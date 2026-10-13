/** A static capsule (a sphere when `a` equals `b`) that particles cannot enter. */
export interface CapsuleCollider {
  a: readonly [number, number, number];
  b: readonly [number, number, number];
  radius: number;
}

/** Closest point on segment ab to p, written to `out`. */
export function closestOnSegment(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  px: number, py: number, pz: number,
  out: Float64Array,
): void {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  let t = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / lengthSq : 0;
  t = Math.max(0, Math.min(1, t));
  out[0] = ax + dx * t;
  out[1] = ay + dy * t;
  out[2] = az + dz * t;
}

const closest = new Float64Array(3);

/**
 * Pushes particles out to `radius + margin` and applies Coulomb-style friction by
 * removing a fraction of the tangential motion since the start of the substep,
 * so cloth rests on shoulders instead of sliding off. `exempt[c][i]` skips
 * particle i for collider c.
 */
export function solveCapsuleCollisions(
  positions: Float32Array,
  previous: Float32Array,
  invMass: Float32Array,
  colliders: readonly CapsuleCollider[],
  margin: number,
  friction: number,
  exempt?: readonly Uint8Array[],
): void {
  const count = invMass.length;
  for (let c = 0; c < colliders.length; c++) {
    const collider = colliders[c];
    const skip = exempt?.[c];
    const [ax, ay, az] = collider.a;
    const [bx, by, bz] = collider.b;
    const reach = collider.radius + margin;
    const minX = Math.min(ax, bx) - reach, maxX = Math.max(ax, bx) + reach;
    const minY = Math.min(ay, by) - reach, maxY = Math.max(ay, by) + reach;
    const minZ = Math.min(az, bz) - reach, maxZ = Math.max(az, bz) + reach;
    for (let i = 0; i < count; i++) {
      if (invMass[i] === 0 || skip?.[i]) continue;
      const o = i * 3;
      const px = positions[o], py = positions[o + 1], pz = positions[o + 2];
      if (px < minX || px > maxX || py < minY || py > maxY || pz < minZ || pz > maxZ) continue;
      closestOnSegment(ax, ay, az, bx, by, bz, px, py, pz, closest);
      let nx = px - closest[0], ny = py - closest[1], nz = pz - closest[2];
      const distance = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (distance >= reach || distance < 1e-9) continue;
      nx /= distance;
      ny /= distance;
      nz /= distance;
      const push = reach - distance;
      let x = px + nx * push, y = py + ny * push, z = pz + nz * push;
      const mx = x - previous[o], my = y - previous[o + 1], mz = z - previous[o + 2];
      const normal = mx * nx + my * ny + mz * nz;
      const tx = mx - nx * normal, ty = my - ny * normal, tz = mz - nz * normal;
      const tangential = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tangential > 1e-12) {
        const keep = Math.max(0, 1 - (friction * push) / tangential);
        x -= tx * (1 - keep);
        y -= ty * (1 - keep);
        z -= tz * (1 - keep);
      }
      positions[o] = x;
      positions[o + 1] = y;
      positions[o + 2] = z;
    }
  }
}

/**
 * Particles that start inside a collider belong to geometry hidden inside the body,
 * such as a sleeve end tucked into the torso; pushing them out would tear the mesh.
 */
export function startInsideMasks(
  positions: ArrayLike<number>,
  colliders: readonly CapsuleCollider[],
  margin: number,
): Uint8Array[] {
  return colliders.map((collider) => {
    const mask = new Uint8Array(positions.length / 3);
    for (let i = 0; i < mask.length; i++) {
      const o = i * 3;
      closestOnSegment(...collider.a, ...collider.b, positions[o], positions[o + 1], positions[o + 2], closest);
      const distance = Math.hypot(positions[o] - closest[0], positions[o + 1] - closest[1], positions[o + 2] - closest[2]);
      if (distance < collider.radius + margin) mask[i] = 1;
    }
    return mask;
  });
}

/** Smallest clearance between any particle and any collider surface; negative means inside. */
export function minimumClearance(positions: ArrayLike<number>, colliders: readonly CapsuleCollider[]): number {
  let min = Infinity;
  for (const collider of colliders) {
    for (let o = 0; o < positions.length; o += 3) {
      closestOnSegment(...collider.a, ...collider.b, positions[o], positions[o + 1], positions[o + 2], closest);
      const distance = Math.hypot(positions[o] - closest[0], positions[o + 1] - closest[1], positions[o + 2] - closest[2]);
      min = Math.min(min, distance - collider.radius);
    }
  }
  return min;
}
