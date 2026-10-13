import { describe, expect, it } from 'vitest';
import { sectionFill, sectionFillCapacity } from './sectionFill';

function area(out: Float32Array, vertices: number): number {
  let total = 0;
  for (let v = 0; v < vertices; v += 3) {
    const [y0, z0, y1, z1, y2, z2] = [out[v * 3 + 1], out[v * 3 + 2], out[v * 3 + 4], out[v * 3 + 5], out[v * 3 + 7], out[v * 3 + 8]];
    total += Math.abs((y1 - y0) * (z2 - z0) - (y2 - y0) * (z1 - z0)) / 2;
  }
  return total;
}

describe('section fill', () => {
  // A unit square in the x-y plane, thickened by 0.1 along z.
  const outer = [0, 0, 0.1, 1, 0, 0.1, 1, 1, 0.1, 0, 1, 0.1];
  const inner = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  const positions = new Float32Array([...outer, ...inner]);
  const triangles = new Uint32Array([0, 1, 2, 0, 2, 3]);

  it('fills the wall thickness where the plane cuts the surface', () => {
    const out = new Float32Array(sectionFillCapacity(triangles.length));
    const vertices = sectionFill(positions, triangles, 4, 0.5, out);
    expect(vertices).toBeGreaterThan(0);
    expect(area(out, vertices)).toBeCloseTo(1 * 0.1, 5);
    for (let v = 0; v < vertices; v += 1) expect(out[v * 3]).toBe(0.5);
  });

  it('is empty when the plane misses the surface', () => {
    const out = new Float32Array(sectionFillCapacity(triangles.length));
    expect(sectionFill(positions, triangles, 4, 1.5, out)).toBe(0);
  });
});
