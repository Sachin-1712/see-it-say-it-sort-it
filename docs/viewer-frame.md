One JSON frame, about 10 per second, over WebSocket ws://localhost:8765
(matches docs/PRD.md section 7)

item  {"id": "p1", "color": "red", "zone": "scan" | "pick" | "binned",
       "pose": {"x": 112, "y": 64, "theta": 15},
       "bin": "left" | "right" | null,
       "status": "waiting" | "planning" | "ready" | "sorted" | "missed"}
goal  {"parcel": "p1", "bin": "left", "avoid": ["p2"]}

{
  "phase":  "idle" | "searching" | "ready" | "executing" | "done",
  "items":  [item, ...],
  "arm":    {"angle": 20},
  "agents": [{"id": "a1", "role": "router" | "planner" | "checker" | "watcher",
              "alive": true, "silenced": false, "tries": 412, "robust": 0.6}],
  "ghosts": [{"agent": "a1", "parcel": "p1", "success": false,
              "path": [[x, y, z, theta], ...]}],
  "best":   {"agent": "a3", "robust": 0.9, "goal": {...},
             "action": {"arm": 0, "start": 10, "end": 150, "speed": 60}},
  "result": null | {"parcel": "p1", "bin": "left", "landed": true,
                    "predicted": {"x": 0, "y": 0, "theta": 0},
                    "actual":    {"x": 0, "y": 0, "theta": 0}}
}

Viewer sends back: {"cmd": "die", "id": "a1"} | {"cmd": "silence"} |
                   {"cmd": "unsilence"} | {"cmd": "replan"} | {"cmd": "execute"}

"execute" asks the arm driver to run the current best push. The viewer only
enables it when best.robust >= 0.8. Pressing it is what moves the phase to
"executing"; nothing starts the push on a timer.

## Real swarm extension (`gekko-swarm-v1`)

Normal operation now runs `python -m swarm.server`, not `scripts/fake_observer.py`.
The old fields above remain for compatibility. The frame additionally contains:

- `protocol`, `stream_id`, monotonically increasing `frame_seq`.
- `task`: task ID, scene version, immutable snapshot, physics config, goals,
  search settings; `source` distinguishes golden fixture/workbench.
- Agents: real `pid`, role/status, heartbeat, actual cumulative `tries`, latest
  completed trial (timestamp/action/outcome/trajectories), current work/validation
  progress, checkpoint ID and peer send/receive counts.
- Ghosts: actual sampled MuJoCo paths with agent/trial/task IDs, version,
  timestamps and outcomes. These never update the physical workbench state.
- `best.plan`: complete actions, nominal results, final snapshot, bag outcomes,
  unique randomized validation evidence. `physical_eligible` is always false
  while UNO Q execution is deferred. `metrics` distinguishes worker rollouts,
  full-plan trials and optional nominal verification replays.
- `events`: real process kill, peer timeout, takeover, silence/reconciliation
  events. `execution.enabled` is false. No simulation success enables hardware.

Additional viewer commands are `load_demo`, `plan_workbench` (snapshot required),
`invalidate`, and `replay_plan`. Replaying returns a `type: plan_replay` response
with task/version and freshly simulated step trajectories. It changes no world
state. Existing `die`, `silence`, `unsilence`, `replan` commands retain their
purpose but now affect genuine processes/networking. `execute` is a
human-confirmed dry run: it returns `{"type":"dry_run_command","step":1,"steps":3,
"target":"world_box_0003","bin":"left","tilt_deg":5.5,"commands":["G 0 41","P 0 41 180 90"],
"robust":0.8,"plan_id":...,"task_id":...,"scene_version":1,"transmitted":false,"note":...}`
for the next step of the validated plan, or an error. `confirm_ready` returns an error.
No hardware driver exists in the swarm. The frame's `execution` object is
`{"enabled":false,"dry_run":true,"next_step":1|null,"steps":N,"reason":...}`.

The static viewer uses scene versions, stream sequence numbers and trial
identities to reject stale/duplicate telemetry. A new physical workbench state
invalidates the active planning task. Scene frames on 8766 (manual physics
preview) and camera/inventory storage remain separate. See [swarm.md](swarm.md).

## Hackathon demo additions (stage-fixes)

The `gekko-swarm-v1` frame now also carries `live_search_stopped` and `recovery[]`.
Each recovery includes the terminated agent, previous role, active count before
termination, confirmed successor/role/checkpoint, recovered trials/progress,
new trials on the successor, resumed status, additional trials since death,
whether a better validated plan appeared, silence/successor status and a timestamped
backend-derived timeline. New worker events are `work_resumed`; takeover events
also include `successor_trials`. No client timer asserts takeover.

`best.attribution` is `live` or `previously_validated`; `best.label` and `saved_at`
make provenance explicit. `plan_replay` returns stored MuJoCo results plus the same
attribution/label, and never runs a new search or physics rollout.

Commands: `load_demo` loads a stopped golden scene; `start_agents` launches fresh
workers for that scene; `stop_live` stops the workers and retains history;
`load_saved` loads the local compatible bundle only when stopped; `prepare_step`
requires `plan_id`, `tilt_confirmed:true`, `scene_confirmed:true`; `confirm_outcome`
requires `success:true` to advance the separate confirmed-step index.
`hardware_stop` reports the disabled transport and physical-power stop instruction.
No real serial transport is enabled. `execution.physical_next_step` and
`awaiting_outcome` are independent of the legacy simulated G/P dry-run index.

`confirmed_step` reports the calibrated L/R mapping (or null when unverified),
manual tilt, step/target/destination, `transmitted:false`, `acknowledged:false` and
the hardware blocker. Configuration is in `config/uno-q.json`.
