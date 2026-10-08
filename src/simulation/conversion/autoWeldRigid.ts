import * as THREE from 'three';
import type {
  QuatTuple,
  RigidWeldPart,
  RigidWeldSample,
  SurfaceAnchor,
  Vec3Tuple,
} from '../../conversion-editor/RigidWeldDocument';
import type { SourceMesh } from './sourceMeshes';
import {
  rigidAccessory,
  type RigidAccessoryDefinition,
  type RigidAccessoryId,
} from './rigidAccessories';

export const AUTO_WELD_TOLERANCE = 0.045;

export interface SurfacePoint {
  anchor: SurfaceAnchor;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

export function placeRigidAccessory(
  ray: THREE.Ray,
  source: SourceMesh,
  presetId: RigidAccessoryId,
  id: string,
): RigidWeldPart | null {
  const hit = raycastSurface(ray, source.positions, source.triangles);
  if (!hit) return null;
  const preset = rigidAccessory(presetId);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal);
  const position = hit.point.clone().addScaledVector(hit.normal, 0.002);
  const part: RigidWeldPart = {
    id,
    presetId,
    label: preset.label,
    position: position.toArray() as Vec3Tuple,
    quaternion: quaternion.toArray() as QuatTuple,
    uniformScale: preset.defaultScale,
    welds: [],
    valid: false,
  };
  return recomputeRigidWelds(part, source);
}

export function recomputeRigidWelds(part: RigidWeldPart, source: SourceMesh): RigidWeldPart {
  const preset = rigidAccessory(part.presetId as RigidAccessoryId);
  const matrix = matrixForRigidWeld(part);
  const welds: RigidWeldSample[] = [];
  const used = new Set<string>();
  for (let mountIndex = 0; mountIndex < preset.mountPoints.length; mountIndex++) {
    const local = new THREE.Vector3().fromArray(preset.mountPoints[mountIndex]);
    const world = local.clone().applyMatrix4(matrix);
    const sourceHit = closestSurfacePoint(world, source.positions, source.triangles);
    if (!sourceHit || sourceHit.distance > AUTO_WELD_TOLERANCE * part.uniformScale) continue;
    const accessoryHit = closestSurfacePoint(local, preset.positions, preset.triangles);
    if (!accessoryHit) continue;
    const key = `${sourceHit.anchor.triangle}:${accessoryHit.anchor.triangle}`;
    if (used.has(key)) continue;
    used.add(key);
    welds.push({
      id: `${part.id}-weld-${mountIndex + 1}`,
      sourceAnchor: sourceHit.anchor,
      accessoryAnchor: accessoryHit.anchor,
    });
  }
  return { ...part, welds, valid: welds.length > 0 };
}

export function matrixForRigidWeld(part: Pick<RigidWeldPart, 'position' | 'quaternion' | 'uniformScale'>): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(part.position),
    new THREE.Quaternion().fromArray(part.quaternion),
    new THREE.Vector3().setScalar(part.uniformScale),
  );
}

export function transformAccessoryPositions(part: RigidWeldPart): Float32Array {
  const local = rigidAccessory(part.presetId as RigidAccessoryId).positions;
  const out = new Float32Array(local.length);
  const matrix = matrixForRigidWeld(part);
  const point = new THREE.Vector3();
  for (let i = 0; i < local.length; i += 3) {
    point.fromArray(local, i).applyMatrix4(matrix).toArray(out, i);
  }
  return out;
}

export function pointForAnchor(
  anchor: SurfaceAnchor,
  positions: Float32Array,
  triangles: Uint32Array,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  const offset = anchor.triangle * 3;
  const a = triangles[offset] * 3;
  const b = triangles[offset + 1] * 3;
  const c = triangles[offset + 2] * 3;
  const [wa, wb, wc] = anchor.barycentric;
  return target.set(
    positions[a] * wa + positions[b] * wb + positions[c] * wc,
    positions[a + 1] * wa + positions[b + 1] * wb + positions[c + 1] * wc,
    positions[a + 2] * wa + positions[b + 2] * wb + positions[c + 2] * wc,
  );
}

export function raycastSurface(
  ray: THREE.Ray,
  positions: Float32Array,
  triangles: Uint32Array,
): SurfacePoint | null {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const point = new THREE.Vector3();
  let best: SurfacePoint | null = null;
  let bestDistance = Infinity;
  for (let offset = 0; offset < triangles.length; offset += 3) {
    a.fromArray(positions, triangles[offset] * 3);
    b.fromArray(positions, triangles[offset + 1] * 3);
    c.fromArray(positions, triangles[offset + 2] * 3);
    if (!ray.intersectTriangle(a, b, c, false, point)) continue;
    const distance = point.distanceTo(ray.origin);
    if (distance >= bestDistance) continue;
    const barycentric = THREE.Triangle.getBarycoord(point, a, b, c, new THREE.Vector3());
    if (!barycentric) continue;
    const normal = new THREE.Triangle(a, b, c).getNormal(new THREE.Vector3());
    bestDistance = distance;
    best = {
      anchor: {
        triangle: offset / 3,
        barycentric: barycentric.toArray() as Vec3Tuple,
      },
      point: point.clone(),
      normal,
      distance,
    };
  }
  return best;
}

export function closestSurfacePoint(
  point: THREE.Vector3,
  positions: Float32Array,
  triangles: Uint32Array,
): SurfacePoint | null {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const closest = new THREE.Vector3();
  let best: SurfacePoint | null = null;
  let bestDistance = Infinity;
  for (let offset = 0; offset < triangles.length; offset += 3) {
    a.fromArray(positions, triangles[offset] * 3);
    b.fromArray(positions, triangles[offset + 1] * 3);
    c.fromArray(positions, triangles[offset + 2] * 3);
    new THREE.Triangle(a, b, c).closestPointToPoint(point, closest);
    const distance = closest.distanceTo(point);
    if (distance >= bestDistance) continue;
    const barycentric = THREE.Triangle.getBarycoord(closest, a, b, c, new THREE.Vector3());
    if (!barycentric) continue;
    bestDistance = distance;
    best = {
      anchor: {
        triangle: offset / 3,
        barycentric: barycentric.toArray() as Vec3Tuple,
      },
      point: closest.clone(),
      normal: new THREE.Triangle(a, b, c).getNormal(new THREE.Vector3()),
      distance,
    };
  }
  return best;
}

export function accessoryDefinitionForPart(part: RigidWeldPart): RigidAccessoryDefinition {
  return rigidAccessory(part.presetId as RigidAccessoryId);
}
