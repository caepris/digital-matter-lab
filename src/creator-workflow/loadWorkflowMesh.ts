import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  buildWorkflowSurface,
  type WorkflowAssetId,
  type WorkflowSurface,
  type WorkflowSurfaceVariant,
} from './workflowAssets';

const cache = new Map<string, Promise<WorkflowSurface>>();

/** Loads `{id}.glb` (capped) or `{id}-open.glb`, falling back to the procedural builder. */
export function loadWorkflowSurface(
  id: WorkflowAssetId,
  variant: WorkflowSurfaceVariant = 'capped',
): Promise<WorkflowSurface> {
  const file = variant === 'open' ? `${id}-open` : id;
  let pending = cache.get(file);
  if (!pending) {
    pending = loadGlb(file).catch(() => buildWorkflowSurface(id, 1, variant));
    cache.set(file, pending);
  }
  return pending;
}

export function clearWorkflowMeshCache(): void {
  cache.clear();
}

async function loadGlb(file: string): Promise<WorkflowSurface> {
  const gltf = await new GLTFLoader().loadAsync(`./creator-workflow/${file}.glb`);
  gltf.scene.updateMatrixWorld(true);
  const positions: number[] = [];
  const uvs: number[] = [];
  const regions: number[] = [];
  const triangles: number[] = [];
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !(object.geometry instanceof THREE.BufferGeometry)) return;
    const geometry = object.geometry;
    const position = geometry.getAttribute('position');
    if (!position) return;
    const uv = geometry.getAttribute('uv');
    // GLTFLoader lowercases custom attribute names.
    const region = geometry.getAttribute('_capregion');
    const offset = positions.length / 3;
    const point = new THREE.Vector3();
    for (let index = 0; index < position.count; index += 1) {
      point.fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld);
      positions.push(point.x, point.y, point.z);
      uvs.push(uv ? uv.getX(index) : 0, uv ? uv.getY(index) : 0);
      regions.push(region ? Math.round(region.getX(index)) : 0);
    }
    if (geometry.index) {
      for (let index = 0; index < geometry.index.count; index += 1) {
        triangles.push(offset + geometry.index.getX(index));
      }
    } else {
      for (let index = 0; index < position.count; index += 1) triangles.push(offset + index);
    }
  });
  if (positions.length === 0 || triangles.length === 0) throw new Error(`No mesh geometry in ${file}.glb`);
  return {
    positions: new Float32Array(positions),
    triangles: new Uint32Array(triangles),
    uvs: new Float32Array(uvs),
    capRegion: new Uint8Array(regions),
    source: 'authored',
  };
}
