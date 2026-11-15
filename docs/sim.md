# Gekko MuJoCo rehearsal

## Run

Use Python 3.12 from the repository root.

```sh
python3.12 -m venv .venv312
.venv312/bin/python -m pip install -r requirements-sim.txt
.venv312/bin/python -m pytest -q -s tests/test_sim.py
npm ci --prefix tests
npm test --prefix tests
.venv312/bin/python -m scripts.demo_sim
.venv312/bin/python -m scripts.sim_benchmark
.venv312/bin/python -m scripts.sim_parallel_check
.venv312/bin/python -m sim.server
```

The demo runs both single-box colours, one deliberately high sweep, and a complete top-to-bottom three-box sequence. It exits nonzero if a required sort fails. A bounded search can establish success, or that the tested actions all failed.

The [physics service](sim-protocol.md) is required for sweeps in the main workbench. The project's separate
Python 3.14 environment remains available for the fake observer.

## Python API

```python
from sim.api import (
    apply_result, build_scene, feasible_tilts, robust_score, rollout, rollout_sequence,
)

scene = build_scene(snapshot)
result = rollout(scene, action)
robust = robust_score(scene, action, trials=10, seed=42)
next_scene = apply_result(scene, result)
sequence = rollout_sequence(scene, actions, seed=42)
tilts = feasible_tilts(scene, target_id)
```

A scene stores an immutable copy of the input snapshot and config. The
simulation shares compiled read-only model definitions within a process and
allocates fresh state for every rollout. Snapshots contain one optional
sweeper and any number of independent boxes. Use the workbench
`instanceId`, `position` (centre for boxes), `baseZ`, `dimensionsMm`,
`massG`, `color`, and optional `friction`. The sweeper root uses
`position.x`, `position.y`, and `baseZ`. Arbitrary inventory shapes
raise an input error. Resumed box poses additionally take `roll`, `pitch`,
and `yaw` in degrees, composed Z–Y–X.

Actions provide `target`, `tilt_deg`, `sweep_start_deg`, `sweep_end_deg`,
and optionally `speed_deg_s`. Each action starts at its parked angle and
the requested manual tilt. The repositioning and tilt change happen before
the trial. Any initial collision beyond the overlap tolerance rejects the
start pose. The servo follows a speed-limited position setpoint with capped
output torque. Independently of the soft solver limit, the two travel stops
clamp excessive travel and absorb outward angular velocity.

Results are JSON-compatible dictionaries. A nominal score is 1 for a success
and 0 for any failure. The reason states why the result failed. `target.pose`
contains centre, orientation and lowest point `baseZ`. `trajectories` holds 60 Hz
samples `[t_s, x, y, z, roll, pitch, yaw]` keyed by box ID and `stick`, using
the collision geometry centre for the stick. `contacts` records first
contact per pair. `others` holds the **maximum** centre displacement over
the whole trial for other parcels initially supported over the bench. Already
collected parcels remain colliders in the viewer but are not required to remain
upright on the bench. Also returned are final poses, final servo angle, actual
trial tilt, peak applied torque and separate pre-contact stall status.

A bag is a region from the floor to its rim. A landing needs floor contact,
a final centre inside that opening and the whole box below the rim. Bag
walls and bottoms are rigid collision geometry. The servo, can, and riser are rigidly
anchored through the evaluated tilt hinge. Boxes have free joints and are
supported by contact. Other parcels must remain upright and settled with a
chain of final contacts to the bench. An action succeeds only when the stick
contacts the target, the assigned bag catches it, the servo avoided a
pre-contact stall, and the remaining parcels stay within the distance and
stability tolerances. A box colour looks up its destination in the rig
config. An explicit destination is accepted for a box without a colour.

`physics_params` accepts `friction_scale`, `mass_scale` and
`position_offset_mm: [dx, dy]` as common values or maps by ID. It also
accepts `tilt_offset_deg` and `max_torque_nm`. Box friction can be a
sliding coefficient, a three-component list, or an object with sliding,
torsional, and rolling components. The contact model uses sliding and
torsion (MuJoCo condim 4). Robustness applies independent uniform perturbations
per box to friction, mass and each tabletop axis, plus one tilt perturbation
per trial. Out-of-limit realized tilts count as failures. Nominal rollouts are
deterministic and use no random draws.

`apply_result` carries forward all unsorted box poses and sweeper angles.
It removes the target if physically caught by either bag, including a
wrong-bag landing. A rejected action leaves its input scene as-is.
Sequence entries start at rest and use the requested tilt and parked angle
at each stage. Plan top → middle → bottom. `feasible_tilts` uses a sampled
oriented-box intersection test to find approaches from either side. It
constrains where to search. Physics establishes whether a push sorts.

## Current inputs and placeholders

All physical dimensions and masses below are unmeasured. Stored geometry is
mm, mass is g, and angles are degrees in the z-up table frame. The engine
converts to SI within `sim/`. The viewer continues to use its existing
`toThree` frame conversion.

The authoritative values are in `config/rig.json`, `config/models.json`,
`config/sim.json` and `config/scoring.json`. Current geometry uses a 220 × 350 mm
bench, 95 × 70 × 25 mm parcels and a can of radius 26.5 mm and length 100 mm.
All measurements and material coefficients remain placeholders.

Validation includes rest stability, geometry clearance, real stick contact and
box displacement, both bag destinations, top-to-bottom sorting, repeatability,
parallel isolation, and capped actuator torque. The browser integration also
checks actual-angle playback, final oriented poses and cancelled requests.

## Viewer verification and asset rebuilding

In separate terminals from the repository root:

```sh
.venv312/bin/python -m http.server 8081 --bind 127.0.0.1
.venv312/bin/python -m sim.server
# Optional observer UI, independent of MuJoCo:
.venv312/bin/python scripts/fake_observer.py
```

Open `http://localhost:8081/viewer/`. Capture/upload a box and a sweeper, place
them, select the sweeper and use **Find & run physical sweep**. For a camera-free
three-box fixture, open `http://localhost:8081/tests/physics-smoke.html` and run
three searches successively. Boxes should move, rotate and fall into the bins
in the main scene, and remain there. Releasing **Sweep** instead runs the current
manual tilt from the current servo angle to the selected endpoint (280°/s).
A missed sweep really misses; it does not invent contact. For a single box near
the default pick location, about 25.5° tilt with a full sweep is a useful starting
point. Park at either endpoint before changing manual tilt.

The compact placeholder servo case is 18 × 10 × 12 mm. Its 1 mm saddle embeds
0.5 mm into the can's crown, and the continuous shaft/horn connects the case to
the stick. The can is now 70 mm behind the stack; this keeps the shorter mount's
sweep reachable. The 27° upper tilt stop keeps the stick clear of the bench.
The viewer and MuJoCo read the same physical configuration. Dimensions, mass,
friction and torque still need hardware measurements; these are not calibrated
predictions. Physics covers boxes, bench, bins and sweeper primitives. Unknown
inventory shapes are rejected explicitly. Each sweep begins from rest; retained
poses are supported, but continuous velocity between requests is not modeled.

Rebuild the permanent assets with Blender (no application runtime dependency):

```sh
blender --background --factory-startup --python scripts/generate_models.py
npm ci --prefix tests
node scripts/sync-model-metadata.mjs
npm test --prefix tests
.venv312/bin/python -m pytest -q -s tests/test_sim.py
```

The metadata sync reads the actual GLBs through Three.js and records the fitted
config geometry used by the viewer. Restart `sim.server` after code/config
changes and open a fresh viewer tab. Existing camera photographs remain in their
original tab; refreshing it clears that tab's in-memory inventory.
