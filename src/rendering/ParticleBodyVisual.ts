import * as THREE from 'three';
import { triangulateFaceGrid } from '../simulation/cubeLattice';
import type { BodyTopology, SimulationFrame } from '../simulation/types';
import type { BodyVisual } from './PanelView';
import { createParticleOverlay, type ParticleOverlay } from './StructureOverlay';

type ParticleTopology = Extract<BodyTopology, { kind: 'particles' }>;

export interface ParticleBodyVisualOptions {
  color: number;
  /** Thin shells are seen from both sides and fold across cube edges, so they shade smoothly everywhere. */
  thinShell: boolean;
  pointSize: number;
}

export class ParticleBodyVisual implements BodyVisual {
  readonly object = new THREE.Group();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly surfacePositions: THREE.BufferAttribute;
  private readonly particlePositions: THREE.BufferAttribute;
  /** Maps each surface vertex to its particle; null when the surface indexes particles directly. */
  private readonly vertexToParticle: Uint32Array | null;
  private readonly overlay: ParticleOverlay;

  constructor(topology: ParticleTopology, options: ParticleBodyVisualOptions) {
    const { segments: n, faceGrids, particleCount } = topology;
    this.particlePositions = new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3);
    this.particlePositions.setUsage(THREE.DynamicDrawUsage);

    const indices: number[] = [];
    if (options.thinShell) {
      for (const grid of faceGrids) triangulateFaceGrid(grid, n, indices);
      this.vertexToParticle = null;
      this.surfacePositions = this.particlePositions;
    } else {
      // Per-face vertices keep the cube's edges crisp instead of averaging normals around corners.
      const vertexToParticle: number[] = [];
      for (const grid of faceGrids) {
        const base = vertexToParticle.length;
        const local = new Uint32Array(grid.length);
        for (let k = 0; k < grid.length; k++) {
          local[k] = base + k;
          vertexToParticle.push(grid[k]);
        }
        triangulateFaceGrid(local, n, indices);
      }
      this.vertexToParticle = new Uint32Array(vertexToParticle);
      this.surfacePositions = new THREE.BufferAttribute(new Float32Array(vertexToParticle.length * 3), 3);
      this.surfacePositions.setUsage(THREE.DynamicDrawUsage);
    }

    this.geometry.setAttribute('position', this.surfacePositions);
    this.geometry.setIndex(indices);

    this.material = new THREE.MeshStandardMaterial({
      color: options.color,
      roughness: options.thinShell ? 0.92 : 0.45,
      metalness: 0,
      side: options.thinShell ? THREE.DoubleSide : THREE.FrontSide,
      flatShading: false,
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.object.add(mesh);

    this.overlay = createParticleOverlay(this.particlePositions, topology.structureEdges, options.pointSize);
    this.object.add(this.overlay.object);
  }

  setColor(color: number): void {
    this.material.color.setHex(color);
  }

  update(frame: SimulationFrame): void {
    const particles = frame.particles;
    if (!particles) return;
    (this.particlePositions.array as Float32Array).set(particles);
    this.particlePositions.needsUpdate = true;

    if (this.vertexToParticle) {
      const out = this.surfacePositions.array as Float32Array;
      const map = this.vertexToParticle;
      for (let v = 0; v < map.length; v++) {
        const p = map[v] * 3;
        out[v * 3] = particles[p];
        out[v * 3 + 1] = particles[p + 1];
        out[v * 3 + 2] = particles[p + 2];
      }
      this.surfacePositions.needsUpdate = true;
    }
    this.geometry.computeVertexNormals();
    this.overlay.update();
  }

  setStructureVisible(visible: boolean): void {
    this.overlay.object.visible = visible;
    this.material.transparent = visible;
    this.material.opacity = visible ? 0.3 : 1;
    this.material.depthWrite = !visible;
    this.material.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.overlay.dispose();
  }
}
