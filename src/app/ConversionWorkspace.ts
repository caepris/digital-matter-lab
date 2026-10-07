import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { InteractionTarget, ViewportRect } from '../interaction/InteractionRouter';
import { ConversionVisual } from '../rendering/ConversionVisual';
import { convertSurface, type ConvertedSurface } from '../simulation/conversion/convertSurface';
import { ConvertedShellSimulation } from '../simulation/conversion/ConvertedShellSimulation';
import { buildSourceMesh, type SourceMesh, type SourceMeshId } from '../simulation/conversion/sourceMeshes';
import { clampToPlatform, DROP_TARGET_PLANE_Y, PRESS_REST_BOTTOM } from '../simulation/scene';
import type { MatterSimulation, SimulationFrame, SimulationStats, ToolId } from '../simulation/types';
import {
  ConversionControls,
  type ConversionControlModel,
  type ConversionSourceId,
  type ConversionStage,
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
  tshirt: 0.115,
  curtain: 0.13,
  'car-shell': 0.13,
};

const PHYSICS: Record<SourceMeshId, { presetId: string; mass: number }> = {
  tshirt: { presetId: 'loose-cloth', mass: 0.25 },
  curtain: { presetId: 'structured-fabric', mass: 0.65 },
  'car-shell': { presetId: 'sheet-metal', mass: 2.4 },
};

export class ConversionWorkspace implements InteractionTarget {
  readonly element: HTMLElement;
  readonly viewport: HTMLElement;
  readonly kind = 'conversion' as const;
  readonly state = { tool: 'grab' as ToolId, presetId: 'converted', structureVisible: false };
  readonly view: ConversionVisual;
  stage: ConversionStage = 'source';
  sourceId: ConversionSourceId = 'tshirt';
  thickness: number;
  private source: SourceMesh;
  private converted: ConvertedSurface | null = null;
  private shell: ConvertedShellSimulation | null = null;
  private simulationPaused = true;
  private status = '';
  private activeTool: ToolId | null = null;
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
      onStage: (stage) => this.setStage(stage),
      onSource: (id) => this.setSource(id),
      onStructure: (visible) => {
        this.state.structureVisible = visible;
        this.view.setStructureVisible(visible);
        this.refresh();
      },
      onThickness: (thickness, commit) => this.setThickness(thickness, commit),
      onGenerate: () => this.generate(),
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
    this.refresh();
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
    if (this.stage === 'run' && !this.simulationPaused) this.shell?.step(dt);
  }

  render(renderer: THREE.WebGLRenderer, alpha: number): void {
    const frame = this.stage === 'run' && this.shell ? this.shell.frame(alpha) : emptyFrame;
    this.view.render(frame, this.stage === 'run' && this.state.tool === 'press');
    renderer.render(this.view.panel.scene, this.view.camera);
  }

  pointerDown(ray: THREE.Ray): boolean {
    if (this.stage !== 'run' || !this.shell) return false;
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
    if (this.activeTool === 'grab') this.shell?.updateGrab(ray);
  }

  pointerUp(): void {
    if (this.activeTool === 'grab') this.shell?.endGrab();
    if (this.activeTool === 'press') this.shell?.setPressActive(false);
    this.activeTool = null;
    this.viewport.classList.remove('is-interacting');
  }

  dispose(): void {
    this.pointerUp();
    this.shell?.dispose();
    this.orbit.dispose();
    this.view.dispose();
  }

  private setStage(stage: ConversionStage): void {
    this.pointerUp();
    if (stage === 'run' && (!this.converted || !this.shell)) {
      this.stage = 'generate';
      this.status = 'Generate a shell before entering Run.';
    } else {
      this.stage = stage;
      if (stage === 'run') this.simulationPaused = true;
      this.status = '';
    }
    this.view.setStage(this.stage);
    this.refresh();
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
    this.status = `${this.source.label} loaded. Inspect it, then continue to Generate.`;
    this.view.configure(this.source, null, this.thickness);
    this.view.setStage('source');
    this.refresh();
  }

  private setThickness(thickness: number, commit: boolean): void {
    this.thickness = THREE.MathUtils.clamp(thickness, 0.002, 0.08);
    if (this.converted) {
      this.shell?.dispose();
      this.shell = null;
      this.converted = null;
      this.simulationPaused = true;
      this.status = 'Thickness changed. Generate the shell again.';
    } else if (commit) {
      this.status = 'Thickness set. Generate the fitted shell.';
    }
    this.view.configure(this.source, this.converted, this.thickness);
    this.view.setStage(this.stage);
    this.view.setStructureVisible(this.state.structureVisible);
    this.refresh();
  }

  private generate(): void {
    this.pointerUp();
    try {
      const converted = convertSurface({
        positions: this.source.positions,
        triangles: this.source.triangles,
        targetSpacing: TARGET_SPACING[this.sourceId],
      });
      this.converted = converted;
      this.createSimulation();
      this.status = `Shell generated from ${this.source.label}. Inspect its vertices, then switch to Run.`;
      this.view.configure(this.source, converted, this.thickness);
      this.view.setStage('generate');
      this.view.setStructureVisible(this.state.structureVisible);
    } catch (error) {
      this.converted = null;
      this.shell = null;
      this.status = `Could not generate shell: ${String(error)}`;
    }
    this.refresh();
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
    });
    this.simulationPaused = true;
  }

  private resetSimulation(): void {
    this.pointerUp();
    this.createSimulation();
    this.simulationPaused = true;
    if (this.converted) {
      this.view.configure(this.source, this.converted, this.thickness);
      this.view.setStage(this.stage);
      this.view.setStructureVisible(this.state.structureVisible);
    }
    this.status = 'Simulation reset and paused.';
    this.refresh();
  }

  private refresh(): void {
    const generated = this.converted
      ? {
          vertices: this.converted.positions.length / 3,
          triangles: this.converted.triangles.length / 3,
          stretchEdges: this.converted.stretchPairs.length / 2,
          bendPairs: this.converted.bendPairs.length / 2,
          thickness: this.thickness,
        }
      : null;
    const model: ConversionControlModel = {
      stage: this.stage,
      sourceId: this.sourceId,
      structureVisible: this.state.structureVisible,
      thickness: this.thickness,
      generated,
      status: this.status,
      simulationPaused: this.simulationPaused,
      tool: this.state.tool,
      legend:
        this.stage === 'source'
          ? [
              { label: 'Source vertices', color: 0xf4f6fa },
              { label: 'Source triangle edges', color: 0x9ba8b8 },
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
