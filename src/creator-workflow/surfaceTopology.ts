/**
 * Topology helpers for render surfaces whose UV seams and cap borders duplicate
 * vertices at the same position.
 */

/**
 * Maps every vertex to a canonical vertex sharing its position. When `regions`
 * is given, vertices only merge within the same region so cap creases survive.
 */
export function weldMap(positions: Float32Array, regions?: ArrayLike<number>, epsilon = 1e-4): Uint32Array {
  const count = positions.length / 3;
  const canonical = new Uint32Array(count);
  const seen = new Map<string, number>();
  const scale = 1 / epsilon;
  for (let index = 0; index < count; index += 1) {
    const key = `${Math.round(positions[index * 3] * scale)},${Math.round(positions[index * 3 + 1] * scale)},${Math.round(
      positions[index * 3 + 2] * scale,
    )}${regions ? `:${regions[index]}` : ''}`;
    const found = seen.get(key);
    if (found === undefined) {
      seen.set(key, index);
      canonical[index] = index;
    } else {
      canonical[index] = found;
    }
  }
  return canonical;
}

/** Edges used by exactly one triangle, measured on welded topology but returned as original indices. */
export function boundaryEdges(triangles: ArrayLike<number>, canonical?: ArrayLike<number>): [number, number][] {
  const edges = new Map<string, { a: number; b: number; count: number }>();
  const id = (vertex: number) => (canonical ? canonical[vertex] : vertex);
  const add = (a: number, b: number): void => {
    const ca = id(a);
    const cb = id(b);
    const key = ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`;
    const entry = edges.get(key);
    if (entry) entry.count += 1;
    else edges.set(key, { a, b, count: 1 });
  };
  for (let index = 0; index < triangles.length; index += 3) {
    add(triangles[index], triangles[index + 1]);
    add(triangles[index + 1], triangles[index + 2]);
    add(triangles[index + 2], triangles[index]);
  }
  return [...edges.values()].filter((edge) => edge.count === 1).map(({ a, b }) => [a, b]);
}

/** Area-weighted vertex normals, shared across welded duplicates. */
export function smoothNormals(
  positions: ArrayLike<number>,
  triangles: ArrayLike<number>,
  canonical: ArrayLike<number>,
  out: Float32Array = new Float32Array(positions.length),
): Float32Array {
  out.fill(0);
  for (let index = 0; index < triangles.length; index += 3) {
    const a = triangles[index];
    const b = triangles[index + 1];
    const c = triangles[index + 2];
    const abx = positions[b * 3] - positions[a * 3];
    const aby = positions[b * 3 + 1] - positions[a * 3 + 1];
    const abz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const acx = positions[c * 3] - positions[a * 3];
    const acy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const acz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const vertex of [a, b, c]) {
      const target = canonical[vertex] * 3;
      out[target] += nx;
      out[target + 1] += ny;
      out[target + 2] += nz;
    }
  }
  const count = positions.length / 3;
  for (let index = 0; index < count; index += 1) {
    const source = canonical[index] * 3;
    const length = Math.hypot(out[source], out[source + 1], out[source + 2]) || 1;
    if (source === index * 3) continue;
    out[index * 3] = out[source] / length;
    out[index * 3 + 1] = out[source + 1] / length;
    out[index * 3 + 2] = out[source + 2] / length;
  }
  for (let index = 0; index < count; index += 1) {
    if (canonical[index] !== index) continue;
    const length = Math.hypot(out[index * 3], out[index * 3 + 1], out[index * 3 + 2]) || 1;
    out[index * 3] /= length;
    out[index * 3 + 1] /= length;
    out[index * 3 + 2] /= length;
  }
  return out;
}

/** Connected component id per vertex (vertices outside every triangle get their own component). */
export function vertexComponents(vertexCount: number, triangles: ArrayLike<number>): Int32Array {
  const parent = Int32Array.from({ length: vertexCount }, (_, index) => index);
  const find = (vertex: number): number => {
    while (parent[vertex] !== vertex) {
      parent[vertex] = parent[parent[vertex]];
      vertex = parent[vertex];
    }
    return vertex;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let index = 0; index < triangles.length; index += 3) {
    union(triangles[index], triangles[index + 1]);
    union(triangles[index + 1], triangles[index + 2]);
  }
  const components = new Int32Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) components[index] = find(index);
  return components;
}
