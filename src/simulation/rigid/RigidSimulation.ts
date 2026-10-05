import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { DEFAULT_PRESET_IDS, findPreset, RIGID_PRESETS, type RigidPreset } from '../../materials/presets';
import { PressState } from '../PressState';
import { pressIsParked } from '../xpbd/collisions';
import {
  CUBE_HALF,
  GRAVITY,
  IMPACTOR_MASS,
  IMPACTOR_RADIUS,
  KILL_PLANE_Y,
  MAX_IMPACTORS,
  PLATFORM_HALF,
  PLATFORM_THICKNESS,
  PRESS_HALF_X,
  PRESS_HALF_Y,
  PRESS_HALF_Z,
  spawnHeight,
} from '../scene';
import type { BodyTopology, MatterSimulation, SimulationFrame, SimulationStats } from '../types';

const GRAB_STIFFNESS = 90;
const GRAB_DAMPING = 14;
const GRAB_MAX_ACCELERATION = 120;
/** Lets the plate bear down slightly so contact force is visible as stillness, not as a gap. */
const PRESS_CONTACT_OVERLAP = 0.003;

interface Impactor {
  body: RAPIER.RigidBody;
  previous: THREE.Vector3;
}

interface Grab {
  localAnchor: THREE.Vector3;
  depth: number;
  target: THREE.Vector3;
}

let rapierReady: Promise<void> | null = null;

export function initRapier(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

export class RigidSimulation implements MatterSimulation {
  readonly kind = 'rigid' as const;
  readonly topology: BodyTopology = { kind: 'rigid', halfExtents: [CUBE_HALF, CUBE_HALF, CUBE_HALF] };
  private preset: RigidPreset;
  private world!: RAPIER.World;
  private cube!: RAPIER.RigidBody;
  private pressBody!: RAPIER.RigidBody;
  private pressCollider!: RAPIER.Collider;
  private impactors: Impactor[] = [];
  private readonly press = new PressState(0);
  private grab: Grab | null = null;

  private readonly previousPosition = new THREE.Vector3();
  private readonly previousQuaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();

  /** Requires `initRapier()` to have resolved. */
  constructor(presetId = DEFAULT_PRESET_IDS.rigid) {
    this.preset = findPreset(RIGID_PRESETS, presetId);
    this.build();
  }

  get presetId(): string {
    return this.preset.id;
  }

  setPreset(id: string): void {
    this.preset = findPreset(RIGID_PRESETS, id);
    this.reset();
  }

  reset(): void {
    this.world.free();
    this.impactors = [];
    this.grab = null;
    this.press.reset();
    this.build();
  }

  dispose(): void {
    this.world.free();
  }

  step(dt: number): void {
    this.previousPosition.copy(this.position);
    this.previousQuaternion.copy(this.quaternion);
    for (const impactor of this.impactors) {
      const t = impactor.body.translation();
      impactor.previous.set(t.x, t.y, t.z);
    }

    this.press.update(dt, this.cubeTopUnderPress() - PRESS_CONTACT_OVERLAP);
    this.pressBody.setNextKinematicTranslation({ x: 0, y: this.press.bottom + PRESS_HALF_Y, z: 0 });
    this.pressCollider.setEnabled(!pressIsParked(this.press.bottom));

    // addForceAtPoint also accumulates a torque, which resetForces leaves in place.
    this.cube.resetForces(true);
    this.cube.resetTorques(true);
    if (this.grab) this.applyGrabForce();

    this.world.timestep = dt;
    this.world.step();

    this.impactors = this.impactors.filter((impactor) => {
      if (impactor.body.translation().y > KILL_PLANE_Y) return true;
      this.world.removeRigidBody(impactor.body);
      return false;
    });
    if (this.cube.translation().y < KILL_PLANE_Y) this.resetCubePose();

    this.capturePose();
  }

  beginGrab(ray: THREE.Ray): boolean {
    const inverse = this.quaternion.clone().invert();
    const localRay = new THREE.Ray(
      ray.origin.clone().sub(this.position).applyQuaternion(inverse),
      ray.direction.clone().applyQuaternion(inverse),
    );
    const box = new THREE.Box3(
      new THREE.Vector3(-CUBE_HALF, -CUBE_HALF, -CUBE_HALF),
      new THREE.Vector3(CUBE_HALF, CUBE_HALF, CUBE_HALF),
    );
    const localHit = localRay.intersectBox(box, new THREE.Vector3());
    if (!localHit) return false;

    const worldHit = localHit.clone().applyQuaternion(this.quaternion).add(this.position);
    this.grab = {
      localAnchor: localHit,
      depth: worldHit.distanceTo(ray.origin),
      target: worldHit,
    };
    this.cube.setAngularDamping(3);
    this.cube.wakeUp();
    return true;
  }

  updateGrab(ray: THREE.Ray): void {
    if (this.grab) ray.at(this.grab.depth, this.grab.target);
  }

  endGrab(): void {
    this.grab = null;
    this.cube.setAngularDamping(0.1);
  }

  dropImpactor(x: number, z: number): void {
    if (this.impactors.length >= MAX_IMPACTORS) {
      const oldest = this.impactors.shift();
      if (oldest) this.world.removeRigidBody(oldest.body);
    }
    const y = spawnHeight(
      x,
      z,
      this.impactors.map(({ body }) => body.translation()),
    );
    const body = this.world.createRigidBody(
      // Damping stands in for rolling resistance, which Rapier lacks; without it balls roll off the platform.
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setCcdEnabled(true)
        .setAngularDamping(2)
        .setLinearDamping(0.3),
    );
    const volume = (4 / 3) * Math.PI * IMPACTOR_RADIUS ** 3;
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(IMPACTOR_RADIUS).setDensity(IMPACTOR_MASS / volume).setRestitution(0.2).setFriction(0.5),
      body,
    );
    this.impactors.push({ body, previous: new THREE.Vector3(x, y, z) });
    this.cube.wakeUp();
  }

  setPressActive(active: boolean): void {
    this.press.active = active;
    this.cube.wakeUp();
  }

  frame(alpha: number): SimulationFrame {
    const position = this.previousPosition.clone().lerp(this.position, alpha);
    const quaternion = this.previousQuaternion.clone().slerp(this.quaternion, alpha);
    return {
      particles: null,
      cubePosition: [position.x, position.y, position.z],
      cubeQuaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      impactors: this.impactors.map(({ body, previous }) => {
        const t = body.translation();
        return {
          x: previous.x + (t.x - previous.x) * alpha,
          y: previous.y + (t.y - previous.y) * alpha,
          z: previous.z + (t.z - previous.z) * alpha,
          radius: IMPACTOR_RADIUS,
        };
      }),
      pressBottom: this.press.interpolated(alpha),
    };
  }

  stats(): SimulationStats {
    return {
      impactorCount: this.impactors.length,
      pressBottom: this.press.bottom,
      pressActive: this.press.active,
      grabbing: this.grab !== null,
      maxDeformation: 0,
      center: [this.position.x, this.position.y, this.position.z],
    };
  }

  private build(): void {
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });

    const platform = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -PLATFORM_THICKNESS / 2, 0),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(PLATFORM_HALF, PLATFORM_THICKNESS / 2, PLATFORM_HALF).setFriction(0.8),
      platform,
    );

    this.cube = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, CUBE_HALF, 0)
        .setLinearDamping(0.05)
        .setAngularDamping(0.1)
        .setCcdEnabled(true),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(CUBE_HALF, CUBE_HALF, CUBE_HALF)
        .setDensity(this.preset.density)
        .setFriction(this.preset.friction)
        .setRestitution(this.preset.restitution),
      this.cube,
    );

    this.pressBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, this.press.bottom + PRESS_HALF_Y, 0),
    );
    this.pressCollider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(PRESS_HALF_X, PRESS_HALF_Y, PRESS_HALF_Z).setFriction(0.6),
      this.pressBody,
    );
    this.pressCollider.setEnabled(false);

    this.capturePose();
    this.previousPosition.copy(this.position);
    this.previousQuaternion.copy(this.quaternion);
  }

  private resetCubePose(): void {
    this.cube.setTranslation({ x: 0, y: CUBE_HALF + 1, z: 0 }, true);
    this.cube.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.cube.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.cube.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  private capturePose(): void {
    const t = this.cube.translation();
    const r = this.cube.rotation();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
  }

  /** Highest cube corner, if the cube overlaps the plate footprint; the plate cannot pass through it. */
  private cubeTopUnderPress(): number {
    let top = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner
        .set(i & 1 ? CUBE_HALF : -CUBE_HALF, i & 2 ? CUBE_HALF : -CUBE_HALF, i & 4 ? CUBE_HALF : -CUBE_HALF)
        .applyQuaternion(this.quaternion)
        .add(this.position);
      top = Math.max(top, corner.y);
      minX = Math.min(minX, corner.x);
      maxX = Math.max(maxX, corner.x);
      minZ = Math.min(minZ, corner.z);
      maxZ = Math.max(maxZ, corner.z);
    }
    const overlaps = maxX > -PRESS_HALF_X && minX < PRESS_HALF_X && maxZ > -PRESS_HALF_Z && minZ < PRESS_HALF_Z;
    return overlaps ? top : -Infinity;
  }

  private applyGrabForce(): void {
    if (!this.grab) return;
    const anchor = this.grab.localAnchor.clone().applyQuaternion(this.quaternion).add(this.position);
    const lever = anchor.clone().sub(this.position);
    const linvel = this.cube.linvel();
    const angvel = this.cube.angvel();
    const pointVelocity = new THREE.Vector3(angvel.x, angvel.y, angvel.z)
      .cross(lever)
      .add(new THREE.Vector3(linvel.x, linvel.y, linvel.z));

    const acceleration = this.grab.target
      .clone()
      .sub(anchor)
      .multiplyScalar(GRAB_STIFFNESS)
      .addScaledVector(pointVelocity, -GRAB_DAMPING);
    acceleration.clampLength(0, GRAB_MAX_ACCELERATION);
    acceleration.y -= GRAVITY;

    const mass = this.cube.mass();
    this.cube.addForceAtPoint(
      { x: acceleration.x * mass, y: acceleration.y * mass, z: acceleration.z * mass },
      { x: anchor.x, y: anchor.y, z: anchor.z },
      true,
    );
  }
}
