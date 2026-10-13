import type { WorkflowAssetId } from './workflowAssets';

/** Path 1 engine shell, Path 2 creator plane, Path 3 engine thickening. */
export const WORKFLOW_PATHS = ['shell', 'plane', 'thicken'] as const;
export type WorkflowPath = (typeof WORKFLOW_PATHS)[number];

export const WORKFLOW_STAGES = ['submit', 'build', 'simulate'] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export interface CreatorWorkflowState {
  assetId: WorkflowAssetId;
  stage: WorkflowStage;
  thicknessCm: number;
  /** Cap region ids the creator marked as end caps in Path 1. Empty means the full mesh simulates. */
  endCaps: number[];
  showMapping: boolean;
  /** When false, the simulation mesh is drawn as a solid surface in place of the render mesh. */
  showRender: boolean;
  simulationPaused: boolean;
  wind: number;
}

export const DEFAULT_WORKFLOW_STATE: CreatorWorkflowState = {
  assetId: 'tshirt',
  stage: 'submit',
  thicknessCm: 0.6,
  endCaps: [],
  showMapping: true,
  showRender: true,
  simulationPaused: true,
  wind: 2.5,
};

/** Rendered thickness in scene units; exaggerated so centimetre-scale rims stay legible. */
export function displayThickness(thicknessCm: number): number {
  return 0.012 + thicknessCm * 0.03;
}
