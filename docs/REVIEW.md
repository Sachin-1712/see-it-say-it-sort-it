# Review of the `sim` branch (Joe's simulation and swarm work)

Reviewed Sun 15 Nov 2026 at `origin/sim` = `98ddf8f`, checked out in a separate
worktree. No code was changed. Every number below comes from a command run during
this review on the MacBook Air M2 (8 cores), Python 3.12.16, MuJoCo 3.17.0,
unless it says "Joe's recorded report".

## 1. What changed

**Branch:** Joe pushed to `origin/sim`. It sits directly on top of `viewer-polish`
(`490b4f9`, the CLAUDE.md commit), so merging it into `viewer-polish` would be a
fast-forward with no conflicts.

**Commits since your last pull (`490b4f9`):**

| Commit | Author | What it is |
| --- | --- | --- |
| `1d87b9d` … `ba02b46` (10 commits, "Gate 1" to "Gate 9" plus "Document setup…") | sachin (Codex) | The Codex MuJoCo work. Identical file contents to your local `sim` branch and `gekko-sim.bundle` (`git diff sim ba02b46` is empty); only the hashes differ, so it was re-created rather than pushed from your branch. |
| `f5edbbd` "Tune Gekko rig contacts and verify robust centred sorts" | sachin (Codex, 03:40) | Retunes rig, models, sim and scoring config; search and scoring tweaks; preview UI. |
| `98ddf8f` "bazalright" | Joe (05:11) | The swarm: 47 files, +35,251 / −169. Includes a 32,366-line JSON report. |

Your local `sim` branch and `origin/sim` have diverged (same Gate content, different
hashes). Do not merge the local one; use `origin/sim`.

**Files (58 in total since `490b4f9`).** Codex Gate commits:

| File | Purpose |
| --- | --- |
| `sim/api.py` | Rollout engine: builds MuJoCo state, steps the sweep, scores, robust trials, sequences |
| `sim/mjcf.py` | Generates the MJCF scene (bench, bins, boxes, can, servo, stick) from config |
| `sim/scene.py` | Immutable scene object built from a workbench snapshot and config |
| `sim/geometry.py` | Kinematic filter: which tilt/servo angles can contact a target |
| `sim/scoring.py` | Bag landing test, stack stability, success reason |
| `sim/search.py` | Deterministic candidate grid and best-candidate search |
| `sim/server.py` | WebSocket preview/search service on `ws://localhost:8766` |
| `sim/__init__.py` | Package marker |
| `config/sim.json` | Timestep, solver, contact, servo torque/speed, settle times |
| `config/scoring.json` | Tolerances and robustness perturbation ranges |
| `requirements-sim.txt` | mujoco, numpy, websockets, pytest |
| `scripts/demo_sim.py` | Runs single box both sides, a deliberate miss, and the three-box stack |
| `scripts/sim_benchmark.py` | Times 100 rollouts |
| `scripts/sim_parallel_check.py` | 8 processes × 50 rollouts, checked against serial replays |
| `tests/test_sim.py` | 11 physics tests |
| `docs/sim.md`, `docs/sim-protocol.md` | Setup, API, protocol for 8766 |
| `viewer/sim-preview.mjs` | Optional preview dialog (`?sim=1`) |
| `viewer/index.html`, `config/models.json`, `assets/models/manifest.json`, `.gitignore` | Small edits for the above |

Joe's `98ddf8f`:

| File | Purpose |
| --- | --- |
| `swarm/planning.py` | Planner: explorer, optimizer, validator, sequencer in every process |
| `swarm/worker.py` | One OS process per agent; UDP heartbeats, gossip, checkpoints, silence |
| `swarm/supervisor.py` | Spawns workers, kills them, aggregates telemetry into viewer frames |
| `swarm/server.py` | WebSocket observer on `ws://localhost:8765` (replaces the fake observer) |
| `swarm/task.py` | Task digest, scene construction, golden snapshot |
| `swarm/wire.py` | UDP compression and fragmentation |
| `swarm/__init__.py` | Package marker |
| `config/swarm.json` | Workers, heartbeat 0.5 s, failure timeout 2 s, trial budgets, threshold 0.8 |
| `config/golden-three-box-v1.json` | Pinned three-box demo scene with its own copy of all config |
| `config/rig.json`, `config/models.json`, `config/sim.json` | Geometry retuned (see section 4) |
| `scripts/swarm_benchmark.py` | One timed swarm run, optional kills |
| `scripts/swarm_reliability.py` | Eight scripted kill/no-kill cases |
| `scripts/audit_swarm_report.py` | Checks a reliability report |
| `scripts/generate_models.py` | Blender generator updated for the compact servo mount |
| `scripts/sync-model-metadata.mjs` | Writes fitted geometry into the manifest |
| `assets/models/box.glb`, `sweeper.glb`, `manifest.json` | GLBs rebuilt in Blender |
| `docs/swarm.md` | Architecture, controls, limits |
| `docs/swarm-reliability.json` | Recorded reliability run (32,366 lines) |
| `docs/viewer-frame.md` | Documents the frame extension `gekko-swarm-v1` |
| `docs/STATE.md`, `docs/sim.md`, `docs/sim-protocol.md`, `README.md` | Updated notes |
| `viewer/swarm-state.mjs` | Rejects stale or duplicate frames |
| `viewer/swarm-overlay.mjs` | Draws agent trial ghosts and plan replay |
| `viewer/world-physics.mjs` | Client for the 8766 physics service |
| `viewer/workshop.mjs`, `workbench.mjs`, `workbench-state.mjs`, `model-fit.mjs`, `index.html`, `inventory.css` | Swarm panel, demo/plan buttons, physics sweep, retained poses (635 lines added in viewer files) |
| `tests/test_swarm.py` | 7 process-level swarm tests |
| `tests/swarm-state.test.mjs`, `tests/world-physics.test.mjs`, `tests/scene-integration.test.mjs`, `tests/fit.test.mjs` | Viewer-side tests |
| `tests/physics-smoke.html` | Manual three-box browser page |

**How it relates to existing code.** It *extends* the Codex `sim/` package (swarm
calls `sim.api.rollout` and `sim.search.candidate_actions`; nothing in `sim/` is
replaced). It *replaces* `scripts/fake_observer.py` as the normal backend: the
viewer ignores the fake observer unless opened with `?legacyObserver=1`. It
*modifies* the viewer you own: new Agents-panel content, demo and plan buttons,
physics playback, and the Send button.

## 2. Does it run?

Set up as `docs/sim.md` says, in the review worktree:

```
python3.12 -m venv .venv312
.venv312/bin/python -m pip install -r requirements-sim.txt
→ mujoco 3.17.0, numpy 2.5.4, websockets 16.1.1, pytest 9.2.0
```

| Command (from docs) | Result |
| --- | --- |
| `.venv312/bin/python -m pytest -q -s tests/test_sim.py tests/test_swarm.py` | **17 passed in 39.63 s** |
| `npm ci --prefix tests && npm test --prefix tests` | **49 passed, 0 failed** (5.4 s) |
| `.venv312/bin/python -m scripts.demo_sim` | exit 0, 7.7 s (output in section 3) |
| `.venv312/bin/python -m scripts.sim_benchmark` | exit 0: 100 rollouts, median **45.8 ms**, p95 54.7 ms, max 76.9 ms, 21.2 rollouts/s per process |
| `.venv312/bin/python -m scripts.sim_parallel_check` | exit 0: 8 processes (distinct PIDs), 400 rollouts in 21.6 s, 0 invalid, serial replays match bit-for-bit (asserted at `scripts/sim_parallel_check.py:72`) |
| `.venv312/bin/python -m scripts.swarm_benchmark --workers 4 --seed 2026 --timeout 300` | **success in 49.7 s**: 1,114 MuJoCo trials, 52 plan trials |
| `.venv312/bin/python -m scripts.swarm_benchmark --workers 8 --kill a8 --kill-after 8 --timeout 300` | **success in 103.1 s**: 1,615 trials, 68 plan trials, robust 0.90 |
| `.venv312/bin/python -m swarm.server --workers 8 --port 8775` + a scripted client acting like the viewer (port 8775 because 8765 is taken, see section 6) | Ready in about 1 s. `load_demo` started 8 processes (PIDs 97830–97837) within 1.1 s. `execute` → error "Hardware execution is disabled". Killed `a2` and `a5` at 6.5 s → takeovers at 8.4 s and 8.7 s with progress recovered. Silence at 14 s and unsilence at 24 s reached all 6 survivors within 0.3 s. **Validated plan at 55.1 s**, robust 0.80 over 20 trials, 1,086 MuJoCo trials. |

Not run: `scripts.swarm_reliability` (eight cases, about 10 minutes even
sequentially). Joe's recorded report from that script is summarised in section 3.
The native MuJoCo viewer is never used (no `mujoco.viewer` or `mjpython` anywhere),
so `mjpython` is not needed. Playback is in the three.js viewer.

## 3. Does it work?

**Single box, both bins** (`scripts.demo_sim`, default config):

| Case | Action | Score | Robust (24 perturbed trials) |
| --- | --- | --- | --- |
| Red → left | tilt 23°, sweep 52° → 180°, 280°/s | 1.0, landed left | 0.958 |
| Blue → right | tilt 23°, sweep 128° → 0°, 280°/s | 1.0, landed right | 0.875 |
| Deliberately bad | tilt 0°, sweep 0° → 180° | 0.0, "stick never contacted target" | — |
| Stack top → left | tilt 8°, 40° → 180°, 90°/s (10 attempts) | 1.0 | not run |
| Stack middle → right | tilt 16.5°, 140° → 0°, 90°/s (5 attempts) | 1.0 | not run |
| Stack bottom → left | tilt 23.5°, 50° → 180°, 280°/s (2 attempts) | 1.0 | 0.958 |

**Full three-box plan from the swarm** (8 workers, `a8` killed): top box tilt 6.5°,
40° → 180°, 90°/s; middle 12.5°, 132° → 0°, 150°/s; bottom 25.5°, 48° → 180°,
150°/s. Robust 0.90 over 20 perturbed full-sequence trials.

**Contacts.** Stable in everything I ran:
- After a push the box comes to rest flat on the bin floor (centre z 15.0 mm = 2.5 mm floor + half of 25 mm) with final speed 0.000 mm/s.
- The two boxes left on the bench move 0.02 and 0.18 mm while the top box is pushed off.
- Peak servo torque 0.034 N·m (cap 0.15), no stall.
- Deepest penetration 1.0 to 1.9 mm, only at the moment a box lands at about 0.9 m/s; no tunnelling, no explosions. Any MuJoCo numerical warning turns a rollout into an invalid result (`sim/api.py`, after the step loop).
- `test_sim.py` reports 0.004 mm stack drift over 0.5 s at rest.

**Time per rehearsal.** One rollout (one simulated sweep, about 2 to 3 s of
simulated time) takes **46 ms** wall time. A complete validated three-box plan takes
**50 s with 4 workers, 55 s with 8 workers and two killed (live run), and 103 s with
8 workers and one killed** on this laptop. Joe's recorded
report: 33 to 180 s across eight cases.

**Multiple agents.** Yes, and they are real:
- Each agent is a separate OS process (`multiprocessing` spawn, distinct PIDs).
- **Kill** is `process.kill()` (`swarm/supervisor.py:108-116`). In my run `a8` was killed at 8.15 s, every peer noticed by 9.78 s, and `a7` took over its job at 9.88 s, so recovery took **1.7 s**. The plan still validated.
- Joe's recorded report (`docs/swarm-reliability.json`, not re-run here): all 8 cases passed, including killing half the swarm and a single survivor; takeovers 1.7 to 1.9 s after each kill; robust 0.80 to 0.90; 33 to 180 s per case.
- **Silence** stops each worker sending and receiving peer traffic while still reporting to the viewer (`swarm/worker.py:115-118`, `129`, `135`, `149`, `189`, `240`). Isolated workers keep searching alone. Tested in `test_four_real_processes_kill_recovery_silence_and_observer_independence`.
- **Problem found:** with 8 workers, live workers wrongly declared each other dead. At about 54 s and 101 s `a2` "took over" from `a1`, `a3`, `a4`, `a5`, `a6` and `a7`, none of which were killed. Heartbeats come from a thread in the same process as the MuJoCo loop, and on 8 busy cores they can fall more than 2 s behind (`swarm/worker.py:151`, `config/swarm.json` `failure_timeout_s: 2.0`). It is intermittent: the 55 s live run with 6 survivors had none (all 24 timeouts were for the two killed agents), the 103 s benchmark with 7 survivors had dozens. It is the likely reason 8 workers took twice as long as 4, and in the demo the Agents panel would show takeovers the judge never caused.

**Viewer and Arduino.**
- Viewer: `swarm.server` streams frames on `ws://localhost:8765` (`gekko-swarm-v1`, documented in `docs/viewer-frame.md`); `sim.server` serves manual sweeps on `ws://localhost:8766`. The viewer has **Load Three-Box Demo**, **Plan workbench**, per-agent rows with Kill, Silence, and **Preview validated sequence**, which replays real MuJoCo trajectories.
- Arduino: **nothing**. No serial, UNO Q or firmware code exists. `execute` and `confirm_ready` always return "Hardware execution is disabled; simulation planning only." (`swarm/server.py:43-44`). The Send button is disabled and reads "Hardware disabled · simulation only" (`viewer/workshop.mjs:587`). There is no dry-run path either: the best plan is never turned into `P <arm> <start> <end> <speed>` commands.

## 4. Honesty check

**No faked physics found.**
- Success comes from MuJoCo state: stick contact, landing inside a bin opening with floor contact, no pre-contact stall, other boxes within 5 mm and upright (`sim/scoring.py:8-54`).
- Randomness is used only for search order and validation perturbations (`swarm/planning.py:44-52`, `112`, `161-211`; `sim/api.py:309-320`), never for outcomes.
- The best plan's robustness is the fraction of real validation trials that succeeded (`swarm/planning.py:39-41`; threshold applied at `swarm/supervisor.py:151-153`).
- The golden fixture stores no actions or paths, only the scene and config.
- Ghosts and plan replays are recorded MuJoCo trajectories.
- No labels claim AI, learning, photo-to-3D or a calibrated twin; `docs/swarm.md` explicitly says no LLMs or neural networks.
- A miss is reported as a miss. In my probe, a 27° sweep that hit the lower boxes instead of the target was scored "stick never contacted target".

**Things to say carefully, or to fix:**
- **The demo fixture was tuned until it passed.** `config/golden-three-box-v1.json` `note`: bins enlarged to 200 × 240 mm and masses changed to 40/12/8 g (bottom/middle/top) because "earlier development fixtures with smaller bins/equal masses failed robustness tests" (`docs/swarm.md`, "Fixture and physical limitations"). The real parcels are not 40/12/8 g. It is disclosed, but the demo should not imply these are measured.
- **Robustness sits on the threshold.** Joe's recorded cases score 0.80 to 0.90 against a 0.80 threshold, over 20 trials. That is not a confidence bound (the docs say so).
- **The servo model is smaller than the real servo.** `config/models.json` now uses an 18 × 10 × 12 mm case; the PRD's Fitec FS90 is about 23 × 12 × 22 mm. The smaller case puts the stick lower, which makes contact easier than the real rig can.
- **Geometry changed without matching your last spec.** Bench width 250 → 220 mm (your minimum was 250), bins 130 × 160 → 200 × 240 mm, can 50 × 90 → 53 × 100 mm, tilt limit 32.5° → 27°, gap 50 → 70 mm, and the stick underside is no longer 10 mm above the stack at tilt 0 (a 0° sweep now sorts the top box).
- **"Real decentralized" is true for search, not for lifecycle.** One supervisor process spawns all workers on one laptop and gives them the peer list. Workers coordinate peer-to-peer after that, and the docs say plainly it is not a consensus protocol.
- **"Kill" means a process kill on the same machine,** not a laptop or network loss (the PRD's "close a laptop lid" case is not covered).
- `physical_eligible` is documented as "always false" (`docs/viewer-frame.md`) but is absent (`None`) from the plan in my run. Harmless, but the doc and the code disagree.

## 5. Demo readiness

| Step | Status | What is needed |
| --- | --- | --- |
| Place parcel | **Partly working.** Load Three-Box Demo loads a pinned scene; Plan workbench takes placed objects. The camera does not read colour or position (identity and colour are picked by hand). | For the PRD's camera step: real vision. Otherwise say plainly that the parcel is placed by hand. |
| Agents rehearse in simulation | **Working.** Real MuJoCo trials in separate processes; ghosts are real trajectories. 50 to 100 s to a full validated three-box plan. | Shorten time-to-plan for the stage (4 workers, or plan one box at a time). |
| Judge kills some agents | **Working, with a flaw.** Real process kill, 1.7 s recovery. Phantom takeovers appear under 8-worker load. | Fix false heartbeat timeouts (fix 2). |
| Best push shown | **Working.** Plan panel lists the steps; "Preview validated sequence" replays real MuJoCo trajectories without moving the scene. | Nothing essential. |
| Human confirms | **Missing.** Send is permanently disabled in swarm mode; `execute` returns an error. | An explicit confirm that turns the chosen action into a command, gated on robust ≥ 0.8. |
| Real servo pushes the box | **Missing.** No serial or network driver, no firmware, no mapping from simulated angles to the real servo's angles. | PRD milestone 3 and 5 work: firmware `P`/`G` commands, a driver, calibration of angle direction and zero. |

## 6. Risks

- **Port 8765 conflict.** `swarm.server` defaults to 8765, the same port as `scripts/fake_observer.py`. On this laptop an old fake observer is still running on 8765 (PID 53789); the swarm server would fail to bind. The viewer hard-codes `ws://localhost:8765` (`viewer/workshop.mjs:18`) and `ws://localhost:8766` (`viewer/world-physics.mjs:4`, `viewer/sim-preview.mjs:125`).
- **Two Python environments.** `.venv312` (MuJoCo, swarm) and the old `.venv` (Python 3.14, fake observer). `.venv312` does not exist in your main checkout yet.
- **Internet needed.** three.js and the fonts load from jsdelivr and Google Fonts (`viewer/index.html:7-9`, `139-140`). Venue Wi-Fi failure means a blank viewer.
- **Slow planning.** 50 to 180 s per validated plan; 8 workers are slower than 4 on this laptop. A judge may lose interest.
- **Phantom agent deaths** under load (section 3), visible in the Agents panel.
- **Fixture is tuned, not measured** (section 4). Real boxes, friction and servo will differ; nothing is calibrated.
- **Runtime data grows.** Each run writes checkpoints and logs to `.gekko/<run>/` (gitignored, but never cleaned).
- **Ownership.** `98ddf8f` rewrote viewer files you own (635 lines added); CLAUDE.md says Joe owns agents, observer and firmware. The viewer changes look reasonable but need your review before merging.
- **Start-up.** The server is ready about 1 s after launch; workers start when a task is loaded. Not a risk.

## Top 5 fixes, in priority order

1. **Human-confirmed Send path, dry run first (60 min).** On confirm, turn the best plan's first action into the PRD's `P <arm> <start> <end> <speed>` line and print or log it instead of rejecting `execute`. Wire the real driver later. This closes the demo's confirm step even without hardware.
2. **Stop phantom agent deaths (30 min).** Raise `failure_timeout_s` to about 5 s (or send heartbeats from a process that does not run MuJoCo), and default the demo to 4 to 6 workers. Re-run the 8-worker kill benchmark and confirm no unexpected `heartbeat_timeout` events.
3. **Restore the agreed geometry or agree the new one (45 min).** Decide between your 250 mm bench, FS90-sized servo case and stick 10 mm above the stack, and Joe's 220 mm bench, 18 × 10 × 12 mm case and lower stick. Then re-run the reach test and the swarm benchmark on the agreed values, in one shared config.
4. **Free port 8765 and make ports configurable (20 min).** Stop the old fake observer, and let the viewer read the observer and physics URLs from a query parameter, so a busy port is not fatal on stage.
5. **Make the stage run fast and offline (40 min).** Vendor three.js and the fonts locally, and pre-warm a validated plan (or plan one box at a time) so the first ghost appears in seconds and a full plan in under about 30 s.
