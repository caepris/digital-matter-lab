import type { Ray } from 'three';

export type MatterKind = 'rigid' | 'volume' | 'shell' | 'assembly';

export type ToolId = 'grab' | 'drop' | 'press';

export interface ImpactorFrame {
  x: number;
  y: number;
  z: number;
  radius: number;
}

/** Interpolated, render-ready snapshot of a simulation. */
export interface SimulationFrame {
  /** Particle positions (xyz triples) for deformable bodies. */
  particles: Float32Array | null;
  cubePosition: [number, number, number] | null;
  cubeQuaternion: [number, number, number, number] | null;
  impactors: ImpactorFrame[];
  /** World-space height of the press plate's underside. */
  pressBottom: number;
}

export type BodyTopology =
  | { kind: 'rigid'; halfExtents: [number, number, number] }
  | {
      kind: 'particles';
      particleCount: number;
      /** Grid resolution (segments per cube edge) used by `faceGrids`. */
      segments: number;
      /** Six (segments + 1)^2 grids of particle indices with outward u-by-v winding. */
      faceGrids: Uint32Array[];
      /** Pairs of particle indices visualized by the structure overlay. */
      structureEdges: Uint32Array;
    }
  | {
      kind: 'composite';
      particleCount: number;
      parts: CompositePartTopology[];
      welds: WeldTopology[];
    };

export interface CompositePartTopology {
  id: string;
  label: string;
  materialKind: Exclude<MatterKind, 'assembly'>;
  color: number;
  /** Global particle indices, grouped as outward-wound triangles. */
  triangles: Uint32Array;
  /** Global particle-index pairs used by the structure overlay. */
  structureEdges: Uint32Array;
  doubleSided?: boolean;
}

export interface WeldTopology {
  id: string;
  label: string;
  /** Shared particle indices at the permanent interface. */
  particleIndices: Uint32Array;
  color: number;
}

export interface SimulationStats {
  impactorCount: number;
  pressBottom: number;
  pressActive: boolean;
  grabbing: boolean;
  /** Largest distance of any material point from its rest shape, after removing translation. */
  maxDeformation: number;
  center: [number, number, number];
}

export interface MatterSimulation {
  readonly kind: MatterKind;
  readonly presetId: string;
  readonly topology: BodyTopology;
  setPreset(id: string): void;
  reset(): void;
  step(dt: number): void;
  beginGrab(ray: Ray): boolean;
  updateGrab(ray: Ray): void;
  endGrab(): void;
  dropImpactor(x: number, z: number): void;
  setPressActive(active: boolean): void;
  frame(alpha: number): SimulationFrame;
  stats(): SimulationStats;
  dispose(): void;
}

export interface PanelState {
  tool: ToolId;
  presetId: string;
  structureVisible: boolean;
}
