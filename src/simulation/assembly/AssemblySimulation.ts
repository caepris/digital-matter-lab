import {
  SHELL_PRESETS,
  VOLUME_PRESETS,
  findPreset,
  type AssemblyPreset,
} from '../../materials/presets';
import type { AssemblyDocument } from '../../assembly-editor/AssemblyDocument';
import type { BodyTopology } from '../types';
import {
  applyDistancePlasticity,
  applyVolumePlasticity,
  DistanceConstraints,
  solveDistances,
  solveTetVolumes,
  TetVolumeConstraints,
} from '../xpbd/constraints';
import { ShapeMatchingConstraint } from '../xpbd/shapeMatching';
import { SpatialHash } from '../xpbd/SpatialHash';
import { WeldConstraints } from '../xpbd/weldConstraints';
import { XpbdSimulation } from '../xpbd/XpbdSimulation';
import { compileAssembly, type CompiledAssembly, type CompiledPart, type CompiledWeld } from './compileAssembly';

const PARTICLE_RADIUS = 0.016;
const CLOTH_THICKNESS = 0.04;
/** Stretch compliance for sheet edges that meet the solid outline, so the flap hangs without towing the assembly. */
const OUTLINE_COMPLIANCE = 8;
const CONTACT_RADIUS = 0.035;
const WELD_CONTACT_CLEARANCE = 0.08;

interface VolumeGroup {
  part: CompiledPart;
  edges: DistanceConstraints;
  volumes: TetVolumeConstraints;
  edgeCompliance: number;
  volumeCompliance: number;
}

interface ShellGroup {
  part: CompiledPart;
  stretch: DistanceConstraints;
  /** Edges that touch an outline pin. These yield so the hinge does not drag the welded solid. */
  outline: DistanceConstraints | null;
  bend: DistanceConstraints;
  stretchCompliance: number;
  compressionCompliance: number;
  bendCompliance: number;
}

export class AssemblySimulation extends XpbdSimulation<AssemblyPreset> {
  readonly kind = 'assembly' as const;
  readonly compiled: CompiledAssembly;
  private readonly rigids: ShapeMatchingConstraint[] = [];
  private readonly volumes: VolumeGroup[] = [];
  private readonly shells: ShellGroup[] = [];
  private readonly welds: WeldConstraints;
  private readonly weldData: CompiledWeld[];
  private readonly hash: SpatialHash;
  /** Inverse masses with rigid particles fixed, so final weld passes move only the deformable side. */
  private readonly pinnedInvMass: Float32Array;
  /** Cross-part particle pairs that start closer than the contact distance, keyed by pairKey, with their rest distance. */
  private readonly restContacts: Map<number, number>;

  constructor(document: AssemblyDocument) {
    if (document.parts.length === 0) throw new Error('Cannot simulate an empty assembly');
    const compiled = compileAssembly(document);
    liftAboveFloor(compiled.positions, PARTICLE_RADIUS);
    const totalMass = compiled.masses.reduce((sum, mass) => sum + mass, 0);
    const preset: AssemblyPreset = {
      id: 'compiled',
      label: 'Compiled assembly',
      description: 'Materials are taken from the authored parts.',
      color: 0xb78cff,
      substeps: compiled.substeps,
      damping: 0,
      friction: 0.65,
    };
    const topology: BodyTopology = {
      kind: 'composite',
      particleCount: compiled.positions.length / 3,
      parts: compiled.topologyParts,
      welds: compiled.topologyWelds,
    };
    super({
      presets: [preset],
      presetId: preset.id,
      restPositions: compiled.positions,
      totalMass,
      topology,
      surfaceTriangles: compiled.surfaceTriangles,
      particleRadius: PARTICLE_RADIUS,
      pressFloor: 0.25,
      pickRadius: 0.16,
      grabRadius: 0.22,
    });
    this.compiled = compiled;
    this.particleDamping = compiled.damping;
    this.particleFriction = compiled.friction;
    for (let i = 0; i < this.count; i++) this.invMass[i] = 1 / compiled.masses[i];
    this.pinnedInvMass = this.invMass.slice();
    for (const group of rigidGroups(compiled.parts, compiled.welds)) {
      const indices = Uint32Array.from(
        group.flatMap((part) => Array.from({ length: part.count }, (_, index) => part.offset + index)),
      );
      for (const index of indices) this.pinnedInvMass[index] = 0;
      this.rigids.push(new ShapeMatchingConstraint(indices, compiled.positions, compiled.masses));
    }
    for (const part of compiled.parts) {
      if (part.kind === 'volume' && part.edges && part.tets) {
        const preset = findPreset(VOLUME_PRESETS, part.presetId);
        this.volumes.push({
          part,
          edges: new DistanceConstraints(part.edges, compiled.positions),
          volumes: new TetVolumeConstraints(part.tets, compiled.positions),
          edgeCompliance: preset.edgeCompliance,
          volumeCompliance: preset.volumeCompliance,
        });
      }
      if (part.kind === 'shell' && part.stretch && part.bend) {
        const preset = findPreset(SHELL_PRESETS, part.presetId);
        const pinned = new Set(part.outlinePins.map((pin) => pin.particle));
        const firm: number[] = [];
        const soft: number[] = [];
        for (let i = 0; i < part.stretch.length; i += 2) {
          const bucket = pinned.has(part.stretch[i]) || pinned.has(part.stretch[i + 1]) ? soft : firm;
          bucket.push(part.stretch[i], part.stretch[i + 1]);
        }
        this.shells.push({
          part,
          stretch: new DistanceConstraints(new Uint32Array(firm), compiled.positions),
          outline: soft.length > 0 ? new DistanceConstraints(new Uint32Array(soft), compiled.positions) : null,
          bend: new DistanceConstraints(part.bend, compiled.positions),
          stretchCompliance: preset.stretchCompliance,
          compressionCompliance: preset.compressionCompliance,
          bendCompliance: preset.bendCompliance,
        });
      }
    }
    this.weldData = compiled.welds;
    this.welds = new WeldConstraints(compiled.welds);
    this.restContacts = restContactDistances(compiled.parts, compiled.positions, CONTACT_RADIUS * 2);
    this.hash = new SpatialHash(CLOTH_THICKNESS, Math.max(1, this.count));
  }

  partParticles(partId: string): Uint32Array {
    const part = this.compiled.parts.find((candidate) => candidate.id === partId);
    if (!part) throw new Error(`Unknown part "${partId}"`);
    return Uint32Array.from({ length: part.count }, (_, index) => part.offset + index);
  }

  rigidShapeError(): number {
    let max = 0;
    for (const rigid of this.rigids) max = Math.max(max, rigid.maxError(this.positions));
    return max;
  }

  maxWeldSeparation(): number {
    return this.welds.maxSeparation(this.positions);
  }

  /** Largest permanent rest-length change caused by plasticity. */
  maxPlasticDrift(): number {
    let max = 0;
    for (const group of this.volumes) {
      for (let i = 0; i < group.edges.count; i++) {
        max = Math.max(max, Math.abs(group.edges.rest[i] - group.edges.initialRest[i]));
      }
    }
    for (const group of this.shells) {
      for (let i = 0; i < group.bend.count; i++) {
        max = Math.max(max, Math.abs(group.bend.rest[i] - group.bend.initialRest[i]));
      }
    }
    return max;
  }

  override setPreset(_id: string): void {
    // Materials are authored per part. Recompile the document to change them.
  }

  protected solveConstraints(h: number): void {
    for (let pass = 0; pass < 2; pass++) {
      this.solveMaterials(h);
      this.solveWelds();
    }
    this.finishRigidAndWelds();
  }

  private solveWelds(invMass = this.invMass): void {
    for (let i = 0; i < 10; i++) this.welds.solve(this.positions, invMass);
  }

  private finishRigidAndWelds(): void {
    for (const rigid of this.rigids) rigid.solve(this.positions);
    this.solveWelds(this.pinnedInvMass);
  }

  protected solveExtraCollisions(): void {
    this.solveShellThickness();
    this.solveShellSolids();
    this.solvePartContacts();
    this.finishRigidAndWelds();
  }

  protected afterStep(): void {
    for (const group of this.volumes) {
      if (!group.part.plastic) continue;
      applyDistancePlasticity(this.positions, group.edges, group.part.plastic);
      if (group.part.volumePlastic) applyVolumePlasticity(this.positions, group.volumes, group.part.plastic);
    }
    for (const group of this.shells) {
      if (group.part.plastic) applyDistancePlasticity(this.positions, group.bend, group.part.plastic);
    }
  }

  protected resetRestState(): void {
    for (const group of this.volumes) {
      group.edges.resetRest();
      group.volumes.resetRest();
    }
    for (const group of this.shells) {
      group.stretch.resetRest();
      group.outline?.resetRest();
      group.bend.resetRest();
    }
  }

  private solveMaterials(h: number): void {
    for (const rigid of this.rigids) rigid.solve(this.positions);
    for (const group of this.volumes) {
      solveDistances(this.positions, this.invMass, group.edges, group.edgeCompliance, h);
      solveTetVolumes(this.positions, this.invMass, group.volumes, group.volumeCompliance, h);
    }
    for (const group of this.shells) {
      solveDistances(
        this.positions,
        this.invMass,
        group.stretch,
        group.stretchCompliance,
        h,
        group.compressionCompliance,
      );
      if (group.outline) solveDistances(this.positions, this.invMass, group.outline, OUTLINE_COMPLIANCE, h);
      solveDistances(this.positions, this.invMass, group.bend, group.bendCompliance, h);
    }
  }

  private solveShellThickness(): void {
    const { positions, hash } = this;
    hash.create(positions, this.count);
    const thickness2 = CLOTH_THICKNESS * CLOTH_THICKNESS;
    for (const group of this.shells) {
      const { offset, count } = group.part;
      for (let n = 0; n < count; n++) {
        const i = offset + n;
        hash.query(positions, i, CLOTH_THICKNESS);
        for (let q = 0; q < hash.querySize; q++) {
          const j = hash.queryIds[q];
          if (j <= i || j < offset || j >= offset + count) continue;
          const dx = positions[j * 3] - positions[i * 3];
          const dy = positions[j * 3 + 1] - positions[i * 3 + 1];
          const dz = positions[j * 3 + 2] - positions[i * 3 + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= thickness2 || d2 < 1e-12) continue;
          const distance = Math.sqrt(d2);
          const wi = this.invMass[i];
          const wj = this.invMass[j];
          const correction = ((CLOTH_THICKNESS - distance) / distance) / (wi + wj);
          positions[i * 3] -= dx * correction * wi;
          positions[i * 3 + 1] -= dy * correction * wi;
          positions[i * 3 + 2] -= dz * correction * wi;
          positions[j * 3] += dx * correction * wj;
          positions[j * 3 + 1] += dy * correction * wj;
          positions[j * 3 + 2] += dz * correction * wj;
        }
      }
    }
  }

  /**
   * The sheet is split along the solid's outline. Pull those new vertices back onto
   * the outline each substep so the triangles hinge around the corner instead of
   * cutting through it. Matching `previous` keeps the correction from becoming speed.
   */
  private solveShellSolids(): void {
    const { positions, previous } = this;
    const blend = 0.45;
    for (const group of this.shells) {
      for (const pin of group.part.outlinePins) {
        const ia = pin.a * 3;
        const ib = pin.b * 3;
        const o = pin.particle * 3;
        for (let axis = 0; axis < 3; axis++) {
          const target = positions[ia + axis] + (positions[ib + axis] - positions[ia + axis]) * pin.t;
          const value = positions[o + axis] + (target - positions[o + axis]) * blend;
          positions[o + axis] = value;
          previous[o + axis] = value;
        }
      }
    }
  }

  private solvePartContacts(): void {
    const parts = this.compiled.parts;
    for (let a = 0; a < parts.length; a++) {
      for (let b = a + 1; b < parts.length; b++) {
        if (!boundsOverlap(parts[a], parts[b], this.positions, CONTACT_RADIUS)) continue;
        this.collidePair(parts[a], parts[b]);
      }
    }
  }

  private collidePair(part: CompiledPart, other: CompiledPart): void {
    const { positions, invMass } = this;
    const welds = this.weldData.filter(
      (weld) =>
        (weld.partA === part.id && weld.partB === other.id) || (weld.partA === other.id && weld.partB === part.id),
    );
    const contactDistance = CONTACT_RADIUS * 2;
    const contactDistance2 = contactDistance * contactDistance;
    for (const i of part.surfaceParticles) {
      if (nearWeld(welds, positions, i)) continue;
      for (const j of other.surfaceParticles) {
        if (nearWeld(welds, positions, j)) continue;
        const dx = positions[j * 3] - positions[i * 3];
        const dy = positions[j * 3 + 1] - positions[i * 3 + 1];
        const dz = positions[j * 3 + 2] - positions[i * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= contactDistance2 || d2 < 1e-12) continue;
        const minDistance = this.restContacts.get(pairKey(i, j)) ?? contactDistance;
        if (d2 >= minDistance * minDistance) continue;
        const distance = Math.sqrt(d2);
        const wi = invMass[i];
        const wj = invMass[j];
        const correction = (minDistance - distance) / distance / (wi + wj);
        positions[i * 3] -= dx * correction * wi;
        positions[i * 3 + 1] -= dy * correction * wi;
        positions[i * 3 + 2] -= dz * correction * wi;
        positions[j * 3] += dx * correction * wj;
        positions[j * 3 + 1] += dy * correction * wj;
        positions[j * 3 + 2] += dz * correction * wj;
      }
    }
  }
}

/** Parts authored resting on y = 0 would otherwise start inside the platform and be launched by its contact. */
function liftAboveFloor(positions: Float32Array, clearance: number): void {
  let minY = Infinity;
  for (let i = 1; i < positions.length; i += 3) minY = Math.min(minY, positions[i]);
  const lift = clearance - minY;
  if (!(lift > 0)) return;
  for (let i = 1; i < positions.length; i += 3) positions[i] += lift;
}

function pairKey(i: number, j: number): number {
  return i < j ? i * 0x100000 + j : j * 0x100000 + i;
}

/** Parts authored flush against each other must not be shoved apart on the first step. */
function restContactDistances(parts: readonly CompiledPart[], positions: Float32Array, contactDistance: number): Map<number, number> {
  const close = new Map<number, number>();
  const contact2 = contactDistance * contactDistance;
  for (let a = 0; a < parts.length; a++) {
    for (let b = a + 1; b < parts.length; b++) {
      for (const i of parts[a].surfaceParticles) {
        for (const j of parts[b].surfaceParticles) {
          const dx = positions[j * 3] - positions[i * 3];
          const dy = positions[j * 3 + 1] - positions[i * 3 + 1];
          const dz = positions[j * 3 + 2] - positions[i * 3 + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < contact2) close.set(pairKey(i, j), Math.sqrt(d2));
        }
      }
    }
  }
  return close;
}

/** Rigid parts, merged into one group when welded to each other. */
function rigidGroups(parts: readonly CompiledPart[], welds: readonly CompiledWeld[]): CompiledPart[][] {
  const rigid = parts.filter((part) => part.kind === 'rigid');
  const parent = new Map(rigid.map((part) => [part.id, part.id]));
  const find = (id: string): string => {
    const next = parent.get(id)!;
    if (next === id) return id;
    const root = find(next);
    parent.set(id, root);
    return root;
  };
  for (const weld of welds) {
    if (parent.has(weld.partA) && parent.has(weld.partB)) parent.set(find(weld.partA), find(weld.partB));
  }
  const groups = new Map<string, CompiledPart[]>();
  for (const part of rigid) {
    const root = find(part.id);
    groups.set(root, [...(groups.get(root) ?? []), part]);
  }
  return [...groups.values()];
}

function nearWeld(welds: readonly CompiledWeld[], positions: Float32Array, particle: number): boolean {
  const px = positions[particle * 3];
  const py = positions[particle * 3 + 1];
  const pz = positions[particle * 3 + 2];
  for (const weld of welds) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < 3; k++) {
      const p = weld.particles[k] * 3;
      x += positions[p] * weld.weights[k];
      y += positions[p + 1] * weld.weights[k];
      z += positions[p + 2] * weld.weights[k];
    }
    if ((px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2 < WELD_CONTACT_CLEARANCE ** 2) return true;
  }
  return false;
}

function boundsOverlap(a: CompiledPart, b: CompiledPart, positions: Float32Array, pad: number): boolean {
  const left = bounds(a, positions);
  const right = bounds(b, positions);
  return (
    left.minX <= right.maxX + pad &&
    left.maxX >= right.minX - pad &&
    left.minY <= right.maxY + pad &&
    left.maxY >= right.minY - pad &&
    left.minZ <= right.maxZ + pad &&
    left.maxZ >= right.minZ - pad
  );
}

function bounds(part: CompiledPart, positions: Float32Array) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < part.count; i++) {
    const p = (part.offset + i) * 3;
    const x = positions[p];
    const y = positions[p + 1];
    const z = positions[p + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
    return { minX, minY, minZ, maxX, maxY, maxZ };
}
