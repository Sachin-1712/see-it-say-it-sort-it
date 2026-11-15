"""Attach actual append-only worker audit counts and verify validation provenance."""
import argparse
from collections import Counter
import json
from pathlib import Path

PRECHECK_PREFIXES=("realized tilt_deg outside limits","tilt_deg outside limits","sweep_start_deg outside limits","sweep_end_deg outside limits")


def audit_report(report):
    root=Path(report['checkpoint_directory'])/'scene-1'
    totals=Counter();by_agent={};events_by_agent={}
    for directory in root.glob('a*'):
        records=[json.loads(line) for line in (directory/'events.jsonl').read_text().splitlines()]
        events_by_agent[directory.name]=records
        trials=[e for e in records if e['type']=='trial' and not str(e.get('reason','')).startswith(PRECHECK_PREFIXES)]
        prechecks=[e for e in records if e['type']=='precheck_rejection' or (e['type']=='trial' and str(e.get('reason','')).startswith(PRECHECK_PREFIXES))]
        counts=dict(trials=len(trials),precheck_rejections=len(prechecks),successes=sum(e['success'] for e in trials),
                    plan_trials=sum(e['type']=='plan_validation' for e in records),
                    role_trials=dict(Counter(e['role'] for e in trials)))
        by_agent[directory.name]=counts
        totals.update({k:v for k,v in counts.items() if k!='role_trials'})
    report['telemetry_metrics_at_solution']=report['metrics']
    report['audited_metrics_at_shutdown']=dict(totals)
    report['audited_agents']=by_agent
    plan=report['best']['plan'] if report.get('best') else None
    provenance=True
    if plan:
        for key,evidence in plan['evidence'].items():
            counter=int(key.split(':')[-1])
            provenance &= any(e['type']=='plan_validation' and e.get('plan_id')==plan['id'] and e.get('trial')==counter and e['success']==evidence['success']
                              for e in events_by_agent[evidence['validator']])
    report['validation_audit_verified']=bool(provenance and plan)
    if plan:assert report['validation_audit_verified'],report['name']
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('source');p.add_argument('output');args=p.parse_args()
    data=json.loads(Path(args.source).read_text())
    for report in data['reports']:audit_report(report)
    data.update(fixture='gekko-three-box-v1',hardware_execution='Deferred by operator; disabled; zero physical tests',
                counts_note='Audited metrics count real MuJoCo calls through shutdown; telemetry metrics are the solution-time snapshot. Earlier telemetry included cheap prechecks; these are separated by the audit. Runtime counters now separate them too.',
                development_failures=['Oversized macOS UDP checkpoints prevented sharing; fixed bounded fragmentation and gossip fanout.',
                                      'Earlier smaller-bin/equal-mass development fixtures failed complete-plan robustness; explicit unmeasured fixture geometry revised, threshold and uncertainty unchanged.',
                                      'An earlier one-survivor run timed out at 300 s due to candidate-cache starvation and stranded simultaneous-death claims; fixed quotas and repeated lease ownership evaluation.'])
    Path(args.output).write_text(json.dumps(data,indent=2)+'\n')
    print(json.dumps(dict(passed=data['passed'],runs=data['runs'],audited_trials=sum(r['audited_metrics_at_shutdown']['trials'] for r in data['reports']),robustness=[r['best']['robust'] for r in data['reports']]),indent=2))

if __name__=='__main__':main()
