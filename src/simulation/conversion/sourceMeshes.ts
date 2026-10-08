import type { PlasticSettings } from '../../materials/presets';
import { PLATFORM_HALF } from '../scene';

/** Procedural rigid source solids. Ids are stable preset keys. */
export const SOURCE_MESH_IDS = ['tshirt', 'denim-jacket', 'curtain', 'car-shell'] as const;

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

/** Cloth properties for one region of a multi-material shell. */
export interface RegionMaterial {
  id: string;
  label: string;
  /** Flat color in the material map view. */
  color: number;
  /** How the fabric looks in the source mesh view. */
  fabricColor: number;
  stretchCompliance: number;
  compressionCompliance: number;
  bendCompliance: number;
  damping: number;
  friction: number;
  plastic: PlasticSettings | null;
}

export interface PinRegion {
  minY: number;
  maxY?: number;
  halfWidth: number;
  maxAbsZ?: number;
  /** Only particles with this material id can be pinned. */
  materialId?: number;
  /** Optional proximity to selected support segments. */
  supportIndices?: readonly number[];
  maxSupportDistance?: number;
}

/** Denim holds a crease; the cotton hoodie compresses and bends much more freely. */
export const JACKET_MATERIALS = [
  {
    id: 'denim',
    label: 'Denim',
    color: 0x3d7bd9,
    fabricColor: 0x3f5f86,
    stretchCompliance: 0,
    compressionCompliance: 0.0008,
    bendCompliance: 0.01,
    damping: 2.5,
    friction: 0.8,
    plastic: { yieldStrain: 0.05, creep: 0.12, maxStrain: 0.4 },
  },
  {
    id: 'cotton',
    label: 'Cotton hoodie',
    color: 0xf0a43a,
    fabricColor: 0x9a9690,
    stretchCompliance: 0,
    compressionCompliance: 0.25,
    bendCompliance: 3,
    damping: 1,
    friction: 0.45,
    plastic: null,
  },
] as const satisfies readonly RegionMaterial[];

/** Closed, upright triangle surface of a rigid solid sitting over the platform. */
export interface SourceMesh extends SourceMeshMetadata {
  positions: Float32Array;
  triangles: Uint32Array;
  /** Generated shell particles inside this region hang from the supports instead of falling. */
  pinRegion: PinRegion | null;
  supports: SupportSegment[];
  /** Empty when the whole solid uses one material. */
  materials: readonly RegionMaterial[];
  /** Per-vertex index into {@link materials}. Empty when `materials` is empty. */
  materialIds: Uint8Array;
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
  'denim-jacket': {
    label: 'Denim jacket',
    description: 'Open-front cropped denim jacket with a sewn-in cotton hood, cotton cuffs, and a narrow cotton zipper facing.',
    color: 0x4a6f9c,
    defaultThickness: 0.008,
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
  const design = designFor(id);
  const built = design.solid.kind === 'implicit' ? buildImplicit(design.solid) : buildSolid(design.solid);
  const materialIds = new Uint8Array(design.materialAt ? built.positions.length / 3 : 0);
  if (design.materialAt) {
    for (let i = 0; i < materialIds.length; i++) {
      materialIds[i] = design.materialAt(built.positions[i * 3], built.positions[i * 3 + 1], built.positions[i * 3 + 2]);
    }
  }
  const [sx, sy, sz] = placeOverPlatform(built.positions, design.floor);
  return {
    ...metadata,
    positions: new Float32Array(built.positions),
    triangles: new Uint32Array(built.triangles),
    pinRegion: design.pinRegion
      ? {
          ...design.pinRegion,
          minY: design.pinRegion.minY + sy,
          maxY: design.pinRegion.maxY === undefined ? undefined : design.pinRegion.maxY + sy,
        }
      : null,
    materials: design.materials ?? [],
    materialIds,
    supports: design.supports.map((segment) => ({
      from: [segment.from[0] + sx, segment.from[1] + sy, segment.from[2] + sz],
      to: [segment.to[0] + sx, segment.to[1] + sy, segment.to[2] + sz],
      radius: segment.radius,
    })),
  };
}

/** Indices of shell particles inside the source's pin region, which hang from its hanger or rod. */
export function pinnedParticles(source: SourceMesh, positions: Float32Array, materialIds?: Uint8Array): number[] {
  const region = source.pinRegion;
  if (!region) return [];
  const pinned: number[] = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (y < region.minY || (region.maxY !== undefined && y > region.maxY)) continue;
    if (Math.abs(x) > region.halfWidth) continue;
    if (region.maxAbsZ !== undefined && Math.abs(z) > region.maxAbsZ) continue;
    if (region.materialId !== undefined && materialIds && materialIds[i] !== region.materialId) continue;
    if (region.supportIndices && region.maxSupportDistance !== undefined) {
      let distance = Infinity;
      for (const supportIndex of region.supportIndices) {
        const segment = source.supports[supportIndex];
        if (segment) distance = Math.min(distance, pointSegmentDistance([x, y, z], segment.from, segment.to));
      }
      if (distance > region.maxSupportDistance) continue;
    }
    pinned.push(i);
  }
  return pinned;
}

/** Majority material of the source vertices bound to each simulation particle. */
export function particleMaterials(
  source: SourceMesh,
  particleCount: number,
  triangles: Uint32Array,
  bindings: readonly { triangle: number; barycentric: readonly [number, number, number] }[],
): Uint8Array {
  const bins = source.materials.length;
  const ids = new Uint8Array(particleCount);
  if (bins === 0) return ids;
  const weight = new Float64Array(particleCount * bins);
  for (let s = 0; s < source.materialIds.length; s++) {
    const binding = bindings[s];
    const material = source.materialIds[s];
    const base = binding.triangle * 3;
    for (let k = 0; k < 3; k++) {
      const share = binding.barycentric[k];
      if (share <= 0) continue;
      weight[triangles[base + k] * bins + material] += share;
    }
  }
  for (let i = 0; i < particleCount; i++) {
    let best = 0;
    let bestWeight = -1;
    for (let material = 0; material < bins; material++) {
      const vote = weight[i * bins + material];
      if (vote > bestWeight) {
        bestWeight = vote;
        best = material;
      }
    }
    ids[i] = best;
  }
  return ids;
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
  kind?: 'silhouette';
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
  solid: SolidSpec | ImplicitSpec;
  floor: number;
  pinRegion: PinRegion | null;
  supports: SupportSegment[];
  materials?: readonly RegionMaterial[];
  /** Material index in design space, before the mesh is moved onto the platform. */
  materialAt?(x: number, y: number, z: number): number;
}

function designFor(id: SourceMeshId): Design {
  if (id === 'tshirt') return tshirt();
  if (id === 'denim-jacket') return denimJacket();
  if (id === 'curtain') return curtain();
  return carShell();
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
      cell: 0.015,
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
    supports: hanger(0.9),
  };
}

const DENIM = 0;
const COTTON = 1;

/** The T-shirt's wire hanger, with its shoulder bar at height `barY`. */
function hanger(barY: number): SupportSegment[] {
  const neckY = barY + 0.09;
  const hookY = barY + 0.23;
  return [
    { from: [-0.3, barY, 0], to: [0, neckY, 0], radius: 0.01 },
    { from: [0.3, barY, 0], to: [0, neckY, 0], radius: 0.01 },
    { from: [-0.3, barY, 0], to: [0.3, barY, 0], radius: 0.008 },
    { from: [0, neckY, 0], to: [0, hookY, 0], radius: 0.01 },
    { from: [0, hookY, 0], to: [0.05, hookY + 0.05, 0], radius: 0.01 },
    { from: [0.05, hookY + 0.05, 0], to: [0.1, hookY, 0], radius: 0.01 },
  ];
}

/** Broader, sloped jacket hanger whose forward hook clears the rear-draped hood. */
function jacketHanger(barY: number): SupportSegment[] {
  const neckY = barY + 0.105;
  const hookZ = 0.055;
  return [
    { from: [-0.345, barY, 0], to: [0, neckY, 0], radius: 0.012 },
    { from: [0.345, barY, 0], to: [0, neckY, 0], radius: 0.012 },
    { from: [-0.345, barY, 0], to: [0.345, barY, 0], radius: 0.009 },
    { from: [0, neckY, 0], to: [0, neckY + 0.105, hookZ], radius: 0.011 },
    { from: [0, neckY + 0.105, hookZ], to: [0.055, neckY + 0.17, hookZ], radius: 0.011 },
    { from: [0.055, neckY + 0.17, hookZ], to: [0.115, neckY + 0.125, hookZ], radius: 0.011 },
  ];
}

type Vec3 = readonly [number, number, number];

/** Shoulder seam and cuff of the right sleeve; the left mirrors it. */
const SLEEVE_TOP: Vec3 = [0.29, 0.79, 0];
const SLEEVE_CUFF: Vec3 = [0.67, 0.63, 0.015];
const SLEEVE_AXIS = normalize3(sub3(SLEEVE_CUFF, SLEEVE_TOP));
const SLEEVE_LENGTH = Math.hypot(...sub3(SLEEVE_CUFF, SLEEVE_TOP));
const CUFF_LENGTH = 0.1;
const HOOD_CENTER: Vec3 = [0, 0.92, -0.105];

function denimJacket(): Design {
  const sleeveOuter = (x: number, y: number, z: number) => {
    const p: Vec3 = [Math.abs(x), y, z];
    const along = dot3(sub3(p, SLEEVE_TOP), SLEEVE_AXIS);
    const cuffPlane = along - dot3(sub3(SLEEVE_CUFF, SLEEVE_TOP), SLEEVE_AXIS);
    return Math.max(roundCone(p, SLEEVE_TOP, SLEEVE_CUFF, 0.105, 0.07), cuffPlane);
  };

  const sleeveCavity = (x: number, y: number, z: number) => {
    const p: Vec3 = [Math.abs(x), y, z];
    const innerStart = add3(SLEEVE_TOP, scale3(SLEEVE_AXIS, -0.08));
    const innerEnd = add3(SLEEVE_CUFF, scale3(SLEEVE_AXIS, 0.065));
    return roundCone(p, innerStart, innerEnd, 0.068, 0.044);
  };

  const torsoOuter = (x: number, y: number, z: number) => {
    const ax = Math.abs(x);
    const width = 0.335 - 0.018 * smoothstep(0.05, 0.72, y);
    const body = roundBox(x, y - 0.43, z, width, 0.43, 0.105, 0.035);
    const shoulderLine = 0.91 - 0.34 * Math.max(0, ax - 0.08);
    return smoothMax(body, y - shoulderLine, 0.025);
  };

  const torsoCavity = (x: number, y: number, z: number) => {
    const ax = Math.abs(x);
    const width = 0.3 - 0.012 * smoothstep(0.05, 0.7, y);
    const inside = roundBox(x, y - 0.43, z, width, 0.47, 0.066, 0.025);
    const shoulderLine = 0.875 - 0.32 * Math.max(0, ax - 0.08);
    return smoothMax(inside, y - shoulderLine, 0.02);
  };

  const frontOpening = (x: number, y: number, z: number) =>
    roundBox(x, y - 0.43, z - 0.11, 0.055, 0.5, 0.09, 0.012);

  const neckOpening = (x: number, y: number, z: number) =>
    ellipsoid(x, y - 0.875, z - 0.005, 0.13, 0.095, 0.09);

  const hoodOuter = (x: number, y: number, z: number) => {
    const p = sub3([x, y, z], HOOD_CENTER);
    const crown = ellipsoid(p[0], p[1], p[2], 0.225, 0.16, 0.165);
    const nape = roundBox(x, y - 0.835, z + 0.055, 0.175, 0.07, 0.11, 0.045);
    return smoothMin(crown, nape, 0.035);
  };

  const hoodCavity = (x: number, y: number, z: number) => {
    const p = sub3([x, y, z], HOOD_CENTER);
    const inside = ellipsoid(p[0], p[1] + 0.004, p[2] - 0.006, 0.175, 0.115, 0.12);
    const face = ellipsoid(x, y - 0.93, z - 0.045, 0.15, 0.12, 0.19);
    const neck = roundBox(x, y - 0.85, z + 0.025, 0.12, 0.1, 0.09, 0.04);
    return Math.min(inside, face, neck);
  };

  const plackets = (x: number, y: number, z: number) => {
    const side = Math.abs(x) - 0.08;
    return roundBox(side, y - 0.43, z - 0.104, 0.018, 0.39, 0.025, 0.008);
  };

  const cottonFacing = (x: number, y: number, z: number) => {
    const side = Math.abs(x) - 0.064;
    return roundBox(side, y - 0.43, z - 0.096, 0.006, 0.37, 0.018, 0.006);
  };

  const pocketDetails = (x: number, y: number, z: number) => {
    const side = Math.abs(x) - 0.165;
    const panel = roundBox(side, y - 0.535, z - 0.102, 0.067, 0.07, 0.022, 0.008);
    const flap = roundBox(side, y - 0.615, z - 0.108, 0.075, 0.032, 0.026, 0.008);
    return Math.min(panel, flap);
  };

  const collarTabs = (x: number, y: number, z: number) => {
    const side = Math.abs(x) - 0.095;
    const slopeY = y - (0.84 - 0.45 * Math.abs(x));
    return Math.max(roundBox(side, slopeY, z - 0.102, 0.07, 0.035, 0.022, 0.008), -z + 0.078);
  };

  const waistband = (x: number, y: number, z: number) =>
    roundBox(x, y - 0.035, z, 0.345, 0.035, 0.118, 0.018);

  const outerGarment = (x: number, y: number, z: number) => {
    const denimBody = smoothMin(torsoOuter(x, y, z), sleeveOuter(x, y, z), 0.035);
    return Math.min(
      denimBody,
      hoodOuter(x, y, z),
      plackets(x, y, z),
      cottonFacing(x, y, z),
      pocketDetails(x, y, z),
      collarTabs(x, y, z),
      waistband(x, y, z),
    );
  };

  const connectedCavity = (x: number, y: number, z: number) =>
    Math.min(
      torsoCavity(x, y, z),
      sleeveCavity(x, y, z),
      frontOpening(x, y, z),
      neckOpening(x, y, z),
      hoodCavity(x, y, z),
    );

  const garment = (x: number, y: number, z: number) =>
    Math.max(outerGarment(x, y, z), -connectedCavity(x, y, z));

  const materialAt = (x: number, y: number, z: number) => {
    const p: Vec3 = [Math.abs(x), y, z];
    const sleeveAlong = dot3(sub3(p, SLEEVE_TOP), SLEEVE_AXIS);
    const cuff =
      Math.abs(x) > 0.52 &&
      sleeveAlong > SLEEVE_LENGTH - CUFF_LENGTH &&
      sleeveAlong < SLEEVE_LENGTH + 0.08;
    const hood = hoodOuter(x, y, z) < 0.025 && y > 0.82 && Math.abs(x) < 0.24;
    const facing = Math.abs(x) > 0.056 && Math.abs(x) < 0.072 && y > 0.06 && y < 0.82 && z > 0.06;
    return hood || cuff || facing ? COTTON : DENIM;
  };

  return {
    solid: {
      kind: 'implicit',
      min: [-0.8, -0.08, -0.34],
      max: [0.8, 1.34, 0.26],
      cell: 0.015,
      sdf: garment,
    },
    floor: 0.24,
    pinRegion: {
      minY: 0.75,
      maxY: 0.9,
      halfWidth: 0.36,
      maxAbsZ: 0.065,
      materialId: DENIM,
      supportIndices: [0, 1],
      maxSupportDistance: 0.075,
    },
    materials: JACKET_MATERIALS,
    materialAt,
    supports: jacketHanger(0.79),
  };
}

/** A closed solid defined by a 3D signed distance field, negative inside. */
interface ImplicitSpec {
  kind: 'implicit';
  min: Vec3;
  max: Vec3;
  cell: number;
  sdf(x: number, y: number, z: number): number;
}

/** Corner offsets of a grid cube, indexed by bits x=1, y=2, z=4. */
const CUBE_CORNERS: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];
/**
 * Freudenthal split of each cube into six tetrahedra around its main diagonal.
 * Neighbouring cubes share face diagonals, so the level set is watertight.
 */
const CUBE_TETS = [
  [0, 1, 3, 7],
  [0, 1, 5, 7],
  [0, 2, 3, 7],
  [0, 2, 6, 7],
  [0, 4, 5, 7],
  [0, 4, 6, 7],
];

/**
 * Marching tetrahedra. The zero set of a piecewise-linear field with no zero samples
 * is a closed 2-manifold, and orienting each face along the field gradient makes
 * every edge appear once in each direction.
 */
function buildImplicit(spec: ImplicitSpec): BuiltMesh {
  const [x0, y0, z0] = spec.min;
  const nx = Math.ceil((spec.max[0] - x0) / spec.cell);
  const ny = Math.ceil((spec.max[1] - y0) / spec.cell);
  const nz = Math.ceil((spec.max[2] - z0) / spec.cell);
  const sx = nx + 1;
  const sxy = sx * (ny + 1);
  const pointCount = sxy * (nz + 1);
  const values = new Float64Array(pointCount);
  const point = (index: number): Vec3 => {
    const k = Math.floor(index / sxy);
    const rest = index - k * sxy;
    const j = Math.floor(rest / sx);
    const i = rest - j * sx;
    return [x0 + i * spec.cell, y0 + j * spec.cell, z0 + k * spec.cell];
  };
  for (let index = 0; index < pointCount; index++) {
    const [x, y, z] = point(index);
    const border = x <= x0 || y <= y0 || z <= z0 || index % sx === nx || Math.floor(index / sx) % (ny + 1) === ny || Math.floor(index / sxy) === nz;
    const value = border ? Math.max(spec.cell, spec.sdf(x, y, z)) : spec.sdf(x, y, z);
    values[index] = Math.abs(value) < 1e-9 ? 1e-9 : value;
  }

  const positions: number[] = [];
  const triangles: number[] = [];
  const edgeVertex = new Map<number, number>();
  const vertexOn = (a: number, b: number): number => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * pointCount + hi;
    const found = edgeVertex.get(key);
    if (found !== undefined) return found;
    const t = Math.min(0.97, Math.max(0.03, values[lo] / (values[lo] - values[hi])));
    const pa = point(lo);
    const pb = point(hi);
    const id = positions.length / 3;
    positions.push(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t);
    edgeVertex.set(key, id);
    return id;
  };
  const emit = (ids: number[], inside: number[], outside: number[]) => {
    const [a, b, c] = ids;
    const ux = positions[b * 3] - positions[a * 3];
    const uy = positions[b * 3 + 1] - positions[a * 3 + 1];
    const uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3];
    const vy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const centroid = (list: number[]) => {
      const out = [0, 0, 0];
      for (const index of list) {
        const p = point(index);
        out[0] += p[0] / list.length;
        out[1] += p[1] / list.length;
        out[2] += p[2] / list.length;
      }
      return out as unknown as Vec3;
    };
    const outward = sub3(centroid(outside), centroid(inside));
    if (dot3(n, outward) >= 0) triangles.push(a, b, c);
    else triangles.push(a, c, b);
  };

  const corner = new Array<number>(8);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let negative = 0;
        for (let c = 0; c < 8; c++) {
          const [di, dj, dk] = CUBE_CORNERS[c];
          corner[c] = (k + dk) * sxy + (j + dj) * sx + (i + di);
          if (values[corner[c]] < 0) negative++;
        }
        if (negative === 0 || negative === 8) continue;
        for (const tet of CUBE_TETS) {
          const ids = tet.map((c) => corner[c]);
          const inside = ids.filter((index) => values[index] < 0);
          const outside = ids.filter((index) => values[index] >= 0);
          if (inside.length === 0 || outside.length === 0) continue;
          if (inside.length === 1 || outside.length === 1) {
            const lone = inside.length === 1 ? inside[0] : outside[0];
            const others = inside.length === 1 ? outside : inside;
            emit(others.map((other) => vertexOn(lone, other)), inside, outside);
          } else {
            const [a, b] = inside;
            const [c, d] = outside;
            const ac = vertexOn(a, c);
            const ad = vertexOn(a, d);
            const bd = vertexOn(b, d);
            const bc = vertexOn(b, c);
            emit([ac, ad, bd], inside, outside);
            emit([ac, bd, bc], inside, outside);
          }
        }
      }
    }
  }
  return compact(positions, triangles);
}

function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize3(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}

function pointSegmentDistance(point: Vec3, from: Vec3, to: Vec3): number {
  const segment = sub3(to, from);
  const length2 = dot3(segment, segment);
  const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, dot3(sub3(point, from), segment) / length2));
  return Math.hypot(...sub3(point, add3(from, scale3(segment, t))));
}

function roundBox(x: number, y: number, z: number, hx: number, hy: number, hz: number, r: number): number {
  const qx = Math.abs(x) - hx + r;
  const qy = Math.abs(y) - hy + r;
  const qz = Math.abs(z) - hz + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

/** Approximate distance to an axis-aligned ellipsoid (Inigo Quilez). */
function ellipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number): number {
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 < 1e-12 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}

/** Tapered capsule from `a` (radius `ra`) to `b` (radius `rb`). */
function roundCone(p: Vec3, a: Vec3, b: Vec3, ra: number, rb: number): number {
  const ab = sub3(b, a);
  const t = Math.min(1, Math.max(0, dot3(sub3(p, a), ab) / dot3(ab, ab)));
  const closest = add3(a, scale3(ab, t));
  const d = sub3(p, closest);
  return Math.hypot(d[0], d[1], d[2]) - (ra + (rb - ra) * t);
}

function smoothMax(a: number, b: number, k: number): number {
  return -smoothMin(-a, -b, k);
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
