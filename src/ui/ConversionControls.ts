import type { ToolId } from '../simulation/types';

export type ConversionStage = 'source' | 'generate' | 'run';

export const CONVERSION_SOURCES = [
  {
    id: 'tshirt',
    label: 'T-shirt',
    description: 'A rigid solid shaped like a T-shirt with a torso and sleeves.',
  },
  {
    id: 'curtain',
    label: 'Curtain',
    description: 'A rigid solid shaped like a curtain with vertical folds.',
  },
  {
    id: 'car-shell',
    label: 'Car shell',
    description: 'A rigid solid shaped like a metal vehicle body.',
  },
] as const;

export type ConversionSourceId = (typeof CONVERSION_SOURCES)[number]['id'];

/** Inclusive slider bounds. {@link ConversionControlModel.thickness} is stored in meters. */
export const CONVERSION_THICKNESS_CM = { min: 0.2, max: 8, step: 0.1 } as const;

export interface ConversionGeneratedStats {
  vertices: number;
  triangles: number;
  stretchEdges: number;
  bendPairs: number;
  /** Thickness in meters used when this shell was generated. */
  thickness: number;
}

export interface ConversionLegendEntry {
  label: string;
  color: number;
}

export interface ConversionControlModel {
  stage: ConversionStage;
  sourceId: ConversionSourceId;
  structureVisible: boolean;
  /** Shell thickness in meters. The slider and readout show centimeters. */
  thickness: number;
  generated: ConversionGeneratedStats | null;
  status: string;
  simulationPaused: boolean;
  tool: ToolId;
  legend: ConversionLegendEntry[];
}

export interface ConversionControlHandlers {
  onStage(stage: ConversionStage): void;
  onSource(sourceId: ConversionSourceId): void;
  onStructure(visible: boolean): void;
  /** `thickness` is meters. `commit` is false while the slider is dragged. */
  onThickness(thickness: number, commit: boolean): void;
  onGenerate(): void;
  onSimulationPaused(paused: boolean): void;
  onReset(): void;
  onTool(tool: ToolId): void;
}

const STAGES: { id: ConversionStage; label: string }[] = [
  { id: 'source', label: 'Source' },
  { id: 'generate', label: 'Generate' },
  { id: 'run', label: 'Run' },
];

const SIM_TOOLS: { id: ToolId; label: string; hint: string }[] = [
  { id: 'grab', label: 'Grab', hint: 'Drag the mesh to pull it.' },
  { id: 'drop', label: 'Drop', hint: 'Click to drop a steel ball.' },
  { id: 'press', label: 'Press', hint: 'Hold to lower the press.' },
];

const STAGE_HINTS: Record<ConversionStage, string> = {
  source: 'Choose a rigid solid mesh. Structure shows the vertices on its closed surface.',
  generate: 'Set a thickness in centimeters, then generate a thin simulatable shell.',
  run: '',
};

const CAMERA_HINT = 'Middle-drag orbit · Right-drag pan · Scroll or trackpad zoom';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatCentimeters(cm: number): string {
  return `${cm.toFixed(1)} cm`;
}

function thicknessToCentimeters(meters: number): number {
  const cm = meters * 100;
  if (!Number.isFinite(cm)) return CONVERSION_THICKNESS_CM.min;
  const clamped = Math.min(CONVERSION_THICKNESS_CM.max, Math.max(CONVERSION_THICKNESS_CM.min, cm));
  return Math.round(clamped / CONVERSION_THICKNESS_CM.step) * CONVERSION_THICKNESS_CM.step;
}

export class ConversionControls {
  readonly root = element('aside', 'panel-controls assembly-editor conversion-editor');
  readonly hint = element('p', 'tool-hint', `${STAGE_HINTS.source} · ${CAMERA_HINT}`);
  readonly legend = element('div', 'structure-legend');
  private readonly stageButtons = new Map<ConversionStage, HTMLButtonElement>();
  private readonly toolButtons = new Map<ToolId, HTMLButtonElement>();
  private readonly sourceSelect: HTMLSelectElement;
  private readonly sourceDescription = element('p', 'context-description');
  private readonly structure: HTMLInputElement;
  private readonly thickness: HTMLInputElement;
  private readonly thicknessValue = element('output', 'value-output');
  private readonly generateShell: HTMLButtonElement;
  private readonly stats = element('p', 'context-description', 'No simulatable shell yet.');
  private readonly play: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly status = element('p', 'assembly-status');

  constructor(private readonly handlers: ConversionControlHandlers) {
    this.root.style.setProperty('--accent', '#5cc4a8');
    this.root.setAttribute('aria-label', 'Thin mesh conversion');

    const heading = element('div', 'panel-heading');
    heading.append(
      element('h2', 'panel-title', 'Thin mesh conversion'),
      element('p', 'panel-subtitle', 'Pick a rigid solid mesh, generate a thin shell, then simulate that shell.'),
    );

    const stageBar = element('div', 'editor-topbar');
    const stages = this.radioGroup('Conversion stage');
    for (const stage of STAGES) {
      const button = this.radio(stage.label, () => handlers.onStage(stage.id));
      button.dataset.stage = stage.id;
      button.dataset.testid = `stage-${stage.id}`;
      stages.append(button);
      this.stageButtons.set(stage.id, button);
    }
    stageBar.append(stages);

    const source = this.section('1 · Source');
    this.sourceSelect = this.select(
      CONVERSION_SOURCES.map((item) => [item.id, item.label]),
      (value) => {
        const match = CONVERSION_SOURCES.find((item) => item.id === value);
        if (match) handlers.onSource(match.id);
      },
      'Rigid source mesh',
    );
    this.sourceSelect.dataset.testid = 'source-select';
    this.structure = this.check('Structure', 'structure-toggle', handlers.onStructure);
    source.append(this.field('Source', this.sourceSelect), this.sourceDescription, this.structure.parentElement!);

    const generate = this.section('2 · Generate');
    this.thickness = element('input', 'brush-range');
    this.thickness.type = 'range';
    this.thickness.id = 'conversion-thickness';
    this.thickness.min = String(CONVERSION_THICKNESS_CM.min);
    this.thickness.max = String(CONVERSION_THICKNESS_CM.max);
    this.thickness.step = String(CONVERSION_THICKNESS_CM.step);
    this.thickness.value = '1.0';
    this.thickness.dataset.testid = 'thickness';
    this.thickness.ariaLabel = 'Shell thickness in centimeters';
    this.thickness.addEventListener('input', () => this.emitThickness(false));
    this.thickness.addEventListener('change', () => this.emitThickness(true));
    this.thicknessValue.htmlFor = 'conversion-thickness';
    this.thicknessValue.dataset.testid = 'thickness-output';
    this.thicknessValue.value = formatCentimeters(1);
    const thicknessField = this.field('Thickness', this.thickness);
    thicknessField.append(this.thicknessValue);
    this.generateShell = this.button('Generate shell', 'generate-shell', handlers.onGenerate);
    const generateActions = element('div', 'action-row');
    generateActions.append(this.generateShell);
    this.stats.dataset.testid = 'conversion-stats';
    generate.append(thicknessField, generateActions, this.stats);

    const run = this.section('3 · Run');
    const transport = element('div', 'action-row');
    this.play = element('button', 'action-button', 'Play');
    this.play.type = 'button';
    this.play.dataset.testid = 'simulation-play';
    this.play.addEventListener('click', () => handlers.onSimulationPaused(this.play.textContent === 'Pause'));
    this.resetButton = this.button('Reset', 'reset', handlers.onReset);
    transport.append(this.play, this.resetButton);
    const tools = this.radioGroup('Simulation tool');
    for (const tool of SIM_TOOLS) {
      const button = this.radio(tool.label, () => handlers.onTool(tool.id), tool.hint);
      button.dataset.tool = tool.id;
      tools.append(button);
      this.toolButtons.set(tool.id, button);
    }
    run.append(
      element('p', 'context-description', 'Simulation starts paused. Play drives the source mesh with the generated shell.'),
      transport,
      tools,
    );

    this.status.dataset.testid = 'conversion-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.legend.hidden = true;
    this.root.append(heading, stageBar, source, generate, run, this.status);
    this.applyStage('source');
  }

  sync(model: ConversionControlModel): void {
    this.syncRadios(this.stageButtons, model.stage);
    this.syncRadios(this.toolButtons, model.tool);
    this.applyStage(model.stage);

    this.sourceSelect.value = model.sourceId;
    this.sourceDescription.textContent = CONVERSION_SOURCES.find((item) => item.id === model.sourceId)?.description ?? '';
    this.structure.checked = model.structureVisible;

    const centimeters = thicknessToCentimeters(model.thickness);
    if (document.activeElement !== this.thickness) this.thickness.value = centimeters.toFixed(1);
    this.publishThicknessReadout(Number(this.thickness.value));

    this.stats.textContent = model.generated ? this.formatStats(model.generated) : 'No simulatable shell yet.';
    this.play.textContent = model.simulationPaused ? 'Play' : 'Pause';
    this.play.ariaLabel = model.simulationPaused ? 'Play simulation' : 'Pause simulation';
    if (model.stage === 'run') {
      this.play.title = model.simulationPaused ? 'Start the simulation' : 'Pause the simulation';
    }
    this.status.textContent = model.status || this.fallbackStatus(model);

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

    const stageHint = model.stage === 'run'
      ? SIM_TOOLS.find((tool) => tool.id === model.tool)?.hint ?? ''
      : STAGE_HINTS[model.stage];
    this.hint.textContent = `${stageHint} · ${CAMERA_HINT}`;
  }

  private emitThickness(commit: boolean): void {
    const centimeters = Number(this.thickness.value);
    this.publishThicknessReadout(centimeters);
    this.handlers.onThickness(centimeters / 100, commit);
  }

  private publishThicknessReadout(centimeters: number): void {
    const text = formatCentimeters(centimeters);
    this.thicknessValue.value = text;
    this.thickness.setAttribute('aria-valuetext', text);
  }

  private formatStats(stats: ConversionGeneratedStats): string {
    const counts = [
      `${stats.vertices.toLocaleString()} vertices`,
      `${stats.triangles.toLocaleString()} triangles`,
      `${stats.stretchEdges.toLocaleString()} stretch edges`,
      `${stats.bendPairs.toLocaleString()} bend pairs`,
    ].join(' · ');
    return `Generated at ${formatCentimeters(thicknessToCentimeters(stats.thickness))} · ${counts}`;
  }

  private fallbackStatus(model: ConversionControlModel): string {
    if (model.stage === 'source') {
      const source = CONVERSION_SOURCES.find((item) => item.id === model.sourceId);
      return source ? `Source · ${source.label}` : 'Choose a source mesh';
    }
    if (model.stage === 'generate') {
      return model.generated ? 'Shell ready. Switch to Run to simulate it.' : 'Set a thickness, then generate the shell.';
    }
    return model.simulationPaused ? 'Simulation paused' : 'Simulation running';
  }

  /** Source edits the mesh and structure overlay; Generate sets thickness; Run simulates. */
  private applyStage(stage: ConversionStage): void {
    const source = stage === 'source';
    const generate = stage === 'generate';
    const run = stage === 'run';
    this.sourceSelect.disabled = !source;
    this.structure.disabled = false;
    this.thickness.disabled = !generate;
    this.generateShell.disabled = !generate;
    this.play.disabled = !run;
    this.resetButton.disabled = !run;
    for (const button of this.toolButtons.values()) button.disabled = !run;

    this.sourceSelect.title = source ? 'Rigid solid mesh to convert' : 'Switch to Source to change the mesh';
    this.structure.title = source ? 'Show source mesh vertices' : 'Show generated simulation vertices and constraints';
    this.thickness.title = generate ? 'Simulated shell thickness' : 'Switch to Generate to set thickness';
    this.generateShell.title = generate ? 'Build a thin simulatable shell' : 'Switch to Generate to build the shell';
    this.play.title = run ? this.play.title : 'Switch to Run to simulate';
    this.resetButton.title = run ? 'Restore the generated shell and pause' : 'Switch to Run to reset the simulation';
    for (const [id, button] of this.toolButtons) {
      const hint = SIM_TOOLS.find((tool) => tool.id === id)!.hint;
      button.title = run ? hint : 'Switch to Run to use simulation tools';
    }
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
    button.setAttribute('aria-checked', 'false');
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
}
