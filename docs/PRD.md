# Dry Run: PRD (DurHack 2026)

Version 2, Sat 14 Nov 2026, 21:30. Team: Sachin (MacBook Air M2, Claude Code) and Joe (MacBook Pro, Codex).
Sponsor briefs and event rules: `durhack-2026-brief.md`. Submission deadline: **12:00 Sunday**.

**Changes since version 1.1**
- Scenario is now **parcel sorting**: push each parcel into the left or right bag by its colour.
- New flow with a scan zone and a pick zone (section 4), so one servo can push either way.
- Agent roles renamed: Router, Planner, Checker, Watcher. Every agent can do every role.
- The push runs when a person presses **Send to Arduino**.
- Viewer data format now carries a list of items (section 7).
- Viewer look follows Joe's sketch (section 6.9).
- Cut: stacks, tilting, photo-to-3D.

---

## 1. Summary

**Pitch:** a swarm of independent agents rehearses every parcel's sort in a digital twin before the real arm moves, and still gets it right when half the swarm is gone.

**What the judge sees:** a small servo arm, two bags and colour-tagged parcels. On screen, a 3D copy of the table. The judge puts a parcel down. Agents read its colour, try hundreds of pushes in the 3D copy, and the judge kills some of them mid-search. The survivors finish. The judge presses Send, and the real arm pushes the parcel into the correct bag.

**Principle: everything shown is real, and anything pre-made is said out loud.**

---

## 2. Prizes to enter

| Prize | Why we fit | Needs |
| --- | --- | --- |
| **Neptune North** (£1,000), primary | Common goal, independent agents, works with agents killed or all communication cut, real-world use case | Milestones 1, 2, 4 |
| **RS** | Sense (camera reads parcel colour and position), analyse, decide, act (servo). **Requires the UNO Q and camera in the loop** | Milestones 3, 6 with the servo on the UNO Q |
| **Marshall Wace** "New Worlds" | Hundreds of parallel simulated worlds, one made real. Creativity, technical complexity, presentation | Milestones 1–5 |
| **Overall** | Technical competence and polish. Theme fit is weak, so don't force it | Milestones 1–6 |

---

## 3. Goals and non-goals

**Goals**
1. A physics simulation of the rig that predicts whether a push lands a parcel in the chosen bag.
2. Several independent agents plan the sort with no coordinator.
3. Killing agents, or cutting all communication, does not stop a correct plan being found.
4. The chosen push runs on the real servo and the parcel lands in the right bag.
5. The camera supplies each parcel's colour and position.
6. Measured numbers (section 10).

**Non-goals**
- No stacked parcels and no tilting. One parcel at a time, lying flat.
- No photo-to-3D. Parcels are boxes described by three measurements.
- No trained AI. Agents are search programs. No LLM on the critical path.
- No fast moves. Slow pushes only.
- No scripted or pre-recorded agent behaviour.
- No mention of DHL or anyone else's sorting product in the pitch.

---

## 4. The rig and the flow

**Hardware:** UNO Q, Nano ESP32 (fallback), 2 Fitec FS90 servos, USB camera (works as a Mac webcam), power bank, jumper wires.

**Layout**
- **Table:** a raised flat surface, such as a hardback book.
- **Arm:** servo taped at the back centre, axis vertical, stick under 10 cm. It sweeps flat from 0° (pointing right) to 180° (pointing left).
- **Pick zone:** a marked rectangle in front of the arm, inside its sweep.
- **Scan zone:** a marked rectangle at the front, outside the sweep.
- **Bags:** two open containers below the left and right table edges.
- **Parcels:** small light boxes (the empty UNO Q box and similar), each with a coloured sticky note. Colour decides the bag, set in `rig.json`.
- **Camera:** fixed overhead.

**Flow for one parcel**
1. Parcel is placed in the scan zone. The camera reads its colour. The bag is chosen.
2. The arm parks on the side it needs to push from. The pick zone is empty, so nothing is in its way.
3. The judge slides the parcel into the pick zone (standing in for a conveyor).
4. The camera reads the exact position. Agents search for a push.
5. A person presses Send. The arm pushes. The camera confirms the parcel has left the table.

A second parcel can wait in the scan zone. It must not be disturbed.

**Power:** servo power from 5 V, never the 3.3 V pin. Join all grounds.

**Measure once into `config/rig.json` (mm, degrees):** table size, arm pivot, arm length and height, both zones, both bag openings, parcel sizes and weights, colour-to-bag mapping.

**First physical test (15 minutes):** confirm the servo can slide an empty parcel off the side of the table.

---

## 5. Setup

**Both laptops**
1. Empty repo `dry-run`, this PRD as `docs/PRD.md`, and a `CLAUDE.md` / `AGENTS.md`: "Read docs/PRD.md first. Build one milestone at a time. Do not change section 7 without telling the other person."
2. Python 3.11 or 3.12 (not 3.14): `brew install python@3.12`, then a virtual environment with `pip install mujoco numpy pyserial opencv-python websockets`.
3. Check: `python -c "import mujoco; print(mujoco.__version__)"`. Fallback engine: `pip install pybullet-arm64`.
4. Phone hotspot for laptop-to-laptop traffic.

---

## 6. How it works

### 6.1 Simulation (`sim/`, MuJoCo)
- Scene from `rig.json`: table, parcels (free bodies), arm (hinge with a servo-like position actuator), bag openings as regions.
- `rollout(action, poses, params) -> result`: about 3 simulated seconds. Returns where the target parcel ended, how far any other parcel moved, and the path.
- `params`: friction, parcel mass, position error.

### 6.2 Action
One slow sweep: start angle, end angle, speed. The start angle fixes which side the arm pushes from.

### 6.3 Score
- Success: the target parcel leaves the table through the chosen bag's opening.
- Fail: wrong side, misses the opening, stays on the table, or any other parcel moves more than a few millimetres.
- **Robust score:** the same action run 10 times with friction, mass and position varied. Score is the fraction that succeed.

### 6.4 Agents (`agent/`)
One Python process per agent, own random seed, own simulation. No coordinator.

| Role | Job |
| --- | --- |
| Router | Reads the parcel's colour from the camera data and picks the bag from the mapping |
| Planner | Searches for a push: random first, then small variations of the best |
| Checker | Re-tests the swarm's best push for its robust score |
| Watcher | Confirms a parcel is present and still in the pick zone before a push, and that it left the table after |

- **Every agent can do every role.** A role is only its current focus.
- Agents share their role and best result by UDP several times a second, and adopt a better result when they hear one.
- **Takeover:** if an agent hears nobody in a role for 2 seconds, it switches to that role.
- **Silence:** with communication cut, each agent cycles through all four roles alone. Slower, same answer.

### 6.5 Faults
`die` (agent exits), `silence` / `unsilence` (stop sending, ignore incoming), or close a laptop lid.

### 6.6 Arm driver
The process that can reach the board. On `execute` it runs the best push it has heard, but only if the robust score is 0.8 or more and a Watcher has confirmed the parcel. One arm, one driver: say so if asked.

### 6.7 Firmware
One command per line: `P <arm> <start> <end> <speed>`, reply `DONE`. Also `G <arm> <angle>` to park.
- **UNO Q (preferred, needed for RS):** a small Python program on the board's Linux side receives the command over the network and calls the servo sketch.
- **Nano ESP32 (fallback):** the same commands over USB serial at 115200.
- Decide by about 22:30 which board is used.

### 6.8 Camera (`vision/`)
- One-time: click the four table corners.
- Each frame: find each coloured note, output colour, centre, rotation and zone.
- Runs on a Mac first. Moving it to the UNO Q is part of the RS work.

### 6.9 Viewer (`viewer/`, three.js)
- Grey "blank workshop" with white gridlines, fixed three-quarter camera.
- Charcoal panels, yellow accent. Green for success, red for Kill.
- Table, arm, zones, bags and parcels from `rig.json`. Ghost attempts per agent.
- Right panel with tabs: **Agents** (rows with role and Kill) and **Outcomes** (attempts tested, successes, predicted against actual).
- **Items** list: each parcel with colour, zone, chosen bag, status.
- **Send to Arduino** button, enabled at robust score 0.8 or more.
- Built against `scripts/fake_observer.py` until the real observer exists.

---

## 7. Interfaces (agree and commit before coding)

```
action  {"arm": 0, "start": 10, "end": 150, "speed": 60}
pose    {"x": 112, "y": 64, "theta": 15}                    # mm, degrees, table frame, z up
item    {"id": "p1", "color": "red", "zone": "scan"|"pick"|"binned",
         "pose": {...}, "bin": "left"|"right"|null, "status": "waiting"|"planning"|"ready"|"sorted"|"missed"}
goal    {"parcel": "p1", "bin": "left", "avoid": ["p2"]}

UDP (JSON) between agents, and agents to observer:
  best  {"t":"best","id":"a3","role":"planner","goal":{...},"action":{...},"robust":0.9,"tries":412}
  ctl   {"t":"ctl","cmd":"die"|"silence"|"unsilence"|"replan"|"execute"|"items", ...}

WebSocket observer -> viewer, about 10 per second, ws://localhost:8765
{
  "phase":  "idle"|"searching"|"ready"|"executing"|"done",
  "items":  [item, ...],
  "arm":    {"angle": 20},
  "agents": [{"id":"a1","role":"router"|"planner"|"checker"|"watcher","alive":true,
              "silenced":false,"tries":412,"robust":0.6}],
  "ghosts": [{"agent":"a1","parcel":"p1","success":false,"path":[[x,y,z,theta],...]}],
  "best":   {"agent":"a3","robust":0.9,"goal":{...},"action":{...}},
  "result": null | {"parcel":"p1","bin":"left","landed":true,
                    "predicted":{...},"actual":{...}}
}
Viewer -> observer: {"cmd":"die","id":"a1"} | {"cmd":"silence"} | {"cmd":"unsilence"}
                    | {"cmd":"replan"} | {"cmd":"execute"}
```

---

## 8. Milestones (cut from the bottom)

| # | Milestone | Done when | Owner |
| --- | --- | --- | --- |
| 1 | Simulation and one agent | Headless: one agent finds a push with robust score 0.8 or more into each bag, for 5 parcel positions | Joe |
| 2 | Swarm | 8 agents, four roles, takeover, kill and silence. A test script asserts a correct plan after killing half, and with silence on | Joe |
| 3 | Servo rig | A typed `P` command makes the real arm push a real parcel into each bag | Joe (board), Sachin (rig) |
| 4 | Viewer | Section 6.9 working on fake data | Sachin |
| 5 | Simulation to reality | Send runs the swarm's push on the servo. Friction tuned until 8 of 10 real pushes land | Both |
| 6 | Camera | Colour, position and zone come from the camera. Moving a parcel moves it on screen | Sachin |
| 7 | Second laptop and numbers | Agents on both Macs. Section 10 measured | Joe |
| 8 | Stretch | Second arm, or camera running on the UNO Q for RS (3-hour cap) | Either |
| 9 | Polish | Rehearsed script, backup video, README, Devpost | Both |

Milestones 1, 2 and 4 alone are a valid Neptune North entry. Milestone 9 is not optional.

**Rough checkpoints**
- **About 23:30:** milestone 1 passing. Real servo pushes a parcel into a bag by typed command.
- **About 02:00:** milestones 2, 4 and 5 working together once. Record a backup video.
- **About 03:00:** feature freeze. Sleep in shifts.
- **About 08:00:** start milestone 9. **11:00:** submit.

**If real pushes are unreliable by 02:00:** demo the simulation and swarm, show the servo attempt, and say plainly that matching reality is unfinished.

---

## 9. Demo script (2 to 3 minutes)

1. **Hook:** "A mis-sorted parcel costs money. Ours rehearses every sort first, and you get to sabotage the rehearsal."
2. **Scan:** judge places a parcel. Its colour and bag appear on screen. The arm parks.
3. **Pick:** judge slides it in. Ghost attempts fill the screen. "Each colour is an independent program. Nothing is in charge."
4. **Sabotage:** judge kills half the agents or presses silence. Roles get picked up and the search finishes.
5. **Send:** judge presses the button. The parcel lands in the right bag. Screen shows predicted against actual.
6. **Repeat** with the other colour, into the other bag.
7. **Close:** numbers, real-world line, honest limits.

---

## 10. Numbers to measure

| Number | How |
| --- | --- |
| Time to a robust plan: 8, 4 and 1 agents | Average of 10 runs each |
| Same, with silence on | 10 runs |
| Real sorts that land in the correct bag | 20 trials, both bags, varied positions |
| Takeover time after a role's agents are killed | Seconds until the role is covered again |

---

## 11. What we say

| Topic | Say | Never say |
| --- | --- | --- |
| The 3D scene | "Built from measurements. The camera places each parcel live" | "The camera scanned the room" |
| Parcels | "Boxes from three measurements. Arbitrary shapes are the next step" | "Generated from a photo" |
| Agents | "Independent search agents, each with its own simulator" | "AI agents that learn" |
| Roles | "Any agent can do any role, so losing one loses nothing" | "Each agent is a specialist" |
| The demo rig | "A desk-sized stand-in for one station on a sorting line" | Anything about a specific company |
| Limits | "One arm, flat boxes, slow pushes, friction tuned by hand, a hand as the conveyor" | Nothing |

**Real-world use:** parcel sorting centres and production lines. Testing a machine's move in a simulated copy before running it is established practice (virtual commissioning; Siemens, NVIDIA and Rockwell sell tools). Those run centrally. Ours is a small rehearsal service that runs on the devices beside the machine and survives losing some of them or the network.

**Likely questions**
- *"Isn't the push always the same?"* No: position, angle and the waiting parcel change which pushes land in the bag. Show a failed ghost.
- *"Isn't this parallel random search?"* Yes, and that is why no agent depends on another.
- *"Does the simulation match reality?"* Give the measured landing rate.

---

## 12. Risks

| Risk | What we do |
| --- | --- |
| Servo too weak | Empty parcels, short stick, smooth surface. Test first |
| Servo twitches or resets the board | 5 V supply with shared ground |
| UNO Q cannot take commands from the laptop | Nano ESP32 fallback, decided by about 22:30. RS entry is dropped if so |
| Simulation and reality disagree | Slow pushes, robust score, wide bag openings, hand-tuned friction |
| Two AI tools write code that doesn't fit | Section 7 committed before coding. Integrate early |
| Search finishes too fast to sabotage | Waiting parcel as an obstacle, and a cap on attempts per second |
| Camera misreads colour | Saturated sticky notes, a lamp, manual override in the viewer |
| Venue Wi-Fi blocks laptop-to-laptop traffic | Phone hotspot. All agents can run on one laptop |
| Demo fails live | Backup video. Known-good parcel positions marked on the table |