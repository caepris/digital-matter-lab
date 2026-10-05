import { describe, expect, it } from 'vitest';
import { WeldConstraints } from './weldConstraints';

describe('barycentric welds', () => {
  it('pulls rotated sample points together without changing total momentum', () => {
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0.2, 0.4, 0, 1.2, 0.4, 0, 0.2, 1.4, 0,
    ]);
    const invMass = new Float32Array([1, 1, 1, 1, 1, 1]);
    const before = positions.slice();
    const welds = new WeldConstraints([
      {
        particles: new Uint32Array([0, 1, 2, 3, 4, 5]),
        weights: new Float32Array([0.5, 0.5, 0, 0.25, 0.25, 0.5]),
      },
    ]);
    welds.solve(positions, invMass);
    expect(welds.maxSeparation(positions)).toBeLessThan(welds.maxSeparation(before));
    let momentumX = 0;
    let momentumY = 0;
    let momentumZ = 0;
    for (let i = 0; i < 6; i++) {
      momentumX += positions[i * 3] - before[i * 3];
      momentumY += positions[i * 3 + 1] - before[i * 3 + 1];
      momentumZ += positions[i * 3 + 2] - before[i * 3 + 2];
    }
    expect(momentumX).toBeCloseTo(0, 6);
    expect(momentumY).toBeCloseTo(0, 6);
    expect(momentumZ).toBeCloseTo(0, 6);
    for (let i = 0; i < 8; i++) welds.solve(positions, invMass);
    expect(welds.maxSeparation(positions)).toBeLessThan(0.001);
  });
});
