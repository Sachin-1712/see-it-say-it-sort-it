"""Run the genuine process swarm and save measurable results, optionally killing workers."""
import argparse
import json
import time
from pathlib import Path
from swarm.supervisor import Swarm


def benchmark(workers=4, seed=2026, timeout=180, kill=None, kill_after=8, directory=None):
    swarm=Swarm(workers,seed,directory=directory,settings={"time_limit_s":timeout,"rollout_limit":2500})
    try:
        swarm.start(source="golden")
        started=time.monotonic(); killed=False
        while time.monotonic()-started < timeout:
            frame=swarm.frame()
            if kill and not killed and time.monotonic()-started >= kill_after:
                for agent in kill:
                    swarm.kill(agent)
                killed=True
            if frame["best"] or frame["phase"] == "failed":
                break
            time.sleep(.1)
        frame=swarm.frame()
        return dict(seed=seed,workers=workers,success=bool(frame["best"]),elapsed_s=time.monotonic()-started,
                    metrics=frame["metrics"],agents=frame["agents"],best=frame["best"],events=swarm.lifecycle_events,
                    checkpoint_directory=str(swarm.directory),failure=frame["failure"])
    finally:
        swarm.close()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--workers",type=int,default=4);p.add_argument("--seed",type=int,default=2026)
    p.add_argument("--timeout",type=float,default=180);p.add_argument("--kill",nargs="*",default=[])
    p.add_argument("--kill-after",type=float,default=8);p.add_argument("--output",default="/tmp/gekko-swarm-benchmark.json")
    args=p.parse_args()
    report=benchmark(args.workers,args.seed,args.timeout,args.kill,args.kill_after)
    Path(args.output).write_text(json.dumps(report,indent=2))
    print(json.dumps({key:report[key] for key in ("seed","workers","success","elapsed_s","metrics","failure")}),flush=True)
    return 0 if report["success"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
