import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_ASSET_IDS, buildWorkflowSurface } from '../creator-workflow/workflowAssets';
import { DEFAULT_WORKFLOW_STATE, WORKFLOW_PATHS, WORKFLOW_STAGES } from '../creator-workflow/workflowTypes';
import { buildWorkflowPathData, proceduralWorkflowSources } from '../creator-workflow/workflowPipeline';
import { CreatorWorkflowVisual, buildThickLayout, updateThickLayout } from './CreatorWorkflowVisual';

describe('creator workflow thickening', () => {
  it('builds outer, inner, and rim groups with UVs for every open example', () => {
    for (const assetId of WORKFLOW_ASSET_IDS) {
      const surface = buildWorkflowSurface(assetId, 0.4, 'open');
      const layout = buildThickLayout(surface);
      updateThickLayout(layout, surface.positions, 0.05);
      const { geometry } = layout;
      const positions = geometry.getAttribute('position');
      const uvs = geometry.getAttribute('uv');

      expect(geometry.groups.map((group) => group.materialIndex)).toEqual([0, 1, 2]);
      expect(geometry.groups[2].count, `${assetId} rim`).toBeGreaterThan(0);
      expect(uvs.count).toBe(positions.count);
      expect([...positions.array].every(Number.isFinite)).toBe(true);
      expect([...uvs.array].every(Number.isFinite)).toBe(true);
      geometry.dispose();
    }
  });

  it('grows thickness outward and derives rim UVs from the boundary UVs', () => {
    const surface = buildWorkflowSurface('tshirt', 0.4, 'open');
    const layout = buildThickLayout(surface, 0.06);
    updateThickLayout(layout, surface.positions, 0.1);
    const count = surface.positions.length / 3;
    const position = layout.geometry.getAttribute('position');
    const uv = layout.geometry.getAttribute('uv');
    const outer = new THREE.Vector3().fromBufferAttribute(position, 0);
    const inner = new THREE.Vector3().fromBufferAttribute(position, count);
    expect(outer.distanceTo(inner)).toBeCloseTo(0.1, 5);

    const rimStart = count * 2;
    const vertex = layout.source[rimStart];
    expect(uv.getX(rimStart)).toBe(surface.uvs[vertex * 2]);
    expect(uv.getY(rimStart + 2)).toBeCloseTo(surface.uvs[vertex * 2 + 1] - 0.06, 5);
    layout.geometry.dispose();
  });

  it('renders every path at every stage and follows simulated particles', () => {
    const sources = proceduralWorkflowSources('fish-flag', 0.4);
    for (const path of WORKFLOW_PATHS) {
      const data = buildWorkflowPathData(DEFAULT_WORKFLOW_STATE, path, sources);
      for (const stage of WORKFLOW_STAGES) {
        const visual = new CreatorWorkflowVisual(path, { ...DEFAULT_WORKFLOW_STATE, stage, endCaps: [1] }, data);
        expect(visual.root.children.length).toBeGreaterThan(0);
        const moved = new Float32Array(data.proxy.positions).map((value, index) => value + (index % 3 === 1 ? -0.2 : 0));
        visual.updateSimulation(moved);
        const box = new THREE.Box3().setFromObject(visual.root);
        expect(Number.isFinite(box.min.y)).toBe(true);
        const colliders = visual.root.getObjectByName('workflow-colliders');
        expect(Boolean(colliders), `${path} ${stage} collider ghost`).toBe(stage === 'simulate' && path !== 'plane');
        visual.dispose();
      }
    }
  });

  it('replaces the render mesh with a solid simulation mesh when the render mesh is hidden', () => {
    const sources = proceduralWorkflowSources('tshirt', 0.4);
    for (const path of WORKFLOW_PATHS) {
      const data = buildWorkflowPathData(DEFAULT_WORKFLOW_STATE, path, sources);
      for (const stage of WORKFLOW_STAGES) {
        const visual = new CreatorWorkflowVisual(path, { ...DEFAULT_WORKFLOW_STATE, stage, showRender: false }, data);
        const solid = visual.root.getObjectByName('workflow-solid-proxy') as THREE.Mesh;
        expect(solid, `${path} ${stage}`).toBeTruthy();
        expect((solid.material as THREE.Material).transparent).toBe(false);
        const textured = visual.root.children.filter(
          (child) => child instanceof THREE.Mesh && [child.material].flat().some((m) => (m as THREE.MeshStandardMaterial).map),
        );
        expect(textured, `${path} ${stage} render mesh hidden`).toHaveLength(0);
        visual.dispose();
      }
    }
  });
});
