import { PLATFORM_HALF, PRESS_HALF_X, PRESS_HALF_Y, PRESS_HALF_Z, PRESS_REST_BOTTOM } from '../scene';

/** The parked plate is out of the way and must not catch falling impactors. */
export function pressIsParked(bottom: number): boolean {
  return bottom >= PRESS_REST_BOTTOM - 1e-6;
}

/** A dynamic sphere integrated alongside the particles; xyz/previous/velocity are stored as triples. */
export interface SphereBody {
  position: Float64Array;
  previous: Float64Array;
  velocity: Float64Array;
  radius: number;
  invMass: number;
}

function onPlatform(x: number, z: number): boolean {
  return Math.abs(x) <= PLATFORM_HALF && Math.abs(z) <= PLATFORM_HALF;
}

/**
 * Pushes a point above the platform top (y = 0) and applies Coulomb-like friction by
 * cancelling a fraction of its tangential motion this substep. Points that are already
 * below the top (fallen off the side) are left alone so they do not teleport upward.
 */
export function collidePointWithPlatform(
  position: Float32Array | Float64Array,
  previous: Float32Array | Float64Array,
  offset: number,
  radius: number,
  friction: number,
): boolean {
  const y = position[offset + 1];
  if (y >= radius) return false;
  if (previous[offset + 1] < radius - 0.05) return false;
  if (!onPlatform(position[offset], position[offset + 2])) return false;

  const penetration = radius - y;
  position[offset + 1] = radius;
  const dx = position[offset] - previous[offset];
  const dz = position[offset + 2] - previous[offset + 2];
  const tangential = Math.sqrt(dx * dx + dz * dz);
  if (tangential > 0) {
    const scale = Math.max(0, tangential - friction * penetration) / tangential;
    position[offset] = previous[offset] + dx * scale;
    position[offset + 2] = previous[offset + 2] + dz * scale;
  }
  return true;
}

/**
 * Pushes a point out of the axis-aligned press plate, whose underside is at `bottom`, and
 * returns the downward displacement applied (negative if pushed up onto the plate).
 * The plate only ever descends onto the body, so anything overlapping it is pushed below
 * unless its center is clearly above the plate (e.g. an impactor resting on top). This
 * keeps squeezed material from being pushed through the thin plate and carried away.
 */
export function collidePointWithPress(
  position: Float32Array | Float64Array,
  offset: number,
  radius: number,
  bottom: number,
): number {
  if (Math.abs(position[offset]) >= PRESS_HALF_X + radius) return 0;
  if (Math.abs(position[offset + 2]) >= PRESS_HALF_Z + radius) return 0;
  const top = bottom + PRESS_HALF_Y * 2;
  const y = position[offset + 1];
  if (y <= bottom - radius || y >= top + radius) return 0;

  position[offset + 1] = y > top ? top + radius : bottom - radius;
  return y - position[offset + 1];
}

/** Separates a particle from a sphere, splitting the correction by inverse mass. */
export function collideParticleWithSphere(
  positions: Float32Array,
  index: number,
  particleInvMass: number,
  particleRadius: number,
  sphere: SphereBody,
): boolean {
  const o = index * 3;
  const dx = positions[o] - sphere.position[0];
  const dy = positions[o + 1] - sphere.position[1];
  const dz = positions[o + 2] - sphere.position[2];
  const minDistance = sphere.radius + particleRadius;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= minDistance * minDistance || d2 < 1e-12) return false;

  const d = Math.sqrt(d2);
  const w = particleInvMass + sphere.invMass;
  if (w === 0) return false;
  const correction = (minDistance - d) / d / w;
  positions[o] += dx * correction * particleInvMass;
  positions[o + 1] += dy * correction * particleInvMass;
  positions[o + 2] += dz * correction * particleInvMass;
  sphere.position[0] -= dx * correction * sphere.invMass;
  sphere.position[1] -= dy * correction * sphere.invMass;
  sphere.position[2] -= dz * correction * sphere.invMass;
  return true;
}

const closest = new Float64Array(3);
const bary = new Float64Array(3);

/** Closest point on triangle (a, b, c) to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestPointOnTriangle(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): void {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return setBary(1, 0, 0);

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return setBary(0, 1, 0);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return setBary(1 - v, v, 0);
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return setBary(0, 0, 1);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return setBary(1 - w, 0, w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return setBary(0, 1 - w, w);
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  setBary(1 - v - w, v, w);

  function setBary(u: number, v: number, w: number): void {
    bary[0] = u;
    bary[1] = v;
    bary[2] = w;
    closest[0] = ax * u + bx * v + cx * w;
    closest[1] = ay * u + by * v + cy * w;
    closest[2] = az * u + bz * v + cz * w;
  }
}

/**
 * Separates a sphere from a surface triangle, distributing the triangle's share of the
 * correction to its vertices by barycentric weight. Colliding against triangles rather
 * than particles stops impactors from slipping between surface particles.
 */
export function collideSphereWithTriangle(
  positions: Float32Array,
  invMass: Float32Array,
  i0: number,
  i1: number,
  i2: number,
  sphere: SphereBody,
  thickness: number,
): boolean {
  const s = sphere.position;
  const a = i0 * 3, b = i1 * 3, c = i2 * 3;
  closestPointOnTriangle(
    s[0], s[1], s[2],
    positions[a], positions[a + 1], positions[a + 2],
    positions[b], positions[b + 1], positions[b + 2],
    positions[c], positions[c + 1], positions[c + 2],
  );
  const dx = s[0] - closest[0];
  const dy = s[1] - closest[1];
  const dz = s[2] - closest[2];
  const minDistance = sphere.radius + thickness;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= minDistance * minDistance || d2 < 1e-12) return false;

  const d = Math.sqrt(d2);
  const nx = dx / d, ny = dy / d, nz = dz / d;
  const w0 = invMass[i0], w1 = invMass[i1], w2 = invMass[i2];
  const wTriangle = bary[0] * bary[0] * w0 + bary[1] * bary[1] * w1 + bary[2] * bary[2] * w2;
  const lambda = (minDistance - d) / (wTriangle + sphere.invMass);

  s[0] += nx * lambda * sphere.invMass;
  s[1] += ny * lambda * sphere.invMass;
  s[2] += nz * lambda * sphere.invMass;
  const k0 = lambda * bary[0] * w0, k1 = lambda * bary[1] * w1, k2 = lambda * bary[2] * w2;
  positions[a] -= nx * k0; positions[a + 1] -= ny * k0; positions[a + 2] -= nz * k0;
  positions[b] -= nx * k1; positions[b + 1] -= ny * k1; positions[b + 2] -= nz * k1;
  positions[c] -= nx * k2; positions[c + 1] -= ny * k2; positions[c + 2] -= nz * k2;
  return true;
}

export function collideSpheres(a: SphereBody, b: SphereBody): void {
  const dx = a.position[0] - b.position[0];
  const dy = a.position[1] - b.position[1];
  const dz = a.position[2] - b.position[2];
  const minDistance = a.radius + b.radius;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= minDistance * minDistance || d2 < 1e-12) return;
  const d = Math.sqrt(d2);
  const w = a.invMass + b.invMass;
  const correction = (minDistance - d) / d / w;
  for (let k = 0; k < 3; k++) {
    const delta = [dx, dy, dz][k] * correction;
    a.position[k] += delta * a.invMass;
    b.position[k] -= delta * b.invMass;
  }
}
