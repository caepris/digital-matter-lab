import { DEFAULT_PRESET_IDS, SHELL_PRESETS, type ShellPreset } from '../../materials/presets';
import { CUBE_SIZE } from '../scene';
import { applyDistancePlasticity, DistanceConstraints, solveDistances } from '../xpbd/constraints';
import { SpatialHash } from '../xpbd/SpatialHash';
import { XpbdSimulation } from '../xpbd/XpbdSimulation';
import { buildShellMesh } from './ShellMesh';

const SEGMENTS = 8;
const TOTAL_MASS = 0.4;
/** Minimum separation between any two cloth particles, i.e. the simulated sheet thickness. */
const THICKNESS = 0.07;
const PARTICLE_RADIUS = 0.01;

export class ShellSimulation extends XpbdSimulation<ShellPreset> {
  readonly kind = 'shell' as const;
  readonly stretch: DistanceConstraints;
  readonly bend: DistanceConstraints;
  private readonly hash: SpatialHash;

  constructor(presetId = DEFAULT_PRESET_IDS.shell, segments = SEGMENTS) {
    const mesh = buildShellMesh(segments, CUBE_SIZE, PARTICLE_RADIUS);
    const spacing = CUBE_SIZE / segments;
    super({
      presets: SHELL_PRESETS,
      presetId,
      restPositions: mesh.positions,
      totalMass: TOTAL_MASS,
      topology: {
        kind: 'particles',
        particleCount: mesh.positions.length / 3,
        segments: mesh.segments,
        faceGrids: mesh.faceGrids,
        structureEdges: mesh.stretchPairs,
      },
      particleRadius: PARTICLE_RADIUS,
      pressFloor: THICKNESS * 2 + PARTICLE_RADIUS,
      pickRadius: spacing * 0.75,
      grabRadius: spacing * 1.2,
      startJitter: 0.004,
    });
    this.stretch = new DistanceConstraints(mesh.stretchPairs, mesh.positions);
    this.bend = new DistanceConstraints(mesh.bendPairs, mesh.positions);
    this.hash = new SpatialHash(THICKNESS, this.count);
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
    solveDistances(this.positions, this.invMass, this.bend, this.preset.bendCompliance, h);
  }

  protected solveExtraCollisions(): void {
    const { positions, hash, count } = this;
    hash.create(positions, count);
    const thickness2 = THICKNESS * THICKNESS;
    for (let i = 0; i < count; i++) {
      hash.query(positions, i, THICKNESS);
      for (let q = 0; q < hash.querySize; q++) {
        const j = hash.queryIds[q];
        if (j <= i) continue;
        const dx = positions[j * 3] - positions[i * 3];
        const dy = positions[j * 3 + 1] - positions[i * 3 + 1];
        const dz = positions[j * 3 + 2] - positions[i * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= thickness2 || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        const push = (0.5 * (THICKNESS - d)) / d;
        positions[i * 3] -= dx * push;
        positions[i * 3 + 1] -= dy * push;
        positions[i * 3 + 2] -= dz * push;
        positions[j * 3] += dx * push;
        positions[j * 3 + 1] += dy * push;
        positions[j * 3 + 2] += dz * push;
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
