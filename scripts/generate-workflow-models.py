"""Generate the original smooth GLB examples used by Creator workflows.

Each model is a closed (or nearly closed) arbitrary mesh with UVs and a per-vertex
`_CAPREGION` attribute. Region 0 is simulated body surface, regions 1-254 are
creator-selectable end caps, and region 255 is authored thickness.

Path 3 gets its own `{id}-open.glb`: the zero-thickness surface a creator would
author for engine thickening. It has no caps, no closed volumes such as a rolled
collar, and no hidden geometry inside the body, so every region is 0.

The files are intentionally dependency-free and deterministic. Run with:
    python3 scripts/generate-workflow-models.py

Keep the shapes in sync with the procedural fallback in
src/creator-workflow/workflowAssets.ts.
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public" / "creator-workflow"
BACK_SKIN = 255


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


class Mesh:
    def __init__(self):
        self.positions: list[tuple[float, float, float]] = []
        self.uvs: list[tuple[float, float]] = []
        self.regions: list[int] = []
        self.triangles: list[tuple[int, int, int]] = []

    def patch(self, positions, uvs, region, faces, outward, keep_face=None):
        """Adds a patch whose winding is flipped if needed so normals agree with `outward`."""
        if keep_face:
            faces = [f for f in faces if keep_face(positions[f[0]], positions[f[1]], positions[f[2]])]
            used = sorted({i for f in faces for i in f})
            remap = {old: new for new, old in enumerate(used)}
            positions = [positions[i] for i in used]
            uvs = [uvs[i] for i in used]
            faces = [(remap[a], remap[b], remap[c]) for a, b, c in faces]
        total = 0.0
        for a, b, c in faces:
            pa, pb, pc = positions[a], positions[b], positions[c]
            normal = cross(sub(pb, pa), sub(pc, pa))
            centroid = tuple((pa[k] + pb[k] + pc[k]) / 3 for k in range(3))
            total += dot(normal, outward(centroid))
        if total < 0:
            faces = [(a, c, b) for a, b, c in faces]
        offset = len(self.positions)
        self.positions.extend(positions)
        self.uvs.extend(uvs)
        self.regions.extend([region] * len(positions))
        self.triangles.extend((a + offset, b + offset, c + offset) for a, b, c in faces)


def grid_patch(mesh: Mesh, nu, nv, point, region, outward, wrap_u=False, uv=None, keep_face=None):
    positions, uvs = [], []
    for j in range(nv + 1):
        for i in range(nu + 1):
            u, v = i / nu, j / nv
            positions.append(point((i % nu) / nu if wrap_u else u, v))
            uvs.append(uv(u, v) if uv else (u, v))
    faces = []
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            b, d = a + 1, a + nu + 1
            faces.extend(((a, b, d + 1), (a, d + 1, d)))
    mesh.patch(positions, uvs, region, faces, outward, keep_face)


def disc_patch(mesh: Mesh, center, ring, region, normal):
    """Fan cap over `ring` (a closed loop without the duplicated seam point)."""
    positions = [center] + list(ring)
    segments = len(ring)
    uvs = [(0.5, 0.5)] + [
        (0.5 + 0.5 * math.cos(2 * math.pi * i / segments), 0.5 + 0.5 * math.sin(2 * math.pi * i / segments))
        for i in range(segments)
    ]
    faces = [(0, 1 + i, 1 + (i + 1) % segments) for i in range(segments)]
    mesh.patch(positions, uvs, region, faces, lambda _c: normal)


def ring_points(point, v, segments):
    return [point(i / segments, v) for i in range(segments)]


def radial_from_axis_y(centroid):
    return (centroid[0], 0.0, centroid[2])


TORSO_POWER = 0.72


def torso_profile(v, depth, puffer):
    """Half width and half depth of the torso superellipse at height parameter v."""
    quilt = 1 + (0.055 * math.cos(v * math.pi * 10) if puffer else 0)
    width = (0.45 - 0.035 * math.sin(v * math.pi) + 0.09 * v * v) * quilt
    bulge = 1 + 0.1 * math.sin(v * math.pi)
    return width, depth * bulge * quilt


def torso_surface_x(y, z, depth, puffer):
    """|x| of the torso surface at (y, z): |x/w|^(2/p) + |z/d|^(2/p) = 1."""
    v = min(1.0, max(0.0, (y - 0.2) / 1.12))
    width, half_depth = torso_profile(v, depth, puffer)
    ratio = min(1.0, abs(z) / half_depth) ** (2 / TORSO_POWER)
    return width * (1 - ratio) ** (TORSO_POWER / 2)


def inside_torso(p, depth, puffer):
    if p[1] < 0.2 or p[1] > 1.32:
        return False
    return abs(p[0]) < torso_surface_x(p[1], p[2], depth, puffer) - 1e-4


def garment_torso(mesh: Mesh, depth=0.2, puffer=False, rings=28, segments=36, open_surface=False):
    def point(u, v):
        y = 0.2 + 1.12 * v
        width, half_depth = torso_profile(v, depth, puffer)
        angle = 2 * math.pi * u
        cx = math.copysign(abs(math.cos(angle)) ** TORSO_POWER, math.cos(angle))
        sz = math.copysign(abs(math.sin(angle)) ** TORSO_POWER, math.sin(angle))
        return (width * cx, y, half_depth * sz)

    grid_patch(mesh, segments, rings, point, 0, radial_from_axis_y, wrap_u=True)
    if not open_surface:
        disc_patch(mesh, (0, 0.2, 0), ring_points(point, 0, segments), 1, (0, -1, 0))

    neck_radius = 0.15

    def yoke(u, t):
        outer = point(u, 1)
        angle = 2 * math.pi * u
        inner = (neck_radius * math.cos(angle), 1.32, neck_radius * math.sin(angle) * 0.92)
        lift = 0.02 * math.sin(math.pi * t)
        return (
            outer[0] + (inner[0] - outer[0]) * t,
            1.32 + lift,
            outer[2] + (inner[2] - outer[2]) * t,
        )

    grid_patch(mesh, segments, 4, yoke, 0, lambda _c: (0, 1, 0), wrap_u=True)
    if open_surface:
        collar_band(mesh, neck_radius, segments)
    else:
        disc_patch(mesh, (0, 1.32, 0), ring_points(yoke, 1, segments), 2, (0, 1, 0))


def collar_band(mesh: Mesh, neck_radius, segments, rings=3):
    """Single-layer stand collar continuing the yoke's neck ring upward."""

    def point(u, t):
        angle = 2 * math.pi * u
        radius = neck_radius + 0.025 * t
        return (radius * math.cos(angle), 1.32 + 0.07 * t, radius * math.sin(angle) * 0.92)

    grid_patch(mesh, segments, rings, point, 0, radial_from_axis_y, wrap_u=True)


def sleeve(mesh: Mesh, x0, x1, y, radius_y, radius_z, region, segments=24, rings=6, torso=None):
    """`torso=(depth, puffer)` starts the sleeve on the torso surface instead of inside it, with an open cuff."""

    def point(u, v):
        taper = 1 - 0.18 * v
        angle = 2 * math.pi * u
        py = y + math.cos(angle) * radius_y * taper
        pz = math.sin(angle) * radius_z * taper
        start = x0
        if torso:
            start = math.copysign(
                torso_surface_x(y + math.cos(angle) * radius_y, math.sin(angle) * radius_z, *torso), x1
            )
        return (start + (x1 - start) * v, py, pz)

    grid_patch(mesh, segments, rings, point, 0, lambda c: (0, c[1] - y, c[2]), wrap_u=True)
    if not torso:
        disc_patch(mesh, (x1, y, 0), ring_points(point, 1, segments), region, (math.copysign(1, x1 - x0), 0, 0))


def torus_xz(mesh: Mesh, center, major, minor, rings=32, sides=10):
    def point(u, v):
        a, b = 2 * math.pi * u, 2 * math.pi * v
        radial = major + minor * math.cos(b)
        return (center[0] + radial * math.cos(a), center[1] + minor * math.sin(b), center[2] + radial * math.sin(a))

    def outward(c):
        dx, dz = c[0] - center[0], c[2] - center[2]
        length = math.hypot(dx, dz) or 1
        return (c[0] - (center[0] + major * dx / length), c[1] - center[1], c[2] - (center[2] + major * dz / length))

    torus_grid(mesh, rings, sides, point, outward)


def torus_xy(mesh: Mesh, center, major_x, major_y, minor, rings=36, sides=10):
    def point(u, v):
        a, b = 2 * math.pi * u, 2 * math.pi * v
        core = (center[0] + major_x * math.cos(a), center[1] + major_y * math.sin(a))
        return (
            core[0] + minor * math.cos(b) * math.cos(a),
            core[1] + minor * math.cos(b) * math.sin(a),
            center[2] + minor * math.sin(b),
        )

    def outward(c):
        a = math.atan2((c[1] - center[1]) / major_y, (c[0] - center[0]) / major_x)
        core = (center[0] + major_x * math.cos(a), center[1] + major_y * math.sin(a), center[2])
        return sub(c, core)

    torus_grid(mesh, rings, sides, point, outward)


def torus_grid(mesh: Mesh, rings, sides, point, outward):
    positions, uvs = [], []
    for j in range(sides + 1):
        for i in range(rings + 1):
            positions.append(point((i % rings) / rings, (j % sides) / sides))
            uvs.append((i / rings, j / sides))
    faces = []
    for j in range(sides):
        for i in range(rings):
            a = j * (rings + 1) + i
            b, d = a + 1, a + rings + 1
            faces.extend(((a, b, d + 1), (a, d + 1, d)))
    mesh.patch(positions, uvs, 0, faces, outward)


def hood(mesh: Mesh, center, scale, opening, region, rings=20, segments=36, torso=None):
    """Ellipsoid opening toward +z; the spherical cap over the face opening is its own region.

    `torso=(depth, puffer)` builds the open variant: no face cap or rolled rim, and
    no faces hidden inside the torso.
    """

    def direction(u, alpha):
        beta = 2 * math.pi * u
        return (math.sin(alpha) * math.cos(beta), math.sin(alpha) * math.sin(beta), math.cos(alpha))

    def body(u, v):
        d = direction(u, opening + (math.pi - opening) * v)
        return (center[0] + scale[0] * d[0], center[1] + scale[1] * d[1], center[2] + scale[2] * d[2])

    def cap(u, v):
        d = direction(u, opening * (1 - v))
        return (center[0] + scale[0] * d[0], center[1] + scale[1] * d[1], center[2] + scale[2] * d[2])

    outward = lambda c: sub(c, center)
    if torso:
        visible = lambda *corners: not all(inside_torso(p, *torso) for p in corners)
        grid_patch(mesh, segments, rings, body, 0, outward, wrap_u=True, keep_face=visible)
        return
    grid_patch(mesh, segments, rings, body, 0, outward, wrap_u=True)
    grid_patch(mesh, segments, 5, cap, region, outward, wrap_u=True)
    rim_center = (center[0], center[1], center[2] + scale[2] * math.cos(opening))
    torus_xy(mesh, rim_center, scale[0] * math.sin(opening), scale[1] * math.sin(opening), 0.03)


def garment(kind: str, open_surface=False):
    mesh = Mesh()
    depth = 0.25 if kind == "puffer" else 0.2
    torso = (depth, kind == "puffer") if open_surface else None
    garment_torso(mesh, depth, kind == "puffer", open_surface=open_surface)
    sleeve(mesh, -0.42, -0.94, 1.12, 0.18, depth * 0.75, 3, torso=torso)
    sleeve(mesh, 0.42, 0.94, 1.12, 0.18, depth * 0.75, 4, torso=torso)
    if not open_surface:
        torus_xz(mesh, (0, 1.335, 0), 0.15, 0.035)
    if kind == "hooded":
        hood(mesh, (0, 1.5, -0.14), (0.34, 0.38, 0.31), 1.0, 5, torso=torso)
    return mesh


def skirt(mesh: Mesh, vertical=22, segments=64, open_surface=False):
    def point(u, v):
        a = 2 * math.pi * u
        ripple = 0.075 * (1 - 0.4 * v) * math.sin(a * 7)
        radius = 0.72 - 0.38 * v + ripple
        return (math.sin(a) * radius, 0.18 + 1.18 * v, math.cos(a) * radius)

    grid_patch(mesh, segments, vertical, point, 0, radial_from_axis_y, wrap_u=True, uv=lambda u, v: (u * 2, v))
    if open_surface:
        return
    disc_patch(mesh, (0, 1.36, 0), ring_points(point, 1, segments), 1, (0, 1, 0))
    disc_patch(mesh, (0, 0.18, 0), ring_points(point, 0, segments), 2, (0, -1, 0))


def sheet_metal(mesh: Mesh, nx=42, ny=24, half=0.022, open_surface=False):
    def panel(u, v, offset):
        uu = u * 2 - 1
        x = uu * (0.92 + 0.08 * v)
        y = 0.25 + 0.82 * v
        z = 0.29 * (1 - uu * uu) + 0.11 * math.sin(v * math.pi) + 0.035 * math.cos(uu * math.pi * 3) * math.sin(v * math.pi)
        return (x, y, z + offset)

    if open_surface:
        grid_patch(mesh, nx, ny, lambda u, v: panel(u, v, 0), 0, lambda _c: (0, 0, 1))
        return
    grid_patch(mesh, nx, ny, lambda u, v: panel(u, v, half), 0, lambda _c: (0, 0, 1))
    grid_patch(mesh, nx, ny, lambda u, v: panel(u, v, -half), BACK_SKIN, lambda _c: (0, 0, -1))
    wall = lambda edge: (lambda s, t: panel(*edge(s), -half + 2 * half * t))
    grid_patch(mesh, nx, 1, wall(lambda s: (s, 1)), 1, lambda _c: (0, 1, 0))
    grid_patch(mesh, nx, 1, wall(lambda s: (s, 0)), 2, lambda _c: (0, -1, 0))
    grid_patch(mesh, ny, 1, wall(lambda s: (0, s)), 3, lambda _c: (-1, 0, 0))
    grid_patch(mesh, ny, 1, wall(lambda s: (1, s)), 4, lambda _c: (1, 0, 0))


def fish_radius(t, angle):
    if t <= 0.8:
        return 0.26 + 0.18 * math.sin(math.pi * t / 0.8) - 0.12 * (t / 0.8) ** 3
    s = (t - 0.8) / 0.2
    return (0.14 + 0.18 * s ** 1.5) * (1 + 0.16 * s * math.sin(angle * 6))


def fish(mesh: Mesh, rings=30, segments=40, open_surface=False):
    def point(u, v):
        angle = 2 * math.pi * u
        radius = fish_radius(v, angle)
        return (-0.95 + 1.9 * v, 0.75 + math.cos(angle) * radius, math.sin(angle) * radius * 0.78)

    grid_patch(mesh, segments, rings, point, 0, lambda c: (0, c[1] - 0.75, c[2]), wrap_u=True, uv=lambda u, v: (v * 2, u))
    if open_surface:
        return
    disc_patch(mesh, (-0.95, 0.75, 0), ring_points(point, 0, segments), 1, (-1, 0, 0))
    disc_patch(mesh, (0.95, 0.75, 0), ring_points(point, 1, segments), 2, (1, 0, 0))


def build(asset_id: str, open_surface=False):
    if asset_id in ("tshirt", "puffer-jacket", "hooded-jacket"):
        kind = "puffer" if asset_id == "puffer-jacket" else "hooded" if asset_id == "hooded-jacket" else "tshirt"
        return garment(kind, open_surface)
    mesh = Mesh()
    if asset_id == "ruffled-skirt":
        skirt(mesh, open_surface=open_surface)
    elif asset_id == "sheet-metal":
        sheet_metal(mesh, open_surface=open_surface)
    elif asset_id == "fish-flag":
        fish(mesh, open_surface=open_surface)
    return mesh


def padded(data: bytes) -> bytes:
    return data + b"\0" * ((4 - len(data) % 4) % 4)


def write_glb(path: Path, mesh: Mesh):
    flat_positions = [value for vertex in mesh.positions for value in vertex]
    flat_uvs = [value for uv in mesh.uvs for value in uv]
    flat_indices = [value for triangle in mesh.triangles for value in triangle]
    chunks = [
        struct.pack("<" + "f" * len(flat_positions), *flat_positions),
        struct.pack("<" + "f" * len(flat_uvs), *flat_uvs),
        struct.pack("<" + "f" * len(mesh.regions), *[float(r) for r in mesh.regions]),
        struct.pack("<" + "I" * len(flat_indices), *flat_indices),
    ]
    binary = b""
    views = []
    for index, chunk in enumerate(chunks):
        views.append({
            "buffer": 0,
            "byteOffset": len(binary),
            "byteLength": len(chunk),
            "target": 34963 if index == 3 else 34962,
        })
        binary += padded(chunk)
    count = len(mesh.positions)
    mins = [min(v[i] for v in mesh.positions) for i in range(3)]
    maxs = [max(v[i] for v in mesh.positions) for i in range(3)]
    document = {
        "asset": {"version": "2.0", "generator": "Digital Matter Lab workflow generator"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": path.stem}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1, "_CAPREGION": 2}, "indices": 3}]}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": views,
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": count, "type": "VEC3", "min": mins, "max": maxs},
            {"bufferView": 1, "componentType": 5126, "count": count, "type": "VEC2"},
            {"bufferView": 2, "componentType": 5126, "count": count, "type": "SCALAR"},
            {"bufferView": 3, "componentType": 5125, "count": len(flat_indices), "type": "SCALAR"},
        ],
    }
    encoded = json.dumps(document, separators=(",", ":")).encode()
    encoded += b" " * ((4 - len(encoded) % 4) % 4)
    header = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(encoded) + 8 + len(binary))
    path.write_bytes(header + struct.pack("<I4s", len(encoded), b"JSON") + encoded + struct.pack("<I4s", len(binary), b"BIN\0") + binary)


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for asset_id in ("tshirt", "ruffled-skirt", "puffer-jacket", "sheet-metal", "hooded-jacket", "fish-flag"):
        write_glb(OUTPUT / f"{asset_id}.glb", build(asset_id))
        write_glb(OUTPUT / f"{asset_id}-open.glb", build(asset_id, open_surface=True))


if __name__ == "__main__":
    main()
