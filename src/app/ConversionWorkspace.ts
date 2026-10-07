import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { InteractionTarget, ViewportRect } from '../interaction/InteractionRouter';
import { ConversionVisual } from '../rendering/ConversionVisual';
import { convertSurface, type ConvertedSurface } from '../simulation/conversion/convertSurface';
import { ConvertedShellSimulation } from '../simulation/conversion/ConvertedShellSimulation';
import {
  buildSourceMesh,
  pinnedParticles,
  type SourceMesh,
  type SourceMeshId,
} from '../simulation/conversion/sourceMeshes';
import { clampToPlatform, DROP_TARGET_PLANE_Y, PRESS_REST_BOTTOM } from '../simulation/scene';
import type { MatterSimulation, SimulationFrame, SimulationStats, ToolId } from '../simulation/types';
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
  curtain: 0.1,
  'car-shell': 0.1,
};

const PHYSICS: Record<SourceMeshId, { presetId: string; mass: number; structural: boolean }> = {
  tshirt: { presetId: 'loose-cloth', mass: 0.3, structural: false },
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
  private readonly controls: ConversionControls;
  private readonly orbit: OrbitControls;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    _isActive: () => boolean,
  ) {
    this.source = buildSourceMesh(this.sourceId);
    this.thickness = this.source.defaultThickness;
    this.view = new ConversionVisual(this.source, ACCENT);
    this.controls = new ConversionControls({
      onSource: (id) => this.setSource(id),
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
        this.simulationPaused = paused;
        this.refresh();
      },
      onReset: () => this.resetSimulation(),
      onTool: (tool) => {
        this.pointerUp();
        this.state.tool = tool;
        this.refresh();
      },
    });

    this.element = document.createElement('section');
    this.element.className = 'panel';
    this.element.dataset.kind = 'conversion';
    this.viewport = document.createElement('div');
    this.viewport.className = 'panel-viewport conversion-viewport';
    this.viewport.append(this.controls.hint, this.controls.legend);
    this.element.append(this.controls.root, this.viewport);
    this.orbit = new OrbitControls(this.view.camera, this.canvas);
    this.orbit.enableDamping = false;
    this.orbit.target.set(0, 0.6, 0);
    this.orbit.mouseButtons = {
      LEFT: -1 as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.orbit.enabled = false;
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
    this.orbit.target.copy(center);
    this.view.camera.position.copy(center).addScaledVector(CAMERA_DIRECTION, 2.4 + extent * 1.35);
    this.view.camera.lookAt(center);
    this.orbit.update();
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

  get sectionVisible(): boolean {
    return this.state.sectionVisible;
  }

  get sectionPosition(): number {
    return this.view.sectionPosition;
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
    if (!active) this.pointerUp();
    this.orbit.enabled = active;
  }

  step(dt: number): void {
    if (!this.simulationPaused) this.shell?.step(dt);
  }

  render(renderer: THREE.WebGLRenderer, alpha: number): void {
    const frame = this.shell ? this.shell.frame(alpha) : emptyFrame;
    this.view.render(frame, this.shell !== null && this.state.tool === 'press');
    renderer.render(this.view.panel.scene, this.view.camera);
  }

  pointerDown(ray: THREE.Ray): boolean {
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
    if (this.sectionDragging) {
      this.view.updateSectionDrag(ray);
      return;
    }
    if (this.activeTool === 'grab') this.shell?.updateGrab(ray);
  }

  pointerUp(): void {
    this.sectionDragging = false;
    if (this.activeTool === 'grab') this.shell?.endGrab();
    if (this.activeTool === 'press') this.shell?.setPressActive(false);
    this.activeTool = null;
    this.viewport.classList.remove('is-interacting');
  }

  dispose(): void {
    if (this.generateTimer !== null) clearTimeout(this.generateTimer);
    this.pointerUp();
    this.shell?.dispose();
    this.orbit.dispose();
    this.view.dispose();
  }

  private setSource(id: ConversionSourceId): void {
    this.pointerUp();
    this.shell?.dispose();
    this.shell = null;
    this.converted = null;
    this.sourceId = id;
    this.source = buildSourceMesh(id);
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
  }

  private createSimulation(): void {
    if (!this.converted) return;
    this.shell?.dispose();
    const physics = PHYSICS[this.sourceId];
    this.shell = new ConvertedShellSimulation({
      mesh: this.converted,
      thickness: this.thickness,
      presetId: physics.presetId,
      totalMass: physics.mass,
      structural: physics.structural,
      pinned: pinnedParticles(this.source, this.converted.positions),
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
    const showingSource = !this.converted || this.state.view === 'source';
    const model: ConversionControlModel = {
      sourceId: this.sourceId,
      view: this.state.view,
      structureVisible: this.state.structureVisible,
      sectionVisible: this.state.sectionVisible,
      thickness: this.thickness,
      generated,
      generating: this.generating,
      status: this.status,
      simulationPaused: this.simulationPaused,
      tool: this.state.tool,
      legend:
        showingSource
          ? [
              { label: 'Rigid solid surface vertices', color: 0xf4f6fa },
              { label: 'Closed solid edges', color: 0x9ba8b8 },
            ]
          : [
              { label: 'Simulation particles', color: 0xf4f6fa },
              { label: 'Stretch and bend structure', color: 0x60e0c1 },
            ],
    };
    this.controls.sync(model);
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
