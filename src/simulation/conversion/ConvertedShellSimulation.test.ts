import { describe, expect, it } from 'vitest';
import { convertSurface } from './convertSurface';
import { buildSourceMesh, SOURCE_MESH_IDS } from './sourceMeshes';
import { bendingComplianceForThickness, ConvertedShellSimulation } from './ConvertedShellSimulation';

const surface = {
  positions: new Float32Array([-0.5, 1, -0.5, 0.5, 1, -0.5, -0.5, 1, 0.5, 0.5, 1, 0.5]),
  triangles: new Uint32Array([0, 1, 2, 2, 1, 3]),
  stretchPairs: new Uint32Array([0, 1, 0, 2, 1, 2, 1, 3, 2, 3]),
  bendPairs: new Uint32Array([0, 3]),
};

describe('ConvertedShellSimulation', () => {
  it('simulates an arbitrary indexed surface with configurable thickness', () => {
    const simulation = new ConvertedShellSimulation({
      mesh: surface,
      thickness: 0.04,
      presetId: 'structured-fabric',
    });
    const startY = simulation.stats().center[1];
    for (let i = 0; i < 60; i++) simulation.step(1 / 60);
    expect(simulation.thickness).toBe(0.04);
    expect(simulation.stats().center[1]).toBeLessThan(startY);
    expect(Array.from(simulation.frame(1).particles ?? [])).toSatisfy((values: number[]) =>
      values.every(Number.isFinite),
    );
  });

  it('clamps unsafe near-zero thickness', () => {
    const simulation = new ConvertedShellSimulation({ mesh: surface, thickness: 0 });
    expect(simulation.thickness).toBe(0.002);
  });

  it('makes a thicker shell harder to bend', () => {
    const thin = bendingComplianceForThickness(0.01, 0.01);
    const thick = bendingComplianceForThickness(0.01, 0.04);
    expect(thick).toBeLessThan(thin);
    expect(thin / thick).toBeCloseTo(64, 5);
  });

  it('keeps every built-in converted mesh finite while it settles', () => {
    for (const id of SOURCE_MESH_IDS) {
      const source = buildSourceMesh(id);
      const converted = convertSurface({
        positions: source.positions,
        triangles: source.triangles,
        targetSpacing: 0.13,
      });
      const simulation = new ConvertedShellSimulation({
        mesh: converted,
        thickness: source.defaultThickness,
        presetId: id === 'car-shell' ? 'sheet-metal' : id === 'curtain' ? 'structured-fabric' : 'loose-cloth',
      });
      for (let i = 0; i < 90; i++) simulation.step(1 / 60);
      expect(Array.from(simulation.frame(1).particles ?? []).every(Number.isFinite), id).toBe(true);
      expect(simulation.stats().center.every(Number.isFinite), id).toBe(true);
    }
  });
});
