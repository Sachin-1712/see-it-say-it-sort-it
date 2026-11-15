## Current update — real decentralized planning

`swarm/` now implements independent MuJoCo worker processes, peer UDP gossip,
versioned disk checkpoints, role reassignment, real Kill/Silence controls and
complete-plan validation. Normal viewer frames come from `python -m swarm.server`.
The viewer has a built-in three-box fixture and independent labelled ghost
worlds; the solid scene is not changed by planning. UNO Q execution was explicitly
deferred by the operator. See docs/swarm.md for verified behavior, test reports
and known physical assumptions. The earlier audit below is historical.

## Current update — compact mount and main-workbench physics

The mount now uses a compact 18 × 10 × 12 mm case, seated saddle and connected
shaft/horn. Both permanent GLBs have been rebuilt with Blender. Shared config
sets the matching MuJoCo collision geometry. The main workbench's Sweep control
now runs MuJoCo and plays solved box and actual joint trajectories, retaining
final poses. Find & run physical sweep searches for the top remaining box.
The service on localhost:8766 is required; no collisionless fallback is used.
Observer/hardware protocol on 8765 is unchanged. See docs/sim.md and
/tests/physics-smoke.html for operation and limitations. The audit below is
historical and predates these simulation changes.

# State of the repo after merging origin/main

Written Sun 15 Nov 2026 on branch `viewer-polish`, at merge commit `efd041a`.

## 0. What the merge did

- `origin/main` was two commits ahead of the shared base `2cf782f`, both Joe's:
  `2282710` (camera inventory, GLB models) and `ae4c804` (workbench placement,
  materialization).
- This branch was one commit ahead: `346c7ad` (rendering polish, all in
  `viewer/index.html`).
- The merge conflicted in `viewer/index.html` only. Main deleted the page's
  inline script and moved it to `viewer/workshop.mjs`; the polish commit rewrote
  that same inline script. A trial three-way merge of the polish onto
  `workshop.mjs` still left 10 conflict hunks.
- On instruction, the conflict was resolved by taking main's file whole.
  **The working tree is now byte-identical to `origin/main`** (`git diff
  origin/main HEAD` is empty) plus this file.
- **The rendering polish from `346c7ad` is not in the running viewer.** It is
  still in history. Missing as a result: the EffectComposer chain (MSAA, GTAO,
  bloom), bevelled table and crate materials, the Free camera button, camera
  move-in and drift, the `?plain=1`, `?ao=0`, `?bloom=0` switches, and the
  parcel and arm rendering described in section 2.
- Nothing was pushed.

## 1. Files changed since `346c7ad`

No file was removed. `viewer/index.html` is the only modified file apart from
`.gitignore`. Everything else is new.

| File | Status | Purpose |
| --- | --- | --- |
| `.gitignore` | modified | Adds `node_modules/` |
| `README.md` | added | Run instructions and a short description of the capture-to-workbench demo. Calls the PRD "the original historical plan" |
| `assets/models/box.glb` | added | Blender-generated box model, 17 KB, metres, Y-up |
| `assets/models/sweeper.glb` | added | Blender-generated can + servo + stick model, 208 KB, metres, Y-up |
| `assets/models/manifest.json` | added | Generated catalogue: per-model dimensions, mass, collision primitives, joints, node names |
| `config/models.json` | added | Hand-written input to the generator: box fallback size, sweeper geometry and joints, workbench placement positions |
| `docs/camera-inventory.md` | added | Capture flow, storage, manual test checklist |
| `docs/models.md` | added | Models, workbench, coordinates, stacking, sweeper joints, materialization, limits |
| `scripts/generate_models.py` | added | Offline Blender (`bpy`) script that builds both GLBs and the manifest |
| `tests/package.json`, `tests/package-lock.json` | added | Node test runner setup: `jsdom`, `three`, `gltf-validator` |
| `tests/capture.test.mjs` | added | 10 tests of the capture dialog against a simulated camera |
| `tests/inventory.test.mjs` | added | 5 tests of `InventoryStore` |
| `tests/models.test.mjs` | added | 8 tests: GLB validity, dimensions, joints, cache |
| `tests/scene-integration.test.mjs` | added | 4 tests: placement, clear during load, materialization cleanup |
| `tests/workbench.test.mjs` | added | 8 tests: stacking heights, sweeper singleton, primitives, particle targets |
| `tests/observer_smoke.py` | added | Drives `fake_observer.py` on a spare port through every command |
| `viewer/index.html` | modified | Inline script removed (86 lines added, 698 removed). Adds workbench toolbar, sweeper setup panel, Inventory tab, model preview panel, capture dialog. Loads three module scripts |
| `viewer/inventory.css` | added | Styles for inventory, capture dialog, preview, workbench toolbar |
| `viewer/workshop.mjs` | added | The old inline script, cut down: scene, room, table, zones, bags, ghosts, best path, camera, agent/outcome/item panels, WebSocket. Creates the `Workbench` |
| `viewer/workbench.mjs` | added | Scene controller for placed objects: placement queue, click-to-select, tilt and servo sliders, joint easing |
| `viewer/workbench-state.mjs` | added | Plain-data state of placed objects (mm, Z-up): stack heights, positions, joint targets, snapshot |
| `viewer/inventory.mjs` | added | Capture dialog: webcam, upload, identity form, inventory cards |
| `viewer/inventory-store.mjs` | added | In-memory records and photo blobs. No WebGL or WebSocket |
| `viewer/model-preview.mjs` | added | Second WebGL canvas that previews one inventory object with orbit controls |
| `viewer/materialization.mjs` | added | 1.2 s photo-to-particles-to-model effect in the preview canvas |
| `viewer/surface-points.mjs` | added | Area-weighted sampling of mesh surfaces for the particle targets |
| `viewer/model-assets.mjs` | added | `ModelLibrary` (manifest and GLB cache, clone, metres-to-mm scale) and `applyJoint` |
| `viewer/asset-router.mjs` | added | Known types load a GLB; `unknown` builds a primitive |
| `viewer/assets.mjs` | added | The one shared `ModelLibrary` and `AssetRouter` |
| `viewer/primitive-models.mjs` | added | Cuboid, cylinder, bottle, mug built in three.js from typed-in dimensions |
| `viewer/tabs.mjs` | added | Tab switching for Inventory, Agents, Outcomes |

Unchanged by main: `CLAUDE.md`, `config/rig.json`, `docs/PRD.md`,
`docs/viewer-frame.md`, `scripts/fake_observer.py`, `.claude/launch.json`.

## 2. The workflow the code implements

There are now two flows in one page that do not talk to each other.

**Flow A, capture to workbench (Joe's, all in the browser)**

| Step | What happens | Real or placeholder |
| --- | --- | --- |
| Camera | `inventory.mjs` opens the webcam with `getUserMedia`, or takes a JPG/PNG/WebP upload. The frame is resized to 1280 px and kept as a JPEG blob in memory | Real capture. **No vision**: nothing reads colour, position or shape from the image. This is not the PRD's overhead `vision/` camera |
| Identity | The person picks Box, Cylindrical Sweeper or Other, and for a box a routing colour | Manual. Colour-to-bag lookup uses `rig.json` |
| Inventory | `InventoryStore` holds one record per type plus any number of `unknown_###` records. Lost on reload | Real, in memory only |
| Materialization | The photo dissolves into 1,800 points that settle on the model surface | Visual effect only. The model is the fixed GLB, not built from the photo |
| Placing | Clicking a card fires `worldplace`. `Workbench.place` clones the model and puts it at a fixed spot from `models.json` | Real rendering. Positions are fixed display slots, not chosen or measured |
| Stacking | Each further Box click adds a box at the same x, y with `baseZ = table.height + sum of box heights below` | Arithmetic only. No collision, gravity or stability check |
| Sweeper tilt | Selecting the sweeper shows two sliders: whole-assembly tilt (limits -35 to 35) and stick rotation (0 to 180). Joints ease with an 80 ms time constant | Visual only. The panel says "no hardware commands" and sends none. All axes, pivots and limits are unmeasured |

**Flow B, observer to viewer (from before the merge, now reduced)**

| Step | What happens | Real or placeholder |
| --- | --- | --- |
| Agents | `fake_observer.py` holds 8 agent records with roles, takeover after 2 s, silence cycling | Placeholder. One process, no search, no UDP |
| Simulation | Ghost paths are made-up slides; success is a 1 in 6 dice roll; robust score is a random number | Placeholder. The script says so in its docstring |
| Observer | Sends a frame 10 times a second on `ws://localhost:8765`, accepts five commands | Real WebSocket, fake content |
| Viewer | `workshop.mjs` draws room, table, zones, bags, and fills the Agents and Outcomes tabs, the Observer parcels list and the Send button | Real |
| Ghosts and best path | Still coded, but hidden until "Show observer rehearsals" is ticked. Off by default | Real rendering of fake paths |
| Parcels and arm in 3D | **Removed on main.** `workshop.mjs` no longer draws observer parcels or the arm. `frame.arm.angle` and `items[].pose` are ignored by the 3D scene. Items appear only as rows in the list | Gone |
| Arduino | The Send button sends `{"cmd":"execute"}` to the observer, which animates its own fake arm angle | Placeholder. No serial, no network call to a board, no firmware in the repo |

**What links A and B:** only the `colour_to_bag` table in `rig.json`. Objects
placed on the workbench are never sent to the observer, and observer items
never appear on the workbench.

## 3. Wire formats

### WebSocket frame, observer to viewer

Unchanged by the merge. `fake_observer.py` sends exactly these seven keys
(`tests/observer_smoke.py` asserts the set).

| Field | Type | Fake observer sends | Viewer uses it for |
| --- | --- | --- | --- |
| `phase` | string | `searching`, `ready`, `executing`, `done` | Top bar, Send button text, when to clear ghosts, switch to Outcomes on `done` |
| `items[].id` | string | `p1`, `p2` | Row label |
| `items[].color` | string | `red`, `blue` | Row swatch |
| `items[].zone` | string | `scan`, `pick`, `binned` | Row text, finding the target |
| `items[].pose` | `{x, y, theta}` mm, degrees | yes | **Not used** since the merge |
| `items[].bin` | `left`, `right` | never null | Row text |
| `items[].status` | string | `waiting`, `planning`, `ready`, `sorted`, `missed` | Row chip |
| `arm.angle` | degrees | yes | **Not used** since the merge |
| `agents[].id`, `role`, `alive`, `silenced`, `tries`, `robust` | | all six | Agents tab |
| `ghosts[].agent`, `parcel`, `success`, `path` | path is `[[x, y, z, theta], ...]`, 24 points | up to 4 per live agent | Ghost lines, success count |
| `best.agent`, `robust`, `goal`, `action` | `goal` is `{parcel, bin, avoid}`, `action` is `{arm, start, end, speed}` | `null` until a success | Best percentage, goal text, Send enable |
| `result` | `null` or `{parcel, bin, landed, predicted, actual}` | set on `done` | Outcomes table |

Viewer to observer: `{"cmd":"die","id":"a1"}`, `{"cmd":"silence"}`,
`{"cmd":"unsilence"}`, `{"cmd":"replan"}`, `{"cmd":"execute"}`. All five are
sent by `workshop.mjs` and handled by the observer.

**Differences from PRD section 7 and `docs/viewer-frame.md`**

- No field has been added, removed or renamed. The two documents agree with
  each other and with the code.
- `phase: "idle"` is in the spec but the fake observer never sends it.
- `items[].bin: null` is allowed by the spec but never sent.
- `best` carries no path. The viewer guesses it from the newest successful
  ghost of the best agent. A real observer may need to send the path.
- `ghosts[].path` z is measured from the floor (table top is z = 40 plus half
  the parcel height). The spec does not say where z = 0 is.
- `result.predicted` and `result.actual` are `{x, y, theta}`. PRD section 7
  leaves them as `{...}`; `viewer-frame.md` spells them out.

### UDP messages

**None exist in code.** PRD section 7 defines `best` and `ctl` JSON messages
between agents and to the observer, including `ctl` commands `replan`,
`execute` and `items`. Nothing in the repo opens a UDP socket. There is
nothing to compare field by field.

### New data that is not in section 7

These are in-page only and are not sent anywhere:

- DOM events: `inventorychange`, `inventorypreview`, `worldplace`,
  `workbenchchange`, `workbenchclear`.
- `workbenchState.snapshot()`: `{mode: "visual-placement", units: "mm", axes:
  "Z-up", selectedId, objects: [...]}`. Each object has `instanceId`,
  `inventoryId`, `modelKey`, `name`, `type`, `stackIndex`, `color`,
  `destination`, `position {x, y, z}` (z is the centre), `baseZ`,
  `dimensionsMm`, `collision`, `definition`, `massG`, `friction`,
  `approximation`, `placeholderMeasurements`, `tiltDeg`, `servoDeg`,
  `jointLimits`. This is the obvious hand-off to a simulation, and it is a
  different shape from the PRD's `item` and `pose`.

## 4. Where sizes and positions come from

Every number below is a placeholder unless marked otherwise. `rig.json` opens
with "PLACEHOLDER measurements" and `models.json` says all geometry is
provisional. **No value in the repo has been measured from hardware.**

| Source | Values | Flag |
| --- | --- | --- |
| `config/rig.json` | Table 240 x 170 x 40. Arm pivot (120, 150), length 90, height 18, rest 0, direction -1. Pick zone (120, 105) 80 x 50. Scan zone (120, 28) 80 x 40. Bags at x = -35 and 275, y = 100, 60 x 90 x 32. Parcels p1 50 x 35 x 20, 25 g; p2 45 x 35 x 22, 22 g. red to left, blue to right | Placeholder |
| `config/models.json` box | Fallback 50 x 35 x 20, 25 g, used only if `rig.json` has no p1 | Placeholder |
| `config/models.json` sweeper | Can radius 33, height 110, 55 g. Servo pivot (0, -8, 122), axis +Y, case 23 x 24 x 12, 9 g, limits 0 to 180. Stick 180 x 9 x 3, pivot 8 from the end, 6 g. Tilt pivot (0, 0, 0), axis +X, limits -35 to 35. Friction null | Placeholder, and says so |
| `config/models.json` workbench | Stack at (145, 75), sweeper at (52, 120), other objects from (55, 40) | Display slots, not measured |
| `assets/models/*.glb` | Geometry baked from the two config files at generation time | Stale if either config changes; rerun Blender |
| `assets/models/manifest.json` | Copy of the above plus derived sweeper envelope 205.6 x 67.2 x 137.0 and total mass 70 g. Marks both models `placeholderMeasurements: true` | Generated |
| `scripts/generate_models.py` | Hard-coded detail geometry: can rims +0.6 radius, ribs, servo horn radius 6, screw, bracket, bevels, decal sizes as fractions of the box | Cosmetic, hard-coded |
| `viewer/workbench-state.mjs` | Hard-coded fallbacks: table height 40, stack (145, 75), sweeper (52, 120), other (55, 40), 55 mm spacing between unknown objects, default dimensions 66 x 66 x 125 when a model has none | Duplicates `rig.json` and `models.json` |
| `viewer/workshop.mjs` | Room extents (-800, table + 120, -700, table + 70, height 520, grid step 40). Bag wall thickness 2.5 and rim 3. Zone line 1.2. Label heights 7 and 9. Ghost dot radius 2.4. Camera azimuth -28, elevation 34, field of view 30 | Cosmetic, hard-coded |
| `viewer/index.html` capture form | Default dimensions for Other: 45 x 45 x 80. Allowed range 1 to 2000 | User-entered |
| `viewer/primitive-models.mjs` | Bottle, mug and handle profiles as unit-size fractions, then scaled to the typed-in size | Shape guesses |
| `scripts/fake_observer.py` | Random pose margin 12, theta within 20, failed slides 10 to 60, 24 path points, gravity 9810 mm/s² over 0.04 s steps, action angle ranges, noise of 6 mm and 8 degrees on the "actual" result | Fake data |

Two things to note:

- The sweeper stick is 180 mm in `models.json`. `rig.json` has the arm at
  90 mm and the PRD says under 10 cm. These describe the same part.
- The sweeper servo axis is horizontal (+Y) in `models.json`. `rig.json` and
  the PRD have a vertical axis sweeping flat across the table.

**Every unit conversion**

| Where | Conversion |
| --- | --- |
| `scripts/generate_models.py`, `MM = 0.001` | Config millimetres to Blender metres |
| `viewer/model-assets.mjs`, `ASSET_TO_VIEWER_SCALE = 1000` | GLB metres back to viewer millimetres, as a scale on the cloned root |
| `viewer/workshop.mjs`, `DEG`, inside `toThree` | Degrees to radians for yaw |
| `viewer/model-assets.mjs`, `applyJoint` | Degrees to radians for joint angles |
| `scripts/generate_models.py`, `math.radians` | Degrees to radians for mount roll and servo rest |
| `scripts/generate_models.py`, `material()` | sRGB hex to linear colour. Not a length |
| `scripts/fake_observer.py` | None. Works in mm and degrees throughout |

Masses stay in grams everywhere. Nothing converts to kilograms.

## 5. Coordinate conventions

- **Simulation and config frame:** millimetres and degrees. Origin at the
  front-left corner of the table footprint on the floor. x to the right, y
  away from the front edge, z up. Angles counter-clockwise seen from above,
  0 along +x. The table top is at z = `table.height`.
- **three.js scene:** millimetres, Y-up. X = x, Y = z, Z = -y.
- **GLB files:** metres, Y-up, same axis mapping.

Functions that cross between frames:

| Function | File | What it does |
| --- | --- | --- |
| `toThree({x, y, z, theta})` | `viewer/workshop.mjs:21` | Returns `pos = (x, z, -y)` and `yaw = theta` in radians. The one pose conversion in the viewer. Passed into `Workbench` rather than copied |
| `place(obj, pose)` | `viewer/workshop.mjs:63` | Thin wrapper that applies `toThree` to an object |
| `pathPositions(path)` | `viewer/workshop.mjs:234` | Maps ghost path points through `toThree` |
| Blender exporter, `export_yup=True` | `scripts/generate_models.py` `export()` | Rotates Z-up to Y-up when writing the GLB |
| `gltf_vector((x, y, z))` | `scripts/generate_models.py` | Returns `[x, z, -y]` for joint axes stored in the manifest. A second, offline copy of the same mapping |
| `ModelLibrary.instantiate` | `viewer/model-assets.mjs:31` | Applies the 1000 scale only and deliberately no rotation, because the GLB is already Y-up |

Places that work in three.js axes directly, without going through `toThree`:

- `block(w, d, h)` in `workshop.mjs` builds `BoxGeometry(w, h, d)`.
- `primitive-models.mjs` builds shapes Y-up and maps width to X, height to Y,
  depth to Z.
- `setBestPath` adds 0.6 to every second component (three.js Y) to lift the
  line.
- Floor and wall grids use `rotation.x = -PI/2` and `rotation.y = -PI/2`.
- `Workbench.bounds()` returns a three.js-frame box that `fitCamera` consumes.

CLAUDE.md asks for the conversion in one function only. For poses that still
holds in the viewer. The axis swap is also written out in
`generate_models.py` and implied in the items above.

The arm-angle rule in `rig.json` (`heading = heading_at_zero + direction *
angle`) is no longer implemented anywhere, because the arm is no longer drawn.

## 6. What exists for MuJoCo, physics or agents

- **MuJoCo:** nothing. No `sim/` directory, no import, no MJCF or URDF. The
  repo's `.venv` is Python 3.14.6 with only `websockets` installed. The PRD
  says to use 3.11 or 3.12 and not 3.14, and to install `mujoco`, `numpy`,
  `pyserial` and `opencv-python`. None is installed.
- **Physics:** nothing. The only physics-like code is the free-fall line in
  `fake_observer.py` and the stack-height sum in `workbench-state.mjs`.
- **Physics inputs that are ready to use:** `manifest.json` has collision
  primitives (box for the parcel; cylinder plus two boxes for the sweeper),
  masses, joint pivots, axes and limits, in mm and Z-up.
  `workbenchState.snapshot()` gives placed objects with position, size,
  collision and mass. Friction is `null` everywhere.
- **Agents:** nothing real. No `agent/` directory. The 8 agents are objects
  inside `fake_observer.py`.
- **Camera vision, arm driver, firmware:** nothing. No `vision/`, no serial
  code, no Arduino sketch.

## 7. Conflicts, broken code, test results

**Merge conflict:** one file, described in section 0.

**Tests, run on the merged tree**

- `npm test --prefix tests` (Node 24.4.1): **35 passed, 0 failed.**
- `.venv/bin/python tests/observer_smoke.py`: **PASS** (frames, ghosts,
  silence, kill, unsilence, execute, results, replan).
- No test loads `viewer/workshop.mjs`, so the bug below is not caught.

**Bug found: `parcelSize is not defined`** (fixed after this file was first
written: `parcelSize` is restored in `workshop.mjs` with its original
definition, reading `rig.parcels`. Checked against a fresh fake observer: no
errors, and the page reaches `ready`, 95%, Send to Arduino enabled. The
description below is of the bug as found on main.)

- `viewer/workshop.mjs:324` calls `parcelSize(parcelId)`. The function was in
  the old inline script and was dropped when parcels were removed. Nothing
  defines or imports it.
- Reproduced in the browser against a fresh fake observer: 98 uncaught
  `ReferenceError: parcelSize is not defined` in 20 seconds, starting when
  the first successful push appeared.
- The throw is inside `renderFrame`, before `renderTop`, `renderAgents`,
  `renderOutcomes`, `renderItems` and `renderSend`. So from the first
  successful push onward the top bar, Agents tab, Outcomes tab and items list
  stop updating, and **Send to Arduino never enables**. The page looks alive
  because the 3D scene keeps drawing.
- The capture, inventory, preview and workbench flow is not affected.

**Other things that no longer work or are dead**

- `parcelZ` and `onTable` in `workshop.mjs` are defined and unused.
- The comment at `workshop.mjs:356` says "O" toggles orbit for debugging, but
  orbit now starts on. `resize()` therefore never calls `fitCamera`, so the
  view is not refitted when the window changes size until "Reset view" is
  pressed.
- The header comment in `workshop.mjs` still says parcels render in their own
  pass. There is one pass and no parcels.
- Imports all resolve. The page loads with no console errors until a best
  push arrives.

**Environment notes**

- Port 8080 (static server) and port 8765 (fake observer) were already
  running from this folder before this session. The observer on 8765 has all
  8 agents killed, so it will sit in `searching` with no best until it is
  restarted. That also hides the bug above.
- `tests/node_modules` is not installed in this checkout. Run
  `npm ci --prefix tests` first.

## 8. Where the code contradicts the PRD

| PRD says | Code does |
| --- | --- |
| Non-goal: no stacked parcels (section 3, and "Cut: stacks, tilting, photo-to-3D") | Box clicks build a stack with no height cap |
| Non-goal: no tilting | The sweeper has a manual tilt slider, -35 to 35 degrees |
| Non-goal: no photo-to-3D. Never say "generated from a photo" (section 11) | The photo visibly turns into the 3D model, with the status text "Forming your 3D representation…". The model is a fixed GLB and the docs say so, but the effect suggests otherwise to a judge |
| Parcels are boxes described by three measurements | Also a sweeper model, and cylinder, bottle and mug shapes |
| 6.9: table, arm, zones, bags and parcels drawn from `rig.json` | Arm and parcels are no longer drawn. `rig.json`'s `arm` and `parcels` are not read by the viewer |
| 6.9: ghost attempts per agent | Hidden behind a checkbox that is off by default |
| 6.9: fixed three-quarter camera | Orbit controls are on by default |
| 6.9: right panel tabs are Agents and Outcomes | A third tab, Inventory, is first and selected by default |
| 6.9: Send to Arduino enabled at robust 0.8 or more | On main it never enables, because of the `parcelSize` bug. Fixed on this branch |
| 6.8 and milestone 6: fixed overhead camera reads colour, centre, rotation and zone | The webcam takes a still photo. Identity and colour are picked by hand. No position is read |
| Section 4: arm axis vertical, stick under 10 cm | `models.json` sweeper: horizontal shaft, 180 mm stick |
| Section 4: parcels and arm only | A metal can is part of the arm assembly. The PRD does not mention one |
| Section 5: Python 3.11 or 3.12, not 3.14; install mujoco, numpy, pyserial, opencv | `.venv` is 3.14.6 with websockets only |
| Section 7: "agree and commit before coding"; UDP `best` and `ctl` | No UDP code. A new, unagreed scene format (`workbenchState.snapshot()`) exists alongside `item` and `pose` |
| Milestones 1, 2, 3 (simulation, swarm, servo rig), owner Joe | Not started in this repo |
| README | States "newer scoped requirements supersede [the PRD's] older exclusions". Those newer requirements are not written down in the repo |

CLAUDE.md points:

- "Single static page, three.js from a CDN, no build step, no framework" still
  holds. The page is now 14 module files, and a second WebGL renderer runs for
  the preview. `tests/` uses npm but the viewer does not.
- "Do not change the data formats" holds. Section 7 and `viewer-frame.md` are
  untouched.
- "I own the viewer only": main's two commits rewrote the viewer.
