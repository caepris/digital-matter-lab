import { describe, expect, it } from 'vitest';
import { DihedralConstraints, dihedralAngle, dihedralStencils, solveDihedrals } from './dihedralBending';

/** Two triangles sharing edge (0,0,0)-(1,0,0), wing tips at +y and -y. */
function hinge(lift = 0): { positions: Float32Array; triangles: Uint32Array } {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0.5, 1, lift, 0.5, -1, 0]),
    triangles: new Uint32Array([0, 1, 2, 1, 0, 3]),
  };
}

describe('dihedral bending', () => {
  it('finds one stencil per interior edge and measures a flat hinge as zero', () => {
    const { positions, triangles } = hinge();
    const stencils = dihedralStencils(triangles);
    expect(stencils.length).toBe(4);
    expect(dihedralAngle(positions, stencils, 0, new Float64Array(12))).toBeCloseTo(0, 6);
  });

  it('has gradients that match finite differences', () => {
    const { positions, triangles } = hinge(0.4);
    positions[10] += 0.1;
    const stencils = dihedralStencils(triangles);
    const gradient = new Float64Array(12);
    dihedralAngle(positions, stencils, 0, gradient);
    const epsilon = 1e-4;
    for (let k = 0; k < 4; k += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const index = stencils[k] * 3 + axis;
        const plus = positions.slice();
        const minus = positions.slice();
        plus[index] += epsilon;
        minus[index] -= epsilon;
        const numeric =
          (dihedralAngle(plus, stencils, 0, new Float64Array(12)) - dihedralAngle(minus, stencils, 0, new Float64Array(12))) /
          (2 * epsilon);
        expect(gradient[k * 3 + axis]).toBeCloseTo(numeric, 2);
      }
    }
  });

  it('distinguishes folding up from folding down', () => {
    const stencils = dihedralStencils(hinge().triangles);
    const up = dihedralAngle(hinge(0.3).positions, stencils, 0, new Float64Array(12));
    const down = dihedralAngle(hinge(-0.3).positions, stencils, 0, new Float64Array(12));
    expect(up).toBeCloseTo(-down, 6);
    expect(Math.abs(up)).toBeGreaterThan(0.2);
  });

  it('restores the rest angle when solved stiffly', () => {
    const rest = hinge();
    const constraints = new DihedralConstraints(rest.triangles, rest.positions);
    const bent = hinge(0.5).positions;
    const invMass = new Float32Array([0, 0, 1, 1]);
    for (let iteration = 0; iteration < 40; iteration += 1) solveDihedrals(bent, invMass, constraints, 0, 1 / 600);
    expect(dihedralAngle(bent, constraints.stencils, 0, new Float64Array(12))).toBeCloseTo(0, 3);
  });
});
