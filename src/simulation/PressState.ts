import { PRESS_DOWN_SPEED, PRESS_MAX_FORCE, PRESS_REST_BOTTOM, PRESS_UP_SPEED } from './scene';

export class PressState {
  bottom = PRESS_REST_BOTTOM;
  previousBottom = PRESS_REST_BOTTOM;
  active = false;

  constructor(private readonly floor: number) {}

  /**
   * Moves the plate. `obstacleTop` stops it on an incompressible surface; `resistingForce`
   * (newtons, from the previous step) holds it in place once the material pushes back harder
   * than the press can push, so stiffer materials compress less.
   */
  update(dt: number, obstacleTop = -Infinity, resistingForce = 0): void {
    this.previousBottom = this.bottom;
    if (this.active) {
      if (resistingForce > PRESS_MAX_FORCE) return;
      const stop = Math.max(this.floor, obstacleTop);
      this.bottom = Math.min(PRESS_REST_BOTTOM, Math.max(this.bottom - PRESS_DOWN_SPEED * dt, stop));
    } else {
      this.bottom = Math.min(PRESS_REST_BOTTOM, this.bottom + PRESS_UP_SPEED * dt);
    }
  }

  interpolated(alpha: number): number {
    return this.previousBottom + (this.bottom - this.previousBottom) * alpha;
  }

  reset(): void {
    this.bottom = PRESS_REST_BOTTOM;
    this.previousBottom = PRESS_REST_BOTTOM;
    this.active = false;
  }
}
