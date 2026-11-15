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

The demo runs both single-box colours, one deliberately high sweep, then the
top of a three-box stack. The exit code is nonzero if either nominal single-box
sort fails or the deliberately bad sweep succeeds or is invalid. The stack
row reports the best observed binary score and its actual failure reason. A
bounded search can establish success, or that the tested actions all failed.

The [preview service](sim-protocol.md) is optional. The project's separate
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
contains centre, orientation and lowest point `baseZ`. `trajectories` holds 20 Hz
samples `[t_s, x, y, z, roll, pitch, yaw]` keyed by box ID and `stick`, using
the collision geometry centre for the stick. `contacts` records first
contact per pair. `others` holds the **maximum** centre displacement over
the whole trial. Also returned are final poses, final servo angle, actual
trial tilt, peak applied torque and separate pre-contact stall status.

A bag is a region from the floor to its rim. A landing needs floor contact,
a final centre inside that opening and the whole box below the rim. Bag
walls are absent from the model. The servo, can, and riser are rigidly
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

| Source | Field | Value |
| --- | --- | --- |
| rig | Bench | Width 250, depth 300, thickness 25, top height 90 |
| rig | Pick zone | Centre (125, 135), 110 × 85 |
| rig | Scan zone | Centre (125, 47.5), 110 × 85 |
| rig | Bags | Left centre (−65, 135), right (315, 135). Both 130 × 160 × 90, from z = 0 |
| rig | Parcels p1 and p2 | 95 × 70 × 25, 30 g each |
| rig | Routing | Red → left, blue → right |
| models | Can | Radius 25, length 90, 40 g, back centre (0, 45, 25.6), axis (0, −1, 0) |
| models | Tilt | Pivot (0, −45, 0), axis (1, 0, 0), 0–32.5° |
| models | Servo | Shaft pivot (0, −36, 82), axis (0, 0, 1), mount roll 0°, rest 0°, direction −1, travel 0–180° |
| models | Servo case, riser and horn | Case 23 × 12 × 23, mass 9 g, riser 6.4, case-to-shaft gap 2, horn rise 3 |
| models | Stick | 145 × 10 × 3, 2 g, pivot 5 from rear end |
| models | Placement | 50 from box back face to can front. Visual Other slots start at (40, 245), spacing 170, two slots |
| models | Friction | Unset. The engine uses the sim defaults unless the snapshot supplies a coefficient |
| sim | Physics | 1 ms step, gravity 9.81 m/s², 30 solver iterations, implicitfast |
| sim | Default friction | Sliding 0.32, torsional 0.002, rolling 0.0001 (stored, inactive in condim 4) |
| sim | Contact compliance | solref (0.008, 1.0), solimp (0.9, 0.95, 0.001, 0.5, 2) |
| sim | Servo envelope | 0.15 N·m cap, default 60°/s, limit 360°/s, position gain 2 N·m/rad, damping 0.012 N·m·s/rad, armature 0.00002 kg·m² |
| sim | Stall criterion | Torque saturated for 0.06 s with at least 4° lag and at most 8°/s angular speed |
| sim | Trial timing | 0.15 s settle before, 0.65 s after, 12 s maximum commanded sweep, 20 Hz sampled |
| sim | Search resolution and candidate grid | Tilt 0.5°, servo 1°, offsets 0°, 6°, 12°, speeds 90, 150, 220, 60, 320°/s |
| scoring | Scoring tolerances | Other displacement < 5 mm, upright within 10°, settled speed ≤ 5 mm/s, floor/start height within 2 mm, initial overlap ≤ 0.2 mm |
| scoring | Robustness ranges | Friction ±20%, mass ±15%, initial x/y ±3 mm per axis, tilt ±1° |

Can rims, ribs, and fasteners are visual details excluded from the
manifest collision shapes. The case-to-shaft and horn offsets are
explicit in models config and match the current viewer fit constants.
If those two measured offsets change, update the viewer fit in its own
change. Simulation never opens a hardware connection.

## Verification on the development M2

The viewer tests and a separate primitive geometry scan are reproducible
without the physics package. The viewer fit test reports 1.41 mm minimum
visual stick clearance and a 9.5–19° straight-slide top-box tilt band.
The geometric primitive scan reports 1.254 mm minimum sampled stick clearance
and an 83.933 mm drop at the forward tip across the tilt range. At the current
0.5° search resolution, the centred single box only has sampled approaches
at 32.5°. In the intact three-stack there are 56 sampled top-box approach
tilts and zero clear first-contact tilts for the middle and bottom boxes.

The development session could not resolve PyPI, and the Python 3.12
environment lacks MuJoCo and pytest. Simulated drift, landings, servo
loads, robustness, throughput, and eight-process replay are unverified.
Loopback socket binding was also denied, so live preview was unverified.
