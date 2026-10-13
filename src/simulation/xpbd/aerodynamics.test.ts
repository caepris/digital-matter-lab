import { describe, expect, it } from 'vitest';
import { applyAerodynamics, type WindSettings } from './aerodynamics';

const triangle = new Uint32Array([0, 1, 2]);
const wind: WindSettings = { velocity: [3, 0, 0], normalDrag: 0.6, tangentialDrag: 0, inflation: 0, gust: 0 };

function push(positions: number[], settings = wind): Float32Array {
  const velocities = new Float32Array(9);
  applyAerodynamics(new Float32Array(positions), velocities, new Float32Array([1, 1, 1]), triangle, settings, 0, 0.01);
  return velocities;
}

describe('aerodynamic wind', () => {
  it('pushes a face that faces the wind and lets an edge-on face pass', () => {
    const facing = push([0, 0, 0, 0, 1, 0, 0, 0, 1]);
    const edgeOn = push([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(facing[0]).toBeGreaterThan(0);
    expect(Math.abs(facing[0])).toBeGreaterThan(100 * Math.abs(edgeOn[0]) + 1e-9);
  });

  it('does not push a face already moving with the wind', () => {
    const positions = new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1]);
    const velocities = new Float32Array([3, 0, 0, 3, 0, 0, 3, 0, 0]);
    applyAerodynamics(positions, velocities, new Float32Array([1, 1, 1]), triangle, wind, 0, 0.01);
    expect(velocities[0]).toBeCloseTo(3, 9);
  });

  it('inflates along the face normal', () => {
    const velocities = push([0, 0, 0, 1, 0, 0, 0, 1, 0], { ...wind, normalDrag: 0, inflation: 1 });
    expect(velocities[2]).toBeGreaterThan(0);
  });
});
