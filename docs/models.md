# Models, inventory and interactive workbench

The current flow is **Capture → confirm identity → photo materialization → inventory → click to place**.
There is one reusable Box type, one Cylindrical Sweeper type, and any number of
individually named unfamiliar objects. The workbench starts empty, including when
the mock observer is already broadcasting parcels. This milestone provides
visual placement and setup, not a validated physics simulation.

## Run and test

From the repository root:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open <http://localhost:8080/viewer/>. Refresh existing tabs to load changes;
photographs and placed objects are intentionally held in memory for that tab.
The app has no build step or frontend npm dependency. Three.js still comes from
the existing CDN. WebGL is required for 3D; capture/inventory is independent of
the observer connection and is separately initialised.

To run the optional mock observer in another terminal:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install websockets
.venv/bin/python scripts/fake_observer.py
```

The observer still uses `ws://localhost:8765` and the original frame and command
formats. Kill, silence, unsilence, replan, execute and outcome displays are
preserved. New placement, particle and tilt controls send no hardware commands.
The legacy **Send to Arduino** button retains its existing explicit execute
command; no automatic execution or physical confirmation workflow was added.

## Demo checklist

1. Load a new tab: the workshop, grid, workbench and neutral bags appear, with
   zero boxes and no sweeper. Observer parcel rows may appear under **Observer
   parcels**; those are telemetry and do not spawn objects.
2. Click **Capture Object**, permit the camera, photograph a box and choose
   **Box**. Alternatively upload a real JPG, PNG or WebP photograph. Confirm
   **Add to Inventory** to see the photograph dissolve into surface particles,
   converge, and reveal the neutral-grey 3D representation.
3. Click the **Box** card three times. It reads **Box × 3** and three independent
   models appear on the workbench at the same horizontal position, stacked by
   their model heights. Further clicks continue the stack without a three-box cap.
4. Capture and select **Cylindrical Sweeper**. Click its card to place it beside
   the stack. Further clicks select that same instance rather than duplicating it.
5. Click the sweeper in the workshop (or select it in **Select placed object**).
   Adjust **Manual tilt** and **Stick rotation** independently. The complete
   can/servo/stick assembly tilts about its configured pivot; the servo output
   rotates just the stick. These are visual setup controls, not motor commands.
6. Capture an unfamiliar object with **Other object · approximation**. Give it a
   name, choose Cylinder, Bottle, Mug or Cuboid and enter width/depth/height in mm.
   Confirm it into the same inventory. Its approximate geometry gets the same
   materialization transition and can be placed using its card.
7. Use **Preview** to rotate/zoom an acquired object. **Reset view** resets the
   preview camera; **Replay transition** repeats the contained effect. Keyboard
   preview controls: arrows rotate, `+` / `-` zoom, Home resets.
8. Use **Clear workbench**: placed objects disappear while inventory photos
   remain. Wait for observer frames; the bench stays empty. A placement still
   loading when Clear was pressed is canceled, so it cannot reappear later.
9. Use **Show observer rehearsals** to opt into the legacy ghost paths and best
   attempt overlay. It defaults off and resets off on Clear. Agents and Outcomes
   remain available in their existing tabs.
10. Disconnect the observer and repeat capture, preview, placement and tilt. Those
    actions use local scene state, not observer data. Enable reduced motion in the
    OS/browser: materialization skips directly to the opaque model, and setup
    rotations respond immediately.

## Permanent known models

Only two categories load permanent GLBs:

| Category / model key | Asset | Geometry source |
| --- | --- | --- |
| `box` | `assets/models/box.glb` | `config/rig.json` parcel p1: 95 × 70 × 25 mm (baked at 50 × 35 × 20, fitted at load) |
| `sweeper` | `assets/models/sweeper.glb` | `config/models.json` sweeper assembly |

The three former box-specific files have been retired. Historical inventory IDs
`box_1`, `box_2`, `box_3` and `sweeper_1` are accepted by the store as aliases of
Box and Sweeper; all new captures use the canonical reusable identities. This
application had no persistent inventory database to migrate. Existing real photo
capture, upload, recapture, routing-colour edits, removal and Blob association
continue to work. Removing an acquired asset does not remove placed instances.

Blender generation is an offline authoring command:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python scripts/generate_models.py
```

If Blender is on PATH, use `blender` in place of that path. Optional paths follow
`--`, for example `-- --config config/models.json --rig config/rig.json --output assets/models`.
Verified using Blender 5.2. The browser never invokes Blender, performs image-to-3D
reconstruction for known objects or generates a new Box mesh for each photo.

The Box uses neutral cardboard, grey tape, a restrained label and a small bevel.
The sweeper uses neutral metal, a graphite servo and a muted grey wooden stick.
All final model materials are opaque. Dimensions and proportions have been kept;
lighting uses controlled PBR environment illumination and soft workshop shadows.

`viewer/assets.mjs` holds one shared `ModelLibrary` and `AssetRouter`. The library
caches each GLB promise by model key, including concurrent requests. Preview and
workbench share this cache. Instances clone the Object3D hierarchy and share the
original geometry/material buffers; transforms and joint quaternions are
independent. Failed loads can retry and never discard a captured photograph.

## Unfamiliar objects

Repository inspection found no pre-existing procedural reconstruction pipeline.
`AssetRouter` now explicitly separates predefined Box/Sweeper loading from a
user-selected primitive approximation. Unknown captures are never silently mapped
to the saved Box. Every unfamiliar capture has a unique `unknown_###` identity,
name, photograph and shape/dimension definition; recapture replaces only that
asset. The approximation generator caches geometry per definition and clones it
for preview/placement. Cylinder, lathed bottle, open mug with handle, and cuboid
shapes are supported. Their final envelope matches the dimensions entered.

This is **manual approximation**, not recognition or accurate reconstruction from
one photograph. Collision metadata for unfamiliar objects is a conservative
bounding box marked approximate. Mass and friction are null until measured.

## Coordinates, geometry and stacking

Config and scene-state records use right-handed **millimetres, Z-up**. Blender
constructs meshes in metres; glTF exports **Y-up**, mapping `(x,y,z)` to `(x,z,-y)`.
`toThree` in `viewer/frame.mjs` is the one z-up to y-up conversion; `scenePose` in `viewer/workshop.mjs` wraps it for placement poses
conversion. `ModelLibrary` scales glTF roots by 1000 and does not rotate them twice.
Procedural approximations are already created in viewer millimetres/Y-up.

Box origins are bottom-centred. For each new box:

```text
baseZ   = table.height + sum(height of every box already below it)
centreZ = baseZ + newBox.height / 2
```

The root is placed at `baseZ`; scene metadata records the centre as `position.z`.
With the bench top at 90 mm and 25 mm boxes, the first three centres are
102.5, 127.5 and 152.5 mm in the absolute table frame (bottoms at 90, 115 and 140).
Visual labels extend at most 0.015 mm above the body and are excluded from its
collision/stacking dimensions. Placement uses asset dimensions, not photo pixels.

The stack sits at the centre of `config/rig.json` `zones.pick`; the sweeper and other
objects use positions in `config/models.json` under `workbench`. `WorkbenchState` has no
built-in sizes or positions and refuses to place anything until configured.
`WorkbenchState` assigns unique `world_box_####`, `world_sweeper_####` or
`world_unknown_####` IDs. IDs do not repeat after Clear. Its snapshot is JSON-ready:

```js
import { workbenchState } from './workbench-state.mjs';
const sceneState = workbenchState.snapshot();
// { mode:'visual-placement', units:'mm', axes:'Z-up', selectedId, objects:[...] }
```

Each instance records its inventory ID, model key, stack index, centre/base
positions, dimensions, routing colour/destination, mass/friction, measurement flags,
collision description and independent tilt/servo targets. Editing the inventory's
routing colour later does not silently relabel already placed instances.
`workbenchchange` DOM events report the same state. Inventory metadata and its
observer-independent `inventorychange` event remain separate. Nothing sends
this newly arranged scene into the old mock simulation or physical hardware yet.

## Sweeper pivots and motion

The hierarchy remains `sweeper → assembly_tilt → can_base_frame → servo_mount →
servo_output → wooden_stick`. The can and case are under the whole-assembly tilt;
the stick/horn are under the servo output. Configurable tilt pivot and axis,
shaft pivot and axis, mount roll, rest orientation, direction and limits live in
`config/models.json`. The default shaft is explicitly horizontal +Y in the
simulation frame. The local glTF output axis is +Y, transformed by the mount.
The controller reads those metadata values instead of assuming a world-vertical
servo axis. It interpolates each setup angle toward its independent target with
an 80 ms exponential time constant and snaps directly under reduced motion.

**All hardware measurements, masses, axes, pivot positions and limits are still
provisional.** The original rig itself marks its measurements as placeholders.
Measure and regenerate before claiming agreement with the physical sweeper.
`assets/models/manifest.json` keeps physical dimensions/collision primitives,
measurement provenance and joint data separate from visual meshes.

## Materialization

Confirmation first preserves the real photo and identity. In the inventory's
preview canvas, the photograph dissolves in small tiles while **1,800 grey/white
points** drift and converge onto area-weighted samples of the actual model's mesh
surfaces. A shader updates a progress uniform over **1,200 ms**; target points are
computed once. The completed opaque mesh is revealed as the particles fade.
Both saved and approximate models use this same path. It visually connects the
photo and its representation; it does not claim photographic reconstruction.

The effect stays inside that canvas and does not pause workshop or agent
controls. Changing objects, removing a capture, hiding the tab or choosing reduced
motion safely cancels/releases temporary textures and particle buffers. Known
models remain cached. No animation or generation library was added.

## Validation and remaining limits

```sh
npm ci --prefix tests
npm test --prefix tests
.venv/bin/python tests/observer_smoke.py
```

The suite covers capture/upload errors and races, arbitrary unfamiliar captures,
known/unknown routing, glTF validation, monochrome opaque materials, unit/origin
checks, cache sharing, independent instances, mixed-height stacking, rapid clicks,
singleton sweeper placement, clear-during-load cancellation, independent joints,
actual surface targets, reduced motion and animation cleanup. Tests use simulated
camera/texture devices; actual WebGL and real capture were also checked in native
Chrome.

Native checks verified an empty connected bench, a real-photo particle transition,
three box clicks/IDs/stack, single-sweeper placement, visible 25° can tilt with 45°
independent stick rotation, an unfamiliar Mug approximation/transition/placement,
and clearing while observer frames continued. Tests used a separate tab; the
original viewer's captured object was preserved.

Remaining limits: manual identity selection; user-entered approximate geometry for
unknowns; provisional hardware measurements; in-memory photos/scene; no collision,
gravity, stability checks, arbitrary object editing or MuJoCo connection. The
unknown placement positions are simple display slots and do not avoid overlap.
There is no measured M2 frame-rate benchmark; particle count and work per frame
are bounded, and the transition was visibly exercised in Chrome.

## Load-time fitting to config (placeholder sizes)

All sizes are placeholders marked `"measured": false`. Boxes come from
`config/rig.json` `parcels`; the can, servo, stick and tilt from `config/models.json`.
Blender has not been rerun: `viewer/model-fit.mjs` measures each part's mesh and
scales it so its bounding box matches config exactly (box body, can, servo case and
stick separately), then moves the tilt pivot, servo mount, rims and stick to their
configured places. `assets/models/manifest.json` collision primitives and joints are
synced to the same values and `tests/fit.test.mjs` checks they agree.

Press **D** in the viewer (or open `?debug=1`) for measured bounding boxes with mm
labels and a 100 mm scale bar. Every refresh prints a `console.table` of each
object's measured size and centre in table-frame mm. The stick reads 120 × 3 × 10 in
x × y × z because it stands on its 10 mm edge with 3 mm along the shaft.

## Lying-can sweeper and the sideways sort

The can (diameter 50, length 90, placeholder) lies on its side along y, behind the stack
on the bench centreline, its front end 15 mm behind the stack, resting on its rims. The
servo sits on a 6.4 mm riser on top of the can near its front end, shaft straight up, so
at tilt 0 the stick's underside is 10 mm above a 3-box stack. Servo 0° points the stick
right (+x), 90° forward over the stack, 180° left. Manual tilt turns the assembly about
an x axis through the can's front-bottom edge: positive tilt lifts the back of the can
and lowers the stick tip. The limits are 0° to 35°; negative tilt would push the back
into the bench. The GLB was baked upright with a horizontal shaft; `model-fit.mjs` turns
the can, rescales its rims and ribs, turns the bracket into the riser, re-parents
`servo_mount` to `assembly_tilt` and sets the shaft vertical at load time.

Reach (kinematic, `tests/fit.test.mjs`, zero penetration of the bench and of any box
other than the one pushed; contact within 1 mm):

- Top box: works for tilt 11.5° to 32°. At 31.5°, red goes left with first contact on
  the right face at servo 0° and the sweep to 176°; blue goes right with contact at 179°
  and the sweep to 4°. The contact point passes each bench edge by 10.0 mm.
- Middle box: not reachable. The stick first reaches its side face at tilt 29.5°, but
  tipping about the front edge also throws the servo forward over the stack, so every
  such pose cuts through the top box.
- Bottom box: not reachable. No tilt within limits brings the stick to its side face.

The stick's swing plane stays 86.5 mm from the pivot line, so at the stack's back face,
15 mm in front of the pivot, it can never come lower than about 85 mm above the bench.
Analytic trials found the middle box reachable only with the stack moved forward into
the scan zone, a 95 mm gap and a 160 mm stick, and the bottom box in none of them.
The kinematic check assumes the pushed box slides straight sideways.
