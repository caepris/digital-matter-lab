import * as THREE from 'three';
import {
  InteractionRouter,
  rayFromViewport,
  type InteractionTarget,
  type ViewportRect,
} from '../interaction/InteractionRouter';
import { ConversionVisual } from '../rendering/ConversionVisual';
import { createAssemblyGizmos, type AssemblyGizmos } from '../rendering/assemblyGizmos';
import { convertSurface, type ConvertedSurface } from '../simulation/conversion/convertSurface';
import { ConvertedShellSimulation } from '../simulation/conversion/ConvertedShellSimulation';
import {
  buildSourceMesh,
  particleMaterials,
  pinnedParticles,
  type SourceMesh,
  type SourceMeshId,
} from '../simulation/conversion/sourceMeshes';
import { clampToPlatform, DROP_TARGET_PLANE_Y, PRESS_REST_BOTTOM } from '../simulation/scene';
import type { MatterSimulation, SimulationFrame, SimulationStats, ToolId } from '../simulation/types';
import {
  MAX_ACCESSORY_SCALE,
  MAX_RIGID_WELDS,
  addRigidWeldPart,
  emptyRigidWeldDocument,
  nextRigidWeldId,
  removeRigidWeldPart,
  selectedRigidWeld,
  updateRigidWeldPart,
  type AccessoryTransformTool,
  type QuatTuple,
  type RigidWeldDocument,
  type RigidWeldPart,
  type Vec3Tuple,
} from '../conversion-editor/RigidWeldDocument';
import {
  placeRigidAccessory,
  recomputeRigidWelds,
} from '../simulation/conversion/autoWeldRigid';
import { RIGID_ACCESSORY_IDS, type RigidAccessoryId } from '../simulation/conversion/rigidAccessories';
import {
  ConversionControls,
  type ConversionControlModel,
  type ConversionSourceId,
  type ConversionView,
} from '../ui/ConversionControls';

const ACCENT = 0x5cc4a8;
const dropPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -DROP_TARGET_PLANE_Y);
const emptyFrame: SimulationFrame = {
  particles: null,
  cubePosition: null,
  cubeQuaternion: null,
  impactors: [],
  pressBottom: PRESS_REST_BOTTOM,
};

const TARGET_SPACING: Record<SourceMeshId, number> = {
  tshirt: 0.07,
  'denim-jacket': 0.05,
  curtain: 0.1,
  'car-shell': 0.1,
};

const PHYSICS: Record<SourceMeshId, { presetId: string; mass: number; structural: boolean }> = {
  tshirt: { presetId: 'loose-cloth', mass: 0.3, structural: false },
  'denim-jacket': { presetId: 'structured-fabric', mass: 0.8, structural: false },
  curtain: { presetId: 'loose-cloth', mass: 0.9, structural: false },
  'car-shell': { presetId: 'sheet-metal', mass: 2.4, structural: true },
};

const CAMERA_DIRECTION = new THREE.Vector3(3.1, 1.65, 3.8).normalize();

export class ConversionWorkspace implements InteractionTarget {
  readonly element: HTMLElement;
  readonly viewport: HTMLElement;
  readonly kind = 'conversion' as const;
  readonly state = {
    tool: 'grab' as ToolId,
    presetId: 'converted',
    structureVisible: false,
    sectionVisible: false,
    view: 'shell' as ConversionView,
    accessoryPresetId: RIGID_ACCESSORY_IDS[0] as RigidAccessoryId,
    accessoryTool: 'select' as AccessoryTransformTool,
  };
  readonly view: ConversionVisual;
  sourceId: ConversionSourceId = 'tshirt';
  thickness: number;
  private source: SourceMesh;
  private converted: ConvertedSurface | null = null;
  private shell: ConvertedShellSimulation | null = null;
  private simulationPaused = true;
  private generating = false;
  private generateTimer: ReturnType<typeof setTimeout> | null = null;
  private status = '';
  private activeTool: ToolId | null = null;
  private sectionDragging = false;
  private rigidWeldDocument: RigidWeldDocument = emptyRigidWeldDocument();
  private deletedAccessory: RigidWeldPart | null = null;
  private placementPreview: RigidWeldPart | null = null;
  private accessorySurfaceDragging = false;
  private accessoryDragging = false;
  private accessoryEditMode = false;
  private readonly controls: ConversionControls;
  private readonly gizmos: AssemblyGizmos;
  /** The viewport sits above the shared canvas, so it routes its own tool input. */
  private readonly router: InteractionRouter;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly isActive: () => boolean,
  ) {
    this.source = buildSourceMesh(this.sourceId);
    this.thickness = this.source.defaultThickness;
    this.view = new ConversionVisual(this.source, ACCENT);
    this.controls = new ConversionControls({
      onSource: (id) => {
        if (
          this.rigidWeldDocument.parts.length > 0 &&
          !window.confirm('Changing the source will remove all rigid accessories. Continue?')
        ) {
          this.refresh();
          return;
        }
        this.setSource(id);
      },
      onView: (view) => {
        this.state.view = view;
        this.view.setView(view);
        this.refresh();
      },
      onStructure: (visible) => {
        this.state.structureVisible = visible;
        this.view.setStructureVisible(visible);
        this.refresh();
      },
      onSection: (visible) => {
        this.state.sectionVisible = visible;
        this.view.setSectionVisible(visible);
        this.refresh();
      },
      onThickness: (thickness, commit) => this.setThickness(thickness, commit),
      onSimulationPaused: (paused) => {
        if (!paused && this.rigidWeldDocument.parts.some((part) => !part.valid)) {
          this.status = 'Move detached rigid meshes back into contact before simulating.';
          this.simulationPaused = true;
          this.refresh();
          return;
        }
        this.simulationPaused = paused;
        if (!paused) this.setAccessoryEditing(false, false);
        this.view.syncRigidWelds(
          this.rigidWeldDocument.parts,
          this.source,
          this.rigidWeldDocument.selectedId,
          false,
        );
        this.refresh();
      },
      onReset: () => this.resetSimulation(),
      onTool: (tool) => {
        this.pointerUp();
        this.state.tool = tool;
        this.refresh();
      },
      onAccessoryPreset: (id) => {
        this.state.accessoryPresetId = id;
        this.refresh();
      },
      onAccessoryEdit: (editing) => this.setAccessoryEditing(editing),
      onAccessoryAdd: () => this.beginAccessoryPlacement(),
      onAccessoryCancel: () => this.cancelAccessoryPlacement(),
      onAccessoryTool: (tool) => this.setAccessoryTool(tool),
      onAccessorySelect: (id) => {
        this.rigidWeldDocument = { ...this.rigidWeldDocument, selectedId: id };
        if (id) this.state.accessoryTool = 'move';
        this.refresh();
      },
      onAccessoryDuplicate: () => this.duplicateSelectedAccessory(),
      onAccessoryDelete: () => this.deleteSelectedAccessory(),
      onAccessoryUndoDelete: () => this.undoAccessoryDelete(),
    });

    this.element = document.createElement('section');
    this.element.className = 'panel';
    this.element.dataset.kind = 'conversion';
    this.viewport = document.createElement('div');
    this.viewport.className = 'panel-viewport conversion-viewport';
    this.viewport.append(this.controls.hint, this.controls.legend);
    this.element.append(this.controls.root, this.viewport);
    this.gizmos = createAssemblyGizmos(
      this.view.camera,
      this.viewport,
      this.canvas,
      () => this.onAccessoryGizmoChange(),
      (dragging) => this.onAccessoryGizmoDrag(dragging),
    );
    this.view.panel.scene.add(this.gizmos.transform.getHelper());
    this.gizmos.setInteraction(true, false);
    const localTarget: InteractionTarget = {
      camera: this.view.camera,
      viewportRect: () => ({ left: 0, top: 0, width: this.viewport.clientWidth, height: this.viewport.clientHeight }),
      pointerDown: (ray) => this.pointerDown(ray),
      pointerMove: (ray) => this.pointerMove(ray),
      pointerUp: () => this.pointerUp(),
    };
    this.router = new InteractionRouter(this.viewport, [localTarget]);
    this.viewport.addEventListener('pointermove', this.onViewportPointerMove);
    this.viewport.addEventListener('pointerdown', this.updateCursor);
    this.viewport.addEventListener('pointerup', this.updateCursor);
    this.viewport.addEventListener('pointerleave', this.clearPlacementPreview);
    window.addEventListener('keydown', this.onKeyDown);
    this.frameSource();
    this.scheduleGenerate();
  }

  private frameSource(): void {
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    const positions = this.source.positions;
    for (let i = 0; i < positions.length; i += 3) box.expandByPoint(point.set(positions[i], positions[i + 1], positions[i + 2]));
    for (const support of this.source.supports) {
      box.expandByPoint(point.fromArray(support.from));
      box.expandByPoint(point.fromArray(support.to));
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z);
    this.gizmos.orbit.target.copy(center);
    this.view.camera.position.copy(center).addScaledVector(CAMERA_DIRECTION, 2.4 + extent * 1.35);
    this.view.camera.lookAt(center);
    this.gizmos.orbit.update();
  }

  get camera(): THREE.Camera {
    return this.view.camera;
  }

  get simulation(): MatterSimulation {
    return this.shell ?? this.sourceStats;
  }

  get simulationVertexCount(): number {
    return this.converted ? this.converted.positions.length / 3 : 0;
  }

  get generatedRegionColorCount(): number {
    return this.view.generatedRegionColorCount;
  }

  get sectionVisible(): boolean {
    return this.state.sectionVisible;
  }

  get sectionPosition(): number {
    return this.view.sectionPosition;
  }

  get rigidWeldCount(): number {
    return this.rigidWeldDocument.parts.reduce((count, part) => count + part.welds.length, 0);
  }

  get rigidAccessoryCount(): number {
    return this.rigidWeldDocument.parts.length;
  }

  get accessoryEditing(): boolean {
    return this.accessoryEditMode;
  }

  get selectedAccessoryPosition(): number[] | null {
    return selectedRigidWeld(this.rigidWeldDocument)?.position ?? null;
  }

  get maxRigidWeldSeparation(): number {
    return this.shell?.maxWeldSeparation() ?? 0;
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

  setActive(active: boolean): void {
    if (!active) {
      this.router.cancelActive();
      this.pointerUp();
    }
    this.gizmos.setInteraction(true, active);
  }

  private updateCursor = (event: PointerEvent): void => {
    if (this.accessoryEditMode) {
      this.viewport.style.cursor =
        this.state.accessoryTool === 'place' ? 'copy' : this.state.accessoryTool === 'move' ? 'grab' : 'default';
      return;
    }
    const tool = this.state.tool;
    this.viewport.style.cursor =
      tool === 'grab' ? (event.buttons & 1 ? 'grabbing' : 'grab') : tool === 'drop' ? 'crosshair' : 'ns-resize';
  };

  private onViewportPointerMove = (event: PointerEvent): void => {
    this.updateCursor(event);
    if (!this.accessoryEditMode || this.state.accessoryTool !== 'place' || event.buttons !== 0) return;
    const bounds = this.viewport.getBoundingClientRect();
    const ray = rayFromViewport(
      this.view.camera,
      { left: 0, top: 0, width: bounds.width, height: bounds.height },
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
    this.placementPreview = placeRigidAccessory(
      ray,
      this.source,
      this.state.accessoryPresetId,
      'rigid-weld-preview',
    );
    this.view.syncPlacementPreview(this.placementPreview);
  };

  private clearPlacementPreview = (): void => {
    this.placementPreview = null;
    this.view.syncPlacementPreview(null);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isActive() || !this.accessoryEditMode) return;
    if (event.key === 'Escape' && this.state.accessoryTool === 'place') {
      event.preventDefault();
      this.cancelAccessoryPlacement();
    }
  };

  step(dt: number): void {
    if (!this.simulationPaused) this.shell?.step(dt);
  }

  render(renderer: THREE.WebGLRenderer, alpha: number): void {
    const frame = this.shell ? this.shell.frame(alpha) : emptyFrame;
    this.view.render(frame, this.shell !== null && this.state.tool === 'press');
    renderer.render(this.view.panel.scene, this.view.camera);
  }

  pointerDown(ray: THREE.Ray): boolean {
    if (this.gizmoBusy()) return false;
    if (this.accessoryEditMode && this.state.accessoryTool === 'place') {
      const part = placeRigidAccessory(
        ray,
        this.source,
        this.state.accessoryPresetId,
        nextRigidWeldId(this.rigidWeldDocument.parts),
      );
      if (!part) {
        this.status = 'Click directly on the source mesh to place the rigid mesh.';
        this.refresh();
        return false;
      }
      this.rigidWeldDocument = addRigidWeldPart(this.rigidWeldDocument, part);
      this.deletedAccessory = null;
      this.clearPlacementPreview();
      this.simulationPaused = true;
      this.state.view = 'source';
      this.state.accessoryTool = 'move';
      this.rebuildAfterAccessoryEdit();
      this.status = part.valid
        ? `Placed ${part.label} with ${part.welds.length} automatic weld point${part.welds.length === 1 ? '' : 's'}.`
        : `Placed ${part.label}, but no contact point could be welded.`;
      this.refresh();
      return false;
    }
    if (this.accessoryEditMode) {
      const id = this.view.rigidWeldAt(ray);
      if (id) {
        this.rigidWeldDocument = { ...this.rigidWeldDocument, selectedId: id };
        this.simulationPaused = true;
        if (this.state.accessoryTool === 'move') {
          this.accessorySurfaceDragging = true;
          this.viewport.classList.add('is-interacting');
          this.refresh();
          return true;
        }
        this.refresh();
        return false;
      }
      return false;
    }
    if (this.state.sectionVisible && this.view.beginSectionDrag(ray)) {
      this.sectionDragging = true;
      this.viewport.classList.add('is-interacting');
      return true;
    }
    if (!this.shell) return false;
    if (this.state.tool === 'grab') {
      if (!this.shell.beginGrab(ray)) return false;
    } else if (this.state.tool === 'drop') {
      const hit = ray.intersectPlane(dropPlane, new THREE.Vector3());
      if (hit) this.shell.dropImpactor(clampToPlatform(hit.x), clampToPlatform(hit.z));
      return false;
    } else {
      this.shell.setPressActive(true);
    }
    this.activeTool = this.state.tool;
    this.viewport.classList.add('is-interacting');
    return true;
  }

  pointerMove(ray: THREE.Ray): void {
    if (this.accessorySurfaceDragging) {
      const selected = selectedRigidWeld(this.rigidWeldDocument);
      if (!selected) return;
      const placed = placeRigidAccessory(ray, this.source, selected.presetId as RigidAccessoryId, selected.id);
      if (!placed) return;
      const moved = recomputeRigidWelds(
        {
          ...placed,
          label: selected.label,
          uniformScale: selected.uniformScale,
        },
        this.source,
      );
      this.rigidWeldDocument = updateRigidWeldPart(this.rigidWeldDocument, selected.id, () => moved);
      this.view.syncRigidWelds(
        this.rigidWeldDocument.parts,
        this.source,
        this.rigidWeldDocument.selectedId,
        true,
      );
      return;
    }
    if (this.sectionDragging) {
      this.view.updateSectionDrag(ray);
      return;
    }
    if (this.activeTool === 'grab') this.shell?.updateGrab(ray);
  }

  pointerUp(): void {
    if (this.accessorySurfaceDragging) {
      this.accessorySurfaceDragging = false;
      this.viewport.classList.remove('is-interacting');
      this.rebuildAfterAccessoryEdit();
      const selected = selectedRigidWeld(this.rigidWeldDocument);
      this.status = selected?.valid
        ? `${selected.label} attached at ${selected.welds.length} weld point${selected.welds.length === 1 ? '' : 's'}.`
        : 'Detached: slide the accessory back onto the source.';
      this.refresh();
      return;
    }
    this.sectionDragging = false;
    if (this.activeTool === 'grab') this.shell?.endGrab();
    if (this.activeTool === 'press') this.shell?.setPressActive(false);
    this.activeTool = null;
    this.viewport.classList.remove('is-interacting');
  }

  dispose(): void {
    if (this.generateTimer !== null) clearTimeout(this.generateTimer);
    this.pointerUp();
    this.router.dispose();
    this.viewport.removeEventListener('pointermove', this.onViewportPointerMove);
    this.viewport.removeEventListener('pointerdown', this.updateCursor);
    this.viewport.removeEventListener('pointerup', this.updateCursor);
    this.viewport.removeEventListener('pointerleave', this.clearPlacementPreview);
    window.removeEventListener('keydown', this.onKeyDown);
    this.shell?.dispose();
    this.gizmos.dispose();
    this.view.dispose();
  }

  private setSource(id: ConversionSourceId): void {
    this.pointerUp();
    this.shell?.dispose();
    this.shell = null;
    this.converted = null;
    this.sourceId = id;
    this.source = buildSourceMesh(id);
    this.accessoryEditMode = false;
    this.deletedAccessory = null;
    this.clearPlacementPreview();
    if (this.rigidWeldDocument.parts.length > 0) {
      this.rigidWeldDocument = emptyRigidWeldDocument();
      this.status = 'Changed source and cleared rigid welds because their surface anchors no longer apply.';
    }
    if (this.state.view === 'material' && this.source.materials.length === 0) this.state.view = 'source';
    this.thickness = this.source.defaultThickness;
    this.simulationPaused = true;
    this.view.configure(this.source, null, this.thickness);
    this.syncView();
    this.frameSource();
    this.scheduleGenerate();
  }

  private setThickness(thickness: number, commit: boolean): void {
    this.thickness = THREE.MathUtils.clamp(thickness, 0.002, 0.08);
    this.shell?.setThickness(this.thickness);
    this.view.setThickness(this.thickness);
    this.status = commit && this.shell
      ? `Thickness is now ${(this.thickness * 100).toFixed(1)} cm. Fill and bending stiffness updated live.`
      : '';
    this.refresh();
  }

  /** Deferred so the source swap paints before the conversion work blocks the main thread. */
  private scheduleGenerate(): void {
    if (this.generateTimer !== null) clearTimeout(this.generateTimer);
    this.generating = true;
    this.status = `Generating a thin shell for the ${this.source.label}…`;
    this.refresh();
    this.generateTimer = setTimeout(() => {
      this.generateTimer = null;
      this.generate();
    }, 0);
  }

  private generate(): void {
    this.pointerUp();
    this.generating = false;
    try {
      const converted = convertSurface({
        positions: this.source.positions,
        triangles: this.source.triangles,
        targetSpacing: TARGET_SPACING[this.sourceId],
      });
      this.converted = converted;
      this.createSimulation();
      const hanging = this.shell?.pinned.length ?? 0;
      this.status =
        `Closed shell generated around the ${this.source.label}.` +
        (hanging > 0 ? ` ${hanging} particles hang from the ${this.sourceId === 'curtain' ? 'rod' : 'hanger'}.` : '') +
        ' Press Play to simulate.';
      this.view.configure(this.source, converted, this.thickness);
      this.syncView();
    } catch (error) {
      this.converted = null;
      this.shell = null;
      this.status = `Could not generate shell: ${String(error)}`;
    }
    this.refresh();
  }

  private syncView(): void {
    this.view.setView(this.state.view);
    this.view.setStructureVisible(this.state.structureVisible);
    this.view.setSectionVisible(this.state.sectionVisible);
    this.view.syncRigidWelds(
      this.rigidWeldDocument.parts,
      this.source,
      this.rigidWeldDocument.selectedId,
      this.accessoryEditMode,
    );
  }

  private createSimulation(): void {
    if (!this.converted) return;
    this.shell?.dispose();
    const physics = PHYSICS[this.sourceId];
    const regionIds =
      this.source.materials.length > 0
        ? particleMaterials(
            this.source,
            this.converted.positions.length / 3,
            this.converted.triangles,
            this.converted.sourceBindings,
          )
        : undefined;
    this.shell = new ConvertedShellSimulation({
      mesh: this.converted,
      thickness: this.thickness,
      presetId: physics.presetId,
      totalMass: physics.mass,
      structural: physics.structural,
      pinned: pinnedParticles(this.source, this.converted.positions, regionIds),
      regions:
        regionIds
          ? {
              materials: this.source.materials,
              particleMaterials: regionIds,
            }
          : undefined,
      rigidWelds: {
        source: this.source,
        parts: this.rigidWeldDocument.parts,
      },
    });
    this.simulationPaused = true;
  }

  private resetSimulation(): void {
    this.pointerUp();
    const wasPaused = this.simulationPaused;
    this.createSimulation();
    this.simulationPaused = wasPaused;
    if (this.converted) {
      this.view.configure(this.source, this.converted, this.thickness);
      this.syncView();
    }
    this.status = wasPaused ? 'Simulation reset and paused.' : 'Simulation reset and playing.';
    this.refresh();
  }

  private refresh(): void {
    const generated = this.converted
      ? {
          vertices: this.converted.positions.length / 3,
          triangles: this.converted.triangles.length / 3,
          stretchEdges: this.converted.stretchPairs.length / 2,
          bendPairs: this.converted.bendPairs.length / 2,
        }
      : null;
    const showingSource = !this.converted || this.state.view !== 'shell';
    const structureLegend = !this.state.structureVisible
      ? []
      : showingSource
        ? [
            { label: 'Rigid solid surface vertices', color: 0xf4f6fa },
            { label: 'Closed solid edges', color: 0x9ba8b8 },
          ]
        : [
            { label: 'Simulation particles', color: 0xf4f6fa },
            { label: 'Stretch and bend structure', color: 0x60e0c1 },
          ];
    const materialLegend =
      this.state.view === 'material'
        ? this.source.materials.map((material) => ({ label: material.label, color: material.color }))
        : [];
    const model: ConversionControlModel = {
      sourceId: this.sourceId,
      view: this.state.view,
      structureVisible: this.state.structureVisible,
      sectionVisible: this.state.sectionVisible,
      materialMapped: this.source.materials.length > 0,
      thickness: this.thickness,
      generated,
      generating: this.generating,
      status: this.status,
      simulationPaused: this.simulationPaused,
      tool: this.state.tool,
      accessoryPresetId: this.state.accessoryPresetId,
      accessoryTool: this.state.accessoryTool,
      accessoryParts: this.rigidWeldDocument.parts.map((part, index) => ({
        id: part.id,
        label: `${part.label} ${index + 1}`,
        valid: part.valid,
        weldCount: part.welds.length,
      })),
      selectedAccessoryId: this.rigidWeldDocument.selectedId,
      accessoryEditing: this.accessoryEditMode,
      accessoryCapacity: { used: this.rigidWeldDocument.parts.length, max: MAX_RIGID_WELDS },
      canUndoAccessoryDelete: this.deletedAccessory !== null,
      accessoriesValid: this.rigidWeldDocument.parts.every((part) => part.valid),
      legend: [...materialLegend, ...structureLegend],
    };
    this.controls.sync(model);
    if (!this.accessoryDragging) {
      this.view.syncRigidWelds(
        this.rigidWeldDocument.parts,
        this.source,
        this.rigidWeldDocument.selectedId,
        this.accessoryEditMode,
      );
    }
    const transformTool = this.state.accessoryTool === 'rotate' || this.state.accessoryTool === 'scale';
    const selected = selectedRigidWeld(this.rigidWeldDocument);
    const proxy = selected ? this.view.rigidWeldProxy(selected.id) : undefined;
    if (transformTool && proxy && this.accessoryEditMode) {
      this.gizmos.transform.setMode(
        this.state.accessoryTool === 'move'
          ? 'translate'
          : this.state.accessoryTool === 'rotate'
            ? 'rotate'
            : 'scale',
      );
      if (this.gizmos.transform.object !== proxy) this.gizmos.transform.attach(proxy);
    } else if (!this.accessoryDragging) {
      this.gizmos.transform.detach();
    }
  }

  private setAccessoryEditing(editing: boolean, refresh = true): void {
    this.pointerUp();
    const entering = editing && !this.accessoryEditMode;
    this.accessoryEditMode = editing;
    if (editing) {
      this.simulationPaused = true;
      if (entering && this.converted) this.createSimulation();
      this.state.view = 'source';
      this.view.setView('source');
      this.state.accessoryTool = this.rigidWeldDocument.selectedId ? 'move' : 'select';
      this.status = 'Accessory editing is active. Simulation tools are paused.';
    } else {
      this.cancelAccessoryPlacement(false);
      this.state.accessoryTool = 'select';
      this.status = this.rigidWeldDocument.parts.length
        ? 'Accessory edits applied. Press Play to simulate the welded assembly.'
        : 'Accessory editing finished.';
    }
    if (refresh) this.refresh();
  }

  private beginAccessoryPlacement(): void {
    if (this.rigidWeldDocument.parts.length >= MAX_RIGID_WELDS) {
      this.status = `Accessory limit reached (${MAX_RIGID_WELDS}).`;
      this.refresh();
      return;
    }
    if (!this.accessoryEditMode) this.setAccessoryEditing(true, false);
    this.state.accessoryTool = 'place';
    this.state.view = 'source';
    this.view.setView('source');
    this.status = 'Move over the source to preview attachment, then click to place. Press Escape to cancel.';
    this.refresh();
  }

  private cancelAccessoryPlacement(refresh = true): void {
    this.clearPlacementPreview();
    if (this.state.accessoryTool === 'place') {
      this.state.accessoryTool = this.rigidWeldDocument.selectedId ? 'move' : 'select';
      this.status = 'Placement cancelled.';
    }
    if (refresh) this.refresh();
  }

  private setAccessoryTool(tool: AccessoryTransformTool): void {
    this.pointerUp();
    this.simulationPaused = true;
    this.accessoryEditMode = true;
    this.clearPlacementPreview();
    this.state.accessoryTool = tool;
    this.state.view = 'source';
    this.view.setView('source');
    this.status =
      tool === 'place'
        ? 'Click the source mesh to place and auto-weld the selected rigid mesh.'
        : tool === 'select'
          ? 'Select a placed rigid mesh.'
          : `${tool[0].toUpperCase()}${tool.slice(1)} the selected rigid mesh; welds update when you release.`;
    this.refresh();
  }

  private deleteSelectedAccessory(): void {
    const selected = selectedRigidWeld(this.rigidWeldDocument);
    if (!selected) return;
    this.deletedAccessory = selected;
    this.rigidWeldDocument = removeRigidWeldPart(this.rigidWeldDocument, selected.id);
    this.rebuildAfterAccessoryEdit();
    this.status = `Deleted ${selected.label} and its welds.`;
    this.refresh();
  }

  private undoAccessoryDelete(): void {
    if (!this.deletedAccessory || this.rigidWeldDocument.parts.length >= MAX_RIGID_WELDS) return;
    const restored = this.deletedAccessory;
    this.deletedAccessory = null;
    this.rigidWeldDocument = addRigidWeldPart(this.rigidWeldDocument, restored);
    this.rebuildAfterAccessoryEdit();
    this.status = `Restored ${restored.label}.`;
    this.refresh();
  }

  private duplicateSelectedAccessory(): void {
    const selected = selectedRigidWeld(this.rigidWeldDocument);
    if (!selected || this.rigidWeldDocument.parts.length >= MAX_RIGID_WELDS) return;
    const id = nextRigidWeldId(this.rigidWeldDocument.parts);
    const duplicate = recomputeRigidWelds(
      {
        ...selected,
        id,
        position: [selected.position[0] + 0.035, selected.position[1], selected.position[2]],
        welds: [],
      },
      this.source,
    );
    this.rigidWeldDocument = addRigidWeldPart(this.rigidWeldDocument, duplicate);
    this.deletedAccessory = null;
    this.state.accessoryTool = 'move';
    this.rebuildAfterAccessoryEdit();
    this.status = duplicate.valid
      ? `Duplicated ${duplicate.label}; slide it to a new location.`
      : `Duplicated ${duplicate.label}, but it needs to be slid back onto the source.`;
    this.refresh();
  }

  private rebuildAfterAccessoryEdit(): void {
    this.simulationPaused = true;
    this.accessoryEditMode = true;
    if (this.converted) this.createSimulation();
    this.syncView();
    this.refresh();
  }

  private onAccessoryGizmoChange(): void {
    const mesh = this.gizmos.transform.object;
    const selected = selectedRigidWeld(this.rigidWeldDocument);
    if (!mesh || !selected) return;
    const scale = Math.min(MAX_ACCESSORY_SCALE, Math.max(0.5, Math.max(mesh.scale.x, mesh.scale.y, mesh.scale.z)));
    mesh.scale.setScalar(scale);
    const position: Vec3Tuple = [mesh.position.x, mesh.position.y, mesh.position.z];
    const quaternion: QuatTuple = [mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w];
    this.rigidWeldDocument = updateRigidWeldPart(this.rigidWeldDocument, selected.id, (part) => ({
      ...part,
      position,
      quaternion,
      uniformScale: scale,
    }));
  }

  private onAccessoryGizmoDrag(dragging: boolean): void {
    this.accessoryDragging = dragging;
    if (dragging) {
      this.simulationPaused = true;
      return;
    }
    const selected = selectedRigidWeld(this.rigidWeldDocument);
    if (selected) {
      this.rigidWeldDocument = updateRigidWeldPart(this.rigidWeldDocument, selected.id, (part) =>
        recomputeRigidWelds(part, this.source),
      );
    }
    this.rebuildAfterAccessoryEdit();
    const updated = selectedRigidWeld(this.rigidWeldDocument);
    this.status = updated?.valid
      ? `Updated ${updated.label}: ${updated.welds.length} automatic weld point${updated.welds.length === 1 ? '' : 's'}.`
      : 'Detached: move the rigid mesh back into contact before simulating.';
    this.refresh();
  }

  private gizmoBusy(): boolean {
    const transform = this.gizmos.transform as unknown as { axis: string | null; dragging: boolean };
    return Boolean(transform.axis) || transform.dragging || this.accessoryDragging;
  }

  private readonly sourceStats: MatterSimulation = {
    kind: 'shell',
    get presetId() {
      return 'loose-cloth';
    },
    topology: {
      kind: 'particles',
      particleCount: 0,
      segments: 0,
      faceGrids: [],
      structureEdges: new Uint32Array(),
    },
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
    stats: (): SimulationStats => {
      const positions = this.source.positions;
      let x = 0;
      let y = 0;
      let z = 0;
      const count = positions.length / 3;
      for (let i = 0; i < count; i++) {
        x += positions[i * 3];
        y += positions[i * 3 + 1];
        z += positions[i * 3 + 2];
      }
      return {
        impactorCount: 0,
        pressBottom: PRESS_REST_BOTTOM,
        pressActive: false,
        grabbing: false,
        maxDeformation: 0,
        center: [x / count, y / count, z / count],
      };
    },
    dispose() {},
  };
}
