import * as THREE from 'three';
import type { InteractionTarget, ViewportRect } from '../interaction/InteractionRouter';
import { findPreset, presetsFor } from '../materials/presets';
import type { BodyVisual } from '../rendering/PanelView';
import { PanelView } from '../rendering/PanelView';
import { clampToPlatform, DROP_TARGET_PLANE_Y } from '../simulation/scene';
import type { MatterKind, MatterSimulation, PanelState, ToolId } from '../simulation/types';
import { PanelControls } from '../ui/PanelControls';

export interface PanelDefinition {
  kind: MatterKind;
  title: string;
  subtitle: string;
  accent: number;
  simulation: MatterSimulation;
  createVisual(simulation: MatterSimulation): BodyVisual;
  structureLegend?: { label: string; color: number }[];
}

const dropPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -DROP_TARGET_PLANE_Y);

export class MatterPanel implements InteractionTarget {
  readonly element: HTMLElement;
  readonly viewport: HTMLElement;
  readonly view: PanelView;
  readonly simulation: MatterSimulation;
  readonly kind: MatterKind;
  readonly state: PanelState;
  private readonly controls: PanelControls;
  private readonly structureLegend: HTMLElement | null;
  private activeTool: ToolId | null = null;

  constructor(
    definition: PanelDefinition,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.kind = definition.kind;
    this.simulation = definition.simulation;
    this.state = { tool: 'grab', presetId: this.simulation.presetId, structureVisible: false };
    this.view = new PanelView(definition.accent, definition.createVisual(this.simulation));
    this.view.setBodyColor(this.presetColor());

    this.controls = new PanelControls({
      title: definition.title,
      subtitle: definition.subtitle,
      accent: definition.accent,
      presets: presetsFor(definition.kind),
      state: this.state,
      onToolChange: (tool) => this.setTool(tool),
      onPresetChange: (id) => this.setPreset(id),
      onStructureToggle: (visible) => this.setStructureVisible(visible),
      onReset: () => this.reset(),
    });

    this.element = document.createElement('section');
    this.element.className = 'panel';
    this.element.dataset.kind = definition.kind;
    this.viewport = document.createElement('div');
    this.viewport.className = 'panel-viewport';
    this.viewport.append(this.controls.hintElement);
    this.structureLegend = definition.structureLegend
      ? this.createStructureLegend(definition.structureLegend)
      : null;
    if (this.structureLegend) this.viewport.append(this.structureLegend);
    this.element.append(this.controls.root, this.viewport);
    this.syncCursor();
  }

  get camera(): THREE.Camera {
    return this.view.camera;
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

  setTool(tool: ToolId): void {
    this.endInteraction();
    this.state.tool = tool;
    this.controls.sync(this.state);
    this.syncCursor();
  }

  setPreset(id: string): void {
    this.endInteraction();
    this.simulation.setPreset(id);
    this.state.presetId = this.simulation.presetId;
    this.view.setBodyColor(this.presetColor());
    this.controls.sync(this.state);
  }

  private presetColor(): number {
    return findPreset(presetsFor(this.kind), this.state.presetId).color;
  }

  setStructureVisible(visible: boolean): void {
    this.state.structureVisible = visible;
    this.view.setStructureVisible(visible);
    if (this.structureLegend) this.structureLegend.hidden = !visible;
  }

  reset(): void {
    this.endInteraction();
    this.simulation.reset();
  }

  step(dt: number): void {
    this.simulation.step(dt);
  }

  render(renderer: THREE.WebGLRenderer, alpha: number): void {
    this.view.update(this.simulation.frame(alpha), this.state.tool === 'press');
    renderer.render(this.view.scene, this.view.camera);
  }

  pointerDown(ray: THREE.Ray): boolean {
    switch (this.state.tool) {
      case 'grab':
        if (!this.simulation.beginGrab(ray)) return false;
        break;
      case 'drop': {
        const hit = ray.intersectPlane(dropPlane, new THREE.Vector3());
        if (hit) this.simulation.dropImpactor(clampToPlatform(hit.x), clampToPlatform(hit.z));
        return false;
      }
      case 'press':
        this.simulation.setPressActive(true);
        break;
    }
    this.activeTool = this.state.tool;
    this.viewport.classList.add('is-interacting');
    return true;
  }

  pointerMove(ray: THREE.Ray): void {
    if (this.activeTool === 'grab') this.simulation.updateGrab(ray);
  }

  pointerUp(): void {
    this.endInteraction();
  }

  dispose(): void {
    this.simulation.dispose();
    this.view.dispose();
  }

  private endInteraction(): void {
    if (this.activeTool === 'grab') this.simulation.endGrab();
    if (this.activeTool === 'press') this.simulation.setPressActive(false);
    this.activeTool = null;
    this.viewport.classList.remove('is-interacting');
  }

  private syncCursor(): void {
    this.viewport.dataset.tool = this.state.tool;
  }

  private createStructureLegend(items: { label: string; color: number }[]): HTMLElement {
    const legend = document.createElement('div');
    legend.className = 'structure-legend';
    legend.hidden = true;
    for (const item of items) {
      const row = document.createElement('span');
      const swatch = document.createElement('i');
      swatch.style.backgroundColor = `#${item.color.toString(16).padStart(6, '0')}`;
      row.append(swatch, item.label);
      legend.append(row);
    }
    return legend;
  }
}
