import * as THREE from 'three';
import { PLATFORM_HALF } from '../simulation/scene';

export interface SurfaceHit {
  partId: string;
  point: THREE.Vector3;
}

interface EditorPointerHandlers {
  gizmoActive(): boolean;
  tool(): string;
  meshes(): THREE.Object3D[];
  /** When true, the weld brush looks past nearer surfaces for the first hit `accepts` allows. */
  xray(): boolean;
  accepts(hit: SurfaceHit): boolean;
  onSelect(partId: string | null, additive: boolean): void;
  onPlace(point: THREE.Vector3): void;
  onPreview(point: THREE.Vector3 | null): void;
  onBrush(hit: SurfaceHit | null): void;
  onWeld(hit: SurfaceHit): void;
  onErase(point: THREE.Vector3): void;
  onStroke(active: boolean): void;
}

export class AssemblyEditorInteraction {
  private readonly raycaster = new THREE.Raycaster();
  private stroking = false;

  constructor(
    private readonly dom: HTMLElement,
    private readonly camera: THREE.Camera,
    private readonly handlers: EditorPointerHandlers,
  ) {
    dom.addEventListener('pointerdown', this.onPointerDown, true);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointerleave', this.onPointerLeave);
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown, true);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('pointerleave', this.onPointerLeave);
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.handlers.gizmoActive()) return;
    event.stopPropagation();
    event.preventDefault();
    this.stroking = true;
    try {
      this.dom.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers cannot always be captured; strokes still work without capture.
    }
    this.dispatch(event, true);
  };

  private onPointerMove = (event: PointerEvent): void => {
    const tool = this.handlers.tool();
    if (!this.stroking) {
      if (tool === 'place') this.handlers.onPreview(this.platformPoint(event));
      else if (tool === 'weld' || tool === 'erase') this.handlers.onBrush(this.brushSurface(event));
      return;
    }
    this.dispatch(event, false);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.stroking) return;
    this.stroking = false;
    this.handlers.onStroke(false);
    if (this.dom.hasPointerCapture(event.pointerId)) this.dom.releasePointerCapture(event.pointerId);
  };

  private onPointerLeave = (event: PointerEvent): void => {
    this.handlers.onBrush(null);
    this.onPointerUp(event);
  };

  private dispatch(event: PointerEvent, start: boolean): void {
    const tool = this.handlers.tool();
    if (tool === 'place') {
      const point = this.platformPoint(event);
      this.handlers.onPreview(point);
      if (start && point) this.handlers.onPlace(point);
      return;
    }
    if (tool === 'weld' || tool === 'erase') {
      if (start) this.handlers.onStroke(true);
      const hit = this.brushSurface(event);
      this.handlers.onBrush(hit);
      if (!hit) return;
      if (tool === 'erase' || event.altKey) this.handlers.onErase(hit.point);
      else this.handlers.onWeld(hit);
      return;
    }
    if (!start) return;
    const hit = this.closestSurface(event);
    this.handlers.onSelect(hit?.partId ?? null, event.shiftKey);
  }

  private platformPoint(event: PointerEvent): THREE.Vector3 | null {
    const raycaster = this.raycasterFor(event);
    const hit = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    if (Math.abs(hit.x) > PLATFORM_HALF || Math.abs(hit.z) > PLATFORM_HALF) return null;
    return hit;
  }

  private closestSurface(event: PointerEvent): SurfaceHit | null {
    return this.surfaces(event)[0] ?? null;
  }

  private brushSurface(event: PointerEvent): SurfaceHit | null {
    const hits = this.surfaces(event);
    if (!this.handlers.xray()) return hits[0] ?? null;
    return hits.find((hit) => this.handlers.accepts(hit)) ?? hits[0] ?? null;
  }

  private surfaces(event: PointerEvent): SurfaceHit[] {
    const hits: SurfaceHit[] = [];
    for (const hit of this.raycasterFor(event).intersectObjects(this.handlers.meshes(), false)) {
      const partId = hit.object.userData.partId as string | undefined;
      if (partId) hits.push({ partId, point: hit.point.clone() });
    }
    return hits;
  }

  private raycasterFor(event: PointerEvent): THREE.Raycaster {
    const rect = this.dom.getBoundingClientRect();
    this.raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    return this.raycaster;
  }
}
