import * as THREE from 'three';
import { localMesh } from '../simulation/assembly/partMeshes';
import {
  cloneDocument,
  nextId,
  shapeForKind,
  validateDocument,
  type AssemblyDocument,
  type AssemblyPart,
  type Vec3,
  type WeldSample,
} from './AssemblyDocument';
import { matrixForPart } from './partTransform';

const WELD_COLORS = [0xff5f8f, 0x48e0ff, 0xffd166, 0xc084fc];
/** Largest gap between two surfaces that the brush still treats as touching. */
export const WELD_TOLERANCE = 0.02;
const SAMPLE_SPACING = 0.03;
const point = new THREE.Vector3();
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();
const ab = new THREE.Vector3();
const ac = new THREE.Vector3();
const ap = new THREE.Vector3();

export function worldAnchor(part: AssemblyPart, triangle: number, barycentric: Vec3, target = new THREE.Vector3()): THREE.Vector3 {
  const mesh = localMesh(shapeForKind(part.kind));
  const matrix = matrixForPart(part);
  const base = triangle * 3;
  target.set(0, 0, 0);
  for (let k = 0; k < 3; k++) {
    const index = mesh.triangles[base + k];
    point.set(mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2]);
    point.applyMatrix4(matrix);
    target.addScaledVector(point, barycentric[k]);
  }
  return target;
}

/** Samples coincident surface triangles so the layered example starts welded. */
export function contactSamples(
  partA: AssemblyPart,
  partB: AssemblyPart,
  tolerance = 0.008,
  limit = 12,
): WeldSample[] {
  const meshA = localMesh(shapeForKind(partA.kind));
  const meshB = localMesh(shapeForKind(partB.kind));
  const worldA = transformed(partA);
  const worldB = transformed(partB);
  const samples: WeldSample[] = [];
  const count = meshA.triangles.length / 3;
  const stride = Math.max(1, Math.floor(count / 48));
  for (let triangle = 0; triangle < count && samples.length < limit; triangle += stride) {
    centroid(worldA, meshA.triangles, triangle, point);
    const hit = closestTriangle(point, worldB, meshB.triangles);
    if (!hit || hit.distance > tolerance) continue;
    samples.push({
      id: `${partA.id}-${partB.id}-${samples.length + 1}`,
      partA: partA.id,
      partB: partB.id,
      anchorA: { triangle, barycentric: [1 / 3, 1 / 3, 1 / 3] },
      anchorB: { triangle: hit.triangle, barycentric: hit.barycentric },
      color: WELD_COLORS[samples.length % WELD_COLORS.length],
    });
  }
  return samples;
}

/**
 * Welds every touching surface within the brush radius of `point`, including faces hidden
 * between stacked parts. `partners` limits which parts the brushed part may weld to.
 */
export function brushWelds(
  document: AssemblyDocument,
  partId: string,
  point: Vec3,
  partners: readonly string[] | null,
): { document: AssemblyDocument; contacts: number } {
  const partA = document.parts.find((part) => part.id === partId);
  if (!partA) return { document, contacts: 0 };
  const radius = document.settings.brushRadius;
  const probe = new THREE.Vector3(...point);
  const sample = new THREE.Vector3();
  const meshA = localMesh(shapeForKind(partA.kind));
  const worldA = transformed(partA);
  const nearby: number[] = [];
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  for (let triangle = 0; triangle < meshA.triangles.length / 3; triangle++) {
    read(worldA, meshA.triangles[triangle * 3], va);
    read(worldA, meshA.triangles[triangle * 3 + 1], vb);
    read(worldA, meshA.triangles[triangle * 3 + 2], vc);
    const [u, v, w] = barycentricOf(probe, va, vb, vc);
    sample.copy(va).multiplyScalar(u).addScaledVector(vb, v).addScaledVector(vc, w);
    if (sample.distanceTo(probe) <= radius) nearby.push(triangle);
  }
  const brushedEdges = edgesNear(worldA, meshA.triangles, probe, radius);
  let next = document;
  let contacts = 0;
  for (const partB of document.parts) {
    if (partB.id === partA.id || (partners && !partners.includes(partB.id))) continue;
    const meshB = localMesh(shapeForKind(partB.kind));
    const worldB = transformed(partB);
    for (const triangle of nearby) {
      centroid(worldA, meshA.triangles, triangle, sample);
      const hit = closestTriangle(sample, worldB, meshB.triangles);
      if (!hit || hit.distance > WELD_TOLERANCE) continue;
      contacts++;
      next = addWeldSample(next, {
        partA: partA.id,
        partB: partB.id,
        anchorA: { triangle, barycentric: [1 / 3, 1 / 3, 1 / 3] },
        anchorB: { triangle: hit.triangle, barycentric: hit.barycentric },
        color: 0xffd166,
      });
    }
    const partnerEdges = surfaceEdges(meshB.triangles);
    for (const edge of brushedEdges) {
      const hit = closestEdge(worldA, edge, worldB, partnerEdges);
      if (!hit || hit.distance > WELD_TOLERANCE) continue;
      contacts++;
      next = addWeldSample(next, {
        partA: partA.id,
        partB: partB.id,
        anchorA: { triangle: edge.triangle, barycentric: edgeBarycentric(meshA.triangles, edge, hit.s) },
        anchorB: { triangle: hit.edge.triangle, barycentric: edgeBarycentric(meshB.triangles, hit.edge, hit.t) },
        color: 0xffd166,
      });
    }
  }
  return { document: next, contacts };
}

export function addWeldSample(document: AssemblyDocument, sample: Omit<WeldSample, 'id'>): AssemblyDocument {
  const anchor = new THREE.Vector3();
  const partA = document.parts.find((part) => part.id === sample.partA);
  const partB = document.parts.find((part) => part.id === sample.partB);
  if (!partA || !partB) return document;
  worldAnchor(partA, sample.anchorA.triangle, sample.anchorA.barycentric, anchor);
  const duplicate = document.welds.some((weld) => {
    if (!samePair(weld, sample.partA, sample.partB)) return false;
    const existingA = document.parts.find((part) => part.id === weld.partA)!;
    return worldAnchor(existingA, weld.anchorA.triangle, weld.anchorA.barycentric).distanceTo(anchor) < SAMPLE_SPACING;
  });
  if (duplicate) return document;
  const next = cloneDocument(document);
  next.welds.push({
    ...sample,
    id: nextId('weld', next.welds.map((weld) => weld.id)),
    color: sample.color || WELD_COLORS[next.welds.length % WELD_COLORS.length],
  });
  return validateDocument(next);
}

export function eraseWeldsNear(document: AssemblyDocument, worldPoint: Vec3, radius: number): AssemblyDocument {
  const probe = new THREE.Vector3(...worldPoint);
  const next = cloneDocument(document);
  next.welds = next.welds.filter((weld) => {
    const part = next.parts.find((candidate) => candidate.id === weld.partA);
    if (!part) return false;
    return worldAnchor(part, weld.anchorA.triangle, weld.anchorA.barycentric).distanceTo(probe) > radius;
  });
  return next;
}

export function createLayeredExampleDocument(): AssemblyDocument {
  const parts: AssemblyPart[] = [
    {
      id: 'rigid-base',
      label: 'Rigid base',
      kind: 'rigid',
      presetId: 'dense-solid',
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      uniformScale: 0.7,
    },
    {
      id: 'gel-core',
      label: 'Gel core',
      kind: 'volume',
      presetId: 'gel',
      position: [0, 0.7, 0],
      quaternion: [0, 0, 0, 1],
      uniformScale: 0.5,
    },
    {
      id: 'cloth-skin',
      label: 'Cloth skin',
      kind: 'shell',
      presetId: 'loose-cloth',
      position: [0, 1.2, 0],
      quaternion: [0, 0, 0, 1],
      uniformScale: 0.85,
    },
  ];
  const baseGel = contactSamples(parts[0], parts[1]).map((sample) => ({ ...sample, color: 0xff5f8f }));
  const gelCloth = contactSamples(parts[1], parts[2]).map((sample) => ({ ...sample, color: 0x48e0ff }));
  return validateDocument({
    version: 1,
    name: 'Layered block',
    parts,
    welds: [...baseGel, ...gelCloth],
    settings: { gridSnap: false, surfaceSnap: false, brushRadius: 0.08 },
  });
}

function samePair(weld: WeldSample, partA: string, partB: string): boolean {
  return (weld.partA === partA && weld.partB === partB) || (weld.partA === partB && weld.partB === partA);
}

function transformed(part: AssemblyPart): Float32Array {
  const mesh = localMesh(shapeForKind(part.kind));
  const matrix = matrixForPart(part);
  const out = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    point.set(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]).applyMatrix4(matrix);
    out[i] = point.x;
    out[i + 1] = point.y;
    out[i + 2] = point.z;
  }
  return out;
}

interface SurfaceEdge {
  triangle: number;
  a: number;
  b: number;
}

function surfaceEdges(triangles: Uint32Array): SurfaceEdge[] {
  const seen = new Set<number>();
  const edges: SurfaceEdge[] = [];
  for (let triangle = 0; triangle < triangles.length / 3; triangle++) {
    const base = triangle * 3;
    const ids = [triangles[base], triangles[base + 1], triangles[base + 2]];
    for (let k = 0; k < 3; k++) {
      const u = ids[k];
      const v = ids[(k + 1) % 3];
      const key = u < v ? u * 1_000_003 + v : v * 1_000_003 + u;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ triangle, a: u, b: v });
    }
  }
  return edges;
}

function edgesNear(positions: Float32Array, triangles: Uint32Array, probe: THREE.Vector3, radius: number): SurfaceEdge[] {
  return surfaceEdges(triangles).filter((edge) => pointSegmentDistance(probe, positions, edge.a, edge.b) <= radius);
}

function closestEdge(
  positionsA: Float32Array,
  edge: SurfaceEdge,
  positionsB: Float32Array,
  edges: SurfaceEdge[],
): { edge: SurfaceEdge; distance: number; s: number; t: number } | null {
  const a0 = edge.a * 3;
  const a1 = edge.b * 3;
  let best: { edge: SurfaceEdge; distance: number; s: number; t: number } | null = null;
  for (const other of edges) {
    const b0 = other.a * 3;
    const b1 = other.b * 3;
    const hit = closestSegments(
      positionsA[a0],
      positionsA[a0 + 1],
      positionsA[a0 + 2],
      positionsA[a1],
      positionsA[a1 + 1],
      positionsA[a1 + 2],
      positionsB[b0],
      positionsB[b0 + 1],
      positionsB[b0 + 2],
      positionsB[b1],
      positionsB[b1 + 1],
      positionsB[b1 + 2],
    );
    if (!best || hit.distance < best.distance) best = { edge: other, ...hit };
  }
  return best;
}

function edgeBarycentric(triangles: Uint32Array, edge: SurfaceEdge, t: number): Vec3 {
  const weights: Vec3 = [0, 0, 0];
  const base = edge.triangle * 3;
  for (let k = 0; k < 3; k++) {
    const index = triangles[base + k];
    if (index === edge.a) weights[k] = 1 - t;
    else if (index === edge.b) weights[k] = t;
  }
  return weights;
}

function pointSegmentDistance(probe: THREE.Vector3, positions: Float32Array, start: number, end: number): number {
  const ia = start * 3;
  const ib = end * 3;
  const abx = positions[ib] - positions[ia];
  const aby = positions[ib + 1] - positions[ia + 1];
  const abz = positions[ib + 2] - positions[ia + 2];
  const length2 = abx * abx + aby * aby + abz * abz;
  const t = length2 < 1e-12
    ? 0
    : Math.min(1, Math.max(0, ((probe.x - positions[ia]) * abx + (probe.y - positions[ia + 1]) * aby + (probe.z - positions[ia + 2]) * abz) / length2));
  const dx = positions[ia] + abx * t - probe.x;
  const dy = positions[ia + 1] + aby * t - probe.y;
  const dz = positions[ia + 2] + abz * t - probe.z;
  return Math.hypot(dx, dy, dz);
}

/** Closest points on two segments. `s` and `t` run from the first endpoint to the second. */
function closestSegments(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  dx: number,
  dy: number,
  dz: number,
): { distance: number; s: number; t: number } {
  const d1x = bx - ax;
  const d1y = by - ay;
  const d1z = bz - az;
  const d2x = dx - cx;
  const d2y = dy - cy;
  const d2z = dz - cz;
  const rx = ax - cx;
  const ry = ay - cy;
  const rz = az - cz;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0;
  let t = 0;
  if (a <= 1e-12 && e <= 1e-12) {
    s = 0;
    t = 0;
  } else if (a <= 1e-12) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-12) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const px = ax + d1x * s - (cx + d2x * t);
  const py = ay + d1y * s - (cy + d2y * t);
  const pz = az + d1z * s - (cz + d2z * t);
  return { distance: Math.hypot(px, py, pz), s, t };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function centroid(positions: Float32Array, triangles: Uint32Array, triangle: number, target: THREE.Vector3): void {
  target.set(0, 0, 0);
  for (let k = 0; k < 3; k++) {
    const index = triangles[triangle * 3 + k] * 3;
    target.x += positions[index];
    target.y += positions[index + 1];
    target.z += positions[index + 2];
  }
  target.multiplyScalar(1 / 3);
}

function closestTriangle(
  probe: THREE.Vector3,
  positions: Float32Array,
  triangles: Uint32Array,
): { triangle: number; distance: number; barycentric: Vec3 } | null {
  let best = Infinity;
  let triangle = -1;
  let barycentric: Vec3 = [1, 0, 0];
  for (let t = 0; t < triangles.length; t += 3) {
    read(positions, triangles[t], a);
    read(positions, triangles[t + 1], b);
    read(positions, triangles[t + 2], c);
    const weights = barycentricOf(probe, a, b, c);
    const projected = a.clone().multiplyScalar(weights[0]).addScaledVector(b, weights[1]).addScaledVector(c, weights[2]);
    const distance = projected.distanceTo(probe);
    if (distance < best) {
      best = distance;
      triangle = t / 3;
      barycentric = weights;
    }
  }
  if (triangle < 0) return null;
  return { triangle, distance: best, barycentric };
}

function read(positions: Float32Array, index: number, target: THREE.Vector3): void {
  target.set(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
}

function barycentricOf(p: THREE.Vector3, va: THREE.Vector3, vb: THREE.Vector3, vc: THREE.Vector3): Vec3 {
  ab.subVectors(vb, va);
  ac.subVectors(vc, va);
  ap.subVectors(p, va);
  const d00 = ab.dot(ab);
  const d01 = ab.dot(ac);
  const d11 = ac.dot(ac);
  const d20 = ap.dot(ab);
  const d21 = ap.dot(ac);
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-12) return [1, 0, 0];
  let v = (d11 * d20 - d01 * d21) / denom;
  let w = (d00 * d21 - d01 * d20) / denom;
  let u = 1 - v - w;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  u = clamp(u);
  v = clamp(v);
  w = clamp(w);
  const sum = u + v + w || 1;
  return [u / sum, v / sum, w / sum];
}
