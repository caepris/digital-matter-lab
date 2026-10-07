import type { ToolId } from '../simulation/types';

/** What the viewport renders: the detailed source mesh or the filled thin shell driving it. */
export type ConversionView = 'source' | 'shell';

export const CONVERSION_SOURCES = [
  {
    id: 'tshirt',
    label: 'T-shirt',
    description: 'An upright rigid T-shirt on a hanger. Its shell drapes like cotton jersey.',
  },
  {
    id: 'curtain',
    label: 'Curtain',
    description: 'A pleated rigid curtain on a rod. Its shell hangs and swings like drapery fabric.',
  },
  {
    id: 'car-shell',
    label: 'Car shell',
    description: 'A rigid car body with wheel arches. Its shell is stiff sheet metal that dents under hard hits.',
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
}

export interface ConversionLegendEntry {
  label: string;
  color: number;
}

export interface ConversionControlModel {
  sourceId: ConversionSourceId;
  view: ConversionView;
  structureVisible: boolean;
  sectionVisible: boolean;
  /** Shell thickness in meters. The slider and readout show centimeters. */
  thickness: number;
  generated: ConversionGeneratedStats | null;
  generating: boolean;
  status: string;
  simulationPaused: boolean;
  tool: ToolId;
  legend: ConversionLegendEntry[];
}

export interface ConversionControlHandlers {
  onSource(sourceId: ConversionSourceId): void;
  onView(view: ConversionView): void;
  onStructure(visible: boolean): void;
  onSection(visible: boolean): void;
  /** `thickness` is meters. `commit` is false while the slider is dragged. */
  onThickness(thickness: number, commit: boolean): void;
  onSimulationPaused(paused: boolean): void;
  onReset(): void;
  onTool(tool: ToolId): void;
}

const VIEWS: { id: ConversionView; label: string; hint: string }[] = [
  { id: 'shell', label: 'Thin shell', hint: 'Show the filled simulation shell' },
  { id: 'source', label: 'Source mesh', hint: 'Show the detailed source mesh driven by the shell' },
];

const SIM_TOOLS: { id: ToolId; label: string; hint: string }[] = [
  { id: 'grab', label: 'Grab', hint: 'Drag the mesh to pull it.' },
  { id: 'drop', label: 'Drop', hint: 'Click to drop a steel ball.' },
  { id: 'press', label: 'Press', hint: 'Hold to lower the press.' },
];

const SECTION_HINT = {
  shell: 'Drag the section plane left or right to inspect the filled shell.',
  source: 'Drag the section plane left or right to inspect the source mesh.',
} satisfies Record<ConversionView, string>;
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
  readonly hint = element('p', 'tool-hint', `${SIM_TOOLS[0].hint} · ${CAMERA_HINT}`);
  readonly legend = element('div', 'structure-legend');
  private readonly viewButtons = new Map<ConversionView, HTMLButtonElement>();
  private readonly toolButtons = new Map<ToolId, HTMLButtonElement>();
  private readonly sourceSelect: HTMLSelectElement;
  private readonly sourceDescription = element('p', 'context-description');
  private readonly structure: HTMLInputElement;
  private readonly thickness: HTMLInputElement;
  private readonly thicknessValue = element('output', 'value-output');
  private readonly sectionButton: HTMLButtonElement;
  private readonly stats = element('p', 'context-description', 'Generating shell…');
  private readonly play: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly status = element('p', 'assembly-status');

  constructor(private readonly handlers: ConversionControlHandlers) {
    this.root.style.setProperty('--accent', '#5cc4a8');
    this.root.setAttribute('aria-label', 'Thin mesh conversion');

    const heading = element('div', 'panel-heading');
    heading.append(
      element('h2', 'panel-title', 'Thin mesh conversion'),
      element('p', 'panel-subtitle', 'Edit the rigid source; a thin shell regenerates automatically and is always ready to simulate.'),
    );

    const display = this.section('View');
    const views = this.radioGroup('Viewport display');
    for (const view of VIEWS) {
      const button = this.radio(view.label, () => handlers.onView(view.id), view.hint);
      button.dataset.view = view.id;
      views.append(button);
      this.viewButtons.set(view.id, button);
    }
    this.sectionButton = this.button('Section view', 'section-tool', () => {
      handlers.onSection(this.sectionButton.getAttribute('aria-pressed') !== 'true');
    });
    this.sectionButton.setAttribute('aria-pressed', 'false');
    this.sectionButton.title = 'Drag a cutting plane through whichever mesh is shown';
    const displayActions = element('div', 'action-row');
    displayActions.append(this.sectionButton);
    display.append(views, displayActions);

    const source = this.section('Source');
    this.sourceSelect = this.select(
      CONVERSION_SOURCES.map((item) => [item.id, item.label]),
      (value) => {
        const match = CONVERSION_SOURCES.find((item) => item.id === value);
        if (match) handlers.onSource(match.id);
      },
      'Rigid source mesh',
    );
    this.sourceSelect.dataset.testid = 'source-select';
    this.sourceSelect.title = 'Rigid solid mesh to convert. Changing it regenerates the shell.';
    this.structure = this.check('Structure', 'structure-toggle', handlers.onStructure);
    this.structure.title = 'Show mesh vertices and edges';
    source.append(this.field('Source', this.sourceSelect), this.sourceDescription, this.structure.parentElement!);

    const shell = this.section('Thin shell');
    this.thickness = element('input', 'brush-range');
    this.thickness.type = 'range';
    this.thickness.id = 'conversion-thickness';
    this.thickness.min = String(CONVERSION_THICKNESS_CM.min);
    this.thickness.max = String(CONVERSION_THICKNESS_CM.max);
    this.thickness.step = String(CONVERSION_THICKNESS_CM.step);
    this.thickness.value = '1.0';
    this.thickness.dataset.testid = 'thickness';
    this.thickness.ariaLabel = 'Shell thickness in centimeters';
    this.thickness.title = 'Adjust filled thickness and bending stiffness live';
    this.thickness.addEventListener('input', () => this.emitThickness(false));
    this.thickness.addEventListener('change', () => this.emitThickness(true));
    this.thicknessValue.htmlFor = 'conversion-thickness';
    this.thicknessValue.dataset.testid = 'thickness-output';
    this.thicknessValue.value = formatCentimeters(1);
    const thicknessField = this.field('Thickness', this.thickness);
    thicknessField.append(this.thicknessValue);
    this.stats.dataset.testid = 'conversion-stats';
    shell.append(
      thicknessField,
      element('p', 'context-description', 'Thicker shells are filled and resist bending with thickness cubed.'),
      this.stats,
    );

    const run = this.section('Simulate');
    const transport = element('div', 'action-row');
    this.play = element('button', 'action-button', 'Play');
    this.play.type = 'button';
    this.play.dataset.testid = 'simulation-play';
    this.play.addEventListener('click', () => handlers.onSimulationPaused(this.play.textContent === 'Pause'));
    this.resetButton = this.button('Reset', 'reset', handlers.onReset);
    this.resetButton.title = 'Restore the shell rest shape and pause';
    transport.append(this.play, this.resetButton);
    const tools = this.radioGroup('Simulation tool');
    for (const tool of SIM_TOOLS) {
      const button = this.radio(tool.label, () => handlers.onTool(tool.id), tool.hint);
      button.dataset.tool = tool.id;
      tools.append(button);
      this.toolButtons.set(tool.id, button);
    }
    run.append(transport, tools);

    this.status.dataset.testid = 'conversion-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.legend.hidden = true;
    this.root.append(heading, display, source, shell, run, this.status);
  }

  sync(model: ConversionControlModel): void {
    this.syncRadios(this.viewButtons, model.view);
    this.syncRadios(this.toolButtons, model.tool);

    this.sourceSelect.value = model.sourceId;
    this.sourceDescription.textContent = CONVERSION_SOURCES.find((item) => item.id === model.sourceId)?.description ?? '';
    this.structure.checked = model.structureVisible;
    this.sectionButton.setAttribute('aria-pressed', String(model.sectionVisible));
    this.sectionButton.classList.toggle('is-selected', model.sectionVisible);

    const ready = model.generated !== null;
    this.thickness.disabled = !ready;
    this.play.disabled = !ready;
    this.resetButton.disabled = !ready;
    this.viewButtons.get('shell')!.disabled = !ready;
    for (const button of this.toolButtons.values()) button.disabled = !ready;

    const centimeters = thicknessToCentimeters(model.thickness);
    if (document.activeElement !== this.thickness) this.thickness.value = centimeters.toFixed(1);
    this.publishThicknessReadout(Number(this.thickness.value));

    this.stats.textContent = model.generated
      ? this.formatStats(model.generated)
      : model.generating
        ? 'Generating shell…'
        : 'No shell. Choose a source to generate one.';
    this.play.textContent = model.simulationPaused ? 'Play' : 'Pause';
    this.play.ariaLabel = model.simulationPaused ? 'Play simulation' : 'Pause simulation';
    this.play.title = model.simulationPaused ? 'Start the simulation' : 'Pause the simulation';
    this.status.textContent = model.status || (model.simulationPaused ? 'Simulation paused' : 'Simulation running');

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

    const hint = model.sectionVisible ? SECTION_HINT[model.view] : (SIM_TOOLS.find((tool) => tool.id === model.tool)?.hint ?? '');
    this.hint.textContent = `${hint} · ${CAMERA_HINT}`;
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
    return [
      `${stats.vertices.toLocaleString()} vertices`,
      `${stats.triangles.toLocaleString()} triangles`,
      `${stats.stretchEdges.toLocaleString()} stretch edges`,
      `${stats.bendPairs.toLocaleString()} bend pairs`,
    ].join(' · ');
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
