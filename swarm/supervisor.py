"""Optional lifecycle/telemetry observer. It never assigns planning work to peers."""
import copy
import json
import multiprocessing as mp
import socket
import time
import uuid
import threading
from functools import wraps
from pathlib import Path

from .planning import assignment, evidence_score
from .task import ROOT, golden_snapshot, make_task
from .wire import Receiver
from .worker import run_worker


def synchronized(method):
    @wraps(method)
    def wrapped(self,*args,**kwargs):
        with self.lock:return method(self,*args,**kwargs)
    return wrapped


class Swarm:
    def __init__(self, workers=4, seed=2026, directory=None, settings=None):
        if not 1 <= workers <= 8:
            raise ValueError("workers must be from 1 to 8")
        self.lock=threading.RLock()
        self.settings = json.loads((ROOT / "config/swarm.json").read_text())
        self.settings.update(settings or {})
        self.settings.update(workers=workers, seed=seed)
        self.directory = Path(directory or ROOT / ".gekko" / uuid.uuid4().hex)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.context = mp.get_context("spawn")
        self.processes, self.controls, self.reports = {}, {}, {}
        self.events, self.event_ids = [], set()
        self.lifecycle_events=[]
        self.stream_id=uuid.uuid4().hex
        self.frame_seq=0
        self.task = None
        self.version = 0
        self.best = None
        self.saved_bundle = None
        self.live_best_score = 0
        self.stopped = True
        self.source = None
        self.verification_trials=0
        self.killed = set()
        self.silenced = False
        self.dry_run_plan, self.dry_run_step = None, 0
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 * 1024 * 1024)
        self.socket.bind(("127.0.0.1", 0))
        self.socket.setblocking(False)
        self.receiver = Receiver()

    @synchronized
    def start(self, snapshot=None, *, source="workbench", run=True):
        version=self.version+1
        task = make_task(snapshot or golden_snapshot(), version, self.settings)
        if source == "golden":
            fixture = json.loads((ROOT / "config/golden-three-box-v1.json").read_text())
            task["config"] = fixture["config"]
            from .task import digest
            task["task_id"] = digest({k:v for k,v in task.items() if k not in ("task_id", "scene_version")})
        self.stop()
        self.version=version
        self.task, self.source = task, source
        self.best, self.reports, self.events, self.event_ids = None, {}, [], set()
        self.killed = set()
        self.lifecycle_events=[]
        self.silenced = False
        self.dry_run_plan, self.dry_run_step = None, 0
        self.saved_bundle = None
        self.live_best_score = 0
        self.awaiting_outcome = False
        self.physical_step = 0
        self.stopped = not run
        self.started = time.monotonic()
        if not run:
            self.add_event(dict(type="demo_loaded"))
            return task
        ids = [f"a{i + 1}" for i in range(self.settings["workers"])]
        reservations = []
        peers = {}
        for key in ids:
            reserve = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            reserve.bind(("127.0.0.1", 0))
            peers[key] = reserve.getsockname()
            reservations.append(reserve)
        for reserve in reservations:
            reserve.close()
        self.peers = peers
        run_dir = self.directory / f"scene-{self.version}"
        run_dir.mkdir(exist_ok=True)
        (run_dir / "task.json").write_text(json.dumps(task, indent=2))
        for i, key in enumerate(ids):
            parent, child = self.context.Pipe()
            process = self.context.Process(target=run_worker, name=f"gekko-{key}",
                args=(key, task, peers, self.socket.getsockname(), child, run_dir, self.settings["seed"] + i * 1009))
            process.start()
            child.close()
            self.processes[key], self.controls[key] = process, parent
        self.add_event(dict(type="task_started", scene_version=self.version, task_id=task["task_id"], workers=len(ids)))
        return task

    def add_event(self, event):
        event = {"timestamp":time.time(), **event}
        event.setdefault("task_id",self.task["task_id"] if self.task else None)
        event.setdefault("scene_version",self.version)
        key = event.setdefault("id", uuid.uuid4().hex)
        if key not in self.event_ids:
            self.event_ids.add(key)
            self.events.append(event)
            if event["type"]!="checkpoint_reconciled":self.lifecycle_events.append(event)
            with (self.directory/"observer-events.jsonl").open("a") as log:log.write(json.dumps(event)+"\n")
            self.events = self.events[-150:]

    @synchronized
    def kill(self, key):
        process = self.processes.get(key)
        if process and process.is_alive():
            process.kill()
            process.join(timeout=.3)
            self.killed.add(key)
            self.add_event(dict(type="process_killed", agent=key, pid=process.pid, role=self.reports.get(key,{}).get("role"), active_before=sum(p.is_alive() for p in self.processes.values())+1, total_trials=sum(r.get("tries",0) for r in self.reports.values()), had_best=bool(self.best), best_score=evidence_score(self.best[1]) if self.best else 0))
            return True
        return False

    @synchronized
    def silence(self, value):
        self.silenced = bool(value)
        for key, control in self.controls.items():
            if self.processes[key].is_alive():
                try:
                    control.send(dict(cmd="silence" if value else "unsilence"))
                except (BrokenPipeError, OSError):
                    pass

    @synchronized
    def poll(self):
        while True:
            try:
                raw, address = self.socket.recvfrom(65535)
            except BlockingIOError:
                break
            try:
                report = self.receiver.receive(raw, address)
                if not report or report.get("kind") != "telemetry" or not self.task:
                    continue
                key = report["agent"]
                process = self.processes.get(key)
                if (not process or not process.is_alive() or key in self.killed or report.get("pid") != process.pid
                        or report.get("task_id") != self.task["task_id"] or report.get("scene_version") != self.version):
                    continue
                old = self.reports.get(key)
                if old and report["heartbeat"] <= old["heartbeat"]:
                    continue
                self.reports[key] = report
                for event in report.get("events", []):
                    self.add_event(event)
                best = report.get("best")
                if best and len(best.get("evidence",{})) >= max(20,self.settings["plan_validation_trials"]) and evidence_score(best) >= self.settings["robust_threshold"]:
                    if self.best is None or evidence_score(best) > evidence_score(self.best[1]):
                        self.best = (key, copy.deepcopy(best))
                        self.live_best_score = evidence_score(best)
            except (ValueError, KeyError, TypeError):
                continue

    @synchronized
    def frame(self):
        self.poll()
        now = time.time()
        roles = assignment(list(self.processes))
        agents, ghosts = [], []
        for key, process in self.processes.items():
            r = self.reports.get(key, {})
            live = process.is_alive()
            disconnected=live and now-r.get("heartbeat",now)>self.settings["failure_timeout_s"]
            agents.append(dict(id=key, pid=process.pid, alive=live, silenced=r.get("silenced", self.silenced),
                role=r.get("role", roles[key]), tries=r.get("tries", 0), attempts=r.get("attempts",r.get("tries",0)), precheck_rejections=r.get("precheck_rejections",0), robust=r.get("robust", 0),
                successes=r.get("successes",0), status=("Disconnected" if disconnected else r.get("status", "Starting")) if live else ("Stopped" if self.stopped and key not in self.killed else "Dead"), heartbeat=r.get("heartbeat"),
                task=r.get("active_job"), latest=r.get("latest"), role_trials=r.get("role_trials", {}),
                checkpoint_id=r.get("checkpoint_id"), peer_tx=r.get("peer_tx",0), peer_rx=r.get("peer_rx",0),
                reconciliations=r.get("reconciliations",0), plan_trials=r.get("plan_trials",0)))
            trial = r.get("latest")
            if trial and live:
                path = trial.get("trajectories", {}).get(trial["target"], [])
                if path:
                    ghosts.append(dict(agent=key, parcel=trial["target"], success=trial["success"],
                        path=[[p[1], p[2], p[3], p[6]] for p in path], trial_id=trial["trial_id"],
                        timestamp=trial["timestamp"], scene_version=self.version, task_id=self.task["task_id"],
                        trajectories=trial["trajectories"], action=trial["action"], reason=trial["reason"]))
        best = None
        if self.best:
            key, plan = self.best
            action = plan["actions"][0]
            best = dict(agent=key, robust=evidence_score(plan), goal=dict(parcel=action["target"], bin=self.task["goals"][action["target"]]),
                        action=dict(arm=0, start=action["sweep_start_deg"], end=action["sweep_end_deg"], speed=action["speed_deg_s"]),
                        plan=plan, validated=True, attribution="previously_validated" if self.saved_bundle else "live", label=self.saved_bundle["label"] if self.saved_bundle else "VALIDATED IN THIS LIVE RUN", saved_at=self.saved_bundle["timestamp"] if self.saved_bundle else None, task_id=self.task["task_id"], scene_version=self.version, physical_eligible=False)
        alive = [a for a in agents if a["alive"]]
        exhausted = bool(agents) and all(not a["alive"] or self.reports.get(a["id"], {}).get("exhausted") for a in agents)
        phase = "idle" if not self.task else "ready" if best else "stopped" if self.stopped else "failed" if exhausted or (agents and not alive) else "searching"
        items = []
        if self.task:
            for o in self.task["snapshot"]["objects"]:
                if o["type"] == "box":
                    items.append(dict(id=o["instanceId"], color=o.get("color"), zone="pick", pose={**o["position"], "theta":o.get("yaw",0)},
                                      bin=self.task["goals"][o["instanceId"]], status="ready" if best else "planning"))
        self.frame_seq+=1
        return dict(protocol="gekko-swarm-v1", stream_id=self.stream_id, frame_seq=self.frame_seq, phase=phase, items=items, arm=dict(angle=0), agents=agents, ghosts=ghosts,
                    best=best, result=None, task=self.task, source=self.source, events=self.events[-40:], recovery=self.recovery_state(agents), live_search_stopped=self.stopped,
                    metrics=dict(trials=sum(a["tries"] for a in agents), precheck_rejections=sum(a["precheck_rejections"] for a in agents), successes=sum(a["successes"] for a in agents), plan_trials=sum(a["plan_trials"] for a in agents),
                                 verification_trials=self.verification_trials, active=len(alive), elapsed_s=round(time.monotonic()-self.started,2) if self.task else 0),
                    failure="Budget exhausted without a validated plan" if phase=="failed" else None,
                    execution=self.execution_state())

    def execution_state(self):
        steps = len(self.best[1]["actions"]) if self.best else 0
        step = self.dry_run_step if self.best and self.dry_run_plan == self.best[1].get("id") else 0
        return dict(enabled=False, dry_run=True, awaiting_outcome=getattr(self,"awaiting_outcome",False), physical_next_step=(getattr(self,"physical_step",0)+1 if getattr(self,"physical_step",0)<steps else None), next_step=step + 1 if step < steps else None, steps=steps,
                    reason="Dry run: Send logs the servo commands; nothing reaches hardware. Physical L/R calibration and acknowledgement are unverified")

    @staticmethod
    def servo_commands(action, arm=0):
        """PRD section 6.7 firmware lines: park at the start angle, then one slow sweep."""
        number = lambda value: f"{round(float(value), 1):g}"
        start, end, speed = (number(action[key]) for key in ("sweep_start_deg", "sweep_end_deg", "speed_deg_s"))
        return [f"G {arm} {start}", f"P {arm} {start} {end} {speed}"]

    @synchronized
    def dry_run(self):
        """Human-confirmed Send, dry run: the next step of the validated plan becomes the
        firmware lines it would send. They are logged and returned, never transmitted."""
        if not self.task or not self.best:
            raise ValueError("No validated plan to send yet")
        _, plan = self.best
        score = evidence_score(plan)
        if score < self.settings["robust_threshold"]:
            raise ValueError(f"Plan robustness {score:.2f} is below {self.settings['robust_threshold']}")
        if self.dry_run_plan != plan.get("id"):
            self.dry_run_plan, self.dry_run_step = plan.get("id"), 0
        actions = plan["actions"]
        if self.dry_run_step >= len(actions):
            raise ValueError("Every step of this plan has already been sent (dry run). Replan for the next parcels.")
        action = actions[self.dry_run_step]
        self.dry_run_step += 1
        record = dict(type="dry_run_command", step=self.dry_run_step, steps=len(actions), target=action["target"],
                      bin=self.task["goals"][action["target"]], tilt_deg=action["tilt_deg"], commands=self.servo_commands(action),
                      robust=score, plan_id=plan.get("id"), task_id=self.task["task_id"], scene_version=self.version,
                      transmitted=False, note="Dry run: nothing was sent to hardware. Set the tilt by hand before the sweep.")
        with (self.directory / "dry-run-commands.jsonl").open("a") as log:
            log.write(json.dumps({"timestamp": time.time(), **record}) + "\n")
        self.add_event(dict(type="dry_run_command", step=record["step"], steps=record["steps"], target=record["target"],
                            commands=record["commands"], tilt_deg=record["tilt_deg"]))
        print(f"DRY RUN step {record['step']}/{record['steps']} {record['target']} -> {record['bin']} bag: "
              f"set tilt {record['tilt_deg']}° by hand, then {' ; '.join(record['commands'])} (not transmitted)", flush=True)
        return record

    def recovery_state(self, agents):
        recoveries=[]
        for death in [e for e in self.lifecycle_events if e['type']=='process_killed']:
            victim=death['agent']
            events=[e for e in self.lifecycle_events if e.get('failed_agent')==victim and e['timestamp']>=death['timestamp']]
            takeover=next((e for e in reversed(events) if e['type']=='task_takeover'),None)
            resumed=next((e for e in events if e['type']=='work_resumed' and takeover and e.get('agent')==takeover['agent'] and e.get('checkpoint_id')==takeover['checkpoint_id'] and e['timestamp']>=takeover['timestamp']),None)
            successor=next((a for a in agents if takeover and a['id']==takeover['agent']),None)
            current=sum(a['tries'] for a in agents)
            recoveries.append(dict(dead=victim, previous_role=death.get('role'), active_before=death.get('active_before'),
                successor=takeover['agent'] if takeover else None, role=takeover.get('role') if takeover else None,
                checkpoint_id=takeover.get('checkpoint_id') if takeover else None,
                recovered_progress=takeover.get('recovered_progress') if takeover else None,
                recovered_trials=takeover.get('recovered_trials') if takeover else None,
                new_trials=max(0,successor['tries']-takeover.get('successor_trials',successor['tries'])) if successor else 0,
                resumed=bool(resumed), continuing_trials=max(0,current-death.get('total_trials',current)),
                improving=self.live_best_score>death.get('best_score',0), silenced=any(a['silenced'] for a in agents if a['alive']),
                successor_alive=bool(successor and successor['alive']),
                timeline=[dict(stage='Terminated',timestamp=death['timestamp'])]+[
                    dict(stage={'heartbeat_timeout':'Heartbeat lost','task_takeover':'Checkpoint recovered','work_resumed':'Work resumed'}[e['type']], timestamp=e['timestamp'])
                    for e in events if e['type'] in ('heartbeat_timeout','task_takeover','work_resumed')][:12]))
        return recoveries

    @synchronized
    def stop_live(self):
        self.poll()
        processes=dict(self.processes)
        self.stop()
        self.processes=processes  # retain final PID, roles and trials for presentation
        self.stopped=True
        self.add_event(dict(type='live_search_stopped'))

    @synchronized
    def load_saved(self, path=None):
        from .saved_plan import load, DEFAULT_PATH
        from .hardware import configuration
        if not self.task:raise ValueError('Load a matching scene first')
        if not self.stopped:raise ValueError('Stop Live Search before loading a previously validated plan')
        bundle=load(path or DEFAULT_PATH,self.task,configuration())
        self.awaiting_outcome=False
        self.physical_step=0
        self.physical_failed=False
        self.saved_bundle=bundle
        self.best=('offline',bundle['plan'])
        self.dry_run_plan,self.dry_run_step=None,0
        self.add_event(dict(type='previously_validated_plan_loaded',plan_id=bundle['plan']['id'],saved_at=bundle['timestamp']))
        return bundle

    @synchronized
    def replay(self):
        if not self.task or not self.best:raise ValueError('No current validated plan')
        plan=self.best[1]
        results=plan['results']
        if any(not r.get('trajectories') for r in results):
            raise ValueError('Full replay tracks unavailable; load an offline validated bundle')
        self.add_event(dict(type='plan_replayed',steps=len(results),plan_id=plan['id']))
        return dict(type='plan_replay',task_id=self.task['task_id'],scene_version=self.version,results=results,
                    attribution='previously_validated' if self.saved_bundle else 'live',
                    label=self.saved_bundle['label'] if self.saved_bundle else 'VALIDATED IN THIS LIVE RUN')

    @synchronized
    def prepare_step(self, plan_id, tilt_confirmed=False, scene_confirmed=False):
        from .hardware import configuration, prepare
        if not self.saved_bundle or not self.best or self.best[1]['id']!=plan_id:
            raise ValueError('Load a matching previously validated plan first')
        # Recheck files and identity at every action, including calibration changes.
        from .saved_plan import identity
        if time.time()-self.saved_bundle["created_at"]>86400:raise ValueError("Saved plan is stale; regenerate offline")
        if self.saved_bundle['hashes']!=identity(self.task,configuration()):
            raise ValueError('Scene or calibration changed; reload compatible plan')
        if tilt_confirmed is not True or scene_confirmed is not True:
            raise ValueError('Confirm the manual tilt and actual physical scene before each action')
        if getattr(self,'physical_failed',False):raise ValueError('Reset physical scene and reload the plan after an unknown/failed outcome')
        if getattr(self,'awaiting_outcome',False):raise ValueError('Confirm actual box outcome before advancing')
        if self.physical_step>=len(self.best[1]['actions']):raise ValueError('All steps prepared')
        action=self.best[1]['actions'][self.physical_step]
        prepared=prepare(action,configuration())
        self.awaiting_outcome=True
        return dict(type='confirmed_step',step=self.physical_step+1,target=action['target'],
                    bin=self.task['goals'][action['target']],**prepared)

    @synchronized
    def confirm_outcome(self, success):
        if not getattr(self,'awaiting_outcome',False):raise ValueError('No pending step')
        self.awaiting_outcome=False
        if success is not True:
            self.physical_failed=True
            raise ValueError('Box outcome failed or unknown; reset the scene and reload the plan')
        self.physical_step+=1
        return dict(type='outcome_confirmed',next_step=self.physical_step+1)

    @synchronized
    def invalidate(self):
        self.stop()
        self.version+=1
        self.task=None
        self.best=None
        self.saved_bundle=None
        self.awaiting_outcome=False
        self.stopped=True
        self.reports={}
        self.add_event(dict(type="scene_invalidated",scene_version=self.version))

    @synchronized
    def stop(self):
        for key, control in self.controls.items():
            try:
                control.send(dict(cmd="stop"))
            except (BrokenPipeError, OSError):
                pass
        for process in self.processes.values():
            process.join(timeout=2)
            if process.is_alive():
                process.terminate()
                process.join(timeout=2)
        for control in self.controls.values():
            control.close()
        self.processes, self.controls = {}, {}

    @synchronized
    def close(self):
        self.stop()
        self.socket.close()
