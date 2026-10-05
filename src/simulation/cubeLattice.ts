/**
 * Cube faces described by a fixed axis and two in-plane axes chosen so that u x v points outward.
 * Axes: 0 = x, 1 = y, 2 = z.
 */
const FACES: { axis: number; side: 0 | 1; u: number; v: number }[] = [
  { axis: 0, side: 1, u: 1, v: 2 },
  { axis: 0, side: 0, u: 2, v: 1 },
  { axis: 1, side: 1, u: 2, v: 0 },
  { axis: 1, side: 0, u: 0, v: 2 },
  { axis: 2, side: 1, u: 0, v: 1 },
  { axis: 2, side: 0, u: 1, v: 0 },
];

export function latticeIndex(n: number, ix: number, iy: number, iz: number): number {
  return (iz * (n + 1) + iy) * (n + 1) + ix;
}

/** Returns six (n+1)^2 grids (row-major in u, then v) of indices produced by `nodeIndex`. */
export function cubeFaceGrids(
  n: number,
  nodeIndex: (ix: number, iy: number, iz: number) => number,
): Uint32Array[] {
  return FACES.map(({ axis, side, u, v }) => {
    const grid = new Uint32Array((n + 1) * (n + 1));
    const coord = [0, 0, 0];
    for (let iv = 0; iv <= n; iv++) {
      for (let iu = 0; iu <= n; iu++) {
        coord[axis] = side * n;
        coord[u] = iu;
        coord[v] = iv;
        grid[iv * (n + 1) + iu] = nodeIndex(coord[0], coord[1], coord[2]);
      }
    }
    return grid;
  });
}

/** Triangulates a face grid with alternating diagonals, preserving the grid's outward winding. */
export function triangulateFaceGrid(grid: Uint32Array, n: number, out: number[] = []): number[] {
  for (let iv = 0; iv < n; iv++) {
    for (let iu = 0; iu < n; iu++) {
      const a = grid[iv * (n + 1) + iu];
      const b = grid[iv * (n + 1) + iu + 1];
      const c = grid[(iv + 1) * (n + 1) + iu + 1];
      const d = grid[(iv + 1) * (n + 1) + iu];
      if ((iu + iv) % 2 === 0) {
        out.push(a, b, c, a, c, d);
      } else {
        out.push(a, b, d, b, c, d);
      }
    }
  }
  return out;
}

export function edgeKey(a: number, b: number): number {
  return a < b ? a * 1_000_003 + b : b * 1_000_003 + a;
}
