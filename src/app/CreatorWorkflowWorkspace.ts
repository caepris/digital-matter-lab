import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { InteractionRouter, rayFromViewport, type ViewportRect } from '../interaction/InteractionRouter';
import { CreatorWorkflowVisual } from '../rendering/CreatorWorkflowVisual';
import { attachTrackpadPan, type PanBounds } from '../rendering/trackpadPan';
import { CreatorWorkflowControls } from '../ui/CreatorWorkflowControls';
import { workflowAsset } from '../creator-workflow/workflowAssets';
import { loadWorkflowSurface } from '../creator-workflow/loadWorkflowMesh';
import { workflowStageCopy } from '../creator-workflow/workflowCopy';
import {
  buildWorkflowPathData,
  proceduralWorkflowSources,
  proxyParticleCount,
  type WorkflowPathData,
  type WorkflowSources,
} from '../creator-workflow/workflowPipeline';
import {
  workflowAttachments,
  workflowColliders,
  workflowPhysics,
  workflowWind,
} from '../creator-workflow/workflowPhysics';
import {
  DEFAULT_WORKFLOW_STATE,
  displayThickness,
  WORKFLOW_STAGES,
  WORKFLOW_PATHS,
  type CreatorWorkflowState,
  type WorkflowPath,
} from '../creator-workflow/workflowTypes';
import { ConvertedShellSimulation } from '../simulation/conversion/ConvertedShellSimulation';
import type { ToolId } from '../simulation/types';

const PATH_COPY: Record<WorkflowPath, { title: string; accent: string }> = {
  shell: { title: 'Engine-generated shell', accent: '#7fa3ff' },
  plane: { title: 'Creator simulation plane', accent: '#42d6c0' },
  thicken: { title: 'Engine-thickened surface', accent: '#f29a62' },
};

const CLICK_TOLERANCE = 0.012;
const CAMERA_POSITION = new THREE.Vector3(2.1, 1.6, 2.7);
const CAMERA_TARGET = new THREE.Vector3(0, 0.78, 0);
/** Simulated seconds run before Simulate is shown, so garments start draped instead of falling. */
const SETTLE_SECONDS = 0.6;
const PAN_BOUNDS: PanBounds = { min: new THREE.Vector3(-2, -0.2, -2), max: new THREE.Vector3(2, 2, 2) };

export class CreatorWorkflowPanel {
  readonly element = document.createElement('article');
  readonly viewport = document.createElement('div');
  readonly state = { tool: 'grab' as ToolId };
  readonly view: {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    setAspect(aspect: number): void;
  };
  readonly controls: OrbitControls;
  readonly visual: CreatorWorkflowVisual;
  private readonly status = document.createElement('span');
  private readonly assetNote = document.createElement('p');
  private readonly stageStatus = document.createElement('p');
  private readonly inspectButton = document.createElement('button');
  private readonly caption = document.createElement('p');
  private readonly interaction: InteractionRouter;
  private readonly canvas: HTMLCanvasElement;
  private simulation: ConvertedShellSimulation | null = null;
  private data: WorkflowPathData;
  private currentState: CreatorWorkflowState;
  private active = false;
  private grabbing = false;
  private pendingCap: { region: number; ray: THREE.Ray } | null = null;
  private lastRay: THREE.Ray | null = null;
  private readonly detachTrackpadPan: () => void;

  constructor(
    readonly path: WorkflowPath,
    canvas: HTMLCanvasElement,
    initial: CreatorWorkflowState,
    onCameraChange: (panel: CreatorWorkflowPanel) => void,
    private readonly onToggleCap: (region: number) => void,
    onInspect: (path: WorkflowPath) => void,
  ) {
    this.canvas = canvas;
    this.currentState = initial;
    this.data = buildWorkflowPathData(initial, path, proceduralWorkflowSources(initial.assetId, 0.25));
    const copy = PATH_COPY[path];
    this.element.className = 'panel workflow-card';
    this.element.dataset.workflowPath = path;
    this.element.style.setProperty('--accent', copy.accent);
    this.element.setAttribute('role', 'group');

    const heading = document.createElement('header');
    heading.className = 'workflow-card-heading panel-controls';
    const eyebrow = document.createElement('div');
    eyebrow.className = 'workflow-card-eyebrow';
    eyebrow.textContent = `Path ${WORKFLOW_PATHS.indexOf(path) + 1}`;
    const titleLine = document.createElement('div');
    titleLine.className = 'workflow-card-title-line';
    const title = document.createElement('h3');
    title.className = 'panel-title';
    title.textContent = copy.title;
    title.id = `workflow-title-${path}`;
    this.element.setAttribute('aria-labelledby', title.id);
    this.status.className = 'workflow-stage-badge';
    this.inspectButton.type = 'button';
    this.inspectButton.className = 'workflow-inspect';
    this.inspectButton.dataset.testid = `workflow-inspect-${path}`;
    this.inspectButton.addEventListener('click', () => onInspect(path));
    const badges = document.createElement('div');
    badges.className = 'workflow-card-badges';
    badges.append(this.status, this.inspectButton);
    titleLine.append(title, badges);
    this.setInspected(false);
    this.assetNote.className = 'workflow-asset-note';
    this.stageStatus.className = 'workflow-path-status';
    this.stageStatus.dataset.testid = `workflow-path-status-${path}`;
    this.stageStatus.setAttribute('aria-live', 'polite');
    heading.append(eyebrow, titleLine, this.stageStatus, this.assetNote);

    this.viewport.className = 'panel-viewport workflow-viewport';
    this.viewport.dataset.testid = `workflow-viewport-${path}`;
    this.caption.className = 'workflow-viewport-caption';
    this.caption.dataset.testid = `workflow-caption-${path}`;
    this.viewport.append(this.caption);
    this.element.append(heading, this.viewport);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x15181d);
    scene.fog = new THREE.Fog(0x15181d, 8, 15);
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
    camera.position.copy(CAMERA_POSITION);
    camera.lookAt(CAMERA_TARGET);
    scene.add(new THREE.HemisphereLight(0xdce6ff, 0x262a32, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.5);
    key.position.set(3, 5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8eaaff, 1.1);
    rim.position.set(-4, 1, -3);
    scene.add(rim);

    this.visual = new CreatorWorkflowVisual(path, initial, this.data);
    scene.add(this.visual.root);
    this.view = {
      scene,
      camera,
      setAspect: (aspect: number) => {
        if (Math.abs(camera.aspect - aspect) > 0.0001) {
          camera.aspect = aspect;
          camera.updateProjectionMatrix();
        }
      },
    };
    this.controls = new OrbitControls(camera, this.viewport);
    this.controls.target.copy(CAMERA_TARGET);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 8;
    this.controls.addEventListener('change', () => onCameraChange(this));
    this.detachTrackpadPan = attachTrackpadPan(this.controls, this.viewport, camera, PAN_BOUNDS);
    this.interaction = new InteractionRouter(this.viewport, [
      {
        camera,
        viewportRect: () => this.localRect(),
        pointerDown: (ray) => this.pointerDown(ray),
        pointerMove: (ray) => this.pointerMove(ray),
        pointerUp: () => this.pointerUp(),
      },
    ]);
    this.viewport.addEventListener('pointermove', this.onHover);
    this.viewport.addEventListener('pointerleave', this.onLeave);
    this.update(initial);
  }

  get camera(): THREE.Camera {
    return this.view.camera;
  }

  private get picking(): boolean {
    return this.path === 'shell' && this.currentState.stage === 'submit';
  }

  update(state: CreatorWorkflowState): void {
    const enteredSimulate = this.currentState.stage !== 'simulate' && state.stage === 'simulate';
    this.currentState = state;
    this.visual.update(state);
    if (!this.picking) this.setHover(0);
    this.status.textContent = stageLabel(state.stage, state.simulationPaused);
    this.status.dataset.stage = state.stage;
    const copy = workflowStageCopy(state.assetId, this.path, state.stage);
    this.stageStatus.textContent = copy.status;
    this.assetNote.textContent = copy.headline;
    this.updateCaption();
    if (state.stage === 'simulate') {
      if (!this.simulation || enteredSimulate) this.createSimulation();
      this.simulation?.setWind(workflowWind(state.assetId, this.path, state.wind, state.endCaps));
    } else {
      this.disposeSimulation();
    }
  }

  setData(data: WorkflowPathData, state: CreatorWorkflowState): void {
    this.data = data;
    this.currentState = state;
    this.visual.setData(data, state);
    this.updateCaption();
    if (state.stage === 'simulate') this.createSimulation();
  }

  setInspected(inspected: boolean): void {
    this.element.classList.toggle('is-inspected', inspected);
    if (inspected) {
      this.element.setAttribute('role', 'dialog');
      this.element.setAttribute('aria-modal', 'true');
    } else {
      this.element.setAttribute('role', 'group');
      this.element.removeAttribute('aria-modal');
    }
    this.inspectButton.textContent = inspected ? 'Close' : 'Inspect';
    this.inspectButton.setAttribute('aria-pressed', String(inspected));
    this.inspectButton.title = inspected ? 'Close the window (Esc)' : 'Open this viewport in a window';
  }

  /** Adds path-specific controls under the card's status. */
  addHeadingControls(controls: HTMLElement): void {
    this.assetNote.after(controls);
  }

  focusInspect(): void {
    this.inspectButton.focus();
  }

  setLoading(loading: boolean): void {
    this.element.classList.toggle('is-loading', loading);
    this.element.setAttribute('aria-busy', String(loading));
  }

  setActive(active: boolean): void {
    this.active = active;
    this.controls.enabled = active && !this.grabbing;
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
    if (this.currentState.stage === 'simulate' && !this.currentState.simulationPaused) {
      this.simulation?.step(dt);
    }
  }

  render(renderer: THREE.WebGLRenderer, alpha: number): void {
    this.controls.update();
    const particles = this.simulation?.frame(alpha).particles;
    if (particles) this.visual.updateSimulation(particles);
    renderer.render(this.view.scene, this.view.camera);
  }

  pointerDown(ray: THREE.Ray): boolean {
    if (this.picking) {
      const region = this.visual.pickRegion(ray);
      if (region <= 0) return false;
      this.pendingCap = { region, ray: ray.clone() };
      this.lastRay = ray.clone();
      return true;
    }
    if (this.currentState.stage !== 'simulate' || !this.simulation?.beginGrab(ray)) return false;
    this.grabbing = true;
    this.controls.enabled = false;
    this.viewport.classList.add('is-interacting');
    return true;
  }

  pointerMove(ray: THREE.Ray): void {
    if (this.pendingCap) this.lastRay = ray.clone();
    if (this.grabbing) this.simulation?.updateGrab(ray);
  }

  pointerUp(): void {
    const pending = this.pendingCap;
    this.pendingCap = null;
    if (pending && this.lastRay && pending.ray.direction.angleTo(this.lastRay.direction) < CLICK_TOLERANCE) {
      this.onToggleCap(pending.region);
    }
    this.simulation?.endGrab();
    this.grabbing = false;
    this.controls.enabled = this.active;
    this.viewport.classList.remove('is-interacting');
  }

  resetSimulation(): void {
    this.simulation?.reset();
  }

  simulationStats(): { vertexCount: number; maxDeformation: number } {
    return {
      vertexCount: this.simulation?.shellParticleCount ?? 0,
      maxDeformation: this.simulation?.stats().maxDeformation ?? 0,
    };
  }

  proxyParticleCount(): number {
    return proxyParticleCount(this.data);
  }

  meshSource(): string {
    return this.data.render.source ?? 'procedural';
  }

  /** Client coordinates of a cap region's centroid in this viewport. */
  capScreenPoint(region: number): { x: number; y: number } | null {
    const { positions, capRegion } = this.data.render;
    const centroid = new THREE.Vector3();
    let count = 0;
    for (let index = 0; index < capRegion.length; index += 1) {
      if (capRegion[index] !== region) continue;
      centroid.x += positions[index * 3];
      centroid.y += positions[index * 3 + 1];
      centroid.z += positions[index * 3 + 2];
      count += 1;
    }
    if (count === 0) return null;
    centroid.divideScalar(count);
    this.view.camera.updateMatrixWorld();
    const ndc = centroid.project(this.view.camera);
    const bounds = this.viewport.getBoundingClientRect();
    return { x: bounds.left + ((ndc.x + 1) / 2) * bounds.width, y: bounds.top + ((1 - ndc.y) / 2) * bounds.height };
  }

  dispose(): void {
    this.viewport.removeEventListener('pointermove', this.onHover);
    this.viewport.removeEventListener('pointerleave', this.onLeave);
    this.detachTrackpadPan();
    this.controls.dispose();
    this.interaction.dispose();
    this.disposeSimulation();
    this.visual.dispose();
  }

  private localRect(): ViewportRect {
    return { left: 0, top: 0, width: this.viewport.clientWidth, height: this.viewport.clientHeight };
  }

  private readonly onHover = (event: PointerEvent): void => {
    if (!this.picking || event.buttons !== 0) return;
    const bounds = this.viewport.getBoundingClientRect();
    const ray = rayFromViewport(this.view.camera, this.localRect(), event.clientX - bounds.left, event.clientY - bounds.top);
    this.setHover(this.visual.pickRegion(ray));
  };

  private readonly onLeave = (): void => this.setHover(0);

  private setHover(region: number): void {
    this.visual.setHoverRegion(region);
    this.viewport.classList.toggle('is-picking', region > 0);
    if (region > 0) {
      const label = workflowAsset(this.currentState.assetId).capRegions.find((cap) => cap.id === region)?.label;
      const marked = this.currentState.endCaps.includes(region);
      this.caption.textContent = `${label}: click to ${marked ? 'unmark' : 'mark'} as end cap`;
    } else {
      this.updateCaption();
    }
  }

  private updateCaption(): void {
    const { stage, endCaps } = this.currentState;
    const particles = proxyParticleCount(this.data);
    let text: string;
    if (stage === 'simulate') {
      text =
        this.path === 'plane'
          ? `${particles} plane particles. Nothing to collide with.`
          : workflowColliders(this.currentState.assetId, this.path).length > 0
            ? `${particles} particles over a grey collision body. Drag to grab.`
            : `${particles} particles. Drag to grab.`;
    } else if (this.path === 'shell') {
      text =
        stage === 'submit'
          ? 'Click an opening to mark it as an end cap.'
          : endCaps.length === 0
            ? `Teal shell, ${particles} particles. The full mesh simulates.`
            : `Teal shell, ${particles} particles. Amber caps render but are not simulated.`;
    } else if (this.path === 'plane') {
      text =
        stage === 'submit'
          ? 'Teal: the creator\'s simulation plane.'
          : `Amber lines bind the mesh to the ${particles}-particle plane.`;
    } else {
      text =
        stage === 'submit'
          ? 'Orange: open edges. No thickness yet.'
          : `Print outside, tint inside, rim from boundary UVs. ${particles} particles.`;
    }
    this.caption.textContent = text;
  }

  private createSimulation(): void {
    this.disposeSimulation();
    const { proxy } = this.data;
    const { assetId, thicknessCm, wind, endCaps } = this.currentState;
    const physics = workflowPhysics(assetId);
    const { pinned, seams } = workflowAttachments(assetId, this.path, proxy);
    const stretchPairs = new Uint32Array(proxy.stretchPairs.length + seams.length);
    stretchPairs.set(proxy.stretchPairs);
    stretchPairs.set(seams, proxy.stretchPairs.length);
    const simulation = new ConvertedShellSimulation({
      mesh: { ...proxy, stretchPairs },
      thickness: thicknessCm / 100,
      preset: physics.preset,
      bending: physics.bending,
      fixedBending: true,
      structural: physics.structural,
      totalMass: physics.totalMass,
      pinned,
      colliders: workflowColliders(assetId, this.path),
      minContactDistance: this.path === 'plane' ? 0 : displayThickness(thicknessCm),
      pickRadius: 0.07,
      grabRadius: 0.16,
      selfCollisionInterval: 2,
    });
    simulation.setWind(workflowWind(assetId, this.path, wind, endCaps));
    const dt = 1 / 60;
    for (let time = 0; time < SETTLE_SECONDS; time += dt) simulation.step(dt);
    simulation.captureStartPose();
    this.simulation = simulation;
  }

  private disposeSimulation(): void {
    this.simulation?.endGrab();
    this.grabbing = false;
    this.controls.enabled = this.active;
    this.viewport.classList.remove('is-interacting');
    this.simulation?.dispose();
    this.simulation = null;
  }
}

export class CreatorWorkflowWorkspace {
  readonly element = document.createElement('section');
  readonly panels: CreatorWorkflowPanel[];
  readonly state: CreatorWorkflowState = { ...DEFAULT_WORKFLOW_STATE, endCaps: [] };
  private readonly controls: CreatorWorkflowControls;
  private syncingCamera = false;
  private sources: WorkflowSources;
  private loadToken = 0;
  private loadedAssetId: CreatorWorkflowState['assetId'] | null = null;
  private readonly comparison = document.createElement('div');
  private readonly backdrop = document.createElement('div');
  private inspectedPath: WorkflowPath | null = null;
  private active = false;

  constructor(canvas: HTMLCanvasElement) {
    this.sources = proceduralWorkflowSources(this.state.assetId, 0.25);
    this.element.className = 'creator-workflow-workspace';
    this.element.dataset.testid = 'creator-workflow';
    this.controls = new CreatorWorkflowControls({
      onAsset: (assetId) =>
        this.change({
          assetId,
          endCaps: [],
          thicknessCm: workflowAsset(assetId).defaultThicknessCm,
          wind: workflowPhysics(assetId).defaultWind,
        }),
      onStage: (stage) => this.change({ stage }),
      onToggleCap: (region) => this.toggleCap(region),
      onClearCaps: () => this.change({ endCaps: [] }),
      onThickness: (thicknessCm) => this.change({ thicknessCm }),
      onShowMapping: (showMapping) => this.change({ showMapping }),
      onShowRender: (showRender) => this.change({ showRender }),
      onSection: (section) => this.change({ section }),
      onSectionPosition: (sectionPosition) => this.change({ sectionPosition }),
      onPrevious: () => this.moveStage(-1),
      onNext: () => this.moveStage(1),
      onSimulationPaused: (simulationPaused) => this.change({ simulationPaused }),
      onResetSimulation: () => this.resetSimulation(),
      onWind: (wind) => this.change({ wind }),
      onResetView: () => this.resetView(),
    });
    this.panels = WORKFLOW_PATHS.map(
      (path) =>
        new CreatorWorkflowPanel(
          path,
          canvas,
          this.state,
          (source) => this.synchronizeCamera(source),
          (region) => this.toggleCap(region),
          (path) => this.inspect(this.inspectedPath === path ? null : path),
        ),
    );
    this.panels.find((panel) => panel.path === 'shell')?.addHeadingControls(this.controls.capField);
    this.comparison.className = 'workflow-comparison';
    this.comparison.append(...this.panels.map((panel) => panel.element));
    this.backdrop.className = 'workflow-inspect-backdrop';
    this.backdrop.dataset.testid = 'workflow-inspect-backdrop';
    this.backdrop.hidden = true;
    this.backdrop.addEventListener('click', () => this.inspect(null));
    this.element.append(this.controls.root, this.comparison, this.backdrop);
    window.addEventListener('keydown', this.onKeyDown);
    this.controls.sync(this.state);
  }

  setActive(active: boolean): void {
    this.active = active;
    for (const panel of this.panels) panel.setActive(active);
    if (active && this.loadedAssetId !== this.state.assetId) void this.loadAsset(this.state.assetId);
  }

  /** Panels to draw and route input to: only the inspected one while its window is open. */
  visiblePanels(): CreatorWorkflowPanel[] {
    return this.inspectedPath ? this.panels.filter((panel) => panel.path === this.inspectedPath) : this.panels;
  }

  get inspected(): WorkflowPath | null {
    return this.inspectedPath;
  }

  /** Opens one path in a pop-up window over the workspace, or closes it. */
  inspect(path: WorkflowPath | null): void {
    this.inspectedPath = path;
    this.backdrop.hidden = path === null;
    for (const panel of this.panels) panel.setInspected(panel.path === path);
    this.panels.find((panel) => panel.path === path)?.focusInspect();
  }

  setState(patch: Partial<CreatorWorkflowState>): void {
    this.change(patch);
  }

  resetSimulation(): void {
    for (const panel of this.panels) panel.resetSimulation();
  }

  simulationStats(): Array<{ vertexCount: number; maxDeformation: number }> {
    return this.panels.map((panel) => panel.simulationStats());
  }

  meshSources(): string[] {
    return this.panels.map((panel) => panel.meshSource());
  }

  proxyParticleCounts(): number[] {
    return this.panels.map((panel) => panel.proxyParticleCount());
  }

  capScreenPoint(region: number): { x: number; y: number } | null {
    return this.panels[0].capScreenPoint(region);
  }

  cameraPositions(): number[][] {
    return this.panels.map((panel) => panel.view.camera.position.toArray());
  }

  sectionPositions(): (number | null)[] {
    return this.panels.map((panel) => panel.visual.sectionX);
  }

  cameraTargets(): number[][] {
    return this.panels.map((panel) => panel.controls.target.toArray());
  }

  resetView(): void {
    this.setCameraPosition(CAMERA_POSITION.x, CAMERA_POSITION.y, CAMERA_POSITION.z);
  }

  setCameraPosition(x: number, y: number, z: number): void {
    for (const panel of this.panels) {
      panel.view.camera.position.set(x, y, z);
      panel.controls.target.copy(CAMERA_TARGET);
      panel.view.camera.lookAt(panel.controls.target);
      panel.controls.update();
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    for (const panel of this.panels) panel.dispose();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.active && this.inspectedPath) this.inspect(null);
  };

  private toggleCap(region: number): void {
    const endCaps = this.state.endCaps.includes(region)
      ? this.state.endCaps.filter((id) => id !== region)
      : [...this.state.endCaps, region].sort((a, b) => a - b);
    this.change({ endCaps });
  }

  private change(patch: Partial<CreatorWorkflowState>): void {
    const assetChanged = patch.assetId !== undefined && patch.assetId !== this.state.assetId;
    const capsChanged =
      patch.endCaps !== undefined && patch.endCaps.join(',') !== this.state.endCaps.join(',');
    Object.assign(this.state, patch);
    this.controls.sync(this.state);
    for (const panel of this.panels) panel.update(this.state);
    if (assetChanged) void this.loadAsset(this.state.assetId);
    else if (capsChanged && this.loadedAssetId === this.state.assetId) this.rebuildPathData(['shell']);
  }

  private moveStage(direction: -1 | 1): void {
    const current = WORKFLOW_STAGES.indexOf(this.state.stage);
    const next = Math.max(0, Math.min(WORKFLOW_STAGES.length - 1, current + direction));
    this.change({ stage: WORKFLOW_STAGES[next], simulationPaused: true });
  }

  private async loadAsset(assetId: CreatorWorkflowState['assetId']): Promise<void> {
    const token = ++this.loadToken;
    for (const panel of this.panels) panel.setLoading(true);
    const [capped, open] = await Promise.all([loadWorkflowSurface(assetId), loadWorkflowSurface(assetId, 'open')]);
    if (token !== this.loadToken || assetId !== this.state.assetId) return;
    this.sources = { capped, open };
    this.loadedAssetId = assetId;
    this.rebuildPathData();
    for (const panel of this.panels) panel.setLoading(false);
  }

  private rebuildPathData(paths: readonly WorkflowPath[] = WORKFLOW_PATHS): void {
    for (const panel of this.panels) {
      if (!paths.includes(panel.path)) continue;
      panel.setData(buildWorkflowPathData(this.state, panel.path, this.sources), this.state);
    }
  }

  private synchronizeCamera(source: CreatorWorkflowPanel): void {
    if (this.syncingCamera) return;
    this.syncingCamera = true;
    for (const panel of this.panels) {
      if (panel === source) continue;
      panel.view.camera.position.copy(source.view.camera.position);
      panel.view.camera.quaternion.copy(source.view.camera.quaternion);
      panel.controls.target.copy(source.controls.target);
      panel.view.camera.updateMatrixWorld();
      panel.controls.update();
    }
    this.syncingCamera = false;
  }
}

function stageLabel(stage: CreatorWorkflowState['stage'], paused: boolean): string {
  if (stage === 'submit') return 'Submit';
  if (stage === 'build') return 'Build';
  return paused ? 'Paused' : 'Simulating';
}
