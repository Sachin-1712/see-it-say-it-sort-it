"""Measure one-process rollout throughput. Usage: python -m scripts.sim_benchmark."""

import argparse
import json
import platform
from statistics import median, quantiles
from time import perf_counter, process_time

from sim.api import build_scene, rollout
from sim.scene import demo_snapshot
from sim.search import best_candidate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=100)
    args = parser.parse_args()
    if args.runs < 2:
        parser.error("--runs must be at least 2")
    scene = build_scene(demo_snapshot(["red"]))
    target = scene.snapshot["objects"][0]["instanceId"]
    best, _ = best_candidate(scene, target)
    if best is None or best[1]["invalid"]:
        raise SystemExit("Benchmark requires a valid sweep candidate.")
    action = best[0]
    elapsed = []
    cpu_start = process_time()
    for i in range(args.runs):
        begin = perf_counter()
        result = rollout(scene, action, seed=i)
        elapsed.append(perf_counter() - begin)
        if result["invalid"]:
            raise SystemExit(f"Invalid benchmark run: {result['reason']}")
    print(json.dumps({
        "platform": platform.platform(), "runs": args.runs, "action": action,
        "success": best[1]["success"], "median_s": median(elapsed),
        "p95_s": quantiles(elapsed, n=20, method="inclusive")[18], "max_s": max(elapsed),
        "rollouts_per_second": len(elapsed) / sum(elapsed),
        "process_cpu_s": process_time() - cpu_start,
    }))
    return int(median(elapsed) >= 0.2)


if __name__ == "__main__":
    raise SystemExit(main())
