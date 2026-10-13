import { describe, expect, it } from 'vitest';
import {
  BACK_SKIN_REGION,
  WORKFLOW_ASSET_IDS,
  buildWorkflowSurface,
  faceRegions,
  workflowAsset,
} from './workflowAssets';
import { boundaryEdges, vertexComponents, weldMap } from './surfaceTopology';

describe('workflow assets', () => {
  for (const id of WORKFLOW_ASSET_IDS) {
    it(`builds deterministic closed geometry with UVs and cap regions for ${id}`, () => {
      const first = buildWorkflowSurface(id, 0.5);
      const second = buildWorkflowSurface(id, 0.5);
      const vertexCount = first.positions.length / 3;

      expect(first.uvs.length).toBe(vertexCount * 2);
      expect(first.capRegion.length).toBe(vertexCount);
      expect([...first.positions].every(Number.isFinite)).toBe(true);
      expect([...first.triangles].every((index) => index < vertexCount)).toBe(true);
      expect([...first.positions]).toEqual([...second.positions]);

      const regions = new Set(faceRegions(first));
      for (const cap of workflowAsset(id).capRegions) expect(regions.has(cap.id), `${id} cap ${cap.label}`).toBe(true);
      for (const region of regions) {
        if (region === 0 || region === BACK_SKIN_REGION) continue;
        expect(workflowAsset(id).capRegions.some((cap) => cap.id === region)).toBe(true);
      }
    });
  }

  it('winds every example outward (positive signed volume)', () => {
    for (const id of WORKFLOW_ASSET_IDS) {
      const { positions, triangles } = buildWorkflowSurface(id, 0.5);
      let volume = 0;
      for (let index = 0; index < triangles.length; index += 3) {
        const [a, b, c] = [triangles[index] * 3, triangles[index + 1] * 3, triangles[index + 2] * 3];
        volume +=
          (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
            positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
            positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) /
          6;
      }
      expect(volume, id).toBeGreaterThan(0);
    }
  });

  it('authors a zero-thickness open surface with no caps or closed volumes for Path 3', () => {
    for (const id of WORKFLOW_ASSET_IDS) {
      const open = buildWorkflowSurface(id, 0.5, 'open');
      const vertexCount = open.positions.length / 3;
      expect([...open.capRegion].every((region) => region === 0), id).toBe(true);
      expect(open.uvs.length).toBe(vertexCount * 2);
      expect([...open.triangles].every((index) => index < vertexCount)).toBe(true);
      const canonical = weldMap(open.positions);
      const boundary = boundaryEdges(open.triangles, canonical);
      // Every connected piece (torso, sleeve, collar band, hood) has an open edge: nothing is a closed volume.
      const components = vertexComponents(vertexCount, [...open.triangles].map((index) => canonical[index]));
      const withBoundary = new Set(boundary.map(([a]) => components[canonical[a]]));
      const pieces = new Set([...open.triangles].map((index) => components[canonical[index]]));
      for (const piece of pieces) expect(withBoundary.has(piece), `${id} piece ${piece} is closed`).toBe(true);
    }
  });

  it('keeps no Path 3 garment geometry hidden inside the torso', () => {
    for (const id of ['tshirt', 'puffer-jacket', 'hooded-jacket'] as const) {
      const open = buildWorkflowSurface(id, 0.5, 'open');
      const capped = buildWorkflowSurface(id, 0.5);
      const inside = (surface: typeof open) => {
        let count = 0;
        for (let index = 0; index < surface.positions.length; index += 3) {
          const [x, y, z] = [surface.positions[index], surface.positions[index + 1], surface.positions[index + 2]];
          if (y > 0.3 && y < 1.25 && Math.abs(x) < 0.38 && Math.abs(z) < 0.12) count += 1;
        }
        return count;
      };
      expect(inside(open), id).toBe(0);
      if (id === 'hooded-jacket') expect(inside(capped), 'capped hood tucks into the torso').toBeGreaterThan(0);
    }
  });

  it('gives every example creator guidance for each path', () => {
    for (const id of WORKFLOW_ASSET_IDS) {
      const asset = workflowAsset(id);
      expect(asset.shellNote.length).toBeGreaterThan(20);
      expect(asset.planeNote.length).toBeGreaterThan(20);
      expect(asset.thickenNote.length).toBeGreaterThan(20);
      expect(asset.capRegions.length).toBeGreaterThan(0);
      expect(asset.defaultThicknessCm).toBeGreaterThan(0);
    }
  });
});
