import * as THREE from 'three';
import { findPreset } from '../../materials/presets';
import { PressState } from '../PressState';
import { GRAVITY, IMPACTOR_MASS, IMPACTOR_RADIUS, KILL_PLANE_Y, MAX_IMPACTORS, spawnHeight } from '../scene';
import type { BodyTopology, MatterKind, MatterSimulation, SimulationFrame, SimulationStats } from '../types';
import { triangulateFaceGrid } from '../cubeLattice';
import {
  collidePointWithPlatform,
  collideSphereWithTriangle,
  collidePointWithPress,
  collideSpheres,
  pressIsParked,
  type SphereBody,
} from './collisions';
import { solveAttachment } from './constraints';

export interface XpbdPreset {
  id: string;
  substeps: number;
  damping: number;
  friction: number;
}

export interface XpbdBodyOptions<P extends XpbdPreset> {
  presets: P[];
  presetId: string;
  restPositions: Float32Array;
  totalMass: number;
  topology: BodyTopology;
  /** Explicit external collision triangles. Composite bodies use this to omit welded interior faces. */
  surfaceTriangles?: Uint32Array;
  /** Contact radius against the platform, press, and impactors. */
  particleRadius: number;
  /** Lowest height the press plate's underside may reach for this body. */
  pressFloor: number;
  /** Max distance from the pointer ray for a particle to be picked. */
  pickRadius: number;
  /** Particles within this distance of the picked particle move with the grab. */
  grabRadius: number;
  /**
   * Amplitude of a fixed pseudo-random offset applied to start positions (not rest shape).
   * A perfectly symmetric shell has no direction to buckle in and would stand up forever.
   */
  startJitter?: number;
}

const GRAB_COMPLIANCE = 5e-5;
const MAX_SPEED = 25;
/** Fast pointer flicks would otherwise slam the grabbed patch through the body in one frame. */
const MAX_GRAB_SPEED = 6;
/** Fraction of horizontal motion an impactor keeps per substep while touching the platform. */
const ROLLING_RESISTANCE = 0.995;

interface Grab {
  indices: number[];
  offsets: number[];
  depth: number;
  /** Picked particle minus its projection onto the pick ray, so grabbing never snaps it. */
  rayOffset: THREE.Vector3;
  target: THREE.Vector3;
  /** Where the grabbed patch is actually pulled; trails `target` at no more than MAX_GRAB_SPEED. */
  anchor: THREE.Vector3;
}

export abstract class XpbdSimulation<P extends XpbdPreset> implements MatterSimulation {
  abstract readonly kind: MatterKind;
  readonly topology: BodyTopology;
  readonly count: number;
  readonly positions: Float32Array;
  readonly previous: Float32Array;
  readonly velocities: Float32Array;
  readonly invMass: Float32Array;
  protected preset: P;
  protected readonly restPositions: Float32Array;
  private readonly presets: P[];
  private readonly framePrevious: Float32Array;
  private readonly renderPositions: Float32Array;
  private readonly options: XpbdBodyOptions<P>;
  private readonly press: PressState;
  private readonly surfaceTriangles: Uint32Array;
  private spheres: SphereBody[] = [];
  private grab: Grab | null = null;
  /** Force the body exerted back on the press during the last step, in newtons. */
  private pressForce = 0;

  protected constructor(options: XpbdBodyOptions<P>) {
    this.options = options;
    this.presets = options.presets;
    this.preset = findPreset(options.presets, options.presetId);
    this.topology = options.topology;
    this.restPositions = options.restPositions;
    this.count = options.restPositions.length / 3;
    this.positions = options.restPositions.slice();
    this.previous = options.restPositions.slice();
    this.framePrevious = options.restPositions.slice();
    this.renderPositions = options.restPositions.slice();
    this.velocities = new Float32Array(this.count * 3);
    this.invMass = new Float32Array(this.count).fill(this.count / options.totalMass);
    this.press = new PressState(options.pressFloor);

    if (options.surfaceTriangles) {
      this.surfaceTriangles = options.surfaceTriangles;
    } else {
      const triangles: number[] = [];
      if (options.topology.kind === 'particles') {
        for (const grid of options.topology.faceGrids) triangulateFaceGrid(grid, options.topology.segments, triangles);
      }
      this.surfaceTriangles = new Uint32Array(triangles);
    }

    this.applyStartJitter();
    this.previous.set(this.positions);
    this.framePrevious.set(this.positions);
  }

  private applyStartJitter(): void {
    const amplitude = this.options.startJitter ?? 0;
    if (amplitude === 0) return;
    let seed = 0x9e3779b9;
    for (let i = 0; i < this.positions.length; i++) {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x85ebca6b) + i) | 0;
      this.positions[i] += ((seed >>> 0) / 0xffffffff - 0.5) * 2 * amplitude;
    }
  }

  /** Solves the body's internal constraints for one substep. */
  protected abstract solveConstraints(h: number): void;

  /** Runs once per step after all substeps, e.g. for plasticity. */
  protected abstract afterStep(): void;

  /** Restores any rest state that plasticity may have changed. */
  protected abstract resetRestState(): void;

  /** Optional per-particle damping coefficients. Falls back to the preset damping. */
  protected particleDamping: Float32Array | null = null;
  /** Optional per-particle Coulomb friction against the platform. */
  protected particleFriction: Float32Array | null = null;

  /** Optional hook for body-specific collisions such as self-collision. */
  protected solveExtraCollisions(_h: number): void {}

  /** Updates contact geometry without resetting the current simulation state. */
  protected setCollisionThickness(particleRadius: number, pressFloor: number): void {
    this.options.particleRadius = particleRadius;
    this.options.pressFloor = pressFloor;
    this.press.setFloor(pressFloor);
  }

  get presetId(): string {
    return this.preset.id;
  }

  setPreset(id: string): void {
    this.preset = findPreset(this.presets, id);
    this.reset();
  }

  reset(): void {
    this.positions.set(this.restPositions);
    this.applyStartJitter();
    this.previous.set(this.positions);
    this.framePrevious.set(this.positions);
    this.velocities.fill(0);
    this.spheres = [];
    this.grab = null;
    this.pressForce = 0;
    this.press.reset();
    this.resetRestState();
  }

  dispose(): void {}

  step(dt: number): void {
    this.framePrevious.set(this.positions);
    const frameStart = this.spheres.map((sphere) => Array.from(sphere.position));
    this.press.update(dt, -Infinity, this.pressForce);
    let pressForce = 0;

    const substeps = this.preset.substeps;
    const h = dt / substeps;
    const { positions, previous, velocities, invMass, count } = this;
    const radius = this.options.particleRadius;
    const friction = this.preset.friction;
    const damping = Math.max(0, 1 - this.preset.damping * h);
    const particleFriction = this.particleFriction;
    const particleDamping = this.particleDamping;

    for (let s = 0; s < substeps; s++) {
      const pressBottom =
        this.press.previousBottom + (this.press.bottom - this.press.previousBottom) * ((s + 1) / substeps);
      const pressEngaged = !pressIsParked(pressBottom);

      for (let i = 0; i < count; i++) {
        if (invMass[i] === 0) continue;
        const o = i * 3;
        velocities[o + 1] += GRAVITY * h;
        previous[o] = positions[o];
        previous[o + 1] = positions[o + 1];
        previous[o + 2] = positions[o + 2];
        positions[o] += velocities[o] * h;
        positions[o + 1] += velocities[o + 1] * h;
        positions[o + 2] += velocities[o + 2] * h;
      }
      for (const sphere of this.spheres) {
        sphere.velocity[1] += GRAVITY * h;
        for (let k = 0; k < 3; k++) {
          sphere.previous[k] = sphere.position[k];
          sphere.position[k] += sphere.velocity[k] * h;
        }
      }

      this.solveConstraints(h);
      this.solveGrab(h);

      if (this.spheres.length > 0) this.collideSpheresWithSurface(radius);
      let pressPush = 0;
      for (let i = 0; i < count; i++) {
        if (invMass[i] === 0) continue;
        if (pressEngaged) {
          const push = collidePointWithPress(positions, i * 3, radius, pressBottom);
          if (push > 0) pressPush += push / invMass[i];
        }
        collidePointWithPlatform(
          positions,
          previous,
          i * 3,
          radius,
          particleFriction ? particleFriction[i] : friction,
        );
      }
      pressForce += pressPush / (h * h) / substeps;
      for (let a = 0; a < this.spheres.length; a++) {
        const sphere = this.spheres[a];
        for (let b = a + 1; b < this.spheres.length; b++) collideSpheres(sphere, this.spheres[b]);
        if (pressEngaged) collidePointWithPress(sphere.position, 0, sphere.radius, pressBottom);
        if (collidePointWithPlatform(sphere.position, sphere.previous, 0, sphere.radius, 0.4)) {
          for (const k of [0, 2]) {
            sphere.position[k] = sphere.previous[k] + (sphere.position[k] - sphere.previous[k]) * ROLLING_RESISTANCE;
          }
        }
      }
      this.solveExtraCollisions(h);

      for (let i = 0; i < count; i++) {
        const o = i * 3;
        const damp = particleDamping ? Math.max(0, 1 - particleDamping[i] * h) : damping;
        let vx = ((positions[o] - previous[o]) / h) * damp;
        let vy = ((positions[o + 1] - previous[o + 1]) / h) * damp;
        let vz = ((positions[o + 2] - previous[o + 2]) / h) * damp;
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (speed > MAX_SPEED) {
          const scale = MAX_SPEED / speed;
          vx *= scale;
          vy *= scale;
          vz *= scale;
        }
        velocities[o] = vx;
        velocities[o + 1] = vy;
        velocities[o + 2] = vz;
      }
      for (const sphere of this.spheres) {
        for (let k = 0; k < 3; k++) sphere.velocity[k] = (sphere.position[k] - sphere.previous[k]) / h;
      }
    }

    this.pressForce = pressForce;
    this.afterStep();

    this.spheres.forEach((sphere, index) => sphere.previous.set(frameStart[index]));
    this.spheres = this.spheres.filter((sphere) => sphere.position[1] > KILL_PLANE_Y);
  }

  beginGrab(ray: THREE.Ray): boolean {
    const { positions, count } = this;
    const { origin, direction } = ray;
    const pickRadius2 = this.options.pickRadius ** 2;
    let best = -1;
    let bestDepth = Infinity;
    for (let i = 0; i < count; i++) {
      const dx = positions[i * 3] - origin.x;
      const dy = positions[i * 3 + 1] - origin.y;
      const dz = positions[i * 3 + 2] - origin.z;
      const t = dx * direction.x + dy * direction.y + dz * direction.z;
      if (t <= 0) continue;
      const ex = dx - direction.x * t;
      const ey = dy - direction.y * t;
      const ez = dz - direction.z * t;
      if (ex * ex + ey * ey + ez * ez > pickRadius2) continue;
      if (t < bestDepth) {
        bestDepth = t;
        best = i;
      }
    }
    if (best < 0) return false;

    const grabRadius2 = this.options.grabRadius ** 2;
    const indices: number[] = [];
    const offsets: number[] = [];
    const bx = positions[best * 3];
    const by = positions[best * 3 + 1];
    const bz = positions[best * 3 + 2];
    for (let i = 0; i < count; i++) {
      const ox = positions[i * 3] - bx;
      const oy = positions[i * 3 + 1] - by;
      const oz = positions[i * 3 + 2] - bz;
      if (ox * ox + oy * oy + oz * oz > grabRadius2) continue;
      indices.push(i);
      offsets.push(ox, oy, oz);
    }
    const target = new THREE.Vector3(bx, by, bz);
    const rayOffset = target.clone().sub(ray.at(bestDepth, new THREE.Vector3()));
    this.grab = { indices, offsets, depth: bestDepth, rayOffset, target, anchor: target.clone() };
    return true;
  }

  updateGrab(ray: THREE.Ray): void {
    if (this.grab) ray.at(this.grab.depth, this.grab.target).add(this.grab.rayOffset);
  }

  endGrab(): void {
    this.grab = null;
  }

  dropImpactor(x: number, z: number): void {
    if (this.spheres.length >= MAX_IMPACTORS) this.spheres.shift();
    const y = spawnHeight(
      x,
      z,
      this.spheres.map(({ position: p }) => ({ x: p[0], y: p[1], z: p[2] })),
    );
    const position = new Float64Array([x, y, z]);
    this.spheres.push({
      position,
      previous: position.slice(),
      velocity: new Float64Array(3),
      radius: IMPACTOR_RADIUS,
      invMass: 1 / IMPACTOR_MASS,
    });
  }

  setPressActive(active: boolean): void {
    this.press.active = active;
  }

  frame(alpha: number): SimulationFrame {
    const { framePrevious, positions, renderPositions } = this;
    for (let i = 0; i < renderPositions.length; i++) {
      renderPositions[i] = framePrevious[i] + (positions[i] - framePrevious[i]) * alpha;
    }
    return {
      particles: renderPositions,
      cubePosition: null,
      cubeQuaternion: null,
      impactors: this.spheres.map((sphere) => ({
        x: sphere.previous[0] + (sphere.position[0] - sphere.previous[0]) * alpha,
        y: sphere.previous[1] + (sphere.position[1] - sphere.previous[1]) * alpha,
        z: sphere.previous[2] + (sphere.position[2] - sphere.previous[2]) * alpha,
        radius: sphere.radius,
      })),
      pressBottom: this.press.interpolated(alpha),
    };
  }

  stats(): SimulationStats {
    return {
      impactorCount: this.spheres.length,
      pressBottom: this.press.bottom,
      pressActive: this.press.active,
      grabbing: this.grab !== null,
      maxDeformation: shapeDeviation(this.positions, this.restPositions),
      center: centroid(this.positions),
    };
  }

  private collideSpheresWithSurface(thickness: number): void {
    const { positions, invMass, surfaceTriangles } = this;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    for (const sphere of this.spheres) {
      const reach = sphere.radius + thickness;
      const [sx, sy, sz] = sphere.position;
      if (sx < minX - reach || sx > maxX + reach) continue;
      if (sy < minY - reach || sy > maxY + reach) continue;
      if (sz < minZ - reach || sz > maxZ + reach) continue;
      for (let t = 0; t < surfaceTriangles.length; t += 3) {
        collideSphereWithTriangle(
          positions,
          invMass,
          surfaceTriangles[t],
          surfaceTriangles[t + 1],
          surfaceTriangles[t + 2],
          sphere,
          thickness,
        );
      }
    }
  }

  private solveGrab(h: number): void {
    if (!this.grab) return;
    const { indices, offsets, target, anchor } = this.grab;
    const gap = anchor.distanceTo(target);
    const maxStep = MAX_GRAB_SPEED * h;
    if (gap > maxStep) anchor.lerp(target, maxStep / gap);
    else anchor.copy(target);
    for (let k = 0; k < indices.length; k++) {
      solveAttachment(
        this.positions,
        this.invMass,
        indices[k],
        anchor.x + offsets[k * 3],
        anchor.y + offsets[k * 3 + 1],
        anchor.z + offsets[k * 3 + 2],
        GRAB_COMPLIANCE,
        h,
      );
    }
  }
}

/**
 * Largest distance between a current point and its rest position after the best-fit
 * translation and rotation are removed (shape matching), i.e. pure change of shape.
 */
export function shapeDeviation(positions: Float32Array, rest: Float32Array): number {
  const c = centroid(positions);
  const r = centroid(rest);
  const count = positions.length / 3;
  const a = new THREE.Matrix3();
  const e = a.elements;
  e.fill(0);
  for (let i = 0; i < count; i++) {
    const px = positions[i * 3] - c[0], py = positions[i * 3 + 1] - c[1], pz = positions[i * 3 + 2] - c[2];
    const qx = rest[i * 3] - r[0], qy = rest[i * 3 + 1] - r[1], qz = rest[i * 3 + 2] - r[2];
    // Column-major: element (row, col) at col * 3 + row; A = sum p q^T.
    e[0] += px * qx; e[1] += py * qx; e[2] += pz * qx;
    e[3] += px * qy; e[4] += py * qy; e[5] += pz * qy;
    e[6] += px * qz; e[7] += py * qz; e[8] += pz * qz;
  }
  const rotation = extractRotation(a);
  const m = new THREE.Matrix4().makeRotationFromQuaternion(rotation).elements;
  let max = 0;
  for (let i = 0; i < count; i++) {
    const qx = rest[i * 3] - r[0], qy = rest[i * 3 + 1] - r[1], qz = rest[i * 3 + 2] - r[2];
    const dx = positions[i * 3] - c[0] - (m[0] * qx + m[4] * qy + m[8] * qz);
    const dy = positions[i * 3 + 1] - c[1] - (m[1] * qx + m[5] * qy + m[9] * qz);
    const dz = positions[i * 3 + 2] - c[2] - (m[2] * qx + m[6] * qy + m[10] * qz);
    max = Math.max(max, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return max;
}

/** Rotation part of A by quaternion iteration (Müller et al., "A Robust Method to Extract the Rotational Part of Deformations"). */
function extractRotation(a: THREE.Matrix3, iterations = 30): THREE.Quaternion {
  const q = new THREE.Quaternion();
  const ae = a.elements;
  const r = new THREE.Matrix4();
  const axis = new THREE.Vector3();
  const step = new THREE.Quaternion();
  for (let iter = 0; iter < iterations; iter++) {
    const re = r.makeRotationFromQuaternion(q).elements;
    let ox = 0, oy = 0, oz = 0, dot = 0;
    for (let col = 0; col < 3; col++) {
      const rx = re[col * 4], ry = re[col * 4 + 1], rz = re[col * 4 + 2];
      const ax = ae[col * 3], ay = ae[col * 3 + 1], az = ae[col * 3 + 2];
      ox += ry * az - rz * ay;
      oy += rz * ax - rx * az;
      oz += rx * ay - ry * ax;
      dot += rx * ax + ry * ay + rz * az;
    }
    const scale = 1 / (Math.abs(dot) + 1e-9);
    axis.set(ox * scale, oy * scale, oz * scale);
    const angle = axis.length();
    if (angle < 1e-9) break;
    step.setFromAxisAngle(axis.divideScalar(angle), angle);
    q.premultiply(step).normalize();
  }
  return q;
}

export function centroid(positions: Float32Array): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  const count = positions.length / 3;
  for (let i = 0; i < count; i++) {
    x += positions[i * 3];
    y += positions[i * 3 + 1];
    z += positions[i * 3 + 2];
  }
  return [x / count, y / count, z / count];
}
