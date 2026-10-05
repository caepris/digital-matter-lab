import { describe, expect, it } from 'vitest';
import {
  applyDistancePlasticity,
  applyVolumePlasticity,
  distance,
  DistanceConstraints,
  solveDistances,
  solveTetVolumes,
  tetVolume,
  TetVolumeConstraints,
} from './constraints';

const H = 1 / 600;

function unitTet(): Float32Array {
  return new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

describe('distance constraints', () => {
  it('converge to the rest length when rigid', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    const constraints = new DistanceConstraints([0, 1], positions);
    positions[3] = 1.5;
    const invMass = new Float32Array([1, 1]);
    for (let i = 0; i < 20; i++) solveDistances(positions, invMass, constraints, 0, H);
    expect(distance(positions, 0, 1)).toBeCloseTo(1, 5);
    // Equal masses share the correction, keeping the midpoint fixed.
    expect((positions[0] + positions[3]) / 2).toBeCloseTo(0.75, 5);
  });

  it('move compliant constraints only part of the way per solve', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    const constraints = new DistanceConstraints([0, 1], positions);
    positions[3] = 1.5;
    solveDistances(positions, new Float32Array([1, 1]), constraints, 1e-5, H);
    const length = distance(positions, 0, 1);
    expect(length).toBeGreaterThan(1);
    expect(length).toBeLessThan(1.5);
  });

  it('use the softer compression compliance only when compressed', () => {
    const invMass = new Float32Array([1, 1]);
    const compressed = new Float32Array([0, 0, 0, 1, 0, 0]);
    const constraints = new DistanceConstraints([0, 1], compressed);
    compressed[3] = 0.5;
    solveDistances(compressed, invMass, constraints, 0, H, 1);
    expect(distance(compressed, 0, 1)).toBeLessThan(0.51);

    const stretched = new Float32Array([0, 0, 0, 1.5, 0, 0]);
    solveDistances(stretched, invMass, constraints, 0, H, 1);
    expect(distance(stretched, 0, 1)).toBeCloseTo(1, 5);
  });

  it('ignore particles with infinite mass', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    const constraints = new DistanceConstraints([0, 1], positions);
    positions[3] = 2;
    for (let i = 0; i < 20; i++) solveDistances(positions, new Float32Array([0, 1]), constraints, 0, H);
    expect(Array.from(positions.slice(0, 3))).toEqual([0, 0, 0]);
    expect(positions[3]).toBeCloseTo(1, 5);
  });
});

describe('tetrahedral volume constraints', () => {
  it('restore a squashed tetrahedron to its rest volume', () => {
    const positions = unitTet();
    const constraints = new TetVolumeConstraints(new Uint32Array([0, 1, 2, 3]), positions);
    const restVolume = constraints.rest[0];
    expect(restVolume).toBeCloseTo(1 / 6, 6);
    positions[11] = 0.4;
    const invMass = new Float32Array([1, 1, 1, 1]);
    for (let i = 0; i < 30; i++) solveTetVolumes(positions, invMass, constraints, 0, H);
    expect(tetVolume(positions, 0, 1, 2, 3)).toBeCloseTo(restVolume, 4);
  });

  it('recover an inverted tetrahedron via the inversion guard', () => {
    const positions = unitTet();
    const constraints = new TetVolumeConstraints(new Uint32Array([0, 1, 2, 3]), positions);
    positions[11] = -0.5;
    expect(tetVolume(positions, 0, 1, 2, 3)).toBeLessThan(0);
    const invMass = new Float32Array([1, 1, 1, 1]);
    // Even a very compliant (compressible) material must not stay inside out.
    for (let i = 0; i < 30; i++) solveTetVolumes(positions, invMass, constraints, 1, H, 0.35);
    expect(tetVolume(positions, 0, 1, 2, 3)).toBeGreaterThan(0);
  });
});

describe('plasticity', () => {
  const settings = { yieldStrain: 0.05, creep: 0.5, maxStrain: 0.2 };

  it('leaves rest lengths alone within the yield strain', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    const constraints = new DistanceConstraints([0, 1], positions);
    positions[3] = 1.03;
    expect(applyDistancePlasticity(positions, constraints, settings)).toBe(0);
    expect(constraints.rest[0]).toBeCloseTo(1, 6);
  });

  it('creeps rest lengths beyond the yield strain, clamped to the maximum', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    const constraints = new DistanceConstraints([0, 1], positions);
    positions[3] = 0.85;
    expect(applyDistancePlasticity(positions, constraints, settings)).toBe(1);
    // Excess beyond yield is 0.10; half of it becomes permanent.
    expect(constraints.rest[0]).toBeCloseTo(0.95, 5);

    positions[3] = 0.1;
    for (let i = 0; i < 50; i++) applyDistancePlasticity(positions, constraints, settings);
    expect(constraints.rest[0]).toBeCloseTo(0.8, 5);

    constraints.resetRest();
    expect(constraints.rest[0]).toBeCloseTo(1, 6);
  });

  it('creeps rest volumes of compressed tetrahedra', () => {
    const positions = unitTet();
    const constraints = new TetVolumeConstraints(new Uint32Array([0, 1, 2, 3]), positions);
    positions[11] = 0.5;
    applyVolumePlasticity(positions, constraints, settings);
    expect(constraints.rest[0]).toBeLessThan(constraints.initialRest[0]);
    expect(constraints.rest[0]).toBeGreaterThan(constraints.initialRest[0] * 0.8 - 1e-9);
  });
});
