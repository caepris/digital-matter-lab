import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CUBE_SIZE, PRESS_REST_BOTTOM } from './scene';
import { buildShellMesh } from './shell/ShellMesh';
import { ShellSimulation } from './shell/ShellSimulation';
import { buildVolumeMesh } from './volume/VolumeMesh';
import { VolumeSimulation } from './volume/VolumeSimulation';
import { tetVolume } from './xpbd/constraints';
import type { MatterSimulation } from './types';

const DT = 1 / 60;

function run(simulation: MatterSimulation, seconds: number, each?: () => void): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    simulation.step(DT);
    each?.();
  }
}

function totalVolume(simulation: VolumeSimulation): number {
  const { tets, count } = simulation.volumes;
  let volume = 0;
  for (let t = 0; t < count; t++) {
    volume += tetVolume(simulation.positions, tets[t * 4], tets[t * 4 + 1], tets[t * 4 + 2], tets[t * 4 + 3]);
  }
  return volume;
}

function maxHeight(positions: Float32Array): number {
  let max = -Infinity;
  for (let i = 1; i < positions.length; i += 3) max = Math.max(max, positions[i]);
  return max;
}

describe('volume mesh', () => {
  it('fills the cube with positively oriented tetrahedra summing to its volume', () => {
    const mesh = buildVolumeMesh(4);
    expect(mesh.positions.length / 3).toBe(125);
    expect(mesh.tets.length / 4).toBe(64 * 6);
    let volume = 0;
    for (let t = 0; t < mesh.tets.length; t += 4) {
      const v = tetVolume(mesh.positions, mesh.tets[t], mesh.tets[t + 1], mesh.tets[t + 2], mesh.tets[t + 3]);
      expect(v).toBeGreaterThan(0);
      volume += v;
    }
    expect(volume).toBeCloseTo(CUBE_SIZE ** 3, 6);
  });
});

describe('shell mesh', () => {
  it('stitches six faces into one closed surface with no interior particles', () => {
    const n = 4;
    const mesh = buildShellMesh(n);
    expect(mesh.positions.length / 3).toBe((n + 1) ** 3 - (n - 1) ** 3);
    // On a closed triangle mesh every edge is shared by exactly two triangles,
    // so each one also yields one bending pair.
    expect(mesh.bendPairs.length).toBe(mesh.stretchPairs.length);
    expect(mesh.triangles.length / 3).toBe(6 * n * n * 2);
  });
});

describe('VolumeSimulation', () => {
  it('stays nearly incompressible when an impactor lands on gel', () => {
    const simulation = new VolumeSimulation('gel');
    run(simulation, 1);
    const rest = totalVolume(simulation);
    simulation.dropImpactor(0, 0);
    let minVolume = Infinity;
    let peak = 0;
    run(simulation, 1.5, () => {
      minVolume = Math.min(minVolume, totalVolume(simulation));
      peak = Math.max(peak, simulation.stats().maxDeformation);
    });
    expect(peak).toBeGreaterThan(0.05);
    expect(minVolume / rest).toBeGreaterThan(0.95);
  });

  it('recovers elastic gel but keeps a plastic dent in foam', () => {
    const results: Record<string, number> = {};
    for (const id of ['gel', 'foam']) {
      const simulation = new VolumeSimulation(id);
      run(simulation, 0.5);
      simulation.setPressActive(true);
      run(simulation, 4);
      simulation.setPressActive(false);
      run(simulation, 4);
      results[id] = simulation.stats().maxDeformation;
    }
    expect(results.gel).toBeLessThan(0.05);
    expect(results.foam).toBeGreaterThan(0.1);
  });

  it('lets stiffer material stall the force-limited press sooner', () => {
    const bottoms: Record<string, number> = {};
    for (const id of ['gel', 'firm-rubber']) {
      const simulation = new VolumeSimulation(id);
      simulation.setPressActive(true);
      run(simulation, 4);
      bottoms[id] = simulation.stats().pressBottom;
    }
    expect(bottoms['firm-rubber']).toBeGreaterThan(bottoms.gel + 0.2);
  });

  it('never inverts tetrahedra under a full press', () => {
    for (const id of ['gel', 'foam', 'firm-rubber']) {
      const simulation = new VolumeSimulation(id);
      simulation.setPressActive(true);
      run(simulation, 4);
      const { tets, count } = simulation.volumes;
      for (let t = 0; t < count; t++) {
        expect(
          tetVolume(simulation.positions, tets[t * 4], tets[t * 4 + 1], tets[t * 4 + 2], tets[t * 4 + 3]),
        ).toBeGreaterThan(0);
      }
    }
  });

  it('reset restores rest shape, plastic rest state, and clears interactions', () => {
    const simulation = new VolumeSimulation('foam');
    simulation.dropImpactor(0, 0);
    simulation.setPressActive(true);
    run(simulation, 3);
    simulation.reset();
    const stats = simulation.stats();
    expect(stats.impactorCount).toBe(0);
    expect(stats.pressActive).toBe(false);
    expect(stats.pressBottom).toBe(PRESS_REST_BOTTOM);
    expect(stats.maxDeformation).toBeLessThan(1e-6);
    expect(Array.from(simulation.edges.rest)).toEqual(Array.from(simulation.edges.initialRest));
    expect(Array.from(simulation.volumes.rest)).toEqual(Array.from(simulation.volumes.initialRest));
  });

  it('can be grabbed and lifted', () => {
    const simulation = new VolumeSimulation('firm-rubber');
    run(simulation, 0.5);
    const origin = new THREE.Vector3(0, 0.5, 5);
    expect(simulation.beginGrab(new THREE.Ray(origin, new THREE.Vector3(0, 0, -1)))).toBe(true);
    simulation.updateGrab(new THREE.Ray(origin.clone().setY(1.5), new THREE.Vector3(0, 0, -1)));
    run(simulation, 2);
    expect(simulation.stats().grabbing).toBe(true);
    expect(simulation.stats().center[1]).toBeGreaterThan(0.8);
  });

  it('stays stable under repeated impacts, grabs, and presses', () => {
    const simulation = new VolumeSimulation('gel');
    for (let round = 0; round < 4; round++) {
      simulation.dropImpactor(0.2 * round - 0.3, 0.1);
      run(simulation, 0.5);
      simulation.beginGrab(new THREE.Ray(new THREE.Vector3(0, 0.6, 5), new THREE.Vector3(0, 0, -1)));
      simulation.updateGrab(new THREE.Ray(new THREE.Vector3(0.5, 1.4, 5), new THREE.Vector3(0, 0, -1)));
      run(simulation, 0.5);
      simulation.endGrab();
      simulation.setPressActive(true);
      run(simulation, 1);
      simulation.setPressActive(false);
      run(simulation, 0.5);
    }
    for (const value of simulation.positions) expect(Number.isFinite(value)).toBe(true);
    run(simulation, 3);
    expect(simulation.stats().maxDeformation).toBeLessThan(0.15);
  });
});

describe('ShellSimulation', () => {
  it('loose cloth sags under its own weight because it has no inner volume', () => {
    const simulation = new ShellSimulation('loose-cloth');
    run(simulation, 3);
    expect(maxHeight(simulation.positions)).toBeLessThan(CUBE_SIZE * 0.7);
  });

  it('structured fabric holds its shape far better than loose cloth', () => {
    const simulation = new ShellSimulation('structured-fabric');
    run(simulation, 3);
    expect(maxHeight(simulation.positions)).toBeGreaterThan(CUBE_SIZE * 0.9);
  });

  it('self-collision keeps the flattened layers apart', () => {
    const simulation = new ShellSimulation('loose-cloth');
    simulation.setPressActive(true);
    run(simulation, 4);
    let minY = Infinity;
    for (let i = 1; i < simulation.positions.length; i += 3) minY = Math.min(minY, simulation.positions[i]);
    expect(maxHeight(simulation.positions) - minY).toBeGreaterThan(0.05);
  });

  it('catches an impactor on the cloth rather than letting it pass between particles', () => {
    const simulation = new ShellSimulation('structured-fabric');
    run(simulation, 1);
    simulation.dropImpactor(0, 0);
    run(simulation, 2);
    expect(simulation.frame(1).impactors[0].y).toBeGreaterThan(0.4);
  });

  it('reset rebuilds the standing cube', () => {
    const simulation = new ShellSimulation('loose-cloth');
    run(simulation, 2);
    simulation.reset();
    expect(maxHeight(simulation.positions)).toBeGreaterThan(CUBE_SIZE);
    expect(simulation.stats().maxDeformation).toBeLessThan(0.02);
  });
});
