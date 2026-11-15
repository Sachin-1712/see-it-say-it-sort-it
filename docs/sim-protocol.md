# Simulation preview protocol

Run `.venv312/bin/python -m sim.server` from the repository root. The service listens
on `ws://localhost:8766` and accepts local browser origins and local programmatic
clients. The observer on port 8765 retains its existing protocol.

Messages are JSON. Send one request at a time per socket. Closing the socket
ends the stream as soon as the current rollout finishes.

| Request | Replies |
| --- | --- |
| `{"cmd":"preview","snapshot":{...},"action":{...}}` | `{"type":"preview_result","result":{...}}` |
| `{"cmd":"search","snapshot":{...},"target":"world_box_0003","budget":200}` | One `{"type":"candidate","attempt":1,"action":{...},"result":{...}}` per completed rollout, then `{"type":"search_done","attempts":N,"best":{...}}` |
| Malformed or unsupported request | `{"type":"error","reason":"..."}` |

The snapshot is the workbench snapshot. See [sim.md](sim.md) for the action
and result schema. The search budget defaults to 200 and accepts 1–2,000.
The deterministic search stops on its first nominal success, on budget
exhaustion, or after the kinematic candidate grid is exhausted.
`best` has the same `attempt`, `action`, and `result` fields as a candidate,
or is null when no candidate ran. A rejected action is an ordinary preview
result with `invalid: true`; request failures use the error reply.

The normal workbench now uses this service without a query flag. Releasing its
Sweep slider sends `preview` with the current servo angle and chosen endpoint.
The boxes and servo play the solved trajectories in the main scene; final box
poses are retained for the next request. No visual sweep runs if the service
fails. Manual tilt is setup, allowed only with the stick parked at 0° or 180°.
“Find & run physical sweep” searches for the top remaining box and applies the
chosen manual setup before physical playback. It does not simulate the human's
repositioning. Physics requests and playback block new placement; Clear cancels
playback and ignores stale responses. No hardware commands are sent.

Results additionally contain `servo_trajectory: [[t_s, actual_angle_deg], ...]`,
sampled alongside `trajectories` at `config/sim.json sample_rate_hz` (60 Hz).
This is the solved joint angle, including contact-induced lag or a stall.

For the older separate diagnostic dialog, open the viewer with `?sim=1` to enable the optional button once the
socket connects. Place a sweeper and boxes. The button searches for the selected
box or the top box and plays the best returned trajectory in a separate dialog.
The dialog draws primitive playback meshes and leaves workbench placement
and the observer alone.
