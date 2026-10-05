import { describe, expect, it } from 'vitest';
import { createLayeredExampleDocument } from '../../assembly-editor/weldPaint';
import { emptyDocument, addPart, type AssemblyDocument } from '../../assembly-editor/AssemblyDocument';
import { AssemblySimulation } from './AssemblySimulation';
import { compileAssembly } from './compileAssembly';

describe('compileAssembly', () => {
  it('transforms a rotated, scaled cube away from the origin', () => {
    const document: AssemblyDocument = addPart(emptyDocument(), {
      id: 'turned',
      label: 'Turned',
      kind: 'rigid',
      presetId: 'dense-solid',
      position: [1, 0, 0],
      quaternion: [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)],
      uniformScale: 0.5,
    });
    const compiled = compileAssembly(document);
    expect(compiled.parts[0].count).toBeGreaterThan(20);
    const xs = [];
    for (let i = 0; i < compiled.positions.length; i += 3) xs.push(compiled.positions[i]);
    expect(Math.min(...xs)).toBeGreaterThan(0.4);
    expect(Math.max(...xs)).toBeLessThan(1.6);
  });

  it('lets unwelded parts collide and keeps foam plastic after an impact', () => {
    const document = addPart(
      addPart(emptyDocument(), {
        id: 'left',
        label: 'Left',
        kind: 'rigid',
        presetId: 'light-solid',
        position: [-0.4, 0, 0],
        quaternion: [0, 0, 0, 1],
        uniformScale: 0.5,
      }),
      {
        id: 'right',
        label: 'Right',
        kind: 'volume',
        presetId: 'foam',
        position: [0.4, 0, 0],
        quaternion: [0, 0, 0, 1],
        uniformScale: 0.5,
      },
    );
    const simulation = new AssemblySimulation(document);
    const foam = simulation.compiled.parts.find((part) => part.id === 'right');
    if (!foam) throw new Error('missing foam');
    for (let i = foam.offset; i < foam.offset + foam.count; i++) simulation.velocities[i * 3] = -3;
    let closest = Infinity;
    for (let i = 0; i < 30; i++) {
      simulation.step(1 / 60);
      closest = Math.min(closest, centroid(simulation, 'right')[0] - centroid(simulation, 'left')[0]);
    }
    expect(closest).toBeGreaterThan(0.4);
    expect(simulation.maxWeldSeparation()).toBe(0);
    for (const value of simulation.positions) expect(Number.isFinite(value)).toBe(true);

    for (let step = 0; step < 25; step++) {
      for (let i = foam.offset; i < foam.offset + foam.count; i++) {
        if (simulation.positions[i * 3 + 1] > 0.25) simulation.positions[i * 3 + 1] = 0.08;
      }
      simulation.step(1 / 60);
    }
    expect(simulation.maxPlasticDrift()).toBeGreaterThan(0);
  });

  it('keeps weld anchors valid when the sheet is compiled before the solids', () => {
    const layered = createLayeredExampleDocument();
    const simulation = new AssemblySimulation({ ...layered, parts: [...layered.parts].reverse() });
    for (const part of simulation.compiled.parts) {
      for (const index of part.triangles) {
        expect(index).toBeGreaterThanOrEqual(part.offset);
        expect(index).toBeLessThan(part.offset + part.count);
      }
    }
    expect(simulation.maxWeldSeparation()).toBeLessThan(0.001);
  });

  it('compiles the layered example welds under a millimetre at rest', () => {
    const simulation = new AssemblySimulation(createLayeredExampleDocument());
    expect(simulation.maxWeldSeparation()).toBeLessThan(0.001);
    expect(simulation.compiled.parts.map((part) => part.kind)).toEqual(['rigid', 'volume', 'shell']);
  });
});

function centroid(simulation: AssemblySimulation, id: string): [number, number, number] {
  const indices = simulation.partParticles(id);
  let x = 0;
  let y = 0;
  let z = 0;
  for (const index of indices) {
    x += simulation.positions[index * 3];
    y += simulation.positions[index * 3 + 1];
    z += simulation.positions[index * 3 + 2];
  }
  return [x / indices.length, y / indices.length, z / indices.length];
}
