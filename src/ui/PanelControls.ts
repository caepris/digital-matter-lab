import type { PanelState, ToolId } from '../simulation/types';

export interface PresetOption {
  id: string;
  label: string;
  description: string;
}

export interface PanelControlsOptions {
  title: string;
  subtitle: string;
  accent: number;
  presets: PresetOption[];
  state: PanelState;
  onToolChange(tool: ToolId): void;
  onPresetChange(id: string): void;
  onStructureToggle(visible: boolean): void;
  onReset(): void;
}

const TOOLS: { id: ToolId; label: string; hint: string }[] = [
  { id: 'grab', label: 'Grab', hint: 'Drag the cube to pull, lift, or stretch it' },
  { id: 'drop', label: 'Drop', hint: 'Click to drop a steel ball from above' },
  { id: 'press', label: 'Press', hint: 'Hold to lower the press plate; release to lift it' },
];

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class PanelControls {
  readonly root: HTMLElement;
  private readonly toolButtons = new Map<ToolId, HTMLButtonElement>();
  private readonly presetSelect: HTMLSelectElement;
  private readonly presetDescription: HTMLElement;
  private readonly toolHint: HTMLElement;

  constructor(private readonly options: PanelControlsOptions) {
    const accent = `#${options.accent.toString(16).padStart(6, '0')}`;
    this.root = element('div', 'panel-controls');
    this.root.style.setProperty('--accent', accent);

    const heading = element('div', 'panel-heading');
    heading.append(element('h2', 'panel-title', options.title), element('p', 'panel-subtitle', options.subtitle));

    const row = element('div', 'control-row material-row');

    const presetLabel = element('label', 'preset-field');
    presetLabel.append(element('span', 'field-label', 'Material'));
    this.presetSelect = element('select', 'preset-select');
    this.presetSelect.setAttribute('data-testid', 'preset-select');
    for (const preset of options.presets) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      this.presetSelect.append(option);
    }
    this.presetSelect.disabled = options.presets.length < 2;
    this.presetSelect.addEventListener('change', () => options.onPresetChange(this.presetSelect.value));
    presetLabel.append(this.presetSelect);

    const tools = element('div', 'tool-group');
    tools.setAttribute('role', 'radiogroup');
    tools.setAttribute('aria-label', `${options.title} interaction tool`);
    for (const tool of TOOLS) {
      const button = element('button', 'tool-button', tool.label);
      button.type = 'button';
      button.title = tool.hint;
      button.setAttribute('role', 'radio');
      button.setAttribute('data-tool', tool.id);
      button.addEventListener('click', () => options.onToolChange(tool.id));
      this.toolButtons.set(tool.id, button);
      tools.append(button);
    }

    const structure = element('label', 'structure-toggle');
    const checkbox = element('input', 'structure-checkbox');
    checkbox.type = 'checkbox';
    checkbox.checked = options.state.structureVisible;
    checkbox.setAttribute('data-testid', 'structure-toggle');
    checkbox.addEventListener('change', () => options.onStructureToggle(checkbox.checked));
    structure.append(checkbox, element('span', '', 'Structure'));

    const reset = element('button', 'reset-button', 'Reset');
    reset.type = 'button';
    reset.setAttribute('data-testid', 'reset');
    reset.addEventListener('click', () => options.onReset());

    row.append(presetLabel, structure, reset);
    const toolRow = element('div', 'control-row tool-row');
    toolRow.append(element('span', 'field-label', 'Tool'), tools);

    this.presetDescription = element('p', 'preset-description');
    this.toolHint = element('p', 'tool-hint');

    this.root.append(heading, row, toolRow, this.presetDescription);
    this.sync(options.state);
  }

  /** Hint shown over the viewport; owned by the panel so it can sit inside the 3D area. */
  get hintElement(): HTMLElement {
    return this.toolHint;
  }

  sync(state: PanelState): void {
    for (const [id, button] of this.toolButtons) {
      const selected = id === state.tool;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-checked', String(selected));
    }
    this.presetSelect.value = state.presetId;
    const preset = this.options.presets.find((candidate) => candidate.id === state.presetId);
    this.presetDescription.textContent = preset?.description ?? '';
    this.toolHint.textContent = TOOLS.find((tool) => tool.id === state.tool)?.hint ?? '';
  }
}
