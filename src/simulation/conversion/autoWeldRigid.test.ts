import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { placeRigidAccessory, recomputeRigidWelds } from './autoWeldRigid';
import { buildSourceMesh } from './sourceMeshes';

describe('automatic rigid weld placement', () => {
  it('aligns a plate to the clicked source surface and creates bounded weld anchors', () => {
    const source = buildSourceMesh('car-shell');
    const ray = new THREE.Ray(new THREE.Vector3(0, 0.5, 3), new THREE.Vector3(0, 0, -1));
    const part = placeRigidAccessory(ray, source, 'plate', 'rigid-weld-1');
    expect(part).not.toBeNull();
    expect(part?.valid).toBe(true);
    expect(part?.welds.length).toBeGreaterThanOrEqual(2);
    expect(part?.welds.length).toBeLessThanOrEqual(4);
    for (const weld of part?.welds ?? []) {
      expect(weld.sourceAnchor.triangle).toBeGreaterThanOrEqual(0);
      expect(weld.sourceAnchor.triangle).toBeLessThan(source.triangles.length / 3);
      expect(weld.sourceAnchor.barycentric.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 5);
      expect(weld.accessoryAnchor.barycentric.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 5);
    }
  });

  it('marks a transformed accessory detached when it no longer contacts the source', () => {
    const source = buildSourceMesh('car-shell');
    const ray = new THREE.Ray(new THREE.Vector3(0, 0.5, 3), new THREE.Vector3(0, 0, -1));
    const placed = placeRigidAccessory(ray, source, 'button', 'rigid-weld-1');
    expect(placed?.valid).toBe(true);
    const moved = recomputeRigidWelds(
      { ...placed!, position: [placed!.position[0], placed!.position[1] + 1, placed!.position[2]] },
      source,
    );
    expect(moved.valid).toBe(false);
    expect(moved.welds).toHaveLength(0);
  });
});
