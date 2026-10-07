import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { tetVolume } from '../xpbd/constraints';
import { createLayeredExampleDocument } from '../../assembly-editor/weldPaint';
import { AssemblySimulation } from './AssemblySimulation';
import { buildLayeredBlock } from './LayeredBlock';

const DT = 1 / 60;

function run(simulation: AssemblySimulation, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) simulation.step(DT);
}

function sheetCuts(simulation: AssemblySimulation, sheetId: string, solidId: string): number {
  const sheet = simulation.compiled.parts.find((part) => part.id === sheetId);
  const solid = simulation.compiled.parts.find((part) => part.id === solidId);
  if (!sheet?.stretch || !solid) return 0;
  const positions = simulation.positions;
  let cuts = 0;
  for (let edge = 0; edge < sheet.stretch.length; edge += 2) {
    const a = sheet.stretch[edge] * 3;
    const b = sheet.stretch[edge + 1] * 3;
    for (let t = 0; t < solid.triangles.length; t += 3) {
      if (
        segmentCutsTriangle(
          positions[a],
          positions[a + 1],
          positions[a + 2],
          positions[b],
          positions[b + 1],
          positions[b + 2],
          positions,
          solid.triangles[t],
          solid.triangles[t + 1],
          solid.triangles[t + 2],
        )
      ) {
        cuts++;
      }
    }
  }
  return cuts;
}

function segmentCutsTriangle(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  positions: Float32Array,
  i: number,
  j: number,
  k: number,
): boolean {
  const ia = i * 3;
  const ja = j * 3;
  const ka = k * 3;
  const ux = positions[ja] - positions[ia];
  const uy = positions[ja + 1] - positions[ia + 1];
  const uz = positions[ja + 2] - positions[ia + 2];
  const vx = positions[ka] - positions[ia];
  const vy = positions[ka + 1] - positions[ia + 1];
  const vz = positions[ka + 2] - positions[ia + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-8) return false;
  const d0 = ((ax - positions[ia]) * nx + (ay - positions[ia + 1]) * ny + (az - positions[ia + 2]) * nz) / length;
  const d1 = ((bx - positions[ia]) * nx + (by - positions[ia + 1]) * ny + (bz - positions[ia + 2]) * nz) / length;
  // A sheet resting on a wrinkled face crosses it by a few millimetres. Count only edges that pass well through.
  if (d0 * d1 >= 0 || Math.abs(d0) < 0.045 || Math.abs(d1) < 0.045) return false;
  const span = d0 - d1;
  if (Math.abs(span) < 1e-8) return false;
  const t = d0 / span;
  if (t < 0.08 || t > 0.92) return false;
  const px = ax + (bx - ax) * t;
  const py = ay + (by - ay) * t;
  const pz = az + (bz - az) * t;
  const apx = px - positions[ia];
  const apy = py - positions[ia + 1];
  const apz = pz - positions[ia + 2];
  const d00 = ux * ux + uy * uy + uz * uz;
  const d01 = ux * vx + uy * vy + uz * vz;
  const d11 = vx * vx + vy * vy + vz * vz;
  const d20 = apx * ux + apy * uy + apz * uz;
  const d21 = apx * vx + apy * vy + apz * vz;
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-12) return false;
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const u = 1 - v - w;
  return u > 0.08 && v > 0.08 && w > 0.08;
}

function includes(indices: Uint32Array, value: number): boolean {
  return indices.includes(value);
}

describe('layered block builder', () => {
  it('merges both material interfaces into shared particle indices', () => {
    const mesh = buildLayeredBlock();
    expect(mesh.positions.length / 3).toBe(471);
    expect(mesh.welds).toHaveLength(2);
    expect(mesh.welds[0].particleIndices).toHaveLength(49);
    expect(mesh.welds[1].particleIndices).toHaveLength(49);
    for (const index of mesh.welds[0].particleIndices) {
      expect(includes(mesh.baseParticles, index)).toBe(true);
      expect(includes(mesh.coreParticles, index)).toBe(true);
    }
    for (const index of mesh.welds[1].particleIndices) {
      expect(includes(mesh.coreParticles, index)).toBe(true);
      expect(includes(mesh.clothParticles, index)).toBe(true);
    }
  });

  it('builds a positive tetrahedral gel volume and omits the hidden base-core face', () => {
    const mesh = buildLayeredBlock();
    let volume = 0;
    for (let i = 0; i < mesh.coreTets.length; i += 4) {
      const value = tetVolume(
        mesh.positions,
        mesh.coreTets[i],
        mesh.coreTets[i + 1],
        mesh.coreTets[i + 2],
        mesh.coreTets[i + 3],
      );
      expect(value).toBeGreaterThan(0);
      volume += value;
    }
    expect(volume).toBeCloseTo(0.9 * 0.6 * 0.9, 5);

    const hidden = new Set(mesh.welds[0].particleIndices);
    for (let i = 0; i < mesh.surfaceTriangles.length; i += 3) {
      const allOnHiddenInterface =
        hidden.has(mesh.surfaceTriangles[i]) &&
        hidden.has(mesh.surfaceTriangles[i + 1]) &&
        hidden.has(mesh.surfaceTriangles[i + 2]);
      expect(allOnHiddenInterface).toBe(false);
    }
  });
});

describe('AssemblySimulation', () => {
  const document = createLayeredExampleDocument();

  it('settles with welds held under a millimetre and a rigid base', () => {
    const simulation = new AssemblySimulation(document);
    expect(simulation.compiled.welds.length).toBeGreaterThan(0);
    run(simulation, 1);
    expect(simulation.maxWeldSeparation()).toBeLessThan(0.001);
    expect(simulation.rigidShapeError()).toBeLessThan(0.002);
    for (const value of simulation.positions) expect(Number.isFinite(value)).toBe(true);
  });

  it('keeps every rigid particle, including welded ones, in the rigid shape', () => {
    const simulation = new AssemblySimulation(document);
    const base = simulation.partParticles('rigid-base');
    const rest = simulation.positions.slice();
    run(simulation, 2);
    let maxEdgeChange = 0;
    for (let a = 0; a < base.length; a += 7) {
      for (let b = a + 1; b < base.length; b += 11) {
        const i = base[a] * 3;
        const j = base[b] * 3;
        const before = Math.hypot(rest[i] - rest[j], rest[i + 1] - rest[j + 1], rest[i + 2] - rest[j + 2]);
        const p = simulation.positions;
        const after = Math.hypot(p[i] - p[j], p[i + 1] - p[j + 1], p[i + 2] - p[j + 2]);
        maxEdgeChange = Math.max(maxEdgeChange, Math.abs(after - before));
      }
    }
    expect(maxEdgeChange).toBeLessThan(0.003);
  });

  it('keeps the welded sheet outside the gel instead of cutting through its corners', () => {
    const simulation = new AssemblySimulation(document);
    const cloth = simulation.compiled.parts.find((part) => part.id === 'cloth-skin');
    expect(cloth?.count).toBeGreaterThan(49);
    expect(cloth?.outlinePins.length).toBeGreaterThan(0);
    run(simulation, 2);
    expect(sheetCuts(simulation, 'cloth-skin', 'gel-core')).toBe(0);
    expect(sheetCuts(simulation, 'cloth-skin', 'rigid-base')).toBe(0);
    expect(simulation.maxWeldSeparation()).toBeLessThan(0.001);
    for (const value of simulation.positions) expect(Number.isFinite(value)).toBe(true);
  });

  it('rests in place on the floor instead of launching or sliding off', () => {
    const simulation = new AssemblySimulation(document);
    const start = simulation.stats().center;
    for (let frame = 0; frame < 600; frame++) {
      simulation.step(DT);
      expect(simulation.stats().center[1]).toBeLessThan(start[1] + 0.05);
    }
    const end = simulation.stats().center;
    expect(Math.hypot(end[0] - start[0], end[2] - start[2])).toBeLessThan(0.1);
    expect(Math.abs(end[1] - start[1])).toBeLessThan(0.05);
  }, 20_000);

  it.each(['rigid-base', 'gel-core', 'cloth-skin'])('can grab the %s and pull the connected assembly', (partId) => {
    const simulation = new AssemblySimulation(document);
    run(simulation, 0.4);
    const before = simulation.stats().center[1];
    let picked = simulation.partParticles(partId)[0];
    let bestY = -Infinity;
    for (const index of simulation.partParticles(partId)) {
      const y = simulation.positions[index * 3 + 1];
      if (y > bestY) {
        bestY = y;
        picked = index;
      }
    }
    const target = new THREE.Vector3(
      simulation.positions[picked * 3],
      simulation.positions[picked * 3 + 1],
      simulation.positions[picked * 3 + 2],
    );
    const origin = new THREE.Vector3(target.x, target.y, 4);
    const direction = target.clone().sub(origin).normalize();
    expect(simulation.beginGrab(new THREE.Ray(origin, direction))).toBe(true);
    simulation.updateGrab(new THREE.Ray(origin.clone().setY(origin.y + 0.7), direction));
    run(simulation, 0.6);
    expect(simulation.stats().center[1]).toBeGreaterThan(before + 0.05);
    expect(simulation.maxWeldSeparation()).toBeLessThan(0.001);
    expect(simulation.rigidShapeError()).toBeLessThan(0.002);
  });

  it('remains finite and welded through impacts, pressing, and reset', () => {
    const simulation = new AssemblySimulation(document);
    simulation.dropImpactor(0, 0);
    run(simulation, 0.8);
    simulation.setPressActive(true);
    run(simulation, 0.8);
    simulation.setPressActive(false);
    run(simulation, 0.3);
    expect(simulation.rigidShapeError()).toBeLessThan(0.03);
    expect(simulation.maxWeldSeparation()).toBeLessThan(0.001);
    for (const value of simulation.positions) expect(Number.isFinite(value)).toBe(true);
    simulation.reset();
    expect(simulation.stats().impactorCount).toBe(0);
    expect(simulation.stats().maxDeformation).toBeLessThan(1e-6);
  });
});
