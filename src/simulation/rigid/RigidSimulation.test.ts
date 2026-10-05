import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { CUBE_HALF, IMPACTOR_RADIUS, PRESS_REST_BOTTOM } from '../scene';
import { initRapier, RigidSimulation } from './RigidSimulation';

const DT = 1 / 60;

function run(simulation: RigidSimulation, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) simulation.step(DT);
}

describe('RigidSimulation', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('rests on the platform without deforming', () => {
    const simulation = new RigidSimulation();
    run(simulation, 1);
    const stats = simulation.stats();
    expect(stats.center[1]).toBeCloseTo(CUBE_HALF, 1);
    expect(stats.maxDeformation).toBe(0);
    simulation.dispose();
  });

  it('takes an impact without changing shape and catches the ball on its top face', () => {
    const simulation = new RigidSimulation();
    simulation.dropImpactor(0, 0);
    run(simulation, 2);
    expect(simulation.stats().impactorCount).toBe(1);
    const ball = simulation.frame(1).impactors[0];
    expect(ball.y).toBeCloseTo(CUBE_HALF * 2 + IMPACTOR_RADIUS, 1);
    expect(simulation.stats().maxDeformation).toBe(0);
    simulation.dispose();
  });

  it('lets drops pass through the parked press', () => {
    const simulation = new RigidSimulation();
    simulation.dropImpactor(0.9, 0.9);
    run(simulation, 2);
    expect(simulation.frame(1).impactors[0].y).toBeLessThan(PRESS_REST_BOTTOM);
    simulation.dispose();
  });

  it('stops the press on the cube top instead of crushing it', () => {
    const simulation = new RigidSimulation();
    simulation.setPressActive(true);
    run(simulation, 4);
    const stats = simulation.stats();
    expect(stats.pressBottom).toBeGreaterThan(CUBE_HALF * 2 - 0.05);
    expect(stats.pressBottom).toBeLessThan(PRESS_REST_BOTTOM);
    expect(stats.center[1]).toBeCloseTo(CUBE_HALF, 1);
    simulation.dispose();
  });

  it('lifts the cube when grabbed and dragged upward', () => {
    const simulation = new RigidSimulation();
    run(simulation, 0.2);
    const origin = new THREE.Vector3(0, CUBE_HALF, 4);
    const ray = new THREE.Ray(origin, new THREE.Vector3(0, 0, -1));
    expect(simulation.beginGrab(ray)).toBe(true);
    simulation.updateGrab(new THREE.Ray(origin.clone().setY(1.5), new THREE.Vector3(0, 0, -1)));
    run(simulation, 1.5);
    // The cube hangs from its front-face anchor, so its center sits roughly half a cube below the target.
    expect(simulation.stats().center[1]).toBeGreaterThan(0.9);
    simulation.endGrab();
    simulation.dispose();
  });

  it('comes to rest after an off-center fling is released', () => {
    const simulation = new RigidSimulation('light-solid');
    run(simulation, 0.2);
    const origin = new THREE.Vector3(0.25, CUBE_HALF * 1.6, 4);
    const direction = new THREE.Vector3(0, 0, -1);
    expect(simulation.beginGrab(new THREE.Ray(origin, direction))).toBe(true);
    for (let i = 0; i < 30; i++) {
      simulation.updateGrab(new THREE.Ray(origin.clone().add(new THREE.Vector3(i * 0.04, i * 0.02, 0)), direction));
      simulation.step(DT);
    }
    simulation.endGrab();
    run(simulation, 6);
    const settled = new THREE.Vector3(...simulation.stats().center);
    run(simulation, 2);
    expect(new THREE.Vector3(...simulation.stats().center).distanceTo(settled)).toBeLessThan(0.01);
    expect(simulation.stats().center[1]).toBeCloseTo(CUBE_HALF, 1);
    simulation.dispose();
  });

  it('reset clears impactors and restores the cube', () => {
    const simulation = new RigidSimulation();
    simulation.dropImpactor(0.3, 0.3);
    run(simulation, 0.5);
    simulation.reset();
    const stats = simulation.stats();
    expect(stats.impactorCount).toBe(0);
    expect(stats.center).toEqual([0, CUBE_HALF, 0]);
    expect(stats.pressBottom).toBe(PRESS_REST_BOTTOM);
    simulation.dispose();
  });
});
