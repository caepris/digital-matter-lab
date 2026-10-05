import * as THREE from 'three';

const STRUCTURE_COLOR = 0xf4f6fa;

export interface StructureOverlay {
  readonly object: THREE.Object3D;
  dispose(): void;
}

/** Collider outline, body axes, and center-of-mass marker; it moves with the rigid transform it is parented to. */
export function createRigidOverlay(halfExtents: [number, number, number]): StructureOverlay {
  const group = new THREE.Group();
  const [hx, hy, hz] = halfExtents;

  const boxGeometry = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
  const edgesGeometry = new THREE.EdgesGeometry(boxGeometry);
  boxGeometry.dispose();
  const edgeMaterial = new THREE.LineBasicMaterial({ color: STRUCTURE_COLOR, depthTest: false, transparent: true });
  const edges = new THREE.LineSegments(edgesGeometry, edgeMaterial);
  edges.renderOrder = 10;
  group.add(edges);

  const axes = new THREE.AxesHelper(Math.max(hx, hy, hz) * 0.9);
  const axesMaterial = axes.material as THREE.Material;
  axesMaterial.depthTest = false;
  axes.renderOrder = 11;
  group.add(axes);

  const markerGeometry = new THREE.SphereGeometry(0.035, 16, 8);
  const markerMaterial = new THREE.MeshBasicMaterial({ color: STRUCTURE_COLOR, depthTest: false });
  const marker = new THREE.Mesh(markerGeometry, markerMaterial);
  marker.renderOrder = 12;
  group.add(marker);

  group.visible = false;
  return {
    object: group,
    dispose() {
      edgesGeometry.dispose();
      edgeMaterial.dispose();
      axes.geometry.dispose();
      axesMaterial.dispose();
      markerGeometry.dispose();
      markerMaterial.dispose();
    },
  };
}

export interface ParticleOverlay extends StructureOverlay {
  /** Call after the shared position attribute changes. */
  update(): void;
}

/** Constraint edges and particles drawn straight from the simulation's position buffer. */
export function createParticleOverlay(
  positions: THREE.BufferAttribute,
  edges: Uint32Array,
  pointSize: number,
): ParticleOverlay {
  const group = new THREE.Group();

  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', positions);
  lineGeometry.setIndex(new THREE.BufferAttribute(edges, 1));
  const lineMaterial = new THREE.LineBasicMaterial({
    color: STRUCTURE_COLOR,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.frustumCulled = false;
  lines.renderOrder = 10;
  group.add(lines);

  const pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setAttribute('position', positions);
  const pointMaterial = new THREE.PointsMaterial({
    color: STRUCTURE_COLOR,
    size: pointSize,
    sizeAttenuation: true,
    depthWrite: false,
  });
  const points = new THREE.Points(pointGeometry, pointMaterial);
  points.frustumCulled = false;
  points.renderOrder = 11;
  group.add(points);

  group.visible = false;
  return {
    object: group,
    update() {
      positions.needsUpdate = true;
    },
    dispose() {
      lineGeometry.dispose();
      lineMaterial.dispose();
      pointGeometry.dispose();
      pointMaterial.dispose();
    },
  };
}
