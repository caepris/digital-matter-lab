import type { PlasticSettings } from '../../materials/presets';

/**
 * Constraints are solved with the "small steps" XPBD variant: many substeps with one
 * iteration each, so Lagrange multipliers need not be accumulated across iterations.
 */

export class DistanceConstraints {
  readonly count: number;
  readonly a: Uint32Array;
  readonly b: Uint32Array;
  readonly rest: Float32Array;
  readonly initialRest: Float32Array;

  constructor(pairs: ArrayLike<number>, positions: Float32Array) {
    this.count = pairs.length / 2;
    this.a = new Uint32Array(this.count);
    this.b = new Uint32Array(this.count);
    this.rest = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this.a[i] = pairs[i * 2];
      this.b[i] = pairs[i * 2 + 1];
      this.rest[i] = distance(positions, this.a[i], this.b[i]);
    }
    this.initialRest = this.rest.slice();
  }

  resetRest(): void {
    this.rest.set(this.initialRest);
  }
}

export class TetVolumeConstraints {
  readonly count: number;
  readonly tets: Uint32Array;
  readonly rest: Float32Array;
  readonly initialRest: Float32Array;

  constructor(tets: Uint32Array, positions: Float32Array) {
    this.count = tets.length / 4;
    this.tets = tets;
    this.rest = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this.rest[i] = tetVolume(positions, tets[i * 4], tets[i * 4 + 1], tets[i * 4 + 2], tets[i * 4 + 3]);
    }
    this.initialRest = this.rest.slice();
  }

  resetRest(): void {
    this.rest.set(this.initialRest);
  }
}

export function distance(positions: Float32Array, i: number, j: number): number {
  const dx = positions[i * 3] - positions[j * 3];
  const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
  const dz = positions[i * 3 + 2] - positions[j * 3 + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function tetVolume(positions: Float32Array, i0: number, i1: number, i2: number, i3: number): number {
  const ax = positions[i1 * 3] - positions[i0 * 3];
  const ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
  const az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
  const bx = positions[i2 * 3] - positions[i0 * 3];
  const by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
  const bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];
  const cx = positions[i3 * 3] - positions[i0 * 3];
  const cy = positions[i3 * 3 + 1] - positions[i0 * 3 + 1];
  const cz = positions[i3 * 3 + 2] - positions[i0 * 3 + 2];
  return ((ay * bz - az * by) * cx + (az * bx - ax * bz) * cy + (ax * by - ay * bx) * cz) / 6;
}

/** `compressionCompliance` lets cloth-like materials buckle easily while staying hard to stretch. */
export function solveDistances(
  positions: Float32Array,
  invMass: Float32Array,
  constraints: DistanceConstraints,
  compliance: number,
  h: number,
  compressionCompliance = compliance,
): void {
  const stretchAlpha = compliance / (h * h);
  const compressAlpha = compressionCompliance / (h * h);
  const { a, b, rest, count } = constraints;
  for (let c = 0; c < count; c++) {
    const i = a[c];
    const j = b[c];
    const wi = invMass[i];
    const wj = invMass[j];
    const w = wi + wj;
    if (w === 0) continue;
    const dx = positions[i * 3] - positions[j * 3];
    const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
    const dz = positions[i * 3 + 2] - positions[j * 3 + 2];
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-9) continue;
    const alpha = length < rest[c] ? compressAlpha : stretchAlpha;
    const s = -(length - rest[c]) / (w + alpha) / length;
    positions[i * 3] += dx * s * wi;
    positions[i * 3 + 1] += dy * s * wi;
    positions[i * 3 + 2] += dz * s * wi;
    positions[j * 3] -= dx * s * wj;
    positions[j * 3 + 1] -= dy * s * wj;
    positions[j * 3 + 2] -= dz * s * wj;
  }
}

/** For each tet vertex, the opposite face whose cross product gives that vertex's volume gradient. */
const OPPOSITE_FACES = [
  [1, 3, 2],
  [0, 2, 3],
  [0, 3, 1],
  [0, 1, 2],
];

const ids = new Uint32Array(4);
const gradients = new Float64Array(12);

/**
 * `minVolumeRatio` is an inversion guard: below that fraction of the rest volume the
 * constraint becomes rigid, so compressible materials squash but never turn inside out.
 */
export function solveTetVolumes(
  positions: Float32Array,
  invMass: Float32Array,
  constraints: TetVolumeConstraints,
  compliance: number,
  h: number,
  minVolumeRatio = 0.35,
): void {
  const alpha = compliance / (h * h);
  const { tets, rest, count } = constraints;
  for (let t = 0; t < count; t++) {
    let w = 0;
    for (let k = 0; k < 4; k++) ids[k] = tets[t * 4 + k];
    for (let k = 0; k < 4; k++) {
      const [f0, f1, f2] = OPPOSITE_FACES[k];
      const p0 = ids[f0] * 3;
      const p1 = ids[f1] * 3;
      const p2 = ids[f2] * 3;
      const ux = positions[p1] - positions[p0];
      const uy = positions[p1 + 1] - positions[p0 + 1];
      const uz = positions[p1 + 2] - positions[p0 + 2];
      const vx = positions[p2] - positions[p0];
      const vy = positions[p2 + 1] - positions[p0 + 1];
      const vz = positions[p2 + 2] - positions[p0 + 2];
      const gx = (uy * vz - uz * vy) / 6;
      const gy = (uz * vx - ux * vz) / 6;
      const gz = (ux * vy - uy * vx) / 6;
      gradients[k * 3] = gx;
      gradients[k * 3 + 1] = gy;
      gradients[k * 3 + 2] = gz;
      w += invMass[ids[k]] * (gx * gx + gy * gy + gz * gz);
    }
    if (w === 0) continue;
    const volume = tetVolume(positions, ids[0], ids[1], ids[2], ids[3]);
    const floor = rest[t] * minVolumeRatio;
    const s = volume < floor ? -(volume - floor) / w : -(volume - rest[t]) / (w + alpha);
    for (let k = 0; k < 4; k++) {
      const p = ids[k] * 3;
      const scale = s * invMass[ids[k]];
      positions[p] += gradients[k * 3] * scale;
      positions[p + 1] += gradients[k * 3 + 1] * scale;
      positions[p + 2] += gradients[k * 3 + 2] * scale;
    }
  }
}

/** Pulls a particle toward a world-space target with the given compliance. */
export function solveAttachment(
  positions: Float32Array,
  invMass: Float32Array,
  i: number,
  tx: number,
  ty: number,
  tz: number,
  compliance: number,
  h: number,
): void {
  const w = invMass[i];
  if (w === 0) return;
  const alpha = compliance / (h * h);
  const scale = w / (w + alpha);
  positions[i * 3] += (tx - positions[i * 3]) * scale;
  positions[i * 3 + 1] += (ty - positions[i * 3 + 1]) * scale;
  positions[i * 3 + 2] += (tz - positions[i * 3 + 2]) * scale;
}

function creep(current: number, rest: number, initial: number, settings: PlasticSettings): number {
  const strain = (current - rest) / initial;
  if (Math.abs(strain) <= settings.yieldStrain) return rest;
  const excess = strain - Math.sign(strain) * settings.yieldStrain;
  const updated = rest + excess * initial * settings.creep;
  const limit = settings.maxStrain * initial;
  return Math.min(initial + limit, Math.max(initial - limit, updated));
}

/** Moves rest lengths toward strained lengths beyond the yield point; returns how many changed. */
export function applyDistancePlasticity(
  positions: Float32Array,
  constraints: DistanceConstraints,
  settings: PlasticSettings,
): number {
  let changed = 0;
  for (let c = 0; c < constraints.count; c++) {
    const current = distance(positions, constraints.a[c], constraints.b[c]);
    const updated = creep(current, constraints.rest[c], constraints.initialRest[c], settings);
    if (updated !== constraints.rest[c]) {
      constraints.rest[c] = updated;
      changed++;
    }
  }
  return changed;
}

export function applyVolumePlasticity(
  positions: Float32Array,
  constraints: TetVolumeConstraints,
  settings: PlasticSettings,
): number {
  let changed = 0;
  const { tets } = constraints;
  for (let t = 0; t < constraints.count; t++) {
    const current = tetVolume(positions, tets[t * 4], tets[t * 4 + 1], tets[t * 4 + 2], tets[t * 4 + 3]);
    const updated = creep(current, constraints.rest[t], constraints.initialRest[t], settings);
    if (updated !== constraints.rest[t]) {
      constraints.rest[t] = updated;
      changed++;
    }
  }
  return changed;
}
