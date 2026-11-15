"""Saved evidence uses a genuine independent-process search, never invented scores."""
import copy
import json
import time

import pytest
from swarm.supervisor import Swarm
from swarm.saved_plan import save, load, sha, LABEL
from swarm.hardware import configuration, prepare
from swarm.task import make_task, golden_snapshot


@pytest.fixture(scope='module')
def validated(tmp_path_factory):
    root=tmp_path_factory.mktemp('genuine-demo')
    swarm=Swarm(4,2026,directory=root/'run',settings={'time_limit_s':90})
    try:
        swarm.start(source='golden')
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            frame=swarm.frame()
            if frame['best']:break
            time.sleep(.1)
        assert frame['best'],frame['metrics']
        swarm.stop_live()
        path=root/'validated.json'
        bundle=save(path,swarm.task,frame['best']['plan'],configuration(),dict(source='pytest genuine MuJoCo agents'))
        yield path,swarm,bundle
    finally:swarm.close()


def test_genuine_saved_plan_load_replays_stored_tracks_without_physics(validated,monkeypatch):
    path,swarm,bundle=validated
    import sim.api
    monkeypatch.setattr(sim.api,'rollout',lambda *args,**kwargs:pytest.fail('Load/replay must not run new physics'))
    swarm.load_saved(path)
    frame=swarm.frame()
    assert frame['best']['label']==LABEL and frame['best']['agent']=='offline'
    assert frame['best']['attribution']=='previously_validated'
    assert len(bundle['plan']['evidence'])>=20 and bundle['robustness']>=.8
    assert [a['direction'] for a in bundle['plan']['actions']]==['left','right','left']
    replay=swarm.replay()
    assert replay['results']==bundle['plan']['results'] and replay['label']==LABEL
    assert frame['execution']['enabled'] is False
    # Loading offline evidence cannot count as an improvement by live agents.
    swarm.live_best_score=0
    swarm.lifecycle_events.append(dict(type='process_killed',agent='a3',timestamp=time.time(),best_score=0))
    assert not swarm.recovery_state(frame['agents'])[-1]['improving']
    assert replay['results'][-1]['bag_assignments']==swarm.task['goals']


def test_rejects_stale_tampered_incompatible_and_weak_evidence(validated,tmp_path):
    path,swarm,bundle=validated
    def write(change):
        item=copy.deepcopy(bundle);change(item);item.pop('checksum',None);item['checksum']=sha(item)
        other=tmp_path/'changed.json';other.write_text(json.dumps(item));return other
    for change in [lambda b:b.update(created_at=time.time()-90000),
                   lambda b:b['hashes'].update(source='obsolete'),
                   lambda b:b['hashes'].update(config='obsolete'),
                   lambda b:b['hashes'].update(hardware='unverified'),
                   lambda b:b['plan'].update(evidence={}),
                   lambda b:b['plan']['results'][0].update(trajectories={}),
                   lambda b:b['plan']['evidence'][next(iter(b['plan']['evidence']))].pop('physics_params')]:
        with pytest.raises(ValueError):load(write(change),swarm.task,configuration())
    bad=tmp_path/'tampered.json';bad.write_text(path.read_text().replace('PREVIOUSLY VALIDATED','NEWLY DISCOVERED'))
    with pytest.raises(ValueError,match='integrity'):load(bad,swarm.task,configuration())
    task=copy.deepcopy(swarm.task);task['snapshot']['objects'][0]['position']['x']+=1
    with pytest.raises(ValueError,match='mismatch'):load(path,task,configuration())
    with pytest.raises(ValueError,match='hardware'):load(path,swarm.task,{**configuration(),'calibration_verified':True})


def test_hardware_is_disabled_and_step_requires_confirmation_and_outcome(validated):
    path,swarm,_=validated
    swarm.load_saved(path)
    plan_id=swarm.best[1]['id']
    with pytest.raises(ValueError,match='Confirm'):swarm.prepare_step(plan_id)
    with pytest.raises(ValueError,match='matching'):swarm.prepare_step('wrong',True,True)
    swarm.dry_run()
    assert swarm.physical_step==0 # simulated G/P logging cannot skip a confirmed action
    step=swarm.prepare_step(plan_id,True,True)
    assert step['step']==1 and step['command'] is None and not step['transmitted'] and not step['acknowledged']
    assert swarm.physical_step==0
    with pytest.raises(ValueError,match='outcome'):swarm.prepare_step(plan_id,True,True)
    with pytest.raises(ValueError,match='failed'):swarm.confirm_outcome(False)
    with pytest.raises(ValueError,match='Reset'):swarm.prepare_step(plan_id,True,True)
    swarm.load_saved(path)
    swarm.prepare_step(plan_id,True,True);swarm.confirm_outcome(True)
    assert swarm.prepare_step(plan_id,True,True)['step']==2
    assert swarm.execution_state()['enabled'] is False


def test_mapping_is_explicit_and_limits_are_enforced():
    action=dict(tilt_deg=10,sweep_start_deg=40,sweep_end_deg=180)
    cfg=configuration()
    assert prepare(action,cfg)['command'] is None
    cfg.update(calibration_verified=True,calibration_id='bench-measurement',direction_commands={'increasing':'R','decreasing':'L'},servo_limits_deg=[0,180],tilt_limits_deg=[0,20])
    assert prepare(action,cfg)['command']=='R' # deliberately reversed physical mapping
    assert prepare({**action,'sweep_start_deg':180,'sweep_end_deg':0},cfg)['command']=='L'
    with pytest.raises(ValueError,match='limits'):prepare({**action,'tilt_deg':25},cfg)
    assert not prepare(action,cfg)['transmitted'] # even configured transport remains locked


def test_cannot_lower_full_plan_validation_budget():
    from swarm.task import ROOT
    settings=json.loads((ROOT/'config/swarm.json').read_text());settings['plan_validation_trials']=19
    with pytest.raises(ValueError,match='20'):make_task(golden_snapshot(),settings=settings)
