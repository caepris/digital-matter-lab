import { describe, expect, it } from 'vitest';
import { PLATFORM_HALF } from '../scene';
import {
  SOURCE_MESH_IDS,
  buildSourceMesh,
  isSourceMeshId,
  listSourceMeshes,
  sourceMeshMetadata,
  type SourceMesh,
  type SourceMeshId,
} from './sourceMeshes';

function vertexCount(mesh: SourceMesh): number {
  return mesh.positions.length / 3;
}

function bounds(mesh: SourceMesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], mesh.positions[i + axis]);
      max[axis] = Math.max(max[axis], mesh.positions[i + axis]);
    }
  }
  return { min, max };
}

function average(mesh: SourceMesh, accept: (x: number, y: number, z: number) => boolean, axis: number): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i];
    const y = mesh.positions[i + 1];
    const z = mesh.positions[i + 2];
    if (!accept(x, y, z)) continue;
    sum += axis === 0 ? x : axis === 1 ? y : z;
    count++;
  }
  return sum / count;
}

function triangleArea(mesh: SourceMesh, triangle: number): number {
  const positions = mesh.positions;
  const triangles = mesh.triangles;
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

function maxEdgeIncidence(mesh: SourceMesh): number {
  const counts = new Map<string, number>();
  const { triangles } = mesh;
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let max = 0;
  for (const count of counts.values()) max = Math.max(max, count);
  return max;
}

function boundaryLoopCount(mesh: SourceMesh): number {
  const neighbors = new Map<number, number[]>();
  const counts = new Map<string, number>();
  const { triangles } = mesh;
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of counts) {
    if (count !== 1) continue;
    const [a, b] = key.split(':').map(Number);
    neighbors.set(a, [...(neighbors.get(a) ?? []), b]);
    neighbors.set(b, [...(neighbors.get(b) ?? []), a]);
  }
  const seen = new Set<string>();
  let loops = 0;
  for (const start of [...neighbors.keys()].sort((a, b) => a - b)) {
    const next = (neighbors.get(start) ?? []).find((other) => !seen.has(start < other ? `${start}:${other}` : `${other}:${start}`));
    if (next === undefined) continue;
    let previous = start;
    let current = next;
    seen.add(start < next ? `${start}:${next}` : `${next}:${start}`);
    for (let guard = 0; guard < neighbors.size + 2; guard++) {
      if (current === start) {
        loops++;
        break;
      }
      const step = (neighbors.get(current) ?? []).find((other) => other !== previous);
      if (step === undefined) break;
      seen.add(current < step ? `${current}:${step}` : `${step}:${current}`);
      previous = current;
      current = step;
    }
  }
  return loops;
}

function expectSurface(mesh: SourceMesh): void {
  expect(mesh.positions.length).toBeGreaterThan(0);
  expect(mesh.positions.length % 3).toBe(0);
  expect(mesh.triangles.length % 3).toBe(0);
  expect(vertexCount(mesh)).toBeGreaterThan(800);
  expect(mesh.triangles.length / 3).toBeGreaterThan(1500);
  const count = vertexCount(mesh);
  for (let i = 0; i < mesh.positions.length; i++) expect(Number.isFinite(mesh.positions[i])).toBe(true);
  const used = new Set<number>();
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const ids = [mesh.triangles[t], mesh.triangles[t + 1], mesh.triangles[t + 2]];
    expect(new Set(ids).size).toBe(3);
    for (const index of ids) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(count);
      used.add(index);
    }
    expect(triangleArea(mesh, t / 3)).toBeGreaterThan(1e-8);
  }
  expect(used.size).toBe(count);
  expect(maxEdgeIncidence(mesh)).toBeLessThanOrEqual(2);
  const box = bounds(mesh);
  expect((box.min[0] + box.max[0]) / 2).toBeCloseTo(0, 5);
  expect((box.min[2] + box.max[2]) / 2).toBeCloseTo(0, 5);
  expect(box.min[1]).toBeGreaterThanOrEqual(0);
  expect(box.min[1]).toBeLessThan(0.05);
  expect(Math.abs(box.min[0])).toBeLessThanOrEqual(PLATFORM_HALF);
  expect(box.max[0]).toBeLessThanOrEqual(PLATFORM_HALF);
  expect(Math.abs(box.min[2])).toBeLessThanOrEqual(PLATFORM_HALF);
  expect(box.max[2]).toBeLessThanOrEqual(PLATFORM_HALF);
}

describe('source mesh catalog', () => {
  it('lists tshirt, curtain, and car-shell with display metadata', () => {
    expect(listSourceMeshes().map((entry) => entry.id)).toEqual([...SOURCE_MESH_IDS]);
    const colors = new Set<number>();
    for (const id of SOURCE_MESH_IDS) {
      expect(isSourceMeshId(id)).toBe(true);
      const metadata = sourceMeshMetadata(id);
      expect(metadata.id).toBe(id);
      expect(metadata.label.length).toBeGreaterThan(0);
      expect(metadata.description.length).toBeGreaterThan(0);
      expect(Number.isInteger(metadata.color)).toBe(true);
      expect(metadata.color).toBeGreaterThan(0);
      expect(metadata.defaultThickness).toBeGreaterThan(0);
      expect(metadata.defaultThickness).toBeLessThan(0.05);
      colors.add(metadata.color);
    }
    expect(colors.size).toBe(SOURCE_MESH_IDS.length);
    expect(isSourceMeshId('cube')).toBe(false);
    expect(() => sourceMeshMetadata('cube' as SourceMeshId)).toThrow(/Unknown source mesh/);
    expect(() => buildSourceMesh('cube' as SourceMeshId)).toThrow(/Unknown source mesh/);
  });
});

describe('procedural source meshes', () => {
  it.each(SOURCE_MESH_IDS)('%s is a finite, indexed, nondegenerate surface centered on the platform', (id) => {
    const mesh = buildSourceMesh(id);
    expect(mesh.id).toBe(id);
    expectSurface(mesh);
    const again = buildSourceMesh(id);
    expect(Array.from(again.positions)).toEqual(Array.from(mesh.positions));
    expect(Array.from(again.triangles)).toEqual(Array.from(mesh.triangles));
  });

  it('builds a wide shirt with sleeves, a drooping cuff, and a neck opening', () => {
    const mesh = buildSourceMesh('tshirt');
    const box = bounds(mesh);
    expect(box.max[0] - box.min[0]).toBeGreaterThan(box.max[2] - box.min[2]);
    expect(box.max[0] - box.min[0]).toBeGreaterThan(1.4);
    expect(boundaryLoopCount(mesh)).toBe(2);
    const cuffY = average(mesh, (x) => Math.abs(x) > 0.7, 1);
    const shoulderY = average(mesh, (x, _y, z) => Math.abs(x) < 0.12 && z > box.max[2] - 0.12, 1);
    expect(cuffY).toBeLessThan(shoulderY - 0.04);
  });

  it('builds a tall curtain with a gathered top and deeper folds at the hem', () => {
    const mesh = buildSourceMesh('curtain');
    const box = bounds(mesh);
    const height = box.max[1] - box.min[1];
    expect(height).toBeGreaterThan(1.2);
    expect(height).toBeGreaterThan(box.max[2] - box.min[2]);
    expect(boundaryLoopCount(mesh)).toBe(1);
    const hemZ = average(mesh, (_x, y) => y < box.min[1] + height * 0.15, 2);
    const topZ = average(mesh, (_x, y) => y > box.max[1] - height * 0.15, 2);
    expect(Math.abs(hemZ)).toBeLessThan(0.05);
    expect(Math.abs(topZ)).toBeLessThan(0.05);
    let hemSpan = 0;
    let topSpan = 0;
    let hemWidth = 0;
    let topWidth = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const y = mesh.positions[i + 1];
      const z = mesh.positions[i + 2];
      const x = Math.abs(mesh.positions[i]);
      if (y < box.min[1] + height * 0.15) {
        hemSpan = Math.max(hemSpan, Math.abs(z));
        hemWidth = Math.max(hemWidth, x);
      }
      if (y > box.max[1] - height * 0.15) {
        topSpan = Math.max(topSpan, Math.abs(z));
        topWidth = Math.max(topWidth, x);
      }
    }
    expect(hemSpan).toBeGreaterThan(topSpan * 2);
    expect(hemWidth).toBeGreaterThan(topWidth + 0.2);
  });

  it('builds a long car body with a raised cabin and wheel-arch holes', () => {
    const mesh = buildSourceMesh('car-shell');
    const box = bounds(mesh);
    const length = box.max[0] - box.min[0];
    const width = box.max[2] - box.min[2];
    const height = box.max[1] - box.min[1];
    expect(length).toBeGreaterThan(width);
    expect(width).toBeGreaterThan(height);
    expect(length).toBeGreaterThan(2);
    expect(boundaryLoopCount(mesh)).toBe(5);
    const cabinY = average(mesh, (x) => Math.abs(x) < 0.2, 1);
    const noseY = average(mesh, (x) => x > 0.9, 1);
    const tailY = average(mesh, (x) => x < -0.9, 1);
    expect(cabinY).toBeGreaterThan(noseY + 0.2);
    expect(cabinY).toBeGreaterThan(tailY + 0.15);
  });
});
