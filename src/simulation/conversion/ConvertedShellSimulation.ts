import { DEFAULT_PRESET_IDS, SHELL_PRESETS, type ShellPreset } from '../../materials/presets';
import { applyDistancePlasticity, DistanceConstraints, solveDistances } from '../xpbd/constraints';
import { SpatialHash } from '../xpbd/SpatialHash';
import { XpbdSimulation } from '../xpbd/XpbdSimulation';

const REFERENCE_THICKNESS = 0.03;
const MIN_THICKNESS = 0.002;

export interface SimulatableSurface {
  positions: Float32Array;
  triangles: Uint32Array;
  stretchPairs: Uint32Array;
  bendPairs: Uint32Array;
}

export interface ConvertedShellSimulationOptions {
  mesh: SimulatableSurface;
  thickness: number;
  presetId?: string;
  totalMass?: number;
  /** Particles held in place, e.g. where a garment hangs from a hanger. */
  pinned?: readonly number[];
  /**
   * Adds stiff distance links between vertices two edges apart, so the shell
   * resists shearing and denting like stamped panels rather than cloth.
   */
  structural?: boolean;
}

/** XPBD thin-shell simulation for an arbitrary indexed surface. */
export class ConvertedShellSimulation extends XpbdSimulation<ShellPreset> {
  readonly kind = 'shell' as const;
  readonly stretch: DistanceConstraints;
  readonly bend: DistanceConstraints;
  readonly structure: DistanceConstraints | null;
  thickness: number;
  /** Separation kept between non-adjacent particles; at least the shell thickness. */
  contactDistance: number;
  readonly pinned: readonly number[];
  private hash: SpatialHash;
  private readonly meanEdgeLength: number;
  private readonly ignored = new Set<number>();

  constructor(options: ConvertedShellSimulationOptions) {
    const { mesh } = options;
    const thickness = Math.max(MIN_THICKNESS, options.thickness);
    super({
      presets: SHELL_PRESETS,
      presetId: options.presetId ?? DEFAULT_PRESET_IDS.shell,
      restPositions: mesh.positions,
      totalMass: options.totalMass ?? 0.5,
      topology: {
        kind: 'particles',
        particleCount: mesh.positions.length / 3,
        segments: 0,
        faceGrids: [],
        structureEdges: mesh.stretchPairs,
      },
      surfaceTriangles: mesh.triangles,
      particleRadius: Math.max(0.008, thickness * 0.5),
      pressFloor: thickness,
      pickRadius: 0.16,
      grabRadius: 0.28,
      startJitter: 0.001,
    });
    this.stretch = new DistanceConstraints(mesh.stretchPairs, mesh.positions);
    this.bend = new DistanceConstraints(mesh.bendPairs, mesh.positions);
    this.structure = options.structural
      ? new DistanceConstraints(secondRingPairs(mesh.stretchPairs, this.count), mesh.positions)
      : null;

    this.pinned = [...new Set(options.pinned ?? [])].filter((index) => index >= 0 && index < this.count);
    for (const index of this.pinned) this.invMass[index] = 0;

    let edgeLength = 0;
    for (let i = 0; i < this.stretch.count; i++) edgeLength += this.stretch.rest[i];
    this.meanEdgeLength = edgeLength / Math.max(1, this.stretch.count);
    this.thickness = thickness;
    this.contactDistance = thickness;
    this.hash = new SpatialHash(thickness, this.count);
    this.setThickness(thickness);
  }

  /** Changes visual/contact thickness and cubic bending stiffness without resetting deformation. */
  setThickness(thickness: number): void {
    this.thickness = Math.max(MIN_THICKNESS, thickness);
    this.contactDistance = Math.max(this.thickness, this.meanEdgeLength * 0.45);
    this.hash = new SpatialHash(this.contactDistance, this.count);
    this.setCollisionThickness(Math.max(0.008, this.thickness * 0.5), this.thickness);
    this.ignored.clear();
    for (let i = 0; i < this.stretch.count; i++) {
      this.ignored.add(pairKey(this.stretch.a[i], this.stretch.b[i]));
    }
    this.ignoreRestContacts(this.restPositions);
  }

  /** Pairs that already start closer than the contact distance are part of the shape, not collisions. */
  private ignoreRestContacts(rest: Float32Array): void {
    const { hash, count, contactDistance } = this;
    hash.create(rest, count);
    const reach2 = contactDistance * contactDistance;
    for (let i = 0; i < count; i++) {
      hash.query(rest, i, contactDistance);
      for (let q = 0; q < hash.querySize; q++) {
        const j = hash.queryIds[q];
        if (j <= i) continue;
        const dx = rest[j * 3] - rest[i * 3];
        const dy = rest[j * 3 + 1] - rest[i * 3 + 1];
        const dz = rest[j * 3 + 2] - rest[i * 3 + 2];
        if (dx * dx + dy * dy + dz * dz < reach2) this.ignored.add(pairKey(i, j));
      }
    }
  }

  protected solveConstraints(h: number): void {
    solveDistances(
      this.positions,
      this.invMass,
      this.stretch,
      this.preset.stretchCompliance,
      h,
      this.preset.compressionCompliance,
    );
    if (this.structure) {
      solveDistances(
        this.positions,
        this.invMass,
        this.structure,
        this.preset.stretchCompliance,
        h,
        this.preset.compressionCompliance,
      );
    }
    solveDistances(
      this.positions,
      this.invMass,
      this.bend,
      bendingComplianceForThickness(this.preset.bendCompliance, this.thickness),
      h,
    );
  }

  protected solveExtraCollisions(): void {
    const { positions, invMass, hash, count, contactDistance } = this;
    hash.create(positions, count);
    const reach2 = contactDistance * contactDistance;
    for (let i = 0; i < count; i++) {
      hash.query(positions, i, contactDistance);
      for (let q = 0; q < hash.querySize; q++) {
        const j = hash.queryIds[q];
        if (j <= i) continue;
        const w = invMass[i] + invMass[j];
        if (w === 0 || this.ignored.has(pairKey(i, j))) continue;
        const dx = positions[j * 3] - positions[i * 3];
        const dy = positions[j * 3 + 1] - positions[i * 3 + 1];
        const dz = positions[j * 3 + 2] - positions[i * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= reach2 || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        const correction = (contactDistance - d) / d / w;
        const ci = correction * invMass[i];
        const cj = correction * invMass[j];
        positions[i * 3] -= dx * ci;
        positions[i * 3 + 1] -= dy * ci;
        positions[i * 3 + 2] -= dz * ci;
        positions[j * 3] += dx * cj;
        positions[j * 3 + 1] += dy * cj;
        positions[j * 3 + 2] += dz * cj;
      }
    }
  }

  protected afterStep(): void {
    const plastic = this.preset.plastic;
    if (!plastic) return;
    // Every rest length must be able to yield: if in-plane edges stay rigid while bend and
    // structure lengths creep, no shape satisfies them all and the solver spins the body up.
    applyDistancePlasticity(this.positions, this.stretch, plastic);
    applyDistancePlasticity(this.positions, this.bend, plastic);
    if (this.structure) applyDistancePlasticity(this.positions, this.structure, plastic);
  }

  protected resetRestState(): void {
    this.stretch.resetRest();
    this.bend.resetRest();
    this.structure?.resetRest();
  }
}

function pairKey(a: number, b: number): number {
  return Math.min(a, b) * 1_000_000 + Math.max(a, b);
}

/** Vertex pairs exactly two edges apart, packed as index pairs. */
function secondRingPairs(edges: Uint32Array, count: number): Uint32Array {
  const adjacent: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < edges.length; i += 2) {
    adjacent[edges[i]].push(edges[i + 1]);
    adjacent[edges[i + 1]].push(edges[i]);
  }
  const pairs: number[] = [];
  const seen = new Set<number>();
  for (let v = 0; v < count; v++) {
    const direct = new Set(adjacent[v]);
    for (const n of adjacent[v]) {
      for (const m of adjacent[n]) {
        if (m <= v || direct.has(m)) continue;
        const key = pairKey(v, m);
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push(v, m);
      }
    }
  }
  return new Uint32Array(pairs);
}

/** Thin-plate bending stiffness grows with thickness cubed, so compliance falls by the same factor. */
export function bendingComplianceForThickness(baseCompliance: number, thickness: number): number {
  return baseCompliance * (REFERENCE_THICKNESS / Math.max(MIN_THICKNESS, thickness)) ** 3;
}
