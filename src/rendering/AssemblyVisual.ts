import * as THREE from 'three';
import type { BodyTopology, CompositePartTopology, SimulationFrame, WeldTopology } from '../simulation/types';
import type { BodyVisual } from './PanelView';

type CompositeTopology = Extract<BodyTopology, { kind: 'composite' }>;

export const VERTEX_COLOR = 0x7fe7ff;
export const EDGE_COLOR = 0x9aa7b8;

interface PartVisual {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
}

interface OverlayVisual {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export class AssemblyVisual implements BodyVisual {
  readonly object = new THREE.Group();
  private readonly positions: THREE.BufferAttribute;
  private readonly parts: PartVisual[] = [];
  private readonly overlays: OverlayVisual[] = [];
  private readonly structure = new THREE.Group();

  constructor(topology: CompositeTopology) {
    this.positions = new THREE.BufferAttribute(new Float32Array(topology.particleCount * 3), 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);

    for (const part of topology.parts) this.addPart(part);
    for (const part of topology.parts) this.addStructure(part);
    for (const weld of topology.welds) this.addWeld(weld);

    this.structure.visible = false;
    this.object.add(this.structure);
  }

  setColor(_color: number): void {
    // Composite parts keep their own material colors.
  }

  update(frame: SimulationFrame): void {
    if (!frame.particles) return;
    (this.positions.array as Float32Array).set(frame.particles);
    this.positions.needsUpdate = true;
    for (const part of this.parts) part.geometry.computeVertexNormals();
  }

  setStructureVisible(visible: boolean): void {
    this.structure.visible = visible;
    for (const { material } of this.parts) {
      material.transparent = visible;
      material.opacity = visible ? 0.3 : 1;
      material.depthWrite = !visible;
      material.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const part of this.parts) {
      part.geometry.dispose();
      part.material.dispose();
    }
    for (const overlay of this.overlays) {
      overlay.geometry.dispose();
      overlay.material.dispose();
    }
  }

  private addPart(part: CompositePartTopology): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.positions);
    geometry.setIndex(new THREE.BufferAttribute(part.triangles, 1));
    const material = new THREE.MeshStandardMaterial({
      color: part.color,
      roughness: part.materialKind === 'rigid' ? 0.32 : part.materialKind === 'shell' ? 0.92 : 0.45,
      metalness: part.materialKind === 'rigid' ? 0.25 : 0,
      side: part.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      polygonOffset: part.doubleSided,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.object.add(mesh);
    this.parts.push({ geometry, material });
  }

  private addStructure(part: CompositePartTopology): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.positions);
    geometry.setIndex(new THREE.BufferAttribute(part.structureEdges, 1));
    const material = new THREE.LineBasicMaterial({
      color: part.color,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    lines.renderOrder = 10;
    this.structure.add(lines);
    this.overlays.push({ geometry, material });

    const vertexMaterial = new THREE.PointsMaterial({
      color: VERTEX_COLOR,
      size: 0.028,
      sizeAttenuation: true,
      depthTest: false,
      depthWrite: false,
    });
    const vertices = new THREE.Points(geometry, vertexMaterial);
    vertices.frustumCulled = false;
    vertices.renderOrder = 15;
    this.structure.add(vertices);
    this.overlays.push({ geometry, material: vertexMaterial });
  }

  private addWeld(weld: WeldTopology): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.positions);
    geometry.setIndex(new THREE.BufferAttribute(weld.particleIndices, 1));
    const material = new THREE.PointsMaterial({
      color: weld.color,
      size: 0.065,
      sizeAttenuation: true,
      depthTest: false,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 20;
    this.structure.add(points);
    this.overlays.push({ geometry, material });
  }
}
