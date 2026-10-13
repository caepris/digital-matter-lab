import { describe, expect, it } from 'vitest';
import { minimumClearance, solveCapsuleCollisions, startInsideMasks, type CapsuleCollider } from './capsuleColliders';

const pole: CapsuleCollider = { a: [0, 0, 0], b: [0, 2, 0], radius: 0.1 };

describe('capsule colliders', () => {
  it('pushes particles out to the surface plus margin', () => {
    const positions = new Float32Array([0.05, 1, 0]);
    solveCapsuleCollisions(positions, positions.slice(), new Float32Array([1]), [pole], 0.01, 0);
    expect(positions[0]).toBeCloseTo(0.11, 5);
    expect(minimumClearance(positions, [pole])).toBeCloseTo(0.01, 5);
  });

  it('applies friction so resting cloth does not slide along the body', () => {
    const previous = new Float32Array([0.1, 1, 0]);
    const sliding = new Float32Array([0.09, 0.99, 0]);
    const frictionless = sliding.slice();
    solveCapsuleCollisions(sliding, previous, new Float32Array([1]), [pole], 0.01, 1);
    solveCapsuleCollisions(frictionless, previous, new Float32Array([1]), [pole], 0.01, 0);
    expect(Math.abs(sliding[1] - previous[1])).toBeLessThan(Math.abs(frictionless[1] - previous[1]));
  });

  it('exempts particles that start inside a collider, such as hidden geometry', () => {
    const positions = new Float32Array([0, 1, 0, 0.5, 1, 0]);
    const masks = startInsideMasks(positions, [pole], 0.01);
    expect([...masks[0]]).toEqual([1, 0]);
    solveCapsuleCollisions(positions, positions.slice(), new Float32Array([1, 1]), [pole], 0.01, 0, masks);
    expect(positions[0]).toBe(0);
  });
});
