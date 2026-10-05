import { AssemblyHistory } from '../../assembly-editor/AssemblyHistory';
import {
  MAX_PARTS,
  MAX_SCALE,
  MIN_SCALE,
  addPart,
  cloneDocument,
  defaultPresetId,
  emptyDocument,
  nextId,
  presetsForKind,
  removePart,
  shapeForKind,
  updatePart,
  updateSettings,
  type AssemblyDocument,
  type AssemblyPart,
  type PartKind,
  type Quat,
  type Vec3,
} from '../../assembly-editor/AssemblyDocument';
import { brushWelds, createLayeredExampleDocument, eraseWeldsNear } from '../../assembly-editor/weldPaint';
import { snapPart, supportHeight } from '../../assembly-editor/partTransform';
import { AssemblySimulation } from '../../simulation/assembly/AssemblySimulation';
import type { ToolId } from '../../simulation/types';

export type EditorMode = 'edit' | 'simulate';
export type EditorTool = 'select' | 'move' | 'rotate' | 'scale' | 'place' | 'weld' | 'erase';

export class AssemblyEditorController {
  readonly history: AssemblyHistory;
  mode: EditorMode = 'edit';
  tool: EditorTool = 'select';
  simTool: ToolId = 'grab';
  selection: string[] = ['rigid-base'];
  placeKind: PartKind = 'rigid';
  placePresetId = defaultPresetId('rigid');
  structureVisible = false;
  xray = false;
  simulationPaused = true;
  status = '';
  simulation: AssemblySimulation | null = null;
  private strokeStart: AssemblyDocument | null = null;

  constructor(document = createLayeredExampleDocument()) {
    this.history = new AssemblyHistory(document);
  }

  get document(): AssemblyDocument {
    return this.history.current;
  }

  setMode(mode: EditorMode): void {
    if (mode === this.mode) return;
    if (mode === 'simulate') {
      if (this.document.parts.length === 0) {
        this.status = 'Add a part before simulating';
        return;
      }
      this.simulation?.dispose();
      this.simulation = new AssemblySimulation(cloneDocument(this.document));
      this.simulationPaused = true;
      this.mode = 'simulate';
      this.status = 'Simulation ready and paused. Press Play to begin.';
      return;
    }
    this.simulation?.dispose();
    this.simulation = null;
    this.mode = 'edit';
    this.status = 'Returned to the authored assembly; simulation changes were discarded.';
  }

  setTool(tool: EditorTool): void {
    this.tool = tool;
  }

  setPlaceKind(kind: PartKind): void {
    this.placeKind = kind;
    if (!presetsForKind(kind).some((preset) => preset.id === this.placePresetId)) {
      this.placePresetId = defaultPresetId(kind);
    }
  }

  setPlacePreset(presetId: string): void {
    this.placePresetId = presetId;
  }

  select(ids: string[], additive = false): void {
    const valid = ids.filter((id) => this.document.parts.some((part) => part.id === id));
    if (additive) {
      const next = new Set(this.selection);
      for (const id of valid) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      const values = [...next];
      this.selection = values.slice(-2);
      if (values.length > 2) this.status = 'Weld pairs are limited to two parts; the oldest selection was released';
      return;
    }
    this.selection = valid.slice(-2);
  }

  placeAt(position: Vec3): void {
    if (this.document.parts.length >= MAX_PARTS) {
      this.status = `An assembly can contain at most ${MAX_PARTS} parts`;
      return;
    }
    const id = nextId('part', this.document.parts.map((part) => part.id));
    let part: AssemblyPart = {
      id,
      label: `${labelFor(this.placeKind)} ${this.document.parts.length + 1}`,
      kind: this.placeKind,
      presetId: this.placePresetId,
      position,
      quaternion: [0, 0, 0, 1],
      uniformScale: this.placeKind === 'shell' ? 0.8 : 0.6,
    };
    part = this.applySnap(part);
    this.history.commit(addPart(this.document, part));
    this.selection = [id];
    this.status = `Placed ${part.label}. Click again to place another, or choose a transform tool.`;
  }

  beginGesture(): void {
    if (this.mode === 'edit') this.history.beginGesture();
  }

  previewTransform(partId: string, position: Vec3, quaternion: Quat, uniformScale: number): void {
    const current = this.document.parts.find((part) => part.id === partId);
    if (!current) return;
    let part: AssemblyPart = { ...current, position, quaternion, uniformScale };
    part = this.applySnap(part);
    this.history.preview(updatePart(this.document, partId, part));
  }

  endGesture(): void {
    this.history.endGesture();
  }

  setPartPreset(partId: string, presetId: string): void {
    this.history.commit(updatePart(this.document, partId, { presetId }));
    this.status = 'Updated material';
  }

  setPartKind(partId: string, kind: PartKind): void {
    const part = this.document.parts.find((candidate) => candidate.id === partId);
    if (!part || part.kind === kind) return;
    const shapeChanged = shapeForKind(part.kind) !== shapeForKind(kind);
    this.history.commit(
      updatePart(this.document, partId, {
        kind,
        presetId: defaultPresetId(kind),
      }),
    );
    this.status = shapeChanged ? 'Changed shape and removed welds on that part' : 'Changed material type';
  }

  setPartLabel(partId: string, label: string): void {
    if (label.trim() === '') {
      this.status = 'Part name cannot be empty';
      return;
    }
    this.history.commit(updatePart(this.document, partId, { label: label.trim() }));
    this.status = `Renamed part to ${label.trim()}`;
  }

  setPartTransform(partId: string, patch: Pick<Partial<AssemblyPart>, 'position' | 'quaternion' | 'uniformScale'>): void {
    const safePatch =
      patch.uniformScale === undefined
        ? patch
        : { ...patch, uniformScale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, patch.uniformScale)) };
    this.history.commit(updatePart(this.document, partId, safePatch));
    this.status = 'Updated part transform';
  }

  resetPartTransform(partId: string): void {
    const part = this.document.parts.find((candidate) => candidate.id === partId);
    if (!part) return;
    const position: Vec3 = [part.position[0], 0, part.position[2]];
    this.history.commit(updatePart(this.document, partId, { position, quaternion: [0, 0, 0, 1], uniformScale: 1 }));
    this.status = 'Reset rotation and scale, and grounded the part';
  }

  duplicate(): void {
    const selected = this.primary;
    if (!selected) return;
    if (this.document.parts.length >= MAX_PARTS) {
      this.status = `An assembly can contain at most ${MAX_PARTS} parts`;
      return;
    }
    const copy: AssemblyPart = {
      ...selected,
      id: nextId('part', this.document.parts.map((part) => part.id)),
      label: `${selected.label} copy`,
      position: [selected.position[0] + 0.05, selected.position[1], selected.position[2]],
    };
    this.history.commit(addPart(this.document, copy));
    this.selection = [copy.id];
    this.status = 'Duplicated part without its welds';
  }

  deleteSelected(): void {
    if (this.selection.length === 0) return;
    let next = this.document;
    for (const id of this.selection) next = removePart(next, id);
    this.history.commit(next);
    this.selection = [];
    this.status = 'Deleted the selection and its welds';
  }

  clear(): void {
    const cleared = emptyDocument(this.document.name);
    cleared.settings = { ...this.document.settings };
    this.history.commit(cleared);
    this.selection = [];
    this.status = 'Cleared the assembly';
  }

  undo(): void {
    this.history.undo();
    this.keepSelection();
  }

  redo(): void {
    this.history.redo();
    this.keepSelection();
  }

  private keepSelection(): void {
    this.selection = this.selection.filter((id) => this.document.parts.some((part) => part.id === id));
    if (this.selection.length === 0 && this.document.parts.length > 0) {
      this.selection = [this.document.parts[this.document.parts.length - 1].id];
    }
  }

  beginStroke(): void {
    this.strokeStart = cloneDocument(this.document);
  }

  /** Welds touching surfaces under the brush; two selected parts limit welding to that pair. */
  paint(partId: string, point: Vec3): void {
    if (this.selection.length === 2 && !this.selection.includes(partId)) {
      this.status = 'The brush is over a part outside the selected weld pair. Turn on X-ray to reach the pair behind it.';
      return;
    }
    const partners = this.weldPartners(partId);
    const { document, contacts } = brushWelds(this.document, partId, point, partners);
    this.history.preview(document);
    this.status =
      contacts === 0
        ? 'No touching surface or edge under the brush. Move the parts into contact, or turn on Surface snap.'
        : `${document.welds.length} weld points`;
  }

  canPaint(partId: string, point: Vec3): boolean {
    if (this.selection.length === 2 && !this.selection.includes(partId)) return false;
    return brushWelds(this.document, partId, point, this.weldPartners(partId)).contacts > 0;
  }

  canErase(point: Vec3): boolean {
    return eraseWeldsNear(this.document, point, this.document.settings.brushRadius).welds.length < this.document.welds.length;
  }

  setXray(enabled: boolean): void {
    this.xray = enabled;
    this.status = enabled
      ? 'X-ray on: parts are see-through and the brush paints the first seam along the cursor, even behind other parts.'
      : 'X-ray off: the brush paints only visible surfaces.';
  }

  erase(point: Vec3): void {
    this.history.preview(eraseWeldsNear(this.document, point, this.document.settings.brushRadius));
    this.status = `${this.document.welds.length} weld points`;
  }

  setBrushRadius(radius: number): void {
    this.history.current = updateSettings(this.document, { brushRadius: radius });
  }

  endStroke(): void {
    if (!this.strokeStart) return;
    const next = this.document;
    this.history.current = this.strokeStart;
    this.strokeStart = null;
    this.history.commit(next);
  }

  toggleGrid(enabled: boolean): void {
    this.history.current = updateSettings(this.document, { gridSnap: enabled });
  }

  toggleSurface(enabled: boolean): void {
    this.history.current = updateSettings(this.document, { surfaceSnap: enabled });
  }

  resetSimulation(): void {
    this.simulation?.reset();
    this.simulationPaused = true;
    this.status = 'Simulation restarted and paused';
  }

  setSimulationPaused(paused: boolean): void {
    this.simulationPaused = paused;
    this.status = paused ? 'Simulation paused' : 'Simulation running';
  }

  get primary(): AssemblyPart | null {
    const id = this.selection[this.selection.length - 1];
    return this.document.parts.find((part) => part.id === id) ?? null;
  }

  private applySnap(part: AssemblyPart): AssemblyPart {
    const { gridSnap, surfaceSnap } = this.document.settings;
    const support = surfaceSnap ? supportHeight(part, this.document.parts) : null;
    return snapPart(part, gridSnap, surfaceSnap, support);
  }

  private weldPartners(partId: string): readonly string[] | null {
    return this.selection.length === 2 && this.selection.includes(partId) ? this.selection : null;
  }
}

function labelFor(kind: PartKind): string {
  if (kind === 'rigid') return 'Rigid';
  if (kind === 'volume') return 'Volume';
  return 'Sheet';
}
