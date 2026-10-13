import { workflowAsset, type WorkflowAssetId } from './workflowAssets';
import type { WorkflowPath, WorkflowStage } from './workflowTypes';

export interface WorkflowStageCopy {
  status: string;
  headline: string;
}

const STATUS: Record<WorkflowPath, Record<WorkflowStage, string>> = {
  shell: {
    submit: 'Creator submits a closed mesh and marks end caps',
    build: 'Engine wraps the mesh in a thin shell',
    simulate: 'The shell simulates; the mesh follows',
  },
  plane: {
    submit: 'Creator submits the mesh plus a thin plane',
    build: 'Engine binds the mesh to the plane',
    simulate: 'The plane simulates; the mesh follows',
  },
  thicken: {
    submit: 'Creator submits an open surface with no thickness',
    build: 'Engine adds thickness, an inside tint, and a rim',
    simulate: 'The thickened surface simulates',
  },
};

export function workflowStageCopy(
  assetId: WorkflowAssetId,
  path: WorkflowPath,
  stage: WorkflowStage,
): WorkflowStageCopy {
  const asset = workflowAsset(assetId);
  const headline = path === 'shell' ? asset.shellNote : path === 'plane' ? asset.planeNote : asset.thickenNote;
  return { status: STATUS[path][stage], headline };
}
