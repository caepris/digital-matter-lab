import * as THREE from 'three';
import { workflowAsset } from '../creator-workflow/workflowAssets';
import { workflowColliders } from '../creator-workflow/workflowPhysics';
import { boundaryEdges, smoothNormals, weldMap } from '../creator-workflow/surfaceTopology';
import { sectionFill, sectionFillCapacity } from './sectionFill';
import {
  displayThickness,
  type CreatorWorkflowState,
  type WorkflowPath,
} from '../creator-workflow/workflowTypes';
import {
  applyBindings,
  buildWorkflowPathData,
  proceduralWorkflowSources,
  type WorkflowPathData,
} from '../creator-workflow/workflowPipeline';

export const WORKFLOW_COLORS = {
  inside: 0xb79be0,
  rim: 0xffb27a,
  boundary: 0xf29a62,
  proxy: 0x37d6c0,
  proxyWire: 0x0d4a42,
  proxyInside: 0x1f8f80,
  proxyRim: 0xa8f5e8,
  section: 0xc5fff2,
  cap: 0xf6b94b,
  capHover: 0xffe2a6,
  mapping: 0xf6b94b,
  collider: 0x9aa3b2,
};

let sharedTexture: THREE.DataTexture | null = null;

/** Shared fabric print: a two-tone check with stripes and dots so UV wrapping stays legible. */
export function fabricTexture(): THREE.DataTexture {
  if (sharedTexture) return sharedTexture;
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cell = (Math.floor(x / 32) + Math.floor(y / 32)) % 2;
      const stripe = (x + y) % 32 < 3;
      const dx = (x % 32) - 16;
      const dy = (y % 32) - 16;
      const dot = dx * dx + dy * dy < 22;
      let value = cell ? 246 : 214;
      if (stripe) value -= 34;
      const index = (y * size + x) * 4;
      data[index] = dot ? 255 : value;
      data[index + 1] = dot ? 236 : value;
      data[index + 2] = dot ? 190 : Math.min(255, value + 8);
      data[index + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 2);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  sharedTexture = texture;
  return texture;
}

interface BaseSurface {
  positions: Float32Array;
  triangles: Uint32Array;
  uvs?: Float32Array;
}

/**
 * A thickened surface whose vertices are re-solved from the base surface every
 * frame: outer layer (group 0) at +thickness along the normal, inner layer
 * (group 1) on the surface, and a rim (group 2) across every open boundary.
 */
export interface ThickLayout {
  geometry: THREE.BufferGeometry;
  baseTriangles: Uint32Array;
  canonical: Uint32Array;
  /** Base vertex for every output vertex. */
  source: Uint32Array;
  /** 1 on the outer layer, 0 on the inner layer. */
  side: Float32Array;
  /** Boundary edge index for rim vertices, -1 elsewhere. */
  rimEdge: Int32Array;
  edges: readonly [number, number][];
  normals: Float32Array;
}

export function buildThickLayout(base: BaseSurface, rimUvSpan = 0.06): ThickLayout {
  const count = base.positions.length / 3;
  const canonical = weldMap(base.positions);
  const edges = boundaryEdges(base.triangles, canonical);
  const total = count * 2 + edges.length * 4;
  const source = new Uint32Array(total);
  const side = new Float32Array(total);
  const rimEdge = new Int32Array(total).fill(-1);
  const uvs = new Float32Array(total * 2);
  const uv = (vertex: number, axis: number) => base.uvs?.[vertex * 2 + axis] ?? 0;
  for (let layer = 0; layer < 2; layer += 1) {
    for (let vertex = 0; vertex < count; vertex += 1) {
      const out = layer * count + vertex;
      source[out] = vertex;
      side[out] = layer === 0 ? 1 : 0;
      uvs[out * 2] = uv(vertex, 0);
      uvs[out * 2 + 1] = uv(vertex, 1);
    }
  }
  const indices: number[] = [...base.triangles];
  for (let index = 0; index < base.triangles.length; index += 3) {
    indices.push(base.triangles[index] + count, base.triangles[index + 2] + count, base.triangles[index + 1] + count);
  }
  edges.forEach(([a, b], edge) => {
    const start = count * 2 + edge * 4;
    const corners = [
      [a, 1],
      [b, 1],
      [a, 0],
      [b, 0],
    ] as const;
    corners.forEach(([vertex, layer], corner) => {
      const out = start + corner;
      source[out] = vertex;
      side[out] = layer;
      rimEdge[out] = edge;
      uvs[out * 2] = uv(vertex, 0);
      uvs[out * 2 + 1] = uv(vertex, 1) - (1 - layer) * rimUvSpan;
    });
    indices.push(start, start + 3, start + 1, start, start + 2, start + 3);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  const faceCount = base.triangles.length;
  geometry.addGroup(0, faceCount, 0);
  geometry.addGroup(faceCount, faceCount, 1);
  geometry.addGroup(faceCount * 2, edges.length * 6, 2);
  return {
    geometry,
    baseTriangles: base.triangles,
    canonical,
    source,
    side,
    rimEdge,
    edges,
    normals: new Float32Array(base.positions.length),
  };
}

export function updateThickLayout(
  layout: ThickLayout,
  basePositions: ArrayLike<number>,
  thickness: number,
  inset = 0,
): void {
  const normals = smoothNormals(basePositions, layout.baseTriangles, layout.canonical, layout.normals);
  const position = layout.geometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = layout.geometry.getAttribute('normal') as THREE.BufferAttribute;
  const out = position.array as Float32Array;
  const outNormal = normal.array as Float32Array;
  const rimNormals = layout.edges.map(([a, b]) => {
    const dx = basePositions[b * 3] - basePositions[a * 3];
    const dy = basePositions[b * 3 + 1] - basePositions[a * 3 + 1];
    const dz = basePositions[b * 3 + 2] - basePositions[a * 3 + 2];
    const nx = normals[a * 3] + normals[b * 3];
    const ny = normals[a * 3 + 1] + normals[b * 3 + 1];
    const nz = normals[a * 3 + 2] + normals[b * 3 + 2];
    const rx = dy * nz - dz * ny;
    const ry = dz * nx - dx * nz;
    const rz = dx * ny - dy * nx;
    const length = Math.hypot(rx, ry, rz) || 1;
    return [rx / length, ry / length, rz / length] as const;
  });
  for (let index = 0; index < layout.source.length; index += 1) {
    const vertex = layout.source[index];
    const offset = inset + layout.side[index] * thickness;
    const edge = layout.rimEdge[index];
    for (let axis = 0; axis < 3; axis += 1) {
      const n = normals[vertex * 3 + axis];
      out[index * 3 + axis] = basePositions[vertex * 3 + axis] + n * offset;
      outNormal[index * 3 + axis] = edge >= 0 ? rimNormals[edge][axis] : layout.side[index] ? n : -n;
    }
  }
  position.needsUpdate = true;
  normal.needsUpdate = true;
  layout.geometry.computeBoundingSphere();
}

/** Render mesh for an arbitrary or open surface, with smooth normals across UV seams. */
interface RenderMesh {
  mesh: THREE.Mesh;
  canonical: Uint32Array;
  triangles: Uint32Array;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Points) {
      if (!(child.userData.sharedGeometry as boolean | undefined)) child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) material.dispose();
    }
  });
}

type ShellSurface = 'solid' | 'overlay' | 'none';

interface SectionFillMesh {
  mesh: THREE.Mesh;
  attribute: THREE.BufferAttribute;
}

interface SimulationShell {
  layout: ThickLayout;
  thickness: number;
  inset: number;
  wire: THREE.BufferAttribute;
  /** Layout vertex for each wireframe line endpoint. */
  wireSources: number[];
  fill: SectionFillMesh | null;
}

export class CreatorWorkflowVisual {
  readonly root = new THREE.Group();
  private state: CreatorWorkflowState;
  private data: WorkflowPathData;
  private render: RenderMesh | null = null;
  private thick: ThickLayout | null = null;
  private thickFill: SectionFillMesh | null = null;
  private shell: SimulationShell | null = null;
  private mappingLines: THREE.BufferAttribute | null = null;
  private mappingSources: number[] = [];
  private capOutlines = new Map<number, THREE.LineSegments>();
  private hoverRegion = 0;
  private deformed = new Float32Array();
  private bound = new Float32Array();
  /** Keeps x <= constant, so the cut faces the default camera. */
  private readonly clippingPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);

  constructor(
    private readonly path: WorkflowPath,
    initialState: CreatorWorkflowState,
    initialData?: WorkflowPathData,
  ) {
    this.state = initialState;
    this.data =
      initialData ?? buildWorkflowPathData(initialState, path, proceduralWorkflowSources(initialState.assetId, 0.4));
    this.rebuild();
  }

  get pathData(): WorkflowPathData {
    return this.data;
  }

  /** World x of the section plane, or null when the section view is off. */
  get sectionX(): number | null {
    return this.state.section ? this.clippingPlane.constant : null;
  }

  update(state: CreatorWorkflowState): void {
    this.state = state;
    this.rebuild();
  }

  setData(data: WorkflowPathData, state: CreatorWorkflowState): void {
    this.data = data;
    this.state = state;
    this.rebuild();
  }

  /** Cap region under the ray on the submitted mesh, or 0. */
  pickRegion(ray: THREE.Ray): number {
    if (!this.render) return 0;
    const raycaster = new THREE.Raycaster();
    raycaster.ray.copy(ray);
    const hit = raycaster.intersectObject(this.render.mesh, false)[0];
    if (!hit?.face) return 0;
    return this.data.render.capRegion[hit.face.a] ?? 0;
  }

  setHoverRegion(region: number): void {
    if (region === this.hoverRegion) return;
    this.hoverRegion = region;
    this.paintCaps();
  }

  updateSimulation(particles: Float32Array): void {
    const renderLength = this.data.render.positions.length;
    if (this.deformed.length !== renderLength) {
      this.deformed = new Float32Array(renderLength);
      this.bound = new Float32Array(renderLength);
    }
    applyBindings(particles, this.data, this.deformed, this.bound);
    if (this.render) {
      const position = this.render.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      (position.array as Float32Array).set(this.deformed);
      position.needsUpdate = true;
      const normal = this.render.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
      smoothNormals(this.deformed, this.render.triangles, this.render.canonical, normal.array as Float32Array);
      normal.needsUpdate = true;
      this.render.mesh.geometry.computeBoundingSphere();
    }
    if (this.thick) {
      updateThickLayout(this.thick, this.deformed, this.thicknessUnits());
      if (this.thickFill) this.updateFill(this.thickFill, this.thick);
    }
    if (this.shell) this.updateShell(this.shell, particles);
    if (this.mappingLines) {
      const values = this.mappingLines.array as Float32Array;
      this.mappingSources.forEach((vertex, line) => {
        values.set(this.bound.subarray(vertex * 3, vertex * 3 + 3), line * 6);
        values.set(this.deformed.subarray(vertex * 3, vertex * 3 + 3), line * 6 + 3);
      });
      this.mappingLines.needsUpdate = true;
    }
  }

  dispose(): void {
    disposeObject(this.root);
    this.root.clear();
  }

  private thicknessUnits(): number {
    return displayThickness(this.state.thicknessCm);
  }

  private rebuild(): void {
    this.dispose();
    this.render = null;
    this.thick = null;
    this.thickFill = null;
    this.shell = null;
    this.mappingLines = null;
    this.mappingSources = [];
    this.capOutlines.clear();
    const { stage, showMapping, showRender } = this.state;
    const rest = this.data.proxy.positions;
    const teal = WORKFLOW_COLORS.proxy;

    // The overlay checkbox is hidden at submit, where Path 2's plane is part of the submission.
    const overlay = stage === 'submit' || showMapping;
    if (!showRender) {
      this.addShell({ surface: 'solid', wireOpacity: overlay ? 0.7 : 0, wireColor: WORKFLOW_COLORS.proxyWire, fill: true });
      if (this.path === 'shell' && stage === 'submit') this.addCapOutlines();
      if (this.path === 'thicken' && stage === 'submit') this.addBoundaryLoops();
    } else if (this.path === 'shell') {
      this.addRenderMesh(1);
      if (stage === 'submit') this.addCapOutlines();
      if (stage === 'build' && showMapping) {
        this.addShell({ surface: 'overlay', overlayOpacity: 0.34, wireOpacity: 0.55, wireColor: teal, fill: true });
      }
      if (stage === 'simulate' && showMapping) {
        this.addShell({ surface: 'none', wireOpacity: 0.55, wireColor: teal, fill: true });
        this.addMapping();
      }
    } else if (this.path === 'plane') {
      this.addRenderMesh(stage === 'build' && showMapping ? 0.42 : 1);
      if (overlay) this.addShell({ surface: 'overlay', overlayOpacity: 0.32, wireOpacity: 0.75, wireColor: teal, fill: true });
      if (stage !== 'submit' && showMapping) this.addMapping();
    } else if (stage === 'submit') {
      this.addRenderMesh(1);
      this.addBoundaryLoops();
    } else {
      this.addThickMesh();
      if (showMapping) this.addShell({ surface: 'none', wireOpacity: 0.45, wireColor: teal, fill: false });
    }
    if (stage === 'simulate') this.addColliders();
    this.applySection();
    this.updateSimulation(rest);
    this.paintCaps();
  }

  /**
   * Thickness of the simulation mesh as drawn. Path 3 submits a zero-thickness surface,
   * and the Path 1 shell does not exist until the engine builds it.
   */
  private shellThickness(): number {
    if (this.state.stage === 'submit' && this.path !== 'plane') return 0;
    return this.thicknessUnits();
  }

  /** Path 1 sits just outside the render mesh, Path 2's plane is centered, Path 3 grows outward. */
  private shellInset(thickness: number, surface: ShellSurface): number {
    if (this.path === 'plane') return -thickness / 2;
    if (this.path === 'shell' && surface !== 'solid') return 0.004;
    return 0;
  }

  /**
   * The simulation mesh at its thickness: an optional surface, the wireframe on both
   * faces, edges across the thickness at open boundaries, and a section fill.
   */
  private addShell(options: {
    surface: ShellSurface;
    overlayOpacity?: number;
    wireOpacity: number;
    wireColor: number;
    fill: boolean;
  }): void {
    const layout = buildThickLayout(this.data.proxy);
    const thickness = this.shellThickness();
    const shell: SimulationShell = {
      layout,
      thickness,
      inset: this.shellInset(thickness, options.surface),
      wire: new THREE.BufferAttribute(new Float32Array(), 3),
      wireSources: [],
      fill: null,
    };
    if (options.surface !== 'none') {
      const solid = options.surface === 'solid';
      const opacity = solid ? 1 : (options.overlayOpacity ?? 0.34);
      const material = (color: number) =>
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: solid ? 0.12 : 0.25,
          roughness: solid ? 0.55 : 0.4,
          transparent: !solid,
          opacity,
          depthWrite: solid,
          side: solid ? THREE.FrontSide : THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
      const mesh = new THREE.Mesh(layout.geometry, [
        material(WORKFLOW_COLORS.proxy),
        material(WORKFLOW_COLORS.proxyInside),
        material(WORKFLOW_COLORS.proxyRim),
      ]);
      mesh.name = solid ? 'workflow-solid-proxy' : 'workflow-proxy-overlay';
      if (!solid) mesh.renderOrder = 3;
      this.root.add(mesh);
    }

    const count = this.data.proxy.positions.length / 3;
    const pairs = this.data.proxy.stretchPairs;
    for (const layer of thickness > 0 ? [0, count] : [0]) {
      for (let index = 0; index < pairs.length; index += 1) shell.wireSources.push(pairs[index] + layer);
    }
    if (thickness > 0) for (const [a] of layout.edges) shell.wireSources.push(a, a + count);
    shell.wire = new THREE.BufferAttribute(new Float32Array(shell.wireSources.length * 3), 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', shell.wire);
    const lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: options.wireColor, transparent: true, opacity: options.wireOpacity }),
    );
    lines.name = 'workflow-proxy-wire';
    lines.renderOrder = 5;
    if (options.wireOpacity > 0) this.root.add(lines);
    else disposeObject(lines);

    if (options.fill && this.state.section && thickness > 0) {
      shell.fill = this.addFill(layout, WORKFLOW_COLORS.section);
    }
    this.shell = shell;
  }

  private updateShell(shell: SimulationShell, particles: Float32Array): void {
    updateThickLayout(shell.layout, particles, shell.thickness, shell.inset);
    const source = shell.layout.geometry.getAttribute('position').array as Float32Array;
    const values = shell.wire.array as Float32Array;
    shell.wireSources.forEach((vertex, index) => {
      values[index * 3] = source[vertex * 3];
      values[index * 3 + 1] = source[vertex * 3 + 1];
      values[index * 3 + 2] = source[vertex * 3 + 2];
    });
    shell.wire.needsUpdate = true;
    if (shell.fill) this.updateFill(shell.fill, shell.layout);
  }

  private addFill(layout: ThickLayout, color: number): SectionFillMesh {
    const attribute = new THREE.BufferAttribute(new Float32Array(sectionFillCapacity(layout.baseTriangles.length)), 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', attribute);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }),
    );
    mesh.name = 'workflow-section-fill';
    mesh.frustumCulled = false;
    mesh.userData.unclipped = true;
    mesh.renderOrder = 4;
    this.root.add(mesh);
    return { mesh, attribute };
  }

  private updateFill(fill: SectionFillMesh, layout: ThickLayout): void {
    const positions = layout.geometry.getAttribute('position').array as Float32Array;
    const count = layout.normals.length / 3;
    const vertices = sectionFill(
      positions,
      layout.baseTriangles,
      count,
      this.clippingPlane.constant,
      fill.attribute.array as Float32Array,
    );
    fill.mesh.geometry.setDrawRange(0, vertices);
    fill.attribute.needsUpdate = true;
  }

  /** Cuts every layer at the section plane and outlines the plane across the model. */
  private applySection(): void {
    if (!this.state.section) return;
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    const positions = this.data.render.positions;
    for (let index = 0; index < positions.length; index += 3) {
      box.expandByPoint(point.set(positions[index], positions[index + 1], positions[index + 2]));
    }
    const x = THREE.MathUtils.lerp(box.min.x, box.max.x, this.state.sectionPosition);
    this.clippingPlane.constant = x;
    const planes = [this.clippingPlane];
    this.root.traverse((child) => {
      if (child.userData.unclipped) return;
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Points) {
        for (const material of [child.material].flat()) material.clippingPlanes = planes;
      }
    });
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(size.z + 0.3, size.y + 0.3).rotateY(Math.PI / 2)),
      new THREE.LineBasicMaterial({ color: WORKFLOW_COLORS.section, transparent: true, opacity: 0.6 }),
    );
    outline.name = 'workflow-section-plane';
    outline.position.set(x, center.y, center.z);
    this.root.add(outline);
  }

  /** Faint mannequin, hips, or pole that the simulation drapes over. */
  private addColliders(): void {
    const colliders = workflowColliders(this.state.assetId, this.path);
    if (colliders.length === 0) return;
    const group = new THREE.Group();
    group.name = 'workflow-colliders';
    const material = new THREE.MeshStandardMaterial({
      color: WORKFLOW_COLORS.collider,
      roughness: 0.8,
      transparent: true,
      opacity: 0.32,
    });
    const up = new THREE.Vector3(0, 1, 0);
    for (const collider of colliders) {
      const a = new THREE.Vector3(...collider.a);
      const b = new THREE.Vector3(...collider.b);
      const axis = b.clone().sub(a);
      const length = axis.length();
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(collider.radius, length, 6, 16), material);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      if (length > 1e-6) mesh.quaternion.setFromUnitVectors(up, axis.divideScalar(length));
      group.add(mesh);
    }
    this.root.add(group);
  }

  private surfaceMaterial(opacity: number): THREE.MeshStandardMaterial {
    const asset = workflowAsset(this.state.assetId);
    return new THREE.MeshStandardMaterial({
      map: fabricTexture(),
      vertexColors: true,
      roughness: asset.id === 'sheet-metal' ? 0.38 : 0.62,
      metalness: asset.id === 'sheet-metal' ? 0.55 : 0.02,
      side: THREE.DoubleSide,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
  }

  private addRenderMesh(opacity: number): void {
    const surface = this.data.render;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(surface.positions), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(surface.positions.length), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(surface.uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(surface.positions.length).fill(1), 3));
    geometry.setIndex(new THREE.BufferAttribute(surface.triangles, 1));
    const mesh = new THREE.Mesh(geometry, this.surfaceMaterial(opacity));
    mesh.renderOrder = opacity < 1 ? 2 : 0;
    this.root.add(mesh);
    this.render = { mesh, canonical: weldMap(surface.positions, surface.capRegion), triangles: surface.triangles };
  }

  /** Colors cap regions: amber when marked as end caps, pale amber while hovered. */
  private paintCaps(): void {
    if (this.render) {
      const color = this.render.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const regions = this.data.render.capRegion;
      const selected = this.path === 'shell' ? new Set(this.state.endCaps) : new Set<number>();
      const submit = this.path === 'shell' && this.state.stage === 'submit';
      const body = new THREE.Color(workflowAsset(this.state.assetId).tint);
      const cap = new THREE.Color(WORKFLOW_COLORS.cap);
      const hover = new THREE.Color(WORKFLOW_COLORS.capHover);
      const dimmed = new THREE.Color(WORKFLOW_COLORS.cap).multiplyScalar(0.6);
      for (let index = 0; index < regions.length; index += 1) {
        const region = regions[index];
        let value = body;
        if (selected.has(region)) value = submit ? cap : dimmed;
        else if (submit && region > 0 && region === this.hoverRegion) value = hover;
        color.setXYZ(index, value.r, value.g, value.b);
      }
      color.needsUpdate = true;
    }
    for (const [region, outline] of this.capOutlines) {
      const material = outline.material as THREE.LineBasicMaterial;
      const active = region === this.hoverRegion || this.state.endCaps.includes(region);
      material.color.set(active ? WORKFLOW_COLORS.cap : 0xffffff);
      material.opacity = active ? 1 : 0.4;
    }
  }

  private addCapOutlines(): void {
    const surface = this.data.render;
    const regions = new Set(workflowAsset(this.state.assetId).capRegions.map((cap) => cap.id));
    for (const region of regions) {
      const faces: number[] = [];
      for (let index = 0; index < surface.triangles.length; index += 3) {
        if (surface.capRegion[surface.triangles[index]] === region) {
          faces.push(surface.triangles[index], surface.triangles[index + 1], surface.triangles[index + 2]);
        }
      }
      const edges = boundaryEdges(faces);
      if (edges.length === 0) continue;
      const values = new Float32Array(edges.length * 6);
      edges.forEach(([a, b], index) => {
        values.set(surface.positions.subarray(a * 3, a * 3 + 3), index * 6);
        values.set(surface.positions.subarray(b * 3, b * 3 + 3), index * 6 + 3);
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(values, 3));
      const outline = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthTest: false }),
      );
      outline.renderOrder = 4;
      this.capOutlines.set(region, outline);
      this.root.add(outline);
    }
  }

  private addBoundaryLoops(): void {
    const surface = this.data.render;
    const edges = boundaryEdges(surface.triangles, weldMap(surface.positions));
    const values = new Float32Array(edges.length * 6);
    edges.forEach(([a, b], index) => {
      values.set(surface.positions.subarray(a * 3, a * 3 + 3), index * 6);
      values.set(surface.positions.subarray(b * 3, b * 3 + 3), index * 6 + 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(values, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: WORKFLOW_COLORS.boundary }));
    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ color: WORKFLOW_COLORS.boundary, size: 0.028, sizeAttenuation: true }),
    );
    points.userData.sharedGeometry = true;
    this.root.add(lines, points);
  }

  private addThickMesh(): void {
    const asset = workflowAsset(this.state.assetId);
    this.thick = buildThickLayout(this.data.render);
    const tint = new THREE.Color(asset.tint);
    const outer = this.surfaceMaterial(1);
    outer.vertexColors = false;
    outer.color = tint.clone();
    const inner = outer.clone();
    inner.color = tint.clone().lerp(new THREE.Color(WORKFLOW_COLORS.inside), 0.6);
    const rim = outer.clone();
    rim.color = tint.clone().lerp(new THREE.Color(WORKFLOW_COLORS.rim), 0.7);
    this.root.add(new THREE.Mesh(this.thick.geometry, [outer, inner, rim]));
    if (this.state.section) this.thickFill = this.addFill(this.thick, rim.color.getHex());
  }

  private addMapping(): void {
    const count = this.data.renderBindings.length;
    const stride = Math.max(1, Math.ceil(count / 48));
    for (let index = 0; index < count; index += stride) this.mappingSources.push(index);
    const geometry = new THREE.BufferGeometry();
    this.mappingLines = new THREE.BufferAttribute(new Float32Array(this.mappingSources.length * 6), 3);
    geometry.setAttribute('position', this.mappingLines);
    const lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: WORKFLOW_COLORS.mapping, transparent: true, opacity: 0.8 }),
    );
    lines.renderOrder = 6;
    this.root.add(lines);
  }
}
