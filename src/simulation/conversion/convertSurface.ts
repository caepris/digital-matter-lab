/** Indexed triangle surface. `triangles` holds three vertex indices per face. */
export interface IndexedTriangleSurface {
  positions: Float32Array;
  triangles: Uint32Array;
}

export interface SurfaceConversionInput extends IndexedTriangleSurface {
  /** Target distance between simulation vertices, in the same units as `positions`. */
  targetSpacing: number;
  /**
   * Vertices no farther than this are merged before clustering.
   * Defaults to a small fraction of `targetSpacing`.
   */
  weldEpsilon?: number;
}

/** Attachment of one source vertex to the reduced simulation surface. */
export interface SourceVertexBinding {
  /** Index of the closest simulation triangle. */
  triangle: number;
  /** Weights of that triangle's three vertices. Non-negative and summing to 1. */
  barycentric: readonly [number, number, number];
}

/**
 * Simulation-ready shell: a compacted triangle surface plus the distance pairs
 * a cloth solver needs, and a binding from every input vertex back onto it.
 */
export interface ConvertedSurface {
  positions: Float32Array;
  triangles: Uint32Array;
  /** Unique undirected edges, packed as vertex-index pairs. */
  stretchPairs: Uint32Array;
  /** The two vertices opposite each interior edge, packed as pairs. */
  bendPairs: Uint32Array;
  /** Edges with a single incident triangle, packed as vertex-index pairs. */
  boundaryPairs: Uint32Array;
  /** One binding per source vertex, in source order. */
  sourceBindings: readonly SourceVertexBinding[];
}

interface Path {
  vertices: number[];
  closed: boolean;
}

/**
 * Welds coincident vertices, clusters the surface down toward `targetSpacing`,
 * and returns a manifold shell plus per-source-vertex barycentric bindings.
 * Clusters are merged along edges, and boundary loops are not sealed shut.
 */
export function convertSurface(input: SurfaceConversionInput): ConvertedSurface {
  const { positions, triangles, targetSpacing } = input;
  validate(input);
  const weldEpsilon = input.weldEpsilon ?? Math.min(1e-4, targetSpacing * 1e-4);
  const welded = weldVertices(positions, weldEpsilon);
  const weldedTriangles = dedupeTriangles(remapTriangles(triangles, welded.of));
  if (weldedTriangles.length === 0) throw new Error('Surface has no triangles after welding');

  const simplified = simplifyByClustering(welded.positions, weldedTriangles, targetSpacing);
  let nextTriangles = filterTriangles(simplified.triangles, simplified.positions);
  nextTriangles = limitIncidence(nextTriangles, simplified.positions);
  if (nextTriangles.length === 0) throw new Error('Surface has no triangles after clustering');

  const compact = compactVertices(simplified.positions, nextTriangles);
  const pairs = edgePairs(compact.triangles);
  return {
    positions: compact.positions,
    triangles: compact.triangles,
    stretchPairs: pairs.stretchPairs,
    bendPairs: pairs.bendPairs,
    boundaryPairs: pairs.boundaryPairs,
    sourceBindings: bindSources(positions, compact.positions, compact.triangles),
  };
}

function validate(input: SurfaceConversionInput): void {
  const { positions, triangles, targetSpacing, weldEpsilon } = input;
  if (!(positions instanceof Float32Array) || positions.length === 0 || positions.length % 3 !== 0) {
    throw new Error('positions must be a non-empty Float32Array of xyz triples');
  }
  if (!(triangles instanceof Uint32Array) || triangles.length === 0 || triangles.length % 3 !== 0) {
    throw new Error('triangles must be a non-empty Uint32Array of index triples');
  }
  if (!Number.isFinite(targetSpacing) || targetSpacing <= 0) {
    throw new Error('targetSpacing must be a positive finite number');
  }
  if (weldEpsilon !== undefined && (!Number.isFinite(weldEpsilon) || weldEpsilon < 0)) {
    throw new Error('weldEpsilon must be a non-negative finite number');
  }
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new Error('positions must be finite');
  }
  const vertexCount = positions.length / 3;
  for (let i = 0; i < triangles.length; i++) {
    const index = triangles[i];
    if (index >= vertexCount) throw new Error('triangle index out of range');
  }
}

function weldVertices(positions: Float32Array, epsilon: number): { positions: Float64Array; of: Uint32Array } {
  const count = positions.length / 3;
  const of = new Uint32Array(count);
  const welded: number[] = [];
  if (epsilon === 0) {
    const exact = new Map<string, number>();
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const key = `${x},${y},${z}`;
      const found = exact.get(key);
      if (found !== undefined) {
        of[i] = found;
        continue;
      }
      of[i] = welded.length / 3;
      exact.set(key, of[i]);
      welded.push(x, y, z);
    }
    return { positions: Float64Array.from(welded), of };
  }

  const inverse = 1 / epsilon;
  const buckets = new Map<string, number[]>();
  const cell = (value: number) => Math.floor(value * inverse);
  const bucketKey = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const ix = cell(x);
    const iy = cell(y);
    const iz = cell(z);
    let match = -1;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const list = buckets.get(bucketKey(ix + dx, iy + dy, iz + dz));
          if (!list) continue;
          for (const candidate of list) {
            if (candidate >= match && match !== -1) continue;
            const dxp = welded[candidate * 3] - x;
            const dyp = welded[candidate * 3 + 1] - y;
            const dzp = welded[candidate * 3 + 2] - z;
            if (dxp * dxp + dyp * dyp + dzp * dzp <= epsilon * epsilon) match = candidate;
          }
        }
      }
    }
    if (match >= 0) {
      of[i] = match;
      continue;
    }
    const created = welded.length / 3;
    of[i] = created;
    welded.push(x, y, z);
    const key = bucketKey(ix, iy, iz);
    const list = buckets.get(key);
    if (list) list.push(created);
    else buckets.set(key, [created]);
  }
  return { positions: Float64Array.from(welded), of };
}

function remapTriangles(triangles: Uint32Array, map: Uint32Array | Int32Array): number[] {
  const out: number[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    out.push(map[triangles[t]], map[triangles[t + 1]], map[triangles[t + 2]]);
  }
  return out;
}

function dedupeTriangles(triangles: number[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t];
    const b = triangles[t + 1];
    const c = triangles[t + 2];
    if (a === b || b === c || c === a) continue;
    const key = tripleKey(a, b, c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a, b, c);
  }
  return out;
}

function tripleKey(a: number, b: number, c: number): string {
  if (a > b) {
    const swap = a;
    a = b;
    b = swap;
  }
  if (b > c) {
    const swap = b;
    b = c;
    c = swap;
  }
  if (a > b) {
    const swap = a;
    a = b;
    b = swap;
  }
  return `${a}:${b}:${c}`;
}

interface CollapsePlan {
  keep: number;
  drop: number;
  x: number;
  y: number;
  z: number;
  boundaryEdge: boolean;
  loop: number;
}

interface HeapItem {
  len: number;
  a: number;
  b: number;
  gen: number;
}

/**
 * Merges vertices across edges shorter than `spacing`. Each merge keeps the
 * cluster inside a ball of radius `spacing`, and boundary loops stay at least
 * a triangle so openings are not sealed.
 */
function simplifyByClustering(
  source: Float64Array,
  sourceTriangles: number[],
  spacing: number,
): { positions: Float64Array; triangles: number[] } {
  const vertexCount = source.length / 3;
  const positions = Float64Array.from(source);
  const radius = new Float64Array(vertexCount);
  const alive = new Uint8Array(vertexCount).fill(1);
  const boundary = new Uint8Array(vertexCount);
  const generation = new Int32Array(vertexCount);
  const corners = sourceTriangles.slice();
  const faceAlive = new Uint8Array(sourceTriangles.length / 3).fill(1);
  const vertexTriangles: number[][] = Array.from({ length: vertexCount }, () => []);
  const neighbors: Array<Set<number>> = Array.from({ length: vertexCount }, () => new Set());
  const faces = new Map<string, number>();

  for (let t = 0; t < faceAlive.length; t++) {
    const a = corners[t * 3];
    const b = corners[t * 3 + 1];
    const c = corners[t * 3 + 2];
    vertexTriangles[a].push(t);
    vertexTriangles[b].push(t);
    vertexTriangles[c].push(t);
    faces.set(tripleKey(a, b, c), t);
  }
  for (let vertex = 0; vertex < vertexCount; vertex++) refreshVertex(vertex);

  const loopOf = new Int32Array(vertexCount).fill(-1);
  const loopSize: number[] = [];
  const loopMin: number[] = [];
  for (const path of boundaryPaths(sourceTriangles)) {
    const loop = loopSize.length;
    loopSize.push(path.vertices.length);
    loopMin.push(path.closed ? Math.min(3, path.vertices.length) : Math.min(2, path.vertices.length));
    for (const vertex of path.vertices) loopOf[vertex] = loop;
  }

  const heap: HeapItem[] = [];
  const pushEdge = (a: number, b: number) => {
    if (!alive[a] || !alive[b] || a === b) return;
    if (a > b) {
      const swap = a;
      a = b;
      b = swap;
    }
    const len = distance(positions, a, b);
    if (!(len < spacing)) return;
    heapPush(heap, { len, a, b, gen: generation[a] + generation[b] });
  };
  for (let t = 0; t < faceAlive.length; t++) {
    pushEdge(corners[t * 3], corners[t * 3 + 1]);
    pushEdge(corners[t * 3 + 1], corners[t * 3 + 2]);
    pushEdge(corners[t * 3 + 2], corners[t * 3]);
  }

  let collapsed = 0;
  while (heap.length > 0 && collapsed < vertexCount) {
    const item = heapPop(heap);
    if (!alive[item.a] || !alive[item.b]) continue;
    if (generation[item.a] + generation[item.b] !== item.gen) continue;
    if (!(distance(positions, item.a, item.b) < spacing)) continue;
    const plan = planCollapse(item.a, item.b);
    if (!plan) continue;
    applyCollapse(plan);
    collapsed++;
  }

  const triangles: number[] = [];
  for (let t = 0; t < faceAlive.length; t++) {
    if (!faceAlive[t]) continue;
    triangles.push(corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2]);
  }
  return { positions, triangles };

  function refreshVertex(vertex: number): void {
    const next: number[] = [];
    const adjacent = new Set<number>();
    const uses = new Map<number, number>();
    for (const triangle of vertexTriangles[vertex]) {
      if (!faceAlive[triangle]) continue;
      const base = triangle * 3;
      const ids = [corners[base], corners[base + 1], corners[base + 2]];
      if (ids[0] !== vertex && ids[1] !== vertex && ids[2] !== vertex) continue;
      next.push(triangle);
      for (const id of ids) {
        if (id === vertex) continue;
        adjacent.add(id);
        uses.set(id, (uses.get(id) ?? 0) + 1);
      }
    }
    vertexTriangles[vertex] = next;
    neighbors[vertex] = adjacent;
    let boundaryEdges = 0;
    for (const count of uses.values()) if (count === 1) boundaryEdges++;
    boundary[vertex] = boundaryEdges > 0 ? 1 : 0;
  }

  function planCollapse(a: number, b: number): CollapsePlan | null {
    if (!neighbors[a].has(b)) return null;
    let common = 0;
    for (const neighbor of neighbors[a]) {
      if (neighbor !== b && neighbors[b].has(neighbor)) common++;
    }
    let opposite = 0;
    for (const triangle of vertexTriangles[a]) {
      if (!faceAlive[triangle]) continue;
      const base = triangle * 3;
      const ids = [corners[base], corners[base + 1], corners[base + 2]];
      if ((ids[0] === b || ids[1] === b || ids[2] === b) && (ids[0] === a || ids[1] === a || ids[2] === a)) opposite++;
    }
    if (opposite < 1 || opposite > 2 || common !== opposite) return null;

    const aBoundary = boundary[a] === 1;
    const bBoundary = boundary[b] === 1;
    const boundaryEdge = opposite === 1;
    if (aBoundary && bBoundary && !boundaryEdge) return null;

    let loop = -1;
    if (boundaryEdge) {
      loop = loopOf[a];
      if (loop < 0 || loopOf[b] !== loop || loopSize[loop] <= loopMin[loop]) return null;
    }

    const keep = aBoundary !== bBoundary ? (aBoundary ? a : b) : Math.min(a, b);
    const drop = keep === a ? b : a;
    const slide = boundaryEdge || (!aBoundary && !bBoundary);
    const x = slide ? (positions[a * 3] + positions[b * 3]) / 2 : positions[keep * 3];
    const y = slide ? (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2 : positions[keep * 3 + 1];
    const z = slide ? (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2 : positions[keep * 3 + 2];
    const reachA = Math.hypot(positions[a * 3] - x, positions[a * 3 + 1] - y, positions[a * 3 + 2] - z) + radius[a];
    const reachB = Math.hypot(positions[b * 3] - x, positions[b * 3 + 1] - y, positions[b * 3 + 2] - z) + radius[b];
    if (Math.max(reachA, reachB) > spacing) return null;
    return { keep, drop, x, y, z, boundaryEdge, loop };
  }

  function applyCollapse(plan: CollapsePlan): void {
    const { keep, drop } = plan;
    const affected = new Set<number>([keep, drop]);
    for (const neighbor of neighbors[keep]) affected.add(neighbor);
    for (const neighbor of neighbors[drop]) affected.add(neighbor);

    const nextRadius = Math.max(planReach(keep, plan.x, plan.y, plan.z), planReach(drop, plan.x, plan.y, plan.z));
    positions[keep * 3] = plan.x;
    positions[keep * 3 + 1] = plan.y;
    positions[keep * 3 + 2] = plan.z;
    radius[keep] = nextRadius;

    for (const triangle of vertexTriangles[drop]) {
      if (!faceAlive[triangle]) continue;
      const base = triangle * 3;
      const previous = [corners[base], corners[base + 1], corners[base + 2]];
      for (let k = 0; k < 3; k++) if (corners[base + k] === drop) corners[base + k] = keep;
      const next = [corners[base], corners[base + 1], corners[base + 2]];
      faces.delete(tripleKey(previous[0], previous[1], previous[2]));
      if (next[0] === next[1] || next[1] === next[2] || next[2] === next[0]) {
        faceAlive[triangle] = 0;
        continue;
      }
      const key = tripleKey(next[0], next[1], next[2]);
      if (faces.has(key)) {
        faceAlive[triangle] = 0;
        continue;
      }
      faces.set(key, triangle);
      vertexTriangles[keep].push(triangle);
    }

    alive[drop] = 0;
    vertexTriangles[drop] = [];
    neighbors[drop] = new Set();
    if (plan.boundaryEdge && plan.loop >= 0) loopSize[plan.loop]--;
    loopOf[drop] = -1;

    for (const vertex of affected) {
      if (!alive[vertex]) continue;
      refreshVertex(vertex);
      generation[vertex]++;
    }
    for (const vertex of affected) {
      if (!alive[vertex]) continue;
      for (const neighbor of neighbors[vertex]) pushEdge(vertex, neighbor);
    }
  }

  function planReach(vertex: number, x: number, y: number, z: number): number {
    return Math.hypot(positions[vertex * 3] - x, positions[vertex * 3 + 1] - y, positions[vertex * 3 + 2] - z) + radius[vertex];
  }
}

function heapPush(heap: HeapItem[], item: HeapItem): void {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!heapBefore(heap[index], heap[parent])) break;
    const swap = heap[parent];
    heap[parent] = heap[index];
    heap[index] = swap;
    index = parent;
  }
}

function heapPop(heap: HeapItem[]): HeapItem {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0 && last) {
    heap[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;
      if (left < heap.length && heapBefore(heap[left], heap[best])) best = left;
      if (right < heap.length && heapBefore(heap[right], heap[best])) best = right;
      if (best === index) break;
      const swap = heap[best];
      heap[best] = heap[index];
      heap[index] = swap;
      index = best;
    }
  }
  return top;
}

function heapBefore(a: HeapItem, b: HeapItem): boolean {
  if (a.len !== b.len) return a.len < b.len;
  if (a.a !== b.a) return a.a < b.a;
  return a.b < b.b;
}

function boundaryPaths(triangles: number[]): Path[] {
  const counts = new Map<string, { a: number; b: number; count: number }>();
  for (let t = 0; t < triangles.length; t += 3) {
    const ids = [triangles[t], triangles[t + 1], triangles[t + 2]];
    for (let k = 0; k < 3; k++) {
      const a = ids[k];
      const b = ids[(k + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { a: Math.min(a, b), b: Math.max(a, b), count: 1 });
    }
  }
  const neighbors = new Map<number, number[]>();
  for (const edge of counts.values()) {
    if (edge.count !== 1) continue;
    pushNeighbor(neighbors, edge.a, edge.b);
    pushNeighbor(neighbors, edge.b, edge.a);
  }
  return tracePaths(neighbors);
}

function pushNeighbor(neighbors: Map<number, number[]>, from: number, to: number): void {
  const list = neighbors.get(from);
  if (list) list.push(to);
  else neighbors.set(from, [to]);
}

function tracePaths(neighbors: Map<number, number[]>): Path[] {
  const remaining = new Map<number, Set<number>>();
  for (const [vertex, list] of neighbors) remaining.set(vertex, new Set(list));
  const paths: Path[] = [];
  const starts = [...remaining.keys()].sort((a, b) => a - b);
  for (const start of starts) {
    const pool = remaining.get(start);
    while (pool && pool.size > 0) {
      const vertices = [start];
      let previous = -1;
      let current = start;
      let closed = false;
      const guardMax = neighbors.size * 4 + 8;
      for (let guard = 0; guard < guardMax; guard++) {
        const options = [...(remaining.get(current) ?? [])].sort((a, b) => a - b);
        const next = options.find((candidate) => candidate !== previous) ?? options[0];
        if (next === undefined) break;
        remaining.get(current)?.delete(next);
        remaining.get(next)?.delete(current);
        if (next === start) {
          closed = true;
          break;
        }
        vertices.push(next);
        previous = current;
        current = next;
      }
      if (vertices.length >= 2) paths.push({ vertices, closed });
    }
  }
  return paths;
}

function filterTriangles(triangles: number[], positions: Float64Array): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t];
    const b = triangles[t + 1];
    const c = triangles[t + 2];
    if (a === b || b === c || c === a) continue;
    if (a < 0 || b < 0 || c < 0) continue;
    if (triangleArea2(positions, a, b, c) <= 1e-20) continue;
    const key = tripleKey(a, b, c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a, b, c);
  }
  return out;
}

function limitIncidence(triangles: number[], positions: Float64Array): number[] {
  let active = triangles;
  const maxPasses = triangles.length / 3 + 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    const incident = new Map<string, number[]>();
    const triangleCount = active.length / 3;
    for (let t = 0; t < triangleCount; t++) {
      const ids = [active[t * 3], active[t * 3 + 1], active[t * 3 + 2]];
      for (let k = 0; k < 3; k++) {
        const a = ids[k];
        const b = ids[(k + 1) % 3];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        const list = incident.get(key);
        if (list) list.push(t);
        else incident.set(key, [t]);
      }
    }
    let victimEdge: string | null = null;
    let victimTriangles: number[] | null = null;
    for (const [key, list] of incident) {
      if (list.length <= 2) continue;
      if (victimEdge === null || key < victimEdge) {
        victimEdge = key;
        victimTriangles = list;
      }
    }
    if (!victimTriangles) return active;
    let victim = victimTriangles[0];
    let victimArea = Infinity;
    for (const triangle of victimTriangles) {
      const area = triangleArea2(positions, active[triangle * 3], active[triangle * 3 + 1], active[triangle * 3 + 2]);
      if (area < victimArea || (area === victimArea && triangle < victim)) {
        victimArea = area;
        victim = triangle;
      }
    }
    const next: number[] = [];
    for (let t = 0; t < triangleCount; t++) {
      if (t === victim) continue;
      next.push(active[t * 3], active[t * 3 + 1], active[t * 3 + 2]);
    }
    active = next;
  }
  return active;
}

function compactVertices(
  positions: Float64Array,
  triangles: number[],
): { positions: Float32Array; triangles: Uint32Array } {
  const seen = new Uint8Array(positions.length / 3);
  for (const index of triangles) seen[index] = 1;
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const kept: number[] = [];
  for (let index = 0; index < seen.length; index++) {
    if (!seen[index]) continue;
    remap[index] = kept.length;
    kept.push(index);
  }
  const compactPositions = new Float32Array(kept.length * 3);
  for (let i = 0; i < kept.length; i++) {
    compactPositions[i * 3] = positions[kept[i] * 3];
    compactPositions[i * 3 + 1] = positions[kept[i] * 3 + 1];
    compactPositions[i * 3 + 2] = positions[kept[i] * 3 + 2];
  }
  const compactTriangles = new Uint32Array(triangles.length);
  for (let i = 0; i < triangles.length; i++) compactTriangles[i] = remap[triangles[i]];
  return { positions: compactPositions, triangles: compactTriangles };
}

function edgePairs(triangles: Uint32Array): {
  stretchPairs: Uint32Array;
  bendPairs: Uint32Array;
  boundaryPairs: Uint32Array;
} {
  const edges = new Map<string, { a: number; b: number; opposite: number[] }>();
  for (let t = 0; t < triangles.length; t += 3) {
    const ids = [triangles[t], triangles[t + 1], triangles[t + 2]];
    for (let k = 0; k < 3; k++) {
      const first = ids[k];
      const second = ids[(k + 1) % 3];
      const opposite = ids[(k + 2) % 3];
      const a = Math.min(first, second);
      const b = Math.max(first, second);
      const key = `${a}:${b}`;
      const entry = edges.get(key);
      if (entry) entry.opposite.push(opposite);
      else edges.set(key, { a, b, opposite: [opposite] });
    }
  }
  const stretch: number[] = [];
  const bend: number[] = [];
  const boundary: number[] = [];
  const ordered = [...edges.values()].sort((left, right) => left.a - right.a || left.b - right.b);
  for (const edge of ordered) {
    stretch.push(edge.a, edge.b);
    if (edge.opposite.length === 1) boundary.push(edge.a, edge.b);
    if (edge.opposite.length === 2) {
      const p = Math.min(edge.opposite[0], edge.opposite[1]);
      const q = Math.max(edge.opposite[0], edge.opposite[1]);
      if (p !== q) bend.push(p, q);
    }
  }
  const bendOrdered = uniquePairs(bend);
  return {
    stretchPairs: new Uint32Array(stretch),
    bendPairs: new Uint32Array(bendOrdered),
    boundaryPairs: new Uint32Array(boundary),
  };
}

function uniquePairs(pairs: number[]): number[] {
  const count = pairs.length / 2;
  const order = Array.from({ length: count }, (_, index) => index);
  order.sort((i, j) => pairs[i * 2] - pairs[j * 2] || pairs[i * 2 + 1] - pairs[j * 2 + 1]);
  const sorted: number[] = [];
  let previousA = -1;
  let previousB = -1;
  for (const index of order) {
    const a = pairs[index * 2];
    const b = pairs[index * 2 + 1];
    if (a === previousA && b === previousB) continue;
    sorted.push(a, b);
    previousA = a;
    previousB = b;
  }
  return sorted;
}

function bindSources(source: Float32Array, positions: Float32Array, triangles: Uint32Array): SourceVertexBinding[] {
  const vertexCount = source.length / 3;
  const bindings: SourceVertexBinding[] = [];
  for (let i = 0; i < vertexCount; i++) {
    bindings.push(closestBinding(source[i * 3], source[i * 3 + 1], source[i * 3 + 2], positions, triangles));
  }
  return bindings;
}

function closestBinding(
  x: number,
  y: number,
  z: number,
  positions: Float32Array,
  triangles: Uint32Array,
): SourceVertexBinding {
  let best = Infinity;
  let triangle = 0;
  let barycentric: readonly [number, number, number] = [1, 0, 0];
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * 3;
    const b = triangles[t + 1] * 3;
    const c = triangles[t + 2] * 3;
    const hit = closestBarycentric(
      x,
      y,
      z,
      positions[a],
      positions[a + 1],
      positions[a + 2],
      positions[b],
      positions[b + 1],
      positions[b + 2],
      positions[c],
      positions[c + 1],
      positions[c + 2],
    );
    if (hit.distance2 < best) {
      best = hit.distance2;
      triangle = t / 3;
      barycentric = hit.barycentric;
    }
  }
  return { triangle, barycentric };
}

/** Closest point on triangle ABC, as barycentric weights that reconstruct that point. */
function closestBarycentric(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): { distance2: number; barycentric: readonly [number, number, number] } {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return result(px, py, pz, ax, ay, az, 1, 0, 0);

  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return result(px, py, pz, bx, by, bz, 0, 1, 0);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return result(px, py, pz, ax + abx * v, ay + aby * v, az + abz * v, 1 - v, v, 0);
  }

  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return result(px, py, pz, cx, cy, cz, 0, 0, 1);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return result(px, py, pz, ax + acx * w, ay + acy * w, az + acz * w, 1 - w, 0, w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return result(px, py, pz, bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w, 0, 1 - w, w);
  }

  const denom = va + vb + vc;
  const v = vb / denom;
  const w = vc / denom;
  const u = 1 - v - w;
  return result(px, py, pz, ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w, u, v, w);
}

function result(
  px: number,
  py: number,
  pz: number,
  qx: number,
  qy: number,
  qz: number,
  u: number,
  v: number,
  w: number,
): { distance2: number; barycentric: readonly [number, number, number] } {
  const dx = px - qx;
  const dy = py - qy;
  const dz = pz - qz;
  const sum = u + v + w || 1;
  return { distance2: dx * dx + dy * dy + dz * dz, barycentric: [u / sum, v / sum, w / sum] };
}

function distance(positions: Float64Array, i: number, j: number): number {
  const dx = positions[i * 3] - positions[j * 3];
  const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
  const dz = positions[i * 3 + 2] - positions[j * 3 + 2];
  return Math.hypot(dx, dy, dz);
}

function triangleArea2(positions: Float64Array, a: number, b: number, c: number): number {
  const ax = positions[a * 3];
  const ay = positions[a * 3 + 1];
  const az = positions[a * 3 + 2];
  const bx = positions[b * 3] - ax;
  const by = positions[b * 3 + 1] - ay;
  const bz = positions[b * 3 + 2] - az;
  const cx = positions[c * 3] - ax;
  const cy = positions[c * 3 + 1] - ay;
  const cz = positions[c * 3 + 2] - az;
  const crossX = by * cz - bz * cy;
  const crossY = bz * cx - bx * cz;
  const crossZ = bx * cy - by * cx;
  return crossX * crossX + crossY * crossY + crossZ * crossZ;
}
