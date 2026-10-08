import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { convertSurface } from './convertSurface';
import { buildSourceMesh, particleMaterials, pinnedParticles, SOURCE_MESH_IDS } from './sourceMeshes';
import { bendingComplianceForThickness, ConvertedShellSimulation } from './ConvertedShellSimulation';
import { placeRigidAccessory } from './autoWeldRigid';
import { rigidAccessory } from './rigidAccessories';

const surface = {
  positions: new Float32Array([-0.5, 1, -0.5, 0.5, 1, -0.5, -0.5, 1, 0.5, 0.5, 1, 0.5]),
  triangles: new Uint32Array([0, 1, 2, 2, 1, 3]),
  stretchPairs: new Uint32Array([0, 1, 0, 2, 1, 2, 1, 3, 2, 3]),
  bendPairs: new Uint32Array([0, 3]),
};

describe('ConvertedShellSimulation', () => {
  it('simulates an arbitrary indexed surface with configurable thickness', () => {
    const simulation = new ConvertedShellSimulation({
      mesh: surface,
      thickness: 0.04,
      presetId: 'structured-fabric',
    });
    const startY = simulation.stats().center[1];
    for (let i = 0; i < 60; i++) simulation.step(1 / 60);
    expect(simulation.thickness).toBe(0.04);
    expect(simulation.stats().center[1]).toBeLessThan(startY);
    expect(Array.from(simulation.frame(1).particles ?? [])).toSatisfy((values: number[]) =>
      values.every(Number.isFinite),
    );
  });

  it('clamps unsafe near-zero thickness', () => {
    const simulation = new ConvertedShellSimulation({ mesh: surface, thickness: 0 });
    expect(simulation.thickness).toBe(0.002);
  });

  it('makes a thicker shell harder to bend', () => {
    const thin = bendingComplianceForThickness(0.01, 0.01);
    const thick = bendingComplianceForThickness(0.01, 0.04);
    expect(thick).toBeLessThan(thin);
    expect(thin / thick).toBeCloseTo(64, 5);
  });

  it('keeps every built-in converted mesh finite while it settles', () => {
    for (const id of SOURCE_MESH_IDS) {
      const source = buildSourceMesh(id);
      const converted = convertSurface({
        positions: source.positions,
        triangles: source.triangles,
        targetSpacing: 0.13,
      });
      const simulation = new ConvertedShellSimulation({
        mesh: converted,
        thickness: source.defaultThickness,
        presetId: id === 'car-shell' ? 'sheet-metal' : 'loose-cloth',
        structural: id === 'car-shell',
        pinned: pinnedParticles(source, converted.positions),
      });
      for (let i = 0; i < 90; i++) simulation.step(1 / 60);
      expect(Array.from(simulation.frame(1).particles ?? []).every(Number.isFinite), id).toBe(true);
      expect(simulation.stats().center.every(Number.isFinite), id).toBe(true);
    }
  }, 30_000);

  it('hangs a garment from its pinned particles while the rest drapes', () => {
    const source = buildSourceMesh('tshirt');
    const converted = convertSurface({ positions: source.positions, triangles: source.triangles, targetSpacing: 0.1 });
    const pinned = pinnedParticles(source, converted.positions);
    expect(pinned.length).toBeGreaterThan(4);
    const simulation = new ConvertedShellSimulation({
      mesh: converted,
      thickness: source.defaultThickness,
      presetId: 'loose-cloth',
      pinned,
    });
    const start = simulation.positions.slice();
    for (let i = 0; i < 120; i++) simulation.step(1 / 60);
    for (const index of pinned) {
      for (let axis = 0; axis < 3; axis++) {
        expect(simulation.positions[index * 3 + axis]).toBe(start[index * 3 + axis]);
      }
    }
    let lowest = Infinity;
    for (let i = 1; i < simulation.positions.length; i += 3) lowest = Math.min(lowest, simulation.positions[i]);
    expect(lowest).toBeGreaterThan(0.05);
    expect(simulation.stats().maxDeformation).toBeGreaterThan(0.02);
  });

  it('changes thickness mid-simulation without resetting, and thick cloth deforms less', () => {
    const source = buildSourceMesh('tshirt');
    const converted = convertSurface({ positions: source.positions, triangles: source.triangles, targetSpacing: 0.1 });
    const pinned = pinnedParticles(source, converted.positions);
    const create = () =>
      new ConvertedShellSimulation({ mesh: converted, thickness: 0.006, presetId: 'loose-cloth', totalMass: 0.3, pinned });
    const thin = create();
    const thick = create();
    for (let i = 0; i < 20; i++) {
      thin.step(1 / 60);
      thick.step(1 / 60);
    }
    const before = thick.positions.slice();
    const deformationBefore = thick.stats().maxDeformation;
    expect(deformationBefore).toBeGreaterThan(0);

    thick.setThickness(0.08);
    expect(thick.thickness).toBe(0.08);
    expect(Array.from(thick.positions)).toEqual(Array.from(before));
    expect(thick.stats().maxDeformation).toBe(deformationBefore);

    for (let i = 0; i < 120; i++) {
      thin.step(1 / 60);
      thick.step(1 / 60);
    }
    expect(thick.positions.every(Number.isFinite)).toBe(true);
    expect(thick.stats().maxDeformation).toBeLessThan(thin.stats().maxDeformation);
  });

  it('keeps a structural sheet-metal body far stiffer than cloth', () => {
    const source = buildSourceMesh('car-shell');
    const converted = convertSurface({ positions: source.positions, triangles: source.triangles, targetSpacing: 0.14 });
    const settle = (presetId: string, structural: boolean) => {
      const simulation = new ConvertedShellSimulation({
        mesh: converted,
        thickness: source.defaultThickness,
        presetId,
        structural,
        totalMass: 2.4,
      });
      for (let i = 0; i < 90; i++) simulation.step(1 / 60);
      return simulation.stats().maxDeformation;
    };
    const metal = settle('sheet-metal', true);
    const cloth = settle('loose-cloth', false);
    expect(metal).toBeLessThan(0.03);
    expect(metal).toBeLessThan(cloth * 0.25);
  });

  it('lets the cotton hoodie flex more than the denim on the same jacket mesh', () => {
    const source = buildSourceMesh('denim-jacket');
    const converted = convertSurface({
      positions: source.positions,
      triangles: source.triangles,
      targetSpacing: 0.075,
    });
    const ids = particleMaterials(source, converted.positions.length / 3, converted.triangles, converted.sourceBindings);
    expect(ids.includes(0)).toBe(true);
    expect(ids.includes(1)).toBe(true);
    const simulation = new ConvertedShellSimulation({
      mesh: converted,
      thickness: source.defaultThickness,
      presetId: 'structured-fabric',
      totalMass: 0.8,
      pinned: pinnedParticles(source, converted.positions, ids),
      regions: { materials: source.materials, particleMaterials: ids },
    });
    expect(simulation.pinned.length).toBeGreaterThan(8);
    expect(simulation.pinned.every((index) => ids[index] === 0)).toBe(true);
    expect(simulation.pinned.every((index) => Math.abs(converted.positions[index * 3 + 2]) < 0.07)).toBe(true);

    const seamCompression = simulation.stretch.compressionCompliance;
    expect(seamCompression).not.toBeNull();
    let seamCount = 0;
    for (let edge = 0; edge < simulation.stretch.count; edge++) {
      const a = simulation.stretch.a[edge];
      const b = simulation.stretch.b[edge];
      if (ids[a] === ids[b]) continue;
      seamCount++;
      expect(seamCompression![edge]).toBeLessThanOrEqual(source.materials[0].compressionCompliance);
    }
    expect(seamCount).toBeGreaterThan(4);
    const bendStrain = (material: number) => {
      let sum = 0;
      let count = 0;
      const { a, b, rest } = simulation.bend;
      const positions = simulation.positions;
      for (let c = 0; c < simulation.bend.count; c++) {
        if (ids[a[c]] !== material || ids[b[c]] !== material) continue;
        const i = a[c] * 3;
        const j = b[c] * 3;
        const current = Math.hypot(positions[i] - positions[j], positions[i + 1] - positions[j + 1], positions[i + 2] - positions[j + 2]);
        sum += Math.abs(current - rest[c]) / Math.max(rest[c], 1e-6);
        count++;
      }
      return { mean: sum / count, count };
    };
    for (let step = 0; step < 150; step++) simulation.step(1 / 60);
    const cotton = bendStrain(1);
    const denim = bendStrain(0);
    expect(cotton.count).toBeGreaterThan(8);
    expect(denim.count).toBeGreaterThan(8);
    expect(cotton.mean).toBeGreaterThan(denim.mean * 2);

    let maxSpeed = 0;
    const velocities = simulation.velocities;
    for (let i = 0; i < velocities.length; i += 3) {
      maxSpeed = Math.max(maxSpeed, Math.hypot(velocities[i], velocities[i + 1], velocities[i + 2]));
    }
    expect(maxSpeed).toBeLessThan(2);
    const center = simulation.stats().center;
    expect(Math.hypot(center[0], center[2])).toBeLessThan(1.2);
  }, 30_000);

  describe('grabbing the car body', () => {
    const camera = new THREE.Vector3(3, 2.2, 3.5);
    const createCar = () => {
      const source = buildSourceMesh('car-shell');
      const converted = convertSurface({ positions: source.positions, triangles: source.triangles, targetSpacing: 0.1 });
      const simulation = new ConvertedShellSimulation({
        mesh: converted,
        thickness: source.defaultThickness,
        presetId: 'sheet-metal',
        structural: true,
        totalMass: 2.4,
      });
      for (let i = 0; i < 60; i++) simulation.step(1 / 60);
      return simulation;
    };
    const rayTo = (point: THREE.Vector3) => new THREE.Ray(camera, point.clone().sub(camera).normalize());
    const maxSpeed = (simulation: ConvertedShellSimulation) => {
      let max = 0;
      const v = simulation.velocities;
      for (let i = 0; i < v.length; i += 3) max = Math.max(max, Math.hypot(v[i], v[i + 1], v[i + 2]));
      return max;
    };

    it('does not jolt the body when grabbed without moving the pointer', () => {
      const simulation = createCar();
      const roof = new THREE.Vector3(0.3, 0.6, 0.3);
      expect(simulation.beginGrab(rayTo(roof))).toBe(true);
      simulation.updateGrab(rayTo(roof));
      simulation.step(1 / 60);
      expect(maxSpeed(simulation)).toBeLessThan(0.5);
    });

    it('comes to rest after being flicked and crushed instead of spinning up', () => {
      const simulation = createCar();
      const roof = new THREE.Vector3(0.6, 0.55, 0.2);
      simulation.beginGrab(rayTo(roof));
      for (let f = 0; f < 30; f++) {
        simulation.updateGrab(rayTo(roof.clone().add(new THREE.Vector3(f % 2 ? -1.2 : 1.2, 0.8, 0))));
        simulation.step(1 / 60);
      }
      for (let f = 0; f < 180; f++) {
        const t = f / 60;
        const target = roof.clone().add(new THREE.Vector3(-1.5 * Math.min(1, t / 2), -0.5, Math.sin(t * 4) * 0.6));
        simulation.updateGrab(rayTo(target));
        simulation.step(1 / 60);
      }
      simulation.endGrab();
      for (let f = 0; f < 240; f++) simulation.step(1 / 60);

      expect(maxSpeed(simulation)).toBeLessThan(1);
      const center = simulation.stats().center;
      expect(center[1]).toBeLessThan(0.6);
      expect(Math.hypot(center[0], center[2])).toBeLessThan(2);
    }, 30_000);
  });

  it('keeps an auto-welded rigid plate rigid and attached to the converted shell', () => {
    const source = buildSourceMesh('car-shell');
    const converted = convertSurface({
      positions: source.positions,
      triangles: source.triangles,
      targetSpacing: 0.1,
    });
    const part = placeRigidAccessory(
      new THREE.Ray(new THREE.Vector3(0, 0.5, 3), new THREE.Vector3(0, 0, -1)),
      source,
      'plate',
      'rigid-weld-1',
    );
    expect(part?.valid).toBe(true);
    const simulation = new ConvertedShellSimulation({
      mesh: converted,
      thickness: source.defaultThickness,
      presetId: 'sheet-metal',
      totalMass: 2.4,
      structural: true,
      rigidWelds: { source, parts: [part!] },
    });
    expect(simulation.count).toBe(converted.positions.length / 3 + rigidAccessory('plate').positions.length / 3);
    expect(simulation.weldCount).toBe(part!.welds.length);
    for (let frame = 0; frame < 120; frame++) simulation.step(1 / 60);
    expect(simulation.maxWeldSeparation()).toBeLessThan(0.015);
    expect(simulation.maxRigidShapeError()).toBeLessThan(0.01);
    expect(simulation.positions.every(Number.isFinite)).toBe(true);
    simulation.reset();
    expect(simulation.maxWeldSeparation()).toBeLessThan(0.005);
  }, 30_000);
});
