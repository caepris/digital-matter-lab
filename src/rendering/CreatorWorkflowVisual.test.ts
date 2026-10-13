import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_ASSET_IDS, buildWorkflowSurface } from '../creator-workflow/workflowAssets';
import { DEFAULT_WORKFLOW_STATE, WORKFLOW_PATHS, WORKFLOW_STAGES, displayThickness } from '../creator-workflow/workflowTypes';
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
        expect([solid.material].flat().every((material) => !material.transparent)).toBe(true);
        const textured = visual.root.children.filter(
          (child) => child instanceof THREE.Mesh && [child.material].flat().some((m) => (m as THREE.MeshStandardMaterial).map),
        );
        expect(textured, `${path} ${stage} render mesh hidden`).toHaveLength(0);
        visual.dispose();
      }
    }
  });

  it('draws every simulation mesh with visible thickness once it is built', () => {
    const sources = proceduralWorkflowSources('tshirt', 0.4);
    for (const path of WORKFLOW_PATHS) {
      const data = buildWorkflowPathData(DEFAULT_WORKFLOW_STATE, path, sources);
      for (const showRender of [true, false]) {
        const state = { ...DEFAULT_WORKFLOW_STATE, stage: 'simulate' as const, showRender, thicknessCm: 2 };
        const visual = new CreatorWorkflowVisual(path, state, data);
        const wireframe = visual.root.getObjectByName('workflow-proxy-wire') as THREE.LineSegments;
        expect(wireframe, `${path} render ${showRender}`).toBeTruthy();
        const values = wireframe.geometry.getAttribute('position').array as Float32Array;
        const pairs = data.proxy.stretchPairs.length;
        let gap = 0;
        for (let index = 0; index < pairs * 3; index += 1) gap = Math.max(gap, Math.abs(values[index] - values[pairs * 3 + index]));
        expect(gap, `${path} render ${showRender} faces apart`).toBeGreaterThan(displayThickness(2) * 0.5);
        visual.dispose();
      }
    }
  });

  it('cuts every layer at the section plane and fills the wall thickness', () => {
    const sources = proceduralWorkflowSources('fish-flag', 0.4);
    for (const path of WORKFLOW_PATHS) {
      const data = buildWorkflowPathData(DEFAULT_WORKFLOW_STATE, path, sources);
      for (const showRender of [true, false]) {
        const state = { ...DEFAULT_WORKFLOW_STATE, stage: 'simulate' as const, showRender, section: true };
        const visual = new CreatorWorkflowVisual(path, state, data);
        expect(visual.sectionX).not.toBeNull();
        expect(visual.root.getObjectByName('workflow-section-plane')).toBeTruthy();
        const fills = visual.root.children.filter((child) => child.name === 'workflow-section-fill') as THREE.Mesh[];
        expect(fills.length, `${path} render ${showRender} fill`).toBeGreaterThan(0);
        for (const fill of fills) {
          expect(fill.geometry.drawRange.count, `${path} fill vertices`).toBeGreaterThan(0);
          const positions = fill.geometry.getAttribute('position').array as Float32Array;
          expect(positions[0]).toBeCloseTo(visual.sectionX!, 5);
        }
        visual.root.traverse((child) => {
          if (child.userData.unclipped || !(child instanceof THREE.Mesh || child instanceof THREE.LineSegments)) return;
          if (child.name === 'workflow-section-plane') return;
          for (const material of [child.material].flat()) expect(material.clippingPlanes, child.name).toHaveLength(1);
        });
        visual.dispose();
      }
    }
  });

  it('shows and hides the simulation mesh overlay with its checkbox after submit', () => {
    const sources = proceduralWorkflowSources('tshirt', 0.4);
    for (const path of WORKFLOW_PATHS) {
      const data = buildWorkflowPathData(DEFAULT_WORKFLOW_STATE, path, sources);
      for (const stage of ['build', 'simulate'] as const) {
        for (const showRender of [true, false]) {
          const names = (showMapping: boolean) => {
            const visual = new CreatorWorkflowVisual(path, { ...DEFAULT_WORKFLOW_STATE, stage, showRender, showMapping }, data);
            const found = new Set<string>();
            visual.root.traverse((child) => found.add(child.name));
            visual.dispose();
            return found;
          };
          const label = `${path} ${stage} render ${showRender}`;
          expect(names(true).has('workflow-proxy-wire'), label).toBe(true);
          const hidden = names(false);
          expect(hidden.has('workflow-proxy-wire'), label).toBe(false);
          expect(hidden.has('workflow-proxy-overlay'), label).toBe(false);
          expect(hidden.has('workflow-solid-proxy'), label).toBe(!showRender);
        }
      }
    }
  });
});
