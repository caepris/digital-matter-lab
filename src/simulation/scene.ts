export const GRAVITY = -9.81;

export const CUBE_SIZE = 1;
export const CUBE_HALF = CUBE_SIZE / 2;

export const PLATFORM_HALF = 1.5;
export const PLATFORM_THICKNESS = 0.2;

export const IMPACTOR_RADIUS = 0.24;
export const IMPACTOR_MASS = 0.6;
export const DROP_HEIGHT = 3.2;
export const MAX_IMPACTORS = 6;
export const KILL_PLANE_Y = -6;

export const PRESS_HALF_X = 0.8;
export const PRESS_HALF_Y = 0.08;
export const PRESS_HALF_Z = 0.8;
/** Parked height, kept in view; the parked plate has collisions disabled so drops pass through it. */
export const PRESS_REST_BOTTOM = 1.7;
export const PRESS_DOWN_SPEED = 0.6;
export const PRESS_UP_SPEED = 1.8;
/** Force at which the plate stalls, in newtons. Estimated from contact corrections, so it also includes the effort of moving material out of the plate's way. */
export const PRESS_MAX_FORCE = 400;

export const DROP_TARGET_PLANE_Y = 0.9;

/** Drop height for a new impactor, stacked above any existing ones it would overlap at spawn. */
export function spawnHeight(x: number, z: number, existing: readonly { x: number; y: number; z: number }[]): number {
  let y = DROP_HEIGHT;
  const clearance = IMPACTOR_RADIUS * 2 + 0.02;
  for (let moved = true; moved; ) {
    moved = false;
    for (const other of existing) {
      if (Math.hypot(other.x - x, other.y - y, other.z - z) < clearance) {
        y = other.y + clearance;
        moved = true;
      }
    }
  }
  return y;
}

export function clampToPlatform(value: number, margin = IMPACTOR_RADIUS): number {
  const limit = PLATFORM_HALF - margin;
  return Math.min(limit, Math.max(-limit, value));
}
