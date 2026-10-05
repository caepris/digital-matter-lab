import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { findViewportAt, rayFromViewport, toNdc, type ViewportRect } from './InteractionRouter';

const rects: ViewportRect[] = [
  { left: 0, top: 100, width: 300, height: 400 },
  { left: 310, top: 100, width: 300, height: 400 },
  { left: 620, top: 100, width: 300, height: 400 },
];

describe('viewport routing', () => {
  it('finds the panel under the pointer', () => {
    expect(findViewportAt(rects, 10, 150)).toBe(0);
    expect(findViewportAt(rects, 400, 499)).toBe(1);
    expect(findViewportAt(rects, 919, 100)).toBe(2);
  });

  it('ignores gaps, headers, and the far edge of a viewport', () => {
    expect(findViewportAt(rects, 305, 200)).toBe(-1);
    expect(findViewportAt(rects, 100, 50)).toBe(-1);
    expect(findViewportAt(rects, 300, 200)).toBe(-1);
  });

  it('maps viewport corners and center to normalized device coordinates', () => {
    const rect = rects[1];
    expect(toNdc(rect, 310, 100)).toEqual({ x: -1, y: 1 });
    expect(toNdc(rect, 460, 300)).toEqual({ x: 0, y: 0 });
    expect(toNdc(rect, 610, 500)).toEqual({ x: 1, y: -1 });
  });

  it('casts the center ray of a viewport along the camera view direction', () => {
    const camera = new THREE.PerspectiveCamera(40, 300 / 400, 0.1, 100);
    camera.position.set(0, 2, 5);
    camera.lookAt(0, 0, 0);
    const ray = rayFromViewport(camera, rects[2], 770, 300);
    const forward = new THREE.Vector3(0, -2, -5).normalize();
    expect(ray.direction.dot(forward)).toBeCloseTo(1, 5);
    expect(ray.origin.distanceTo(camera.position)).toBeLessThan(0.2);
  });
});
