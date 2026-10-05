import * as THREE from 'three';

/** Rectangle in CSS pixels relative to the canvas's top-left corner. */
export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface InteractionTarget {
  viewportRect(): ViewportRect;
  readonly camera: THREE.Camera;
  /** Returns true when the target wants to keep receiving moves until pointer up. */
  pointerDown(ray: THREE.Ray): boolean;
  pointerMove(ray: THREE.Ray): void;
  pointerUp(): void;
}

export function findViewportAt(rects: readonly ViewportRect[], x: number, y: number): number {
  return rects.findIndex(
    (rect) => x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height,
  );
}

export function toNdc(rect: ViewportRect, x: number, y: number): { x: number; y: number } {
  return {
    x: ((x - rect.left) / rect.width) * 2 - 1,
    y: -((y - rect.top) / rect.height) * 2 + 1,
  };
}

export function rayFromViewport(
  camera: THREE.Camera,
  rect: ViewportRect,
  x: number,
  y: number,
  raycaster = new THREE.Raycaster(),
): THREE.Ray {
  const ndc = toNdc(rect, x, y);
  camera.updateMatrixWorld();
  raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
  return raycaster.ray.clone();
}

export class InteractionRouter {
  private active: { target: InteractionTarget; pointerId: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();

  constructor(
    private readonly element: HTMLElement,
    private readonly targets: readonly InteractionTarget[] | (() => readonly InteractionTarget[]),
  ) {
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('lostpointercapture', this.onPointerUp);
  }

  dispose(): void {
    this.cancelActive();
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerup', this.onPointerUp);
    this.element.removeEventListener('pointercancel', this.onPointerUp);
    this.element.removeEventListener('lostpointercapture', this.onPointerUp);
  }

  cancelActive(): void {
    if (!this.active) return;
    this.active.target.pointerUp();
    this.active = null;
  }

  private currentTargets(): readonly InteractionTarget[] {
    return typeof this.targets === 'function' ? this.targets() : this.targets;
  }

  private localPoint(event: PointerEvent): { x: number; y: number } {
    const bounds = this.element.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  private rayFor(target: InteractionTarget, event: PointerEvent): THREE.Ray {
    const { x, y } = this.localPoint(event);
    return rayFromViewport(target.camera, target.viewportRect(), x, y, this.raycaster);
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.active || event.button !== 0) return;
    const { x, y } = this.localPoint(event);
    const targets = this.currentTargets();
    const index = findViewportAt(
      targets.map((target) => target.viewportRect()),
      x,
      y,
    );
    if (index < 0) return;
    const target = targets[index];
    event.preventDefault();
    if (target.pointerDown(this.rayFor(target, event))) {
      this.active = { target, pointerId: event.pointerId };
      try {
        this.element.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic or already-released pointers cannot be captured; routing still works without capture.
      }
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.active || event.pointerId !== this.active.pointerId) return;
    this.active.target.pointerMove(this.rayFor(this.active.target, event));
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.active || event.pointerId !== this.active.pointerId) return;
    const { target } = this.active;
    this.active = null;
    if (this.element.hasPointerCapture(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }
    target.pointerUp();
  };
}
