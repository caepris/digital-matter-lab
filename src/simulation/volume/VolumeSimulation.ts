import { DEFAULT_PRESET_IDS, VOLUME_PRESETS, type VolumePreset } from '../../materials/presets';
import { CUBE_SIZE } from '../scene';
import {
  applyDistancePlasticity,
  applyVolumePlasticity,
  DistanceConstraints,
  solveDistances,
  solveTetVolumes,
  TetVolumeConstraints,
} from '../xpbd/constraints';
import { XpbdSimulation } from '../xpbd/XpbdSimulation';
import { buildVolumeMesh } from './VolumeMesh';

const SEGMENTS = 6;
const TOTAL_MASS = 1;

export class VolumeSimulation extends XpbdSimulation<VolumePreset> {
  readonly kind = 'volume' as const;
  readonly edges: DistanceConstraints;
  readonly volumes: TetVolumeConstraints;

  constructor(presetId = DEFAULT_PRESET_IDS.volume, segments = SEGMENTS) {
    const mesh = buildVolumeMesh(segments);
    const spacing = CUBE_SIZE / segments;
    super({
      presets: VOLUME_PRESETS,
      presetId,
      restPositions: mesh.positions,
      totalMass: TOTAL_MASS,
      topology: {
        kind: 'particles',
        particleCount: mesh.positions.length / 3,
        segments: mesh.segments,
        faceGrids: mesh.faceGrids,
        structureEdges: mesh.edges,
      },
      particleRadius: 0.02,
      pressFloor: CUBE_SIZE * 0.45,
      pickRadius: spacing * 0.7,
      grabRadius: spacing * 1.5,
    });
    this.edges = new DistanceConstraints(mesh.edges, mesh.positions);
    this.volumes = new TetVolumeConstraints(mesh.tets, mesh.positions);
  }

  protected solveConstraints(h: number): void {
    solveDistances(this.positions, this.invMass, this.edges, this.preset.edgeCompliance, h);
    solveTetVolumes(this.positions, this.invMass, this.volumes, this.preset.volumeCompliance, h);
  }

  protected afterStep(): void {
    const plastic = this.preset.plastic;
    if (!plastic) return;
    applyDistancePlasticity(this.positions, this.edges, plastic);
    applyVolumePlasticity(this.positions, this.volumes, plastic);
  }

  protected resetRestState(): void {
    this.edges.resetRest();
    this.volumes.resetRest();
  }
}
