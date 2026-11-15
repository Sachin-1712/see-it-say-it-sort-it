"""Fake observer for building the viewer without the real swarm.

Serves frames in the docs/viewer-frame.md format on ws://localhost:8765,
10 per second. Nothing here is a simulation: ghost paths are made-up
slides so the viewer has something to draw.

Scenario: two parcels. One sits in the pick zone (the target), the other
waits in the scan zone. Agents search for a push into the target's bag.

Commands accepted from the viewer:
  {"cmd": "die", "id": "a1"}   agent stops: alive false, no new ghosts
  {"cmd": "silence"}           no sharing; each agent cycles through all roles
  {"cmd": "unsilence"}
  {"cmd": "replan"}            before a push: new target position, search restarts
                               after a push: the waiting parcel moves to the pick
                               zone and the sorted one goes back to the scan zone
  {"cmd": "execute"}           runs the best push if its robust score >= 0.8
(dead agents stay dead until this script restarts)

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
N_AGENTS = 8
ROLES = ["router", "planner", "checker", "watcher"]
GHOSTS_PER_AGENT = 4
PATH_POINTS = 24
SUCCESS_RATE = 1 / 6
EXECUTE_MIN = 0.8
TAKEOVER_SECONDS = 2.0
PARK_SPEED = 90  # deg/s when moving to the start angle

RIG = json.loads((Path(__file__).resolve().parent.parent / "config" / "rig.json").read_text())
TABLE, ZONES, BAGS = RIG["table"], RIG["zones"], RIG["bags"]
SIZES = {p["id"]: p for p in RIG["parcels"]}
COLOUR_TO_BAG = RIG["colour_to_bag"]
COLOURS = list(COLOUR_TO_BAG)


def on_table(x, y):
    return 0 <= x <= TABLE["width"] and 0 <= y <= TABLE["depth"]


def in_rect(x, y, r):
    return abs(x - r["x"]) <= r["width"] / 2 and abs(y - r["y"]) <= r["depth"] / 2


def random_pose_in(zone, rng=random, margin=12):
    z = ZONES[zone]
    return {"x": round(rng.uniform(z["x"] - z["width"] / 2 + margin, z["x"] + z["width"] / 2 - margin), 1),
            "y": round(rng.uniform(z["y"] - z["depth"] / 2 + margin, z["y"] + z["depth"] / 2 - margin), 1),
            "theta": round(rng.uniform(-20, 20), 1)}


class Agent:
    def __init__(self, i):
        self.id = f"a{i + 1}"
        self.role = ROLES[i % len(ROLES)]
        self.alive = True
        self.tries = 0
        self.robust = 0.0
        self.ghosts = []
        self.rng = random.Random(1000 + i)


class World:
    def __init__(self):
        self.agents = [Agent(i) for i in range(N_AGENTS)]
        self.silenced = False
        self.items = [
            {"id": "p1", "color": "red", "zone": "pick", "pose": random_pose_in("pick"),
             "bin": "left", "status": "planning"},
            {"id": "p2", "color": "blue", "zone": "scan", "pose": random_pose_in("scan"),
             "bin": "right", "status": "waiting"},
        ]
        self.tick = 0
        self.role_seen = {r: time.monotonic() for r in ROLES}
        self.start_search()

    # ---- state helpers ----------------------------------------------------

    @property
    def target(self):
        return next(i for i in self.items if i["zone"] == "pick")

    def start_search(self):
        self.phase = "searching"
        self.best = None
        self.best_path = None
        self.result = None
        self.exec_stage = None
        self.arm_angle = self.park_angle(self.target["bin"])
        for a in self.agents:
            a.ghosts.clear()
            a.robust = 0.0
            if a.alive:
                a.tries = 0
        self.target["status"] = "planning"

    @staticmethod
    def park_angle(bin_):
        # pushing left means starting from the right (0 deg), and the other way round
        return 0 if bin_ == "left" else 180

    # ---- fake ghost paths -------------------------------------------------

    def make_ghost(self, agent):
        rng, item = agent.rng, self.target
        size = SIZES.get(item["id"], RIG["parcels"][0])
        x0, y0, th0 = item["pose"]["x"], item["pose"]["y"], item["pose"]["theta"]
        z_top = TABLE["height"] + size["height"] / 2
        z_floor = size["height"] / 2
        bag = BAGS[item["bin"]]
        success = rng.random() < SUCCESS_RATE

        if success:
            tx = bag["x"] + rng.uniform(-12, 12)
            ty = bag["y"] + rng.uniform(-bag["depth"] / 3, bag["depth"] / 3)
        else:
            ang = rng.uniform(0, 2 * math.pi)
            d = rng.uniform(10, 60)
            tx, ty = x0 + math.cos(ang) * d, y0 + math.sin(ang) * d
        spin = rng.uniform(-60, 60)

        path, fall_i = [], 0
        for i in range(PATH_POINTS):
            s = i / (PATH_POINTS - 1)
            e = 1 - (1 - s) ** 2                      # slows down as it slides
            x, y = x0 + (tx - x0) * e, y0 + (ty - y0) * e
            if not success:                           # failures stop at the edge
                x = min(max(x, 0), TABLE["width"])
                y = min(max(y, 0), TABLE["depth"])
            if on_table(x, y):
                z = z_top
            else:
                fall_i += 1
                z = max(z_floor, z_top - 0.5 * 9810 * (fall_i * 0.04) ** 2)
            path.append([round(x, 1), round(y, 1), round(z, 1), round(th0 + spin * s, 1)])

        if item["bin"] == "left":
            action = {"arm": 0, "start": round(rng.uniform(5, 25), 1),
                      "end": round(rng.uniform(110, 150), 1), "speed": round(rng.uniform(40, 80), 1)}
        else:
            action = {"arm": 0, "start": round(rng.uniform(155, 175), 1),
                      "end": round(rng.uniform(30, 70), 1), "speed": round(rng.uniform(40, 80), 1)}
        ghost = {"agent": agent.id, "parcel": item["id"], "success": success, "path": path}
        return ghost, action

    # ---- one tick ---------------------------------------------------------

    def step(self, dt):
        self.tick += 1
        self.update_roles()
        if self.phase in ("searching", "ready"):
            self.search_step()
            if self.best and self.best["robust"] >= EXECUTE_MIN:
                self.phase = "ready"
                self.target["status"] = "ready"
        elif self.phase == "executing":
            self.execute_step(dt)

    def update_roles(self):
        alive = [a for a in self.agents if a.alive]
        if not alive:
            return
        if self.silenced:
            # alone, each agent cycles through every role (one per second)
            for i, a in enumerate(self.agents):
                if a.alive:
                    a.role = ROLES[(self.tick // FPS + i) % len(ROLES)]
            return
        now = time.monotonic()
        for r in ROLES:
            if any(a.role == r for a in alive):
                self.role_seen[r] = now
            elif now - self.role_seen[r] >= TAKEOVER_SECONDS:
                # takeover: an agent from the most crowded role switches
                counts = {q: sum(a.role == q for a in alive) for q in ROLES}
                donor = max(counts, key=counts.get)
                if counts[donor] > 1:
                    next(a for a in alive if a.role == donor).role = r
                    self.role_seen[r] = now

    def search_step(self):
        for a in self.agents:
            if not a.alive:
                continue
            busy = self.silenced or a.role in ("planner", "checker")
            rate = 0.35 if self.silenced else (0.7 if busy else 0.15)
            a.tries += a.rng.randint(20, 40) if busy else a.rng.randint(2, 6)
            if a.rng.random() < rate:
                ghost, action = self.make_ghost(a)
                a.ghosts.append(ghost)
                del a.ghosts[:-GHOSTS_PER_AGENT]
                if ghost["success"]:
                    score = round(a.rng.uniform(0.4, 0.95), 2)
                    if score > a.robust:
                        a.robust = score
                        if not self.best or score > self.best["robust"]:
                            others = [i["id"] for i in self.items
                                      if i is not self.target and i["zone"] != "binned"]
                            self.best = {"agent": a.id, "robust": score,
                                         "goal": {"parcel": self.target["id"],
                                                  "bin": self.target["bin"], "avoid": others},
                                         "action": action}
                            self.best_path = ghost["path"]
            # sharing: unsilenced checkers re-test the best and report it
            if not self.silenced and a.role == "checker" and self.best:
                a.robust = round(max(a.robust, self.best["robust"] - 0.05), 2)

    def execute(self):
        if self.phase not in ("searching", "ready"):
            print(f"execute ignored: phase is {self.phase}")
            return
        if not self.best or self.best["robust"] < EXECUTE_MIN:
            print("execute ignored: no push with robust score >= 0.8 yet")
            return
        self.phase = "executing"
        self.exec_stage = "park"
        self.exec_from = dict(self.target["pose"])

    def execute_step(self, dt):
        act = self.best["action"]
        if self.exec_stage == "park":
            step = PARK_SPEED * dt
            self.arm_angle += max(-step, min(step, act["start"] - self.arm_angle))
            if abs(self.arm_angle - act["start"]) < 1e-6:
                self.exec_stage = "sweep"
            return
        sign = 1 if act["end"] >= act["start"] else -1
        self.arm_angle += sign * act["speed"] * dt
        span = abs(act["end"] - act["start"]) or 1
        s = min(1.0, abs(self.arm_angle - act["start"]) / span)
        # the parcel follows the predicted path as the sweep progresses
        p = self.best_path[min(len(self.best_path) - 1, int(s * (len(self.best_path) - 1)))]
        self.target["pose"] = {"x": p[0], "y": p[1], "theta": p[3]}
        if s >= 1.0:
            self.arm_angle = act["end"]
            self.finish()

    def finish(self):
        item = self.target
        end = self.best_path[-1]
        predicted = {"x": end[0], "y": end[1], "theta": end[3]}
        actual = {"x": round(end[0] + random.gauss(0, 6), 1),
                  "y": round(end[1] + random.gauss(0, 6), 1),
                  "theta": round(end[3] + random.gauss(0, 8), 1)}
        landed = in_rect(actual["x"], actual["y"], BAGS[item["bin"]])
        self.result = {"parcel": item["id"], "bin": item["bin"], "landed": landed,
                       "predicted": predicted, "actual": actual}
        item["pose"] = actual
        item["zone"] = "binned"
        item["status"] = "sorted" if landed else "missed"
        self.phase = "done"

    # ---- commands ---------------------------------------------------------

    def replan(self):
        if self.phase == "executing":
            print("replan ignored while executing")
            return
        if self.phase == "done":
            binned = next(i for i in self.items if i["zone"] == "binned")
            waiting = next(i for i in self.items if i["zone"] == "scan")
            waiting.update(zone="pick", pose=random_pose_in("pick"))
            # the recycled parcel takes a different colour so both bags get used
            colour = random.choice([c for c in COLOURS if c != waiting["color"]] or COLOURS)
            binned.update(zone="scan", pose=random_pose_in("scan"), color=colour,
                          bin=COLOUR_TO_BAG[colour], status="waiting")
        else:
            self.target["pose"] = random_pose_in("pick")
        self.start_search()

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
            self.replan()
        elif cmd == "execute":
            self.execute()
        else:
            print("unknown command:", msg)
            return
        print("command:", msg)

    def frame(self):
        return {
            "phase": self.phase,
            "items": self.items,
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
