# GEKKO hackathon demo

Use Python 3.13 (the code uses Python 3.12+ syntax):

```sh
python3.13 -m venv .venv
.venv/bin/pip install -r requirements-sim.txt
.venv/bin/python -m scripts.prepare_demo --workers 4 --seed 2026 --timeout 180
.venv/bin/python -m swarm.server
# In another terminal:
.venv/bin/python -m http.server 8000 --bind 127.0.0.1
```

Open http://127.0.0.1:8000/viewer/?offline=1. Load Three-Box Demo → Start agents
→ Kill an agent after it has checkpointed → observe the termination, real heartbeat
timeout, checkpoint takeover and resumed trial counts → Stop Live Search → Load
Previously Validated Plan → Replay Three-Box Solution.

Offline preparation runs four genuine independent MuJoCo processes. It writes
`.gekko/validated-three-box.json` only after a complete plan meets the unchanged
80% robustness threshold in at least 20 full-plan uncertainty trials. The bundle
contains full body/servo trajectories from a fresh nominal MuJoCo rollout,
per-trial realized uncertainty and validator identities, UTC timestamp, origin,
robustness, fixture/configuration/hardware/source/engine hashes and checksum.
Replay consumes these stored tracks without new physics or a new search. Its
persistent label is **PREVIOUSLY VALIDATED — NOT THIS LIVE RUN**. Yellow outlines
show simulation; solid workbench objects describe the setup, not measured physical
state. The expected order is Box A left, B right, C left; that order is discovered
by geometry and physics, not supplied as a plan.

The loader requires the same scenario, physics/config, validation policy, hardware
constraints and implementation/engine version. Bundles expire after 24 hours.
Regenerate after source, fixture, calibration or engine changes; scene edits
invalidate the current task. Checksums detect accidental tampering; bundles are
trusted local evidence, not cryptographically signed third-party certificates.
The cached file is deliberately local and git-ignored. `--output` can archive a
bundle elsewhere; copy it back to the default path to use it in the viewer.

A killed agent is an actual terminated OS process. Takeover appears only after a
survivor's real `task_takeover` event; `work_resumed` requires a subsequent genuine
MuJoCo trial. The display includes checkpoint identity, previous progress and new
trials. Silence, missing checkpoints, delayed heartbeats and a dead successor do
not produce invented recovery. No extra validated result means the banner says
so even when further trials have run. Stopped agents retain their history.

## UNO Q blocker and dry run

Real execution is locked, including when configuration flags are edited. No
serial device is opened and no commands are transmitted. We have not verified
this rig's firmware acknowledgement, servo travel, direction calibration or a
safe serial integration. This deliberately uses the requested disabled-hardware
fallback. No claim of hardware receipt or physical completion is made.

`config/uno-q.json` records opt-in settings, calibrated servo/tilt limits,
calibration identity and explicit **increasing/decreasing simulated angle → L/R**
mapping. A letter is never treated as a physical direction. Changing it invalidates
an old bundle. The separate Dry Run One Confirmed Step control requires manual
tilt/scene confirmation, reports sent=false/acknowledged=false, and blocks the next
step until a human confirms the actual box outcome. Failed/unknown outcomes require
resetting the scene and reloading. Simulated G/P logging remains separate and cannot
advance the confirmed-step workflow.

For future integration, use one Python serial owner only; close `servo_keys.py`
and Serial Monitor before connecting. Verify L/R/S/C behavior and acknowledgement
on the actual board, then implement/test that transport before enabling the
Execute control. The UI Stop control sends no unverified `S`; for an immediate
physical stop **disconnect servo power**.

## Measurements and verification

See `demo-benchmark.json` for measured runs on this Mac. Physics and the golden
fixture are unchanged. Results vary with OS process scheduling and machine load;
the 10–20 second target is not a guarantee.

```sh
.venv/bin/python -m scripts.swarm_benchmark --workers 4 --seed 2026 --timeout 90
GEKKO_PROFILE=1 .venv/bin/python -m scripts.swarm_benchmark --timeout 90
# Worker profiles: printed checkpoint_directory/scene-1/a*.prof
.venv/bin/python -m pytest -q
npm ci --prefix tests
npm test --prefix tests
```

Profiling covered compilation, stepping, geometry/candidate generation, checkpoint
copying and disk writes. The baseline's per-contact Python wrapper iteration was
the largest Python cost (3.62 s of an 8.25 s single-box profile); it now uses MuJoCo's
contact arrays. Candidates spread early trials over contact heights and speeds,
prioritize exposed stack tops, and partition workers' initial shortlists.
Trajectory reduction copies retained samples only. Integration timestep, solver,
uncertainty and acceptance criteria are unchanged. The remaining cost is mostly
real integration; the existing read-only model cache remains in place.
