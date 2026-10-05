import { edgeKey, latticeIndex } from '../cubeLattice';
import { tetVolume } from '../xpbd/constraints';
import { buildVolumeMesh } from '../volume/VolumeMesh';

export const CUBE_SEGMENTS = 4;
export const SHEET_SEGMENTS = 6;

export interface LocalMesh {
  shape: 'cube' | 'sheet';
  segments: number;
  positions: Float32Array;
  triangles: Uint32Array;
  edges: Uint32Array;
  tets: Uint32Array | null;
  stretchPairs: Uint32Array | null;
  bendPairs: Uint32Array | null;
  surfaceParticles: Uint32Array;
}

const cubeMesh = buildCube();
const sheetMesh = buildSheet();

export function localMesh(shape: 'cube' | 'sheet'): LocalMesh {
  return shape === 'cube' ? cubeMesh : sheetMesh;
}

export function triangleCount(shape: 'cube' | 'sheet'): number {
  return localMesh(shape).triangles.length / 3;
}

function buildCube(): LocalMesh {
  const mesh = buildVolumeMesh(CUBE_SEGMENTS, 1);
  const n = CUBE_SEGMENTS;
  const surface: number[] = [];
  for (let iz = 0; iz <= n; iz++) {
    for (let iy = 0; iy <= n; iy++) {
      for (let ix = 0; ix <= n; ix++) {
        if (ix === 0 || iy === 0 || iz === 0 || ix === n || iy === n || iz === n) {
          surface.push(latticeIndex(n, ix, iy, iz));
        }
      }
    }
  }
  const triangles: number[] = [];
  for (const grid of mesh.faceGrids) {
    for (let iv = 0; iv < n; iv++) {
      for (let iu = 0; iu < n; iu++) {
        const a = grid[iv * (n + 1) + iu];
        const b = grid[iv * (n + 1) + iu + 1];
        const c = grid[(iv + 1) * (n + 1) + iu + 1];
        const d = grid[(iv + 1) * (n + 1) + iu];
        triangles.push(a, b, c, a, c, d);
      }
    }
  }
  const local: LocalMesh = {
    shape: 'cube',
    segments: n,
    positions: mesh.positions,
    triangles: new Uint32Array(triangles),
    edges: mesh.edges,
    tets: mesh.tets,
    stretchPairs: null,
    bendPairs: null,
    surfaceParticles: new Uint32Array(surface),
  };
  assertPositiveTets(local);
  return local;
}

function buildSheet(): LocalMesh {
  const n = SHEET_SEGMENTS;
  const spacing = 1 / n;
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  const index = (ix: number, iz: number) => iz * (n + 1) + ix;
  for (let iz = 0; iz <= n; iz++) {
    for (let ix = 0; ix <= n; ix++) {
      const o = index(ix, iz) * 3;
      positions[o] = ix * spacing - 0.5;
      positions[o + 1] = 0;
      positions[o + 2] = iz * spacing - 0.5;
    }
  }
  const triangles: number[] = [];
  const edgeFaces = new Map<number, { edge: [number, number]; opposite: number[] }>();
  const push = (a: number, b: number, c: number) => {
    triangles.push(a, b, c);
    const ids = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const u = ids[k];
      const v = ids[(k + 1) % 3];
      const opposite = ids[(k + 2) % 3];
      const key = edgeKey(u, v);
      const entry = edgeFaces.get(key);
      if (entry) entry.opposite.push(opposite);
      else edgeFaces.set(key, { edge: u < v ? [u, v] : [v, u], opposite: [opposite] });
    }
  };
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const a = index(ix, iz);
      const b = index(ix + 1, iz);
      const c = index(ix + 1, iz + 1);
      const d = index(ix, iz + 1);
      push(a, b, c);
      push(a, c, d);
    }
  }
  const stretch: number[] = [];
  const bend: number[] = [];
  for (const { edge, opposite } of edgeFaces.values()) {
    stretch.push(edge[0], edge[1]);
    if (opposite.length === 2) bend.push(opposite[0], opposite[1]);
  }
  return {
    shape: 'sheet',
    segments: n,
    positions,
    triangles: new Uint32Array(triangles),
    edges: new Uint32Array(stretch),
    tets: null,
    stretchPairs: new Uint32Array(stretch),
    bendPairs: new Uint32Array(bend),
    surfaceParticles: Uint32Array.from({ length: (n + 1) * (n + 1) }, (_, i) => i),
  };
}

/** Guards against inverted tets if a caller rebuilds a cube. */
export function assertPositiveTets(mesh: LocalMesh): void {
  if (!mesh.tets) return;
  for (let i = 0; i < mesh.tets.length; i += 4) {
    if (tetVolume(mesh.positions, mesh.tets[i], mesh.tets[i + 1], mesh.tets[i + 2], mesh.tets[i + 3]) <= 0) {
      throw new Error('Cube lattice produced an inverted tetrahedron');
    }
  }
}
