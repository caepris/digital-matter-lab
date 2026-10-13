/**
 * Dihedral-angle bending across every interior edge, with the robust gradients of
 * Bridson et al. 2003, "Simulation of Clothing with Folds and Wrinkles". Unlike
 * distance-based bending, stiffness does not depend on how far the wing tips sit
 * from the edge, so folds curve smoothly instead of snapping along the mesh grid.
 *
 * Stencil order per edge: wing tip x1, wing tip x2, edge start x3, edge end x4.
 */
export class DihedralConstraints {
  readonly count: number;
  readonly stencils: Uint32Array;
  readonly rest: Float32Array;

  constructor(triangles: ArrayLike<number>, positions: Float32Array) {
    this.stencils = dihedralStencils(triangles);
    this.count = this.stencils.length / 4;
    this.rest = new Float32Array(this.count);
    const gradient = new Float64Array(12);
    for (let c = 0; c < this.count; c++) {
      this.rest[c] = dihedralAngle(positions, this.stencils, c, gradient);
    }
  }
}

/** Interior edges shared by exactly two triangles, as [x1, x2, x3, x4] stencils. */
export function dihedralStencils(triangles: ArrayLike<number>): Uint32Array {
  const edges = new Map<number, [number, number, number]>();
  const stencils: number[] = [];
  const shared = new Set<number>();
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      const opposite = triangles[t + ((k + 2) % 3)];
      const key = Math.min(a, b) * 4_194_304 + Math.max(a, b);
      const first = edges.get(key);
      if (!first) {
        edges.set(key, [a, b, opposite]);
      } else if (!shared.has(key)) {
        shared.add(key);
        stencils.push(first[2], opposite, first[0], first[1]);
      }
    }
  }
  return new Uint32Array(stencils);
}

/**
 * Signed dihedral angle of stencil `c` (0 when flat) and its gradient with
 * respect to x1..x4, written to `gradient` as four xyz triples.
 */
export function dihedralAngle(
  positions: ArrayLike<number>,
  stencils: Uint32Array,
  c: number,
  gradient: Float64Array,
): number {
  const p1 = stencils[c * 4] * 3;
  const p2 = stencils[c * 4 + 1] * 3;
  const p3 = stencils[c * 4 + 2] * 3;
  const p4 = stencils[c * 4 + 3] * 3;
  const ex = positions[p4] - positions[p3];
  const ey = positions[p4 + 1] - positions[p3 + 1];
  const ez = positions[p4 + 2] - positions[p3 + 2];
  const a1x = positions[p1] - positions[p3], a1y = positions[p1 + 1] - positions[p3 + 1], a1z = positions[p1 + 2] - positions[p3 + 2];
  const b1x = positions[p1] - positions[p4], b1y = positions[p1 + 1] - positions[p4 + 1], b1z = positions[p1 + 2] - positions[p4 + 2];
  const a2x = positions[p2] - positions[p4], a2y = positions[p2 + 1] - positions[p4 + 1], a2z = positions[p2 + 2] - positions[p4 + 2];
  const b2x = positions[p2] - positions[p3], b2y = positions[p2 + 1] - positions[p3 + 1], b2z = positions[p2 + 2] - positions[p3 + 2];
  // N1 = (x1 - x3) x (x1 - x4), N2 = (x2 - x4) x (x2 - x3)
  const n1x = a1y * b1z - a1z * b1y, n1y = a1z * b1x - a1x * b1z, n1z = a1x * b1y - a1y * b1x;
  const n2x = a2y * b2z - a2z * b2y, n2y = a2z * b2x - a2x * b2z, n2z = a2x * b2y - a2y * b2x;
  const n1Sq = n1x * n1x + n1y * n1y + n1z * n1z;
  const n2Sq = n2x * n2x + n2y * n2y + n2z * n2z;
  const eLength = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (n1Sq < 1e-20 || n2Sq < 1e-20 || eLength < 1e-10) {
    gradient.fill(0);
    return 0;
  }
  const n1Length = Math.sqrt(n1Sq);
  const n2Length = Math.sqrt(n2Sq);
  const cosine = (n1x * n2x + n1y * n2y + n1z * n2z) / (n1Length * n2Length);
  // (N2 x N1) . E / |E|, normalized, so lifting a wing tip along its own normal increases the angle.
  const cx = n2y * n1z - n2z * n1y, cy = n2z * n1x - n2x * n1z, cz = n2x * n1y - n2y * n1x;
  const sine = (cx * ex + cy * ey + cz * ez) / (eLength * n1Length * n2Length);
  const angle = Math.atan2(sine, cosine);

  const s1 = eLength / n1Sq;
  const s2 = eLength / n2Sq;
  const invE = 1 / eLength;
  const d14 = (b1x * ex + b1y * ey + b1z * ez) * invE;
  const d24 = (a2x * ex + a2y * ey + a2z * ez) * invE;
  const d13 = (a1x * ex + a1y * ey + a1z * ez) * invE;
  const d23 = (b2x * ex + b2y * ey + b2z * ez) * invE;
  const m1x = n1x / n1Sq, m1y = n1y / n1Sq, m1z = n1z / n1Sq;
  const m2x = n2x / n2Sq, m2y = n2y / n2Sq, m2z = n2z / n2Sq;
  gradient[0] = n1x * s1;
  gradient[1] = n1y * s1;
  gradient[2] = n1z * s1;
  gradient[3] = n2x * s2;
  gradient[4] = n2y * s2;
  gradient[5] = n2z * s2;
  gradient[6] = d14 * m1x + d24 * m2x;
  gradient[7] = d14 * m1y + d24 * m2y;
  gradient[8] = d14 * m1z + d24 * m2z;
  gradient[9] = -d13 * m1x - d23 * m2x;
  gradient[10] = -d13 * m1y - d23 * m2y;
  gradient[11] = -d13 * m1z - d23 * m2z;
  return angle;
}

const scratch = new Float64Array(12);

export function solveDihedrals(
  positions: Float32Array,
  invMass: Float32Array,
  constraints: DihedralConstraints,
  compliance: number,
  h: number,
): void {
  const alpha = compliance / (h * h);
  const { stencils, rest, count } = constraints;
  const gradient = scratch;
  for (let c = 0; c < count; c++) {
    const angle = dihedralAngle(positions, stencils, c, gradient);
    let error = angle - rest[c];
    if (error > Math.PI) error -= 2 * Math.PI;
    else if (error < -Math.PI) error += 2 * Math.PI;
    if (error === 0) continue;
    let denominator = alpha;
    for (let k = 0; k < 4; k++) {
      const w = invMass[stencils[c * 4 + k]];
      const gx = gradient[k * 3], gy = gradient[k * 3 + 1], gz = gradient[k * 3 + 2];
      denominator += w * (gx * gx + gy * gy + gz * gz);
    }
    if (denominator < 1e-12) continue;
    const lambda = -error / denominator;
    for (let k = 0; k < 4; k++) {
      const vertex = stencils[c * 4 + k];
      const w = invMass[vertex];
      if (w === 0) continue;
      positions[vertex * 3] += w * gradient[k * 3] * lambda;
      positions[vertex * 3 + 1] += w * gradient[k * 3 + 1] * lambda;
      positions[vertex * 3 + 2] += w * gradient[k * 3 + 2] * lambda;
    }
  }
}
