"""Real process/physics tests. No scores, trajectories or worker deaths are mocked."""
import copy
import json
import os
import random
import time
from pathlib import Path

import pytest

from sim.api import rollout
from sim.scene import demo_snapshot
from swarm.planning import Planner, ROLES, assignment, evidence_score
from swarm.supervisor import Swarm
from swarm.task import make_task
from swarm.wire import packets, Receiver


def wait_for(swarm, predicate, timeout=15):
    started=time.monotonic()
    while time.monotonic()-started < timeout:
        frame=swarm.frame()
        if predicate(frame):return frame
        time.sleep(.05)
    raise AssertionError(f"Timed out: {json.dumps(swarm.frame()['metrics'])}; events={swarm.events[-5:]}")


def test_udp_chunks_fit_macos_and_reassemble_out_of_order():
    message={"payload":[random.Random(i).randbytes(200).hex() for i in range(300)]}
    chunks=packets(message)
    assert len(chunks)>1 and max(map(len,chunks))<8192
    receiver=Receiver();result=None
    for chunk in reversed(chunks):result=receiver.receive(chunk,('127.0.0.1',1234)) or result
    assert result==message


def test_initial_roles_and_failover_assignment():
    ids=[f'a{i+1}' for i in range(8)]
    assert list(assignment(ids).values())==['explorer']*3+['optimizer']*2+['validator']*2+['sequencer']
    for victim in ids:
        assert set(assignment([i for i in ids if i!=victim]).values())==set(ROLES)


def test_every_capability_runs_real_physics_and_checkpoint_versions_are_enforced():
    task=make_task(demo_snapshot(['red']))
    events=[];p=Planner(task,'a1',211,audit=events.append)
    for role in ['explorer','optimizer','validator','sequencer']:
        for _ in range(100):
            job=p.choose(role)
            if job:p.perform(job)
            if p.role_trials[role]>0:break
        assert p.role_trials[role]>0,role
    trial_events=[e for e in events if e['type']=='trial']
    assert len(trial_events)==p.trials and all(e['score']==float(e['success']) for e in trial_events)
    assert any(e['contacts'] for e in trial_events)
    cp=p.checkpoint();q=Planner(task,'a2',212)
    assert q.merge(cp)
    assert q.merge(cp) # evidence union is idempotent
    for key,c in p.candidates.items():assert q.candidates[key]['evidence']==c['evidence']
    assert not q.merge({**cp,'scene_version':task['scene_version']+1})
    assert not q.merge({**cp,'task_id':'obsolete'})
    r=Planner(task,'a1',211);assert r.restore(cp)
    assert r.trials==p.trials and r.physics_rng.bit_generator.state==p.physics_rng.bit_generator.state


def test_four_real_processes_kill_recovery_silence_and_observer_independence(tmp_path):
    swarm=Swarm(4,123,directory=tmp_path,settings={'time_limit_s':90,'rollout_limit':1000})
    try:
        swarm.start(source='golden')
        frame=wait_for(swarm,lambda f:len(f['ghosts'])==4 and all(a['tries']>=3 for a in f['agents']))
        pids={a['pid'] for a in frame['agents']}
        assert len(pids)==4 and os.getpid() not in pids
        assert all(swarm.processes[a['id']].is_alive() for a in frame['agents'])
        # Every displayed path is a real completed MuJoCo trial recorded on disk.
        for a in frame['agents']:
            audit=tmp_path/'scene-1'/a['id']/'events.jsonl'
            records=[json.loads(line) for line in audit.read_text().splitlines()]
            assert any(r.get('trial_id')==a['latest']['trial_id'] for r in records)
        victim='a4';before={a['id']:a['tries'] for a in frame['agents']}
        assert swarm.kill(victim)
        assert not swarm.processes[victim].is_alive()
        frame=wait_for(swarm,lambda f:any(e['type']=='task_takeover' and e.get('failed_agent')==victim for e in f['events']),timeout=12)
        event=next(e for e in frame['events'] if e['type']=='task_takeover' and e.get('failed_agent')==victim)
        assert event['checkpoint_id'] and event['recovered_trials']>0
        frame=wait_for(swarm,lambda f:any(e['type']=='work_resumed' and e.get('failed_agent')==victim for e in f['events']),timeout=8)
        recovery=frame['recovery'][-1]
        assert recovery['dead']==victim and recovery['active_before']==4
        assert recovery['checkpoint_id'] and recovery['resumed'] and recovery['new_trials']>0
        wait_for(swarm,lambda f:any(a['tries']>before[a['id']]+2 for a in f['agents'] if a['alive']))
        swarm.silence(True)
        frame=wait_for(swarm,lambda f:all(a['silenced'] for a in f['agents'] if a['alive']))
        time.sleep(.7);frame=swarm.frame()
        network={a['id']:(a['peer_tx'],a['peer_rx'],a['tries']) for a in frame['agents'] if a['alive']}
        time.sleep(1.5);frame=swarm.frame()
        for a in frame['agents']:
            if a['id'] in network:
                tx,rx,trials=network[a['id']]
                assert (a['peer_tx'],a['peer_rx'])==(tx,rx)
                assert a['tries']>trials
        swarm.silence(False)
        wait_for(swarm,lambda f:all(not a['silenced'] for a in f['agents'] if a['alive']))
        wait_for(swarm,lambda f:all(a['peer_rx']>network[a['id']][1] for a in f['agents'] if a['id'] in network))
        # Closing the observer control channel must not terminate independent work.
        before={a['id']:a['tries'] for a in swarm.frame()['agents']}
        for control in swarm.controls.values():control.close()
        wait_for(swarm,lambda f:all(a['tries']>before[a['id']] for a in f['agents'] if a['alive']))
    finally:swarm.close()


def test_eight_processes_survive_explorer_validator_and_half_swarm_death(tmp_path):
    swarm=Swarm(8,99,directory=tmp_path,settings={'time_limit_s':90,'rollout_limit':1000})
    try:
        swarm.start(source='golden')
        frame=wait_for(swarm,lambda f:len(f['ghosts'])==8 and all(a['tries']>2 for a in f['agents']),timeout=25)
        assert len({a['pid'] for a in frame['agents']})==8
        for key in ['a1','a6','a7','a8']:assert swarm.kill(key)
        frame=wait_for(swarm,lambda f:sum(a['alive'] for a in f['agents'])==4 and len([e for e in f['events'] if e['type']=='task_takeover'])>=2,timeout=15)
        before=sum(a['tries'] for a in frame['agents'])
        wait_for(swarm,lambda f:f['metrics']['trials']>before+10)
        assert any(e['type']=='heartbeat_timeout' for e in swarm.events)
    finally:swarm.close()


def test_impossible_scene_reports_failure_and_never_invents_a_plan(tmp_path):
    snapshot=demo_snapshot(['red'])
    snapshot['objects'][-1]['position']['y']+=2000
    swarm=Swarm(1,1,directory=tmp_path,settings={'time_limit_s':10,'rollout_limit':20})
    try:
        swarm.start(snapshot)
        frame=wait_for(swarm,lambda f:f['phase']=='failed')
        assert frame['best'] is None and frame['metrics']['trials']==0
        assert frame['execution']['enabled'] is False
    finally:swarm.close()


def test_precheck_rejections_do_not_invent_mujoco_trial_counts():
    task=make_task(demo_snapshot(['red']))
    planner=Planner(task,'a1',4)
    action=dict(target=task['snapshot']['objects'][0]['instanceId'],tilt_deg=100,sweep_start_deg=0,sweep_end_deg=180)
    result=planner.trial(__import__('swarm.task',fromlist=['scene_from']).scene_from(task),action)
    assert result['invalid'] and result['engine_ran'] is False
    assert planner.trials==0 and planner.attempts==1 and planner.precheck_rejections==1
    assert planner.latest is None


def test_send_is_a_confirmed_dry_run_of_the_validated_plan(tmp_path):
    """Send turns the next validated step into the PRD firmware lines, logs them and never transmits."""
    from swarm.supervisor import Swarm
    swarm = Swarm(workers=1, seed=1, directory=tmp_path)
    try:
        with pytest.raises(ValueError, match="No validated plan"):
            swarm.dry_run()
        assert Swarm.servo_commands(dict(sweep_start_deg=41.0, sweep_end_deg=180, speed_deg_s=90)) == ["G 0 41", "P 0 41 180 90"]
        assert Swarm.servo_commands(dict(sweep_start_deg=132.25, sweep_end_deg=0, speed_deg_s=150)) == ["G 0 132.2", "P 0 132.2 0 150"]
        # A plan record shaped like a worker's validated plan; evidence decides robustness.
        actions = [dict(target=f"world_box_000{i}", tilt_deg=5.0 * i, sweep_start_deg=40, sweep_end_deg=180, speed_deg_s=90) for i in (3, 2)]
        plan = dict(id="plan-1", actions=actions, evidence={f"e{i}": dict(success=i < 9) for i in range(10)})
        swarm.task = dict(task_id="t", goals={a["target"]: "left" for a in actions}, snapshot={"objects": []})
        swarm.best = ("a1", plan)
        assert swarm.execution_state()["next_step"] == 1 and swarm.execution_state()["enabled"] is False
        first = swarm.dry_run()
        assert first["step"] == 1 and first["commands"] == ["G 0 40", "P 0 40 180 90"] and first["transmitted"] is False
        assert swarm.dry_run()["step"] == 2 and swarm.execution_state()["next_step"] is None
        with pytest.raises(ValueError, match="already been sent"):
            swarm.dry_run()
        logged = [json.loads(line) for line in (tmp_path / "dry-run-commands.jsonl").read_text().splitlines()]
        assert [entry["step"] for entry in logged] == [1, 2] and all(not entry["transmitted"] for entry in logged)
        swarm.best = ("a1", dict(plan, id="plan-2", evidence={"e": dict(success=False)}))
        with pytest.raises(ValueError, match="below"):
            swarm.dry_run()
    finally:
        swarm.close()
