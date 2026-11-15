# GEKKO physics swarm

The real backend replaces the fake observer for normal operation. No LLMs, AI
services, neural networks or hardware drivers are involved. UNO Q execution was
explicitly deferred by the operator; every command to execute hardware is rejected.

## Run

From the repository root with Python 3.12:

```sh
python3.12 -m venv .venv312
.venv312/bin/python -m pip install -r requirements-sim.txt
.venv312/bin/python -m http.server 8081 --bind 127.0.0.1
# Separate terminal; port 8765 must be free (stop scripts/fake_observer.py).
.venv312/bin/python -m swarm.server --workers 8 --seed 2026
# Optional, for the independent main-workbench manual physics controls:
.venv312/bin/python -m sim.server
```

Open http://localhost:8081/viewer/ and click **Load Three-Box Demo**. Or capture
and place boxes/sweeper and press **Plan workbench**. The Agents panel shows OS
PIDs, actual completed MuJoCo trials, current roles, outcomes and checkpoint IDs.
The task ID and scene version identify every result. The solid workbench stays
unchanged while separately outlined trials animate. Click a row or use Show
agent to isolate that agent. Successful trials are solid, failures dashed; the
labels identify independent worlds. A validated complete plan exposes a separate
**Preview validated sequence** replay with actual MuJoCo trajectories. It never
moves the solid scene. Box A goes left, Box B right, Box C left.

**Kill** sends an OS process kill. Peers independently detect missing heartbeats,
then claim checkpoint work. The feed separates kill, heartbeat timeout and task
takeover, with recovered checkpoint/progress. **Silence all** disables both send
and receive on peer traffic. Separate observer telemetry continues; each isolated
worker cycles capabilities using its own local knowledge. Unsilence reconciles
version-matched checkpoints. Network silence cannot magically share new results.
The observer may show a globally best result received through telemetry during
silence; this does not deliver it to any peer. No worker reads observer state.

Changing physical workbench objects invalidates the old task and plan. Selecting
an agent/object or moving the camera does not alter the planning world. Replan
starts a new scene version. Arbitrary inventory primitives remain unsupported by
the physics engine and produce explicit errors.

## Architecture

`swarm/planning.py` implements all four capabilities in every process:

- Explorer: geometry-filtered candidate sweeps, independent random search order.
- Optimizer: local action mutations, broad exploration and full-plan mutations.
  Mutations focus on stages that actually failed validation. No winning action
  sequence is stored in production search code.
- Validator: independent randomized MuJoCo trials, unique evidence IDs, early
  rejection when the fixed trial budget cannot meet the threshold. Nominal
  success never substitutes for validation.
- Sequencer: bounded beam search over actual simulated intermediate states,
  followed by randomized evaluation of the entire sequence. Collected boxes stay
  as collision bodies. The last result must contain every original box inside
  its assigned bin. Stacked boxes inside a bin require a final support chain to
  its floor; a transient contact or crossing a rectangle does not count.

Compiled MuJoCo models are cached per process; MjData is independent for each
rollout. Action validation defaults to 8 trials; complete plans to 20 trials and
at least 80% success. Full-plan trials perturb the initial masses, friction and
individual positions, then carry the resulting state through every step, with
one sampled manual tilt error for that trial. The unchanged uncertainty ranges
are friction ±20%, mass ±15%, XY ±3 mm per box, tilt ±1°. Search and validation
random seeds are independent per worker. A finite empirical pass rate is not a
guarantee of real-world reliability or a confidence bound.

`swarm/worker.py` runs each independent process plus a network thread. All peers
know task/config snapshots and peer endpoints at bootstrap. Heartbeats are sent
about every 500 ms and failures suspected after 2 s. Every heartbeat carries a
small recoverable active-job checkpoint; full knowledge is gossiped to a rotating
fanout. Packets are compressed and fragmented below macOS's UDP datagram limit.
This keeps bulk trajectories from overwhelming heartbeats. No required central
broker, manager, task queue or coordinator exists. The observer can disappear
without stopping search, peer discovery or recovery. Worker control pipes may
close; that is not a shutdown signal.

Roles derive deterministically from locally live peers, initially 3 Explorers,
2 Optimizers, 2 Validators and 1 Sequencer for eight workers. Current displayed
roles reflect actual selected work, including useful fallback work. Below four
workers (including isolated workers), roles cycle. Deterministic job ownership
and expiring leases reduce duplicate validation/extensions. Failure suspicion
is local: network partitions can cause duplicate work and differing membership;
this is not a consensus protocol. Recovery ownership is reconsidered as further
failures expire, so simultaneous deaths cannot strand work on a dead claimant.

Checkpoints include task/version, frontier nodes, candidates, validation
evidence, plans, cursors, random generator state and active work. Knowledge merges
by unique evidence IDs; duplicate checkpoints do not multiply validation counts.
Retired beam nodes and rejected candidates propagate. Per-state candidate quotas
reserve room for deep search, including with one surviving worker. Stale task
IDs/versions are rejected. On-disk checkpoints and append-only trial/event logs
are under `.gekko/<run>/scene-<version>/a*/`; this runtime data is gitignored.
Reusing the same run directory can resume matching checkpoints. An observer
restart is a new telemetry stream; it does not certify old data for a new task.

`swarm/supervisor.py` only bootstraps processes, manages lifecycle and aggregates
telemetry. Its local WebSocket server is `swarm/server.py`. Peer coordination and
observer telemetry use separate UDP channels. The viewer ignores the old fake
observer unless explicitly opened with `?legacyObserver=1`; that script remains
available for legacy UI development, not as evidence of physics activity.

## Fixture and physical limitations

`config/golden-three-box-v1.json` pins the complete initial snapshot and all
physics configuration. Boxes are 95 × 70 × 25 mm; masses bottom/middle/top are
40/12/8 g; sliding friction 0.35/0.30/0.30. Bin openings are 200 × 240 mm. These
are explicit plausible simulation estimates, **not measured hardware**. Earlier
development fixtures with smaller bins/equal masses failed robustness tests.
The fixture geometry/mass ratios were revised; the success threshold and
uncertainty ranges were not reduced. The same can/servo/stick geometry is used
by the viewer and physics engine. Hardware measurements/calibration remain an
external prerequisite; do not describe this as a calibrated digital twin.

Sweeps start from rest, with manual tilt and parking applied before each action.
Human repositioning between actions is not simulated. Servo torque/speed limits
are enforced in MuJoCo. Optimized angles/speeds are simulation parameters only;
the UNO Q L/R mapping, calibration, acknowledgements and operator-confirmed
execution controller are deliberately not implemented in this milestone, per
operator instruction. Existing external keyboard control is not modified.

Budget exhaustion means no validated solution was found within the configured
search; it does not prove global physical impossibility. A geometry with no
sampled reachable action is reported as failure without invented trials/plans.
The system does not claim tolerance of Byzantine peers, arbitrary hostile packet
injection, machine loss or disk loss. UDP losses can discard unshared progress;
shared checkpoints and surviving local search continue independently.

## Tests and measurable reports

```sh
npm ci --prefix tests
npm test --prefix tests
.venv312/bin/python -m pytest -q -s tests/test_sim.py tests/test_swarm.py
.venv312/bin/python -m scripts.swarm_benchmark --workers 4 --seed 2026 --timeout 300
.venv312/bin/python -m scripts.swarm_benchmark --workers 8 --kill a8 --kill-after 8 --timeout 300
.venv312/bin/python -m scripts.swarm_reliability --timeout 300 --output docs/swarm-reliability.json
```

The reliability runner launches fresh independent processes for each case,
kills real workers, records trials/time/recovery, and nominally replays every
winning three-step plan against the pinned fixture. It verifies all final bag
assignments. Failed/time-limited cases are retained in its JSON report and cause
a nonzero exit. `--cases NAME...` selects cases; `--jobs` controls concurrent
benchmarks (use 1 on an already busy MacBook). The quick process tests also prove
peer silence, reconciliation, actual trajectory audit provenance, version
rejection, one-process role capabilities, and search continuing without observer
control pipes. No test substitutes fabricated physics outcomes.
