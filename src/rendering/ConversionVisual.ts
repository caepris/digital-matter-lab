import * as THREE from 'three';
import type { ConvertedSurface } from '../simulation/conversion/convertSurface';
import type { SourceMesh } from '../simulation/conversion/sourceMeshes';
import type { SimulationFrame } from '../simulation/types';
import type { ConversionStage } from '../ui/ConversionControls';
import { PanelView, type BodyVisual } from './PanelView';
import { createParticleOverlay, type ParticleOverlay } from './StructureOverlay';

const GENERATED_COLOR = 0x60e0c1;
const SUPPORT_COLOR = 0x8a939f;

/** Displays the detailed source, generated shell, and source-to-shell runtime binding. */
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

  setStage(stage: ConversionStage): void {
    this.body.setStage(stage);
  }

  setStructureVisible(visible: boolean): void {
    this.body.setStructureVisible(visible);
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
  private source!: SourceMesh;
  private converted: ConvertedSurface | null = null;
  private thickness = 0.01;
  private stage: ConversionStage = 'source';
  private structureVisible = false;
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
  private sourcePositions = new Float32Array();
  private generatedThickPositions = new Float32Array();
  /** Signed distance of each source vertex from its bound point, along the shell normal. */
  private bindingOffsets: Float32Array<ArrayBufferLike> = new Float32Array();

  constructor(source: SourceMesh) {
    this.configure(source, null, source.defaultThickness);
  }

  configure(source: SourceMesh, converted: ConvertedSurface | null, thickness: number): void {
    this.clear();
    this.source = source;
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

    this.sourceOverlay = createParticleOverlay(this.sourceAttribute, uniqueEdges(source.triangles), 0.02);
    this.object.add(this.sourceOverlay.object);

    for (const support of source.supports) this.supports.add(supportMesh(support, this.supportMaterial));
    this.object.add(this.supports);

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
        color: GENERATED_COLOR,
        roughness: 0.65,
        metalness: 0,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.58,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      this.generatedMesh = new THREE.Mesh(this.generatedGeometry, this.generatedMaterial);
      this.generatedMesh.frustumCulled = false;
      this.object.add(this.generatedMesh);
      this.generatedOverlay = createParticleOverlay(this.generatedCenterAttribute, converted.stretchPairs, 0.035);
      this.object.add(this.generatedOverlay.object);
      this.bindingOffsets = computeBindingOffsets(source.positions, converted);
      this.updateGeneratedSurface(converted.positions);
    }

    this.applyVisibility();
  }

  update(frame: SimulationFrame): void {
    const particles = frame.particles;
    if (particles && this.converted && this.stage === 'run') {
      const normals = vertexNormals(particles, this.converted.triangles);
      this.bindSource(particles, normals);
      if (this.generatedCenterAttribute) {
        (this.generatedCenterAttribute.array as Float32Array).set(particles);
        this.generatedCenterAttribute.needsUpdate = true;
      }
      this.updateGeneratedSurface(particles, normals);
      this.generatedOverlay?.update();
    }
  }

  setColor(color: number): void {
    this.sourceMaterial?.color.setHex(color);
  }

  setStage(stage: ConversionStage): void {
    this.stage = stage;
    if (stage !== 'run') {
      this.sourcePositions.set(this.source.positions);
      this.commitSource();
      if (this.generatedCenterAttribute && this.converted) {
        (this.generatedCenterAttribute.array as Float32Array).set(this.converted.positions);
        this.generatedCenterAttribute.needsUpdate = true;
        this.updateGeneratedSurface(this.converted.positions);
      }
    }
    this.applyVisibility();
  }

  setStructureVisible(visible: boolean): void {
    this.structureVisible = visible;
    this.applyVisibility();
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
    this.commitSource();
  }

  private commitSource(): void {
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

  private applyVisibility(): void {
    if (!this.sourceMesh) return;
    const generated = this.stage === 'generate';
    if (this.sourceMaterial) {
      this.sourceMaterial.transparent = generated;
      this.sourceMaterial.opacity = generated ? 0.16 : 1;
      this.sourceMaterial.depthWrite = !generated;
      this.sourceMaterial.needsUpdate = true;
    }
    if (this.generatedMesh) this.generatedMesh.visible = generated;
    if (this.sourceOverlay) this.sourceOverlay.object.visible = this.structureVisible && this.stage === 'source';
    if (this.generatedOverlay) {
      this.generatedOverlay.object.visible = this.structureVisible && this.stage !== 'source';
    }
  }

  private clear(): void {
    this.object.clear();
    for (const child of this.supports.children) (child as THREE.Mesh).geometry.dispose();
    this.supports.clear();
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
    this.generatedMaterial = null;
    this.sourceOverlay = null;
    this.generatedOverlay = null;
    this.sourceAttribute = null;
    this.generatedCenterAttribute = null;
    this.generatedThickAttribute = null;
    this.bindingOffsets = new Float32Array();
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

/** Outer and inner layers of a shell offset along its normals, joined along any open edges. */
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
