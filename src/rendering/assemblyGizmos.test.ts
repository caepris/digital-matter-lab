import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { isTrackpadScroll, orbitCamera } from './assemblyGizmos';

describe('trackpad orbit', () => {
  it('tells trackpad scrolls from notched mouse wheels', () => {
    expect(isTrackpadScroll({ deltaMode: 0, deltaX: 3, deltaY: 0 })).toBe(true);
    expect(isTrackpadScroll({ deltaMode: 0, deltaX: 0, deltaY: 4.5 })).toBe(true);
    expect(isTrackpadScroll({ deltaMode: 0, deltaX: 0, deltaY: 12 })).toBe(true);
    expect(isTrackpadScroll({ deltaMode: 0, deltaX: 0, deltaY: 100 })).toBe(false);
    expect(isTrackpadScroll({ deltaMode: 0, deltaX: 0, deltaY: -120 })).toBe(false);
    expect(isTrackpadScroll({ deltaMode: 1, deltaX: 0, deltaY: 3 })).toBe(false);
  });

  it('orbits around the target at a fixed distance and never flips over the poles', () => {
    const camera = new THREE.PerspectiveCamera();
    const target = new THREE.Vector3(0, 0.6, 0);
    camera.position.set(0, 0.6, 4);
    orbitCamera(camera, target, Math.PI / 2, 0);
    expect(camera.position.distanceTo(target)).toBeCloseTo(4, 5);
    expect(camera.position.x).toBeCloseTo(-4, 5);
    expect(camera.position.z).toBeCloseTo(0, 5);

    orbitCamera(camera, target, 0, 10);
    expect(camera.position.distanceTo(target)).toBeCloseTo(4, 5);
    expect(camera.position.y).toBeGreaterThan(target.y + 3.9);
    expect(camera.position.y).toBeLessThan(target.y + 4);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    expect(forward.dot(target.clone().sub(camera.position).normalize())).toBeCloseTo(1, 5);
  });
});
