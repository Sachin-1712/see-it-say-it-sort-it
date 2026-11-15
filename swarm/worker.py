"""Independent OS worker with peer heartbeats, gossip, leases and disk recovery."""
import copy
import json
import os
import queue
import select
import socket
import threading
import time
from pathlib import Path

from .planning import Planner, ROLES, assignment, evidence_score
from .wire import Receiver, packets


def atomic_json(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, allow_nan=False, separators=(",", ":")))
    temp.replace(path)


def run_worker(agent_id, task, peers, telemetry_address, control, directory, seed):
    directory = Path(directory) / agent_id
    directory.mkdir(parents=True, exist_ok=True)
    audit_file = (directory / "events.jsonl").open("a", buffering=1)
    def audit(event):
        audit_file.write(json.dumps({"timestamp":time.time(), "pid":os.getpid(), "task_id":task["task_id"], "scene_version":task["scene_version"], **event}, allow_nan=False) + "\n")
    planner = Planner(task, agent_id, seed, audit)
    path = directory / "checkpoint.json"
    if path.exists():
        try:
            saved=json.loads(path.read_text())
            planner.restore(saved)
            if saved.get("task_id")==task["task_id"] and saved.get("scene_version")==task["scene_version"] and saved.get("schema_version",1)<2:
                records=[json.loads(line) for line in (directory/"events.jsonl").read_text().splitlines()]
                trials=[r for r in records if r.get("type")=="trial" and r.get("task_id")==task["task_id"] and int(r.get("trial_id",":0").split(":")[-1])<=saved.get("trials",0)]
                rejected=[r for r in trials if str(r.get("reason","")).startswith(("realized tilt_deg outside limits","tilt_deg outside limits","sweep_start_deg outside limits","sweep_end_deg outside limits"))]
                planner.trials=len(trials)-len(rejected);planner.precheck_rejections=len(rejected)
                planner.role_trials.clear()
                for record in trials:
                    if record not in rejected:planner.role_trials[record["role"]]+=1
        except (ValueError, KeyError, TypeError):
            pass
    settings = task["settings"]
    peer_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    peer_socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
    peer_socket.bind(tuple(peers[agent_id]))
    telemetry_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    incoming = queue.Queue(maxsize=128)
    now = time.monotonic()
    state = dict(silenced=False, stop=False, latest=None, checkpoint=planner.checkpoint(), current=None,
                 events=[], peer_tx=0, peer_rx=0, rejected=0, reconciliations=0)
    seen = {key: now for key in peers}
    seen[agent_id] = now
    cached = {}
    declared_dead = set()
    recovered = {}
    peer_claims = {}
    receiver = Receiver()
    event_seq = 0
    def event(kind, **fields):
        nonlocal event_seq
        event_seq += 1
        item = dict(id=f"{agent_id}:{event_seq}:{os.getpid()}", type=kind, agent=agent_id, timestamp=time.time(), **fields)
        state["events"] = (state["events"] + [item])[-40:]
        audit(item)
    def live_ids():
        if state["silenced"]:
            return [agent_id]
        stamp = time.monotonic()
        return sorted(key for key, last in seen.items() if stamp - last <= settings["failure_timeout_s"])
    def tx(sock, addr, message):
        try:
            chunks = packets(message)
            for chunk in chunks:
                sock.sendto(chunk, tuple(addr))
            return len(chunks)
        except (OSError, ValueError):
            return 0
    def envelope(kind, **body):
        return dict(kind=kind, agent=agent_id, pid=os.getpid(), task_id=task["task_id"], scene_version=task["scene_version"], sent_at=time.time(), **body)
    def compact_checkpoint():
        cp=state["checkpoint"]
        job=cp.get("active_job") or {}
        nodes={key:value for key,value in cp.get("nodes",{}).items() if key==job.get("node") or value["depth"]==0}
        candidates={key:value for key,value in cp.get("candidates",{}).items() if key==job.get("candidate")}
        if candidates:
            for candidate in candidates.values():
                node=cp["nodes"].get(candidate["node"])
                if node:nodes[node["id"]]=node
        plans={key:value for key,value in cp.get("plans",{}).items() if key==job.get("plan")}
        compact={key:cp[key] for key in ("agent","task_id","scene_version","checkpoint_id","trials","progress","role")}
        compact.update(active_job=job,assigned_role=cp.get("assigned_role",cp["role"]),cursors=cp.get("cursors",{}),nodes=nodes,candidates=candidates,plans=plans)
        # Heartbeat checkpoints preserve the active frontier and validation work;
        # trajectories are sent on the separate bulk gossip/telemetry channels.
        compact=copy.deepcopy(compact)
        for node in compact["nodes"].values():
            for result in node["results"]:result["trajectories"]={}
        for candidate in compact["candidates"].values():candidate["result"]["trajectories"]={}
        for plan in compact["plans"].values():
            for result in plan["results"]:result["trajectories"]={}
        return compact

    def network():
        gossip_round=0
        last_heartbeat = last_gossip = last_telemetry = 0
        while not state["stop"]:
            stamp = time.monotonic()
            seen[agent_id] = stamp
            try:
                while control.poll():
                    message = control.recv()
                    if message.get("cmd") == "stop":
                        state["stop"] = True
                    elif message.get("cmd") in ("silence", "unsilence"):
                        mute = message["cmd"] == "silence"
                        state["silenced"] = mute
                        event("peer_network_silenced" if mute else "peer_network_restored")
                        if not mute:
                            # Allow a complete heartbeat interval before declaring previously isolated peers dead.
                            seen.update({key: stamp for key in peers})
                            declared_dead.clear()
                            last_gossip = 0
            except (EOFError, OSError):
                # Observer death must not stop search or peer recovery.
                pass
            if stamp - last_heartbeat >= settings["heartbeat_s"]:
                last_heartbeat = stamp
                if not state["silenced"]:
                    heartbeat = envelope("heartbeat", claim=state["current"], role=planner.role,
                                         trials=planner.trials, checkpoint_id=state["checkpoint"]["checkpoint_id"], recovery=compact_checkpoint())
                    for key, address in peers.items():
                        if key != agent_id:
                            state["peer_tx"] += tx(peer_socket, address, heartbeat)
            if stamp - last_gossip >= settings["checkpoint_s"] and not state["silenced"]:
                last_gossip = stamp
                message = envelope("checkpoint", checkpoint=state["checkpoint"])
                # Compress once, gossip to a rotating fanout. This bounds traffic
                # on macOS while small all-to-all heartbeat checkpoints stay timely.
                targets=[key for key in sorted(peers) if key!=agent_id and key not in declared_dead]
                chunks=packets(message)
                for i in range(min(2,len(targets))):
                    address=peers[targets[(gossip_round+i)%len(targets)]]
                    for chunk in chunks:
                        try:
                            peer_socket.sendto(chunk,tuple(address));state["peer_tx"]+=1
                        except OSError:pass
                gossip_round+=2
            if not state["silenced"]:
                for key in list(seen):
                    if key != agent_id and stamp - seen[key] > settings["failure_timeout_s"] and key not in declared_dead:
                        declared_dead.add(key)
                        cp = cached.get(key)
                        event("heartbeat_timeout", failed_agent=key, checkpoint_id=cp.get("checkpoint_id") if cp else None)
                # Re-evaluate ownership as further failures expire. Simultaneous
                # deaths must not strand a recovery on an agent that also died.
                for failed in sorted(declared_dead):
                    cp=cached.get(failed)
                    if not cp:continue
                    alive=live_ids();roles=assignment(alive)
                    old_role=cp.get("assigned_role",cp.get("role","explorer"))
                    owners=[who for who in alive if roles[who]==old_role] or alive
                    if owners and owners[0]==agent_id and recovered.get(failed)!=cp["checkpoint_id"]:
                        try:
                            incoming.put_nowait(dict(kind="recover",checkpoint=cp,failed_agent=failed))
                            recovered[failed]=cp["checkpoint_id"]
                        except queue.Full:pass
            if stamp - last_telemetry >= 1 / settings["telemetry_hz"]:
                last_telemetry = stamp
                cp = state["checkpoint"]
                best = state.get("best")
                status = "Taking Over" if stamp < state.get("taking_over_until",0) else "Validating" if planner.role == "validator" else "Running"
                if state.get("exhausted"):
                    status = "Idle"
                report = envelope("telemetry", heartbeat=time.time(), role=planner.role, status=status,
                                  silenced=state["silenced"], tries=planner.trials, attempts=planner.attempts, precheck_rejections=planner.precheck_rejections, successes=planner.successes, role_trials=dict(planner.role_trials),
                                  plan_trials=planner.plan_trials, robust=evidence_score(best) if best else 0,
                                  best=best, latest=state["latest"], checkpoint_id=cp["checkpoint_id"],
                                  events=state["events"], peer_tx=state["peer_tx"], peer_rx=state["peer_rx"],
                                  rejected=state["rejected"], reconciliations=state["reconciliations"],
                                  active_job=state["current"], live_peers=live_ids(),
                                  candidates=len(planner.candidates), plans=len(planner.plans),
                                  exhausted=state.get("exhausted", False))
                tx(telemetry_socket, telemetry_address, report)
            ready, _, _ = select.select([peer_socket], [], [], .02)
            if ready:
                try:
                    raw, source = peer_socket.recvfrom(65535)
                    if state["silenced"]:
                        continue  # No peer messages accepted during an outage.
                    message = receiver.receive(raw, source)
                    if not message:
                        continue
                    key = message.get("agent")
                    if key not in peers or list(source) != list(peers[key]):
                        continue
                    if message.get("task_id") != task["task_id"] or message.get("scene_version") != task["scene_version"]:
                        state["rejected"] += 1
                        continue
                    state["peer_rx"] += 1
                    if message["kind"]=="heartbeat":
                        if time.time()-message.get("sent_at",0)>settings["failure_timeout_s"]:continue
                        seen[key]=stamp
                        if key in declared_dead:
                            declared_dead.remove(key);recovered.pop(key,None)
                            event("peer_rejoined",peer=key)
                    if message["kind"] == "heartbeat":
                        recovery=message.get("recovery")
                        if recovery and recovery.get("progress",-1)>cached.get(key,{}).get("progress",-2):cached[key]=recovery
                        claim = message.get("claim")
                        if claim:
                            peer_claims[key] = claim
                    elif message["kind"] == "checkpoint":
                        checkpoint = message["checkpoint"]
                        cached[key] = checkpoint
                        try:
                            incoming.put_nowait(dict(kind="merge", checkpoint=checkpoint))
                        except queue.Full:
                            pass
                except (ValueError, OSError, KeyError, TypeError):
                    continue
        peer_socket.close()
        telemetry_socket.close()
    thread = threading.Thread(target=network, daemon=True, name=f"{agent_id}-network")
    thread.start()
    event("worker_started", seed=seed, recovered_trials=planner.trials)
    started = last_checkpoint = time.monotonic()
    cycle = 0
    recovery_role = None
    while not state["stop"]:
        while not incoming.empty():
            message = incoming.get_nowait()
            cp = message["checkpoint"]
            if message["kind"] == "recover":
                if planner.restore(cp):
                    state["taking_over_until"]=time.monotonic()+2
                    recovery_role = cp.get("assigned_role",cp.get("role", "explorer"))
                    event("task_takeover", failed_agent=message["failed_agent"], role=recovery_role,
                          checkpoint_id=cp["checkpoint_id"], recovered_trials=cp["trials"], recovered_progress=cp["progress"])
            elif not state["silenced"] and planner.merge(cp):
                state["reconciliations"] += 1
                if state["reconciliations"] == 1 or (state["reconciliations"] % 16 == 0 and cp.get("plans")):
                    event("checkpoint_reconciled", peer=cp["agent"], checkpoint_id=cp["checkpoint_id"], validated_plans=sum(len(p.get("evidence",{})) >= settings["plan_validation_trials"] for p in cp.get("plans",{}).values()))
        alive = live_ids()
        preferred = assignment(alive).get(agent_id, "explorer")
        if len(alive) < 4:
            preferred = ROLES[cycle % len(ROLES)]
        if recovery_role:
            preferred, recovery_role = recovery_role, None
        def allowed(job):
            if state["silenced"] or len(alive) == 1:
                return True
            for owner, claim in list(peer_claims.items()):
                if owner in alive and claim.get("key") == job["key"] and claim.get("expires", 0) > time.time():
                    # Deterministic winner if simultaneous claims race.
                    if owner < agent_id:
                        return False
            if job["kind"] in ("validate", "plan_trial", "extend"):
                roles = assignment(alive)
                eligible = [who for who in alive if roles[who] == ("sequencer" if job["kind"] == "extend" else "validator")]
                if eligible:
                    owner = sorted(eligible, key=lambda who: __import__('hashlib').sha256((job["key"] + who).encode()).digest())[0]
                    return owner == agent_id
            return True
        exhausted = planner.attempts >= settings["rollout_limit"] or time.monotonic() - started >= settings["time_limit_s"]
        no_reach = not planner.candidates and all(not planner.pool(n) for n in planner.nodes.values())
        exhausted = exhausted or no_reach
        state["exhausted"] = exhausted
        job = None if exhausted else planner.choose(preferred, allowed)
        if job:
            current_record=planner.candidates.get(job.get("candidate"),{}) if job["kind"]=="validate" else planner.plans.get(job.get("plan"),{})
            evidence=current_record.get("evidence",{})
            state["current"] = dict(key=job["key"], kind=job["kind"], target=job.get("action",current_record.get("action",{})).get("target"),
                                    validated_trials=len(evidence),successful_trials=sum(v["success"] for v in evidence.values()),
                                    expires=time.time() + settings["lease_s"])
            # Publish the unfinished job before executing; peers can resume it after death.
            state["checkpoint"] = {**state["checkpoint"], "active_job":copy.deepcopy(job),
                                   "role":planner.role, "assigned_role":preferred, "trials":planner.trials, "progress":planner.progress}
            planner.perform(job)
            state["latest"] = planner.latest
            state["best"] = copy.deepcopy(planner.best)
            state["current"] = None
            cycle += 1
        else:
            time.sleep(.03)
        now = time.monotonic()
        if now - last_checkpoint >= settings["checkpoint_s"]:
            last_checkpoint = now
            checkpoint = {**planner.checkpoint(), "assigned_role":preferred}
            state["checkpoint"] = checkpoint
            atomic_json(path, checkpoint)
    atomic_json(path, planner.checkpoint())
    thread.join(timeout=2)
    audit_file.close()
