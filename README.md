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
Choose a T-shirt, curtain, or metal car shell, inspect its source vertices, set a visible
and physical thickness, and generate a reduced fitted surface. The generated shell derives
stretch and bending constraints from triangle adjacency. In Run, barycentric bindings make
the detailed source mesh follow that shell while Grab, Drop, and Press act on the simulation
particles. Structure switches between source vertices and generated shell particles based
on the current stage.

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

Use the **Comparison**, **Assembly**, and **Thin conversion** tabs to switch workspaces.
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
- `src/materials/presets.ts`: all tunable material parameters.
- `src/rendering`: per-panel scenes, body visuals, and structure overlays, drawn as scissored viewports of one WebGL canvas.
- `src/interaction`, `src/ui`, `src/app`: pointer routing, panel controls, and app wiring.
