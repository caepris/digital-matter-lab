import { describe, expect, it } from 'vitest';
import { clampToPlatform, DROP_HEIGHT, IMPACTOR_RADIUS, PLATFORM_HALF, spawnHeight } from './scene';

describe('impactor spawning', () => {
  it('uses the drop height when the spawn point is clear', () => {
    expect(spawnHeight(0, 0, [{ x: 0, y: 1.2, z: 0 }])).toBe(DROP_HEIGHT);
  });

  it('stacks rapid drops above balls that have not fallen yet', () => {
    const first = { x: 0, y: DROP_HEIGHT, z: 0 };
    const secondY = spawnHeight(0.05, 0, [first]);
    expect(secondY).toBeGreaterThan(DROP_HEIGHT + IMPACTOR_RADIUS * 2 - 1e-9);
    const thirdY = spawnHeight(0, 0.05, [first, { x: 0.05, y: secondY, z: 0 }]);
    expect(thirdY).toBeGreaterThan(secondY + IMPACTOR_RADIUS * 2 - 1e-9);
  });

  it('keeps drop targets on the platform', () => {
    expect(clampToPlatform(10)).toBeCloseTo(PLATFORM_HALF - IMPACTOR_RADIUS);
    expect(clampToPlatform(-10)).toBeCloseTo(-(PLATFORM_HALF - IMPACTOR_RADIUS));
    expect(clampToPlatform(0.3)).toBe(0.3);
  });
});
