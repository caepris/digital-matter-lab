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
        orbit.connect(nextElement);
        orbitElement = nextElement;
      }
      transform.enabled = editing && active;
      orbit.enabled = active;
      if (!editing) transform.detach();
    },
    dispose() {
      transform.dispose();
      orbit.dispose();
    },
  };
}
