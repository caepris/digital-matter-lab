import * as THREE from 'three';
import { localMesh } from '../simulation/assembly/partMeshes';
import { MAX_SCALE, MIN_SCALE, shapeForKind, type AssemblyPart, type Quat, type Vec3 } from './AssemblyDocument';

const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();
const corner = new THREE.Vector3();

export function matrixForPart(part: AssemblyPart, target = new THREE.Matrix4()): THREE.Matrix4 {
  position.set(part.position[0], part.position[1], part.position[2]);
  quaternion.set(part.quaternion[0], part.quaternion[1], part.quaternion[2], part.quaternion[3]);
  scale.setScalar(part.uniformScale);
  return target.compose(position, quaternion, scale);
}

export function transformPositions(part: AssemblyPart, local: Float32Array, out = new Float32Array(local.length)): Float32Array {
  const matrix = matrixForPart(part);
  for (let i = 0; i < local.length; i += 3) {
    corner.set(local[i], local[i + 1], local[i + 2]).applyMatrix4(matrix);
    out[i] = corner.x;
    out[i + 1] = corner.y;
    out[i + 2] = corner.z;
  }
  return out;
}

export function worldBounds(part: AssemblyPart): { min: Vec3; max: Vec3 } {
  const mesh = localMesh(shapeForKind(part.kind));
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const positions = mesh.positions;
  const matrix = matrixForPart(part);
  const seen = new Set<number>();
  for (let i = 0; i < mesh.triangles.length; i++) seen.add(mesh.triangles[i]);
  for (const index of seen) {
    corner.set(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]).applyMatrix4(matrix);
    minX = Math.min(minX, corner.x);
    minY = Math.min(minY, corner.y);
    minZ = Math.min(minZ, corner.z);
    maxX = Math.max(maxX, corner.x);
    maxY = Math.max(maxY, corner.y);
    maxZ = Math.max(maxZ, corner.z);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export function snapPart(part: AssemblyPart, grid: boolean, surface: boolean, supportY: number | null): AssemblyPart {
  const next = { ...part, position: [...part.position] as Vec3, quaternion: [...part.quaternion] as Quat };
  if (grid) {
    next.position = [
      snap(next.position[0], 0.05),
      surface ? next.position[1] : snap(next.position[1], 0.05),
      snap(next.position[2], 0.05),
    ];
    next.uniformScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, snap(next.uniformScale, 0.1)));
    next.quaternion = snapQuaternion(next.quaternion);
  }
  if (surface && supportY !== null) {
    const bounds = worldBounds(next);
    next.position = [next.position[0], next.position[1] + (supportY - bounds.min[1]), next.position[2]];
  }
  return next;
}

export function supportHeight(part: AssemblyPart, others: readonly AssemblyPart[]): number {
  const bounds = worldBounds(part);
  let support = 0;
  for (const other of others) {
    if (other.id === part.id) continue;
    const otherBounds = worldBounds(other);
    const overlapsX = bounds.min[0] <= otherBounds.max[0] && bounds.max[0] >= otherBounds.min[0];
    const overlapsZ = bounds.min[2] <= otherBounds.max[2] && bounds.max[2] >= otherBounds.min[2];
    if (!overlapsX || !overlapsZ) continue;
    if (otherBounds.max[1] <= bounds.min[1] + 0.05) support = Math.max(support, otherBounds.max[1]);
  }
  return support;
}

function snap(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function snapQuaternion(quaternion: Quat): Quat {
  const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...quaternion), 'XYZ');
  const step = (15 * Math.PI) / 180;
  euler.set(snap(euler.x, step), snap(euler.y, step), snap(euler.z, step));
  const snapped = new THREE.Quaternion().setFromEuler(euler);
  return [snapped.x, snapped.y, snapped.z, snapped.w];
}
