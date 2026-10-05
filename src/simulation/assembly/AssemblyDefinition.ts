import type { MatterKind } from '../types';

export interface AssemblyPartDefinition {
  id: string;
  label: string;
  materialKind: Exclude<MatterKind, 'assembly'>;
  color: number;
  dimensions: [number, number, number];
  origin: [number, number, number];
  grid: [number, number, number];
  mass: number;
}

export interface AssemblyWeldDefinition {
  id: string;
  label: string;
  partA: string;
  partB: string;
  color: number;
}

export interface AssemblyDefinition {
  id: string;
  label: string;
  description: string;
  spacing: number;
  parts: AssemblyPartDefinition[];
  welds: AssemblyWeldDefinition[];
}

export const LAYERED_BLOCK_DEFINITION: AssemblyDefinition = {
  id: 'layered-block',
  label: 'Layered block',
  description: 'A rigid base, elastic gel core, and thin cloth skin joined by permanent no-slip welds.',
  spacing: 0.15,
  parts: [
    {
      id: 'rigid-base',
      label: 'Rigid base',
      materialKind: 'rigid',
      color: 0x7f9cff,
      dimensions: [1.2, 0.3, 1.2],
      origin: [-0.6, 0, -0.6],
      grid: [8, 2, 8],
      mass: 3.6,
    },
    {
      id: 'gel-core',
      label: 'Gel core',
      materialKind: 'volume',
      color: 0xf0a060,
      dimensions: [0.9, 0.6, 0.9],
      origin: [-0.45, 0.3, -0.45],
      grid: [6, 4, 6],
      mass: 0.8,
    },
    {
      id: 'cloth-skin',
      label: 'Cloth skin',
      materialKind: 'shell',
      color: 0x5cc4a8,
      dimensions: [1.2, 0, 1.2],
      origin: [-0.6, 0.9, -0.6],
      grid: [8, 0, 8],
      mass: 0.15,
    },
  ],
  welds: [
    {
      id: 'base-core-weld',
      label: 'Rigid ↔ gel weld',
      partA: 'rigid-base',
      partB: 'gel-core',
      color: 0xff5f8f,
    },
    {
      id: 'core-cloth-weld',
      label: 'Gel ↔ cloth weld',
      partA: 'gel-core',
      partB: 'cloth-skin',
      color: 0x48e0ff,
    },
  ],
};
