export type AccessoryTransformTool = 'select' | 'move' | 'rotate' | 'scale' | 'place';
export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

export interface SurfaceAnchor {
  triangle: number;
  barycentric: Vec3Tuple;
}

export interface RigidWeldSample {
  id: string;
  sourceAnchor: SurfaceAnchor;
  accessoryAnchor: SurfaceAnchor;
}

export interface RigidWeldPart {
  id: string;
  presetId: string;
  label: string;
  position: Vec3Tuple;
  quaternion: QuatTuple;
  uniformScale: number;
  welds: RigidWeldSample[];
  valid: boolean;
}

export interface RigidWeldDocument {
  parts: RigidWeldPart[];
  selectedId: string | null;
}

export const MAX_RIGID_WELDS = 8;
export const MIN_ACCESSORY_SCALE = 0.5;
export const MAX_ACCESSORY_SCALE = 2;

export function emptyRigidWeldDocument(): RigidWeldDocument {
  return { parts: [], selectedId: null };
}

export function nextRigidWeldId(parts: readonly RigidWeldPart[]): string {
  const ids = new Set(parts.map((part) => part.id));
  let number = 1;
  while (ids.has(`rigid-weld-${number}`)) number++;
  return `rigid-weld-${number}`;
}

export function selectedRigidWeld(document: RigidWeldDocument): RigidWeldPart | null {
  return document.parts.find((part) => part.id === document.selectedId) ?? null;
}

export function addRigidWeldPart(document: RigidWeldDocument, part: RigidWeldPart): RigidWeldDocument {
  if (document.parts.length >= MAX_RIGID_WELDS) return document;
  return { parts: [...document.parts, part], selectedId: part.id };
}

export function updateRigidWeldPart(
  document: RigidWeldDocument,
  id: string,
  update: (part: RigidWeldPart) => RigidWeldPart,
): RigidWeldDocument {
  return {
    ...document,
    parts: document.parts.map((part) => (part.id === id ? update(part) : part)),
  };
}

export function removeRigidWeldPart(document: RigidWeldDocument, id: string): RigidWeldDocument {
  const parts = document.parts.filter((part) => part.id !== id);
  return {
    parts,
    selectedId: document.selectedId === id ? (parts.at(-1)?.id ?? null) : document.selectedId,
  };
}
