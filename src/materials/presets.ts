import type { MatterKind } from '../simulation/types';

/** Rest-state creep: strains beyond `yieldStrain` permanently move the rest shape by `creep` per step, up to `maxStrain`. */
export interface PlasticSettings {
  yieldStrain: number;
  creep: number;
  maxStrain: number;
}

export interface PresetBase {
  id: string;
  label: string;
  description: string;
  color: number;
}

export interface RigidPreset extends PresetBase {
  density: number;
  friction: number;
  restitution: number;
}

export interface VolumePreset extends PresetBase {
  /** XPBD compliance (inverse stiffness) of tetrahedral edges. */
  edgeCompliance: number;
  /** XPBD compliance of tetrahedral volume preservation; 0 is incompressible. */
  volumeCompliance: number;
  damping: number;
  friction: number;
  substeps: number;
  plastic: PlasticSettings | null;
}

export interface ShellPreset extends PresetBase {
  stretchCompliance: number;
  compressionCompliance: number;
  bendCompliance: number;
  damping: number;
  friction: number;
  substeps: number;
  plastic: PlasticSettings | null;
}

export interface AssemblyPreset extends PresetBase {
  substeps: number;
  damping: number;
  friction: number;
}

export const RIGID_PRESETS: RigidPreset[] = [
  {
    id: 'dense-solid',
    label: 'Dense solid',
    description: 'Steel-like: heavy, low bounce. Never changes shape.',
    color: 0x7f9cff,
    density: 7,
    friction: 0.6,
    restitution: 0.1,
  },
  {
    id: 'light-solid',
    label: 'Light solid',
    description: 'Wood-like: light and lively. Never changes shape.',
    color: 0xa5b8ff,
    density: 0.7,
    friction: 0.7,
    restitution: 0.35,
  },
];

export const VOLUME_PRESETS: VolumePreset[] = [
  {
    id: 'gel',
    label: 'Gel',
    description: 'Very soft and incompressible. Wobbles, then fully recovers.',
    color: 0xf0a060,
    edgeCompliance: 0.06,
    volumeCompliance: 0,
    damping: 0.6,
    friction: 0.5,
    substeps: 12,
    plastic: null,
  },
  {
    id: 'foam',
    label: 'Foam',
    description: 'Compressible and plastic. Impacts leave lasting dents.',
    color: 0xe6c27a,
    edgeCompliance: 0.004,
    volumeCompliance: 0.05,
    damping: 4,
    friction: 0.8,
    substeps: 10,
    plastic: { yieldStrain: 0.06, creep: 0.08, maxStrain: 0.22 },
  },
  {
    id: 'firm-rubber',
    label: 'Firm rubber',
    description: 'Stiff and springy. Small elastic give, then rebounds.',
    color: 0xd9744a,
    edgeCompliance: 0.0004,
    volumeCompliance: 0,
    damping: 1.2,
    friction: 0.8,
    substeps: 14,
    plastic: null,
  },
];

export const SHELL_PRESETS: ShellPreset[] = [
  {
    id: 'loose-cloth',
    label: 'Loose cloth',
    description: 'A sewn cloth bag. Sags under its own weight; no inner volume.',
    color: 0x5cc4a8,
    stretchCompliance: 0,
    compressionCompliance: 0.1,
    bendCompliance: 2,
    damping: 1.5,
    friction: 0.6,
    substeps: 10,
    plastic: null,
  },
  {
    id: 'structured-fabric',
    label: 'Structured fabric',
    description: 'Stiffer canvas. Resists folding and keeps the creases it gets.',
    color: 0x7fd6c0,
    stretchCompliance: 0,
    compressionCompliance: 0.0002,
    bendCompliance: 0.02,
    damping: 1.5,
    friction: 0.7,
    substeps: 12,
    plastic: { yieldStrain: 0.08, creep: 0.1, maxStrain: 0.9 },
  },
];

export const ASSEMBLY_PRESETS: AssemblyPreset[] = [
  {
    id: 'layered-block',
    label: 'Layered block',
    description: 'Dense rigid base, elastic gel core, and loose cloth skin with permanent shared-node welds.',
    color: 0xb78cff,
    substeps: 12,
    damping: 0.9,
    friction: 0.65,
  },
];

export const DEFAULT_PRESET_IDS: Record<MatterKind, string> = {
  rigid: 'dense-solid',
  volume: 'gel',
  shell: 'loose-cloth',
  assembly: 'layered-block',
};

export function presetsFor(kind: MatterKind): PresetBase[] {
  if (kind === 'rigid') return RIGID_PRESETS;
  if (kind === 'volume') return VOLUME_PRESETS;
  if (kind === 'shell') return SHELL_PRESETS;
  return ASSEMBLY_PRESETS;
}

export function findPreset<T extends { id: string }>(presets: T[], id: string): T {
  const preset = presets.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Unknown preset "${id}"`);
  return preset;
}
