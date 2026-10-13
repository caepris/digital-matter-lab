import { SHELL_PRESETS, type ShellPreset } from '../materials/presets';
import type { WindSettings } from '../simulation/xpbd/aerodynamics';
import type { CapsuleCollider } from '../simulation/xpbd/capsuleColliders';
import { surfaceBounds, type WorkflowAssetId } from './workflowAssets';
import { vertexComponents } from './surfaceTopology';
import type { WorkflowPath } from './workflowTypes';

/** Simulation tuning for one example. Bend compliance is per radian of dihedral angle. */
export interface WorkflowPhysics {
  preset: ShellPreset;
  bending: 'distance' | 'dihedral';
  /** Stiff second-ring links so stamped panels resist shear. */
  structural: boolean;
  totalMass: number;
  /** Wind slider value when the example is selected, in m/s. */
  defaultWind: number;
  /** Unit direction of the wind; the wind slider sets its speed. */
  windDirection: readonly [number, number, number];
  normalDrag: number;
  tangentialDrag: number;
  inflation: number;
  gust: number;
}

/**
 * Fabric buckles into wrinkles finer than the simulation mesh almost for free, so
 * compression is very soft. Without that, a closed mesh (Path 1 with no caps marked)
 * cannot lose volume and holds its shape like a balloon instead of collapsing like a bag.
 */
function cloth(
  id: string,
  label: string,
  values: Pick<ShellPreset, 'compressionCompliance' | 'bendCompliance' | 'damping' | 'friction'>,
): ShellPreset {
  return {
    id,
    label,
    description: `${label} tuned for the creator workflow examples.`,
    color: 0x5cc4a8,
    stretchCompliance: 0,
    substeps: 10,
    plastic: null,
    ...values,
  };
}

const SIDE_WIND = [0.94, 0, 0.34] as const;

const sheetMetal = SHELL_PRESETS.find((preset) => preset.id === 'sheet-metal')!;

const PHYSICS: Record<WorkflowAssetId, WorkflowPhysics> = {
  tshirt: {
    preset: cloth('workflow-jersey', 'Cotton jersey', {
      compressionCompliance: 10,
      bendCompliance: 150,
      damping: 0.8,
      friction: 0.5,
    }),
    bending: 'dihedral',
    structural: false,
    totalMass: 0.55,
    defaultWind: 2.5,
    windDirection: SIDE_WIND,
    normalDrag: 0.36,
    tangentialDrag: 0.05,
    inflation: 0,
    gust: 0.6,
  },
  'ruffled-skirt': {
    preset: cloth('workflow-chiffon', 'Chiffon', {
      compressionCompliance: 10,
      bendCompliance: 250,
      damping: 0.6,
      friction: 0.45,
    }),
    bending: 'dihedral',
    structural: false,
    totalMass: 0.4,
    defaultWind: 2.5,
    windDirection: SIDE_WIND,
    normalDrag: 0.4,
    tangentialDrag: 0.05,
    inflation: 0,
    gust: 0.6,
  },
  'puffer-jacket': {
    preset: cloth('workflow-quilted', 'Quilted nylon', {
      compressionCompliance: 1,
      bendCompliance: 15,
      damping: 2,
      friction: 0.6,
    }),
    bending: 'dihedral',
    structural: false,
    totalMass: 1.1,
    defaultWind: 2.5,
    windDirection: SIDE_WIND,
    normalDrag: 0.3,
    tangentialDrag: 0.05,
    inflation: 0,
    gust: 0.5,
  },
  'hooded-jacket': {
    preset: cloth('workflow-denim', 'Denim', {
      compressionCompliance: 5,
      bendCompliance: 150,
      damping: 1.2,
      friction: 0.6,
    }),
    bending: 'dihedral',
    structural: false,
    totalMass: 0.9,
    defaultWind: 2.5,
    windDirection: SIDE_WIND,
    normalDrag: 0.36,
    tangentialDrag: 0.05,
    inflation: 0,
    gust: 0.5,
  },
  'fish-flag': {
    preset: cloth('workflow-nylon', 'Ripstop nylon', {
      compressionCompliance: 8,
      bendCompliance: 100,
      damping: 0.3,
      friction: 0.4,
    }),
    bending: 'dihedral',
    structural: false,
    totalMass: 0.2,
    defaultWind: 6,
    windDirection: [0.99, 0.05, 0.12],
    normalDrag: 0.6,
    tangentialDrag: 0.25,
    inflation: 0.6,
    gust: 0.5,
  },
  'sheet-metal': {
    preset: { ...sheetMetal, id: 'workflow-sheet-metal', bendCompliance: 6e-4 },
    bending: 'distance',
    structural: true,
    totalMass: 1.8,
    defaultWind: 2.5,
    windDirection: SIDE_WIND,
    normalDrag: 0.6,
    tangentialDrag: 0,
    inflation: 0,
    gust: 0.4,
  },
};

export function workflowPhysics(assetId: WorkflowAssetId): WorkflowPhysics {
  return PHYSICS[assetId];
}

/**
 * Wind for the slider speed. Air only inflates a windsock whose mouth is open: always
 * in Path 3, in Path 1 only once the mouth is marked as an end cap, never on a flat plane.
 */
export function workflowWind(
  assetId: WorkflowAssetId,
  path: WorkflowPath,
  speed: number,
  endCaps: readonly number[] = [],
): WindSettings {
  const physics = PHYSICS[assetId];
  const mouthOpen = path === 'thicken' || (path === 'shell' && endCaps.includes(1));
  const [x, y, z] = physics.windDirection;
  return {
    velocity: [x * speed, y * speed, z * speed],
    normalDrag: physics.normalDrag,
    tangentialDrag: physics.tangentialDrag,
    inflation: mouthOpen ? physics.inflation : 0,
    gust: physics.gust,
  };
}

function capsule(a: [number, number, number], b: [number, number, number], radius: number): CapsuleCollider {
  return { a, b, radius };
}

const UPPER_BODY: readonly CapsuleCollider[] = [
  capsule([-0.17, 0.5, 0], [-0.17, 1.08, 0], 0.15),
  capsule([0.17, 0.5, 0], [0.17, 1.08, 0], 0.15),
  capsule([-0.28, 1.16, 0], [0.28, 1.16, 0], 0.1),
  capsule([-0.6, 1.13, 0], [-0.82, 1.1, 0], 0.075),
  capsule([0.6, 1.13, 0], [0.82, 1.1, 0], 0.075),
  capsule([0, 1.2, 0], [0, 1.42, 0], 0.065),
];

const COLLIDERS: Record<WorkflowAssetId, readonly CapsuleCollider[]> = {
  tshirt: UPPER_BODY,
  'puffer-jacket': UPPER_BODY,
  'hooded-jacket': [...UPPER_BODY, capsule([0, 1.56, -0.12], [0, 1.56, -0.12], 0.12)],
  'ruffled-skirt': [
    capsule([-0.1, 1.12, 0], [0.1, 1.12, 0], 0.22),
    capsule([-0.12, 1.0, 0], [-0.13, 0.3, 0], 0.085),
    capsule([0.12, 1.0, 0], [0.13, 0.3, 0], 0.085),
  ],
  'fish-flag': [capsule([-0.95, 0, -0.24], [-0.95, 1.7, -0.24], 0.02)],
  'sheet-metal': [],
};

/**
 * Bodies the cloth drapes over: a mannequin for garments, hips and legs for the
 * skirt, and the windsock's pole. Path 2's plane runs through the body, so it
 * has none.
 */
export function workflowColliders(assetId: WorkflowAssetId, path: WorkflowPath): readonly CapsuleCollider[] {
  return path === 'plane' ? [] : COLLIDERS[assetId];
}

const GARMENTS: readonly WorkflowAssetId[] = ['tshirt', 'puffer-jacket', 'hooded-jacket'];
const SEAM_RADIUS = 0.1;

export interface WorkflowAttachments {
  pinned: number[];
  /** Vertex pairs sewn together with distance constraints, e.g. a sleeve to the torso. */
  seams: Uint32Array;
}

/**
 * Pins where the item is held (a garment's neckline, the skirt's waistband, the
 * windsock's mouth hoop, the panel's top edge, or Path 2's top band) and sews
 * every other component to its neighbours so sleeves and hoods hang from their
 * seams instead of from rigid pins.
 */
export function workflowAttachments(
  assetId: WorkflowAssetId,
  path: WorkflowPath,
  surface: { positions: Float32Array; triangles: Uint32Array },
): WorkflowAttachments {
  const { positions, triangles } = surface;
  const count = positions.length / 3;
  const { min, max } = surfaceBounds(positions);
  const height = max[1] - min[1];
  const pinned = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    const x = positions[index * 3];
    const y = positions[index * 3 + 1];
    const z = positions[index * 3 + 2];
    let pin: boolean;
    if (assetId === 'fish-flag') pin = x < min[0] + (path === 'plane' ? 0.15 : 0.05);
    else if (path === 'plane' || assetId === 'sheet-metal') pin = y > max[1] - height * 0.055;
    else if (assetId === 'ruffled-skirt') pin = y > max[1] - 0.04;
    else pin = Math.abs(y - 1.32) < 0.045 && Math.hypot(x, z / 0.92) < 0.21;
    if (pin) pinned[index] = 1;
  }

  const components = vertexComponents(count, triangles);
  const members = new Map<number, number[]>();
  for (let index = 0; index < count; index += 1) {
    const list = members.get(components[index]);
    if (list) list.push(index);
    else members.set(components[index], [index]);
  }
  const seams: number[] = [];
  for (const [component, vertices] of members) {
    if (vertices.some((index) => pinned[index])) continue;
    let sewn = 0;
    for (const vertex of vertices) {
      let best = -1;
      let bestDistance = SEAM_RADIUS * SEAM_RADIUS;
      for (let other = 0; other < count; other += 1) {
        if (components[other] === component) continue;
        const dx = positions[vertex * 3] - positions[other * 3];
        const dy = positions[vertex * 3 + 1] - positions[other * 3 + 1];
        const dz = positions[vertex * 3 + 2] - positions[other * 3 + 2];
        const distance = dx * dx + dy * dy + dz * dz;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = other;
        }
      }
      if (best >= 0) {
        seams.push(vertex, best);
        sewn += 1;
      }
    }
    if (sewn > 0) continue;
    const top = Math.max(...vertices.map((index) => positions[index * 3 + 1]));
    for (const vertex of vertices) if (positions[vertex * 3 + 1] > top - 0.06) pinned[vertex] = 1;
  }

  const result: number[] = [];
  for (let index = 0; index < count; index += 1) if (pinned[index]) result.push(index);
  if (result.length === 0 && count > 0) result.push(0);
  return { pinned: result, seams: new Uint32Array(seams) };
}

export function isGarment(assetId: WorkflowAssetId): boolean {
  return GARMENTS.includes(assetId);
}
