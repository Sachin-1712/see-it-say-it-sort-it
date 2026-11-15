"""All four planning capabilities, checkpointable without an observer/coordinator."""
import copy
import math
import random
import time
from collections import Counter
from itertools import islice

import numpy as np

from sim.api import perturbed_scene, rollout
from sim.search import candidate_actions
from .task import advance, digest, scene_from

ROLES = ("explorer", "optimizer", "validator", "sequencer")


def assignment(ids):
    ids = sorted(ids)
    if len(ids) < 4:
        return {key: ROLES[i] for i, key in enumerate(ids)}
    roles = list(ROLES)
    for role in ("explorer", "optimizer", "validator", "explorer")[:len(ids) - 4]:
        roles.append(role)
    roles.sort(key=ROLES.index)
    return dict(zip(ids, roles))


def trim_result(result):
    result = copy.deepcopy(result)
    result["trajectories"] = {key:path for key,path in result.get("trajectories",{}).items() if key in ("stick",result["target"]["id"])}
    for key, path in result["trajectories"].items():
        stride=max(6,math.ceil(len(path)/40))
        result["trajectories"][key] = path[::stride] + ([path[-1]] if path and path[-1] not in path[::stride] else [])
    result.pop("servo_trajectory", None)
    return result


def evidence_score(record):
    evidence = record.get("evidence", {})
    return sum(v["success"] for v in evidence.values()) / len(evidence) if evidence else 0.0


def uncertainty(scene, rng, *, positions=True):
    settings = scene.config()["scoring"]["robustness"]
    ids = [o["instanceId"] for o in scene.snapshot["objects"] if o["type"] == "box"]
    return dict(
        friction_scale={key: float(rng.uniform(1 - settings["friction_fraction"], 1 + settings["friction_fraction"])) for key in ids},
        mass_scale={key: float(rng.uniform(1 - settings["mass_fraction"], 1 + settings["mass_fraction"])) for key in ids},
        position_offset_mm={key: rng.uniform(-settings["position_mm"], settings["position_mm"], 2).tolist() if positions else [0, 0] for key in ids},
        tilt_offset_deg=float(rng.uniform(-settings["tilt_deg"], settings["tilt_deg"])),
    )


class Planner:
    def __init__(self, task, agent_id, seed, audit=lambda event: None):
        self.task, self.id, self.settings = task, agent_id, task["settings"]
        self.rng = random.Random(seed)
        self.physics_rng = np.random.default_rng(seed ^ 0xC0FFEE)
        self.audit = audit
        self.trials = 0
        self.attempts = 0
        self.precheck_rejections = 0
        self.plan_trials = 0
        self.successes = 0
        self.role_trials = Counter()
        self.nodes = {}
        self.candidates = {}
        self.plans = {}
        self.tested = set()
        self.cursors = {}
        self.pools = {}
        self.extended = set()
        self.retired = set()
        self.rejected = set()
        self.latest = None
        self.progress = 0
        self.best = None
        self.role = "explorer"
        self.active_job = None
        self.blocked = set()
        self.recovered_jobs = []
        self.add_node(task["snapshot"], [], [], {})

    def add_node(self, snapshot, actions, results, caught):
        # Prefix actions identify a node. Rounded poses alone cannot alias paths.
        key = digest(actions)
        if key not in self.retired and key not in self.nodes and len(self.nodes) < self.settings["max_nodes"]:
            self.nodes[key] = dict(id=key, snapshot=snapshot, actions=actions, results=results, caught=caught, depth=len(actions))
        return key

    def state_scene(self, node):
        return scene_from(self.task, node["snapshot"])

    def remaining(self, node):
        return [o for o in node["snapshot"]["objects"] if o["type"] == "box" and o["instanceId"] not in node["caught"]]

    def pool(self, node):
        if node["id"] not in self.pools:
            remaining = self.remaining(node)
            # Test every available target; the beam naturally favors top-down when lower pushes destabilize others.
            remaining.sort(key=lambda obj: -obj["position"]["z"])
            per_target = max(1, self.settings["candidate_limit_per_state"] // max(1, len(remaining)))
            actions = []
            for target in remaining:
                for action in islice(candidate_actions(self.state_scene(node), target["instanceId"]), per_target):
                    action["direction"] = "left" if action["sweep_end_deg"] > action["sweep_start_deg"] else "right"
                    actions.append(action)
            # Preserve the useful geometric ordering while giving workers independent local search orders.
            for offset in range(0, len(actions), 20):
                block = actions[offset:offset + 20]
                self.rng.shuffle(block)
                actions[offset:offset + 20] = block
            self.pools[node["id"]] = actions
        return self.pools[node["id"]]

    def trial(self, scene, action, params=None):
        result = rollout(scene, action, physics_params=params)
        self.attempts += 1
        if not result["engine_ran"]:
            self.precheck_rejections+=1
            self.audit(dict(type="precheck_rejection",agent=self.id,action=action,params=params,reason=result["reason"],attempt=self.attempts))
            return result
        self.trials += 1
        self.successes += int(result["success"])
        self.role_trials[self.role] += 1
        trial_id = f"{self.id}:{self.task['scene_version']}:{self.attempts}"
        self.latest = dict(agent=self.id, trial_id=trial_id, timestamp=time.time(), role=self.role,
                           action=action, target=action["target"], success=result["success"], score=result["score"],
                           reason=result["reason"], trajectories=trim_result(result)["trajectories"],
                           task_id=self.task["task_id"], scene_version=self.task["scene_version"])
        self.audit(dict(type="trial", **{k: v for k, v in self.latest.items() if k != "trajectories"},
                        params=params, contacts=result["contacts"], peak_torque_nm=result.get("peak_servo_torque_nm")))
        return result

    def candidate_job(self, node, action):
        key = digest([node["id"], action])
        if key in self.tested:
            return None
        return dict(kind="candidate", key=key, node=node["id"], action=action)

    def explore_job(self):
        nodes = [n for n in self.nodes.values() if self.remaining(n)]
        # Deeper states get priority; periodically revisit shallower alternatives.
        nodes.sort(key=lambda n: (-n["depth"], n["id"]))
        if self.progress % 4 == 0:
            nodes.reverse()
        for node in nodes:
            pool = self.pool(node)
            cursor = self.cursors.get(node["id"], 0)
            while cursor < len(pool):
                action = pool[cursor]
                cursor += 1
                self.cursors[node["id"]] = cursor
                job = self.candidate_job(node, action)
                if job:
                    return job
        return None

    def optimize_job(self):
        if self.plans and self.rng.random()<.6:
            plans=sorted(self.plans.values(),key=lambda p:-evidence_score(p))[:6]
            parent=self.rng.choice(plans)
            actions=copy.deepcopy(parent["actions"])
            reasons=Counter(v["reason"].split(":")[0] for v in parent.get("evidence",{}).values() if v.get("reason") and ":" in v["reason"])
            target=reasons.most_common(1)[0][0] if reasons else self.rng.choice(actions)["target"]
            action=next((a for a in actions if a["target"]==target),self.rng.choice(actions))
            if self.rng.random()<.6:
                index=actions.index(action)
                scene=scene_from(self.task)
                for result in parent["results"][:index]:scene=advance(scene,result)
                pool=list(islice(candidate_actions(scene,action["target"]),self.settings["candidate_limit_per_state"]))
                if pool:
                    proposal=dict(self.rng.choice(pool));proposal["direction"]=action["direction"]
                    actions[index]=proposal
                    key="mutation:"+digest(actions)
                    if key not in self.tested:return dict(kind="plan_mutation",key=key,actions=actions)
            field=self.rng.choice(["tilt_deg","tilt_deg","speed_deg_s","sweep_start_deg"])
            if field=="tilt_deg":
                lo,hi=self.task["config"]["models"]["sweeper"]["assemblyTilt"]["limitsDeg"]
                margin=self.task["config"]["scoring"]["robustness"]["tilt_deg"];lo+=margin;hi-=margin
                action[field]=max(lo,min(hi,action[field]+self.rng.choice([-.5,.5,-1,1])))
            elif field=="speed_deg_s":action[field]=self.rng.choice(self.task["config"]["sim"]["demo_speeds_deg_s"])
            else:
                lo,hi=self.task["config"]["models"]["sweeper"]["servo"]["limitsDeg"]
                action[field]=self.rng.choice([lo if action["direction"]=="left" else hi,max(lo,min(hi,action[field]+self.rng.choice([-6,-2,2,6])))])
            key="mutation:"+digest(actions)
            if key not in self.tested:
                return dict(kind="plan_mutation",key=key,actions=actions)
        if self.rng.random() < .15:
            return self.explore_job()
        promising = sorted(self.candidates.values(), key=lambda c: (len(self.nodes.get(c["node"], {}).get("actions", [])), evidence_score(c)), reverse=True)
        if not promising:
            return self.explore_job()
        for _ in range(20):
            candidate = self.rng.choice(promising[:12])
            if candidate["node"] not in self.nodes:
                continue
            action = dict(candidate["action"])
            spec = self.task["config"]["models"]["sweeper"]
            field = self.rng.choice(["tilt_deg", "tilt_deg", "sweep_start_deg", "speed_deg_s"])
            if field == "tilt_deg":
                lo, hi = spec["assemblyTilt"]["limitsDeg"]
                margin=self.task["config"]["scoring"]["robustness"]["tilt_deg"];lo+=margin;hi-=margin
                action[field] = round(max(lo, min(hi, action[field] + self.rng.choice([-.5, .5, -1, 1]))), 3)
            elif field == "sweep_start_deg":
                lo, hi = spec["servo"]["limitsDeg"]
                action[field] = self.rng.choice([lo if action["direction"]=="left" else hi,max(lo, min(hi, action[field] + self.rng.choice([-6, -2, 2, 6])))])
            else:
                # Simulation profiles only. No claim that UNO Q supports arbitrary timing.
                action[field] = self.rng.choice(self.task["config"]["sim"]["demo_speeds_deg_s"])
            job = self.candidate_job(self.nodes[candidate["node"]], action)
            if job:
                return job
        return self.explore_job()

    def needs_trials(self, record, count):
        n = len(record.get("evidence", {}))
        wins = sum(e["success"] for e in record.get("evidence", {}).values())
        return n < count and (wins + count - n) / count >= self.settings["robust_threshold"]

    def validate_job(self):
        for plan in sorted(self.plans.values(), key=lambda p: (-evidence_score(p), len(p.get("evidence", {})))):
            if "plan:" + plan["id"] not in self.blocked and self.needs_trials(plan, self.settings["plan_validation_trials"]):
                return dict(kind="plan_trial", key="plan:" + plan["id"], plan=plan["id"])
        candidates = [c for c in self.candidates.values() if c["node"] in self.nodes and "validate:" + c["id"] not in self.blocked and self.needs_trials(c, self.settings["action_validation_trials"])]
        candidates.sort(key=lambda c: (-self.nodes[c["node"]]["depth"], -evidence_score(c), len(c.get("evidence", {})), c["id"]))
        if candidates:
            candidate = candidates[0]
            return dict(kind="validate", key="validate:" + candidate["id"], candidate=candidate["id"])
        return None

    def sequence_job(self):
        count = self.settings["action_validation_trials"]
        eligible = [c for c in self.candidates.values() if c["node"] in self.nodes and c["id"] not in self.extended and "extend:" + c["id"] not in self.blocked
                    and len(c.get("evidence", {})) >= count and evidence_score(c) >= self.settings["robust_threshold"]]
        eligible.sort(key=lambda c: (-self.nodes[c["node"]]["depth"], -evidence_score(c), c["id"]))
        for candidate in eligible:
            parent = self.nodes[candidate["node"]]
            child = digest(parent["actions"] + [candidate["action"]])
            if child in self.nodes or child in self.retired:
                self.extended.add(candidate["id"])
                continue
            return dict(kind="extend", key="extend:" + candidate["id"], candidate=candidate["id"])
        validation=self.validate_job()
        if validation and validation["key"] not in self.blocked:return validation
        return self.explore_job()

    def choose(self, preferred, allowed=lambda job: True):
        self.blocked.clear()
        methods = {"explorer":self.explore_job, "optimizer":self.optimize_job,
                   "validator":self.validate_job, "sequencer":self.sequence_job}
        if self.recovered_jobs:
            job = self.recovered_jobs.pop(0)
            if job.get("node") in self.nodes and job.get("action"):
                self.role = preferred
                return job
        # Real role changes reflect the work actually selected, including fallback work.
        order = [preferred] + [r for r in ROLES if r != preferred]
        for role in order:
            self.role = role
            for _ in range(4):
                job = methods[role]()
                if not job:
                    break
                if allowed(job):
                    self.active_job = job
                    return job
                self.blocked.add(job["key"])
        return None

    def evidence(self, record, success, reason):
        key = f"{self.id}:{self.attempts}:{self.plan_trials}"
        record.setdefault("evidence", {})[key] = dict(success=bool(success), reason=reason, validator=self.id)

    def perform(self, job):
        kind = job["kind"]
        if kind == "candidate":
            self.tested.add(job["key"])
            node = self.nodes[job["node"]]
            result = self.trial(self.state_scene(node), job["action"])
            if result["success"]:
                self.candidates[job["key"]] = dict(id=job["key"], node=node["id"], action=job["action"], result=trim_result(result), origin=self.id, evidence={})
        elif kind == "validate":
            candidate = self.candidates.get(job["candidate"])
            if candidate:
                scene = self.state_scene(self.nodes[candidate["node"]])
                result = self.trial(scene, candidate["action"], uncertainty(scene, self.physics_rng))
                self.evidence(candidate, result["success"], result["reason"])
        elif kind == "extend":
            candidate = self.candidates[job["candidate"]]
            parent = self.nodes[candidate["node"]]
            self.extended.add(candidate["id"])
            next_scene = advance(self.state_scene(parent), candidate["result"])
            caught = {**parent["caught"], candidate["action"]["target"]:candidate["result"]["target"]["landed_bag"]}
            actions, results = parent["actions"] + [candidate["action"]], parent["results"] + [candidate["result"]]
            key = digest(actions)
            if caught == self.task["goals"] and candidate["result"].get("bag_assignments") == self.task["goals"]:
                self.plans.setdefault(key, dict(id=key, actions=actions, results=results, final_snapshot=next_scene.snapshot, caught=caught, evidence={}, origin=self.id))
                self.audit(dict(type="plan_nominal", plan_id=key, steps=len(actions), agent=self.id))
            elif len(caught)<len(self.task["goals"]):
                self.add_node(next_scene.snapshot, actions, results, caught)
                if key in self.nodes:
                    self.nodes[key]["quality"] = min(parent.get("quality",1), evidence_score(candidate))
            self.prune()
        elif kind == "plan_mutation":
            self.tested.add(job["key"])
            scene=scene_from(self.task);results=[];caught={}
            for action in job["actions"]:
                result=self.trial(scene,action)
                if not result["success"]:break
                results.append(trim_result(result));caught[action["target"]]=result["target"]["landed_bag"]
                scene=advance(scene,result)
            if caught==self.task["goals"] and result.get("bag_assignments")==self.task["goals"]:
                key=digest(job["actions"])
                self.plans.setdefault(key,dict(id=key,actions=job["actions"],results=results,final_snapshot=scene.snapshot,caught=caught,evidence={},origin=self.id))
        elif kind == "plan_trial":
            plan = self.plans.get(job["plan"])
            if plan:
                scene = scene_from(self.task)
                params = uncertainty(scene, self.physics_rng)
                realized_params=copy.deepcopy(params)
                tilt_error = params.pop("tilt_offset_deg")
                scene = perturbed_scene(scene, params, scene.snapshot, scene.config())
                success, reason = True, None
                for action in plan["actions"]:
                    result = self.trial(scene, action, {"tilt_offset_deg":tilt_error})
                    if not result["success"]:
                        success, reason = False, f"{action['target']}: {result['reason']}"
                        break
                    scene = advance(scene, result)
                if success and result.get("bag_assignments") != self.task["goals"]:
                    success,reason=False,"Previously collected parcel left its assigned bin"
                self.plan_trials += 1
                self.evidence(plan, success, reason)
                self.audit(dict(type="plan_validation", agent=self.id, plan_id=plan["id"], success=success, reason=reason, trial=self.plan_trials, physics_params=realized_params))
        self.prune()
        self.progress += 1
        self.active_job = None
        self.update_best()

    def prune(self):
        count=self.settings["action_validation_trials"]
        for key,candidate in self.candidates.items():
            n=len(candidate.get("evidence",{}));wins=sum(v["success"] for v in candidate.get("evidence",{}).values())
            if (wins+max(0,count-n))/max(count,n)<self.settings["robust_threshold"]:
                self.rejected.add(key)
        for depth in range(1,len(self.task["goals"])):
            nodes=sorted((n for n in self.nodes.values() if n["depth"]==depth),key=lambda n:(-n.get("quality",0),n["id"]))
            for node in nodes[self.settings["beam_width"]:]:
                self.retired.add(node["id"])
        for key in self.retired:
            self.nodes.pop(key,None)
        self.candidates={key:c for key,c in self.candidates.items() if c["node"] in self.nodes and key not in self.rejected}
        # Per-state quotas reserve room for deeper frontiers. A flood of root
        # candidates must not prevent a lone worker from completing the last step.
        selected={}
        for node_id in self.nodes:
            group=[c for c in self.candidates.values() if c["node"]==node_id]
            elite=sorted((c for c in group if len(c.get("evidence",{}))>=count),key=lambda c:(-evidence_score(c),c["id"]))[:4]
            pending=sorted((c for c in group if len(c.get("evidence",{}))<count),key=lambda c:(-len(c.get("evidence",{})),c["id"]))[:12]
            selected.update({c["id"]:c for c in elite+pending})
        self.candidates=selected
        # Keep records of accepted plans; bound rejected terminal alternatives.
        if len(self.plans)>24:
            ranked=sorted(self.plans.values(),key=lambda p:(-evidence_score(p),p["id"]))
            certified=[p for p in ranked if len(p.get("evidence",{}))>=self.settings["plan_validation_trials"] and evidence_score(p)>=self.settings["robust_threshold"]][:4]
            parents=ranked[:6]
            pending=sorted((p for p in ranked if self.needs_trials(p,self.settings["plan_validation_trials"])),key=lambda p:(-len(p.get("evidence",{})),p["id"]))[:12]
            self.plans={p["id"]:p for p in certified+parents+pending}

    def update_best(self):
        eligible = [p for p in self.plans.values() if len(p.get("evidence", {})) >= self.settings["plan_validation_trials"]
                    and evidence_score(p) >= self.settings["robust_threshold"]]
        self.best = max(eligible, key=lambda p:(evidence_score(p), -len(p["actions"]))) if eligible else None

    def checkpoint(self):
        return copy.deepcopy(dict(schema_version=2, task_id=self.task["task_id"], scene_version=self.task["scene_version"], agent=self.id,
                    checkpoint_id=f"{self.id}:{self.progress}", trials=self.trials, attempts=self.attempts, precheck_rejections=self.precheck_rejections, successes=self.successes, plan_trials=self.plan_trials,
                    role=self.role, role_trials=dict(self.role_trials), active_job=self.active_job,
                    nodes=self.nodes, candidates=self.candidates, plans=self.plans, tested=sorted(self.tested),
                    cursors=self.cursors, progress=self.progress, retired=sorted(self.retired), rejected=sorted(self.rejected), rng_state=self.rng.getstate(),
                    physics_rng_state=self.physics_rng.bit_generator.state))

    def merge(self, checkpoint):
        if checkpoint.get("task_id") != self.task["task_id"] or checkpoint.get("scene_version") != self.task["scene_version"]:
            return False
        # Merging is monotonic: union unique evidence, never average scores or
        # overwrite a stronger validation with an older checkpoint.
        self.retired.update(checkpoint.get("retired",[]))
        self.rejected.update(checkpoint.get("rejected",[]))
        for key, node in checkpoint.get("nodes", {}).items():
            if key not in self.retired and key not in self.nodes and len(self.nodes) < self.settings["max_nodes"]:
                self.nodes[key] = copy.deepcopy(node)
        for group in ("candidates", "plans"):
            target = getattr(self, group)
            for key, record in checkpoint.get(group, {}).items():
                if key not in target:
                    target[key] = copy.deepcopy(record)
                else:
                    target[key].setdefault("evidence", {}).update(record.get("evidence", {}))
        self.tested.update(checkpoint.get("tested", []))
        self.prune()
        self.update_best()
        return True

    def restore(self, checkpoint):
        if not self.merge(checkpoint):
            return False
        self.cursors.update(checkpoint.get("cursors", {}))
        if checkpoint.get("agent") == self.id:
            self.trials = checkpoint.get("trials", 0)
            self.attempts = checkpoint.get("attempts",self.trials)
            self.precheck_rejections=checkpoint.get("precheck_rejections",0)
            self.successes = checkpoint.get("successes", 0)
            self.plan_trials = checkpoint.get("plan_trials", 0)
            self.progress = checkpoint.get("progress", 0)
            self.role_trials.update(checkpoint.get("role_trials", {}))
            def tuples(value):
                return tuple(tuples(x) for x in value) if isinstance(value, list) else value
            self.rng.setstate(tuples(checkpoint["rng_state"]))
            self.physics_rng.bit_generator.state = checkpoint["physics_rng_state"]
        if checkpoint.get("active_job"):
            self.recovered_jobs.append(checkpoint["active_job"])
        return True
