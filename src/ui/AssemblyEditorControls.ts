import {
  MAX_PARTS,
  presetById,
  presetsForKind,
  type AssemblyPart,
  type PartKind,
} from '../assembly-editor/AssemblyDocument';
import * as THREE from 'three';
import type { EditorMode, EditorTool } from '../app/assembly/AssemblyEditorController';
import type { ToolId } from '../simulation/types';

export interface LegendEntry {
  label: string;
  color: number;
}

export interface AssemblyControlModel {
  mode: EditorMode;
  tool: EditorTool;
  simTool: ToolId;
  placeKind: PartKind;
  placePresetId: string;
  gridSnap: boolean;
  surfaceSnap: boolean;
  brushRadius: number;
  canUndo: boolean;
  canRedo: boolean;
  part: AssemblyPart | null;
  parts: AssemblyPart[];
  selection: string[];
  weldCount: number;
  status: string;
  structureVisible: boolean;
  xray: boolean;
  simulationPaused: boolean;
  legend: LegendEntry[];
}

interface AssemblyControlHandlers {
  onMode(mode: EditorMode): void;
  onTool(tool: EditorTool): void;
  onSimTool(tool: ToolId): void;
  onPlaceKind(kind: PartKind): void;
  onPlacePreset(id: string): void;
  onSelectPart(id: string, additive: boolean): void;
  onGrid(enabled: boolean): void;
  onSurface(enabled: boolean): void;
  onBrushRadius(radius: number, commit: boolean): void;
  onUndo(): void;
  onRedo(): void;
  onDuplicate(): void;
  onDelete(): void;
  onClear(): void;
  onLabel(label: string): void;
  onPartKind(kind: PartKind): void;
  onPartPreset(id: string): void;
  onTransform(axis: 'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz' | 'scale', value: number): void;
  onResetTransform(): void;
  onStructure(visible: boolean): void;
  onXray(enabled: boolean): void;
  onSimulationPaused(paused: boolean): void;
  onReset(): void;
}

const EDITOR_TOOLS: { id: EditorTool; label: string; hint: string }[] = [
  { id: 'select', label: 'Select', hint: 'Click a part to select it; Shift-click selects a weld pair.' },
  { id: 'place', label: 'Place', hint: 'Click the platform to place copies of the configured part.' },
  { id: 'move', label: 'Move', hint: 'Drag the gizmo arrows to move the selected part.' },
  { id: 'rotate', label: 'Rotate', hint: 'Drag the gizmo rings to rotate the selected part.' },
  { id: 'scale', label: 'Scale', hint: 'Drag the gizmo to scale the selected part evenly.' },
  { id: 'weld', label: 'Add welds', hint: 'Brush across a highlighted seam where parts touch, including the shared edge of two sheets.' },
  { id: 'erase', label: 'Erase welds', hint: 'Brush over weld points to remove them.' },
];

const SIM_TOOLS: { id: ToolId; label: string; hint: string }[] = [
  { id: 'grab', label: 'Grab', hint: 'Drag the assembly to pull it.' },
  { id: 'drop', label: 'Drop', hint: 'Click to drop a steel ball.' },
  { id: 'press', label: 'Press', hint: 'Hold to lower the press.' },
];

const CAMERA_HINT = 'Middle-drag orbit · Right-drag pan · Scroll or trackpad zoom';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class AssemblyEditorControls {
  readonly root = element('aside', 'panel-controls assembly-editor');
  readonly hint = element('p', 'tool-hint', CAMERA_HINT);
  readonly legend = element('div', 'structure-legend');
  private readonly modeButtons = new Map<EditorMode, HTMLButtonElement>();
  private readonly toolButtons = new Map<EditorTool, HTMLButtonElement>();
  private readonly simButtons = new Map<ToolId, HTMLButtonElement>();
  private readonly kindSelect: HTMLSelectElement;
  private readonly presetSelect: HTMLSelectElement;
  private readonly presetDescription = element('p', 'context-description');
  private readonly grid: HTMLInputElement;
  private readonly surface: HTMLInputElement;
  private readonly brush: HTMLInputElement;
  private readonly brushValue = element('output', 'value-output');
  private readonly undo: HTMLButtonElement;
  private readonly redo: HTMLButtonElement;
  private readonly duplicate: HTMLButtonElement;
  private readonly remove: HTMLButtonElement;
  private readonly place: HTMLButtonElement;
  private readonly nameInput: HTMLInputElement;
  private readonly partKind: HTMLSelectElement;
  private readonly partPreset: HTMLSelectElement;
  private readonly positionInputs: HTMLInputElement[] = [];
  private readonly rotationInputs: HTMLInputElement[] = [];
  private readonly scaleInput: HTMLInputElement;
  private readonly structure: HTMLInputElement;
  private readonly xray: HTMLInputElement;
  private readonly status = element('p', 'assembly-status');
  private readonly editRoot = element('div', 'editor-sections');
  private readonly simRoot = element('div', 'editor-sections');
  private readonly outliner = element('div', 'part-list');
  private readonly selectionSummary = element('p', 'selection-summary');
  private readonly weldSection = element('section', 'editor-section weld-section');
  private readonly inspectorSection = element('section', 'editor-section inspector-section');
  private readonly play: HTMLButtonElement;

  constructor(private readonly handlers: AssemblyControlHandlers) {
    this.root.style.setProperty('--accent', '#b78cff');
    const heading = element('div', 'panel-heading');
    heading.append(
      element('h2', 'panel-title', 'Assembly editor'),
      element('p', 'panel-subtitle', 'Build parts, join touching surfaces, then test the assembly.'),
    );

    const modeBar = element('div', 'editor-topbar');
    const modes = this.radioGroup('Assembly mode');
    for (const [id, label] of [['edit', 'Edit'], ['simulate', 'Simulate']] as const) {
      const button = this.radio(label, () => handlers.onMode(id));
      button.dataset.mode = id;
      modes.append(button);
      this.modeButtons.set(id, button);
    }
    this.structure = this.check('Structure', 'structure-toggle', handlers.onStructure);
    modeBar.append(modes, this.structure.parentElement!);

    const history = element('div', 'history-bar');
    this.undo = this.button('Undo', 'undo', handlers.onUndo);
    this.redo = this.button('Redo', 'redo', handlers.onRedo);
    history.append(this.undo, this.redo);

    const create = this.section('1 · Add a part');
    this.kindSelect = this.select(
      [['rigid', 'Rigid volume'], ['volume', 'Deformable volume'], ['shell', 'Thin shell']],
      (value) => handlers.onPlaceKind(value as PartKind),
      'New part type',
    );
    this.kindSelect.dataset.testid = 'place-kind';
    this.presetSelect = this.select([], handlers.onPlacePreset, 'New part material');
    this.presetSelect.dataset.testid = 'place-preset';
    this.place = this.button('Place part', 'place-part', () => handlers.onTool('place'));
    this.place.dataset.tool = 'place';
    create.append(this.field('Shape', this.kindSelect), this.field('Material', this.presetSelect), this.presetDescription, this.place);

    const parts = this.section('2 · Select parts');
    parts.append(this.outliner, this.selectionSummary);

    const tools = this.section('3 · Edit');
    const transforms = this.radioGroup('Transform tool');
    for (const id of ['select', 'move', 'rotate', 'scale'] as EditorTool[]) {
      const definition = EDITOR_TOOLS.find((tool) => tool.id === id)!;
      const button = this.radio(definition.label, () => handlers.onTool(id), definition.hint);
      button.dataset.tool = id;
      transforms.append(button);
      this.toolButtons.set(id, button);
    }
    this.grid = this.check('Grid snap', 'grid-snap', handlers.onGrid);
    this.surface = this.check('Surface snap', 'surface-snap', handlers.onSurface);
    const snaps = element('div', 'check-row');
    snaps.append(this.grid.parentElement!, this.surface.parentElement!);
    tools.append(transforms, snaps, element('p', 'context-description', 'Shortcuts: W move · E rotate · R scale · Delete remove · ⌘/Ctrl-Z undo'));

    this.weldSection.append(element('h3', 'section-title', '4 · Join parts'));
    const weldModes = this.radioGroup('Weld brush mode');
    for (const id of ['weld', 'erase'] as EditorTool[]) {
      const definition = EDITOR_TOOLS.find((tool) => tool.id === id)!;
      const button = this.radio(definition.label, () => handlers.onTool(id), definition.hint);
      button.dataset.tool = id;
      weldModes.append(button);
      this.toolButtons.set(id, button);
    }
    this.brush = element('input', 'brush-range');
    this.brush.type = 'range';
    this.brush.min = '0.03';
    this.brush.max = '0.25';
    this.brush.step = '0.01';
    this.brush.dataset.testid = 'brush-radius';
    this.brush.ariaLabel = 'Weld brush radius';
    this.brush.addEventListener('input', () => {
      this.brushValue.value = `${Math.round(Number(this.brush.value) * 100)} cm`;
      handlers.onBrushRadius(Number(this.brush.value), false);
    });
    this.brush.addEventListener('change', () => handlers.onBrushRadius(Number(this.brush.value), true));
    const brushField = this.field('Brush size', this.brush);
    brushField.append(this.brushValue);
    this.xray = this.check('Paint through parts (X-ray)', 'xray-brush', handlers.onXray);
    this.xray.parentElement!.title = 'Show hidden vertices and weld seams that are covered by other parts';
    this.weldSection.append(
      element('p', 'context-description', 'Paint all touching parts, or Shift-select two parts to limit the weld pair.'),
      weldModes,
      brushField,
      this.xray.parentElement!,
      element(
        'p',
        'context-description',
        'X-ray reveals buried vertices and paints the first seam along the cursor. Shift-select two parts to reach their seam through others.',
      ),
    );

    this.inspectorSection.append(element('h3', 'section-title', 'Selected part'));
    this.nameInput = element('input', 'text-input');
    this.nameInput.dataset.testid = 'part-name';
    this.nameInput.ariaLabel = 'Part name';
    this.nameInput.addEventListener('change', () => handlers.onLabel(this.nameInput.value));
    this.partKind = this.select(
      [['rigid', 'Rigid volume'], ['volume', 'Deformable volume'], ['shell', 'Thin shell']],
      (value) => handlers.onPartKind(value as PartKind),
      'Selected part type',
    );
    this.partKind.dataset.testid = 'part-kind';
    this.partPreset = this.select([], handlers.onPartPreset, 'Selected part material');
    this.partPreset.dataset.testid = 'part-preset';
    const transformGrid = element('div', 'transform-grid');
    for (const axis of ['x', 'y', 'z'] as const) {
      const input = this.numberInput(`Position ${axis.toUpperCase()}`, (value) => handlers.onTransform(axis, value), 0.05);
      this.positionInputs.push(input);
      transformGrid.append(this.field(axis.toUpperCase(), input));
    }
    for (const axis of ['rx', 'ry', 'rz'] as const) {
      const input = this.numberInput(`Rotation ${axis[1].toUpperCase()} in degrees`, (value) => handlers.onTransform(axis, value), 15);
      this.rotationInputs.push(input);
      transformGrid.append(this.field(`R${axis[1].toUpperCase()}`, input));
    }
    this.scaleInput = this.numberInput('Uniform scale', (value) => handlers.onTransform('scale', value), 0.1);
    transformGrid.append(this.field('Scale', this.scaleInput));
    const actions = element('div', 'action-row');
    this.duplicate = this.button('Duplicate', 'duplicate', handlers.onDuplicate);
    this.remove = this.button('Delete', 'delete-part', handlers.onDelete);
    actions.append(this.duplicate, this.remove, this.button('Reset transform', 'reset-transform', handlers.onResetTransform));
    this.inspectorSection.append(
      this.field('Name', this.nameInput),
      this.field('Type', this.partKind),
      this.field('Material', this.partPreset),
      transformGrid,
      actions,
    );

    const clear = this.button('Clear all…', 'clear-assembly', handlers.onClear);
    clear.classList.add('danger-button');
    this.editRoot.append(create, parts, tools, this.weldSection, this.inspectorSection, clear);

    const simTools = this.section('Simulation');
    const simGroup = this.radioGroup('Simulation tool');
    for (const tool of SIM_TOOLS) {
      const button = this.radio(tool.label, () => handlers.onSimTool(tool.id), tool.hint);
      button.dataset.tool = tool.id;
      simGroup.append(button);
      this.simButtons.set(tool.id, button);
    }
    const transport = element('div', 'action-row');
    this.play = element('button', 'action-button', 'Play');
    this.play.type = 'button';
    this.play.dataset.testid = 'simulation-play';
    this.play.addEventListener('click', () => handlers.onSimulationPaused(this.play.textContent === 'Pause'));
    transport.append(this.play, this.button('Restart', 'reset', handlers.onReset));
    simTools.append(
      element('p', 'context-description', 'Simulation starts paused. Returning to Edit discards runtime deformation.'),
      transport,
      simGroup,
    );
    this.simRoot.append(simTools);

    this.status.dataset.testid = 'assembly-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.legend.hidden = true;
    this.root.append(heading, modeBar, history, this.editRoot, this.simRoot, this.status);
  }

  sync(model: AssemblyControlModel): void {
    this.syncRadios(this.modeButtons, model.mode);
    this.syncRadios(this.toolButtons, model.tool);
    this.syncRadios(this.simButtons, model.simTool);
    this.editRoot.hidden = model.mode !== 'edit';
    this.simRoot.hidden = model.mode !== 'simulate';
    this.kindSelect.value = model.placeKind;
    this.fillPresets(this.presetSelect, model.placeKind, model.placePresetId);
    this.presetDescription.textContent = presetById(model.placeKind, model.placePresetId).description;
    this.place.classList.toggle('is-selected', model.tool === 'place');
    this.place.disabled = model.parts.length >= MAX_PARTS;
    this.place.title = this.place.disabled ? `Assemblies are limited to ${MAX_PARTS} parts` : 'Activate placement, then click the platform';
    this.grid.checked = model.gridSnap;
    this.surface.checked = model.surfaceSnap;
    this.brush.value = String(model.brushRadius);
    this.brushValue.value = `${Math.round(model.brushRadius * 100)} cm`;
    this.undo.disabled = !model.canUndo;
    this.redo.disabled = !model.canRedo;
    this.rebuildOutliner(model);

    const part = model.part;
    for (const control of [this.nameInput, this.partKind, this.partPreset, ...this.positionInputs, ...this.rotationInputs, this.scaleInput]) {
      control.disabled = !part;
    }
    this.duplicate.disabled = !part || model.parts.length >= MAX_PARTS;
    this.remove.disabled = !part;
    if (part) {
      if (document.activeElement !== this.nameInput) this.nameInput.value = part.label;
      this.partKind.value = part.kind;
      this.fillPresets(this.partPreset, part.kind, part.presetId);
      part.position.forEach((value, index) => { this.positionInputs[index].value = value.toFixed(2); });
      const rotation = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...part.quaternion), 'XYZ');
      [rotation.x, rotation.y, rotation.z].forEach((value, index) => {
        this.rotationInputs[index].value = THREE.MathUtils.radToDeg(value).toFixed(0);
      });
      this.scaleInput.value = part.uniformScale.toFixed(2);
    } else {
      this.nameInput.value = '';
    }
    this.inspectorSection.classList.toggle('is-empty', !part);

    const weld = this.toolButtons.get('weld')!;
    weld.disabled = model.parts.length < 2;
    weld.title = weld.disabled ? 'Add at least two parts' : EDITOR_TOOLS.find((tool) => tool.id === 'weld')!.hint;
    const erase = this.toolButtons.get('erase')!;
    erase.disabled = model.weldCount === 0;
    erase.title = erase.disabled ? 'There are no welds to erase' : EDITOR_TOOLS.find((tool) => tool.id === 'erase')!.hint;

    this.structure.checked = model.structureVisible;
    this.xray.checked = model.xray;
    this.status.textContent = model.status || `${model.parts.length} parts · ${model.weldCount} weld points`;
    this.play.textContent = model.simulationPaused ? 'Play' : 'Pause';

    this.legend.replaceChildren();
    for (const entry of model.legend) {
      const row = element('span', '');
      const swatch = element('i', '');
      swatch.style.color = `#${entry.color.toString(16).padStart(6, '0')}`;
      swatch.style.background = 'currentColor';
      row.append(swatch, document.createTextNode(entry.label));
      this.legend.append(row);
    }
    this.legend.hidden = !model.structureVisible;
    const hint = model.mode === 'edit'
      ? EDITOR_TOOLS.find((tool) => tool.id === model.tool)?.hint
      : SIM_TOOLS.find((tool) => tool.id === model.simTool)?.hint;
    this.hint.textContent = `${hint ?? ''} · ${CAMERA_HINT}`;
  }

  private rebuildOutliner(model: AssemblyControlModel): void {
    this.outliner.replaceChildren();
    for (const part of model.parts) {
      const button = element('button', 'part-list-item');
      button.type = 'button';
      button.classList.toggle('is-selected', model.selection.includes(part.id));
      button.setAttribute('aria-pressed', String(model.selection.includes(part.id)));
      button.addEventListener('click', (event) => this.handlers.onSelectPart(part.id, event.shiftKey));
      const color = element('i', 'part-color');
      color.style.background = `#${presetById(part.kind, part.presetId).color.toString(16).padStart(6, '0')}`;
      button.append(color, element('span', 'part-list-name', part.label), element('span', 'part-list-kind', part.kind));
      this.outliner.append(button);
    }
    if (model.parts.length === 0) this.outliner.append(element('p', 'empty-state', 'No parts yet'));
    const selected = model.parts.filter((part) => model.selection.includes(part.id));
    this.selectionSummary.textContent = selected.length === 2
      ? `Weld pair: ${selected[0].label} ↔ ${selected[1].label}`
      : selected.length === 1
        ? `Selected: ${selected[0].label} · Shift-select one more part to scope welding`
        : 'No selection · welding affects all touching parts';
  }

  private fillPresets(select: HTMLSelectElement, kind: PartKind, selected: string): void {
    if (select.dataset.kind !== kind) {
      select.replaceChildren();
      for (const preset of presetsForKind(kind)) {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.label;
        select.append(option);
      }
      select.dataset.kind = kind;
    }
    select.value = selected;
  }

  private syncRadios<T extends string>(buttons: Map<T, HTMLButtonElement>, active: T): void {
    for (const [id, button] of buttons) {
      const selected = id === active;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-checked', String(selected));
    }
  }

  private section(title: string): HTMLElement {
    const section = element('section', 'editor-section');
    section.append(element('h3', 'section-title', title));
    return section;
  }

  private field(label: string, control: HTMLElement): HTMLLabelElement {
    const field = element('label', 'control-field');
    field.append(element('span', 'field-label', label), control);
    return field;
  }

  private radioGroup(label: string): HTMLElement {
    const group = element('div', 'tool-group');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    return group;
  }

  private radio(label: string, onClick: () => void, title = ''): HTMLButtonElement {
    const button = element('button', 'tool-button', label);
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
  }

  private button(label: string, testId: string, onClick: () => void): HTMLButtonElement {
    const button = element('button', 'action-button', label);
    button.type = 'button';
    button.dataset.testid = testId;
    button.addEventListener('click', onClick);
    return button;
  }

  private check(label: string, testId: string, onChange: (checked: boolean) => void): HTMLInputElement {
    const input = element('input', 'structure-checkbox');
    input.type = 'checkbox';
    input.dataset.testid = testId;
    input.addEventListener('change', () => onChange(input.checked));
    const wrap = element('label', 'structure-toggle');
    wrap.append(input, document.createTextNode(label));
    return input;
  }

  private select(options: [string, string][], onChange: (value: string) => void, label: string): HTMLSelectElement {
    const select = element('select', 'preset-select');
    select.ariaLabel = label;
    for (const [value, text] of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  private numberInput(label: string, onChange: (value: number) => void, step: number): HTMLInputElement {
    const input = element('input', 'number-input');
    input.type = 'number';
    input.step = String(step);
    input.ariaLabel = label;
    input.addEventListener('change', () => onChange(Number(input.value)));
    return input;
  }
}
