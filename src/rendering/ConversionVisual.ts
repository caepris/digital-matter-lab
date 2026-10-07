import * as THREE from 'three';
import type { ConvertedSurface } from '../simulation/conversion/convertSurface';
import type { SourceMesh } from '../simulation/conversion/sourceMeshes';
import type { SimulationFrame } from '../simulation/types';
import type { ConversionStage } from '../ui/ConversionControls';
import { PanelView, type BodyVisual } from './PanelView';
import { createParticleOverlay, type ParticleOverlay } from './StructureOverlay';

const GENERATED_COLOR = 0x60e0c1;

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
  private centerAttribute: THREE.BufferAttribute | null = null;
  private generatedAttribute: THREE.BufferAttribute | null = null;
  private sourceOverlay: ParticleOverlay | null = null;
  private generatedOverlay: ParticleOverlay | null = null;
  private sourceEdges: Uint32Array<ArrayBufferLike> = new Uint32Array();
  private thickPositions = new Float32Array();
  private centerPositions = new Float32Array();

  constructor(source: SourceMesh) {
    this.configure(source, null, source.defaultThickness);
  }

  configure(source: SourceMesh, converted: ConvertedSurface | null, thickness: number): void {
    this.clear();
    this.source = source;
    this.converted = converted;
    this.thickness = thickness;
    this.centerPositions = source.positions.slice();
    this.sourceEdges = uniqueEdges(source.triangles);

    const thick = buildThickIndices(source.positions.length / 3, source.triangles, boundaryEdges(source.triangles));
    this.thickPositions = new Float32Array((source.positions.length / 3) * 2 * 3);
    this.sourceGeometry = new THREE.BufferGeometry();
    this.sourceGeometry.setAttribute('position', new THREE.BufferAttribute(this.thickPositions, 3));
    this.sourceGeometry.setIndex(new THREE.BufferAttribute(thick, 1));
    this.sourceMaterial = new THREE.MeshStandardMaterial({
      color: source.color,
      roughness: source.id === 'car-shell' ? 0.28 : 0.78,
      metalness: source.id === 'car-shell' ? 0.75 : 0.02,
      side: THREE.DoubleSide,
    });
    this.sourceMesh = new THREE.Mesh(this.sourceGeometry, this.sourceMaterial);
    this.sourceMesh.castShadow = true;
    this.sourceMesh.receiveShadow = true;
    this.sourceMesh.frustumCulled = false;
    this.object.add(this.sourceMesh);

    this.centerAttribute = new THREE.BufferAttribute(this.centerPositions, 3);
    this.centerAttribute.setUsage(THREE.DynamicDrawUsage);
    this.sourceOverlay = createParticleOverlay(this.centerAttribute, this.sourceEdges, 0.025);
    this.object.add(this.sourceOverlay.object);

    if (converted) {
      this.generatedAttribute = new THREE.BufferAttribute(converted.positions.slice(), 3);
      this.generatedAttribute.setUsage(THREE.DynamicDrawUsage);
      this.generatedGeometry = new THREE.BufferGeometry();
      this.generatedGeometry.setAttribute('position', this.generatedAttribute);
      this.generatedGeometry.setIndex(new THREE.BufferAttribute(converted.triangles, 1));
      this.generatedGeometry.computeVertexNormals();
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
      this.generatedOverlay = createParticleOverlay(this.generatedAttribute, converted.stretchPairs, 0.035);
      this.object.add(this.generatedOverlay.object);
    }

    this.updateThickSurface();
    this.applyVisibility();
  }

  update(frame: SimulationFrame): void {
    const particles = frame.particles;
    if (particles && this.converted && this.stage === 'run') {
      this.bindSource(particles);
      if (this.generatedAttribute) {
        (this.generatedAttribute.array as Float32Array).set(particles);
        this.generatedAttribute.needsUpdate = true;
      }
      this.updateThickSurface();
      this.generatedOverlay?.update();
    }
  }

  setColor(color: number): void {
    this.sourceMaterial?.color.setHex(color);
  }

  setStage(stage: ConversionStage): void {
    this.stage = stage;
    if (stage !== 'run') {
      this.centerPositions.set(this.source.positions);
      if (this.generatedAttribute && this.converted) {
        (this.generatedAttribute.array as Float32Array).set(this.converted.positions);
        this.generatedAttribute.needsUpdate = true;
        this.generatedGeometry?.computeVertexNormals();
      }
      this.updateThickSurface();
    }
    this.applyVisibility();
  }

  setStructureVisible(visible: boolean): void {
    this.structureVisible = visible;
    this.applyVisibility();
  }

  dispose(): void {
    this.clear();
  }

  private bindSource(particles: Float32Array): void {
    const converted = this.converted;
    if (!converted) return;
    for (let i = 0; i < converted.sourceBindings.length; i++) {
      const binding = converted.sourceBindings[i];
      const corner = binding.triangle * 3;
      const a = converted.triangles[corner];
      const b = converted.triangles[corner + 1];
      const c = converted.triangles[corner + 2];
      const [wa, wb, wc] = binding.barycentric;
      for (let axis = 0; axis < 3; axis++) {
        this.centerPositions[i * 3 + axis] =
          particles[a * 3 + axis] * wa + particles[b * 3 + axis] * wb + particles[c * 3 + axis] * wc;
      }
    }
    if (this.centerAttribute) this.centerAttribute.needsUpdate = true;
  }

  private updateThickSurface(): void {
    const count = this.centerPositions.length / 3;
    const normals = vertexNormals(this.centerPositions, this.source.triangles);
    const half = this.thickness * 0.5;
    for (let i = 0; i < count; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const center = this.centerPositions[i * 3 + axis];
        const offset = normals[i * 3 + axis] * half;
        this.thickPositions[i * 3 + axis] = center + offset;
        this.thickPositions[(i + count) * 3 + axis] = center - offset;
      }
    }
    const attribute = this.sourceGeometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (attribute) attribute.needsUpdate = true;
    this.sourceGeometry?.computeVertexNormals();
    this.sourceOverlay?.update();
  }

  private applyVisibility(): void {
    if (!this.sourceMesh) return;
    const generated = this.stage === 'generate';
    this.sourceMesh.visible = true;
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
    this.centerAttribute = null;
    this.generatedAttribute = null;
  }
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

function boundaryEdges(triangles: Uint32Array): Uint32Array {
  const edges = new Map<string, { a: number; b: number; count: number }>();
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const edge = edges.get(key);
      if (edge) edge.count++;
      else edges.set(key, { a, b, count: 1 });
    }
  }
  return new Uint32Array(Array.from(edges.values()).filter((edge) => edge.count === 1).flatMap((edge) => [edge.a, edge.b]));
}

function buildThickIndices(count: number, triangles: Uint32Array, boundary: Uint32Array): Uint32Array {
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
