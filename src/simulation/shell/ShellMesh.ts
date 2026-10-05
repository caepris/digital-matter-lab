import { CUBE_SIZE } from '../scene';
import { cubeFaceGrids, edgeKey, latticeIndex, triangulateFaceGrid } from '../cubeLattice';

export interface ShellMesh {
  segments: number;
  positions: Float32Array;
  triangles: Uint32Array;
  /** Triangle edges; resist stretching and shearing. */
  stretchPairs: Uint32Array;
  /** Vertices opposite each shared edge; their distance resists folding, including across the cube's edges. */
  bendPairs: Uint32Array;
  faceGrids: Uint32Array[];
}

/**
 * Builds a closed, hollow cube surface: only lattice nodes on the boundary become
 * particles, so neighbouring faces share (are stitched along) their edge particles.
 */
export function buildShellMesh(segments: number, size = CUBE_SIZE, lift = 0): ShellMesh {
  const n = segments;
  const spacing = size / n;
  const particleOf = new Int32Array((n + 1) ** 3).fill(-1);
  const coords: number[] = [];
  for (let iz = 0; iz <= n; iz++) {
    for (let iy = 0; iy <= n; iy++) {
      for (let ix = 0; ix <= n; ix++) {
        const onBoundary = ix === 0 || iy === 0 || iz === 0 || ix === n || iy === n || iz === n;
        if (!onBoundary) continue;
        particleOf[latticeIndex(n, ix, iy, iz)] = coords.length / 3;
        coords.push(ix * spacing - size / 2, iy * spacing + lift, iz * spacing - size / 2);
      }
    }
  }

  const faceGrids = cubeFaceGrids(n, (ix, iy, iz) => particleOf[latticeIndex(n, ix, iy, iz)]);
  const triangles: number[] = [];
  for (const grid of faceGrids) triangulateFaceGrid(grid, n, triangles);

  const edgeOpposites = new Map<number, { a: number; b: number; opposite: number[] }>();
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      const opposite = triangles[t + ((k + 2) % 3)];
      const key = edgeKey(a, b);
      const entry = edgeOpposites.get(key);
      if (entry) entry.opposite.push(opposite);
      else edgeOpposites.set(key, { a, b, opposite: [opposite] });
    }
  }

  const stretchPairs: number[] = [];
  const bendPairs: number[] = [];
  for (const { a, b, opposite } of edgeOpposites.values()) {
    stretchPairs.push(a, b);
    if (opposite.length === 2) bendPairs.push(opposite[0], opposite[1]);
  }

  return {
    segments: n,
    positions: new Float32Array(coords),
    triangles: new Uint32Array(triangles),
    stretchPairs: new Uint32Array(stretchPairs),
    bendPairs: new Uint32Array(bendPairs),
    faceGrids,
  };
}
