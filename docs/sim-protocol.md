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

Open the normal viewer with `?sim=1` to enable the optional button once the
socket connects. Place a sweeper and boxes. The button searches for the selected
box or the top box and plays the best returned trajectory in a separate dialog.
The dialog draws primitive playback meshes and leaves workbench placement
and the observer alone.
