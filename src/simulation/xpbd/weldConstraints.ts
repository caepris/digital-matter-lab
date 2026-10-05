export interface BarycentricWeld {
  particles: Uint32Array;
  weights: Float32Array;
}

/**
 * Zero-compliance weld: the barycentric point on triangle A stays on the barycentric
 * point on triangle B. Corrections are split across all six particles by weight and inverse mass.
 */
export class WeldConstraints {
  readonly count: number;
  private readonly particles: Uint32Array;
  private readonly weights: Float32Array;

  constructor(welds: readonly BarycentricWeld[]) {
    this.count = welds.length;
    this.particles = new Uint32Array(welds.length * 6);
    this.weights = new Float32Array(welds.length * 6);
    for (let i = 0; i < welds.length; i++) {
      this.particles.set(welds[i].particles, i * 6);
      this.weights.set(welds[i].weights, i * 6);
    }
  }

  solve(positions: Float32Array, invMass: Float32Array): void {
    const { particles, weights } = this;
    for (let w = 0; w < this.count; w++) {
      const base = w * 6;
      let ax = 0;
      let ay = 0;
      let az = 0;
      let bx = 0;
      let by = 0;
      let bz = 0;
      let generalized = 0;
      for (let k = 0; k < 6; k++) {
        const index = particles[base + k];
        const weight = weights[base + k];
        const p = index * 3;
        const x = positions[p] * weight;
        const y = positions[p + 1] * weight;
        const z = positions[p + 2] * weight;
        if (k < 3) {
          ax += x;
          ay += y;
          az += z;
        } else {
          bx += x;
          by += y;
          bz += z;
        }
        generalized += weight * weight * invMass[index];
      }
      if (generalized < 1e-12) continue;
      const cx = ax - bx;
      const cy = ay - by;
      const cz = az - bz;
      for (let k = 0; k < 6; k++) {
        const index = particles[base + k];
        const weight = weights[base + k];
        const scale = ((k < 3 ? -1 : 1) * weight * invMass[index]) / generalized;
        const p = index * 3;
        positions[p] += cx * scale;
        positions[p + 1] += cy * scale;
        positions[p + 2] += cz * scale;
      }
    }
  }

  maxSeparation(positions: Float32Array): number {
    const { particles, weights } = this;
    let max = 0;
    for (let w = 0; w < this.count; w++) {
      const base = w * 6;
      let ax = 0;
      let ay = 0;
      let az = 0;
      let bx = 0;
      let by = 0;
      let bz = 0;
      for (let k = 0; k < 6; k++) {
        const p = particles[base + k] * 3;
        const weight = weights[base + k];
        if (k < 3) {
          ax += positions[p] * weight;
          ay += positions[p + 1] * weight;
          az += positions[p + 2] * weight;
        } else {
          bx += positions[p] * weight;
          by += positions[p + 1] * weight;
          bz += positions[p + 2] * weight;
        }
      }
      max = Math.max(max, Math.hypot(ax - bx, ay - by, az - bz));
    }
    return max;
  }
}
