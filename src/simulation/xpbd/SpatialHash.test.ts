import { describe, expect, it } from 'vitest';
import { SpatialHash } from './SpatialHash';

describe('SpatialHash', () => {
  it('returns each particle once when neighboring cells collide in the hash table', () => {
    const positions = new Float32Array([0, 0, 0, 0.01, 0.01, 0.01, -0.01, 0, 0]);
    const hash = new SpatialHash(0.04, 3);
    hash.create(positions);
    hash.query(positions, 0, 0.04);
    const ids = Array.from(hash.queryIds.slice(0, hash.querySize));
    expect(ids.length).toBeLessThanOrEqual(3);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([0, 1, 2]);
  });
});
