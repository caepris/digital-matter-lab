# Digital Matter Lab

An interactive browser prototype comparing three kinds of simulated matter, all starting as the same 1 m cube on identical platforms:

| Panel | Model | What it shows |
| --- | --- | --- |
| Rigid volume | Rapier rigid body | Moves under impacts and forces; its shape never changes. The press stalls on it. |
| Deformable volume | XPBD tetrahedral mesh (edges + volume preservation) | The whole interior squashes, bulges, and wobbles. Gel and firm rubber recover; foam keeps dents. |
| Thin deformable shell | XPBD cloth surface (stretch + bending + self-collision) | A hollow, stitched six-sided sheet with thickness. Loose cloth sags into a heap; structured fabric holds its shape and keeps creases. |

The **Assembly** tab is an editor for mixed materials. Edit mode places up to eight cubes
or sheets, assigns any comparison preset, and brushes permanent welds where surfaces
touch. Simulate mode compiles that document into one XPBD world: rigid parts keep their
shape, volume parts use tetrahedra, and sheets use cloth constraints. Welds are
zero-compliance barycentric constraints, so rotated parts stay joined. Unwelded parts
still collide. Returning to Edit restores the authored transforms.

The **Thin conversion** tab demonstrates the render-mesh-to-simulation-mesh workflow.
Choose an upright rigid solid shaped like a T-shirt on a hanger, a pleated curtain on a rod,
or a car body, inspect its closed surface vertices, then set a physical thickness and generate
a reduced closed shell that wraps the whole solid. The generated shell derives stretch and
bending constraints from triangle adjacency. The T-shirt and curtain run as loose fabric pinned
where they hang; the car runs as sheet metal with extra second-ring links, so it stays stiff
and keeps permanent dents. In Run, barycentric bindings plus a normal offset make the detailed
source mesh follow that shell while Grab, Drop, and Press act on the simulation particles.
Structure switches between source vertices and generated shell particles based on the
current stage.

The **Creator workflows** tab follows one arbitrary mesh through three authoring paths in
three steps: **Creator submits**, **Engine builds simulation mesh**, and **Simulate**.

1. **Engine-generated shell.** The creator submits a closed arbitrary mesh and clicks any
   capped openings (or uses the chips) to mark them as end caps. The engine generates a thin
   teal shell around every non-cap face; marked caps still render but do not simulate. With
   no caps marked, the full mesh simulates.
2. **Creator simulation plane.** The creator also submits one thin plane that intersects the
   mesh. Every render vertex binds to the plane, and only the plane simulates.
3. **Engine thickening.** The creator submits a separately authored zero-thickness open
   surface (no caps, no rolled collar, nothing tucked inside the body). The engine adds
   outward thickness, reuses the UVs with a tint for the inside, and textures the rim from
   the boundary UVs.

`python3 scripts/generate-workflow-models.py` writes each example twice: `{id}.glb`, the
capped arbitrary mesh with UVs and a `_CAPREGION` vertex attribute, and `{id}-open.glb`,
the Path 3 surface. Matching procedural fallbacks live in
`src/creator-workflow/workflowAssets.ts`.

All three paths run independent XPBD cloth with per-example materials
(`src/creator-workflow/workflowPhysics.ts`): dihedral-angle bending, per-face aerodynamic
wind with gusts, and a faint grey collision body (a mannequin, hips and legs, or a pole)
for Paths 1 and 3. Path 2's plane runs through the body, so it has none. Fabric resists
stretching but compresses almost freely, the way real cloth buckles into fine wrinkles, so
a closed Path 1 shell collapses like an empty bag instead of holding its volume. Air only
inflates the windsock once its mouth is open (Path 3, or Path 1 with the mouth marked as an
end cap). Garments hang from the neckline and sleeves and hoods are sewn on. Simulate shows
a settled drape, and Reset returns to it. Drag the cloth to grab it and drag empty space to
orbit. Two-finger scroll or shift-drag pans, pinch zooms, and **Reset view** restores the
camera. Every simulation mesh is drawn at the chosen thickness, with its wireframe on both
faces. Uncheck **Show render mesh** to see only the simulation mesh as a solid teal shell.
**Section view** cuts all three viewports at a plane across the model (move it with
**Section position**) and fills the cut wall, so the thickness of the shell, the plane, and
the thickened surface is visible. **Inspect** on any path opens its viewport in a pop-up
window; **Close**, Esc, or a click outside closes it.

The editor's numbered sidebar guides the workflow: configure and place a part, select it
from the viewport or part list, transform it, then join touching parts. Position, rotation,
scale, material, duplicate, delete, snapping, history, and structure controls remain
available without covering the 3D viewport.

With **Add welds**, brush over a visible face next to a seam. A green brush means a touching
surface can be welded; red means there is no eligible contact. Every surface within
2 cm of another part inside the brush sphere is welded, including hidden interfaces such as
the face between two stacked cubes. If exactly two parts are selected, the brush only welds
that named pair. Use **Erase welds** to remove weld points.

Turn on **Paint through parts (X-ray)** to weld seams you cannot see. Parts become
translucent with every vertex shown, and the brush lands on the first weldable seam along
the cursor even when other parts are in front. Shift-select two parts first to reach a
seam buried under a third part, such as the base-to-gel interface beneath the cloth.

## Running

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production bundle
npm test           # unit tests (Vitest)
npx playwright install chromium
npm run test:e2e   # browser smoke test (Playwright)
```

## Using it

Each panel is independent and has its own controls:

- **Grab**: drag the cube to pull, lift, or stretch it.
- **Drop**: click to drop a steel ball from above.
- **Press**: hold to lower a force-limited plate; release to lift it. Stiffer materials stop it sooner.
- **Material**: switch presets (switching resets the panel).
- **Structure**: reveal how the body is built (collider frame and axes, tetrahedral lattice, or cloth mesh).
- **Reset**: restore that panel, including any permanent plastic deformation.

Use the **Comparison**, **Assembly**, **Thin conversion**, and **Creator workflows** tabs to switch workspaces.
Hidden simulations are paused. In Assembly, switch to **Simulate**, then press **Play** for Grab, Drop, and Press.
Pause to inspect the result; Restart restores the authored assembly and pauses again. Camera
orbit, pan, and zoom remain available while simulating. **Structure**
works in both Edit and Simulate: it fades the parts and draws every simulated vertex
(including interior cube nodes), the constraint edges, and the welds for each part pair.

## Layout

- `src/simulation/rigid`: Rapier wrapper for the rigid panel.
- `src/simulation/xpbd`: shared XPBD core with constraints, collisions, the substep loop, grab, and impactors.
- `src/simulation/volume`, `src/simulation/shell`: mesh builders and solvers for the two deformable bodies.
- `src/assembly-editor`: authored assembly documents, undo history, and weld brushing.
- `src/simulation/assembly`: part meshes, compilation, and the mixed-material solver.
- `src/simulation/conversion`: procedural source meshes, surface reduction/binding, and the arbitrary thin-shell solver.
- `src/creator-workflow`: authored-model loading, procedural fallbacks, path processing, and runtime workflow data.
- `src/materials/presets.ts`: all tunable material parameters.
- `src/rendering`: per-panel scenes, body visuals, and structure overlays, drawn as scissored viewports of one WebGL canvas.
- `src/interaction`, `src/ui`, `src/app`: pointer routing, panel controls, and app wiring.
