import {
  bindSourceVertices,
  convertSurface,
  type ConvertedSurface,
  type SourceVertexBinding,
} from '../simulation/conversion/convertSurface';
import {
  buildWorkflowSurface,
  filterSurface,
  surfaceBounds,
  workflowAsset,
  type WorkflowAssetId,
  type WorkflowSurface,
} from './workflowAssets';
import { smoothNormals } from './surfaceTopology';
import type { CreatorWorkflowState, WorkflowPath } from './workflowTypes';

export const PROXY_SPACING = 0.06;
export const PLANE_SPACING = 0.06;
/** How far bound points bulge toward the smooth surface implied by proxy normals (Phong tessellation). */
const PHONG_BLEND = 0.75;

/** The creator's inputs: the capped arbitrary mesh (Paths 1-2) and the zero-thickness open surface (Path 3). */
export interface WorkflowSources {
  capped: WorkflowSurface;
  open: WorkflowSurface;
}

export function proceduralWorkflowSources(assetId: WorkflowAssetId, detail = 1): WorkflowSources {
  return {
    capped: buildWorkflowSurface(assetId, detail, 'capped'),
    open: buildWorkflowSurface(assetId, detail, 'open'),
  };
}

export interface WorkflowPathData {
  /** The mesh that renders: the arbitrary mesh for Paths 1-2, the open surface for Path 3. */
  render: WorkflowSurface;
  /** The simulation mesh overlaid on the render mesh. */
  proxy: ConvertedSurface;
  renderBindings: readonly SourceVertexBinding[];
  /** Per render vertex offset from its bound point, in the smooth (tangent, bitangent, normal) frame there. */
  bindingOffsets: Float32Array;
  /** Identity weld map and per-frame normal scratch for the (already welded) proxy. */
  proxyCanonical: Uint32Array;
  proxyNormals: Float32Array;
}

export function buildWorkflowPathData(
  state: CreatorWorkflowState,
  path: WorkflowPath,
  sources: WorkflowSources,
): WorkflowPathData {
  if (path === 'plane') {
    const proxy = planeProxy(sources.capped, workflowAsset(state.assetId).planeDepth);
    return bind(sources.capped, proxy, PLANE_SPACING);
  }
  if (path === 'thicken') {
    const render = sources.open;
    return bind(render, convertSurface({ ...render, targetSpacing: PROXY_SPACING }), PROXY_SPACING);
  }
  const caps = new Set(state.endCaps);
  const simulated = filterSurface(sources.capped, (region) => !caps.has(region));
  return bind(sources.capped, convertSurface({ ...simulated, targetSpacing: PROXY_SPACING }), PROXY_SPACING);
}

/**
 * Path 2's creator mesh: one flat grid at `depth`, trimmed to the cells the
 * arbitrary mesh covers (plus one cell of margin) so no plane flaps over empty space.
 */
export function planeProxy(surface: WorkflowSurface, depth: number): ConvertedSurface {
  const { min, max } = surfaceBounds(surface.positions);
  const margin = 0.03;
  const width = max[0] - min[0] + margin * 2;
  const height = max[1] - min[1] + margin * 2;
  const nx = Math.max(2, Math.ceil(width / PLANE_SPACING));
  const ny = Math.max(2, Math.ceil(height / PLANE_SPACING));
  const x0 = min[0] - margin;
  const y0 = min[1] - margin;
  const covered = new Uint8Array(nx * ny);
  for (let index = 0; index < surface.positions.length; index += 3) {
    const i = Math.min(nx - 1, Math.floor(((surface.positions[index] - x0) / width) * nx));
    const j = Math.min(ny - 1, Math.floor(((surface.positions[index + 1] - y0) / height) * ny));
    covered[j * nx + i] = 1;
  }
  const keep = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      if (!covered[j * nx + i]) continue;
      for (let dj = -1; dj <= 1; dj += 1) {
        for (let di = -1; di <= 1; di += 1) {
          const ii = i + di;
          const jj = j + dj;
          if (ii >= 0 && ii < nx && jj >= 0 && jj < ny) keep[jj * nx + ii] = 1;
        }
      }
    }
  }
  const remap = new Int32Array((nx + 1) * (ny + 1)).fill(-1);
  const positions: number[] = [];
  const vertex = (i: number, j: number): number => {
    const key = j * (nx + 1) + i;
    if (remap[key] < 0) {
      remap[key] = positions.length / 3;
      positions.push(x0 + (width * i) / nx, y0 + (height * j) / ny, depth);
    }
    return remap[key];
  };
  const triangles: number[] = [];
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      if (!keep[j * nx + i]) continue;
      const a = vertex(i, j);
      const b = vertex(i + 1, j);
      const c = vertex(i + 1, j + 1);
      const d = vertex(i, j + 1);
      triangles.push(a, b, c, a, c, d);
    }
  }
  return convertSurface({
    positions: new Float32Array(positions),
    triangles: new Uint32Array(triangles),
    targetSpacing: Math.min(width / nx, height / ny) * 0.5,
  });
}

function bind(render: WorkflowSurface, proxy: ConvertedSurface, spacing: number): WorkflowPathData {
  const renderBindings = bindSourceVertices(render.positions, proxy.positions, proxy.triangles, spacing);
  const count = proxy.positions.length / 3;
  const data = {
    render,
    proxy,
    renderBindings,
    bindingOffsets: new Float32Array(render.positions.length),
    proxyCanonical: Uint32Array.from({ length: count }, (_, index) => index),
    proxyNormals: new Float32Array(proxy.positions.length),
  };
  localBindingOffsets(render.positions, data);
  return data;
}

/**
 * Smooth frame at a binding: the point blends the flat barycentric point with its
 * Phong-tessellated projection onto the vertex tangent planes, the normal is the
 * interpolated vertex normal, and the tangent follows the triangle's first edge.
 * Both vary continuously across proxy edges, so the render mesh shows no facets.
 */
function boundFrame(
  particles: ArrayLike<number>,
  normals: Float32Array,
  triangles: Uint32Array,
  binding: SourceVertexBinding,
  point: Float64Array,
  frame: Float64Array,
): void {
  const corners = [triangles[binding.triangle * 3] * 3, triangles[binding.triangle * 3 + 1] * 3, triangles[binding.triangle * 3 + 2] * 3];
  const weights = binding.barycentric;
  let lx = 0, ly = 0, lz = 0, nx = 0, ny = 0, nz = 0;
  for (let k = 0; k < 3; k += 1) {
    const o = corners[k];
    lx += particles[o] * weights[k];
    ly += particles[o + 1] * weights[k];
    lz += particles[o + 2] * weights[k];
    nx += normals[o] * weights[k];
    ny += normals[o + 1] * weights[k];
    nz += normals[o + 2] * weights[k];
  }
  let px = 0, py = 0, pz = 0;
  for (let k = 0; k < 3; k += 1) {
    const o = corners[k];
    const height = (lx - particles[o]) * normals[o] + (ly - particles[o + 1]) * normals[o + 1] + (lz - particles[o + 2]) * normals[o + 2];
    px += (lx - height * normals[o]) * weights[k];
    py += (ly - height * normals[o + 1]) * weights[k];
    pz += (lz - height * normals[o + 2]) * weights[k];
  }
  point[0] = lx + (px - lx) * PHONG_BLEND;
  point[1] = ly + (py - ly) * PHONG_BLEND;
  point[2] = lz + (pz - lz) * PHONG_BLEND;

  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  let ex = particles[corners[1]] - particles[corners[0]];
  let ey = particles[corners[1] + 1] - particles[corners[0] + 1];
  let ez = particles[corners[1] + 2] - particles[corners[0] + 2];
  const along = ex * nx + ey * ny + ez * nz;
  ex -= along * nx;
  ey -= along * ny;
  ez -= along * nz;
  const el = Math.hypot(ex, ey, ez) || 1;
  ex /= el;
  ey /= el;
  ez /= el;
  frame[0] = ex;
  frame[1] = ey;
  frame[2] = ez;
  frame[3] = ny * ez - nz * ey;
  frame[4] = nz * ex - nx * ez;
  frame[5] = nx * ey - ny * ex;
  frame[6] = nx;
  frame[7] = ny;
  frame[8] = nz;
}

function localBindingOffsets(source: Float32Array, data: WorkflowPathData): void {
  const { proxy, renderBindings, bindingOffsets: offsets } = data;
  const normals = smoothNormals(proxy.positions, proxy.triangles, data.proxyCanonical, data.proxyNormals);
  const point = new Float64Array(3);
  const frame = new Float64Array(9);
  for (let index = 0; index < renderBindings.length; index += 1) {
    boundFrame(proxy.positions, normals, proxy.triangles, renderBindings[index], point, frame);
    const dx = source[index * 3] - point[0];
    const dy = source[index * 3 + 1] - point[1];
    const dz = source[index * 3 + 2] - point[2];
    for (let axis = 0; axis < 3; axis += 1) {
      offsets[index * 3 + axis] = dx * frame[axis * 3] + dy * frame[axis * 3 + 1] + dz * frame[axis * 3 + 2];
    }
  }
}

/** Reconstructs bound render positions from current particle positions. */
export function applyBindings(
  particles: ArrayLike<number>,
  data: Pick<WorkflowPathData, 'proxy' | 'renderBindings' | 'bindingOffsets' | 'proxyCanonical' | 'proxyNormals'>,
  out: Float32Array,
  boundPoints?: Float32Array,
): Float32Array {
  const { renderBindings, bindingOffsets, proxy } = data;
  const normals = smoothNormals(particles, proxy.triangles, data.proxyCanonical, data.proxyNormals);
  const point = new Float64Array(3);
  const frame = new Float64Array(9);
  for (let index = 0; index < renderBindings.length; index += 1) {
    boundFrame(particles, normals, proxy.triangles, renderBindings[index], point, frame);
    const ox = bindingOffsets[index * 3];
    const oy = bindingOffsets[index * 3 + 1];
    const oz = bindingOffsets[index * 3 + 2];
    for (let axis = 0; axis < 3; axis += 1) {
      if (boundPoints) boundPoints[index * 3 + axis] = point[axis];
      out[index * 3 + axis] = point[axis] + ox * frame[axis] + oy * frame[3 + axis] + oz * frame[6 + axis];
    }
  }
  return out;
}

/** Proxy particle count, used by the build-step readouts. */
export function proxyParticleCount(data: WorkflowPathData): number {
  return data.proxy.positions.length / 3;
}
