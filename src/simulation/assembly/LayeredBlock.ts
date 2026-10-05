import { edgeKey } from '../cubeLattice';
import type { CompositePartTopology, WeldTopology } from '../types';
import { tetVolume } from '../xpbd/constraints';
import {
  LAYERED_BLOCK_DEFINITION,
  type AssemblyDefinition,
  type AssemblyPartDefinition,
} from './AssemblyDefinition';

const AXIS_PERMUTATIONS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

export interface LayeredBlockMesh {
  definition: AssemblyDefinition;
  positions: Float32Array;
  masses: Float32Array;
  baseParticles: Uint32Array;
  coreParticles: Uint32Array;
  clothParticles: Uint32Array;
  coreTets: Uint32Array;
  coreEdges: Uint32Array;
  clothStretchPairs: Uint32Array;
  clothBendPairs: Uint32Array;
  surfaceTriangles: Uint32Array;
  parts: CompositePartTopology[];
  welds: WeldTopology[];
}

function coordinateKey(x: number, y: number, z: number, spacing: number): string {
  return `${Math.round(x / spacing)},${Math.round(y / spacing)},${Math.round(z / spacing)}`;
}

function localIndex(nx: number, ny: number, ix: number, iy: number, iz: number): number {
  return (iz * (ny + 1) + iy) * (nx + 1) + ix;
}

function addEdge(set: Map<number, [number, number]>, a: number, b: number): void {
  const key = edgeKey(a, b);
  if (!set.has(key)) set.set(key, a < b ? [a, b] : [b, a]);
}

function pushQuad(out: number[], a: number, b: number, c: number, d: number): void {
  out.push(a, b, c, a, c, d);
}

/**
 * Builds the data-driven layered preset. Coincident nodes are interned globally, so
 * interface particles are literally the same degrees of freedom—not merely constrained
 * to remain close.
 */
export function buildLayeredBlock(
  definition: AssemblyDefinition = LAYERED_BLOCK_DEFINITION,
): LayeredBlockMesh {
  const base = definition.parts.find((part) => part.id === 'rigid-base');
  const core = definition.parts.find((part) => part.id === 'gel-core');
  const cloth = definition.parts.find((part) => part.id === 'cloth-skin');
  if (!base || !core || !cloth) throw new Error('Layered block requires rigid-base, gel-core, and cloth-skin');

  const positions: number[] = [];
  const keyToParticle = new Map<string, number>();
  const masses: number[] = [];

  const getParticle = (x: number, y: number, z: number): number => {
    const key = coordinateKey(x, y, z, definition.spacing);
    const existing = keyToParticle.get(key);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    positions.push(x, y, z);
    masses.push(0);
    keyToParticle.set(key, index);
    return index;
  };

  const createGrid = (part: AssemblyPartDefinition): Uint32Array => {
    const [nx, ny, nz] = part.grid;
    const [ox, oy, oz] = part.origin;
    const grid = new Uint32Array((nx + 1) * (ny + 1) * (nz + 1));
    const unique = new Set<number>();
    for (let iz = 0; iz <= nz; iz++) {
      for (let iy = 0; iy <= ny; iy++) {
        for (let ix = 0; ix <= nx; ix++) {
          const index = getParticle(
            ox + ix * definition.spacing,
            oy + iy * definition.spacing,
            oz + iz * definition.spacing,
          );
          grid[localIndex(nx, ny, ix, iy, iz)] = index;
          unique.add(index);
        }
      }
    }
    const contribution = part.mass / unique.size;
    for (const index of unique) masses[index] += contribution;
    return grid;
  };

  const baseGrid = createGrid(base);
  const coreGrid = createGrid(core);
  const clothGrid = createGrid(cloth);
  const [bnx, bny, bnz] = base.grid;
  const [cnx, cny, cnz] = core.grid;
  const [tnx, , tnz] = cloth.grid;
  const b = (x: number, y: number, z: number) => baseGrid[localIndex(bnx, bny, x, y, z)];
  const c = (x: number, y: number, z: number) => coreGrid[localIndex(cnx, cny, x, y, z)];
  const t = (x: number, z: number) => clothGrid[localIndex(tnx, 0, x, 0, z)];

  const baseEdges = new Map<number, [number, number]>();
  for (let iz = 0; iz <= bnz; iz++) {
    for (let iy = 0; iy <= bny; iy++) {
      for (let ix = 0; ix <= bnx; ix++) {
        if (ix < bnx) addEdge(baseEdges, b(ix, iy, iz), b(ix + 1, iy, iz));
        if (iy < bny) addEdge(baseEdges, b(ix, iy, iz), b(ix, iy + 1, iz));
        if (iz < bnz) addEdge(baseEdges, b(ix, iy, iz), b(ix, iy, iz + 1));
      }
    }
  }

  const coreTets: number[] = [];
  const coreEdges = new Map<number, [number, number]>();
  for (let iz = 0; iz < cnz; iz++) {
    for (let iy = 0; iy < cny; iy++) {
      for (let ix = 0; ix < cnx; ix++) {
        for (const permutation of AXIS_PERMUTATIONS) {
          const corner = [ix, iy, iz];
          const ids = [c(ix, iy, iz)];
          for (let step = 0; step < 3; step++) {
            corner[permutation[step]]++;
            ids.push(c(corner[0], corner[1], corner[2]));
          }
          coreTets.push(...ids);
          for (let a = 0; a < 4; a++) {
            for (let d = a + 1; d < 4; d++) addEdge(coreEdges, ids[a], ids[d]);
          }
        }
      }
    }
  }

  const clothTriangles: number[] = [];
  for (let iz = 0; iz < tnz; iz++) {
    for (let ix = 0; ix < tnx; ix++) {
      const a = t(ix, iz);
      const bb = t(ix, iz + 1);
      const cc = t(ix + 1, iz + 1);
      const d = t(ix + 1, iz);
      pushQuad(clothTriangles, a, bb, cc, d);
    }
  }
  const clothEdgeFaces = new Map<number, { edge: [number, number]; opposite: number[] }>();
  for (let i = 0; i < clothTriangles.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = clothTriangles[i + k];
      const bb = clothTriangles[i + ((k + 1) % 3)];
      const opposite = clothTriangles[i + ((k + 2) % 3)];
      const key = edgeKey(a, bb);
      const entry = clothEdgeFaces.get(key);
      if (entry) entry.opposite.push(opposite);
      else clothEdgeFaces.set(key, { edge: a < bb ? [a, bb] : [bb, a], opposite: [opposite] });
    }
  }
  const clothStretchPairs: number[] = [];
  const clothBendPairs: number[] = [];
  for (const { edge, opposite } of clothEdgeFaces.values()) {
    clothStretchPairs.push(...edge);
    if (opposite.length === 2) clothBendPairs.push(opposite[0], opposite[1]);
  }

  const baseTriangles: number[] = [];
  // x faces.
  for (let iz = 0; iz < bnz; iz++) {
    for (let iy = 0; iy < bny; iy++) {
      pushQuad(baseTriangles, b(bnx, iy, iz), b(bnx, iy + 1, iz), b(bnx, iy + 1, iz + 1), b(bnx, iy, iz + 1));
      pushQuad(baseTriangles, b(0, iy, iz), b(0, iy, iz + 1), b(0, iy + 1, iz + 1), b(0, iy + 1, iz));
    }
  }
  // z faces.
  for (let ix = 0; ix < bnx; ix++) {
    for (let iy = 0; iy < bny; iy++) {
      pushQuad(baseTriangles, b(ix, iy, bnz), b(ix + 1, iy, bnz), b(ix + 1, iy + 1, bnz), b(ix, iy + 1, bnz));
      pushQuad(baseTriangles, b(ix, iy, 0), b(ix, iy + 1, 0), b(ix + 1, iy + 1, 0), b(ix + 1, iy, 0));
    }
  }
  // Bottom and exposed top rim; the 6×6 center is the hidden base-core weld.
  for (let iz = 0; iz < bnz; iz++) {
    for (let ix = 0; ix < bnx; ix++) {
      pushQuad(baseTriangles, b(ix, 0, iz), b(ix, 0, iz + 1), b(ix + 1, 0, iz + 1), b(ix + 1, 0, iz));
      if (ix === 0 || ix === bnx - 1 || iz === 0 || iz === bnz - 1) {
        pushQuad(
          baseTriangles,
          b(ix, bny, iz),
          b(ix + 1, bny, iz),
          b(ix + 1, bny, iz + 1),
          b(ix, bny, iz + 1),
        );
      }
    }
  }

  const coreTriangles: number[] = [];
  // Only side faces are exposed: bottom is welded to the base and top is covered by cloth.
  for (let iz = 0; iz < cnz; iz++) {
    for (let iy = 0; iy < cny; iy++) {
      pushQuad(coreTriangles, c(cnx, iy, iz), c(cnx, iy + 1, iz), c(cnx, iy + 1, iz + 1), c(cnx, iy, iz + 1));
      pushQuad(coreTriangles, c(0, iy, iz), c(0, iy, iz + 1), c(0, iy + 1, iz + 1), c(0, iy + 1, iz));
    }
  }
  for (let ix = 0; ix < cnx; ix++) {
    for (let iy = 0; iy < cny; iy++) {
      pushQuad(coreTriangles, c(ix, iy, cnz), c(ix + 1, iy, cnz), c(ix + 1, iy + 1, cnz), c(ix, iy + 1, cnz));
      pushQuad(coreTriangles, c(ix, iy, 0), c(ix, iy + 1, 0), c(ix + 1, iy + 1, 0), c(ix + 1, iy, 0));
    }
  }

  const rest = new Float32Array(positions);
  for (let i = 0; i < coreTets.length; i += 4) {
    if (tetVolume(rest, coreTets[i], coreTets[i + 1], coreTets[i + 2], coreTets[i + 3]) < 0) {
      [coreTets[i + 1], coreTets[i + 2]] = [coreTets[i + 2], coreTets[i + 1]];
    }
  }

  const baseCoreWeld: number[] = [];
  for (let iz = 0; iz <= cnz; iz++) {
    for (let ix = 0; ix <= cnx; ix++) baseCoreWeld.push(c(ix, 0, iz));
  }
  const coreClothWeld: number[] = [];
  for (let iz = 0; iz <= cnz; iz++) {
    for (let ix = 0; ix <= cnx; ix++) coreClothWeld.push(c(ix, cny, iz));
  }

  const parts: CompositePartTopology[] = [
    {
      id: base.id,
      label: base.label,
      materialKind: base.materialKind,
      color: base.color,
      triangles: new Uint32Array(baseTriangles),
      structureEdges: new Uint32Array([...baseEdges.values()].flat()),
    },
    {
      id: core.id,
      label: core.label,
      materialKind: core.materialKind,
      color: core.color,
      triangles: new Uint32Array(coreTriangles),
      structureEdges: new Uint32Array([...coreEdges.values()].flat()),
    },
    {
      id: cloth.id,
      label: cloth.label,
      materialKind: cloth.materialKind,
      color: cloth.color,
      triangles: new Uint32Array(clothTriangles),
      structureEdges: new Uint32Array(clothStretchPairs),
      doubleSided: true,
    },
  ];
  const welds: WeldTopology[] = [
    {
      id: definition.welds[0].id,
      label: definition.welds[0].label,
      particleIndices: new Uint32Array(baseCoreWeld),
      color: definition.welds[0].color,
    },
    {
      id: definition.welds[1].id,
      label: definition.welds[1].label,
      particleIndices: new Uint32Array(coreClothWeld),
      color: definition.welds[1].color,
    },
  ];

  return {
    definition,
    positions: rest,
    masses: new Float32Array(masses),
    baseParticles: new Uint32Array(new Set(baseGrid)),
    coreParticles: new Uint32Array(new Set(coreGrid)),
    clothParticles: new Uint32Array(new Set(clothGrid)),
    coreTets: new Uint32Array(coreTets),
    coreEdges: new Uint32Array([...coreEdges.values()].flat()),
    clothStretchPairs: new Uint32Array(clothStretchPairs),
    clothBendPairs: new Uint32Array(clothBendPairs),
    surfaceTriangles: new Uint32Array([...baseTriangles, ...coreTriangles, ...clothTriangles]),
    parts,
    welds,
  };
}
