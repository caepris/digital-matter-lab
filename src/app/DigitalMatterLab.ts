import * as THREE from 'three';
import { findViewportAt, InteractionRouter } from '../interaction/InteractionRouter';
import { SimulationRunner } from '../simulation/SimulationRunner';
import type { SimulationStats, ToolId } from '../simulation/types';
import { AssemblyWorkspace } from './AssemblyWorkspace';
import type { PanelDefinition } from './MatterPanel';
import { MatterPanel } from './MatterPanel';
import { ConversionWorkspace } from './ConversionWorkspace';

const PAGE_BACKGROUND = 0x0d0f12;

const TOOL_CURSORS: Record<ToolId, string> = {
  grab: 'grab',
  drop: 'crosshair',
  press: 'ns-resize',
};

export interface LabTestHook {
  ready: boolean;
  activeWorkspace(): WorkspaceId;
  setWorkspace(workspace: WorkspaceId): void;
  panels: {
    kind: string;
    stats(): SimulationStats;
    /** Client-space pixel position of the body's current center. */
    bodyScreenPoint(): { x: number; y: number };
    frameCount(): number;
  }[];
  assembly: {
    mode(): 'edit' | 'simulate';
    partCount(): number;
    weldCount(): number;
    cameraPosition(): number[];
    screenPoint(x: number, y: number, z: number): { x: number; y: number };
  };
  conversion: {
    view(): 'source' | 'shell';
    sourceId(): string;
    thickness(): number;
    /** Distance between the rendered outer and inner shell surfaces. */
    renderedThickness(): number;
    simulationVertexCount(): number;
    sectionVisible(): boolean;
    sectionPosition(): number;
  };
}

export type WorkspaceId = 'comparison' | 'assembly' | 'conversion';

declare global {
  interface Window {
    __digitalMatterLab?: LabTestHook;
  }
}

export class DigitalMatterLab {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly panels: Array<MatterPanel | AssemblyWorkspace | ConversionWorkspace>;
  private readonly router: InteractionRouter;
  private readonly comparisonPanels: MatterPanel[];
  private readonly assemblyPanels: AssemblyWorkspace[];
  private readonly conversionPanels: ConversionWorkspace[];
  private comparisonWorkspace!: HTMLElement;
  private assemblyWorkspace!: HTMLElement;
  private conversionWorkspace!: HTMLElement;
  private readonly tabButtons = new Map<WorkspaceId, HTMLButtonElement>();
  private activeWorkspace: WorkspaceId = 'comparison';
  private readonly runner = new SimulationRunner({ fixedDt: 1 / 60, maxStepsPerFrame: 3 });
  private lastTime = performance.now();
  private frames = 0;
  private animationFrame = 0;

  constructor(root: HTMLElement, definitions: PanelDefinition[]) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lab-canvas';

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, stencil: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setClearColor(PAGE_BACKGROUND);

    this.comparisonPanels = definitions
      .filter((definition) => definition.kind !== 'assembly')
      .map((definition) => new MatterPanel(definition, this.canvas));
    this.assemblyPanels = [new AssemblyWorkspace(this.canvas, () => this.activeWorkspace === 'assembly')];
    this.conversionPanels = [new ConversionWorkspace(this.canvas, () => this.activeWorkspace === 'conversion')];
    this.panels = [...this.comparisonPanels, ...this.assemblyPanels, ...this.conversionPanels];

    root.append(this.canvas, this.createLayout());
    this.router = new InteractionRouter(this.canvas, () => this.activePanels());
    this.canvas.addEventListener('pointermove', this.updateCursor);

    window.addEventListener('resize', this.resize);
    this.resize();
    this.exposeTestHook();
    this.animationFrame = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    window.removeEventListener('resize', this.resize);
    this.router.dispose();
    for (const panel of this.panels) panel.dispose();
    this.renderer.dispose();
  }

  private createLayout(): HTMLElement {
    const layout = document.createElement('div');
    layout.className = 'lab-layout';

    const header = document.createElement('header');
    header.className = 'lab-header';
    header.innerHTML = `
      <div>
        <h1>Digital Matter Lab</h1>
        <p>Compare matter, weld mixed materials, and turn detailed meshes into thin simulation shells.</p>
      </div>`;

    const tabs = document.createElement('div');
    tabs.className = 'workspace-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Digital Matter Lab workspace');
    for (const [workspace, label] of [
      ['comparison', 'Comparison'],
      ['assembly', 'Assembly'],
      ['conversion', 'Thin conversion'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'workspace-tab';
      button.textContent = label;
      button.id = `${workspace}-tab`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', `${workspace}-workspace`);
      button.setAttribute('aria-selected', String(workspace === this.activeWorkspace));
      button.tabIndex = workspace === this.activeWorkspace ? 0 : -1;
      button.classList.toggle('is-selected', workspace === this.activeWorkspace);
      button.addEventListener('click', () => this.setWorkspace(workspace));
      button.addEventListener('keydown', this.onTabKeyDown);
      tabs.append(button);
      this.tabButtons.set(workspace, button);
    }

    const workspaceHost = document.createElement('main');
    workspaceHost.className = 'workspace-host';

    this.comparisonWorkspace = document.createElement('section');
    this.comparisonWorkspace.className = 'panel-grid comparison-grid';
    this.comparisonWorkspace.id = 'comparison-workspace';
    this.comparisonWorkspace.setAttribute('role', 'tabpanel');
    this.comparisonWorkspace.setAttribute('aria-labelledby', 'comparison-tab');
    for (const panel of this.comparisonPanels) this.comparisonWorkspace.append(panel.element);

    this.assemblyWorkspace = document.createElement('section');
    this.assemblyWorkspace.className = 'panel-grid assembly-grid';
    this.assemblyWorkspace.id = 'assembly-workspace';
    this.assemblyWorkspace.setAttribute('role', 'tabpanel');
    this.assemblyWorkspace.setAttribute('aria-labelledby', 'assembly-tab');
    this.assemblyWorkspace.hidden = true;
    for (const panel of this.assemblyPanels) this.assemblyWorkspace.append(panel.element);

    this.conversionWorkspace = document.createElement('section');
    this.conversionWorkspace.className = 'panel-grid conversion-grid';
    this.conversionWorkspace.id = 'conversion-workspace';
    this.conversionWorkspace.setAttribute('role', 'tabpanel');
    this.conversionWorkspace.setAttribute('aria-labelledby', 'conversion-tab');
    this.conversionWorkspace.hidden = true;
    for (const panel of this.conversionPanels) this.conversionWorkspace.append(panel.element);
    workspaceHost.append(this.comparisonWorkspace, this.assemblyWorkspace, this.conversionWorkspace);

    const footer = document.createElement('footer');
    footer.className = 'lab-footer';
    footer.textContent =
      'Comparison: test matter. Assembly: weld materials. Thin conversion: generate a shell proxy, then simulate it.';

    layout.append(header, tabs, workspaceHost, footer);
    return layout;
  }

  setWorkspace(workspace: WorkspaceId): void {
    if (workspace === this.activeWorkspace) return;
    this.router.cancelActive();
    for (const panel of this.activePanels()) panel.pointerUp();
    this.activeWorkspace = workspace;
    this.comparisonWorkspace.hidden = workspace !== 'comparison';
    this.assemblyWorkspace.hidden = workspace !== 'assembly';
    this.conversionWorkspace.hidden = workspace !== 'conversion';
    for (const panel of this.assemblyPanels) panel.setActive(workspace === 'assembly');
    for (const panel of this.conversionPanels) panel.setActive(workspace === 'conversion');
    for (const [id, button] of this.tabButtons) {
      const selected = id === workspace;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.classList.toggle('is-selected', selected);
    }
    this.tabButtons.get(workspace)?.focus();
  }

  private activePanels(): Array<MatterPanel | AssemblyWorkspace | ConversionWorkspace> {
    if (this.activeWorkspace === 'comparison') return this.comparisonPanels;
    return this.activeWorkspace === 'assembly' ? this.assemblyPanels : this.conversionPanels;
  }

  private onTabKeyDown = (event: KeyboardEvent): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const workspaces: WorkspaceId[] = ['comparison', 'assembly', 'conversion'];
    const current = workspaces.indexOf(this.activeWorkspace);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? workspaces.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + workspaces.length) % workspaces.length;
    this.setWorkspace(workspaces[next]);
  };

  private resize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  };

  private tick = (time: number): void => {
    this.animationFrame = requestAnimationFrame(this.tick);
    const elapsed = (time - this.lastTime) / 1000;
    this.lastTime = time;

    const alpha = this.runner.advance(elapsed, (dt) => {
      for (const panel of this.activePanels()) panel.step(dt);
    });

    const size = this.renderer.getSize(new THREE.Vector2());
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.setScissorTest(true);
    for (const panel of this.activePanels()) {
      const rect = panel.viewportRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const bottom = size.y - (rect.top + rect.height);
      this.renderer.setViewport(rect.left, bottom, rect.width, rect.height);
      this.renderer.setScissor(rect.left, bottom, rect.width, rect.height);
      panel.view.setAspect(rect.width / rect.height);
      panel.render(this.renderer, alpha);
    }
    this.frames++;
  };

  private updateCursor = (event: PointerEvent): void => {
    const bounds = this.canvas.getBoundingClientRect();
    const activePanels = this.activePanels();
    const index = findViewportAt(
      activePanels.map((panel) => panel.viewportRect()),
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
    const tool = index >= 0 ? activePanels[index].state.tool : null;
    const grabbing = event.buttons !== 0 && tool === 'grab';
    this.canvas.style.cursor = tool ? (grabbing ? 'grabbing' : TOOL_CURSORS[tool]) : 'default';
  };

  private exposeTestHook(): void {
    window.__digitalMatterLab = {
      ready: true,
      activeWorkspace: () => this.activeWorkspace,
      setWorkspace: (workspace) => this.setWorkspace(workspace),
      panels: this.panels.map((panel) => ({
        kind: panel.kind,
        stats: () => panel.simulation.stats(),
        frameCount: () => this.frames,
        bodyScreenPoint: () => {
          const [x, y, z] = panel.simulation.stats().center;
          const projected = new THREE.Vector3(x, y, z).project(panel.view.camera);
          const rect = panel.viewportRect();
          const canvasBounds = this.canvas.getBoundingClientRect();
          return {
            x: canvasBounds.left + rect.left + ((projected.x + 1) / 2) * rect.width,
            y: canvasBounds.top + rect.top + ((1 - projected.y) / 2) * rect.height,
          };
        },
      })),
      assembly: {
        mode: () => this.assemblyPanels[0].controller.mode,
        partCount: () => this.assemblyPanels[0].controller.document.parts.length,
        weldCount: () => this.assemblyPanels[0].controller.document.welds.length,
        cameraPosition: () => this.assemblyPanels[0].view.camera.position.toArray(),
        screenPoint: (x, y, z) => {
          const workspace = this.assemblyPanels[0];
          const projected = new THREE.Vector3(x, y, z).project(workspace.view.camera);
          const bounds = workspace.viewport.getBoundingClientRect();
          return {
            x: bounds.left + ((projected.x + 1) / 2) * bounds.width,
            y: bounds.top + ((1 - projected.y) / 2) * bounds.height,
          };
        },
      },
      conversion: {
        view: () => this.conversionPanels[0].state.view,
        sourceId: () => this.conversionPanels[0].sourceId,
        thickness: () => this.conversionPanels[0].thickness,
        renderedThickness: () => this.conversionPanels[0].view.renderedHalfThickness * 2,
        simulationVertexCount: () => this.conversionPanels[0].simulationVertexCount,
        sectionVisible: () => this.conversionPanels[0].sectionVisible,
        sectionPosition: () => this.conversionPanels[0].sectionPosition,
      },
    };
  }
}
