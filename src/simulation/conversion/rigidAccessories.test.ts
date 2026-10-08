import { describe, expect, it } from 'vitest';
import { RIGID_ACCESSORY_IDS, rigidAccessory } from './rigidAccessories';

describe('rigid accessory catalog', () => {
  it.each(RIGID_ACCESSORY_IDS)('%s is a finite, closed indexed mesh with mount points', (id) => {
    const preset = rigidAccessory(id);
    expect(preset.positions.length).toBeGreaterThan(9);
    expect(preset.positions.length % 3).toBe(0);
    expect(preset.triangles.length % 3).toBe(0);
    expect(preset.mountPoints.length).toBeGreaterThan(0);
    expect(Array.from(preset.positions).every(Number.isFinite)).toBe(true);
    const count = preset.positions.length / 3;
    const edges = new Map<string, number>();
    for (let i = 0; i < preset.triangles.length; i += 3) {
      const face = [preset.triangles[i], preset.triangles[i + 1], preset.triangles[i + 2]];
      expect(new Set(face).size).toBe(3);
      for (const vertex of face) expect(vertex).toBeLessThan(count);
      for (let edge = 0; edge < 3; edge++) {
        const a = face[edge];
        const b = face[(edge + 1) % 3];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    for (const uses of edges.values()) expect(uses).toBe(2);
    for (const point of preset.mountPoints) {
      expect(point[2]).toBe(0);
      expect(point.every(Number.isFinite)).toBe(true);
    }
  });
});
