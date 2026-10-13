import { WORKFLOW_ASSETS, workflowAsset, type WorkflowAssetId } from '../creator-workflow/workflowAssets';
import type { CreatorWorkflowState, WorkflowStage } from '../creator-workflow/workflowTypes';
import { WORKFLOW_STAGES } from '../creator-workflow/workflowTypes';

export interface CreatorWorkflowHandlers {
  onAsset(id: WorkflowAssetId): void;
  onStage(stage: WorkflowStage): void;
  onToggleCap(region: number): void;
  onClearCaps(): void;
  onThickness(value: number): void;
  onShowMapping(value: boolean): void;
  onShowRender(value: boolean): void;
  onPrevious(): void;
  onNext(): void;
  onSimulationPaused(value: boolean): void;
  onResetSimulation(): void;
  onWind(value: number): void;
  onResetView(): void;
}

const STAGES: readonly { id: WorkflowStage; label: string }[] = [
  { id: 'submit', label: '1. Creator submits' },
  { id: 'build', label: '2. Engine builds simulation mesh' },
  { id: 'simulate', label: '3. Simulate' },
];

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

export class CreatorWorkflowControls {
  readonly root = node('section', 'workflow-controls');
  private readonly asset: HTMLSelectElement;
  private readonly stageButtons = new Map<WorkflowStage, HTMLButtonElement>();
  private readonly caps = node('div', 'workflow-cap-chips');
  private readonly capStatus = node('span', 'workflow-cap-status');
  private readonly clearCaps = node('button', 'action-button', 'Clear');
  private readonly capField = node('div', 'workflow-cap-field');
  private readonly thickness: HTMLInputElement;
  private readonly thicknessOutput = node('output', 'value-output');
  private readonly thicknessField: HTMLLabelElement;
  private readonly mapping: HTMLInputElement;
  private readonly renderToggle: HTMLInputElement;
  private readonly previous = node('button', 'action-button', 'Back');
  private readonly next = node('button', 'action-button', 'Next');
  private readonly play = node('button', 'action-button', 'Play');
  private readonly reset = node('button', 'action-button', 'Reset simulation');
  private readonly resetView = node('button', 'action-button', 'Reset view');
  private readonly wind: HTMLInputElement;
  private readonly windOutput = node('output', 'value-output');
  private readonly callout = node('p', 'workflow-callout');
  private capsAssetId: WorkflowAssetId | null = null;

  constructor(private readonly handlers: CreatorWorkflowHandlers) {
    const intro = node('div', 'workflow-intro');
    intro.append(
      node('h2', 'panel-title', 'Creator authoring paths'),
      node(
        'p',
        'panel-subtitle',
        'Follow one arbitrary mesh through three ways of producing the mesh that actually simulates.',
      ),
    );

    this.asset = this.select(
      WORKFLOW_ASSETS.map((asset) => [asset.id, asset.label]),
      (value) => handlers.onAsset(value as WorkflowAssetId),
      'Example asset',
    );
    this.asset.dataset.testid = 'workflow-asset';

    const stage = node('div', 'workflow-stage');
    stage.setAttribute('role', 'radiogroup');
    stage.setAttribute('aria-label', 'Workflow step');
    for (const entry of STAGES) {
      const button = node('button', 'tool-button', entry.label);
      button.type = 'button';
      button.dataset.workflowStage = entry.id;
      button.dataset.testid = `workflow-stage-${entry.id}`;
      button.setAttribute('role', 'radio');
      button.addEventListener('click', () => handlers.onStage(entry.id));
      stage.append(button);
      this.stageButtons.set(entry.id, button);
    }
    stage.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const active = STAGES.findIndex((entry) => this.stageButtons.get(entry.id) === document.activeElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? STAGES.length - 1
            : (Math.max(0, active) + (event.key === 'ArrowRight' ? 1 : -1) + STAGES.length) % STAGES.length;
      this.stageButtons.get(STAGES[next].id)?.click();
      this.stageButtons.get(STAGES[next].id)?.focus();
    });

    this.caps.setAttribute('role', 'group');
    this.caps.setAttribute('aria-label', 'End caps');
    this.caps.dataset.testid = 'workflow-caps';
    this.capStatus.dataset.testid = 'workflow-cap-status';
    this.clearCaps.type = 'button';
    this.clearCaps.dataset.testid = 'workflow-caps-clear';
    this.clearCaps.addEventListener('click', handlers.onClearCaps);
    const capHeader = node('div', 'workflow-cap-header');
    capHeader.append(node('span', 'field-label', 'Path 1 end caps (click the mesh or a chip)'), this.clearCaps);
    this.capField.append(capHeader, this.caps, this.capStatus);

    this.thickness = this.range('workflow-thickness', 0.2, 5, 0.1, (value) => handlers.onThickness(value));
    this.thicknessField = this.field('Thickness (Paths 1 and 3)', this.thickness);
    this.thicknessField.append(this.thicknessOutput);
    this.mapping = this.check('Show simulation mesh overlay', 'workflow-mapping', handlers.onShowMapping);
    this.renderToggle = this.check('Show render mesh', 'workflow-render', handlers.onShowRender);
    this.wind = this.range('workflow-wind', 0, 8, 0.25, (value) => handlers.onWind(value));
    for (const button of [this.previous, this.next, this.play, this.reset, this.resetView]) button.type = 'button';
    this.resetView.dataset.testid = 'workflow-reset-view';
    this.resetView.addEventListener('click', handlers.onResetView);
    this.previous.dataset.testid = 'workflow-back';
    this.next.dataset.testid = 'workflow-next';
    this.play.dataset.testid = 'workflow-simulation-play';
    this.reset.dataset.testid = 'workflow-simulation-reset';
    this.previous.addEventListener('click', handlers.onPrevious);
    this.next.addEventListener('click', handlers.onNext);
    this.play.addEventListener('click', () => handlers.onSimulationPaused(this.play.textContent === 'Pause'));
    this.reset.addEventListener('click', handlers.onResetSimulation);

    const primary = node('div', 'workflow-primary-controls');
    const navigation = node('div', 'workflow-navigation');
    navigation.append(this.previous, this.next);
    primary.append(this.field('Example', this.asset), stage, navigation);
    const details = node('div', 'workflow-detail-controls');
    details.append(this.capField, this.thicknessField, this.renderToggle.parentElement!, this.mapping.parentElement!);
    const simulation = node('div', 'workflow-simulation-controls');
    simulation.dataset.testid = 'workflow-simulation-controls';
    const windField = this.field('Wind', this.wind);
    windField.append(this.windOutput);
    simulation.append(
      this.play,
      this.reset,
      windField,
      node('span', 'workflow-simulation-hint', 'Drag the model to grab it; drag empty space to orbit.'),
    );
    const legend = node('div', 'workflow-legend-row');
    legend.setAttribute('aria-label', 'Color legend');
    legend.innerHTML =
      '<span><i class="render"></i>Render mesh</span><span><i class="proxy"></i>Simulation mesh</span>' +
      '<span><i class="cap"></i>End cap</span><span><i class="rim"></i>Open boundary / thickness rim</span>' +
      '<span><i class="mapping"></i>Binding</span><span><i class="ghost"></i>Collision body</span>';
    const camera = node('div', 'workflow-camera-hint');
    camera.dataset.testid = 'workflow-camera-hint';
    camera.append(
      node('span', '', 'Two-finger scroll or shift-drag to pan, pinch to zoom, drag to orbit'),
      this.resetView,
    );
    legend.append(camera);
    this.root.append(intro, primary, details, simulation, legend, this.callout);
  }

  sync(state: CreatorWorkflowState): void {
    this.root.dataset.stage = state.stage;
    this.asset.value = state.assetId;
    for (const [id, button] of this.stageButtons) {
      const selected = id === state.stage;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    const asset = workflowAsset(state.assetId);
    if (this.capsAssetId !== state.assetId) {
      this.capsAssetId = state.assetId;
      this.caps.replaceChildren(
        ...asset.capRegions.map((cap) => {
          const chip = node('button', 'workflow-cap-chip', cap.label);
          chip.type = 'button';
          chip.dataset.capRegion = String(cap.id);
          chip.dataset.testid = `workflow-cap-${cap.id}`;
          chip.addEventListener('click', () => this.handlers.onToggleCap(cap.id));
          return chip;
        }),
      );
    }
    for (const chip of this.caps.querySelectorAll<HTMLButtonElement>('.workflow-cap-chip')) {
      const pressed = state.endCaps.includes(Number(chip.dataset.capRegion));
      chip.setAttribute('aria-pressed', String(pressed));
      chip.classList.toggle('is-selected', pressed);
    }
    this.capStatus.textContent =
      state.endCaps.length === 0
        ? 'No end caps: full mesh simulates'
        : `${state.endCaps.length} end cap${state.endCaps.length === 1 ? '' : 's'} marked: they render but do not simulate`;
    this.clearCaps.disabled = state.endCaps.length === 0;
    this.capField.hidden = state.stage !== 'submit';
    this.thicknessField.hidden = state.stage !== 'build';
    this.mapping.parentElement!.hidden = state.stage === 'submit';
    this.thickness.value = String(state.thicknessCm);
    this.thicknessOutput.value = `${state.thicknessCm.toFixed(1)} cm`;
    this.mapping.checked = state.showMapping;
    this.mapping.disabled = !state.showRender;
    this.renderToggle.checked = state.showRender;
    this.wind.value = String(state.wind);
    this.windOutput.value = `${state.wind.toFixed(1)} m/s`;
    this.play.textContent = state.simulationPaused ? 'Play' : 'Pause';
    const stageIndex = WORKFLOW_STAGES.indexOf(state.stage);
    this.previous.disabled = stageIndex === 0;
    this.next.disabled = stageIndex === WORKFLOW_STAGES.length - 1;
    this.callout.textContent = asset.callout;
  }

  private range(
    testId: string,
    min: number,
    max: number,
    step: number,
    onInput: (value: number) => void,
  ): HTMLInputElement {
    const input = node('input', 'brush-range');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.dataset.testid = testId;
    input.addEventListener('input', () => onInput(Number(input.value)));
    return input;
  }

  private select(
    options: readonly (readonly [string, string])[],
    onChange: (value: string) => void,
    label: string,
  ): HTMLSelectElement {
    const select = node('select', 'preset-select');
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

  private check(label: string, testId: string, onChange: (checked: boolean) => void): HTMLInputElement {
    const input = node('input', 'structure-checkbox');
    input.type = 'checkbox';
    input.dataset.testid = testId;
    input.addEventListener('change', () => onChange(input.checked));
    const wrap = node('label', 'structure-toggle');
    wrap.append(input, document.createTextNode(label));
    return input;
  }

  private field(label: string, control: HTMLElement): HTMLLabelElement {
    const field = node('label', 'control-field');
    field.append(node('span', 'field-label', label), control);
    return field;
  }
}
