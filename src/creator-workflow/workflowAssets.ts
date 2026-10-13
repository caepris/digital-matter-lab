export const WORKFLOW_ASSET_IDS = [
  'tshirt',
  'ruffled-skirt',
  'puffer-jacket',
  'sheet-metal',
  'hooded-jacket',
  'fish-flag',
] as const;

export type WorkflowAssetId = (typeof WORKFLOW_ASSET_IDS)[number];

/** Region 0 is body surface; 1-254 are selectable end caps; this one is authored thickness. */
export const BACK_SKIN_REGION = 255;

export interface WorkflowSurface {
  positions: Float32Array;
  triangles: Uint32Array;
  uvs: Float32Array;
  /** Per-vertex region id. Patches never share vertices, so a face's region is its first vertex's. */
  capRegion: Uint8Array;
  source?: 'authored' | 'procedural';
}

export interface CapRegionDefinition {
  id: number;
  label: string;
}

export interface WorkflowAssetDefinition {
  id: WorkflowAssetId;
  label: string;
  callout: string;
  shellNote: string;
  planeNote: string;
  thickenNote: string;
  defaultThicknessCm: number;
  capRegions: readonly CapRegionDefinition[];
  /** Depth (z) of the creator's single simulation plane in Path 2. */
  planeDepth: number;
  /** Base color multiplied into the shared fabric texture. */
  tint: number;
}

const GARMENT_CAPS: readonly CapRegionDefinition[] = [
  { id: 1, label: 'Hem opening' },
  { id: 2, label: 'Neck opening' },
  { id: 3, label: 'Left cuff' },
  { id: 4, label: 'Right cuff' },
];

export const WORKFLOW_ASSETS: readonly WorkflowAssetDefinition[] = [
  {
    id: 'tshirt',
    label: 'T-shirt',
    callout: 'Baseline garment: hem, neck, and cuffs are closed in the arbitrary mesh but open in real cloth.',
    shellNote: 'Mark the hem, neck, and cuffs to open the shirt.',
    planeNote: 'One plane drives the whole shirt.',
    thickenNote: 'The print wraps a thin rim at every opening.',
    defaultThicknessCm: 0.6,
    capRegions: GARMENT_CAPS,
    planeDepth: 0,
    tint: 0x8fb2ff,
  },
  {
    id: 'ruffled-skirt',
    label: 'Ruffled skirt',
    callout: 'A ruffled cone whose waist and hem discs close the arbitrary mesh.',
    shellNote: 'Mark the hem so the ruffles swing freely.',
    planeNote: 'Motion stays flat; ruffles ride along.',
    thickenNote: 'The ruffled hem shows its thickness as it moves.',
    defaultThicknessCm: 0.8,
    capRegions: [
      { id: 1, label: 'Waist opening' },
      { id: 2, label: 'Hem opening' },
    ],
    planeDepth: 0,
    tint: 0xf0a3c4,
  },
  {
    id: 'puffer-jacket',
    label: 'Puffer jacket',
    callout: 'Thick quilted volume: the shell and thickening paths both carry a visible depth.',
    shellNote: 'The shell hugs the quilting; caps open the ends.',
    planeNote: 'One plane moves the whole puffer.',
    thickenNote: 'A large thickness makes a padded layer.',
    defaultThicknessCm: 3,
    capRegions: GARMENT_CAPS,
    planeDepth: 0,
    tint: 0xf2c46b,
  },
  {
    id: 'sheet-metal',
    label: 'Sheet-metal panel',
    callout: 'A closed slab whose four edge walls can be treated as end caps.',
    shellNote: 'Mark the edge walls to keep only the two skins.',
    planeNote: 'A flat plane drives the panel bending.',
    thickenNote: 'The sheet becomes plate with a machined rim.',
    defaultThicknessCm: 1.2,
    capRegions: [
      { id: 1, label: 'Top edge wall' },
      { id: 2, label: 'Bottom edge wall' },
      { id: 3, label: 'Left edge wall' },
      { id: 4, label: 'Right edge wall' },
    ],
    planeDepth: 0.17,
    tint: 0xc9d2dc,
  },
  {
    id: 'hooded-jacket',
    label: 'Hooded denim jacket',
    callout: 'Adds a hood with a face opening to the garment caps.',
    shellNote: 'Mark the hood opening too, or it stays sealed.',
    planeNote: 'Hood and body follow one plane.',
    thickenNote: 'Denim print wraps the hood and cuff rims.',
    defaultThicknessCm: 0.8,
    capRegions: [...GARMENT_CAPS, { id: 5, label: 'Hood face opening' }],
    planeDepth: 0,
    tint: 0x6f95d8,
  },
  {
    id: 'fish-flag',
    label: 'Fish flag',
    callout: 'A koinobori-style windsock: open mouth and tail in real life, closed in the arbitrary mesh.',
    shellNote: 'Mark the mouth and tail so wind flows through.',
    planeNote: 'A flat plane gives simple flag flapping.',
    thickenNote: 'Fabric rims at the open mouth and tail.',
    defaultThicknessCm: 1,
    capRegions: [
      { id: 1, label: 'Mouth opening' },
      { id: 2, label: 'Tail opening' },
    ],
    planeDepth: 0,
    tint: 0xff8f6b,
  },
];

export function workflowAsset(id: WorkflowAssetId): WorkflowAssetDefinition {
  const asset = WORKFLOW_ASSETS.find((entry) => entry.id === id);
  if (!asset) throw new Error(`Unknown workflow asset "${id}"`);
  return asset;
}

export function surfaceBounds(positions: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], positions[index + axis]);
      max[axis] = Math.max(max[axis], positions[index + axis]);
    }
  }
  return { min, max };
}

/** Region id of each triangle. */
export function faceRegions(surface: WorkflowSurface): Uint8Array {
  const regions = new Uint8Array(surface.triangles.length / 3);
  for (let face = 0; face < regions.length; face += 1) regions[face] = surface.capRegion[surface.triangles[face * 3]];
  return regions;
}

/** Keeps the faces whose region passes `keep`, compacting unused vertices away. */
export function filterSurface(surface: WorkflowSurface, keep: (region: number) => boolean): WorkflowSurface {
  const regions = faceRegions(surface);
  const kept: number[] = [];
  for (let face = 0; face < regions.length; face += 1) {
    if (!keep(regions[face])) continue;
    kept.push(surface.triangles[face * 3], surface.triangles[face * 3 + 1], surface.triangles[face * 3 + 2]);
  }
  const remap = new Int32Array(surface.positions.length / 3).fill(-1);
  let count = 0;
  for (const index of kept) if (remap[index] < 0) remap[index] = count++;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const capRegion = new Uint8Array(count);
  for (let old = 0; old < remap.length; old += 1) {
    const next = remap[old];
    if (next < 0) continue;
    positions.set(surface.positions.subarray(old * 3, old * 3 + 3), next * 3);
    uvs.set(surface.uvs.subarray(old * 2, old * 2 + 2), next * 2);
    capRegion[next] = surface.capRegion[old];
  }
  return {
    positions,
    triangles: new Uint32Array(kept.map((index) => remap[index])),
    uvs,
    capRegion,
    source: surface.source,
  };
}

/**
 * `capped` is the arbitrary mesh for Paths 1-2. `open` is Path 3's authored
 * zero-thickness surface: no caps, no closed volumes, nothing hidden inside the body.
 */
export type WorkflowSurfaceVariant = 'capped' | 'open';

/**
 * Procedural fallback matching scripts/generate-workflow-models.py. `detail`
 * scales tessellation so tests can build lighter meshes.
 */
export function buildWorkflowSurface(
  id: WorkflowAssetId,
  detail = 1,
  variant: WorkflowSurfaceVariant = 'capped',
): WorkflowSurface {
  const builder = new SurfaceBuilder(detail);
  const open = variant === 'open';
  switch (id) {
    case 'tshirt':
      garment(builder, 'tshirt', open);
      break;
    case 'puffer-jacket':
      garment(builder, 'puffer', open);
      break;
    case 'hooded-jacket':
      garment(builder, 'hooded', open);
      break;
    case 'ruffled-skirt':
      skirt(builder, open);
      break;
    case 'sheet-metal':
      sheetMetal(builder, open);
      break;
    case 'fish-flag':
      fish(builder, open);
      break;
  }
  return builder.build();
}

type Vec3 = readonly [number, number, number];
type PointFn = (u: number, v: number) => Vec3;
type FaceFilter = (a: Vec3, b: Vec3, c: Vec3) => boolean;

class SurfaceBuilder {
  private readonly positions: number[] = [];
  private readonly uvs: number[] = [];
  private readonly regions: number[] = [];
  private readonly triangles: number[] = [];

  constructor(private readonly detail: number) {}

  count(base: number, minimum = 3): number {
    return Math.max(minimum, Math.round(base * this.detail));
  }

  patch(
    positions: Vec3[],
    uvs: [number, number][],
    region: number,
    faces: [number, number, number][],
    outward: (centroid: Vec3) => Vec3,
    keepFace?: FaceFilter,
  ): void {
    if (keepFace) {
      faces = faces.filter(([a, b, c]) => keepFace(positions[a], positions[b], positions[c]));
      const used = [...new Set(faces.flat())].sort((a, b) => a - b);
      const remap = new Map(used.map((old, next) => [old, next]));
      positions = used.map((index) => positions[index]);
      uvs = used.map((index) => uvs[index]);
      faces = faces.map(([a, b, c]) => [remap.get(a)!, remap.get(b)!, remap.get(c)!]);
    }
    let total = 0;
    for (const [a, b, c] of faces) {
      const pa = positions[a];
      const pb = positions[b];
      const pc = positions[c];
      const normal = cross(sub(pb, pa), sub(pc, pa));
      const centroid: Vec3 = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
      total += dot(normal, outward(centroid));
    }
    const offset = this.positions.length / 3;
    for (const point of positions) this.positions.push(...point);
    for (const uv of uvs) this.uvs.push(...uv);
    for (let index = 0; index < positions.length; index += 1) this.regions.push(region);
    for (const [a, b, c] of faces) {
      if (total < 0) this.triangles.push(a + offset, c + offset, b + offset);
      else this.triangles.push(a + offset, b + offset, c + offset);
    }
  }

  grid(
    nu: number,
    nv: number,
    point: PointFn,
    region: number,
    outward: (centroid: Vec3) => Vec3,
    wrapU = false,
    uv: (u: number, v: number) => [number, number] = (u, v) => [u, v],
    keepFace?: FaceFilter,
  ): void {
    const positions: Vec3[] = [];
    const uvs: [number, number][] = [];
    for (let j = 0; j <= nv; j += 1) {
      for (let i = 0; i <= nu; i += 1) {
        positions.push(point(wrapU ? (i % nu) / nu : i / nu, j / nv));
        uvs.push(uv(i / nu, j / nv));
      }
    }
    const faces: [number, number, number][] = [];
    for (let j = 0; j < nv; j += 1) {
      for (let i = 0; i < nu; i += 1) {
        const a = j * (nu + 1) + i;
        const d = a + nu + 1;
        faces.push([a, a + 1, d + 1], [a, d + 1, d]);
      }
    }
    this.patch(positions, uvs, region, faces, outward, keepFace);
  }

  disc(center: Vec3, ring: Vec3[], region: number, normal: Vec3): void {
    const segments = ring.length;
    const uvs: [number, number][] = [[0.5, 0.5]];
    for (let i = 0; i < segments; i += 1) {
      const angle = (2 * Math.PI * i) / segments;
      uvs.push([0.5 + 0.5 * Math.cos(angle), 0.5 + 0.5 * Math.sin(angle)]);
    }
    const faces: [number, number, number][] = [];
    for (let i = 0; i < segments; i += 1) faces.push([0, 1 + i, 1 + ((i + 1) % segments)]);
    this.patch([center, ...ring], uvs, region, faces, () => normal);
  }

  build(): WorkflowSurface {
    return {
      positions: new Float32Array(this.positions),
      triangles: new Uint32Array(this.triangles),
      uvs: new Float32Array(this.uvs),
      capRegion: new Uint8Array(this.regions),
      source: 'procedural',
    };
  }
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function ring(point: PointFn, v: number, segments: number): Vec3[] {
  return Array.from({ length: segments }, (_, i) => point(i / segments, v));
}

const radialFromY = (c: Vec3): Vec3 => [c[0], 0, c[2]];

const TORSO_POWER = 0.72;

interface TorsoShape {
  depth: number;
  puffer: boolean;
}

/** Half width and half depth of the torso superellipse at height parameter v. */
function torsoProfile(v: number, { depth, puffer }: TorsoShape): [number, number] {
  const quilt = 1 + (puffer ? 0.055 * Math.cos(v * Math.PI * 10) : 0);
  const width = (0.45 - 0.035 * Math.sin(v * Math.PI) + 0.09 * v * v) * quilt;
  const bulge = 1 + 0.1 * Math.sin(v * Math.PI);
  return [width, depth * bulge * quilt];
}

/** |x| of the torso surface at (y, z): |x/w|^(2/p) + |z/d|^(2/p) = 1. */
function torsoSurfaceX(y: number, z: number, torso: TorsoShape): number {
  const v = Math.min(1, Math.max(0, (y - 0.2) / 1.12));
  const [width, halfDepth] = torsoProfile(v, torso);
  const ratio = Math.min(1, Math.abs(z) / halfDepth) ** (2 / TORSO_POWER);
  return width * (1 - ratio) ** (TORSO_POWER / 2);
}

function insideTorso(p: Vec3, torso: TorsoShape): boolean {
  if (p[1] < 0.2 || p[1] > 1.32) return false;
  return Math.abs(p[0]) < torsoSurfaceX(p[1], p[2], torso) - 1e-4;
}

function garmentTorso(builder: SurfaceBuilder, torso: TorsoShape, open: boolean): void {
  const rings = builder.count(28);
  const segments = builder.count(36, 8);
  const point: PointFn = (u, v) => {
    const y = 0.2 + 1.12 * v;
    const [width, halfDepth] = torsoProfile(v, torso);
    const angle = 2 * Math.PI * u;
    const cx = Math.sign(Math.cos(angle)) * Math.abs(Math.cos(angle)) ** TORSO_POWER;
    const sz = Math.sign(Math.sin(angle)) * Math.abs(Math.sin(angle)) ** TORSO_POWER;
    return [width * cx, y, halfDepth * sz];
  };
  builder.grid(segments, rings, point, 0, radialFromY, true);
  if (!open) builder.disc([0, 0.2, 0], ring(point, 0, segments), 1, [0, -1, 0]);
  const neck = 0.15;
  const yoke: PointFn = (u, t) => {
    const outer = point(u, 1);
    const angle = 2 * Math.PI * u;
    const inner = [neck * Math.cos(angle), 1.32, neck * Math.sin(angle) * 0.92];
    return [outer[0] + (inner[0] - outer[0]) * t, 1.32 + 0.02 * Math.sin(Math.PI * t), outer[2] + (inner[2] - outer[2]) * t];
  };
  builder.grid(segments, 4, yoke, 0, () => [0, 1, 0], true);
  if (open) collarBand(builder, neck, segments);
  else builder.disc([0, 1.32, 0], ring(yoke, 1, segments), 2, [0, 1, 0]);
}

/** Single-layer stand collar continuing the yoke's neck ring upward. */
function collarBand(builder: SurfaceBuilder, neck: number, segments: number): void {
  const point: PointFn = (u, t) => {
    const angle = 2 * Math.PI * u;
    const radius = neck + 0.025 * t;
    return [radius * Math.cos(angle), 1.32 + 0.07 * t, radius * Math.sin(angle) * 0.92];
  };
  builder.grid(segments, builder.count(3, 1), point, 0, radialFromY, true);
}

/** With `torso`, the sleeve starts on the torso surface instead of inside it and keeps an open cuff. */
function sleeve(
  builder: SurfaceBuilder,
  x0: number,
  x1: number,
  y: number,
  radiusY: number,
  radiusZ: number,
  region: number,
  torso?: TorsoShape,
): void {
  const segments = builder.count(24, 8);
  const point: PointFn = (u, v) => {
    const taper = 1 - 0.18 * v;
    const angle = 2 * Math.PI * u;
    const start = torso
      ? Math.sign(x1) * torsoSurfaceX(y + Math.cos(angle) * radiusY, Math.sin(angle) * radiusZ, torso)
      : x0;
    return [start + (x1 - start) * v, y + Math.cos(angle) * radiusY * taper, Math.sin(angle) * radiusZ * taper];
  };
  builder.grid(segments, builder.count(6, 2), point, 0, (c) => [0, c[1] - y, c[2]], true);
  if (!torso) builder.disc([x1, y, 0], ring(point, 1, segments), region, [Math.sign(x1 - x0), 0, 0]);
}

function torusGrid(builder: SurfaceBuilder, rings: number, sides: number, point: PointFn, outward: (c: Vec3) => Vec3): void {
  const positions: Vec3[] = [];
  const uvs: [number, number][] = [];
  for (let j = 0; j <= sides; j += 1) {
    for (let i = 0; i <= rings; i += 1) {
      positions.push(point((i % rings) / rings, (j % sides) / sides));
      uvs.push([i / rings, j / sides]);
    }
  }
  const faces: [number, number, number][] = [];
  for (let j = 0; j < sides; j += 1) {
    for (let i = 0; i < rings; i += 1) {
      const a = j * (rings + 1) + i;
      const d = a + rings + 1;
      faces.push([a, a + 1, d + 1], [a, d + 1, d]);
    }
  }
  builder.patch(positions, uvs, 0, faces, outward);
}

function torusXZ(builder: SurfaceBuilder, center: Vec3, major: number, minor: number): void {
  const point: PointFn = (u, v) => {
    const a = 2 * Math.PI * u;
    const b = 2 * Math.PI * v;
    const radial = major + minor * Math.cos(b);
    return [center[0] + radial * Math.cos(a), center[1] + minor * Math.sin(b), center[2] + radial * Math.sin(a)];
  };
  torusGrid(builder, builder.count(32, 8), builder.count(10, 4), point, (c) => {
    const dx = c[0] - center[0];
    const dz = c[2] - center[2];
    const length = Math.hypot(dx, dz) || 1;
    return [c[0] - (center[0] + (major * dx) / length), c[1] - center[1], c[2] - (center[2] + (major * dz) / length)];
  });
}

function torusXY(builder: SurfaceBuilder, center: Vec3, majorX: number, majorY: number, minor: number): void {
  const point: PointFn = (u, v) => {
    const a = 2 * Math.PI * u;
    const b = 2 * Math.PI * v;
    return [
      center[0] + majorX * Math.cos(a) + minor * Math.cos(b) * Math.cos(a),
      center[1] + majorY * Math.sin(a) + minor * Math.cos(b) * Math.sin(a),
      center[2] + minor * Math.sin(b),
    ];
  };
  torusGrid(builder, builder.count(36, 8), builder.count(10, 4), point, (c) => {
    const a = Math.atan2((c[1] - center[1]) / majorY, (c[0] - center[0]) / majorX);
    return sub(c, [center[0] + majorX * Math.cos(a), center[1] + majorY * Math.sin(a), center[2]]);
  });
}

/** With `torso`, builds the open hood: no face cap or rolled rim, and no faces hidden inside the torso. */
function hood(
  builder: SurfaceBuilder,
  center: Vec3,
  scale: Vec3,
  opening: number,
  region: number,
  torso?: TorsoShape,
): void {
  const segments = builder.count(36, 8);
  const at = (u: number, alpha: number): Vec3 => {
    const beta = 2 * Math.PI * u;
    return [
      center[0] + scale[0] * Math.sin(alpha) * Math.cos(beta),
      center[1] + scale[1] * Math.sin(alpha) * Math.sin(beta),
      center[2] + scale[2] * Math.cos(alpha),
    ];
  };
  const outward = (c: Vec3) => sub(c, center);
  const body: PointFn = (u, v) => at(u, opening + (Math.PI - opening) * v);
  if (torso) {
    const visible: FaceFilter = (a, b, c) => ![a, b, c].every((p) => insideTorso(p, torso));
    builder.grid(segments, builder.count(20), body, 0, outward, true, undefined, visible);
    return;
  }
  builder.grid(segments, builder.count(20), body, 0, outward, true);
  builder.grid(segments, builder.count(5, 2), (u, v) => at(u, opening * (1 - v)), region, outward, true);
  torusXY(
    builder,
    [center[0], center[1], center[2] + scale[2] * Math.cos(opening)],
    scale[0] * Math.sin(opening),
    scale[1] * Math.sin(opening),
    0.03,
  );
}

function garment(builder: SurfaceBuilder, kind: 'tshirt' | 'puffer' | 'hooded', open: boolean): void {
  const depth = kind === 'puffer' ? 0.25 : 0.2;
  const shape: TorsoShape = { depth, puffer: kind === 'puffer' };
  const torso = open ? shape : undefined;
  garmentTorso(builder, shape, open);
  sleeve(builder, -0.42, -0.94, 1.12, 0.18, depth * 0.75, 3, torso);
  sleeve(builder, 0.42, 0.94, 1.12, 0.18, depth * 0.75, 4, torso);
  if (!open) torusXZ(builder, [0, 1.335, 0], 0.15, 0.035);
  if (kind === 'hooded') hood(builder, [0, 1.5, -0.14], [0.34, 0.38, 0.31], 1, 5, torso);
}

function skirt(builder: SurfaceBuilder, open: boolean): void {
  const segments = builder.count(64, 14);
  const point: PointFn = (u, v) => {
    const a = 2 * Math.PI * u;
    const radius = 0.72 - 0.38 * v + 0.075 * (1 - 0.4 * v) * Math.sin(a * 7);
    return [Math.sin(a) * radius, 0.18 + 1.18 * v, Math.cos(a) * radius];
  };
  builder.grid(segments, builder.count(22), point, 0, radialFromY, true, (u, v) => [u * 2, v]);
  if (open) return;
  builder.disc([0, 1.36, 0], ring(point, 1, segments), 1, [0, 1, 0]);
  builder.disc([0, 0.18, 0], ring(point, 0, segments), 2, [0, -1, 0]);
}

function sheetMetal(builder: SurfaceBuilder, open: boolean): void {
  const nx = builder.count(42, 6);
  const ny = builder.count(24, 4);
  const half = 0.022;
  const panel = (u: number, v: number, offset: number): Vec3 => {
    const uu = u * 2 - 1;
    return [
      uu * (0.92 + 0.08 * v),
      0.25 + 0.82 * v,
      0.29 * (1 - uu * uu) +
        0.11 * Math.sin(v * Math.PI) +
        0.035 * Math.cos(uu * Math.PI * 3) * Math.sin(v * Math.PI) +
        offset,
    ];
  };
  if (open) {
    builder.grid(nx, ny, (u, v) => panel(u, v, 0), 0, () => [0, 0, 1]);
    return;
  }
  builder.grid(nx, ny, (u, v) => panel(u, v, half), 0, () => [0, 0, 1]);
  builder.grid(nx, ny, (u, v) => panel(u, v, -half), BACK_SKIN_REGION, () => [0, 0, -1]);
  const wall =
    (edge: (s: number) => [number, number]): PointFn =>
    (s, t) =>
      panel(...edge(s), -half + 2 * half * t);
  builder.grid(nx, 1, wall((s) => [s, 1]), 1, () => [0, 1, 0]);
  builder.grid(nx, 1, wall((s) => [s, 0]), 2, () => [0, -1, 0]);
  builder.grid(ny, 1, wall((s) => [0, s]), 3, () => [-1, 0, 0]);
  builder.grid(ny, 1, wall((s) => [1, s]), 4, () => [1, 0, 0]);
}

function fishRadius(t: number, angle: number): number {
  if (t <= 0.8) return 0.26 + 0.18 * Math.sin((Math.PI * t) / 0.8) - 0.12 * (t / 0.8) ** 3;
  const s = (t - 0.8) / 0.2;
  return (0.14 + 0.18 * s ** 1.5) * (1 + 0.16 * s * Math.sin(angle * 6));
}

function fish(builder: SurfaceBuilder, open: boolean): void {
  const segments = builder.count(40, 8);
  const point: PointFn = (u, v) => {
    const angle = 2 * Math.PI * u;
    const radius = fishRadius(v, angle);
    return [-0.95 + 1.9 * v, 0.75 + Math.cos(angle) * radius, Math.sin(angle) * radius * 0.78];
  };
  builder.grid(segments, builder.count(30), point, 0, (c) => [0, c[1] - 0.75, c[2]], true, (u, v) => [v * 2, u]);
  if (open) return;
  builder.disc([-0.95, 0.75, 0], ring(point, 0, segments), 1, [-1, 0, 0]);
  builder.disc([0.95, 0.75, 0], ring(point, 1, segments), 2, [1, 0, 0]);
}
