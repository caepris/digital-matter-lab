import {
  findPreset,
  RIGID_PRESETS,
  SHELL_PRESETS,
  VOLUME_PRESETS,
  type PlasticSettings,
} from '../../materials/presets';
import type { AssemblyDocument, AssemblyPart, WeldSample } from '../../assembly-editor/AssemblyDocument';
import { shapeForKind } from '../../assembly-editor/AssemblyDocument';
import { transformPositions } from '../../assembly-editor/partTransform';
import type { CompositePartTopology, WeldTopology } from '../types';
import type { BarycentricWeld } from '../xpbd/weldConstraints';
import { localMesh, type LocalMesh } from './partMeshes';
import { refineShellContacts } from './refineShellContacts';

export interface CompiledPart {
  id: string;
  label: string;
  kind: AssemblyPart['kind'];
  presetId: string;
  color: number;
  offset: number;
  count: number;
  triangles: Uint32Array;
  structureEdges: Uint32Array;
  surfaceParticles: Uint32Array;
  damping: number;
  friction: number;
  doubleSided: boolean;
  edges: Uint32Array | null;
  tets: Uint32Array | null;
  stretch: Uint32Array | null;
  bend: Uint32Array | null;
  plastic: PlasticSettings | null;
  volumePlastic: boolean;
  /** Sheet vertices held on a solid feature edge so the sheet hinges around the outline. */
  outlinePins: OutlinePin[];
}

export interface OutlinePin {
  particle: number;
  a: number;
  b: number;
  t: number;
}

export interface CompiledWeld extends BarycentricWeld {
  id: string;
  label: string;
  color: number;
  partA: string;
  partB: string;
}

export interface CompiledAssembly {
  positions: Float32Array;
  masses: Float32Array;
  damping: Float32Array;
  friction: Float32Array;
  parts: CompiledPart[];
  welds: CompiledWeld[];
  surfaceTriangles: Uint32Array;
  substeps: number;
  topologyParts: CompositePartTopology[];
  topologyWelds: WeldTopology[];
}

export function compileAssembly(document: AssemblyDocument): CompiledAssembly {
  const built = document.parts.map((part) => ({ part, mesh: localMesh(shapeForKind(part.kind)) }));
  const count = built.reduce((sum, entry) => sum + entry.mesh.positions.length / 3, 0);
  const positions = new Float32Array(count * 3);
  const masses = new Float32Array(count);
  const damping = new Float32Array(count);
  const friction = new Float32Array(count);
  const parts: CompiledPart[] = [];
  let offset = 0;
  let substeps = 8;

  for (const { part, mesh } of built) {
    const world = transformPositions(part, mesh.positions);
    positions.set(world, offset * 3);
    const material = materialFor(part);
    substeps = Math.max(substeps, material.substeps);
    const particleCount = mesh.positions.length / 3;
    const mass = material.mass / particleCount;
    for (let i = 0; i < particleCount; i++) {
      masses[offset + i] = mass;
      damping[offset + i] = material.damping;
      friction[offset + i] = material.friction;
    }
    const triangles = shift(mesh.triangles, offset);
    const structureEdges = shift(mesh.edges, offset);
    parts.push({
      id: part.id,
      label: part.label,
      kind: part.kind,
      presetId: part.presetId,
      color: material.color,
      offset,
      count: particleCount,
      triangles,
      structureEdges,
      surfaceParticles: Uint32Array.from(mesh.surfaceParticles, (index) => index + offset),
      damping: material.damping,
      friction: material.friction,
      doubleSided: part.kind === 'shell',
      edges: part.kind === 'volume' ? shift(mesh.edges, offset) : null,
      tets: part.kind === 'volume' && mesh.tets ? shift(mesh.tets, offset) : null,
      stretch: part.kind === 'shell' && mesh.stretchPairs ? shift(mesh.stretchPairs, offset) : null,
      bend: part.kind === 'shell' && mesh.bendPairs ? shift(mesh.bendPairs, offset) : null,
      plastic: material.plastic,
      volumePlastic: part.kind === 'volume' && material.plastic !== null,
      outlinePins: [],
    });
    offset += particleCount;
  }

  const particles = refineShellContacts({ positions, masses, damping, friction }, parts);
  const welds = document.welds.flatMap((weld) => compileWeld(weld, document, built, parts));
  const surfaceTriangles = new Uint32Array(parts.reduce((sum, part) => sum + part.triangles.length, 0));
  let cursor = 0;
  for (const part of parts) {
    surfaceTriangles.set(part.triangles, cursor);
    cursor += part.triangles.length;
  }
  return {
    positions: particles.positions,
    masses: particles.masses,
    damping: particles.damping,
    friction: particles.friction,
    parts,
    welds,
    surfaceTriangles,
    substeps,
    topologyParts: parts.map(topologyPart),
    topologyWelds: topologyWelds(welds, document),
  };
}

function compileWeld(
  weld: WeldSample,
  document: AssemblyDocument,
  built: { part: AssemblyPart; mesh: LocalMesh }[],
  parts: CompiledPart[],
): CompiledWeld[] {
  const first = built.find((entry) => entry.part.id === weld.partA);
  const second = built.find((entry) => entry.part.id === weld.partB);
  if (!first || !second) return [];
  const anchor = (entry: { part: AssemblyPart; mesh: LocalMesh }, triangle: number, weights: [number, number, number]) => {
    const base = triangle * 3;
    const compiled = parts.find((part) => part.id === entry.part.id);
    const partOffset = compiled?.offset ?? 0;
    return {
      particles: [0, 1, 2].map((k) => entry.mesh.triangles[base + k] + partOffset),
      weights,
    };
  };
  const a = anchor(first, weld.anchorA.triangle, weld.anchorA.barycentric);
  const b = anchor(second, weld.anchorB.triangle, weld.anchorB.barycentric);
  const partA = document.parts.find((part) => part.id === weld.partA);
  const partB = document.parts.find((part) => part.id === weld.partB);
  return [
    {
      id: weld.id,
      label: `${partA?.label ?? weld.partA} ↔ ${partB?.label ?? weld.partB}`,
      color: weld.color,
      partA: weld.partA,
      partB: weld.partB,
      particles: new Uint32Array([...a.particles, ...b.particles]),
      weights: new Float32Array([...a.weights, ...b.weights]),
    },
  ];
}

function materialFor(part: AssemblyPart): {
  color: number;
  mass: number;
  damping: number;
  friction: number;
  substeps: number;
  plastic: PlasticSettings | null;
} {
  const volume = part.uniformScale ** 3;
  const area = part.uniformScale ** 2;
  if (part.kind === 'rigid') {
    const preset = findPreset(RIGID_PRESETS, part.presetId);
    return { color: preset.color, mass: preset.density * volume * 0.15, damping: 0.8, friction: preset.friction, substeps: 8, plastic: null };
  }
  if (part.kind === 'volume') {
    const preset = findPreset(VOLUME_PRESETS, part.presetId);
    return {
      color: preset.color,
      mass: 1.1 * volume,
      damping: preset.damping,
      friction: preset.friction,
      substeps: preset.substeps,
      plastic: preset.plastic,
    };
  }
  const preset = findPreset(SHELL_PRESETS, part.presetId);
  return {
    color: preset.color,
    mass: 0.2 * area,
    damping: preset.damping,
    friction: preset.friction,
    substeps: preset.substeps,
    plastic: preset.plastic,
  };
}

function shift(indices: Uint32Array, offset: number): Uint32Array {
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = indices[i] + offset;
  return out;
}

function topologyPart(part: CompiledPart): CompositePartTopology {
  return {
    id: part.id,
    label: part.label,
    materialKind: part.kind,
    color: part.color,
    triangles: part.triangles,
    structureEdges: part.structureEdges,
    doubleSided: part.doubleSided,
  };
}

function topologyWelds(welds: CompiledWeld[], document: AssemblyDocument): WeldTopology[] {
  const groups = new Map<string, WeldTopology & { indices: number[] }>();
  for (const weld of welds) {
    const key = [weld.partA, weld.partB].sort().join('|');
    let group = groups.get(key);
    if (!group) {
      const partA = document.parts.find((part) => part.id === weld.partA);
      const partB = document.parts.find((part) => part.id === weld.partB);
      group = {
        id: key,
        label: `${partA?.label ?? weld.partA} ↔ ${partB?.label ?? weld.partB}`,
        color: weld.color,
        particleIndices: new Uint32Array(),
        indices: [],
      };
      groups.set(key, group);
    }
    let best = 0;
    for (let k = 1; k < 3; k++) if (weld.weights[k] > weld.weights[best]) best = k;
    group.indices.push(weld.particles[best]);
  }
  return [...groups.values()].map((group) => ({
    id: group.id,
    label: group.label,
    color: group.color,
    particleIndices: new Uint32Array(group.indices),
  }));
}
