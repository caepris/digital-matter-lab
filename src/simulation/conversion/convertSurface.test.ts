import { describe, expect, it } from 'vitest';
import { SOURCE_MESH_IDS, buildSourceMesh, type SourceMeshId } from './sourceMeshes';
import { convertSurface, type ConvertedSurface, type IndexedTriangleSurface } from './convertSurface';

const SPACING = 0.08;

function surfaceOf(mesh: IndexedTriangleSurface, targetSpacing = SPACING) {
  return convertSurface({ positions: mesh.positions, triangles: mesh.triangles, targetSpacing });
}

function triangleArea(positions: Float32Array, triangles: Uint32Array, triangle: number): number {
  const ia = triangles[triangle * 3] * 3;
  const ib = triangles[triangle * 3 + 1] * 3;
  const ic = triangles[triangle * 3 + 2] * 3;
  const bx = positions[ib] - positions[ia];
  const by = positions[ib + 1] - positions[ia + 1];
  const bz = positions[ib + 2] - positions[ia + 2];
  const cx = positions[ic] - positions[ia];
  const cy = positions[ic + 1] - positions[ia + 1];
  const cz = positions[ic + 2] - positions[ia + 2];
  const crossX = by * cz - bz * cy;
  const crossY = bz * cx - bx * cz;
  const crossZ = bx * cy - by * cx;
  return 0.5 * Math.hypot(crossX, crossY, crossZ);
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function incidence(triangles: Uint32Array): Map<string, { count: number; opposite: number[] }> {
  const edges = new Map<string, { count: number; opposite: number[] }>();
  for (let t = 0; t < triangles.length; t += 3) {
    const ids = [triangles[t], triangles[t + 1], triangles[t + 2]];
    for (let k = 0; k < 3; k++) {
      const a = ids[k];
      const b = ids[(k + 1) % 3];
      const key = pairKey(a, b);
      const entry = edges.get(key);
      if (entry) {
        entry.count++;
        entry.opposite.push(ids[(k + 2) % 3]);
      } else edges.set(key, { count: 1, opposite: [ids[(k + 2) % 3]] });
    }
  }
  return edges;
}

function pairs(packed: Uint32Array): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < packed.length; i += 2) set.add(`${packed[i]}:${packed[i + 1]}`);
  return set;
}

function boundaryLoopCount(triangles: Uint32Array): number {
  const edges = incidence(triangles);
  const neighbors = new Map<number, number[]>();
  for (const [key, edge] of edges) {
    if (edge.count !== 1) continue;
    const [a, b] = key.split(':').map(Number);
    neighbors.set(a, [...(neighbors.get(a) ?? []), b]);
    neighbors.set(b, [...(neighbors.get(b) ?? []), a]);
  }
  const seen = new Set<string>();
  let loops = 0;
  for (const start of [...neighbors.keys()].sort((a, b) => a - b)) {
    const first = (neighbors.get(start) ?? []).find((other) => !seen.has(pairKey(start, other)));
    if (first === undefined) continue;
    let previous = start;
    let current = first;
    seen.add(pairKey(start, first));
    for (let guard = 0; guard < neighbors.size + 2; guard++) {
      if (current === start) {
        loops++;
        break;
      }
      const step = (neighbors.get(current) ?? []).find((other) => other !== previous);
      if (step === undefined) break;
      seen.add(pairKey(current, step));
      previous = current;
      current = step;
    }
  }
  return loops;
}

function snapshot(surface: ConvertedSurface) {
  return {
    positions: Array.from(surface.positions),
    triangles: Array.from(surface.triangles),
    stretchPairs: Array.from(surface.stretchPairs),
    bendPairs: Array.from(surface.bendPairs),
    boundaryPairs: Array.from(surface.boundaryPairs),
    bindings: surface.sourceBindings.map((binding) => [binding.triangle, ...binding.barycentric]),
  };
}

function closestDistance2(
  x: number,
  y: number,
  z: number,
  positions: Float32Array,
  triangles: Uint32Array,
): number {
  let best = Infinity;
  for (let t = 0; t < triangles.length; t += 3) {
    const ia = triangles[t] * 3;
    const ib = triangles[t + 1] * 3;
    const ic = triangles[t + 2] * 3;
    best = Math.min(best, pointTriangleDistance2(x, y, z, positions, ia, ib, ic));
  }
  return best;
}

/** Independent closest-point distance, used to check stored barycentric bindings. */
function pointTriangleDistance2(
  px: number,
  py: number,
  pz: number,
  positions: Float32Array,
  ia: number,
  ib: number,
  ic: number,
): number {
  const ax = positions[ia];
  const ay = positions[ia + 1];
  const az = positions[ia + 2];
  const bx = positions[ib];
  const by = positions[ib + 1];
  const bz = positions[ib + 2];
  const cx = positions[ic];
  const cy = positions[ic + 1];
  const cz = positions[ic + 2];
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return norm2(px - ax, py - ay, pz - az);
  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return norm2(px - bx, py - by, pz - bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return norm2(px - (ax + abx * v), py - (ay + aby * v), pz - (az + abz * v));
  }
  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return norm2(px - cx, py - cy, pz - cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return norm2(px - (ax + acx * w), py - (ay + acy * w), pz - (az + acz * w));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return norm2(px - (bx + (cx - bx) * w), py - (by + (cy - by) * w), pz - (bz + (cz - bz) * w));
  }
  const denom = va + vb + vc;
  const v = vb / denom;
  const w = vc / denom;
  const qx = ax + abx * v + acx * w;
  const qy = ay + aby * v + acy * w;
  const qz = az + abz * v + acz * w;
  return norm2(px - qx, py - qy, pz - qz);
}

function norm2(x: number, y: number, z: number): number {
  return x * x + y * y + z * z;
}

function expectConverted(source: IndexedTriangleSurface, surface: ConvertedSurface, spacing: number): void {
  const vertexCount = surface.positions.length / 3;
  expect(vertexCount).toBeGreaterThan(3);
  expect(surface.triangles.length % 3).toBe(0);
  expect(surface.triangles.length).toBeGreaterThan(0);
  for (let i = 0; i < surface.positions.length; i++) expect(Number.isFinite(surface.positions[i])).toBe(true);
  const used = new Set<number>();
  for (let t = 0; t < surface.triangles.length; t += 3) {
    const ids = [surface.triangles[t], surface.triangles[t + 1], surface.triangles[t + 2]];
    expect(new Set(ids).size).toBe(3);
    for (const index of ids) {
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(vertexCount);
      used.add(index);
    }
    expect(triangleArea(surface.positions, surface.triangles, t / 3)).toBeGreaterThan(1e-10);
  }
  expect(used.size).toBe(vertexCount);

  const edges = incidence(surface.triangles);
  for (const edge of edges.values()) expect(edge.count).toBeLessThanOrEqual(2);

  const stretch = pairs(surface.stretchPairs);
  const bend = pairs(surface.bendPairs);
  const boundary = pairs(surface.boundaryPairs);
  expect(surface.stretchPairs.length % 2).toBe(0);
  expect(surface.bendPairs.length % 2).toBe(0);
  expect(surface.boundaryPairs.length % 2).toBe(0);
  expect(stretch.size).toBe(surface.stretchPairs.length / 2);
  expect(bend.size).toBe(surface.bendPairs.length / 2);
  expect(boundary.size).toBe(surface.boundaryPairs.length / 2);
  expect(stretch.size).toBe(edges.size);
  let interior = 0;
  for (const [key, edge] of edges) {
    const [a, b] = key.split(':').map(Number);
    expect(stretch.has(`${Math.min(a, b)}:${Math.max(a, b)}`)).toBe(true);
    if (edge.count === 1) {
      expect(boundary.has(`${Math.min(a, b)}:${Math.max(a, b)}`)).toBe(true);
    } else {
      interior++;
      const p = Math.min(edge.opposite[0], edge.opposite[1]);
      const q = Math.max(edge.opposite[0], edge.opposite[1]);
      expect(bend.has(`${p}:${q}`)).toBe(true);
      expect(boundary.has(`${Math.min(a, b)}:${Math.max(a, b)}`)).toBe(false);
    }
  }
  expect(bend.size).toBeLessThanOrEqual(interior);
  expect(bend.size).toBeGreaterThan(0);
  expect(boundary.size + interior).toBe(stretch.size);

  expect(surface.sourceBindings).toHaveLength(source.positions.length / 3);
  let maxError = 0;
  for (let i = 0; i < surface.sourceBindings.length; i++) {
    const binding = surface.sourceBindings[i];
    expect(binding.triangle).toBeGreaterThanOrEqual(0);
    expect(binding.triangle).toBeLessThan(surface.triangles.length / 3);
    const [u, v, w] = binding.barycentric;
    expect(Number.isFinite(u)).toBe(true);
    expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(w)).toBe(true);
    expect(u).toBeGreaterThanOrEqual(-1e-4);
    expect(v).toBeGreaterThanOrEqual(-1e-4);
    expect(w).toBeGreaterThanOrEqual(-1e-4);
    expect(u + v + w).toBeCloseTo(1, 5);
    const base = binding.triangle * 3;
    const ia = surface.triangles[base] * 3;
    const ib = surface.triangles[base + 1] * 3;
    const ic = surface.triangles[base + 2] * 3;
    const x = u * surface.positions[ia] + v * surface.positions[ib] + w * surface.positions[ic];
    const y = u * surface.positions[ia + 1] + v * surface.positions[ib + 1] + w * surface.positions[ic + 1];
    const z = u * surface.positions[ia + 2] + v * surface.positions[ib + 2] + w * surface.positions[ic + 2];
    const sx = source.positions[i * 3];
    const sy = source.positions[i * 3 + 1];
    const sz = source.positions[i * 3 + 2];
    const error2 = norm2(x - sx, y - sy, z - sz);
    maxError = Math.max(maxError, Math.sqrt(error2));
    const independent = closestDistance2(sx, sy, sz, surface.positions, surface.triangles);
    expect(error2).toBeCloseTo(independent, 4);
    expect(Math.sqrt(error2)).toBeLessThanOrEqual(spacing * 2);
  }
  expect(maxError).toBeLessThanOrEqual(spacing * 2);
}

describe('convertSurface', () => {
  it('welds duplicate vertices without clustering a coarse square apart', () => {
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1,
    ]);
    const triangles = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const before = positions.slice();
    const surface = convertSurface({ positions, triangles, targetSpacing: 0.01, weldEpsilon: 1e-5 });
    expect(Array.from(positions)).toEqual(Array.from(before));
    expect(surface.positions.length / 3).toBe(4);
    expect(surface.triangles.length / 3).toBe(2);
    expect(surface.bendPairs.length / 2).toBe(1);
    expect(surface.boundaryPairs.length / 2).toBe(4);
    expectConverted({ positions, triangles }, surface, 0.01);
  });

  it('drops degenerate and duplicate triangles', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]);
    const triangles = new Uint32Array([0, 0, 1, 0, 1, 2, 0, 2, 3, 0, 1, 2]);
    const surface = convertSurface({ positions, triangles, targetSpacing: 0.01 });
    expect(surface.triangles.length / 3).toBe(2);
    expect(surface.positions.length / 3).toBe(4);
  });

  it('rejects empty, non-finite, and out-of-range input', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const triangles = new Uint32Array([0, 1, 2]);
    expect(() => convertSurface({ positions, triangles, targetSpacing: 0 })).toThrow(/targetSpacing/);
    expect(() => convertSurface({ positions, triangles, targetSpacing: Number.NaN })).toThrow(/targetSpacing/);
    expect(() => convertSurface({ positions: new Float32Array([0, 0, Number.NaN]), triangles, targetSpacing: 0.1 })).toThrow(/finite/);
    expect(() => convertSurface({ positions, triangles: new Uint32Array([0, 1, 3]), targetSpacing: 0.1 })).toThrow(/out of range/);
    expect(() =>
      convertSurface({ positions: new Float32Array(0), triangles, targetSpacing: 0.1 }),
    ).toThrow(/positions/);
  });

  it('binds an off-surface source vertex to the closest triangle', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1 / 3, 1 / 3, 0.25]);
    const triangles = new Uint32Array([0, 1, 2]);
    const surface = convertSurface({ positions, triangles, targetSpacing: 0.01 });
    expect(surface.triangles.length / 3).toBe(1);
    const binding = surface.sourceBindings[3];
    expect(binding.triangle).toBe(0);
    for (const weight of binding.barycentric) expect(weight).toBeCloseTo(1 / 3, 4);
    const [u, v, w] = binding.barycentric;
    const base = binding.triangle * 3;
    const ia = surface.triangles[base] * 3;
    const ib = surface.triangles[base + 1] * 3;
    const ic = surface.triangles[base + 2] * 3;
    const x = u * surface.positions[ia] + v * surface.positions[ib] + w * surface.positions[ic];
    const y = u * surface.positions[ia + 1] + v * surface.positions[ib + 1] + w * surface.positions[ic + 1];
    const z = u * surface.positions[ia + 2] + v * surface.positions[ib + 2] + w * surface.positions[ic + 2];
    expect(Math.hypot(x - 1 / 3, y - 1 / 3, z)).toBeLessThan(1e-4);
    expect(Math.hypot(x - 1 / 3, y - 1 / 3, z - 0.25)).toBeCloseTo(0.25, 4);
  });

  it('uses a finer target spacing to keep more vertices', () => {
    const mesh = buildSourceMesh('curtain');
    const fine = surfaceOf(mesh, 0.06);
    const coarse = surfaceOf(mesh, 0.14);
    expect(fine.positions.length).toBeGreaterThan(coarse.positions.length);
    expect(coarse.positions.length).toBeLessThan(mesh.positions.length / 3);
    expect(snapshot(fine)).toEqual(snapshot(surfaceOf(mesh, 0.06)));
  });

  it('keeps the openings of an open surface', () => {
    const positions: number[] = [];
    const triangles: number[] = [];
    const n = 20;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(i / n, 0, j / n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        triangles.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
      }
    }
    const mesh = { positions: new Float32Array(positions), triangles: new Uint32Array(triangles) };
    const surface = surfaceOf(mesh, 0.12);
    expectConverted(mesh, surface, 0.12);
    expect(boundaryLoopCount(surface.triangles)).toBe(1);
  });

  it.each(SOURCE_MESH_IDS)(
    'converts %s deterministically into a closed shell that wraps the solid',
    (id: SourceMeshId) => {
      const mesh = buildSourceMesh(id);
      const copy = mesh.positions.slice();
      const surface = surfaceOf(mesh);
      expect(Array.from(mesh.positions)).toEqual(Array.from(copy));
      expect(snapshot(surface)).toEqual(snapshot(surfaceOf(mesh)));
      expect(surface.positions.length).toBeLessThan(mesh.positions.length);
      expectConverted(mesh, surface, SPACING);
      expect(surface.boundaryPairs.length).toBe(0);
      expect(boundaryLoopCount(surface.triangles)).toBe(0);
    },
    30_000,
  );
});
