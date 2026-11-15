# Saved 3D models (Phase 2)

All four real binary assets are committed under `assets/models/`:

| Object | Inventory ID | Model key / filename | Nominal dimensions (mm) |
| --- | --- | --- | --- |
| Box 1 | `box_1` | `box_1.glb` | 50 × 35 × 20 from `rig.json` p1 |
| Box 2 | `box_2` | `box_2.glb` | 45 × 35 × 22 from `rig.json` p2 |
| Box 3 | `box_3` | `box_3.glb` | 55 × 38 × 24 fallback placeholder |
| Cylindrical Sweeper | `sweeper_1` | `sweeper.glb` | Can Ø66 × 110; stick 180 × 9 × 3 placeholders |

**Every current measurement is provisional.** `rig.json` itself labels its values
as placeholders. No physical dimensions, shaft orientation, masses, friction,
pivots or limits have been calibrated by this milestone. The saved models are
reusable approximations until the team measures the hardware.

## Regenerate assets with Blender

From the repository root, using Blender 4.x or 5.x (verified with 5.2):

```sh
blender --background --factory-startup --python scripts/generate_models.py
```

On this Mac, Blender is installed at:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python scripts/generate_models.py
```

Optional paths follow Blender's argument separator:

```sh
blender --background --factory-startup --python scripts/generate_models.py -- --config config/models.json --rig config/rig.json --output assets/models
```

The script uses Blender's `bpy` API to build bevelled cardboard boxes, packing
tape and labels, and the metal-can / servo / wooden-stick assembly. It exports
four self-contained GLBs and `manifest.json`. No textures, external buffers,
compression decoder, web backend or runtime Blender installation is needed.
Capturing/uploading an image only associates a photo and a model key; it never
calls this script or generates geometry.

## Measurement configuration

Edit `config/rig.json` parcel dimensions for p1/p2, and `config/models.json` for
the new asset measurements and hardware geometry. Existing rig and observer
formats have not been changed. Boxes use a matching `rigParcel` if present,
otherwise the explicitly named fallback dimensions and mass. Adding p3 to the
rig later will make Box 3 use that entry automatically.

Sweeper inputs in `config/models.json` are in a can-base-centred Z-up frame:

- `can.radiusMm`, `can.heightMm`: cylinder geometry.
- `assemblyTilt.pivotMm`: complete assembly's manual tilt pivot, relative to the
  can base. `axisZup` is its rotation axis and `limitsDeg` the preview range.
- `servo.pivotMm`: shaft centre in the same can-base frame.
- `servo.axisZup`: measured shaft direction. The **placeholder is horizontal +Y**;
  nothing assumes a vertical shaft. Any nonzero 3-vector is supported.
- `servo.mountRollDeg`: case orientation about that shaft. The script first
  aligns local +Z to the shaft, then applies this roll about local +Z.
- `servo.caseDimensionsLocalMm`: dimensions in the mounted servo's local frame.
- `servo.restDeg`, `direction`, `limitsDeg`: rest orientation, sweep sign and
  preview limits. At rest, the stick's long axis is the output frame's local +X.
- `stick.pivotFromEndMm`: offset from the near end to its attachment point.

Regenerate and re-test after measuring these values. A photo is not used to
infer size or orientation.

## Units, origins and transform hierarchy

Source measurements and future collision descriptions use **mm and Z-up**.
The generator builds Blender meshes in **metres**, then exports glTF **Y-up**.
The mapping is `(x, y, z) -> (x, z, -y)`; Blender's exporter performs that axis
conversion. See the official [glTF export options](https://docs.blender.org/api/5.2/bpy.ops.export_scene.html).

`viewer/model-assets.mjs` clones a loaded asset and scales its root by **1000**
to match the existing millimetre-based Three.js scene. It does not rotate the
asset a second time: the exported basis already matches the viewer's existing
`toThree` function. Future placement can use that existing function for poses.
No new models are placed into the workshop in this phase.

Each box's origin is its **bottom centre**, so a future stack can place its base
at the previous box's top surface. The body has the exact nominal dimensions;
flat visual labels sit up to 0.015 mm above the surface and are excluded from
collision geometry.

The sweeper asset origin is the **can-base centre**. Its hierarchy is:

```text
sweeper
└── assembly_tilt                 complete assembly's configurable tilt pivot
    └── can_base_frame           offset back to the can-base reference
        ├── metal_can / rims / ribs
        └── servo_mount          configured shaft alignment and case roll
            ├── servo_case / bracket
            └── servo_output     independently rotating shaft/output pivot
                ├── servo_horn / screw
                └── wooden_stick
```

The servo output rotates about its **local glTF +Y**, the exported equivalent of
Blender local +Z. The parent mount determines the physical shaft direction.
The default assembly tilt rotates about local glTF +X. `manifest.json` records
the actual configured axes; the preview reads these instead of hard-coding a
world-space rotation. Preview sliders never send WebSocket or Arduino commands.

## Inventory and viewer test

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open <http://localhost:8080/viewer/> and refresh after code changes. No frontend
build or npm install is required for the app. It uses the existing Three.js CDN;
camera/upload and inventory still work if the observer is disconnected. WebGL
and access to that CDN are needed for 3D rendering.

1. Before capture, use **Preview object** or **View 3D** to inspect all four saved
   assets. They are labelled “no photo yet” and are not counted as captures.
2. Click **Capture Object**, take or upload a real photo, select the matching
   identity, select a box colour and confirm. The selected saved model loads in
   the inventory preview beside the real photograph. Repeat for all four slots.
3. Drag the model to rotate; scroll/pinch to zoom; **Reset view** restores the
   camera. Keyboard alternative: focus the preview, use arrow keys to rotate,
   `+` / `-` to zoom and Home to reset.
4. For the sweeper, adjust **Manual can tilt** and **Servo stick rotation**.
   The first moves the whole assembly; the second moves only the stick/output.
   **Reset pose** returns both joints to their configured rest angles.
5. Replace/remove a photo and edit a box colour. Its static asset identity stays
   fixed. The exported cardboard colours are intentionally distinct and fixed;
   the assigned colour controls the inventory's routing label, not mesh geometry.
6. Stop the mock observer and repeat capture / preview. Check that the existing
   Agents and Outcomes tabs still work after reconnecting.
7. If a model file is unavailable, the photo remains in inventory and **Retry
   model load** can retry. Three.js parse/load failures never discard a capture.

The capture flow remains manual identity selection. It makes no AI recognition
claim. Inventory photographs remain in memory for the tab and clear on refresh;
the four saved GLBs are permanent and independent of those photographs.

## Physical metadata and the next phase

`config/models.json` is the editable measurement source; the generated
`assets/models/manifest.json` supplies physical metadata separately from meshes:
dimensions, origin, mass, primitive collision shapes, relative frames, joint
axes/pivots/limits, measurement provenance and placeholder flags. Friction is
explicitly `null` until measured. Node extras identify model keys and joint axes.
Visual bevels, tape, labels and can ridges are not collision geometry.

Future code can use `ModelLibrary.instantiate(modelKey)` for independent
transforms from cached GLBs. Instances share immutable mesh/material resources;
clone materials first if future placement needs per-instance recolouring. It
returns `{ root, metadata, joints }` in viewer millimetres. `applyJoint` applies
local rotations relative to each saved rest pose. The inventory's `list()` and
`getPhoto(id)` API and `inventorychange` event remain available.

Placement, stacking, MuJoCo bodies, autonomous planning and physical Arduino
execution are deliberately outside this milestone. Hardware measurements are
still needed before the sweeper can claim an accurate match to reality.

## Validation

```sh
npm ci --prefix tests
npm test --prefix tests
.venv/bin/python tests/observer_smoke.py
```

The model tests parse every GLB with Three.js 0.170.0 and validate them with the
Khronos glTF validator. They check dimensions, bottom origins, metre/mm scaling,
node hierarchy, a nonvertical shaft, independent rotations, cached loading,
independent instance transforms and retry behavior. The camera integration
suite checks that all four confirmed identities emit the correct preview request
and retain distinct asset keys. Camera/upload regression tests remain included.

Native Chrome verification loaded all four saved assets and exercised the two
sweeper controls. A real webcam photo was confirmed into Box 1; both the photo and
saved Box 1 model appeared together. That temporary test capture was cleared.
Physical measurements and other browser/device combinations need hands-on checks.
