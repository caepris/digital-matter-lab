import * as THREE from 'three';

/**
 * Position-based rigid shape matching. All listed particles remain in one best-fit rigid
 * transform, while their finite masses still let contacts and welded deformables move the body.
 */
export class ShapeMatchingConstraint {
  readonly indices: Uint32Array;
  private readonly restLocal: Float64Array;
  private readonly weights: Float64Array;
  private readonly totalWeight: number;
  private readonly covariance = new THREE.Matrix3();
  private readonly rotationMatrix = new THREE.Matrix4();

  constructor(indices: Uint32Array, restPositions: Float32Array, masses?: Float32Array) {
    this.indices = indices;
    this.restLocal = new Float64Array(indices.length * 3);
    this.weights = new Float64Array(indices.length);
    let totalWeight = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < indices.length; k++) {
      const index = indices[k];
      const weight = masses?.[index] ?? 1;
      this.weights[k] = weight;
      totalWeight += weight;
      cx += restPositions[index * 3] * weight;
      cy += restPositions[index * 3 + 1] * weight;
      cz += restPositions[index * 3 + 2] * weight;
    }
    this.totalWeight = totalWeight;
    cx /= totalWeight;
    cy /= totalWeight;
    cz /= totalWeight;
    for (let k = 0; k < indices.length; k++) {
      const index = indices[k];
      this.restLocal[k * 3] = restPositions[index * 3] - cx;
      this.restLocal[k * 3 + 1] = restPositions[index * 3 + 1] - cy;
      this.restLocal[k * 3 + 2] = restPositions[index * 3 + 2] - cz;
    }
  }

  solve(positions: Float32Array, stiffness = 1): void {
    const center = this.currentCenter(positions);
    const ae = this.covariance.elements;
    ae.fill(0);
    for (let k = 0; k < this.indices.length; k++) {
      const p = this.indices[k] * 3;
      const weight = this.weights[k];
      const px = positions[p] - center[0];
      const py = positions[p + 1] - center[1];
      const pz = positions[p + 2] - center[2];
      const qx = this.restLocal[k * 3];
      const qy = this.restLocal[k * 3 + 1];
      const qz = this.restLocal[k * 3 + 2];
      ae[0] += weight * px * qx;
      ae[1] += weight * py * qx;
      ae[2] += weight * pz * qx;
      ae[3] += weight * px * qy;
      ae[4] += weight * py * qy;
      ae[5] += weight * pz * qy;
      ae[6] += weight * px * qz;
      ae[7] += weight * py * qz;
      ae[8] += weight * pz * qz;
    }
    const rotation = extractRotation(this.covariance);
    const m = this.rotationMatrix.makeRotationFromQuaternion(rotation).elements;
    for (let k = 0; k < this.indices.length; k++) {
      const p = this.indices[k] * 3;
      const qx = this.restLocal[k * 3];
      const qy = this.restLocal[k * 3 + 1];
      const qz = this.restLocal[k * 3 + 2];
      const tx = center[0] + m[0] * qx + m[4] * qy + m[8] * qz;
      const ty = center[1] + m[1] * qx + m[5] * qy + m[9] * qz;
      const tz = center[2] + m[2] * qx + m[6] * qy + m[10] * qz;
      positions[p] += (tx - positions[p]) * stiffness;
      positions[p + 1] += (ty - positions[p + 1]) * stiffness;
      positions[p + 2] += (tz - positions[p + 2]) * stiffness;
    }
  }

  maxError(positions: Float32Array): number {
    const copy = positions.slice();
    this.solve(copy);
    let max = 0;
    for (const index of this.indices) {
      const p = index * 3;
      max = Math.max(
        max,
        Math.hypot(copy[p] - positions[p], copy[p + 1] - positions[p + 1], copy[p + 2] - positions[p + 2]),
      );
    }
    return max;
  }

  private currentCenter(positions: Float32Array): [number, number, number] {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < this.indices.length; k++) {
      const p = this.indices[k] * 3;
      const weight = this.weights[k];
      x += positions[p] * weight;
      y += positions[p + 1] * weight;
      z += positions[p + 2] * weight;
    }
    return [x / this.totalWeight, y / this.totalWeight, z / this.totalWeight];
  }
}

/** Rotation part of a covariance matrix by quaternion iteration. */
export function extractRotation(covariance: THREE.Matrix3, iterations = 30): THREE.Quaternion {
  const q = new THREE.Quaternion();
  const ae = covariance.elements;
  const r = new THREE.Matrix4();
  const axis = new THREE.Vector3();
  const step = new THREE.Quaternion();
  for (let iter = 0; iter < iterations; iter++) {
    const re = r.makeRotationFromQuaternion(q).elements;
    let ox = 0;
    let oy = 0;
    let oz = 0;
    let dot = 0;
    for (let col = 0; col < 3; col++) {
      const rx = re[col * 4];
      const ry = re[col * 4 + 1];
      const rz = re[col * 4 + 2];
      const ax = ae[col * 3];
      const ay = ae[col * 3 + 1];
      const az = ae[col * 3 + 2];
      ox += ry * az - rz * ay;
      oy += rz * ax - rx * az;
      oz += rx * ay - ry * ax;
      dot += rx * ax + ry * ay + rz * az;
    }
    const scale = 1 / (Math.abs(dot) + 1e-9);
    axis.set(ox * scale, oy * scale, oz * scale);
    const angle = axis.length();
    if (angle < 1e-9) break;
    step.setFromAxisAngle(axis.divideScalar(angle), angle);
    q.premultiply(step).normalize();
  }
  return q;
}
