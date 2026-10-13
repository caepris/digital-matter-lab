import { describe, expect, it } from 'vitest';
import { ConvertedShellSimulation } from '../simulation/conversion/ConvertedShellSimulation';
import { minimumClearance, startInsideMasks } from '../simulation/xpbd/capsuleColliders';
import { WORKFLOW_ASSET_IDS, type WorkflowAssetId } from './workflowAssets';
import { buildWorkflowPathData, proceduralWorkflowSources } from './workflowPipeline';
import { workflowAttachments, workflowColliders, workflowPhysics, workflowWind } from './workflowPhysics';
import { vertexComponents } from './surfaceTopology';
import { DEFAULT_WORKFLOW_STATE, WORKFLOW_PATHS, displayThickness, type WorkflowPath } from './workflowTypes';

function enclosedVolume(positions: ArrayLike<number>, triangles: ArrayLike<number>): number {
  let volume = 0;
  for (let index = 0; index < triangles.length; index += 3) {
    const [a, b, c] = [triangles[index] * 3, triangles[index + 1] * 3, triangles[index + 2] * 3];
    volume +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return Math.abs(volume / 6);
}

function simulation(assetId: WorkflowAssetId, path: WorkflowPath, endCaps: number[] = []) {
  const state = { ...DEFAULT_WORKFLOW_STATE, assetId, endCaps };
  const data = buildWorkflowPathData(state, path, proceduralWorkflowSources(assetId, 0.5));
  const physics = workflowPhysics(assetId);
  const { pinned, seams } = workflowAttachments(assetId, path, data.proxy);
  const sim = new ConvertedShellSimulation({
    mesh: { ...data.proxy, stretchPairs: new Uint32Array([...data.proxy.stretchPairs, ...seams]) },
    thickness: state.thicknessCm / 100,
    preset: physics.preset,
    bending: physics.bending,
    fixedBending: true,
    structural: physics.structural,
    totalMass: physics.totalMass,
    pinned,
    colliders: workflowColliders(assetId, path),
    minContactDistance: path === 'plane' ? 0 : displayThickness(state.thicknessCm),
  });
  sim.setWind(workflowWind(assetId, path, state.wind, endCaps));
  return { sim, data };
}

describe('workflow physics', () => {
  it('sizes the collision bodies so no open Path 3 surface starts inside them', () => {
    for (const assetId of WORKFLOW_ASSET_IDS) {
      const { open } = proceduralWorkflowSources(assetId, 0.5);
      const colliders = workflowColliders(assetId, 'thicken');
      if (colliders.length === 0) continue;
      expect(minimumClearance(open.positions, colliders), assetId).toBeGreaterThan(0.012);
    }
  });

  it('keeps Path 2 planes free of colliders and inflation', () => {
    for (const assetId of WORKFLOW_ASSET_IDS) {
      expect(workflowColliders(assetId, 'plane')).toHaveLength(0);
      expect(workflowWind(assetId, 'plane', 3).inflation).toBe(0);
    }
  });

  it('holds every piece of every example by a pin or a seam', () => {
    for (const assetId of WORKFLOW_ASSET_IDS) {
      for (const path of WORKFLOW_PATHS) {
        const data = buildWorkflowPathData({ ...DEFAULT_WORKFLOW_STATE, assetId }, path, proceduralWorkflowSources(assetId, 0.5));
        const { positions, triangles } = data.proxy;
        const { pinned, seams } = workflowAttachments(assetId, path, data.proxy);
        const count = positions.length / 3;
        expect(pinned.length, `${assetId} ${path}`).toBeGreaterThan(0);
        expect(pinned.length).toBeLessThan(count * 0.25);
        const linked = new Uint32Array([...triangles, ...[...seams].flatMap((v, i, all) => (i % 2 ? [] : [v, all[i + 1], v]))]);
        const components = vertexComponents(count, linked);
        const held = new Set(pinned.map((index) => components[index]));
        for (let index = 0; index < count; index += 1) {
          expect(held.has(components[index]), `${assetId} ${path} vertex ${index} hangs free`).toBe(true);
        }
      }
    }
  }, 20_000);

  it('settles every example into a stable drape outside its collision body', () => {
    for (const assetId of WORKFLOW_ASSET_IDS) {
      for (const path of ['shell', 'thicken'] as const) {
        const { sim, data } = simulation(assetId, path);
        for (let step = 0; step < 90; step += 1) sim.step(1 / 60);
        const positions = sim.positions;
        expect([...positions].every(Number.isFinite), `${assetId} ${path} finite`).toBe(true);
        let maxSpeed = 0;
        for (let index = 0; index < sim.velocities.length; index += 3) {
          maxSpeed = Math.max(maxSpeed, Math.hypot(sim.velocities[index], sim.velocities[index + 1], sim.velocities[index + 2]));
        }
        expect(maxSpeed, `${assetId} ${path} speed`).toBeLessThan(6);
        let minY = Infinity;
        for (let index = 1; index < positions.length; index += 3) minY = Math.min(minY, positions[index]);
        expect(minY, `${assetId} ${path} fell`).toBeGreaterThan(-0.05);

        const colliders = workflowColliders(assetId, path);
        const exempt = startInsideMasks(data.proxy.positions, colliders, 0.012);
        colliders.forEach((collider, c) => {
          const visible: number[] = [];
          for (let index = 0; index < sim.count; index += 1) {
            if (!exempt[c][index]) visible.push(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
          }
          expect(minimumClearance(visible, [collider]), `${assetId} ${path} collider ${c}`).toBeGreaterThan(-0.02);
        });
      }
    }
  }, 60_000);

  it('makes the windsock stream downwind and inflate when its ends are open', () => {
    const { sim, data } = simulation('fish-flag', 'thicken');
    sim.setWind(workflowWind('fish-flag', 'thicken', workflowPhysics('fish-flag').defaultWind));
    const restTail = Math.max(...Array.from({ length: sim.count }, (_, i) => data.proxy.positions[i * 3]));
    for (let step = 0; step < 120; step += 1) sim.step(1 / 60);
    let tailX = -Infinity;
    let minY = Infinity;
    for (let index = 0; index < sim.count; index += 1) {
      tailX = Math.max(tailX, sim.positions[index * 3]);
      minY = Math.min(minY, sim.positions[index * 3 + 1]);
    }
    expect(tailX).toBeGreaterThan(restTail * 0.6);
    expect(minY).toBeGreaterThan(0.1);
  }, 20_000);

  it('only inflates the windsock once its mouth is open', () => {
    expect(workflowWind('fish-flag', 'shell', 3).inflation).toBe(0);
    expect(workflowWind('fish-flag', 'shell', 3, [2]).inflation).toBe(0);
    expect(workflowWind('fish-flag', 'shell', 3, [1]).inflation).toBeGreaterThan(0);
    expect(workflowWind('fish-flag', 'thicken', 3).inflation).toBeGreaterThan(0);
  });

  it('collapses a closed Path 1 shell like an empty bag instead of holding its volume', () => {
    const { sim, data } = simulation('fish-flag', 'shell');
    sim.setWind(workflowWind('fish-flag', 'shell', 0));
    const rest = enclosedVolume(data.proxy.positions, data.proxy.triangles);
    for (let step = 0; step < 180; step += 1) sim.step(1 / 60);
    expect(enclosedVolume(sim.positions, data.proxy.triangles) / rest).toBeLessThan(0.6);
  }, 20_000);
});
