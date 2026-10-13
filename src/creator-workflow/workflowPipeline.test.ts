import { describe, expect, it } from 'vitest';
import { workflowAsset } from './workflowAssets';
import { applyBindings, buildWorkflowPathData, planeProxy, proceduralWorkflowSources } from './workflowPipeline';
import { DEFAULT_WORKFLOW_STATE, WORKFLOW_PATHS } from './workflowTypes';

const sources = proceduralWorkflowSources('tshirt', 0.5);

describe('workflow pipeline', () => {
  it('binds every render vertex for every path and reconstructs the rest pose', () => {
    for (const path of WORKFLOW_PATHS) {
      const data = buildWorkflowPathData(DEFAULT_WORKFLOW_STATE, path, sources);
      expect(data.proxy.triangles.length).toBeGreaterThan(2);
      expect(data.renderBindings).toHaveLength(data.render.positions.length / 3);
      for (const binding of data.renderBindings) {
        expect(binding.barycentric[0] + binding.barycentric[1] + binding.barycentric[2]).toBeCloseTo(1, 5);
      }
      const rebuilt = applyBindings(data.proxy.positions, data, new Float32Array(data.render.positions.length));
      for (let index = 0; index < rebuilt.length; index += 1) {
        expect(rebuilt[index]).toBeCloseTo(data.render.positions[index], 4);
      }
    }
  }, 20_000);

  it('moves render vertices continuously across proxy triangle edges', () => {
    const data = buildWorkflowPathData(DEFAULT_WORKFLOW_STATE, 'thicken', sources);
    const bent = data.proxy.positions.slice();
    for (let index = 0; index < bent.length; index += 3) bent[index + 2] += 0.3 * Math.sin(bent[index] * 4) * bent[index + 1];
    const out = applyBindings(bent, data, new Float32Array(data.render.positions.length));
    const rest = data.render.positions;
    // Neighbouring render vertices bound to different proxy triangles must not tear apart.
    const { triangles } = data.render;
    let worst = 0;
    for (let face = 0; face < triangles.length; face += 3) {
      for (let k = 0; k < 3; k += 1) {
        const a = triangles[face + k] * 3;
        const b = triangles[face + ((k + 1) % 3)] * 3;
        const before = Math.hypot(rest[a] - rest[b], rest[a + 1] - rest[b + 1], rest[a + 2] - rest[b + 2]);
        const after = Math.hypot(out[a] - out[b], out[a + 1] - out[b + 1], out[a + 2] - out[b + 2]);
        if (before > 1e-4) worst = Math.max(worst, after / before);
      }
    }
    expect(worst).toBeLessThan(2.5);
  });

  it('excludes selected end caps from the shell but still binds cap vertices', () => {
    const full = buildWorkflowPathData(DEFAULT_WORKFLOW_STATE, 'shell', sources);
    const capped = buildWorkflowPathData({ ...DEFAULT_WORKFLOW_STATE, endCaps: [1, 2, 3, 4] }, 'shell', sources);
    expect(capped.proxy.triangles.length).toBeLessThan(full.proxy.triangles.length);
    expect(capped.renderBindings).toHaveLength(sources.capped.positions.length / 3);
    expect(capped.proxy.boundaryPairs.length).toBeGreaterThan(full.proxy.boundaryPairs.length * 2);
  });

  it('trims the single flat creator plane to the mesh silhouette', () => {
    const asset = workflowAsset('tshirt');
    const plane = planeProxy(sources.capped, asset.planeDepth);
    for (let index = 2; index < plane.positions.length; index += 3) expect(plane.positions[index]).toBe(asset.planeDepth);
    // Below the sleeves, beside the torso, there is no garment, so no plane either.
    for (let index = 0; index < plane.positions.length; index += 3) {
      const [x, y] = [plane.positions[index], plane.positions[index + 1]];
      expect(Math.abs(x) > 0.75 && y < 0.7, `plane vertex at ${x.toFixed(2)}, ${y.toFixed(2)}`).toBe(false);
    }
    const data = buildWorkflowPathData(DEFAULT_WORKFLOW_STATE, 'plane', sources);
    expect(data.proxy.positions.length).toBe(plane.positions.length);
  });

  it('thickens the authored open surface for Path 3, never the capped mesh', () => {
    const data = buildWorkflowPathData({ ...DEFAULT_WORKFLOW_STATE, endCaps: [1] }, 'thicken', sources);
    expect(data.render).toBe(sources.open);
  });
});
