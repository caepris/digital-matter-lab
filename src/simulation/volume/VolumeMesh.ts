import { CUBE_SIZE } from '../scene';
import { cubeFaceGrids, edgeKey, latticeIndex } from '../cubeLattice';
import { tetVolume } from '../xpbd/constraints';

export interface VolumeMesh {
  segments: number;
  positions: Float32Array;
  tets: Uint32Array;
  edges: Uint32Array;
  faceGrids: Uint32Array[];
}

const AXIS_PERMUTATIONS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/**
 * Fills a cube resting on y = 0 with a regular lattice split into six tetrahedra per cell
 * (Kuhn triangulation), which is conforming across neighbouring cells without alternation.
 */
export function buildVolumeMesh(segments: number, size = CUBE_SIZE): VolumeMesh {
  const n = segments;
  const spacing = size / n;
  const positions = new Float32Array((n + 1) ** 3 * 3);
  for (let iz = 0; iz <= n; iz++) {
    for (let iy = 0; iy <= n; iy++) {
      for (let ix = 0; ix <= n; ix++) {
        const o = latticeIndex(n, ix, iy, iz) * 3;
        positions[o] = ix * spacing - size / 2;
        positions[o + 1] = iy * spacing;
        positions[o + 2] = iz * spacing - size / 2;
      }
    }
  }

  const tets: number[] = [];
  const edgeSet = new Map<number, [number, number]>();
  const addEdge = (a: number, b: number) => {
    const key = edgeKey(a, b);
    if (!edgeSet.has(key)) edgeSet.set(key, [a, b]);
  };

  for (let iz = 0; iz < n; iz++) {
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        for (const permutation of AXIS_PERMUTATIONS) {
          const corner = [ix, iy, iz];
          const ids = [latticeIndex(n, ix, iy, iz)];
          for (let step = 0; step < 3; step++) {
            corner[permutation[step]]++;
            ids.push(latticeIndex(n, corner[0], corner[1], corner[2]));
          }
          if (tetVolume(positions, ids[0], ids[1], ids[2], ids[3]) < 0) [ids[1], ids[2]] = [ids[2], ids[1]];
          tets.push(...ids);
          for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) addEdge(ids[a], ids[b]);
        }
      }
    }
  }

  return {
    segments: n,
    positions,
    tets: new Uint32Array(tets),
    edges: new Uint32Array([...edgeSet.values()].flat()),
    faceGrids: cubeFaceGrids(n, (ix, iy, iz) => latticeIndex(n, ix, iy, iz)),
  };
}
