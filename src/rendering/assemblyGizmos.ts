import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { MAX_SCALE, MIN_SCALE } from '../assembly-editor/AssemblyDocument';

export interface AssemblyGizmos {
  orbit: OrbitControls;
  transform: TransformControls;
  setSnapping(grid: boolean): void;
  setInteraction(editing: boolean, active: boolean): void;
  dispose(): void;
}

export function createAssemblyGizmos(
  camera: THREE.Camera,
  transformDom: HTMLElement,
  orbitDom: HTMLElement,
  onChange: () => void,
  onDrag: (dragging: boolean) => void,
): AssemblyGizmos {
  const orbit = new OrbitControls(camera, orbitDom);
  let orbitElement: HTMLElement = orbitDom;
  orbit.enableDamping = false;
  orbit.target.set(0, 0.55, 0);
  orbit.mouseButtons = {
    LEFT: -1 as unknown as THREE.MOUSE,
    MIDDLE: THREE.MOUSE.ROTATE,
    RIGHT: THREE.MOUSE.PAN,
  };

  // Two-finger trackpad scrolls orbit; pinches (ctrlKey) and notched mouse wheels fall through to OrbitControls zoom.
  let trackpadUntil = 0;
  const onWheel = (event: WheelEvent) => {
    if (!orbit.enabled || event.ctrlKey) return;
    const now = performance.now();
    const continuing = now < trackpadUntil && event.deltaMode === 0;
    if (!continuing && !isTrackpadScroll(event)) return;
    trackpadUntil = now + TRACKPAD_GESTURE_GAP_MS;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = event.currentTarget as HTMLElement;
    const radiansPerPixel = (2 * Math.PI) / Math.max(1, element.clientHeight);
    orbitCamera(camera, orbit.target, event.deltaX * radiansPerPixel, event.deltaY * radiansPerPixel);
    orbit.update();
  };
  const listenWheel = (element: HTMLElement) =>
    element.addEventListener('wheel', onWheel, { capture: true, passive: false });
  const unlistenWheel = (element: HTMLElement) =>
    element.removeEventListener('wheel', onWheel, { capture: true });
  listenWheel(orbitDom);

  const transform = new TransformControls(camera, transformDom);
  transform.setMode('translate');
  let applying = false;
  transform.addEventListener('objectChange', () => {
    const object = transform.object;
    if (!object || applying) return;
    if (transform.mode === 'scale') {
      applying = true;
      const uniform = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.max(object.scale.x, object.scale.y, object.scale.z)));
      object.scale.setScalar(uniform);
      applying = false;
    }
    onChange();
  });
  transform.addEventListener('dragging-changed', (event) => {
    const dragging = Boolean((event as { value?: boolean }).value);
    orbit.enabled = !dragging;
    onDrag(dragging);
  });

  return {
    orbit,
    transform,
    setSnapping(grid: boolean) {
      transform.setTranslationSnap(grid ? 0.05 : null);
      transform.setRotationSnap(grid ? (15 * Math.PI) / 180 : null);
      transform.setScaleSnap(grid ? 0.1 : null);
    },
    setInteraction(editing: boolean, active: boolean) {
      const nextElement = editing ? transformDom : orbitDom;
      if (nextElement !== orbitElement) {
        orbit.disconnect();
        unlistenWheel(orbitElement);
        listenWheel(nextElement);
        orbit.connect(nextElement);
        orbitElement = nextElement;
      }
      transform.enabled = editing && active;
      orbit.enabled = active;
      if (!editing) transform.detach();
    },
    dispose() {
      unlistenWheel(orbitElement);
      transform.dispose();
      orbit.dispose();
    },
  };
}

/**
 * Trackpads report pixel deltas that are fractional, small, or horizontal;
 * notched mouse wheels report large integer vertical steps.
 */
export function isTrackpadScroll(event: Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>): boolean {
  if (event.deltaMode !== 0) return false;
  if (event.deltaX !== 0) return true;
  return !Number.isInteger(event.deltaY) || Math.abs(event.deltaY) < 50;
}

const MIN_POLAR = 0.05;
/** Wheel events closer together than this belong to the same trackpad gesture. */
const TRACKPAD_GESTURE_GAP_MS = 180;

/** Rotates the camera around `target`: `left` turns about world up, `up` tilts toward the poles. */
export function orbitCamera(camera: THREE.Camera, target: THREE.Vector3, left: number, up: number): void {
  const offset = camera.position.clone().sub(target);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta -= left;
  spherical.phi = THREE.MathUtils.clamp(spherical.phi - up, MIN_POLAR, Math.PI - MIN_POLAR);
  offset.setFromSpherical(spherical);
  camera.position.copy(target).add(offset);
  camera.lookAt(target);
}
