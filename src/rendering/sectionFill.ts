/** Prism edges as pairs of corners: outer triangle, inner triangle, then the three walls. */
const PRISM_EDGES = [
  [0, 1], [1, 2], [2, 0],
  [3, 4], [4, 5], [5, 3],
  [0, 3], [1, 4], [2, 5],
] as const;

/**
 * Cross-section of a thickened surface cut by the plane x = `planeX`. Every base
 * triangle spans a prism from its outer vertex (index `v`) to its inner vertex
 * (index `count + v`); the plane cuts each prism in a convex polygon, which is
 * fanned into triangles. Writes into `out` and returns the number of vertices.
 */
export function sectionFill(
  positions: ArrayLike<number>,
  baseTriangles: ArrayLike<number>,
  count: number,
  planeX: number,
  out: Float32Array,
): number {
  const corner = new Int32Array(6);
  const distance = new Float64Array(6);
  const points: number[] = [];
  let written = 0;
  for (let face = 0; face < baseTriangles.length; face += 3) {
    let below = false;
    let above = false;
    for (let k = 0; k < 3; k += 1) {
      corner[k] = baseTriangles[face + k];
      corner[k + 3] = baseTriangles[face + k] + count;
    }
    for (let k = 0; k < 6; k += 1) {
      distance[k] = positions[corner[k] * 3] - planeX;
      if (distance[k] < 0) below = true;
      else above = true;
    }
    if (!below || !above) continue;
    points.length = 0;
    for (const [a, b] of PRISM_EDGES) {
      const da = distance[a];
      const db = distance[b];
      if (da < 0 === db < 0) continue;
      const t = da / (da - db);
      const pa = corner[a] * 3;
      const pb = corner[b] * 3;
      points.push(
        positions[pa + 1] + (positions[pb + 1] - positions[pa + 1]) * t,
        positions[pa + 2] + (positions[pb + 2] - positions[pa + 2]) * t,
      );
    }
    const n = points.length / 2;
    if (n < 3) continue;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < n; k += 1) {
      cy += points[k * 2];
      cz += points[k * 2 + 1];
    }
    cy /= n;
    cz /= n;
    const order = Array.from({ length: n }, (_, k) => k).sort(
      (i, j) =>
        Math.atan2(points[i * 2 + 1] - cz, points[i * 2] - cy) - Math.atan2(points[j * 2 + 1] - cz, points[j * 2] - cy),
    );
    for (let k = 1; k + 1 < n; k += 1) {
      if (written + 9 > out.length) return written / 3;
      for (const index of [order[0], order[k], order[k + 1]]) {
        out[written] = planeX;
        out[written + 1] = points[index * 2];
        out[written + 2] = points[index * 2 + 1];
        written += 3;
      }
    }
  }
  return written / 3;
}

/** Room for the largest possible fill: a pentagon (three triangles) per base triangle. */
export function sectionFillCapacity(baseTriangleIndexCount: number): number {
  return (baseTriangleIndexCount / 3) * 27;
}
