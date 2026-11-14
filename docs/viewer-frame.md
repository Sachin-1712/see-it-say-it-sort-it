One JSON frame, about 10 per second, over WebSocket ws://localhost:8765

{
  "phase": "searching" | "executing" | "done",
  "pose":  {"x": 112, "y": 64, "theta": 15},
  "arm":   {"angle": 20},
  "agents": [{"id": "a1", "role": "explore" | "refine", "alive": true,
              "silenced": false, "tries": 412, "robust": 0.6}],
  "ghosts": [{"agent": "a1", "success": false,
              "path": [[x, y, z, theta], ...]}],
  "best":   {"agent": "a3", "robust": 0.9,
             "action": {"arm": 0, "start": 20, "end": 140, "speed": 60}},
  "result": null | {"predicted": {"x":0,"y":0,"theta":0},
                    "actual":    {"x":0,"y":0,"theta":0}}
}

Viewer sends back: {"cmd": "die", "id": "a1"} | {"cmd": "silence"} |
                   {"cmd": "unsilence"} | {"cmd": "replan"}