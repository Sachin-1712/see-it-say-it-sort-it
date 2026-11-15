"""Offline genuine swarm search and evidence/trajectory export. Run from repo root."""
import argparse
import json
import time
from pathlib import Path
from swarm.supervisor import Swarm
from swarm.saved_plan import DEFAULT_PATH, save
from swarm.hardware import configuration


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timeout',type=float,default=180)
    parser.add_argument('--seed',type=int,default=2026)
    parser.add_argument('--workers',type=int,default=4)
    parser.add_argument('--output',type=Path,default=DEFAULT_PATH)
    args=parser.parse_args()
    swarm=Swarm(args.workers,args.seed,settings={'time_limit_s':args.timeout})
    started=time.monotonic()
    try:
        swarm.start(source='golden')
        while time.monotonic()-started<args.timeout:
            frame=swarm.frame()
            if frame['best']:
                swarm.stop_live()
                bundle=save(args.output,swarm.task,frame['best']['plan'],configuration(),
                            dict(agent=frame['best']['agent'],seed=args.seed,run_directory=str(swarm.directory),source='offline genuine MuJoCo swarm'))
                print(json.dumps(dict(path=str(args.output),elapsed_s=time.monotonic()-started,robustness=bundle['robustness'],trials=len(bundle['plan']['evidence']),timestamp=bundle['timestamp'])))
                return 0
            if frame['phase']=='failed':break
            time.sleep(.1)
        print('No validated complete plan; no saved plan written.')
        return 1
    finally:swarm.close()

if __name__=='__main__':raise SystemExit(main())
