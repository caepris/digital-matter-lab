import { DEFAULT_PRESET_IDS, SHELL_PRESETS, type ShellPreset } from '../../materials/presets';
import { applyDistancePlasticity, DistanceConstraints, solveDistances } from '../xpbd/constraints';
import { SpatialHash } from '../xpbd/SpatialHash';
import { XpbdSimulation } from '../xpbd/XpbdSimulation';

const REFERENCE_THICKNESS = 0.03;
const MIN_THICKNESS = 0.002;

export interface SimulatableSurface {
  positions: Float32Array;
  triangles: Uint32Array;
  stretchPairs: Uint32Array;
  bendPairs: Uint32Array;
}

export interface ConvertedShellSimulationOptions {
  mesh: SimulatableSurface;
  thickness: number;
  presetId?: string;
  totalMass?: number;
}

/** XPBD thin-shell simulation for an arbitrary indexed surface. */
export class ConvertedShellSimulation extends XpbdSimulation<ShellPreset> {
  readonly kind = 'shell' as const;
  readonly stretch: DistanceConstraints;
  readonly bend: DistanceConstraints;
  readonly thickness: number;
  private readonly hash: SpatialHash;
  private readonly neighbors = new Set<number>();

  constructor(options: ConvertedShellSimulationOptions) {
    const { mesh } = options;
    const thickness = Math.max(MIN_THICKNESS, options.thickness);
    super({
      presets: SHELL_PRESETS,
      presetId: options.presetId ?? DEFAULT_PRESET_IDS.shell,
      restPositions: mesh.positions,
      totalMass: options.totalMass ?? 0.5,
      topology: {
        kind: 'particles',
        particleCount: mesh.positions.length / 3,
        segments: 0,
        faceGrids: [],
        structureEdges: mesh.stretchPairs,
      },
      surfaceTriangles: mesh.triangles,
      particleRadius: Math.max(0.008, thickness * 0.5),
      pressFloor: thickness,
      pickRadius: 0.16,
      grabRadius: 0.28,
      startJitter: 0.001,
    });
    this.thickness = thickness;
    this.stretch = new DistanceConstraints(mesh.stretchPairs, mesh.positions);
    this.bend = new DistanceConstraints(mesh.bendPairs, mesh.positions);
    this.hash = new SpatialHash(thickness, this.count);
    for (let i = 0; i < mesh.stretchPairs.length; i += 2) {
      const a = mesh.stretchPairs[i];
      const b = mesh.stretchPairs[i + 1];
      this.neighbors.add(pairKey(a, b));
    }
  }

  protected solveConstraints(h: number): void {
    solveDistances(
      this.positions,
      this.invMass,
      this.stretch,
      this.preset.stretchCompliance,
      h,
      this.preset.compressionCompliance,
    );
    solveDistances(
      this.positions,
      this.invMass,
      this.bend,
      bendingComplianceForThickness(this.preset.bendCompliance, this.thickness),
      h,
    );
  }

  protected solveExtraCollisions(): void {
    const { positions, hash, count, thickness } = this;
    hash.create(positions, count);
    const thickness2 = thickness * thickness;
    for (let i = 0; i < count; i++) {
      hash.query(positions, i, thickness);
      for (let q = 0; q < hash.querySize; q++) {
        const j = hash.queryIds[q];
        if (j <= i) continue;
        if (this.neighbors.has(pairKey(i, j))) continue;
        const dx = positions[j * 3] - positions[i * 3];
        const dy = positions[j * 3 + 1] - positions[i * 3 + 1];
        const dz = positions[j * 3 + 2] - positions[i * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= thickness2 || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        const correction = (0.5 * (thickness - d)) / d;
        positions[i * 3] -= dx * correction;
        positions[i * 3 + 1] -= dy * correction;
        positions[i * 3 + 2] -= dz * correction;
        positions[j * 3] += dx * correction;
        positions[j * 3 + 1] += dy * correction;
        positions[j * 3 + 2] += dz * correction;
      }
    }
  }

  protected afterStep(): void {
    const plastic = this.preset.plastic;
    if (plastic) applyDistancePlasticity(this.positions, this.bend, plastic);
  }

  protected resetRestState(): void {
    this.stretch.resetRest();
    this.bend.resetRest();
  }
}

function pairKey(a: number, b: number): number {
  return Math.min(a, b) * 1_000_000 + Math.max(a, b);
}

/** Thin-plate bending stiffness grows with thickness cubed, so compliance falls by the same factor. */
export function bendingComplianceForThickness(baseCompliance: number, thickness: number): number {
  return baseCompliance * (REFERENCE_THICKNESS / Math.max(MIN_THICKNESS, thickness)) ** 3;
}
