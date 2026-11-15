"""Repeat the golden benchmark, including real process deaths, and replay every winning plan."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import time

from scripts.swarm_benchmark import benchmark
from swarm.task import scene_from, advance
from sim.api import rollout

CASES = [
    dict(name='nominal-seed-11',workers=4,seed=11),
    dict(name='nominal-seed-29',workers=4,seed=29),
    dict(name='kill-sequencer-a8',workers=8,seed=2026,kill=['a8']),
    dict(name='kill-explorer-a1',workers=4,seed=42,kill=['a1']),
    dict(name='kill-only-validator-a3',workers=4,seed=52,kill=['a3']),
    dict(name='kill-half',workers=8,seed=73,kill=['a1','a3','a6','a8']),
    dict(name='one-survivor',workers=4,seed=61,kill=['a1','a2','a3']),
    dict(name='solo-from-start',workers=1,seed=91),
]


def run_case(case, timeout):
    case=dict(case);name=case.pop('name')
    report=benchmark(**case,timeout=timeout,kill_after=8)
    report['name']=name
    report['nominal_replay']=False
    if report['best']:
        task=json.loads((Path(report['checkpoint_directory'])/'scene-1/task.json').read_text())
        scene=scene_from(task)
        results=[]
        for action in report['best']['plan']['actions']:
            result=rollout(scene,action);results.append(result)
            if not result['success']:break
            scene=advance(scene,result)
        report['nominal_replay']=all(r['success'] for r in results) and len(results)==3 and results[-1]['bag_assignments']==task['goals']
        report['verified_final_bags']=results[-1].get('bag_assignments',{})
    takeovers=[e for e in report['events'] if e['type']=='task_takeover']
    kills=[e for e in report['events'] if e['type']=='process_killed']
    report['recovery_s']={kill['agent']:min((e['timestamp']-kill['timestamp'] for e in takeovers if e.get('failed_agent')==kill['agent']),default=None) for kill in kills}
    report['passed']=report['success'] and report['nominal_replay'] and set(report['recovery_s'])==set(case.get('kill',[])) and all(v is not None for v in report['recovery_s'].values())
    print(json.dumps({key:report.get(key) for key in ['name','passed','elapsed_s','metrics','recovery_s']}),flush=True)
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timeout',type=float,default=300)
    parser.add_argument('--jobs',type=int,default=1)
    parser.add_argument('--cases',nargs='*')
    parser.add_argument('--output',default='docs/swarm-reliability.json')
    args=parser.parse_args();cases=[c for c in CASES if not args.cases or c['name'] in args.cases]
    reports=[]
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for report in pool.map(lambda c:run_case(c,args.timeout),cases):
            reports.append(report)
            Path(args.output).write_text(json.dumps(dict(timestamp=time.time(),passed=sum(r['passed'] for r in reports),runs=len(reports),reports=reports),indent=2))
    return int(any(not r['passed'] for r in reports))

if __name__=='__main__':
    raise SystemExit(main())
