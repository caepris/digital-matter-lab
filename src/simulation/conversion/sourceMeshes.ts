import { PLATFORM_HALF } from '../scene';

/** Procedural rigid source solids. Ids are stable preset keys. */
export const SOURCE_MESH_IDS = ['tshirt', 'curtain', 'car-shell'] as const;

export type SourceMeshId = (typeof SOURCE_MESH_IDS)[number];

export interface SourceMeshMetadata {
  id: SourceMeshId;
  label: string;
  description: string;
  /** sRGB hex, matching material presets. */
  color: number;
  /** Default thickness of the generated thin shell, in metres. */
  defaultThickness: number;
}

/** A straight support member, such as a hanger arm or curtain rod. */
export interface SupportSegment {
  from: readonly [number, number, number];
  to: readonly [number, number, number];
  radius: number;
}

/** Closed, upright triangle surface of a rigid solid sitting over the platform. */
export interface SourceMesh extends SourceMeshMetadata {
  positions: Float32Array;
  triangles: Uint32Array;
  /** Generated shell particles inside this region hang from the supports instead of falling. */
  pinRegion: { minY: number; halfWidth: number } | null;
  supports: SupportSegment[];
}

const METADATA: Record<SourceMeshId, Omit<SourceMeshMetadata, 'id'>> = {
  tshirt: {
    label: 'T-shirt',
    description: 'Upright rigid T-shirt on a hanger, with a torso, short sleeves, and a scooped neck.',
    color: 0x3e7cb1,
    defaultThickness: 0.006,
  },
  curtain: {
    label: 'Curtain',
    description: 'Upright rigid curtain on a rod, with deep pleats that widen toward the hem.',
    color: 0xc4a574,
    defaultThickness: 0.005,
  },
  'car-shell': {
    label: 'Car shell',
    description: 'Rigid car body with a hood, cabin, trunk, and wheel arches.',
    color: 0xb23a2f,
    defaultThickness: 0.015,
  },
};

export function isSourceMeshId(id: string): id is SourceMeshId {
  return (SOURCE_MESH_IDS as readonly string[]).includes(id);
}

export function sourceMeshMetadata(id: SourceMeshId): SourceMeshMetadata {
  const metadata = METADATA[id];
  if (!metadata) throw new Error(`Unknown source mesh "${id}"`);
  return { id, ...metadata };
}

export function listSourceMeshes(): SourceMeshMetadata[] {
  return SOURCE_MESH_IDS.map((id) => sourceMeshMetadata(id));
}

export function buildSourceMesh(id: SourceMeshId): SourceMesh {
  const metadata = sourceMeshMetadata(id);
  const design = id === 'tshirt' ? tshirt() : id === 'curtain' ? curtain() : carShell();
  const built = buildSolid(design.solid);
  const [sx, sy, sz] = placeOverPlatform(built.positions, design.floor);
  return {
    ...metadata,
    positions: new Float32Array(built.positions),
    triangles: new Uint32Array(built.triangles),
    pinRegion: design.pinRegion ? { minY: design.pinRegion.minY + sy, halfWidth: design.pinRegion.halfWidth } : null,
    supports: design.supports.map((segment) => ({
      from: [segment.from[0] + sx, segment.from[1] + sy, segment.from[2] + sz],
      to: [segment.to[0] + sx, segment.to[1] + sy, segment.to[2] + sz],
      radius: segment.radius,
    })),
  };
}

/** Indices of shell particles inside the source's pin region, which hang from its hanger or rod. */
export function pinnedParticles(source: SourceMesh, positions: Float32Array): number[] {
  const region = source.pinRegion;
  if (!region) return [];
  const pinned: number[] = [];
  for (let i = 0; i < positions.length / 3; i++) {
    if (positions[i * 3 + 1] >= region.minY && Math.abs(positions[i * 3]) <= region.halfWidth) pinned.push(i);
  }
  return pinned;
}

interface BuiltMesh {
  positions: number[];
  triangles: number[];
}

/**
 * An upright solid described by its silhouette in the x-y plane. The front and back
 * surfaces bulge out of a (possibly folded) mid-surface and meet along the silhouette,
 * so the result is one closed surface with no openings.
 */
interface SolidSpec {
  bounds: [number, number, number, number];
  cell: number;
  /** Signed distance to the silhouette; negative inside. */
  sdf(x: number, y: number): number;
  /** Half the solid's depth well inside the silhouette. */
  halfDepth(x: number, y: number): number;
  /** Distance from the silhouette over which the depth rounds off to zero. */
  round: number;
  /** Lower values give boxier edges; 0.5 gives a round pillow. */
  profile: number;
  /** Mid-surface depth offset, e.g. curtain pleats. */
  midZ?(x: number, y: number): number;
}

interface Design {
  solid: SolidSpec;
  floor: number;
  pinRegion: { minY: number; halfWidth: number } | null;
  supports: SupportSegment[];
}

function tshirt(): Design {
  const torso: Point[] = [
    [-0.3, 0],
    [0.3, 0],
    [0.29, 0.66],
    [0.31, 0.93],
    [0.12, 1],
    [-0.12, 1],
    [-0.31, 0.93],
    [-0.29, 0.66],
  ];
  const rightSleeve: Point[] = [
    [0.24, 0.97],
    [0.62, 0.74],
    [0.52, 0.56],
    [0.27, 0.66],
  ];
  const leftSleeve = rightSleeve.map(([x, y]) => [-x, y] as Point);
  const sdf = (x: number, y: number) => {
    const body = polygonSdf(x, y, torso) - 0.02;
    const sleeves = Math.min(polygonSdf(x, y, rightSleeve), polygonSdf(x, y, leftSleeve)) - 0.02;
    const neck = Math.hypot(x, y - 1.06) - 0.14;
    return Math.max(smoothMin(body, sleeves, 0.05), -neck);
  };
  return {
    solid: {
      bounds: [-0.7, 0.68, -0.05, 1.06],
      cell: 0.018,
      sdf,
      halfDepth: (x, y) => {
        const sleeve = y > 0.5 ? smoothstep(0.27, 0.36, Math.abs(x)) : 0;
        const chest = 0.1 + 0.015 * Math.sin((Math.PI * Math.min(1, y)) / 1);
        return chest + (0.06 - chest) * sleeve;
      },
      round: 0.07,
      profile: 0.5,
      midZ: (x, y) => 0.004 * Math.sin(x * 14) * Math.sin(y * 9),
    },
    floor: 0.42,
    pinRegion: { minY: 0.88, halfWidth: 0.33 },
    supports: [
      { from: [-0.3, 0.9, 0], to: [0, 0.99, 0], radius: 0.01 },
      { from: [0.3, 0.9, 0], to: [0, 0.99, 0], radius: 0.01 },
      { from: [-0.3, 0.9, 0], to: [0.3, 0.9, 0], radius: 0.008 },
      { from: [0, 0.99, 0], to: [0, 1.13, 0], radius: 0.01 },
      { from: [0, 1.13, 0], to: [0.05, 1.18, 0], radius: 0.01 },
      { from: [0.05, 1.18, 0], to: [0.1, 1.13, 0], radius: 0.01 },
    ],
  };
}

function curtain(): Design {
  const halfWidth = 0.95;
  const height = 1.5;
  const pleats = 4.5;
  return {
    solid: {
      bounds: [-halfWidth - 0.03, halfWidth + 0.03, -0.03, height + 0.03],
      cell: 0.028,
      sdf: (x, y) => boxSdf(x, y - height / 2, halfWidth, height / 2),
      halfDepth: () => 0.02,
      round: 0.025,
      profile: 0.5,
      midZ: (x, y) => {
        const amplitude = 0.07 + 0.05 * (1 - Math.min(1, Math.max(0, y / height)));
        return amplitude * Math.sin((2 * Math.PI * pleats * (x + halfWidth)) / (2 * halfWidth));
      },
    },
    floor: 0.06,
    pinRegion: { minY: height - 0.035, halfWidth: halfWidth + 0.05 },
    supports: [{ from: [-halfWidth - 0.12, height + 0.025, 0], to: [halfWidth + 0.12, height + 0.025, 0], radius: 0.022 }],
  };
}

function carShell(): Design {
  const body: Point[] = [
    [-1.08, 0.2],
    [1.08, 0.2],
    [1.12, 0.38],
    [0.98, 0.45],
    [0.5, 0.5],
    [-0.72, 0.52],
    [-1.06, 0.5],
    [-1.12, 0.32],
  ];
  const cabin: Point[] = [
    [-0.74, 0.46],
    [0.5, 0.46],
    [0.14, 0.79],
    [-0.46, 0.8],
    [-0.62, 0.62],
  ];
  const arches: Point[] = [
    [-0.68, 0.2],
    [0.68, 0.2],
  ];
  const sdf = (x: number, y: number) => {
    const lower = polygonSdf(x, y, body) - 0.04;
    const top = polygonSdf(x, y, cabin) - 0.025;
    let shape = smoothMin(lower, top, 0.06);
    for (const [ax, ay] of arches) shape = Math.max(shape, -(Math.hypot(x - ax, y - ay) - 0.19));
    return shape;
  };
  return {
    solid: {
      bounds: [-1.2, 1.2, 0.12, 0.88],
      cell: 0.02,
      sdf,
      halfDepth: (_x, y) => 0.44 + (0.36 - 0.44) * smoothstep(0.5, 0.6, y),
      round: 0.08,
      profile: 0.5,
    },
    floor: 0.01,
    pinRegion: null,
    supports: [],
  };
}

type Point = readonly [number, number];

/** Exact signed distance to a simple polygon (Inigo Quilez). */
function polygonSdf(px: number, py: number, points: readonly Point[]): number {
  let distance2 = (px - points[0][0]) ** 2 + (py - points[0][1]) ** 2;
  let sign = 1;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i++) {
    const [ix, iy] = points[i];
    const [jx, jy] = points[j];
    const ex = jx - ix;
    const ey = jy - iy;
    const wx = px - ix;
    const wy = py - iy;
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const bx = wx - ex * t;
    const by = wy - ey * t;
    distance2 = Math.min(distance2, bx * bx + by * by);
    const above = py >= iy;
    const below = py < jy;
    const left = ex * wy > ey * wx;
    if ((above && below && left) || (!above && !below && !left)) sign = -sign;
  }
  return sign * Math.sqrt(distance2);
}

function boxSdf(x: number, y: number, halfX: number, halfY: number): number {
  const dx = Math.abs(x) - halfX;
  const dy = Math.abs(y) - halfY;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function buildSolid(spec: SolidSpec): BuiltMesh {
  const [x0, x1, y0, y1] = spec.bounds;
  const nx = Math.ceil((x1 - x0) / spec.cell);
  const ny = Math.ceil((y1 - y0) / spec.cell);
  const gridX = (i: number) => x0 + ((x1 - x0) * i) / nx;
  const gridY = (j: number) => y0 + ((y1 - y0) * j) / ny;
  const vertexId = (i: number, j: number) => j * (nx + 1) + i;
  const quadId = (i: number, j: number) => j * nx + i;

  const inside = new Uint8Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) inside[vertexId(i, j)] = spec.sdf(gridX(i), gridY(j)) < 0 ? 1 : 0;
  }
  const quads = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      quads[quadId(i, j)] =
        inside[vertexId(i, j)] & inside[vertexId(i + 1, j)] & inside[vertexId(i + 1, j + 1)] & inside[vertexId(i, j + 1)];
    }
  }
  // Quads that touch only at a corner would pinch the surface into a non-manifold vertex.
  const quadAt = (i: number, j: number) => (i >= 0 && j >= 0 && i < nx && j < ny ? quads[quadId(i, j)] : 0);
  for (let changed = true; changed; ) {
    changed = false;
    for (let j = 1; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const q00 = quadAt(i - 1, j - 1);
        const q10 = quadAt(i, j - 1);
        const q01 = quadAt(i - 1, j);
        const q11 = quadAt(i, j);
        if (q00 && q11 && !q10 && !q01) {
          quads[quadId(i, j)] = 0;
          changed = true;
        } else if (q10 && q01 && !q00 && !q11) {
          quads[quadId(i - 1, j)] = 0;
          changed = true;
        }
      }
    }
  }

  const front = new Int32Array((nx + 1) * (ny + 1)).fill(-1);
  const back = new Int32Array((nx + 1) * (ny + 1)).fill(-1);
  const positions: number[] = [];
  const midZ = spec.midZ ?? (() => 0);
  const e = spec.cell * 0.25;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const around = quadAt(i - 1, j - 1) + quadAt(i, j - 1) + quadAt(i - 1, j) + quadAt(i, j);
      if (around === 0) continue;
      const rim = around < 4;
      let x = gridX(i);
      let y = gridY(j);
      if (rim) [x, y] = projectToContour(spec.sdf, x, y, spec.cell);
      const depth = rim ? 0 : spec.halfDepth(x, y) * Math.pow(Math.min(1, -spec.sdf(x, y) / spec.round), spec.profile);
      const z = midZ(x, y);
      const gx = (midZ(x + e, y) - midZ(x - e, y)) / (2 * e);
      const gy = (midZ(x, y + e) - midZ(x, y - e)) / (2 * e);
      const length = Math.hypot(gx, gy, 1);
      const nx3 = -gx / length;
      const ny3 = -gy / length;
      const nz3 = 1 / length;
      const id = vertexId(i, j);
      front[id] = positions.length / 3;
      positions.push(x + nx3 * depth, y + ny3 * depth, z + nz3 * depth);
      if (rim) {
        back[id] = front[id];
      } else {
        back[id] = positions.length / 3;
        positions.push(x - nx3 * depth, y - ny3 * depth, z - nz3 * depth);
      }
    }
  }

  const triangles: number[] = [];
  const rimShared = (a: number, b: number, c: number) => front[a] === back[a] && front[b] === back[b] && front[c] === back[c];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!quads[quadId(i, j)]) continue;
      const a = vertexId(i, j);
      const b = vertexId(i + 1, j);
      const c = vertexId(i + 1, j + 1);
      const d = vertexId(i, j + 1);
      for (const [p, q, r] of [
        [a, b, c],
        [a, c, d],
      ]) {
        // A triangle lying entirely on the rim has no depth; front and back copies would coincide.
        if (rimShared(p, q, r)) continue;
        triangles.push(front[p], front[q], front[r]);
        triangles.push(back[p], back[r], back[q]);
      }
    }
  }
  return compact(positions, triangles);
}

function projectToContour(
  sdf: (x: number, y: number) => number,
  x: number,
  y: number,
  cell: number,
): [number, number] {
  const e = cell * 0.05;
  for (let step = 0; step < 4; step++) {
    const value = sdf(x, y);
    const gx = (sdf(x + e, y) - sdf(x - e, y)) / (2 * e);
    const gy = (sdf(x, y + e) - sdf(x, y - e)) / (2 * e);
    const g2 = gx * gx + gy * gy;
    if (g2 < 1e-12) break;
    let dx = (-value * gx) / g2;
    let dy = (-value * gy) / g2;
    const length = Math.hypot(dx, dy);
    if (length > cell * 0.7) {
      dx *= (cell * 0.7) / length;
      dy *= (cell * 0.7) / length;
    }
    x += dx;
    y += dy;
  }
  return [x, y];
}

function compact(positions: number[], triangles: number[]): BuiltMesh {
  const used = new Int32Array(positions.length / 3).fill(-1);
  const out: number[] = [];
  const remapped: number[] = [];
  for (const index of triangles) {
    if (used[index] < 0) {
      used[index] = out.length / 3;
      out.push(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
    }
    remapped.push(used[index]);
  }
  return { positions: out, triangles: remapped };
}

/** Centers the solid over the platform with its lowest point at `floor`; returns the applied shift. */
function placeOverPlatform(positions: number[], floor: number): [number, number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);
    maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }
  const shift: [number, number, number] = [-0.5 * (minX + maxX), floor - minY, -0.5 * (minZ + maxZ)];
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += shift[0];
    positions[i + 1] += shift[1];
    positions[i + 2] += shift[2];
    if (Math.abs(positions[i]) > PLATFORM_HALF || Math.abs(positions[i + 2]) > PLATFORM_HALF || positions[i + 1] < 0) {
      throw new Error('Source mesh does not sit on the platform');
    }
  }
  return shift;
}
