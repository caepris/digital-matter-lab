import * as THREE from 'three';
import type { ConvertedSurface } from '../simulation/conversion/convertSurface';
import { particleMaterials, type SourceMesh } from '../simulation/conversion/sourceMeshes';
import type { SimulationFrame } from '../simulation/types';
import type { ConversionView } from '../ui/ConversionControls';
import type { RigidWeldPart } from '../conversion-editor/RigidWeldDocument';
import { matrixForRigidWeld, pointForAnchor } from '../simulation/conversion/autoWeldRigid';
import { rigidAccessory, type RigidAccessoryId } from '../simulation/conversion/rigidAccessories';
import { PanelView, type BodyVisual } from './PanelView';
import { createParticleOverlay, type ParticleOverlay } from './StructureOverlay';

const GENERATED_COLOR = 0x60e0c1;
const CAP_COLOR = 0x2f9c84;
const SUPPORT_COLOR = 0x8a939f;

/** Displays the detailed source, the filled thin shell, and the source-to-shell runtime binding. */
export class ConversionVisual {
  readonly body: ConversionBodyVisual;
  readonly panel: PanelView;

  constructor(source: SourceMesh, accent = 0x5cc4a8) {
    this.body = new ConversionBodyVisual(source);
    this.panel = new PanelView(accent, this.body);
    this.panel.camera.position.set(3.1, 2.3, 3.8);
    this.panel.camera.lookAt(0, 0.65, 0);
  }

  get camera(): THREE.PerspectiveCamera {
    return this.panel.camera;
  }

  setAspect(aspect: number): void {
    this.panel.setAspect(aspect);
  }

  configure(source: SourceMesh, converted: ConvertedSurface | null, thickness: number): void {
    this.body.configure(source, converted, thickness);
  }

  setView(view: ConversionView): void {
    this.body.setView(view);
  }

  setThickness(thickness: number): void {
    this.body.setThickness(thickness);
  }

  setStructureVisible(visible: boolean): void {
    this.body.setStructureVisible(visible);
  }

  setSectionVisible(visible: boolean): void {
    this.body.setSectionVisible(visible);
  }

  syncRigidWelds(parts: readonly RigidWeldPart[], source: SourceMesh, selectedId: string | null, editing: boolean): void {
    this.body.syncRigidWelds(parts, source, selectedId, editing);
  }

  rigidWeldProxy(id: string): THREE.Mesh | undefined {
    return this.body.rigidWeldProxy(id);
  }

  rigidWeldAt(ray: THREE.Ray): string | null {
    return this.body.rigidWeldAt(ray);
  }

  beginSectionDrag(ray: THREE.Ray): boolean {
    return this.body.beginSectionDrag(ray);
  }

  updateSectionDrag(ray: THREE.Ray): void {
    this.body.updateSectionDrag(ray);
  }

  get sectionPosition(): number {
    return this.body.sectionPosition;
  }

  /** Half the distance between the rendered outer and inner shell surfaces at vertex 0. */
  get renderedHalfThickness(): number {
    return this.body.renderedHalfThickness;
  }

  get generatedRegionColorCount(): number {
    return this.body.generatedRegionColorCount;
  }

  render(frame: SimulationFrame, pressSelected: boolean): void {
    this.panel.update(frame, pressSelected);
  }

  dispose(): void {
    this.panel.dispose();
  }
}

class ConversionBodyVisual implements BodyVisual {
  readonly object = new THREE.Group();
  private converted: ConvertedSurface | null = null;
  private thickness = 0.01;
  private view: ConversionView = 'shell';
  private structureVisible = false;
  private sectionVisible = false;
  private sourceMesh: THREE.Mesh | null = null;
  private generatedMesh: THREE.Mesh | null = null;
  private sourceMaterial: THREE.MeshStandardMaterial | null = null;
  private generatedMaterial: THREE.MeshStandardMaterial | null = null;
  private sourceGeometry: THREE.BufferGeometry | null = null;
  private generatedGeometry: THREE.BufferGeometry | null = null;
  private sourceAttribute: THREE.BufferAttribute | null = null;
  private generatedCenterAttribute: THREE.BufferAttribute | null = null;
  private generatedThickAttribute: THREE.BufferAttribute | null = null;
  private sourceOverlay: ParticleOverlay | null = null;
  private generatedOverlay: ParticleOverlay | null = null;
  private readonly supports = new THREE.Group();
  private readonly supportMaterial = new THREE.MeshStandardMaterial({ color: SUPPORT_COLOR, roughness: 0.35, metalness: 0.8 });
  /** Writes front/back face parity into the stencil buffer so the cap only fills the solid cross-section. */
  private readonly sourceCapStencil = new THREE.Group();
  private readonly shellCapStencil = new THREE.Group();
  private capMaterial: THREE.MeshStandardMaterial | null = null;
  private sourceColor = 0xffffff;
  private materialIds: Uint8Array | null = null;
  private generatedMaterialIds: Uint8Array | null = null;
  private regionColors: number[] = [];
  private fabricColors: number[] = [];
  private readonly sectionGizmo = new THREE.Group();
  private readonly rigidWelds = new THREE.Group();
  private readonly weldMarkers = new THREE.Group();
  private readonly rigidWeldMeshes = new Map<string, THREE.Mesh>();
  private rigidWeldParts: readonly RigidWeldPart[] = [];
  private accessoryEditing = true;
  private readonly clippingPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private sectionMinX = -1;
  private sectionMaxX = 1;
  private sectionCenterY = 0.5;
  private sectionCenterZ = 0;
  private sectionHalfY = 0.5;
  private sectionHalfZ = 0.5;
  private sourcePositions = new Float32Array();
  private generatedThickPositions = new Float32Array();
  /** Signed distance of each source vertex from its bound point, along the shell normal. */
  private bindingOffsets: Float32Array<ArrayBufferLike> = new Float32Array();

  constructor(source: SourceMesh) {
    this.configure(source, null, source.defaultThickness);
  }

  get sectionPosition(): number {
    return this.sectionGizmo.position.x;
  }

  get renderedHalfThickness(): number {
    if (!this.converted || this.generatedThickPositions.length === 0) return 0;
    const inner = this.converted.positions.length;
    const p = this.generatedThickPositions;
    return 0.5 * Math.hypot(p[0] - p[inner], p[1] - p[inner + 1], p[2] - p[inner + 2]);
  }

  get generatedRegionColorCount(): number {
    const colors = this.generatedGeometry?.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!colors) return 0;
    const unique = new Set<string>();
    const values = colors.array as Float32Array;
    for (let i = 0; i < values.length; i += 3) {
      unique.add(`${values[i].toFixed(4)}:${values[i + 1].toFixed(4)}:${values[i + 2].toFixed(4)}`);
    }
    return unique.size;
  }

  configure(source: SourceMesh, converted: ConvertedSurface | null, thickness: number): void {
    this.clear();
    this.converted = converted;
    this.thickness = thickness;
    this.sourcePositions = source.positions.slice();
    this.sourceGeometry = new THREE.BufferGeometry();
    this.sourceAttribute = new THREE.BufferAttribute(this.sourcePositions, 3);
    this.sourceAttribute.setUsage(THREE.DynamicDrawUsage);
    this.sourceGeometry.setAttribute('position', this.sourceAttribute);
    this.sourceGeometry.setIndex(new THREE.BufferAttribute(source.triangles, 1));
    this.sourceGeometry.computeVertexNormals();
    const metal = source.id === 'car-shell';
    this.sourceMaterial = new THREE.MeshStandardMaterial({
      color: source.color,
      roughness: metal ? 0.28 : 0.88,
      metalness: metal ? 0.75 : 0,
      side: THREE.DoubleSide,
    });
    this.sourceMesh = new THREE.Mesh(this.sourceGeometry, this.sourceMaterial);
    this.sourceMesh.castShadow = true;
    this.sourceMesh.receiveShadow = true;
    this.sourceMesh.frustumCulled = false;
    this.object.add(this.sourceMesh);
    this.sourceColor = source.color;
    this.materialIds = source.materials.length > 0 ? source.materialIds : null;
    this.generatedMaterialIds =
      converted && source.materials.length > 0
        ? particleMaterials(
            source,
            converted.positions.length / 3,
            converted.triangles,
            converted.sourceBindings,
          )
        : null;
    this.regionColors = source.materials.map((material) => material.color);
    this.fabricColors = source.materials.map((material) => material.fabricColor);
    this.buildCapStencil(this.sourceGeometry, this.sourceCapStencil);
    this.object.add(this.sourceCapStencil);

    this.sourceOverlay = createParticleOverlay(this.sourceAttribute, uniqueEdges(source.triangles), 0.02);
    this.object.add(this.sourceOverlay.object);

    for (const support of source.supports) this.supports.add(supportMesh(support, this.supportMaterial));
    this.object.add(this.supports);
    this.buildSectionGizmo(source.positions);
    this.object.add(this.sectionGizmo);
    this.object.add(this.rigidWelds, this.weldMarkers);

    if (converted) {
      this.generatedCenterAttribute = new THREE.BufferAttribute(converted.positions.slice(), 3);
      this.generatedCenterAttribute.setUsage(THREE.DynamicDrawUsage);
      const generatedIndices = buildLayeredIndices(converted.positions.length / 3, converted.triangles, converted.boundaryPairs);
      this.generatedThickPositions = new Float32Array(converted.positions.length * 2);
      this.generatedThickAttribute = new THREE.BufferAttribute(this.generatedThickPositions, 3);
      this.generatedThickAttribute.setUsage(THREE.DynamicDrawUsage);
      this.generatedGeometry = new THREE.BufferGeometry();
      this.generatedGeometry.setAttribute('position', this.generatedThickAttribute);
      this.generatedGeometry.setIndex(new THREE.BufferAttribute(generatedIndices, 1));
      this.generatedMaterial = new THREE.MeshStandardMaterial({
        color: this.generatedMaterialIds ? 0xffffff : GENERATED_COLOR,
        roughness: 0.62,
        metalness: 0,
        side: THREE.DoubleSide,
        vertexColors: this.generatedMaterialIds !== null,
      });
      this.generatedMesh = new THREE.Mesh(this.generatedGeometry, this.generatedMaterial);
      this.generatedMesh.castShadow = true;
      this.generatedMesh.receiveShadow = true;
      this.generatedMesh.frustumCulled = false;
      this.object.add(this.generatedMesh);
      this.paintGeneratedColors();
      this.buildCapStencil(this.generatedGeometry, this.shellCapStencil);
      this.object.add(this.shellCapStencil);
      this.generatedOverlay = createParticleOverlay(this.generatedCenterAttribute, converted.stretchPairs, 0.035);
      this.object.add(this.generatedOverlay.object);
      this.bindingOffsets = computeBindingOffsets(source.positions, converted);
      this.updateGeneratedSurface(converted.positions);
    }

    this.applyClipping();
    this.applyVisibility();
  }

  update(frame: SimulationFrame): void {
    const particles = frame.particles;
    if (!particles || !this.converted) return;
    const shellParticles = particles.subarray(0, this.converted.positions.length);
    const normals = vertexNormals(shellParticles, this.converted.triangles);
    this.bindSource(shellParticles, normals);
    if (this.generatedCenterAttribute) {
      (this.generatedCenterAttribute.array as Float32Array).set(shellParticles);
      this.generatedCenterAttribute.needsUpdate = true;
    }
    this.updateGeneratedSurface(shellParticles, normals);
    this.generatedOverlay?.update();
    if (!this.accessoryEditing) this.updateRigidWeldParticles(particles);
  }

  syncRigidWelds(parts: readonly RigidWeldPart[], source: SourceMesh, selectedId: string | null, editing: boolean): void {
    this.rigidWeldParts = parts;
    this.accessoryEditing = editing;
    const keep = new Set(parts.map((part) => part.id));
    for (const [id, mesh] of this.rigidWeldMeshes) {
      if (keep.has(id)) continue;
      mesh.removeFromParent();
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.rigidWeldMeshes.delete(id);
    }
    for (const part of parts) {
      let mesh = this.rigidWeldMeshes.get(part.id);
      if (!mesh) {
        const preset = rigidAccessory(part.presetId as RigidAccessoryId);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(preset.positions.slice(), 3));
        geometry.setIndex(new THREE.BufferAttribute(preset.triangles, 1));
        geometry.computeVertexNormals();
        mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: part.valid ? preset.color : 0xe45b64,
            roughness: 0.32,
            metalness: 0.72,
            emissive: part.id === selectedId ? 0x1c5b4e : 0x000000,
            emissiveIntensity: 0.7,
          }),
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.rigidWeldId = part.id;
        this.rigidWelds.add(mesh);
        this.rigidWeldMeshes.set(part.id, mesh);
      }
      mesh.matrix.copy(matrixForRigidWeld(part));
      mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      const material = mesh.material as THREE.MeshStandardMaterial;
      const preset = rigidAccessory(part.presetId as RigidAccessoryId);
      material.color.setHex(part.valid ? preset.color : 0xe45b64);
      material.emissive.setHex(part.id === selectedId ? 0x1c5b4e : 0x000000);
    }
    this.weldMarkers.clear();
    const markerGeometry = new THREE.SphereGeometry(0.012, 8, 6);
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xffcf5a });
    for (const part of parts) {
      for (const weld of part.welds) {
        const marker = new THREE.Mesh(markerGeometry, markerMaterial);
        marker.position.copy(pointForAnchor(weld.sourceAnchor, source.positions, source.triangles));
        this.weldMarkers.add(marker);
      }
    }
    this.weldMarkers.visible = editing;
  }

  rigidWeldProxy(id: string): THREE.Mesh | undefined {
    return this.rigidWeldMeshes.get(id);
  }

  rigidWeldAt(ray: THREE.Ray): string | null {
    const raycaster = new THREE.Raycaster();
    raycaster.ray.copy(ray);
    const hit = raycaster.intersectObjects([...this.rigidWeldMeshes.values()], false)[0];
    return hit?.object.userData.rigidWeldId ?? null;
  }

  private updateRigidWeldParticles(particles: Float32Array): void {
    if (!this.converted) return;
    let offset = this.converted.positions.length / 3;
    for (const part of this.rigidWeldParts) {
      const mesh = this.rigidWeldMeshes.get(part.id);
      const preset = rigidAccessory(part.presetId as RigidAccessoryId);
      if (mesh) {
        const attribute = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
        const values = attribute.array as Float32Array;
        values.set(particles.subarray(offset * 3, offset * 3 + values.length));
        attribute.needsUpdate = true;
        mesh.geometry.computeVertexNormals();
        mesh.position.set(0, 0, 0);
        mesh.quaternion.identity();
        mesh.scale.set(1, 1, 1);
      }
      offset += preset.positions.length / 3;
    }
  }

  setColor(color: number): void {
    this.sourceColor = color;
    this.sourceMaterial?.color.setHex(color);
    this.applyVisibility();
  }

  setView(view: ConversionView): void {
    this.view = view;
    this.applyVisibility();
  }

  setThickness(thickness: number): void {
    this.thickness = thickness;
    if (this.generatedCenterAttribute) this.updateGeneratedSurface(this.generatedCenterAttribute.array as Float32Array);
  }

  setStructureVisible(visible: boolean): void {
    this.structureVisible = visible;
    this.applyVisibility();
  }

  setSectionVisible(visible: boolean): void {
    this.sectionVisible = visible;
    this.applyClipping();
    this.applyVisibility();
  }

  beginSectionDrag(ray: THREE.Ray): boolean {
    if (!this.sectionVisible) return false;
    const hit = ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(1, 0, 0), -this.sectionGizmo.position.x),
      new THREE.Vector3(),
    );
    if (!hit) return false;
    const margin = 0.15;
    return (
      Math.abs(hit.y - this.sectionCenterY) <= this.sectionHalfY + margin &&
      Math.abs(hit.z - this.sectionCenterZ) <= this.sectionHalfZ + margin
    );
  }

  updateSectionDrag(ray: THREE.Ray): void {
    const onSegment = new THREE.Vector3();
    ray.distanceSqToSegment(
      new THREE.Vector3(this.sectionMinX, this.sectionCenterY, this.sectionCenterZ),
      new THREE.Vector3(this.sectionMaxX, this.sectionCenterY, this.sectionCenterZ),
      undefined,
      onSegment,
    );
    this.setSectionPosition(THREE.MathUtils.clamp(onSegment.x, this.sectionMinX, this.sectionMaxX));
  }

  dispose(): void {
    this.clear();
    this.supportMaterial.dispose();
  }

  private bindSource(particles: Float32Array, normals: Float32Array): void {
    const converted = this.converted;
    if (!converted) return;
    const out = this.sourcePositions;
    for (let i = 0; i < converted.sourceBindings.length; i++) {
      const binding = converted.sourceBindings[i];
      const corner = binding.triangle * 3;
      const a = converted.triangles[corner] * 3;
      const b = converted.triangles[corner + 1] * 3;
      const c = converted.triangles[corner + 2] * 3;
      const [wa, wb, wc] = binding.barycentric;
      const nx = normals[a] * wa + normals[b] * wb + normals[c] * wc;
      const ny = normals[a + 1] * wa + normals[b + 1] * wb + normals[c + 1] * wc;
      const nz = normals[a + 2] * wa + normals[b + 2] * wb + normals[c + 2] * wc;
      const scale = this.bindingOffsets[i] / (Math.hypot(nx, ny, nz) || 1);
      out[i * 3] = particles[a] * wa + particles[b] * wb + particles[c] * wc + nx * scale;
      out[i * 3 + 1] = particles[a + 1] * wa + particles[b + 1] * wb + particles[c + 1] * wc + ny * scale;
      out[i * 3 + 2] = particles[a + 2] * wa + particles[b + 2] * wb + particles[c + 2] * wc + nz * scale;
    }
    if (this.sourceAttribute) this.sourceAttribute.needsUpdate = true;
    this.sourceGeometry?.computeVertexNormals();
    this.sourceOverlay?.update();
  }

  private updateGeneratedSurface(centers: Float32Array, normals?: Float32Array): void {
    if (!this.converted || !this.generatedThickAttribute) return;
    const count = centers.length / 3;
    const n = normals ?? vertexNormals(centers, this.converted.triangles);
    const half = this.thickness * 0.5;
    for (let i = 0; i < count * 3; i++) {
      this.generatedThickPositions[i] = centers[i] + n[i] * half;
      this.generatedThickPositions[i + count * 3] = centers[i] - n[i] * half;
    }
    this.generatedThickAttribute.needsUpdate = true;
    this.generatedGeometry?.computeVertexNormals();
  }

  private applyClipping(): void {
    const planes = this.sectionVisible ? [this.clippingPlane] : [];
    for (const material of [this.sourceMaterial, this.generatedMaterial]) {
      if (!material) continue;
      material.clippingPlanes = planes;
      material.needsUpdate = true;
    }
  }

  private applyVisibility(): void {
    if (!this.sourceMesh) return;
    const shellShown = this.converted !== null && this.view === 'shell';
    this.sourceMesh.visible = !shellShown;
    if (this.generatedMesh) this.generatedMesh.visible = shellShown;
    if (this.sourceOverlay) this.sourceOverlay.object.visible = this.structureVisible && !shellShown;
    if (this.generatedOverlay) this.generatedOverlay.object.visible = this.structureVisible && shellShown;
    this.rigidWelds.visible = true;
    this.weldMarkers.visible = this.accessoryEditing && !shellShown;
    this.sectionGizmo.visible = this.sectionVisible;
    this.sourceCapStencil.visible = this.sectionVisible && !shellShown;
    this.shellCapStencil.visible = this.sectionVisible && shellShown;
    const capColor = this.view === 'material' ? 0x5c6570 : shellShown ? CAP_COLOR : this.sourceColor;
    this.capMaterial?.color.setHex(capColor).multiplyScalar(this.view === 'material' || shellShown ? 1 : 0.62);
    this.paintSourceColor();
  }

  /** Multi-material sources show fabric colors, or flat map colors in Material view. */
  private paintSourceColor(): void {
    if (!this.sourceMaterial || !this.sourceGeometry) return;
    if (!this.materialIds) {
      this.sourceMaterial.vertexColors = false;
      this.sourceMaterial.color.setHex(this.sourceColor);
      this.sourceMaterial.needsUpdate = true;
      return;
    }
    const count = this.materialIds.length;
    let colors = this.sourceGeometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!colors || colors.count !== count) {
      colors = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
      this.sourceGeometry.setAttribute('color', colors);
    }
    const array = colors.array as Float32Array;
    const palette = this.view === 'material' ? this.regionColors : this.fabricColors;
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      // Vertex colors are linear; setHex converts the sRGB palette like material colors.
      color.setHex(palette[this.materialIds[i]] ?? this.sourceColor);
      array[i * 3] = color.r;
      array[i * 3 + 1] = color.g;
      array[i * 3 + 2] = color.b;
    }
    colors.needsUpdate = true;
    this.sourceMaterial.vertexColors = true;
    this.sourceMaterial.color.setHex(0xffffff);
    this.sourceMaterial.needsUpdate = true;
  }

  /** Duplicate region colors onto the generated shell's outer and inner layers. */
  private paintGeneratedColors(): void {
    if (!this.generatedGeometry || !this.generatedMaterialIds) return;
    const count = this.generatedMaterialIds.length;
    const colors = new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3);
    const array = colors.array as Float32Array;
    const color = new THREE.Color();
    for (let layer = 0; layer < 2; layer++) {
      for (let i = 0; i < count; i++) {
        color.setHex(this.fabricColors[this.generatedMaterialIds[i]] ?? GENERATED_COLOR);
        const offset = (layer * count + i) * 3;
        array[offset] = color.r;
        array[offset + 1] = color.g;
        array[offset + 2] = color.b;
      }
    }
    this.generatedGeometry.setAttribute('color', colors);
  }

  private buildCapStencil(geometry: THREE.BufferGeometry, group: THREE.Group): void {
    const stencilMaterial = (side: THREE.Side, op: THREE.StencilOp) =>
      new THREE.MeshBasicMaterial({
        side,
        colorWrite: false,
        depthWrite: false,
        depthTest: false,
        clippingPlanes: [this.clippingPlane],
        stencilWrite: true,
        stencilFunc: THREE.AlwaysStencilFunc,
        stencilFail: op,
        stencilZFail: op,
        stencilZPass: op,
      });
    const back = new THREE.Mesh(geometry, stencilMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp));
    const front = new THREE.Mesh(geometry, stencilMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp));
    for (const mesh of [back, front]) {
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      group.add(mesh);
    }
  }

  private buildSectionGizmo(positions: Float32Array): void {
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (let i = 0; i < positions.length; i += 3) {
      box.expandByPoint(point.set(positions[i], positions[i + 1], positions[i + 2]));
    }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.sectionMinX = box.min.x - 0.05;
    this.sectionMaxX = box.max.x + 0.05;
    this.sectionCenterY = center.y;
    this.sectionCenterZ = center.z;
    this.sectionHalfY = size.y * 0.58 + 0.08;
    this.sectionHalfZ = size.z * 0.58 + 0.08;

    const geometry = new THREE.PlaneGeometry(this.sectionHalfZ * 2, this.sectionHalfY * 2);
    geometry.rotateY(Math.PI / 2);
    this.capMaterial = new THREE.MeshStandardMaterial({
      color: CAP_COLOR,
      roughness: 0.8,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    const cap = new THREE.Mesh(geometry, this.capMaterial);
    cap.renderOrder = 2;
    this.sectionGizmo.add(cap);
    const sheet = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: GENERATED_COLOR,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    sheet.renderOrder = 3;
    this.sectionGizmo.add(sheet);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0xc5fff2, transparent: true, opacity: 0.95 }),
    );
    this.sectionGizmo.add(edges);
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 10), new THREE.MeshBasicMaterial({ color: 0xf4f6fa }));
    handle.position.set(0, this.sectionHalfY, 0);
    this.sectionGizmo.add(handle);
    this.setSectionPosition(center.x + size.x * 0.18);
  }

  private setSectionPosition(x: number): void {
    this.sectionGizmo.position.set(x, this.sectionCenterY, this.sectionCenterZ);
    this.clippingPlane.constant = x;
  }

  private clear(): void {
    this.object.clear();
    const stencils = [this.sourceCapStencil, this.shellCapStencil];
    for (const group of [this.supports, this.sectionGizmo, ...stencils]) {
      for (const child of group.children) {
        const mesh = child as THREE.Mesh;
        if (!stencils.includes(group)) mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else if (material !== this.supportMaterial) material?.dispose();
      }
      group.clear();
    }
    this.sourceGeometry?.dispose();
    this.generatedGeometry?.dispose();
    this.sourceMaterial?.dispose();
    this.generatedMaterial?.dispose();
    this.sourceOverlay?.dispose();
    this.generatedOverlay?.dispose();
    this.sourceMesh = null;
    this.generatedMesh = null;
    this.sourceGeometry = null;
    this.generatedGeometry = null;
    this.sourceMaterial = null;
    this.materialIds = null;
    this.regionColors = [];
    this.generatedMaterial = null;
    this.sourceOverlay = null;
    this.generatedOverlay = null;
    this.sourceAttribute = null;
    this.generatedCenterAttribute = null;
    this.generatedThickAttribute = null;
    this.generatedThickPositions = new Float32Array();
    this.bindingOffsets = new Float32Array();
    for (const mesh of this.rigidWeldMeshes.values()) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.rigidWeldMeshes.clear();
    this.rigidWelds.clear();
    for (const child of this.weldMarkers.children) {
      const marker = child as THREE.Mesh;
      marker.geometry.dispose();
      (marker.material as THREE.Material).dispose();
    }
    this.weldMarkers.clear();
    this.rigidWeldParts = [];
  }
}

function supportMesh(support: SourceMesh['supports'][number], material: THREE.Material): THREE.Mesh {
  const from = new THREE.Vector3().fromArray(support.from);
  const to = new THREE.Vector3().fromArray(support.to);
  const direction = to.clone().sub(from);
  const geometry = new THREE.CylinderGeometry(support.radius, support.radius, direction.length() + support.radius * 2, 12);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.castShadow = true;
  return mesh;
}

function computeBindingOffsets(source: Float32Array, converted: ConvertedSurface): Float32Array {
  const normals = vertexNormals(converted.positions, converted.triangles);
  const positions = converted.positions;
  const offsets = new Float32Array(converted.sourceBindings.length);
  for (let i = 0; i < offsets.length; i++) {
    const binding = converted.sourceBindings[i];
    const corner = binding.triangle * 3;
    const a = converted.triangles[corner] * 3;
    const b = converted.triangles[corner + 1] * 3;
    const c = converted.triangles[corner + 2] * 3;
    const [wa, wb, wc] = binding.barycentric;
    let dot = 0;
    let length2 = 0;
    for (let axis = 0; axis < 3; axis++) {
      const bound = positions[a + axis] * wa + positions[b + axis] * wb + positions[c + axis] * wc;
      const normal = normals[a + axis] * wa + normals[b + axis] * wb + normals[c + axis] * wc;
      dot += (source[i * 3 + axis] - bound) * normal;
      length2 += normal * normal;
    }
    offsets[i] = dot / (Math.sqrt(length2) || 1);
  }
  return offsets;
}

function uniqueEdges(triangles: Uint32Array): Uint32Array {
  const edges = new Map<string, [number, number]>();
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      edges.set(`${lo}:${hi}`, [lo, hi]);
    }
  }
  return new Uint32Array(Array.from(edges.values()).flat());
}

/**
 * Outer layer wound outward and inner layer wound inward, joined along any open edges,
 * so the pair bounds a solid of the shell's thickness.
 */
function buildLayeredIndices(count: number, triangles: Uint32Array, boundary: Uint32Array): Uint32Array {
  const indices: number[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t];
    const b = triangles[t + 1];
    const c = triangles[t + 2];
    indices.push(a, b, c, a + count, c + count, b + count);
  }
  for (let e = 0; e < boundary.length; e += 2) {
    const a = boundary[e];
    const b = boundary[e + 1];
    indices.push(a, a + count, b + count, a, b + count, b);
  }
  return new Uint32Array(indices);
}

function vertexNormals(positions: Float32Array, triangles: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * 3;
    const b = triangles[t + 1] * 3;
    const c = triangles[t + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const o of [a, b, c]) {
      normals[o] += nx;
      normals[o + 1] += ny;
      normals[o + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= length;
    normals[i + 1] /= length;
    normals[i + 2] /= length;
  }
  return normals;
}
