import { PLATFORM_HALF } from '../scene';

/** Procedural cloth surfaces. Ids are stable preset keys. */
export const SOURCE_MESH_IDS = ['tshirt', 'curtain', 'car-shell'] as const;

export type SourceMeshId = (typeof SOURCE_MESH_IDS)[number];

export interface SourceMeshMetadata {
  id: SourceMeshId;
  label: string;
  description: string;
  /** sRGB hex, matching material presets. */
  color: number;
  /** Rest thickness in metres, used as the shell contact gap. */
  defaultThickness: number;
  /** Display depth of the rigid source solid before it is converted to a thin shell. */
  solidThickness: number;
}

/** Indexed triangle surface sitting just above the platform. */
export interface SourceMesh extends SourceMeshMetadata {
  positions: Float32Array;
  triangles: Uint32Array;
}

const METADATA: Record<SourceMeshId, Omit<SourceMeshMetadata, 'id'>> = {
  tshirt: {
    label: 'T-shirt',
    description: 'Rigid T-shirt-shaped solid with a scooped neck and short sleeves.',
    color: 0x3e7cb1,
    defaultThickness: 0.008,
    solidThickness: 0.14,
  },
  curtain: {
    label: 'Curtain',
    description: 'Rigid curtain-shaped solid with deep vertical folds.',
    color: 0xc4a574,
    defaultThickness: 0.006,
    solidThickness: 0.1,
  },
  'car-shell': {
    label: 'Car shell',
    description: 'Rigid car-body-shaped solid with a hood, cabin, trunk, and wheel arches.',
    color: 0xb23a2f,
    defaultThickness: 0.018,
    solidThickness: 0.12,
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
  const built = id === 'tshirt' ? buildTshirt() : id === 'curtain' ? buildCurtain() : buildCarShell();
  placeOverPlatform(built.positions, metadata.solidThickness * 0.5 + 0.01);
  return {
    ...metadata,
    positions: new Float32Array(built.positions),
    triangles: new Uint32Array(built.triangles),
  };
}

interface BuiltMesh {
  positions: number[];
  triangles: number[];
}

function placeOverPlatform(positions: number[], clearance: number): void {
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
  const shiftX = -0.5 * (minX + maxX);
  const shiftY = clearance - minY;
  const shiftZ = -0.5 * (minZ + maxZ);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += shiftX;
    positions[i + 1] += shiftY;
    positions[i + 2] += shiftZ;
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (Math.abs(x) > PLATFORM_HALF || Math.abs(z) > PLATFORM_HALF || y < 0) {
      throw new Error('Source mesh does not sit on the platform');
    }
  }
}

/** Keep a quad only when every corner is accepted, so the mask stays a manifold surface. */
function rasterize(
  nu: number,
  nv: number,
  point: (iu: number, iv: number) => [number, number, number] | null,
): BuiltMesh {
  const positions: number[] = [];
  const triangles: number[] = [];
  const index = new Map<number, number>();
  const key = (iu: number, iv: number) => iu * (nv + 1) + iv;
  const vertex = (iu: number, iv: number): number => {
    const id = key(iu, iv);
    const existing = index.get(id);
    if (existing !== undefined) return existing;
    const p = point(iu, iv);
    if (!p) throw new Error('Raster corner was not accepted');
    const next = positions.length / 3;
    positions.push(p[0], p[1], p[2]);
    index.set(id, next);
    return next;
  };
  for (let iu = 0; iu < nu; iu++) {
    for (let iv = 0; iv < nv; iv++) {
      if (!point(iu, iv) || !point(iu, iv + 1) || !point(iu + 1, iv + 1) || !point(iu + 1, iv)) continue;
      const a = vertex(iu, iv);
      const b = vertex(iu, iv + 1);
      const c = vertex(iu + 1, iv + 1);
      const d = vertex(iu + 1, iv);
      triangles.push(a, b, c, a, c, d);
    }
  }
  return { positions, triangles };
}

function buildTshirt(): BuiltMesh {
  const x0 = -0.86;
  const x1 = 0.86;
  const z0 = -0.52;
  const z1 = 0.4;
  const bodyHalf = 0.28;
  const nx = 72;
  const nz = 48;
  const neckZ = z1 - 0.12;
  const xOf = (iu: number) => x0 + ((x1 - x0) * iu) / nx;
  const zOf = (iv: number) => z0 + ((z1 - z0) * iv) / nz;
  const inside = (x: number, z: number): boolean => {
    const ax = Math.abs(x);
    if (z < z0 || z > z1) return false;
    if (ax > bodyHalf) {
      const reach = (ax - bodyHalf) / (x1 - bodyHalf);
      if (reach > 1) return false;
      const zTop = z1 - 0.03 * reach;
      const zBot = 0.05 + 0.12 * reach;
      if (z < zBot || z > zTop) return false;
    }
    const dx = x / 0.11;
    const dz = (z - neckZ) / 0.07;
    return dx * dx + dz * dz > 1;
  };
  return rasterize(nx, nz, (iu, iv) => {
    const x = xOf(iu);
    const z = zOf(iv);
    if (!inside(x, z)) return null;
    const ax = Math.abs(x);
    let y = 0.04 * ((z - z0) / (z1 - z0));
    y += 0.012 * Math.sin(x * 7) * Math.sin(z * 6);
    if (ax > bodyHalf) {
      const reach = (ax - bodyHalf) / (x1 - bodyHalf);
      y -= 0.1 * reach * reach;
    }
    return [x, y, z];
  });
}

function buildCurtain(): BuiltMesh {
  const halfWidth = 1.08;
  const height = 1.42;
  const nx = 84;
  const ny = 42;
  const waves = 4;
  return rasterize(nx, ny, (iu, iv) => {
    const u = iu / nx;
    const v = iv / ny;
    const gather = 0.52 + 0.48 * (1 - v);
    const x = (u * 2 - 1) * halfWidth * gather;
    const y = height * v;
    const amplitude = 0.22 * (0.12 + 0.88 * (1 - v));
    const z = amplitude * Math.sin(u * waves * Math.PI * 2);
    return [x, y, z];
  });
}

interface CarStation {
  x: number;
  roofY: number;
  sillY: number;
  halfWidth: number;
  roofHalf: number;
}

const CAR_STATIONS: readonly CarStation[] = [
  { x: -1.12, roofY: 0.28, sillY: 0.1, halfWidth: 0.34, roofHalf: 0.2 },
  { x: -0.86, roofY: 0.42, sillY: 0.11, halfWidth: 0.44, roofHalf: 0.28 },
  { x: -0.55, roofY: 0.5, sillY: 0.11, halfWidth: 0.47, roofHalf: 0.32 },
  { x: -0.28, roofY: 0.74, sillY: 0.12, halfWidth: 0.47, roofHalf: 0.34 },
  { x: 0.12, roofY: 0.76, sillY: 0.12, halfWidth: 0.48, roofHalf: 0.36 },
  { x: 0.36, roofY: 0.62, sillY: 0.12, halfWidth: 0.47, roofHalf: 0.33 },
  { x: 0.58, roofY: 0.4, sillY: 0.11, halfWidth: 0.46, roofHalf: 0.3 },
  { x: 0.86, roofY: 0.34, sillY: 0.1, halfWidth: 0.42, roofHalf: 0.24 },
  { x: 1.12, roofY: 0.22, sillY: 0.09, halfWidth: 0.32, roofHalf: 0.16 },
];

const WHEEL_ARCHES: readonly { x: number; y: number; radius: number }[] = [
  { x: -0.7, y: 0.36, radius: 0.13 },
  { x: 0.72, y: 0.36, radius: 0.13 },
];

function carStation(x: number): CarStation {
  if (x <= CAR_STATIONS[0].x) return CAR_STATIONS[0];
  const last = CAR_STATIONS[CAR_STATIONS.length - 1];
  if (x >= last.x) return last;
  let hi = 1;
  while (CAR_STATIONS[hi].x < x) hi++;
  const a = CAR_STATIONS[hi - 1];
  const b = CAR_STATIONS[hi];
  const t = (x - a.x) / (b.x - a.x);
  return {
    x,
    roofY: a.roofY + (b.roofY - a.roofY) * t,
    sillY: a.sillY + (b.sillY - a.sillY) * t,
    halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * t,
    roofHalf: a.roofHalf + (b.roofHalf - a.roofHalf) * t,
  };
}

function carSection(t: number, station: CarStation): { y: number; z: number } {
  const sideEnd = 0.46;
  const glassEnd = 0.74;
  const belt = station.sillY + (station.roofY - station.sillY) * 0.48;
  if (t <= sideEnd) {
    const s = t / sideEnd;
    return {
      y: station.sillY + (belt - station.sillY) * s,
      z: station.halfWidth * (0.88 + 0.12 * Math.sin(s * Math.PI)),
    };
  }
  if (t <= glassEnd) {
    const s = (t - sideEnd) / (glassEnd - sideEnd);
    const smooth = s * s * (3 - 2 * s);
    return {
      y: belt + (station.roofY - belt) * smooth,
      z: station.halfWidth + (station.roofHalf - station.halfWidth) * smooth,
    };
  }
  const s = (t - glassEnd) / (1 - glassEnd);
  const crown = s * s * (3 - 2 * s);
  return {
    y: station.roofY - 0.02 * (1 - crown) * (1 - crown),
    z: station.roofHalf * (1 - crown),
  };
}

function inWheelArch(x: number, y: number, z: number, halfWidth: number): boolean {
  if (Math.abs(z) < halfWidth * 0.62) return false;
  for (const arch of WHEEL_ARCHES) {
    const dx = x - arch.x;
    const dy = y - arch.y;
    if (dx * dx + dy * dy <= arch.radius * arch.radius) return true;
  }
  return false;
}

function buildCarShell(): BuiltMesh {
  const nu = 64;
  const nv = 28;
  const x0 = CAR_STATIONS[0].x;
  const x1 = CAR_STATIONS[CAR_STATIONS.length - 1].x;
  return rasterize(nu, nv, (iu, iv) => {
    const u = iu / nu;
    const v = iv / nv;
    const x = x0 + (x1 - x0) * u;
    const station = carStation(x);
    const side = v <= 0.5 ? -1 : 1;
    const t = v <= 0.5 ? v * 2 : (1 - v) * 2;
    const section = carSection(t, station);
    const y = section.y;
    const z = side * section.z;
    if (inWheelArch(x, y, z, station.halfWidth)) return null;
    return [x, y, z];
  });
}
