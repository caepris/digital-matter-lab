import './styles.css';
import { DigitalMatterLab } from './app/DigitalMatterLab';
import { findPreset, presetsFor } from './materials/presets';
import { ParticleBodyVisual } from './rendering/ParticleBodyVisual';
import { RigidVisual } from './rendering/RigidVisual';
import { initRapier, RigidSimulation } from './simulation/rigid/RigidSimulation';
import { ShellSimulation } from './simulation/shell/ShellSimulation';
import type { MatterSimulation } from './simulation/types';
import { VolumeSimulation } from './simulation/volume/VolumeSimulation';

function presetColor(simulation: MatterSimulation): number {
  return findPreset(presetsFor(simulation.kind), simulation.presetId).color;
}

function particleVisual(simulation: MatterSimulation, thinShell: boolean, pointSize: number) {
  if (simulation.topology.kind !== 'particles') throw new Error('Expected a particle body');
  return new ParticleBodyVisual(simulation.topology, { color: presetColor(simulation), thinShell, pointSize });
}

async function start(): Promise<void> {
  await initRapier();
  const root = document.getElementById('app');
  if (!root) throw new Error('Missing #app element');

  new DigitalMatterLab(root, [
    {
      kind: 'rigid',
      title: 'Rigid volume',
      subtitle: 'A solid body. Impacts and forces move it, but its shape never changes.',
      accent: 0x7f9cff,
      simulation: new RigidSimulation(),
      createVisual: (simulation) => {
        if (simulation.topology.kind !== 'rigid') throw new Error('Expected a rigid body');
        return new RigidVisual(simulation.topology.halfExtents, presetColor(simulation));
      },
    },
    {
      kind: 'volume',
      title: 'Deformable volume',
      subtitle: 'Filled with tetrahedra, so the whole interior squashes, bulges, and wobbles.',
      accent: 0xf0a060,
      simulation: new VolumeSimulation(),
      createVisual: (simulation) => particleVisual(simulation, false, 0.035),
    },
    {
      kind: 'shell',
      title: 'Thin deformable shell',
      subtitle: 'Only a surface with thickness, no inside. It bends, folds, and collapses like a sheet.',
      accent: 0x5cc4a8,
      simulation: new ShellSimulation(),
      createVisual: (simulation) => particleVisual(simulation, true, 0.03),
    },
  ]);
}

start().catch((error: unknown) => {
  console.error(error);
  document.body.textContent = `Failed to start Digital Matter Lab: ${String(error)}`;
});
