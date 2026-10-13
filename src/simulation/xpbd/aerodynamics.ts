export interface WindSettings {
  /** Mean wind velocity in m/s. */
  velocity: readonly [number, number, number];
  /** 0.5 * air density * drag coefficient, applied to the flow normal to each face. */
  normalDrag: number;
  /** Skin friction on the flow along each face, as a fraction of `normalDrag`. */
  tangentialDrag: number;
  /** Outward pressure per unit dynamic pressure, e.g. air filling a windsock. */
  inflation: number;
  /** 0 is steady wind; 1 gives strong gusts and direction changes. */
  gust: number;
}

export const CALM: WindSettings = {
  velocity: [0, 0, 0],
  normalDrag: 0,
  tangentialDrag: 0,
  inflation: 0,
  gust: 0,
};

const AIR_DENSITY = 1.2;

/**
 * Per-face aerodynamic force from the wind relative to each face's own velocity.
 * Faces facing the wind catch it and faces edge-on let it pass, so cloth flutters
 * instead of leaning under a uniform push. Gusts vary in space and time.
 */
export function applyAerodynamics(
  positions: Float32Array,
  velocities: Float32Array,
  invMass: Float32Array,
  triangles: Uint32Array,
  wind: WindSettings,
  time: number,
  h: number,
): void {
  const [wx, wy, wz] = wind.velocity;
  const speed = Math.hypot(wx, wy, wz);
  if (speed === 0 || (wind.normalDrag === 0 && wind.inflation === 0)) return;
  const sideX = -wz / speed;
  const sideZ = wx / speed;
  const dynamicPressure = 0.5 * AIR_DENSITY * speed * speed;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2];
    const ao = a * 3, bo = b * 3, co = c * 3;
    const cx = (positions[ao] + positions[bo] + positions[co]) / 3;
    const cy = (positions[ao + 1] + positions[bo + 1] + positions[co + 1]) / 3;
    const cz = (positions[ao + 2] + positions[bo + 2] + positions[co + 2]) / 3;
    const gust =
      1 + wind.gust * (0.55 * Math.sin(1.1 * time + 1.3 * cx - 0.4 * cz) + 0.35 * Math.sin(2.7 * time + 2.1 * cy + 0.7 * cx));
    const swirl = wind.gust * 0.4 * speed * Math.sin(0.8 * time + 0.9 * cx + 0.5 * cy);
    const fx = wx * gust + sideX * swirl;
    const fy = wy * gust;
    const fz = wz * gust + sideZ * swirl;

    const ux = positions[bo] - positions[ao], uy = positions[bo + 1] - positions[ao + 1], uz = positions[bo + 2] - positions[ao + 2];
    const vx = positions[co] - positions[ao], vy = positions[co + 1] - positions[ao + 1], vz = positions[co + 2] - positions[ao + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const doubleArea = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (doubleArea < 1e-12) continue;
    nx /= doubleArea;
    ny /= doubleArea;
    nz /= doubleArea;
    const area = doubleArea * 0.5;

    const rx = fx - (velocities[ao] + velocities[bo] + velocities[co]) / 3;
    const ry = fy - (velocities[ao + 1] + velocities[bo + 1] + velocities[co + 1]) / 3;
    const rz = fz - (velocities[ao + 2] + velocities[bo + 2] + velocities[co + 2]) / 3;
    const normalFlow = rx * nx + ry * ny + rz * nz;
    const tx = rx - nx * normalFlow, ty = ry - ny * normalFlow, tz = rz - nz * normalFlow;
    const tangentSpeed = Math.sqrt(tx * tx + ty * ty + tz * tz);
    const normalForce = wind.normalDrag * area * Math.abs(normalFlow) * normalFlow + wind.inflation * dynamicPressure * area;
    const tangentForce = wind.normalDrag * wind.tangentialDrag * area * tangentSpeed;
    const forceX = nx * normalForce + tx * tangentForce;
    const forceY = ny * normalForce + ty * tangentForce;
    const forceZ = nz * normalForce + tz * tangentForce;
    for (const vertex of [a, b, c]) {
      const scale = (invMass[vertex] * h) / 3;
      if (scale === 0) continue;
      velocities[vertex * 3] += forceX * scale;
      velocities[vertex * 3 + 1] += forceY * scale;
      velocities[vertex * 3 + 2] += forceZ * scale;
    }
  }
}
