import {
  RIGID_PRESETS,
  SHELL_PRESETS,
  VOLUME_PRESETS,
  type PresetBase,
} from '../materials/presets';
import { triangleCount } from '../simulation/assembly/partMeshes';

export const DOCUMENT_VERSION = 1;
export const MAX_PARTS = 8;
export const MIN_SCALE = 0.3;
export const MAX_SCALE = 2;

export type PartKind = 'rigid' | 'volume' | 'shell';
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface AssemblyPart {
  id: string;
  label: string;
  kind: PartKind;
  presetId: string;
  position: Vec3;
  quaternion: Quat;
  uniformScale: number;
}

export interface WeldAnchor {
  triangle: number;
  barycentric: Vec3;
}

export interface WeldSample {
  id: string;
  partA: string;
  partB: string;
  anchorA: WeldAnchor;
  anchorB: WeldAnchor;
  color: number;
}

export interface AssemblySettings {
  gridSnap: boolean;
  surfaceSnap: boolean;
  brushRadius: number;
}

export interface AssemblyDocument {
  version: typeof DOCUMENT_VERSION;
  name: string;
  parts: AssemblyPart[];
  welds: WeldSample[];
  settings: AssemblySettings;
}

export class DocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentValidationError';
  }
}

const KIND_PRESETS: Record<PartKind, PresetBase[]> = {
  rigid: RIGID_PRESETS,
  volume: VOLUME_PRESETS,
  shell: SHELL_PRESETS,
};

export function shapeForKind(kind: PartKind): 'cube' | 'sheet' {
  return kind === 'shell' ? 'sheet' : 'cube';
}

export function presetsForKind(kind: PartKind): PresetBase[] {
  return KIND_PRESETS[kind];
}

export function defaultPresetId(kind: PartKind): string {
  return KIND_PRESETS[kind][0].id;
}

export function presetById(kind: PartKind, presetId: string): PresetBase {
  const preset = KIND_PRESETS[kind].find((candidate) => candidate.id === presetId);
  if (!preset) throw new DocumentValidationError(`Unknown ${kind} preset "${presetId}"`);
  return preset;
}

export function cloneDocument(document: AssemblyDocument): AssemblyDocument {
  return structuredClone(document);
}

export function emptyDocument(name = 'Untitled assembly'): AssemblyDocument {
  return {
    version: DOCUMENT_VERSION,
    name,
    parts: [],
    welds: [],
    settings: { gridSnap: false, surfaceSnap: false, brushRadius: 0.08 },
  };
}

export function validateDocument(input: unknown): AssemblyDocument {
  if (!isRecord(input)) throw new DocumentValidationError('Assembly document must be an object');
  if (input.version !== DOCUMENT_VERSION) throw new DocumentValidationError('Unsupported assembly version');
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new DocumentValidationError('Assembly name is required');
  }
  if (!Array.isArray(input.parts) || !Array.isArray(input.welds) || !isRecord(input.settings)) {
    throw new DocumentValidationError('Assembly document is missing parts, welds, or settings');
  }
  if (input.parts.length > MAX_PARTS) throw new DocumentValidationError(`An assembly can contain at most ${MAX_PARTS} parts`);

  const parts = input.parts.map(readPart);
  const ids = new Set(parts.map((part) => part.id));
  if (ids.size !== parts.length) throw new DocumentValidationError('Part ids must be unique');
  const welds = input.welds.map((weld) => readWeld(weld, parts));
  const weldIds = new Set(welds.map((weld) => weld.id));
  if (weldIds.size !== welds.length) throw new DocumentValidationError('Weld ids must be unique');

  const settings = input.settings;
  if (typeof settings.gridSnap !== 'boolean' || typeof settings.surfaceSnap !== 'boolean') {
    throw new DocumentValidationError('Snap settings must be booleans');
  }
  if (!isUnitInterval(settings.brushRadius) || settings.brushRadius < 0.01 || settings.brushRadius > 0.3) {
    throw new DocumentValidationError('Brush radius must be between 1 cm and 30 cm');
  }

  return {
    version: DOCUMENT_VERSION,
    name: input.name.trim(),
    parts,
    welds,
    settings: {
      gridSnap: settings.gridSnap,
      surfaceSnap: settings.surfaceSnap,
      brushRadius: settings.brushRadius,
    },
  };
}

function readPart(input: unknown): AssemblyPart {
  if (!isRecord(input)) throw new DocumentValidationError('Each part must be an object');
  const kind = input.kind;
  if (kind !== 'rigid' && kind !== 'volume' && kind !== 'shell') {
    throw new DocumentValidationError('Part kind must be rigid, volume, or shell');
  }
  if (typeof input.id !== 'string' || typeof input.label !== 'string' || input.label.trim() === '') {
    throw new DocumentValidationError('Each part needs an id and a label');
  }
  if (typeof input.presetId !== 'string') throw new DocumentValidationError('Each part needs a preset');
  presetById(kind, input.presetId);
  const scale = input.uniformScale;
  if (typeof scale !== 'number' || scale < MIN_SCALE || scale > MAX_SCALE) {
    throw new DocumentValidationError(`Uniform scale must be between ${MIN_SCALE} and ${MAX_SCALE}`);
  }
  return {
    id: input.id,
    label: input.label.trim(),
    kind,
    presetId: input.presetId,
    position: readVec3(input.position, 'position'),
    quaternion: normalizeQuaternion(readQuat(input.quaternion)),
    uniformScale: scale,
  };
}

function readWeld(input: unknown, parts: AssemblyPart[]): WeldSample {
  if (!isRecord(input)) throw new DocumentValidationError('Each weld must be an object');
  if (typeof input.id !== 'string' || typeof input.partA !== 'string' || typeof input.partB !== 'string') {
    throw new DocumentValidationError('Each weld needs an id and two parts');
  }
  if (input.partA === input.partB) throw new DocumentValidationError('A part cannot be welded to itself');
  const partA = parts.find((part) => part.id === input.partA);
  const partB = parts.find((part) => part.id === input.partB);
  if (!partA || !partB) throw new DocumentValidationError('Weld references a missing part');
  if (typeof input.color !== 'number') throw new DocumentValidationError('Weld color is required');
  return {
    id: input.id,
    partA: input.partA,
    partB: input.partB,
    anchorA: readAnchor(input.anchorA, partA),
    anchorB: readAnchor(input.anchorB, partB),
    color: input.color,
  };
}

function readAnchor(input: unknown, part: AssemblyPart): WeldAnchor {
  if (!isRecord(input) || typeof input.triangle !== 'number' || !Number.isInteger(input.triangle)) {
    throw new DocumentValidationError('Weld anchor needs an integer triangle index');
  }
  const limit = triangleCount(shapeForKind(part.kind));
  if (input.triangle < 0 || input.triangle >= limit) {
    throw new DocumentValidationError('Weld anchor triangle is outside the part mesh');
  }
  const barycentric = readVec3(input.barycentric, 'barycentric');
  const sum = barycentric[0] + barycentric[1] + barycentric[2];
  if (barycentric.some((value) => value < -1e-3 || value > 1 + 1e-3) || Math.abs(sum - 1) > 1e-2) {
    throw new DocumentValidationError('Barycentric coordinates must be non-negative and sum to 1');
  }
  return { triangle: input.triangle, barycentric };
}

function readVec3(input: unknown, label: string): Vec3 {
  if (!Array.isArray(input) || input.length !== 3 || input.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new DocumentValidationError(`${label} must be three finite numbers`);
  }
  return [input[0], input[1], input[2]];
}

function readQuat(input: unknown): Quat {
  if (!Array.isArray(input) || input.length !== 4 || input.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new DocumentValidationError('quaternion must be four finite numbers');
  }
  return [input[0], input[1], input[2], input[3]];
}

function normalizeQuaternion(quaternion: Quat): Quat {
  const length = Math.hypot(...quaternion);
  if (length < 1e-8) throw new DocumentValidationError('Quaternion cannot be zero');
  return quaternion.map((value) => value / length) as Quat;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function isUnitInterval(input: unknown): input is number {
  return typeof input === 'number' && Number.isFinite(input);
}

export function nextId(prefix: string, used: readonly string[]): string {
  let n = 1;
  const taken = new Set(used);
  while (taken.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

export function addPart(document: AssemblyDocument, part: AssemblyPart): AssemblyDocument {
  if (document.parts.length >= MAX_PARTS) {
    throw new DocumentValidationError(`An assembly can contain at most ${MAX_PARTS} parts`);
  }
  const next = cloneDocument(document);
  next.parts.push(part);
  return validateDocument(next);
}

export function removePart(document: AssemblyDocument, partId: string): AssemblyDocument {
  const next = cloneDocument(document);
  next.parts = next.parts.filter((part) => part.id !== partId);
  next.welds = next.welds.filter((weld) => weld.partA !== partId && weld.partB !== partId);
  return next;
}

export function updatePart(document: AssemblyDocument, partId: string, patch: Partial<AssemblyPart>): AssemblyDocument {
  const next = cloneDocument(document);
  const part = next.parts.find((candidate) => candidate.id === partId);
  if (!part) throw new DocumentValidationError('Selected part no longer exists');
  const previousShape = shapeForKind(part.kind);
  Object.assign(part, patch);
  if (patch.kind && shapeForKind(part.kind) !== previousShape) {
    next.welds = next.welds.filter((weld) => weld.partA !== partId && weld.partB !== partId);
  }
  if (patch.presetId) presetById(part.kind, part.presetId);
  return validateDocument(next);
}

export function replaceWelds(document: AssemblyDocument, welds: WeldSample[]): AssemblyDocument {
  const next = cloneDocument(document);
  next.welds = welds;
  return validateDocument(next);
}

export function updateSettings(document: AssemblyDocument, patch: Partial<AssemblySettings>): AssemblyDocument {
  const next = cloneDocument(document);
  next.settings = { ...next.settings, ...patch };
  return validateDocument(next);
}
