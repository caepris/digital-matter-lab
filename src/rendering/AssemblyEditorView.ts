import * as THREE from 'three';
import { presetById, shapeForKind, type AssemblyDocument, type AssemblyPart, type PartKind } from '../assembly-editor/AssemblyDocument';
import { worldAnchor } from '../assembly-editor/weldPaint';
import { AssemblyVisual, EDGE_COLOR, VERTEX_COLOR } from './AssemblyVisual';
import { PanelView, type BodyVisual } from './PanelView';
import type { SimulationFrame } from '../simulation/types';
import { localMesh } from '../simulation/assembly/partMeshes';

export { EDGE_COLOR, VERTEX_COLOR };

const geometries = new Map<PartKind, THREE.BufferGeometry>();
const edgeGeometries = new Map<PartKind, THREE.EdgesGeometry>();
const latticeGeometries = new Map<PartKind, THREE.BufferGeometry>();

/** Every simulated node (including interior cube nodes) with the mesh's constraint edges as an index. */
function latticeFor(kind: PartKind): THREE.BufferGeometry {
  const cached = latticeGeometries.get(kind);
  if (cached) return cached;
  const mesh = localMesh(shapeForKind(kind));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(mesh.edges), 1));
  latticeGeometries.set(kind, geometry);
  return geometry;
}

const vertexMaterial = new THREE.PointsMaterial({ color: VERTEX_COLOR, size: 0.028, sizeAttenuation: true, depthTest: false });
const latticeMaterial = new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.55, depthTest: false });
const noRaycast = (): void => {};

function geometryFor(kind: PartKind): THREE.BufferGeometry {
  const cached = geometries.get(kind);
  if (cached) return cached;
  const mesh = localMesh(shapeForKind(kind));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.triangles.slice(), 1));
  geometry.computeVertexNormals();
  geometries.set(kind, geometry);
  return geometry;
}

function edgesFor(kind: PartKind): THREE.EdgesGeometry {
  const cached = edgeGeometries.get(kind);
  if (cached) return cached;
  const edges = new THREE.EdgesGeometry(geometryFor(kind));
  edgeGeometries.set(kind, edges);
  return edges;
}

class HiddenBody implements BodyVisual {
  readonly object = new THREE.Group();
  update(): void {}
  setColor(): void {}
  setStructureVisible(): void {}
  dispose(): void {}
}

interface Proxy {
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  vertices: THREE.Points;
  lattice: THREE.LineSegments;
  material: THREE.MeshStandardMaterial;
}

export class AssemblyEditorView {
  readonly panel: PanelView;
  readonly editRoot = new THREE.Group();
  private readonly proxies = new Map<string, Proxy>();
  private readonly weldGeometry = new THREE.BufferGeometry();
  private readonly weldPositions = new THREE.BufferAttribute(new Float32Array(3), 3);
  private readonly welds: THREE.Points;
  private readonly brush: THREE.Mesh;
  private readonly preview: THREE.Mesh;
  private simVisual: AssemblyVisual | null = null;
  private readonly edgeMaterials: THREE.LineBasicMaterial[] = [];
  private structureVisible = false;
  private xray = false;

  constructor(accent: number) {
    this.panel = new PanelView(accent, new HiddenBody());
    this.panel.scene.add(this.editRoot);
    this.weldGeometry.setAttribute('position', this.weldPositions);
    const weldMaterial = new THREE.PointsMaterial({
      color: 0xffd166,
      size: 0.045,
      sizeAttenuation: true,
      depthTest: false,
    });
    this.welds = new THREE.Points(this.weldGeometry, weldMaterial);
    this.welds.frustumCulled = false;
    this.welds.renderOrder = 5;
    this.editRoot.add(this.welds);

    this.brush = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.brush.visible = false;
    this.editRoot.add(this.brush);

    this.preview = new THREE.Mesh(
      geometryFor('rigid'),
      new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.preview.visible = false;
    this.editRoot.add(this.preview);
  }

  get camera(): THREE.PerspectiveCamera {
    return this.panel.camera;
  }

  setAspect(aspect: number): void {
    this.panel.setAspect(aspect);
  }

  get proxiesRoot(): THREE.Group {
    return this.editRoot;
  }

  proxy(id: string): THREE.Mesh | undefined {
    return this.proxies.get(id)?.mesh;
  }

  sync(document: AssemblyDocument, selection: readonly string[]): void {
    const live = new Set(document.parts.map((part) => part.id));
    for (const [id, proxy] of this.proxies) {
      if (live.has(id)) continue;
      this.editRoot.remove(proxy.mesh);
      proxy.material.dispose();
      (proxy.edges.material as THREE.Material).dispose();
      this.proxies.delete(id);
    }
    for (const part of document.parts) {
      const proxy = this.ensureProxy(part);
      applyPart(proxy.mesh, part);
      const selected = selection.includes(part.id);
      proxy.edges.visible = selected;
      proxy.material.emissive.setHex(selected ? 0x1c2430 : 0x000000);
    }
    this.syncWelds(document);
    const brushMaterial = this.brush.material as THREE.MeshBasicMaterial;
    this.brush.scale.setScalar(document.settings.brushRadius / 0.08);
    brushMaterial.color.setHex(0xffd166);
  }

  setPreview(kind: PartKind | null, position: THREE.Vector3 | null, presetId: string): void {
    this.preview.visible = kind !== null && position !== null;
    if (!kind || !position) return;
    this.preview.geometry = geometryFor(kind);
    this.preview.position.copy(position);
    this.preview.scale.setScalar(kind === 'shell' ? 0.8 : 0.6);
    (this.preview.material as THREE.MeshStandardMaterial).color.setHex(presetById(kind, presetId).color);
  }

  setBrush(point: THREE.Vector3 | null, radius?: number, eligible = true): void {
    this.brush.visible = point !== null;
    if (point) this.brush.position.copy(point);
    if (radius !== undefined) this.brush.scale.setScalar(radius / 0.08);
    (this.brush.material as THREE.MeshBasicMaterial).color.setHex(eligible ? 0x6ee7a8 : 0xff6b6b);
  }

  setEditing(editing: boolean): void {
    this.editRoot.visible = editing;
    if (this.simVisual) this.simVisual.object.visible = !editing;
  }

  showSimulation(topology: Extract<import('../simulation/types').BodyTopology, { kind: 'composite' }> | null): void {
    if (this.simVisual) {
      this.panel.scene.remove(this.simVisual.object);
      this.simVisual.dispose();
      this.simVisual = null;
    }
    if (!topology) return;
    this.simVisual = new AssemblyVisual(topology);
    this.panel.scene.add(this.simVisual.object);
    this.simVisual.object.visible = !this.editRoot.visible;
  }

  setStructureVisible(visible: boolean): void {
    this.structureVisible = visible;
    this.simVisual?.setStructureVisible(visible);
    for (const proxy of this.proxies.values()) this.applyStructure(proxy);
  }

  setXray(enabled: boolean): void {
    this.xray = enabled;
    const brushMaterial = this.brush.material as THREE.MeshBasicMaterial;
    brushMaterial.depthTest = !enabled;
    brushMaterial.needsUpdate = true;
    this.brush.renderOrder = enabled ? 6 : 0;
    for (const proxy of this.proxies.values()) this.applyStructure(proxy);
  }

  private applyStructure(proxy: Proxy): void {
    const seeThrough = this.structureVisible || this.xray;
    proxy.lattice.visible = this.structureVisible;
    proxy.vertices.visible = seeThrough;
    proxy.material.transparent = seeThrough;
    proxy.material.opacity = seeThrough ? 0.28 : 1;
    proxy.material.depthWrite = !seeThrough;
    proxy.material.needsUpdate = true;
  }

  render(frame: SimulationFrame, pressSelected: boolean): void {
    this.simVisual?.update(frame);
    this.panel.update(frame, pressSelected);
  }

  dispose(): void {
    for (const proxy of this.proxies.values()) {
      proxy.material.dispose();
      (proxy.edges.material as THREE.Material).dispose();
    }
    this.simVisual?.dispose();
    this.panel.dispose();
    this.weldGeometry.dispose();
    (this.welds.material as THREE.Material).dispose();
    this.brush.geometry.dispose();
    (this.brush.material as THREE.Material).dispose();
    (this.preview.material as THREE.MeshStandardMaterial).dispose();
    for (const material of this.edgeMaterials) material.dispose();
  }

  private ensureProxy(part: AssemblyPart): Proxy {
    const existing = this.proxies.get(part.id);
    if (existing && existing.mesh.userData.kind === part.kind) return existing;
    if (existing) {
      this.editRoot.remove(existing.mesh);
      existing.material.dispose();
      (existing.edges.material as THREE.Material).dispose();
      this.proxies.delete(part.id);
    }
    const material = new THREE.MeshStandardMaterial({
      color: presetById(part.kind, part.presetId).color,
      roughness: part.kind === 'rigid' ? 0.32 : part.kind === 'shell' ? 0.92 : 0.45,
      metalness: part.kind === 'rigid' ? 0.25 : 0,
      side: part.kind === 'shell' ? THREE.DoubleSide : THREE.FrontSide,
      polygonOffset: part.kind === 'shell',
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geometryFor(part.kind), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.kind = part.kind;
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xf4f7fb });
    this.edgeMaterials.push(edgeMaterial);
    const edges = new THREE.LineSegments(edgesFor(part.kind), edgeMaterial);
    edges.visible = false;
    mesh.add(edges);
    const vertices = new THREE.Points(latticeFor(part.kind), vertexMaterial);
    const lattice = new THREE.LineSegments(latticeFor(part.kind), latticeMaterial);
    vertices.raycast = noRaycast;
    lattice.raycast = noRaycast;
    vertices.renderOrder = 4;
    lattice.renderOrder = 3;
    mesh.add(lattice, vertices);
    this.editRoot.add(mesh);
    const proxy = { mesh, edges, vertices, lattice, material };
    this.applyStructure(proxy);
    this.proxies.set(part.id, proxy);
    return proxy;
  }

  private syncWelds(document: AssemblyDocument): void {
    const count = document.welds.length;
    const array = new Float32Array(Math.max(1, count) * 3);
    for (let i = 0; i < count; i++) {
      const weld = document.welds[i];
      const part = document.parts.find((candidate) => candidate.id === weld.partA);
      if (!part) continue;
      const point = worldAnchor(part, weld.anchorA.triangle, weld.anchorA.barycentric);
      array[i * 3] = point.x;
      array[i * 3 + 1] = point.y;
      array[i * 3 + 2] = point.z;
    }
    this.weldGeometry.setAttribute('position', new THREE.BufferAttribute(array, 3));
    this.welds.visible = count > 0;
  }
}

function applyPart(mesh: THREE.Object3D, part: AssemblyPart): void {
  mesh.position.set(part.position[0], part.position[1], part.position[2]);
  mesh.quaternion.set(part.quaternion[0], part.quaternion[1], part.quaternion[2], part.quaternion[3]);
  mesh.scale.setScalar(part.uniformScale);
  const material = (mesh as THREE.Mesh).material as THREE.MeshStandardMaterial;
  material.color.setHex(presetById(part.kind, part.presetId).color);
  material.side = part.kind === 'shell' ? THREE.DoubleSide : THREE.FrontSide;
}
