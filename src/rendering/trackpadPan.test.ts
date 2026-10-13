import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { panCamera } from './trackpadPan';

function view(): { camera: THREE.PerspectiveCamera; target: THREE.Vector3 } {
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
  camera.position.set(0, 1, 3);
  const target = new THREE.Vector3(0, 1, 0);
  camera.lookAt(target);
  return { camera, target };
}

describe('trackpad pan', () => {
  it('moves camera and target together so the view direction is kept', () => {
    const { camera, target } = view();
    const before = camera.position.clone().sub(target);
    panCamera(camera, target, -100, 0, 500);
    expect(camera.position.clone().sub(target).distanceTo(before)).toBeCloseTo(0, 6);
    // Dragging the scene left moves the camera right.
    expect(target.x).toBeGreaterThan(0);
  });

  it('follows the pointer vertically and clamps to the bounds', () => {
    const { camera, target } = view();
    panCamera(camera, target, 0, 100, 500);
    expect(target.y).toBeGreaterThan(1);
    const bounds = { min: new THREE.Vector3(-1, 0, -1), max: new THREE.Vector3(1, 1.2, 1) };
    for (let step = 0; step < 50; step += 1) panCamera(camera, target, 0, 200, 500, bounds);
    expect(target.y).toBeCloseTo(1.2, 6);
  });
});
