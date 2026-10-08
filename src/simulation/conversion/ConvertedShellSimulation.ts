import { DEFAULT_PRESET_IDS, SHELL_PRESETS, type PlasticSettings, type ShellPreset } from '../../materials/presets';
import { applyDistancePlasticity, DistanceConstraints, solveDistances } from '../xpbd/constraints';
import { SpatialHash } from '../xpbd/SpatialHash';
import { XpbdSimulation } from '../xpbd/XpbdSimulation';
import { ShapeMatchingConstraint } from '../xpbd/shapeMatching';
import { WeldConstraints, type BarycentricWeld } from '../xpbd/weldConstraints';
import type { RigidWeldPart } from '../../conversion-editor/RigidWeldDocument';
import {
  closestSurfacePoint,
  pointForAnchor,
  transformAccessoryPositions,
} from './autoWeldRigid';
import { rigidAccessory, type RigidAccessoryId } from './rigidAccessories';
import type { SourceMesh } from './sourceMeshes';

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
  /**
   * Per-particle materials on one mesh. Mixed seams use the stiffer endpoint
   * for in-plane stretch/compression while retaining blended bending.
   */
  regions?: {
    particleMaterials: Uint8Array;
    materials: readonly RegionCompliance[];
  };
  rigidWelds?: {
    source: SourceMesh;
    parts: readonly RigidWeldPart[];
  };
}

export interface RegionCompliance {
  stretchCompliance: number;
  compressionCompliance: number;
  bendCompliance: number;
  damping: number;
  friction: number;
  plastic: PlasticSettings | null;
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
  private readonly bendBase: Float32Array | null = null;
  private readonly regionPlastic: PlasticSettings | null = null;
  private readonly stretchPlastic: Uint8Array | null = null;
  private readonly bendPlastic: Uint8Array | null = null;
  private readonly rigidGroups: ShapeMatchingConstraint[] = [];
  private readonly welds: WeldConstraints;
  readonly shellParticleCount: number;

  constructor(options: ConvertedShellSimulationOptions) {
    const { mesh } = options;
    const thickness = Math.max(MIN_THICKNESS, options.thickness);
    const compiled = compileRigidWelds(mesh, options.rigidWelds);
    super({
      presets: SHELL_PRESETS,
      presetId: options.presetId ?? DEFAULT_PRESET_IDS.shell,
      restPositions: compiled.positions,
      totalMass: (options.totalMass ?? 0.5) + compiled.totalMass,
      topology: {
        kind: 'particles',
        particleCount: compiled.positions.length / 3,
        segments: 0,
        faceGrids: [],
        structureEdges: mesh.stretchPairs,
      },
      surfaceTriangles: compiled.triangles,
      particleRadius: Math.max(0.008, thickness * 0.5),
      pressFloor: thickness,
      pickRadius: 0.16,
      grabRadius: 0.28,
      startJitter: 0.001,
    });
    this.stretch = new DistanceConstraints(mesh.stretchPairs, mesh.positions);
    this.bend = new DistanceConstraints(mesh.bendPairs, mesh.positions);
    this.shellParticleCount = mesh.positions.length / 3;
    const shellMass = options.totalMass ?? 0.5;
    this.invMass.fill(this.shellParticleCount / shellMass, 0, this.shellParticleCount);
    for (const rigid of compiled.rigids) {
      this.invMass.fill(rigid.indices.length / rigid.mass, rigid.offset, rigid.offset + rigid.indices.length);
      this.rigidGroups.push(new ShapeMatchingConstraint(rigid.indices, this.restPositions));
    }
    this.welds = new WeldConstraints(compiled.welds);
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
    if (options.regions && options.regions.materials.length > 0) {
      const { particleMaterials: ids, materials } = options.regions;
      this.stretch.stretchCompliance = pairCompliance(this.stretch, ids, materials, 'stretchCompliance');
      this.stretch.compressionCompliance = pairCompliance(this.stretch, ids, materials, 'compressionCompliance');
      this.bendBase = pairCompliance(this.bend, ids, materials, 'bendCompliance');
      const damping = new Float32Array(this.count);
      const friction = new Float32Array(this.count);
      for (let i = 0; i < this.count; i++) {
        const material = materials[ids[i]] ?? materials[0];
        damping[i] = material.damping;
        friction[i] = material.friction;
      }
      this.particleDamping = damping;
      this.particleFriction = friction;
      const plastic = materials.find((material) => material.plastic)?.plastic ?? null;
      if (plastic) {
        this.regionPlastic = plastic;
        this.stretchPlastic = plasticMask(this.stretch, ids, materials);
        this.bendPlastic = plasticMask(this.bend, ids, materials);
      }
    }
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
    this.applyRegionBending();
  }

  /** Bending stiffness still grows with thickness cubed, per material. */
  private applyRegionBending(): void {
    if (!this.bendBase) return;
    const scale = (REFERENCE_THICKNESS / this.thickness) ** 3;
    const scaled = this.bend.stretchCompliance ?? new Float32Array(this.bendBase.length);
    for (let i = 0; i < this.bendBase.length; i++) scaled[i] = this.bendBase[i] * scale;
    this.bend.stretchCompliance = scaled;
    this.bend.compressionCompliance = scaled;
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
    for (let iteration = 0; iteration < 10; iteration++) {
      for (const rigid of this.rigidGroups) rigid.solve(this.positions);
      this.welds.solve(this.positions, this.invMass);
    }
  }

  get weldCount(): number {
    return this.welds.count;
  }

  maxWeldSeparation(): number {
    return this.welds.maxSeparation(this.positions);
  }

  maxRigidShapeError(): number {
    return this.rigidGroups.reduce((max, rigid) => Math.max(max, rigid.maxError(this.positions)), 0);
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
    if (this.regionPlastic) {
      applyDistancePlasticity(this.positions, this.stretch, this.regionPlastic, this.stretchPlastic);
      applyDistancePlasticity(this.positions, this.bend, this.regionPlastic, this.bendPlastic);
      return;
    }
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

interface CompiledRigidWelds {
  positions: Float32Array;
  triangles: Uint32Array;
  totalMass: number;
  rigids: { offset: number; indices: Uint32Array; mass: number }[];
  welds: BarycentricWeld[];
}

function compileRigidWelds(
  mesh: SimulatableSurface,
  input: ConvertedShellSimulationOptions['rigidWelds'],
): CompiledRigidWelds {
  const positions = Array.from(mesh.positions);
  const triangles = Array.from(mesh.triangles);
  const rigids: CompiledRigidWelds['rigids'] = [];
  const welds: BarycentricWeld[] = [];
  let totalMass = 0;
  if (!input) {
    return {
      positions: mesh.positions,
      triangles: mesh.triangles,
      totalMass,
      rigids,
      welds,
    };
  }

  for (const part of input.parts) {
    const preset = rigidAccessory(part.presetId as RigidAccessoryId);
    const transformed = transformAccessoryPositions(part);
    const offset = positions.length / 3;
    positions.push(...transformed);
    for (const index of preset.triangles) triangles.push(offset + index);
    const indices = new Uint32Array(preset.positions.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = offset + i;
    rigids.push({ offset, indices, mass: preset.mass * part.uniformScale ** 3 });
    totalMass += preset.mass * part.uniformScale ** 3;

    for (const weld of part.welds) {
      const sourcePoint = pointForAnchor(
        weld.sourceAnchor,
        input.source.positions,
        input.source.triangles,
      );
      const shellAnchor = closestSurfacePoint(sourcePoint, mesh.positions, mesh.triangles);
      if (!shellAnchor) continue;
      const shellBase = shellAnchor.anchor.triangle * 3;
      const accessoryBase = weld.accessoryAnchor.triangle * 3;
      welds.push({
        particles: new Uint32Array([
          mesh.triangles[shellBase],
          mesh.triangles[shellBase + 1],
          mesh.triangles[shellBase + 2],
          offset + preset.triangles[accessoryBase],
          offset + preset.triangles[accessoryBase + 1],
          offset + preset.triangles[accessoryBase + 2],
        ]),
        weights: new Float32Array([
          ...shellAnchor.anchor.barycentric,
          ...weld.accessoryAnchor.barycentric,
        ]),
      });
    }
  }
  return {
    positions: new Float32Array(positions),
    triangles: new Uint32Array(triangles),
    totalMass,
    rigids,
    welds,
  };
}

function pairCompliance(
  constraints: DistanceConstraints,
  particleMaterials: Uint8Array,
  materials: readonly RegionCompliance[],
  key: 'stretchCompliance' | 'compressionCompliance' | 'bendCompliance',
): Float32Array {
  const out = new Float32Array(constraints.count);
  for (let i = 0; i < constraints.count; i++) {
    const a = materials[particleMaterials[constraints.a[i]]] ?? materials[0];
    const b = materials[particleMaterials[constraints.b[i]]] ?? materials[0];
    const mixed = particleMaterials[constraints.a[i]] !== particleMaterials[constraints.b[i]];
    out[i] = mixed && key !== 'bendCompliance' ? Math.min(a[key], b[key]) : 0.5 * (a[key] + b[key]);
  }
  return out;
}

/** Permanent set only where both endpoints share a material that creases. */
function plasticMask(
  constraints: DistanceConstraints,
  particleMaterials: Uint8Array,
  materials: readonly RegionCompliance[],
): Uint8Array {
  const mask = new Uint8Array(constraints.count);
  for (let i = 0; i < constraints.count; i++) {
    const a = materials[particleMaterials[constraints.a[i]]];
    const b = materials[particleMaterials[constraints.b[i]]];
    mask[i] = a?.plastic && b?.plastic ? 1 : 0;
  }
  return mask;
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
