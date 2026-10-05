import type { CompiledPart, OutlinePin } from './compileAssembly';

/** A shell vertex this close to another part is treated as lying on that part. */
const ON_SURFACE = 0.004;

export interface ParticleArrays {
  positions: Float32Array;
  masses: Float32Array;
  damping: Float32Array;
  friction: Float32Array;
}

export interface SurfaceSample {
  distance: number;
  /** Positive outside the triangle, negative through the face. */
  signed: number;
  nx: number;
  ny: number;
  nz: number;
  barycentric: [number, number, number];
}

/**
 * A welded sheet is pinned to the face it rests on, and its next vertex hangs past the
 * corner. The straight edge between them cuts through the solid. Insert a vertex where
 * each of those edges leaves the solid so the sheet can hinge around the outline instead.
 */
export function refineShellContacts(arrays: ParticleArrays, parts: CompiledPart[]): ParticleArrays {
  let current = arrays;
  for (const shell of parts) {
    if (shell.kind !== 'shell') continue;
    for (const other of parts) {
      if (other === shell || other.kind === 'shell') continue;
      current = refinePair(current, parts, shell, other);
    }
  }
  return current;
}

export function closestSurfacePoint(
  positions: Float32Array,
  triangles: Uint32Array,
  x: number,
  y: number,
  z: number,
): SurfaceSample | null {
  let best = Infinity;
  let sample: SurfaceSample | null = null;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * 3;
    const b = triangles[t + 1] * 3;
    const c = triangles[t + 2] * 3;
    const hit = projectTriangle(
      x,
      y,
      z,
      positions[a],
      positions[a + 1],
      positions[a + 2],
      positions[b],
      positions[b + 1],
      positions[b + 2],
      positions[c],
      positions[c + 1],
      positions[c + 2],
    );
    if (!hit || hit.distance >= best) continue;
    best = hit.distance;
    sample = hit;
  }
  return sample;
}

function refinePair(arrays: ParticleArrays, parts: CompiledPart[], shell: CompiledPart, other: CompiledPart): ParticleArrays {
  const onSurface = (index: number) => liesOnSurface(arrays.positions, other.triangles, index);
  let any = false;
  for (let i = 0; i < shell.count; i++) {
    if (onSurface(shell.offset + i)) {
      any = true;
      break;
    }
  }
  if (!any) return arrays;

  const insertAt = shell.offset + shell.count;
  const extras: number[][] = [];
  const pins: OutlinePin[] = [];
  const features = featureEdges(arrays.positions, other.triangles);
  const splits = new Map<string, number>();
  const boundary = (inside: number, outside: number): number | null => {
    const key = inside < outside ? `${inside}:${outside}` : `${outside}:${inside}`;
    const cached = splits.get(key);
    if (cached !== undefined) return cached;
    const t = boundaryParameter(arrays.positions, other.triangles, inside, outside);
    if (t < 0.04 || t > 0.96) return null;
    const index = insertAt + extras.length;
    const point = lerp(arrays.positions, inside, outside, t);
    extras.push(point);
    const pin = pinToFeature(point, features, arrays.positions);
    if (pin) pins.push({ particle: index, ...pin });
    splits.set(key, index);
    return index;
  };

  const next: number[] = [];
  let changed = false;
  const tris = shell.triangles;
  for (let t = 0; t < tris.length; t += 3) {
    const tri = [tris[t], tris[t + 1], tris[t + 2]];
    const flags = tri.map((index) => onSurface(index));
    const insideCount = flags.filter(Boolean).length;
    if (insideCount === 0 || insideCount === 3) {
      next.push(...tri);
      continue;
    }
    const pieces = cutTriangle(tri, flags, boundary);
    if (!pieces) {
      next.push(...tri);
      continue;
    }
    changed = true;
    next.push(...pieces);
  }
  if (!changed || extras.length === 0) return arrays;

  const constraints = constraintsFromTriangles(next);
  const spliced = spliceParticles(arrays, parts, insertAt, extras);
  const add = extras.length;
  for (const pin of pins) {
    if (pin.a >= insertAt) pin.a += add;
    if (pin.b >= insertAt) pin.b += add;
  }
  shell.outlinePins.push(...pins);
  shell.triangles = new Uint32Array(next);
  shell.stretch = constraints.stretch;
  shell.bend = constraints.bend;
  shell.structureEdges = constraints.stretch;
  shell.count += extras.length;
  shell.surfaceParticles = Uint32Array.from({ length: shell.count }, (_, index) => shell.offset + index);
  return spliced;
}

function cutTriangle(
  tri: number[],
  onSurface: boolean[],
  boundary: (inside: number, outside: number) => number | null,
): number[] | null {
  const insideCount = onSurface.filter(Boolean).length;
  if (insideCount === 1) {
    const k = onSurface.findIndex(Boolean);
    const inside = tri[k];
    const first = tri[(k + 1) % 3];
    const second = tri[(k + 2) % 3];
    const start = boundary(inside, first);
    const end = boundary(inside, second);
    if (start === null || end === null) return null;
    return [inside, start, end, start, first, second, start, second, end];
  }
  const k = onSurface.findIndex((flag) => !flag);
  const outside = tri[k];
  const first = tri[(k + 1) % 3];
  const second = tri[(k + 2) % 3];
  const start = boundary(first, outside);
  const end = boundary(second, outside);
  if (start === null || end === null) return null;
  return [first, second, end, first, end, start, start, end, outside];
}

function boundaryParameter(positions: Float32Array, triangles: Uint32Array, inside: number, outside: number): number {
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < 20; step++) {
    const mid = (lo + hi) / 2;
    const point = lerp(positions, inside, outside, mid);
    if (pointOnSurface(positions, triangles, point[0], point[1], point[2])) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function liesOnSurface(positions: Float32Array, triangles: Uint32Array, index: number): boolean {
  return pointOnSurface(positions, triangles, positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
}

function pointOnSurface(positions: Float32Array, triangles: Uint32Array, x: number, y: number, z: number): boolean {
  const hit = closestSurfacePoint(positions, triangles, x, y, z);
  return hit !== null && hit.distance < ON_SURFACE;
}

function lerp(positions: Float32Array, a: number, b: number, t: number): [number, number, number] {
  const ia = a * 3;
  const ib = b * 3;
  return [
    positions[ia] + (positions[ib] - positions[ia]) * t,
    positions[ia + 1] + (positions[ib + 1] - positions[ia + 1]) * t,
    positions[ia + 2] + (positions[ib + 2] - positions[ia + 2]) * t,
  ];
}

function featureEdges(positions: Float32Array, triangles: Uint32Array): { a: number; b: number }[] {
  const edges = new Map<number, { a: number; b: number; nx: number; ny: number; nz: number; count: number }>();
  for (let t = 0; t < triangles.length; t += 3) {
    const ids = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const normal = faceNormal(positions, ids[0], ids[1], ids[2]);
    if (!normal) continue;
    for (let k = 0; k < 3; k++) {
      const u = ids[k];
      const v = ids[(k + 1) % 3];
      const key = u < v ? u * 1_000_003 + v : v * 1_000_003 + u;
      let entry = edges.get(key);
      if (!entry) {
        entry = { a: Math.min(u, v), b: Math.max(u, v), nx: normal[0], ny: normal[1], nz: normal[2], count: 1 };
        edges.set(key, entry);
        continue;
      }
      if (entry.count === 1) {
        const dot = entry.nx * normal[0] + entry.ny * normal[1] + entry.nz * normal[2];
        entry.count = dot < 0.5 ? 2 : 3;
      }
    }
  }
  const features: { a: number; b: number }[] = [];
  for (const entry of edges.values()) if (entry.count === 2) features.push({ a: entry.a, b: entry.b });
  return features;
}

function pinToFeature(
  point: [number, number, number],
  features: { a: number; b: number }[],
  positions: Float32Array,
): { a: number; b: number; t: number } | null {
  let best = 0.02;
  let chosen: { a: number; b: number; t: number } | null = null;
  for (const edge of features) {
    const ia = edge.a * 3;
    const ib = edge.b * 3;
    const abx = positions[ib] - positions[ia];
    const aby = positions[ib + 1] - positions[ia + 1];
    const abz = positions[ib + 2] - positions[ia + 2];
    const ab2 = abx * abx + aby * aby + abz * abz;
    if (ab2 < 1e-12) continue;
    const t = Math.min(1, Math.max(0, ((point[0] - positions[ia]) * abx + (point[1] - positions[ia + 1]) * aby + (point[2] - positions[ia + 2]) * abz) / ab2));
    const dx = positions[ia] + abx * t - point[0];
    const dy = positions[ia + 1] + aby * t - point[1];
    const dz = positions[ia + 2] + abz * t - point[2];
    const distance = Math.hypot(dx, dy, dz);
    if (distance < best) {
      best = distance;
      chosen = { a: edge.a, b: edge.b, t };
    }
  }
  return chosen;
}

function faceNormal(positions: Float32Array, i: number, j: number, k: number): [number, number, number] | null {
  const ia = i * 3;
  const ja = j * 3;
  const ka = k * 3;
  const ux = positions[ja] - positions[ia];
  const uy = positions[ja + 1] - positions[ia + 1];
  const uz = positions[ja + 2] - positions[ia + 2];
  const vx = positions[ka] - positions[ia];
  const vy = positions[ka + 1] - positions[ia + 1];
  const vz = positions[ka + 2] - positions[ia + 2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-8) return null;
  return [nx / length, ny / length, nz / length];
}

function constraintsFromTriangles(triangles: number[]): { stretch: Uint32Array; bend: Uint32Array } {
  const faces = new Map<number, { a: number; b: number; opposite: number[] }>();
  const add = (u: number, v: number, opposite: number) => {
    const key = u < v ? u * 1_000_003 + v : v * 1_000_003 + u;
    let entry = faces.get(key);
    if (!entry) {
      entry = { a: Math.min(u, v), b: Math.max(u, v), opposite: [] };
      faces.set(key, entry);
    }
    entry.opposite.push(opposite);
  };
  for (let t = 0; t < triangles.length; t += 3) {
    add(triangles[t], triangles[t + 1], triangles[t + 2]);
    add(triangles[t + 1], triangles[t + 2], triangles[t]);
    add(triangles[t + 2], triangles[t], triangles[t + 1]);
  }
  const stretch: number[] = [];
  const bend: number[] = [];
  for (const entry of faces.values()) {
    stretch.push(entry.a, entry.b);
    if (entry.opposite.length === 2) bend.push(entry.opposite[0], entry.opposite[1]);
  }
  return { stretch: new Uint32Array(stretch), bend: new Uint32Array(bend) };
}

function spliceParticles(arrays: ParticleArrays, parts: CompiledPart[], insertAt: number, extras: number[][]): ParticleArrays {
  const add = extras.length;
  const count = arrays.positions.length / 3;
  const positions = new Float32Array((count + add) * 3);
  const masses = new Float32Array(count + add);
  const damping = new Float32Array(count + add);
  const friction = new Float32Array(count + add);
  const copy = (from: number, to: number, dest: number) => {
    positions.set(arrays.positions.subarray(from * 3, to * 3), dest * 3);
    masses.set(arrays.masses.subarray(from, to), dest);
    damping.set(arrays.damping.subarray(from, to), dest);
    friction.set(arrays.friction.subarray(from, to), dest);
  };
  copy(0, insertAt, 0);
  const donor = insertAt - 1;
  for (let i = 0; i < add; i++) {
    const out = (insertAt + i) * 3;
    positions[out] = extras[i][0];
    positions[out + 1] = extras[i][1];
    positions[out + 2] = extras[i][2];
    masses[insertAt + i] = arrays.masses[donor];
    damping[insertAt + i] = arrays.damping[donor];
    friction[insertAt + i] = arrays.friction[donor];
  }
  copy(insertAt, count, insertAt + add);
  for (const part of parts) {
    part.triangles = shiftIndices(part.triangles, insertAt, add);
    part.structureEdges = shiftIndices(part.structureEdges, insertAt, add);
    part.surfaceParticles = shiftIndices(part.surfaceParticles, insertAt, add);
    part.edges = part.edges ? shiftIndices(part.edges, insertAt, add) : null;
    part.tets = part.tets ? shiftIndices(part.tets, insertAt, add) : null;
    part.stretch = part.stretch ? shiftIndices(part.stretch, insertAt, add) : null;
    part.bend = part.bend ? shiftIndices(part.bend, insertAt, add) : null;
    for (const pin of part.outlinePins) {
      if (pin.particle >= insertAt) pin.particle += add;
      if (pin.a >= insertAt) pin.a += add;
      if (pin.b >= insertAt) pin.b += add;
    }
    if (part.offset >= insertAt) part.offset += add;
  }
  return { positions, masses, damping, friction };
}

function shiftIndices(buffer: Uint32Array, insertAt: number, add: number): Uint32Array {
  const out = new Uint32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) out[i] = buffer[i] >= insertAt ? buffer[i] + add : buffer[i];
  return out;
}

function projectTriangle(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): SurfaceSample | null {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  let nx = aby * acz - abz * acy;
  let ny = abz * acx - abx * acz;
  let nz = abx * acy - aby * acx;
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-8) return null;
  nx /= length;
  ny /= length;
  nz /= length;

  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d00 = abx * abx + aby * aby + abz * abz;
  const d01 = abx * acx + aby * acy + abz * acz;
  const d11 = acx * acx + acy * acy + acz * acz;
  const d20 = apx * abx + apy * aby + apz * abz;
  const d21 = apx * acx + apy * acy + apz * acz;
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-12) return null;
  let v = (d11 * d20 - d01 * d21) / denom;
  let w = (d00 * d21 - d01 * d20) / denom;
  let u = 1 - v - w;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  u = clamp(u);
  v = clamp(v);
  w = clamp(w);
  const sum = u + v + w || 1;
  u /= sum;
  v /= sum;
  w /= sum;
  const cx0 = ax * u + bx * v + cx * w;
  const cy0 = ay * u + by * v + cy * w;
  const cz0 = az * u + bz * v + cz * w;
  const dx = px - cx0;
  const dy = py - cy0;
  const dz = pz - cz0;
  return {
    distance: Math.hypot(dx, dy, dz),
    signed: dx * nx + dy * ny + dz * nz,
    nx,
    ny,
    nz,
    barycentric: [u, v, w],
  };
}
