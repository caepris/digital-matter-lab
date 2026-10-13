import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { isTrackpadScroll, TRACKPAD_GESTURE_GAP_MS } from './assemblyGizmos';

export interface PanBounds {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

/**
 * Pans like an OrbitControls mouse pan: `dx`/`dy` are pointer pixels, so the
 * scene follows the pointer. The target is clamped to `bounds` so the model
 * cannot be pushed out of reach.
 */
export function panCamera(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  dx: number,
  dy: number,
  viewportHeight: number,
  bounds?: PanBounds,
): void {
  const distance = camera.position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const scale = (2 * distance) / Math.max(1, viewportHeight);
  camera.updateMatrix();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
  const move = right.multiplyScalar(-dx * scale).addScaledVector(up, dy * scale);
  const next = target.clone().add(move);
  if (bounds) next.clamp(bounds.min, bounds.max);
  move.subVectors(next, target);
  camera.position.add(move);
  target.copy(next);
}

/**
 * Two-finger trackpad scrolls pan the camera; pinches (ctrlKey) and notched
 * mouse wheels fall through to OrbitControls zoom.
 */
export function attachTrackpadPan(
  controls: OrbitControls,
  element: HTMLElement,
  camera: THREE.PerspectiveCamera,
  bounds?: PanBounds,
): () => void {
  let trackpadUntil = 0;
  const onWheel = (event: WheelEvent) => {
    if (!controls.enabled || event.ctrlKey) return;
    const now = performance.now();
    const continuing = now < trackpadUntil && event.deltaMode === 0;
    if (!continuing && !isTrackpadScroll(event)) return;
    trackpadUntil = now + TRACKPAD_GESTURE_GAP_MS;
    event.preventDefault();
    event.stopImmediatePropagation();
    panCamera(camera, controls.target, -event.deltaX, -event.deltaY, element.clientHeight, bounds);
    controls.update();
  };
  element.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => element.removeEventListener('wheel', onWheel, { capture: true });
}
