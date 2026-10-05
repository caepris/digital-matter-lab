import * as THREE from 'three';
import { AssemblyEditorController, type EditorMode, type EditorTool } from './assembly/AssemblyEditorController';
import { shapeForKind, type AssemblyPart, type WeldSample } from '../assembly-editor/AssemblyDocument';
import type { InteractionTarget, ViewportRect } from '../interaction/InteractionRouter';
import { AssemblyEditorInteraction, type SurfaceHit } from '../interaction/AssemblyEditorInteraction';
import { createAssemblyGizmos, type AssemblyGizmos } from '../rendering/assemblyGizmos';
import { AssemblyEditorView, EDGE_COLOR, VERTEX_COLOR } from '../rendering/AssemblyEditorView';
import { clampToPlatform, DROP_TARGET_PLANE_Y } from '../simulation/scene';
import type { MatterSimulation, SimulationFrame, ToolId } from '../simulation/types';
import { AssemblyEditorControls, type LegendEntry } from '../ui/AssemblyEditorControls';

const dropPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -DROP_TARGET_PLANE_Y);
const emptyFrame: SimulationFrame = { particles: null, cubePosition: null, cubeQuaternion: null, impactors: [], pressBottom: 1.7 };

export class AssemblyWorkspace implements InteractionTarget {
  readonly element: HTMLElement;
  readonly viewport: HTMLElement;
  readonly kind = 'assembly' as const;
  readonly controller: AssemblyEditorController;
  readonly view: AssemblyEditorView;
  readonly state = { tool: 'grab' as ToolId, presetId: 'compiled', structureVisible: false };
  private readonly controls: AssemblyEditorControls;
  private readonly gizmos: AssemblyGizmos;
  private readonly interaction: AssemblyEditorInteraction;
  private readonly canvas: HTMLCanvasElement;
  private activeSimTool: ToolId | null = null;
  private dragging = false;

  constructor(canvas: HTMLCanvasElement, private readonly isActive: () => boolean) {
    this.canvas = canvas;
    this.controller = new AssemblyEditorController();
    this.view = new AssemblyEditorView(0xb78cff);
    this.controls = new AssemblyEditorControls({
      onMode: (mode) => this.setMode(mode),
      onTool: (tool) => this.setTool(tool),
      onSimTool: (tool) => this.setSimTool(tool),
      onPlaceKind: (kind) => {
        this.controller.setPlaceKind(kind);
        this.refresh();
      },
      onPlacePreset: (id) => {
        this.controller.setPlacePreset(id);
        this.refresh();
      },
      onSelectPart: (id, additive) => {
        this.controller.select([id], additive);
        this.refresh();
      },
      onGrid: (enabled) => {
        this.controller.toggleGrid(enabled);
        this.refresh();
      },
      onSurface: (enabled) => {
        this.controller.toggleSurface(enabled);
        this.refresh();
      },
      onUndo: () => this.edit(() => this.controller.undo()),
      onRedo: () => this.edit(() => this.controller.redo()),
      onDuplicate: () => this.edit(() => this.controller.duplicate()),
      onDelete: () => this.edit(() => this.controller.deleteSelected()),
      onClear: () => {
        if (window.confirm('Clear every part and weld? You can still Undo this action.')) {
          this.edit(() => this.controller.clear());
        }
      },
      onLabel: (label) => {
        const part = this.controller.primary;
        if (part) this.edit(() => this.controller.setPartLabel(part.id, label));
      },
      onPartKind: (kind) => {
        const part = this.controller.primary;
        if (!part) return;
        const removesWelds =
          shapeForKind(part.kind) !== shapeForKind(kind) &&
          this.controller.document.welds.some((weld) => weld.partA === part.id || weld.partB === part.id);
        if (!removesWelds || window.confirm(`Changing ${part.label}'s shape removes its welds. Continue?`)) {
          this.edit(() => this.controller.setPartKind(part.id, kind));
        }
      },
      onPartPreset: (id) => {
        const part = this.controller.primary;
        if (part) this.edit(() => this.controller.setPartPreset(part.id, id));
      },
      onBrushRadius: (radius) => {
        this.controller.setBrushRadius(radius);
        this.view.setBrush(null, radius);
        this.refresh();
      },
      onTransform: (axis, value) => {
        const part = this.controller.primary;
        if (!part || !Number.isFinite(value)) return;
        if (axis === 'scale') {
          this.edit(() => this.controller.setPartTransform(part.id, { uniformScale: value }));
        } else if (axis === 'rx' || axis === 'ry' || axis === 'rz') {
          const rotation = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...part.quaternion), 'XYZ');
          const component = axis === 'rx' ? 'x' : axis === 'ry' ? 'y' : 'z';
          rotation[component] = THREE.MathUtils.degToRad(value);
          const quaternion = new THREE.Quaternion().setFromEuler(rotation);
          this.edit(() =>
            this.controller.setPartTransform(part.id, {
              quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
            }),
          );
        } else {
          const position = [...part.position] as [number, number, number];
          const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
          position[index] = value;
          this.edit(() => this.controller.setPartTransform(part.id, { position }));
        }
      },
      onResetTransform: () => {
        const part = this.controller.primary;
        if (part) this.edit(() => this.controller.resetPartTransform(part.id));
      },
      onStructure: (visible) => {
        this.controller.structureVisible = visible;
        this.state.structureVisible = visible;
        this.view.setStructureVisible(visible);
        this.refresh();
      },
      onXray: (enabled) => {
        this.controller.setXray(enabled);
        this.view.setXray(enabled);
        this.refresh();
      },
      onReset: () => {
        this.controller.resetSimulation();
        this.refresh();
      },
      onSimulationPaused: (paused) => {
        this.controller.setSimulationPaused(paused);
        this.refresh();
      },
    });

    this.element = document.createElement('section');
    this.element.className = 'panel';
    this.element.dataset.kind = 'assembly';
    this.viewport = document.createElement('div');
    this.viewport.className = 'panel-viewport assembly-viewport is-editing';
    this.viewport.append(this.controls.hint, this.controls.legend);
    this.element.append(this.controls.root, this.viewport);

    this.gizmos = createAssemblyGizmos(
      this.view.camera,
      this.viewport,
      this.canvas,
      () => this.onGizmoChange(),
      (dragging) => this.onGizmoDrag(dragging),
    );
    this.view.panel.scene.add(this.gizmos.transform.getHelper());
    this.interaction = new AssemblyEditorInteraction(this.viewport, this.view.camera, {
      gizmoActive: () => this.gizmoBusy(),
      tool: () => this.controller.tool,
      meshes: () => this.partMeshes(),
      xray: () => this.controller.xray,
      accepts: (hit) => this.brushAccepts(hit),
      onSelect: (partId, additive) => {
        this.controller.select(partId ? [partId] : [], additive);
        this.refresh();
      },
      onPlace: (point) => {
        this.controller.placeAt([point.x, 0, point.z]);
        this.view.setPreview(null, null, this.controller.placePresetId);
        this.refresh();
      },
      onPreview: (point) => {
        this.view.setPreview(point ? this.controller.placeKind : null, point, this.controller.placePresetId);
      },
      onBrush: (hit) => {
        const eligible = hit !== null && (this.controller.tool === 'erase' || this.brushAccepts(hit));
        this.view.setBrush(hit?.point ?? null, this.controller.document.settings.brushRadius, eligible);
      },
      onWeld: (hit) => {
        this.controller.paint(hit.partId, [hit.point.x, hit.point.y, hit.point.z]);
        this.view.setBrush(hit.point, this.controller.document.settings.brushRadius, true);
        this.refresh();
      },
      onErase: (point) => {
        this.controller.erase([point.x, point.y, point.z]);
        this.view.setBrush(point, this.controller.document.settings.brushRadius, true);
        this.refresh();
      },
      onStroke: (active) => {
        if (active) this.controller.beginStroke();
        else {
          this.controller.endStroke();
          this.refresh();
        }
      },
    });
    window.addEventListener('keydown', this.onKeyDown);
    this.refresh();
  }

  get camera(): THREE.Camera {
    return this.view.camera;
  }

  get simulation(): MatterSimulation {
    return this.controller.simulation ?? this.authoredStats;
  }

  viewportRect(): ViewportRect {
    const canvasBounds = this.canvas.getBoundingClientRect();
    const bounds = this.viewport.getBoundingClientRect();
    return {
      left: bounds.left - canvasBounds.left,
      top: bounds.top - canvasBounds.top,
      width: bounds.width,
      height: bounds.height,
    };
  }

  step(dt: number): void {
    if (this.controller.mode === 'simulate' && !this.controller.simulationPaused) this.controller.simulation?.step(dt);
  }

  render(renderer: THREE.WebGLRenderer, alpha: number): void {
    const simulating = this.controller.mode === 'simulate' && this.controller.simulation;
    const frame = simulating ? this.controller.simulation!.frame(alpha) : emptyFrame;
    this.view.render(frame, simulating ? this.controller.simTool === 'press' : false);
    renderer.render(this.view.panel.scene, this.view.camera);
  }

  pointerDown(ray: THREE.Ray): boolean {
    const simulation = this.controller.simulation;
    if (this.controller.mode !== 'simulate' || !simulation) return false;
    if (this.controller.simTool === 'grab') {
      if (!simulation.beginGrab(ray)) return false;
    } else if (this.controller.simTool === 'drop') {
      const hit = ray.intersectPlane(dropPlane, new THREE.Vector3());
      if (hit) simulation.dropImpactor(clampToPlatform(hit.x), clampToPlatform(hit.z));
      return false;
    } else {
      simulation.setPressActive(true);
    }
    this.activeSimTool = this.controller.simTool;
    this.state.tool = this.controller.simTool;
    this.viewport.classList.add('is-interacting');
    return true;
  }

  pointerMove(ray: THREE.Ray): void {
    if (this.activeSimTool === 'grab') this.controller.simulation?.updateGrab(ray);
  }

  pointerUp(): void {
    if (this.activeSimTool === 'grab') this.controller.simulation?.endGrab();
    if (this.activeSimTool === 'press') this.controller.simulation?.setPressActive(false);
    this.activeSimTool = null;
    this.viewport.classList.remove('is-interacting');
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.interaction.dispose();
    this.gizmos.dispose();
    this.controller.simulation?.dispose();
    this.view.dispose();
  }

  setActive(active: boolean): void {
    this.gizmos.setInteraction(this.controller.mode === 'edit', active);
  }

  private setMode(mode: EditorMode): void {
    this.pointerUp();
    this.controller.setMode(mode);
    this.viewport.classList.toggle('is-editing', mode === 'edit');
    this.view.setEditing(mode === 'edit');
    if (mode === 'simulate' && this.controller.simulation) {
      const topology = this.controller.simulation.topology;
      this.view.showSimulation(topology.kind === 'composite' ? topology : null);
      this.view.setStructureVisible(this.controller.structureVisible);
    } else {
      this.view.showSimulation(null);
    }
    this.refresh();
  }

  private setTool(tool: EditorTool): void {
    this.controller.setTool(tool);
    this.view.setPreview(null, null, this.controller.placePresetId);
    this.viewport.style.cursor =
      tool === 'place' || tool === 'weld' || tool === 'erase' ? 'crosshair' : tool === 'select' ? 'default' : 'move';
    this.refresh();
  }

  private setSimTool(tool: ToolId): void {
    this.pointerUp();
    this.controller.simTool = tool;
    this.state.tool = tool;
    this.refresh();
  }

  private edit(action: () => void): void {
    if (this.controller.mode !== 'edit') return;
    action();
    this.refresh();
  }

  private refresh(): void {
    const document = this.controller.document;
    const editing = this.controller.mode === 'edit';
    this.view.setEditing(editing);
    this.viewport.classList.toggle('is-editing', editing);
    if (editing) this.view.showSimulation(null);
    if (!this.dragging) this.view.sync(document, this.controller.selection);
    this.gizmos.setSnapping(document.settings.gridSnap);
    this.gizmos.setInteraction(this.controller.mode === 'edit', this.isActive());
    const transformTool = this.controller.tool === 'move' || this.controller.tool === 'rotate' || this.controller.tool === 'scale';
    const selected = this.controller.primary;
    const mesh = selected ? this.view.proxy(selected.id) : undefined;
    if (this.controller.mode === 'edit' && transformTool && mesh) {
      this.gizmos.transform.setMode(this.controller.tool === 'move' ? 'translate' : this.controller.tool === 'rotate' ? 'rotate' : 'scale');
      if (this.gizmos.transform.object !== mesh) this.gizmos.transform.attach(mesh);
    } else if (!this.dragging) {
      this.gizmos.transform.detach();
    }
    this.controls.sync({
      mode: this.controller.mode,
      tool: this.controller.tool,
      simTool: this.controller.simTool,
      placeKind: this.controller.placeKind,
      placePresetId: this.controller.placePresetId,
      gridSnap: document.settings.gridSnap,
      surfaceSnap: document.settings.surfaceSnap,
      brushRadius: document.settings.brushRadius,
      canUndo: this.controller.history.canUndo,
      canRedo: this.controller.history.canRedo,
      part: selected,
      parts: document.parts,
      selection: this.controller.selection,
      weldCount: document.welds.length,
      status: this.controller.status,
      structureVisible: this.controller.structureVisible,
      xray: this.controller.xray,
      simulationPaused: this.controller.simulationPaused,
      legend: legendEntries(document.parts, document.welds),
    });
  }

  private brushAccepts(hit: SurfaceHit): boolean {
    const point: [number, number, number] = [hit.point.x, hit.point.y, hit.point.z];
    return this.controller.tool === 'erase' ? this.controller.canErase(point) : this.controller.canPaint(hit.partId, point);
  }

  private onGizmoChange(): void {
    const mesh = this.gizmos.transform.object;
    const part = this.controller.primary;
    if (!mesh || !part) return;
    this.controller.previewTransform(
      part.id,
      [mesh.position.x, mesh.position.y, mesh.position.z],
      [mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w],
      mesh.scale.x,
    );
  }

  private onGizmoDrag(dragging: boolean): void {
    this.dragging = dragging;
    if (dragging) this.controller.beginGesture();
    else {
      this.controller.endGesture();
      this.refresh();
    }
  }

  private partMeshes(): THREE.Object3D[] {
    return this.controller.document.parts.flatMap((part) => {
      const mesh = this.view.proxy(part.id);
      if (!mesh) return [];
      mesh.userData.partId = part.id;
      return [mesh];
    });
  }

  private gizmoBusy(): boolean {
    const controls = this.gizmos.transform as unknown as { axis: string | null; dragging: boolean };
    return Boolean(controls.axis) || controls.dragging || this.dragging;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isActive() || this.controller.mode !== 'edit') return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === 'z') {
      event.preventDefault();
      this.edit(() => (event.shiftKey ? this.controller.redo() : this.controller.undo()));
    } else if ((event.metaKey || event.ctrlKey) && key === 'd') {
      event.preventDefault();
      this.edit(() => this.controller.duplicate());
    } else if (key === 'w') this.setTool('move');
    else if (key === 'e') this.setTool('rotate');
    else if (key === 'r') this.setTool('scale');
    else if (key === 'delete' || key === 'backspace') this.edit(() => this.controller.deleteSelected());
    else if (key === 'escape') {
      this.controller.select([]);
      this.refresh();
    }
  };

  private readonly authoredStats: MatterSimulation = {
    kind: 'assembly',
    get presetId() {
      return 'compiled';
    },
    topology: { kind: 'composite', particleCount: 0, parts: [], welds: [] },
    setPreset() {},
    reset() {},
    step() {},
    beginGrab() {
      return false;
    },
    updateGrab() {},
    endGrab() {},
    dropImpactor() {},
    setPressActive() {},
    frame() {
      return emptyFrame;
    },
    stats: () => {
      const parts = this.controller.document.parts;
      const center = parts.reduce(
        (sum, part) => [sum[0] + part.position[0], sum[1] + part.position[1], sum[2] + part.position[2]] as [number, number, number],
        [0, 0, 0] as [number, number, number],
      );
      const count = Math.max(1, parts.length);
      return {
        impactorCount: 0,
        pressBottom: 1.7,
        pressActive: false,
        grabbing: false,
        maxDeformation: 0,
        center: [center[0] / count, center[1] / count + 0.2, center[2] / count],
      };
    },
    dispose() {},
  };
}

function legendEntries(parts: readonly AssemblyPart[], welds: readonly WeldSample[]): LegendEntry[] {
  const entries: LegendEntry[] = [
    { label: 'Vertices', color: VERTEX_COLOR },
    { label: 'Edges', color: EDGE_COLOR },
  ];
  const seen = new Set<string>();
  for (const weld of welds) {
    const key = [weld.partA, weld.partB].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const a = parts.find((part) => part.id === weld.partA)?.label ?? weld.partA;
    const b = parts.find((part) => part.id === weld.partB)?.label ?? weld.partB;
    entries.push({ label: `${a} ↔ ${b}`, color: weld.color });
  }
  return entries;
}
