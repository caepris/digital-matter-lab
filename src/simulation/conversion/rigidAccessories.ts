import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const RIGID_ACCESSORY_IDS = ['button', 'zipper-pull', 'buckle', 'plate', 'hook'] as const;
export type RigidAccessoryId = (typeof RIGID_ACCESSORY_IDS)[number];

export interface RigidAccessoryDefinition {
  id: RigidAccessoryId;
  label: string;
  color: number;
  mass: number;
  defaultScale: number;
  positions: Float32Array;
  triangles: Uint32Array;
  /** Local points on the z=0 mounting plane. Local +Z faces away from the source. */
  mountPoints: readonly [number, number, number][];
}

const cache = new Map<RigidAccessoryId, RigidAccessoryDefinition>();

export function rigidAccessory(id: RigidAccessoryId): RigidAccessoryDefinition {
  const cached = cache.get(id);
  if (cached) return cached;
  const definition = buildDefinition(id);
  cache.set(id, definition);
  return definition;
}

export function listRigidAccessories(): RigidAccessoryDefinition[] {
  return RIGID_ACCESSORY_IDS.map(rigidAccessory);
}

function buildDefinition(id: RigidAccessoryId): RigidAccessoryDefinition {
  if (id === 'button') {
    const geometry = new THREE.CylinderGeometry(0.045, 0.045, 0.018, 16, 1, false);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, 0.009);
    return definition(id, 'Button', 0xd0aa64, 0.015, 1, geometry, [
      [-0.018, 0, 0],
      [0.018, 0, 0],
    ]);
  }
  if (id === 'plate') {
    const geometry = new THREE.BoxGeometry(0.16, 0.1, 0.018, 2, 2, 1);
    geometry.translate(0, 0, 0.009);
    return definition(id, 'Plate', 0x98a3ad, 0.12, 1, geometry, [
      [-0.055, -0.03, 0],
      [0.055, -0.03, 0],
      [-0.055, 0.03, 0],
      [0.055, 0.03, 0],
    ]);
  }
  if (id === 'buckle') {
    const pieces = [
      boxPiece(new THREE.BoxGeometry(1, 1, 1), [0, 0.046, 0.012], [0.15, 0.018, 0.024]),
      boxPiece(new THREE.BoxGeometry(1, 1, 1), [0, -0.046, 0.012], [0.15, 0.018, 0.024]),
      boxPiece(new THREE.BoxGeometry(1, 1, 1), [-0.066, 0, 0.012], [0.018, 0.075, 0.024]),
      boxPiece(new THREE.BoxGeometry(1, 1, 1), [0.066, 0, 0.012], [0.018, 0.075, 0.024]),
      boxPiece(new THREE.BoxGeometry(1, 1, 1), [0, 0, 0.014], [0.11, 0.014, 0.018]),
      boxPiece(new THREE.BoxGeometry(1, 1, 1), [0, 0, 0.015], [0.014, 0.075, 0.018]),
    ];
    return definition(id, 'Buckle', 0xc2a05d, 0.08, 1, merge(pieces), [
      [-0.055, 0, 0],
      [0.055, 0, 0],
    ]);
  }
  if (id === 'zipper-pull') {
    const ring = new THREE.TorusGeometry(0.025, 0.007, 8, 16);
    ring.translate(0, 0.04, 0.009);
    const tab = new THREE.BoxGeometry(0.038, 0.07, 0.014);
    tab.translate(0, -0.018, 0.009);
    return definition(id, 'Zipper pull', 0xb7bcc2, 0.025, 1, merge([ring, tab]), [[0, 0.064, 0]]);
  }
  const arc = new THREE.TorusGeometry(0.045, 0.009, 8, 20);
  arc.rotateZ(-Math.PI * 0.5);
  arc.translate(0, 0.035, 0.012);
  const stem = new THREE.CylinderGeometry(0.009, 0.009, 0.07, 10);
  stem.translate(-0.035, -0.005, 0.012);
  return definition(id, 'Hook', 0x858d96, 0.04, 1, merge([arc, stem]), [[-0.035, -0.04, 0]]);
}

function definition(
  id: RigidAccessoryId,
  label: string,
  color: number,
  mass: number,
  defaultScale: number,
  geometry: THREE.BufferGeometry,
  mountPoints: readonly [number, number, number][],
): RigidAccessoryDefinition {
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  geometry.dispose();
  nonIndexed.deleteAttribute('normal');
  nonIndexed.deleteAttribute('uv');
  const welded = mergeVertices(nonIndexed, 1e-5);
  nonIndexed.dispose();
  welded.computeVertexNormals();
  const position = welded.getAttribute('position');
  const index = welded.getIndex();
  const positions = new Float32Array(position.array);
  const triangles = index
    ? new Uint32Array(index.array)
    : new Uint32Array(Array.from({ length: position.count }, (_, vertex) => vertex));
  welded.dispose();
  return { id, label, color, mass, defaultScale, positions, triangles, mountPoints };
}

function boxPiece(
  geometry: THREE.BufferGeometry,
  position: [number, number, number],
  size: [number, number, number],
): THREE.BufferGeometry {
  geometry.scale(size[0], size[1], size[2]);
  geometry.translate(...position);
  return geometry;
}

function merge(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const nonIndexed = geometries.map((geometry) => {
    const converted = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    geometry.dispose();
    return converted;
  });
  const merged = mergeGeometries(nonIndexed, false);
  nonIndexed.forEach((geometry) => geometry.dispose());
  if (!merged) throw new Error('Could not build rigid accessory mesh');
  return merged;
}
