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
