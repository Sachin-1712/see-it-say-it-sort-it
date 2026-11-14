"""Fake observer for building the viewer without the real swarm.

Serves frames in the docs/viewer-frame.md format on ws://localhost:8765,
10 per second. Nothing here is a simulation: ghost paths are made-up
straight slides so the viewer has something to draw.

Commands accepted from the viewer:
  {"cmd": "die", "id": "a1"}   agent stops: alive false, no new ghosts
  {"cmd": "silence"}           all agents silenced: no sharing, slower refine
  {"cmd": "unsilence"}
  {"cmd": "replan"}            new box pose, back to "searching", timer reset
                               (dead agents stay dead)

Run:  .venv/bin/python scripts/fake_observer.py
"""

import asyncio
import json
import math
import random
import time
from pathlib import Path

from websockets.asyncio.server import broadcast, serve

HOST, PORT = "localhost", 8765
FPS = 10
SEARCH_SECONDS = 15
N_AGENTS = 8
GHOSTS_PER_AGENT = 4
PATH_POINTS = 24
SUCCESS_RATE = 1 / 6

RIG = json.loads((Path(__file__).resolve().parent.parent / "config" / "rig.json").read_text())
TABLE, ARM, BOX = RIG["table"], RIG["arm"], RIG["box"]


def edge_direction(edge):
    """Unit vector (table frame) pointing out of the table across the edge."""
    return {"front": (0, -1), "back": (0, 1), "left": (-1, 0), "right": (1, 0)}[edge]


def distance_to_edge(x, y, edge):
    return {"front": y, "back": TABLE["depth"] - y,
            "left": x, "right": TABLE["width"] - x}[edge]


def on_table(x, y):
    return 0 <= x <= TABLE["width"] and 0 <= y <= TABLE["depth"]


class Agent:
    def __init__(self, i):
        self.id = f"a{i + 1}"
        self.role = "explore" if i % 2 == 0 else "refine"
        self.alive = True
        self.tries = 0
        self.robust = 0.0
        self.action = None
        self.ghosts = []
        self.rng = random.Random(1000 + i)


class World:
    def __init__(self):
        self.agents = [Agent(i) for i in range(N_AGENTS)]
        self.silenced = False
        self.arm_angle = ARM["rest_angle"]
        self.reset(RIG["box"]["default_pose"])

    def reset(self, pose):
        self.pose = dict(pose)
        self.phase = "searching"
        self.t0 = time.monotonic()
        self.best = None
        self.best_path = None
        self.result = None
        self.exec_start = None
        self.arm_angle = ARM["rest_angle"]
        for a in self.agents:
            a.ghosts.clear()
            a.robust = 0.0
            a.action = None
            if a.alive:
                a.tries = 0

    def random_pose(self):
        m = 30
        return {"x": round(random.uniform(m, TABLE["width"] - m), 1),
                "y": round(random.uniform(m, TABLE["depth"] - m), 1),
                "theta": round(random.uniform(-45, 45), 1)}

    # ---- fake ghost paths -------------------------------------------------

    def make_ghost(self, agent):
        rng = agent.rng
        x0, y0, th0 = self.pose["x"], self.pose["y"], self.pose["theta"]
        z_top = TABLE["height"] + BOX["height"] / 2
        z_floor = BOX["height"] / 2
        edge = TABLE["goal_edge"]
        success = rng.random() < SUCCESS_RATE

        if success:
            ex, ey = edge_direction(edge)
            ang = math.atan2(ey, ex) + rng.uniform(-0.5, 0.5)
            dist = distance_to_edge(x0, y0, edge) / max(0.3, math.cos(ang - math.atan2(ey, ex))) + 40
        else:
            ang = rng.uniform(0, 2 * math.pi)
            dist = rng.uniform(10, 60)
        dx, dy = math.cos(ang), math.sin(ang)
        spin = rng.uniform(-60, 60)

        path, fallen, fall_i = [], False, 0
        for i in range(PATH_POINTS):
            s = i / (PATH_POINTS - 1)
            d = dist * (1 - (1 - s) ** 2)          # slows down as it slides
            x, y = x0 + dx * d, y0 + dy * d
            th = th0 + spin * s
            if not fallen and not on_table(x, y):
                if success:
                    fallen = True
                else:                               # failures stop at the edge
                    x = min(max(x, 0), TABLE["width"])
                    y = min(max(y, 0), TABLE["depth"])
            if fallen:
                fall_i += 1
                z = max(z_floor, z_top - 0.5 * 9810 * (fall_i * 0.04) ** 2)
            else:
                z = z_top
            path.append([round(x, 1), round(y, 1), round(z, 1), round(th, 1)])

        action = {"arm": 0,
                  "start": round(rng.uniform(5, 40), 1),
                  "end": round(rng.uniform(90, 150), 1),
                  "speed": round(rng.uniform(40, 80), 1)}
        return {"agent": agent.id, "success": success, "path": path}, action

    # ---- one tick ---------------------------------------------------------

    def step(self, dt):
        if self.phase == "searching":
            self.search_step()
            if time.monotonic() - self.t0 >= SEARCH_SECONDS and self.best:
                self.phase = "executing"
                self.exec_start = time.monotonic()
                self.arm_angle = self.best["action"]["start"]
        elif self.phase == "executing":
            act = self.best["action"]
            self.arm_angle = min(act["end"], self.arm_angle + act["speed"] * dt)
            if self.arm_angle >= act["end"]:
                self.finish()
        elif self.phase == "done":
            # arm drifts back to rest
            rest = ARM["rest_angle"]
            step = 90 * dt
            self.arm_angle += max(-step, min(step, rest - self.arm_angle))

    def search_step(self):
        for a in self.agents:
            if not a.alive:
                continue
            # silenced refiners have nothing to refine from, so they slow down
            rate = 0.35 if (self.silenced and a.role == "refine") else 0.7
            a.tries += a.rng.randint(20, 40) if rate > 0.5 else a.rng.randint(8, 18)
            if a.rng.random() < rate:
                ghost, action = self.make_ghost(a)
                a.ghosts.append(ghost)
                del a.ghosts[:-GHOSTS_PER_AGENT]
                if ghost["success"]:
                    score = round(a.rng.uniform(0.4, 0.95), 2)
                    if score > a.robust:
                        a.robust, a.action = score, action
                        if not self.best or score > self.best["robust"]:
                            self.best = {"agent": a.id, "robust": score, "action": action}
                            self.best_path = ghost["path"]
            # sharing: unsilenced refiners pull their score toward the best
            if not self.silenced and a.role == "refine" and self.best:
                a.robust = round(max(a.robust, self.best["robust"] - 0.1), 2)

    def finish(self):
        end = self.best_path[-1]
        predicted = {"x": end[0], "y": end[1], "theta": end[3]}
        actual = {"x": round(end[0] + random.gauss(0, 6), 1),
                  "y": round(end[1] + random.gauss(0, 6), 1),
                  "theta": round(end[3] + random.gauss(0, 8), 1)}
        self.result = {"predicted": predicted, "actual": actual}
        self.phase = "done"

    # ---- commands ---------------------------------------------------------

    def handle(self, msg):
        cmd = msg.get("cmd")
        if cmd == "die":
            for a in self.agents:
                if a.id == msg.get("id"):
                    a.alive = False
                    a.ghosts.clear()
        elif cmd == "silence":
            self.silenced = True
        elif cmd == "unsilence":
            self.silenced = False
        elif cmd == "replan":
            self.reset(self.random_pose())
        else:
            print("unknown command:", msg)
            return
        print("command:", msg)

    def frame(self):
        return {
            "phase": self.phase,
            "pose": self.pose,
            "arm": {"angle": round(self.arm_angle, 1)},
            "agents": [{"id": a.id, "role": a.role, "alive": a.alive,
                        "silenced": self.silenced and a.alive,
                        "tries": a.tries, "robust": a.robust}
                       for a in self.agents],
            "ghosts": [g for a in self.agents for g in a.ghosts],
            "best": self.best,
            "result": self.result,
        }


world = World()
clients = set()


async def handler(ws):
    clients.add(ws)
    print(f"viewer connected ({len(clients)})")
    try:
        async for raw in ws:
            try:
                world.handle(json.loads(raw))
            except (ValueError, AttributeError):
                print("bad message:", raw)
    finally:
        clients.discard(ws)
        print(f"viewer disconnected ({len(clients)})")


async def tick():
    dt = 1 / FPS
    while True:
        world.step(dt)
        broadcast(clients, json.dumps(world.frame()))
        await asyncio.sleep(dt)


async def main():
    async with serve(handler, HOST, PORT):
        print(f"fake observer on ws://{HOST}:{PORT}  ({FPS} frames/s, {N_AGENTS} agents)")
        await tick()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
