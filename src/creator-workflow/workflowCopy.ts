import { workflowAsset, type WorkflowAssetId } from './workflowAssets';
import type { WorkflowPath, WorkflowStage } from './workflowTypes';

export interface WorkflowStageCopy {
  status: string;
  headline: string;
  checklist: readonly string[];
}

const COPY: Record<WorkflowPath, Record<WorkflowStage, Omit<WorkflowStageCopy, 'headline'>>> = {
  shell: {
    submit: {
      status: 'Creator submits an arbitrary mesh and marks end caps',
      checklist: ['Upload the finished, closed mesh', 'Click capped openings to mark them', 'No caps marked: the full mesh simulates'],
    },
    build: {
      status: 'Engine generates a thin shell around the mesh',
      checklist: ['Shell surrounds every non-cap face', 'End caps render but do not simulate', 'Thickness sets the shell depth'],
    },
    simulate: {
      status: 'The shell simulates and drives the mesh',
      checklist: ['Render mesh follows the shell', 'Caps ride along without simulating', 'Drag, wind, and reset to test'],
    },
  },
  plane: {
    submit: {
      status: 'Creator submits an arbitrary mesh plus a simulation plane',
      checklist: ['Upload the finished mesh', 'Upload one thin plane as the simulation mesh', 'The plane intersects the mesh'],
    },
    build: {
      status: 'Engine binds the mesh to the creator plane',
      checklist: ['Each render vertex binds to the plane', 'Offsets keep depth off the plane', 'No geometry is generated'],
    },
    simulate: {
      status: 'The plane simulates and drives the mesh',
      checklist: ['Only the plane runs physics', 'The full 3D mesh follows its bending', 'Drag, wind, and reset to test'],
    },
  },
  thicken: {
    submit: {
      status: 'Creator submits a zero-thickness open surface',
      checklist: ['A single surface with no thickness', 'Openings stay open exactly as authored', 'UVs are authored on the surface'],
    },
    build: {
      status: 'Engine adds thickness and textures it from the UVs',
      checklist: ['Thickness grows outward from the surface', 'Inside reuses the UVs with an inside tint', 'Rim samples boundary UVs across its depth'],
    },
    simulate: {
      status: 'The thickened surface simulates',
      checklist: ['The surface itself is the simulation mesh', 'Thickness and rim follow every frame', 'Drag, wind, and reset to test'],
    },
  },
};

export function workflowStageCopy(
  assetId: WorkflowAssetId,
  path: WorkflowPath,
  stage: WorkflowStage,
): WorkflowStageCopy {
  const asset = workflowAsset(assetId);
  const headline = path === 'shell' ? asset.shellNote : path === 'plane' ? asset.planeNote : asset.thickenNote;
  return { ...COPY[path][stage], headline };
}
