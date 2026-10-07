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

function component(mesh: SourceMesh, axis: number, accept: (other: number) => boolean, by: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    if (accept(mesh.positions[i + by])) out.push(Math.abs(mesh.positions[i + axis]));
  }
  return out;
}

const xs = (mesh: SourceMesh, acceptY: (y: number) => boolean) => component(mesh, 0, acceptY, 1);
const zs = (mesh: SourceMesh, acceptY: (y: number) => boolean) => component(mesh, 2, acceptY, 1);
const ys = (mesh: SourceMesh, acceptX: (x: number) => boolean) => component(mesh, 1, acceptX, 0);

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

/** Oriented edge counts; a closed, consistently wound surface uses each directed edge exactly once. */
function directedEdges(mesh: SourceMesh): Map<string, number> {
  const counts = new Map<string, number>();
  const { triangles } = mesh;
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const key = `${triangles[t + k]}>${triangles[t + ((k + 1) % 3)]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function signedVolume(mesh: SourceMesh): number {
  const p = mesh.positions;
  const t = mesh.triangles;
  let volume = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3;
    const b = t[i + 1] * 3;
    const c = t[i + 2] * 3;
    volume +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6;
  }
  return volume;
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
  const edges = directedEdges(mesh);
  for (const [key, uses] of edges) {
    expect(uses).toBe(1);
    const [a, b] = key.split('>');
    expect(edges.get(`${b}>${a}`)).toBe(1);
  }
  expect(signedVolume(mesh)).toBeGreaterThan(0.005);
  const box = bounds(mesh);
  expect((box.min[0] + box.max[0]) / 2).toBeCloseTo(0, 5);
  expect((box.min[2] + box.max[2]) / 2).toBeCloseTo(0, 5);
  expect(box.min[1]).toBeGreaterThan(0);
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

  it('builds an upright shirt with sleeves wider than the hem and a scooped neck', () => {
    const mesh = buildSourceMesh('tshirt');
    const box = bounds(mesh);
    const height = box.max[1] - box.min[1];
    const depth = box.max[2] - box.min[2];
    expect(height).toBeGreaterThan(0.9);
    expect(height).toBeGreaterThan(depth * 3);
    const hemWidth = 2 * Math.max(...xs(mesh, (y) => y < box.min[1] + 0.05));
    const sleeveWidth = box.max[0] - box.min[0];
    expect(sleeveWidth).toBeGreaterThan(hemWidth * 1.8);
    const cuffY = average(mesh, (x) => Math.abs(x) > 0.55, 1);
    expect(cuffY).toBeGreaterThan(box.min[1] + height * 0.5);
    const neckTop = Math.max(...ys(mesh, (x) => Math.abs(x) < 0.03));
    expect(neckTop).toBeLessThan(box.max[1] - 0.05);
    expect(mesh.pinRegion).not.toBeNull();
    expect(mesh.supports.length).toBeGreaterThan(0);
  });

  it('builds a tall pleated curtain hanging from a rod', () => {
    const mesh = buildSourceMesh('curtain');
    const box = bounds(mesh);
    const height = box.max[1] - box.min[1];
    expect(height).toBeGreaterThan(1.2);
    expect(height).toBeGreaterThan((box.max[2] - box.min[2]) * 4);
    const hemSpan = Math.max(...zs(mesh, (y) => y < box.min[1] + height * 0.1));
    const topSpan = Math.max(...zs(mesh, (y) => y > box.max[1] - height * 0.1));
    expect(hemSpan).toBeGreaterThan(topSpan);
    const rod = mesh.supports[0];
    expect(rod.from[1]).toBeGreaterThan(box.max[1]);
    expect(mesh.pinRegion?.minY).toBeLessThan(box.max[1]);
  });

  it('builds a long car body with a raised cabin and wheel arches', () => {
    const mesh = buildSourceMesh('car-shell');
    const box = bounds(mesh);
    const length = box.max[0] - box.min[0];
    const width = box.max[2] - box.min[2];
    const height = box.max[1] - box.min[1];
    expect(length).toBeGreaterThan(width);
    expect(width).toBeGreaterThan(height);
    expect(length).toBeGreaterThan(2);
    const cabinY = Math.max(...ys(mesh, (x) => Math.abs(x) < 0.2));
    const noseY = Math.max(...ys(mesh, (x) => x > 0.9));
    expect(cabinY).toBeGreaterThan(noseY + 0.2);
    const archBottom = Math.min(...ys(mesh, (x) => Math.abs(Math.abs(x) - 0.7) < 0.03));
    expect(archBottom).toBeGreaterThan(box.min[1] + 0.15);
    expect(mesh.pinRegion).toBeNull();
  });
});
