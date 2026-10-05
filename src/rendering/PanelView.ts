import * as THREE from 'three';
import {
  CUBE_HALF,
  IMPACTOR_RADIUS,
  MAX_IMPACTORS,
  PLATFORM_HALF,
  PLATFORM_THICKNESS,
  PRESS_HALF_X,
  PRESS_HALF_Y,
  PRESS_HALF_Z,
  PRESS_REST_BOTTOM,
} from '../simulation/scene';
import type { SimulationFrame } from '../simulation/types';

export interface BodyVisual {
  readonly object: THREE.Object3D;
  update(frame: SimulationFrame): void;
  setColor(color: number): void;
  setStructureVisible(visible: boolean): void;
  dispose(): void;
}

const BACKGROUND = 0x15181d;

export class PanelView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
  private readonly impactors: THREE.Mesh[] = [];
  private readonly press: THREE.Group;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(
    accent: number,
    private readonly body: BodyVisual,
  ) {
    this.scene.background = new THREE.Color(BACKGROUND);
    this.scene.fog = new THREE.Fog(BACKGROUND, 9, 18);
    this.camera.position.set(3.1, 2.5, 3.9);
    this.camera.lookAt(0, CUBE_HALF * 0.8, 0);

    this.addLights();
    this.addPlatform(accent);
    this.press = this.createPress();
    this.scene.add(this.press);
    this.createImpactorPool();
    this.scene.add(body.object);
  }

  setAspect(aspect: number): void {
    if (Math.abs(this.camera.aspect - aspect) > 1e-4) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
  }

  update(frame: SimulationFrame, pressToolSelected: boolean): void {
    this.body.update(frame);

    for (let i = 0; i < this.impactors.length; i++) {
      const mesh = this.impactors[i];
      const impactor = frame.impactors[i];
      mesh.visible = impactor !== undefined;
      if (impactor) mesh.position.set(impactor.x, impactor.y, impactor.z);
    }

    const pressLowered = frame.pressBottom < PRESS_REST_BOTTOM - 1e-3;
    this.press.visible = pressToolSelected || pressLowered;
    this.press.position.y = frame.pressBottom + PRESS_HALF_Y;
  }

  setStructureVisible(visible: boolean): void {
    this.body.setStructureVisible(visible);
  }

  setBodyColor(color: number): void {
    this.body.setColor(color);
  }

  dispose(): void {
    this.body.dispose();
    for (const item of this.disposables) item.dispose();
  }

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xdfe7f2, 0x20242b, 1.1));

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2.5, 5.5, 3.2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -2.2;
    key.shadow.camera.right = 2.2;
    key.shadow.camera.top = 2.2;
    key.shadow.camera.bottom = -2.2;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 14;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x9fb4ff, 0.6);
    rim.position.set(-3, 2.5, -3);
    this.scene.add(rim);
  }

  private addPlatform(accent: number): void {
    const geometry = new THREE.BoxGeometry(PLATFORM_HALF * 2, PLATFORM_THICKNESS, PLATFORM_HALF * 2);
    const material = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.85, metalness: 0.05 });
    const platform = new THREE.Mesh(geometry, material);
    platform.position.y = -PLATFORM_THICKNESS / 2;
    platform.receiveShadow = true;
    this.scene.add(platform);

    const grid = new THREE.GridHelper(PLATFORM_HALF * 2, 12, accent, 0x454c57);
    grid.position.y = 0.002;
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.35;
    this.scene.add(grid);

    const edgeGeometry = new THREE.EdgesGeometry(geometry);
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x4a515c });
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    edges.position.copy(platform.position);
    this.scene.add(edges);

    this.disposables.push(geometry, material, grid.geometry, gridMaterial, edgeGeometry, edgeMaterial);
  }

  private createPress(): THREE.Group {
    const group = new THREE.Group();
    const geometry = new THREE.BoxGeometry(PRESS_HALF_X * 2, PRESS_HALF_Y * 2, PRESS_HALF_Z * 2);
    const material = new THREE.MeshStandardMaterial({
      color: 0x8c96a6,
      roughness: 0.4,
      metalness: 0.6,
      transparent: true,
      opacity: 0.55,
    });
    const plate = new THREE.Mesh(geometry, material);
    plate.castShadow = true;
    group.add(plate);

    const edgeGeometry = new THREE.EdgesGeometry(geometry);
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xc8d0dc });
    group.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));

    const rodGeometry = new THREE.CylinderGeometry(0.05, 0.05, 4, 12);
    const rod = new THREE.Mesh(rodGeometry, material);
    rod.position.y = 2 + PRESS_HALF_Y;
    group.add(rod);

    group.visible = false;
    this.disposables.push(geometry, material, edgeGeometry, edgeMaterial, rodGeometry);
    return group;
  }

  private createImpactorPool(): void {
    const geometry = new THREE.SphereGeometry(IMPACTOR_RADIUS, 32, 16);
    const material = new THREE.MeshStandardMaterial({ color: 0xd9dde4, roughness: 0.25, metalness: 0.8 });
    this.disposables.push(geometry, material);
    for (let i = 0; i < MAX_IMPACTORS; i++) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.visible = false;
      this.impactors.push(mesh);
      this.scene.add(mesh);
    }
  }
}
