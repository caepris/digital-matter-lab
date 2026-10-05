import * as THREE from 'three';
import type { SimulationFrame } from '../simulation/types';
import type { BodyVisual } from './PanelView';
import { createRigidOverlay } from './StructureOverlay';

export class RigidVisual implements BodyVisual {
  readonly object = new THREE.Group();
  private readonly geometry: THREE.BoxGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly overlay;

  constructor(halfExtents: [number, number, number], color: number) {
    const [hx, hy, hz] = halfExtents;
    this.geometry = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    this.material = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.25 });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.object.add(mesh);

    this.overlay = createRigidOverlay(halfExtents);
    this.object.add(this.overlay.object);
  }

  setColor(color: number): void {
    this.material.color.setHex(color);
  }

  update(frame: SimulationFrame): void {
    if (frame.cubePosition) this.object.position.fromArray(frame.cubePosition);
    if (frame.cubeQuaternion) this.object.quaternion.fromArray(frame.cubeQuaternion);
  }

  setStructureVisible(visible: boolean): void {
    this.overlay.object.visible = visible;
    this.material.transparent = visible;
    this.material.opacity = visible ? 0.45 : 1;
    this.material.depthWrite = !visible;
    this.material.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.overlay.dispose();
  }
}
