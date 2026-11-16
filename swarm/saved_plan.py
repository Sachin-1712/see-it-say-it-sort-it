"""Local, integrity-checked evidence bundles. No search or physics runs on load."""
import copy
import hashlib
import json
import math
import time
from datetime import datetime, timezone

from .planning import evidence_score
from .task import ROOT, advance, scene_from

LABEL = "PREVIOUSLY VALIDATED — NOT THIS LIVE RUN"
DEFAULT_PATH = ROOT / '.gekko' / 'validated-three-box.json'


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def source_hash():
    paths = sorted((ROOT / 'sim').glob('*.py')) + [ROOT / 'swarm' / name for name in ('planning.py', 'task.py', 'saved_plan.py', 'worker.py', 'hardware.py')]
    return sha({str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths})


def identity(task, hardware):
    import mujoco
    # Viewer-only metadata may differ; geometry, poses and every physics input may not.
    objects = [{k:v for k,v in o.items() if k in ('instanceId','type','color','destination','position','baseZ','dimensionsMm','massG','friction','roll','pitch','yaw','tiltDeg','servoDeg')} for o in task['snapshot']['objects']]
    return dict(scenario=sha(sorted(objects,key=lambda o:o['instanceId'])), fixture=sha(json.loads((ROOT / "config/golden-three-box-v1.json").read_text())), config=sha(task['config']),
                hardware=sha(hardware), source=source_hash(), engine=mujoco.__version__,
                validation=sha({k:task['settings'][k] for k in ('robust_threshold','action_validation_trials','plan_validation_trials')}))


def check_plan(task, plan):
    evidence = plan.get('evidence', {})
    required = max(20, task['settings']['plan_validation_trials'])
    if len(evidence) < required or evidence_score(plan) < max(.8, task['settings']['robust_threshold']):
        raise ValueError('Insufficient full-plan validation evidence or robustness')
    if len({sha(item.get('physics_params')) for item in evidence.values()}) != len(evidence):
        raise ValueError('Duplicate uncertainty evidence')
    for item in evidence.values():
        if not isinstance(item.get('success'), bool) or not item.get('full_plan') or not item.get('physics_params') or not item.get('validator') or not item.get('timestamp'):
            raise ValueError('Missing genuine full-plan uncertainty evidence')
    actions, results = plan.get('actions', []), plan.get('results', [])
    if len(actions) != len(task['goals']) or {a['target'] for a in actions} != set(task['goals']) or len(results) != len(actions):
        raise ValueError('Incomplete plan')
    from sim.api import validate_action
    scene = scene_from(task)
    ids = set(task['goals']) | {'stick'}
    for action, result in zip(actions, results):
        snap = scene.snapshot
        validate_action(action, 0, next(o for o in snap['objects'] if o['type']=='sweeper'), task['config'])
        if not result.get('engine_ran') or not result.get('success') or result.get('target',{}).get('id') != action['target']:
            raise ValueError('Missing successful MuJoCo result')
        if result['target']['landed_bag'] != task['goals'][action['target']]:
            raise ValueError('Result destination mismatch')
        tracks = result.get('trajectories', {})
        if set(tracks) != ids:
            raise ValueError('Missing stored body trajectories')
        for path in tracks.values():
            if len(path)<2 or any(len(p)!=7 or not all(math.isfinite(v) for v in p) for p in path) or any(b[0]<=a[0] for a,b in zip(path,path[1:])):
                raise ValueError('Invalid trajectory samples')
        scene = advance(scene, result)
    if results[-1].get('bag_assignments') != task['goals']:
        raise ValueError('Final collection mismatch')


def save(path, task, plan, hardware, origin):
    from sim.api import rollout
    plan = copy.deepcopy(plan)
    # Capture full-resolution nominal tracks once, offline, after full validation.
    scene = scene_from(task)
    plan['results'] = []
    for action in plan['actions']:
        result = rollout(scene, action)
        plan['results'].append(result)
        if not result['success']:
            raise ValueError('Offline nominal replay failed')
        scene = advance(scene, result)
    check_plan(task, plan)
    now = time.time()
    bundle = dict(schema=1, created_at=now, timestamp=datetime.fromtimestamp(now, timezone.utc).isoformat(),
                  label=LABEL, origin=origin, hashes=identity(task, hardware), robustness=evidence_score(plan), plan=plan)
    bundle['checksum'] = sha(bundle)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(bundle, allow_nan=False))
    temp.replace(path)
    return bundle


def load(path, task, hardware, max_age_s=86400):
    try:
        bundle = json.loads(path.read_text())
        checksum = bundle.pop('checksum')
        if checksum != sha(bundle) or bundle.get('schema') != 1:
            raise ValueError('Saved-plan integrity check failed')
        age = time.time() - bundle['created_at']
        if age < -60 or age > max_age_s:
            raise ValueError('Saved plan is stale; regenerate offline')
        if bundle['hashes'] != identity(task, hardware):
            raise ValueError('Saved plan scenario/configuration/hardware/source mismatch')
        check_plan(task, bundle['plan'])
        if bundle['robustness'] != evidence_score(bundle['plan']):
            raise ValueError('Robustness mismatch')
        return bundle
    except (OSError, KeyError, TypeError) as error:
        raise ValueError(f'Cannot load saved plan: {error}') from error
