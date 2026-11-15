"""Check that eight fresh Python processes agree with independent serial replays."""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter

from sim.api import build_scene, robust_score
from sim.scene import demo_snapshot
from sim.search import candidate_actions


def fingerprint(scene, action, seed):
    result = robust_score(scene, action, trials=1, seed=seed)["results"][0]
    payload = json.dumps(result, sort_keys=True, allow_nan=False).encode()
    return hashlib.sha256(payload).hexdigest(), result["invalid"]


def worker(source, index, runs):
    fixture = json.loads(Path(source).read_text())
    scene = build_scene(fixture["snapshot"])
    baseline = scene.snapshot
    observations = [fingerprint(scene, fixture["action"], index * runs + i) for i in range(runs)]
    assert scene.snapshot == baseline
    print(json.dumps({
        "pid": os.getpid(), "index": index, "runs": runs,
        "first": observations[0][0], "last": observations[-1][0],
        "invalid": sum(invalid for _, invalid in observations),
        "distinct": len(set(key for key, _ in observations)),
    }))


def parallel_check(runs=50):
    scene = build_scene(demo_snapshot(["red", "blue", "red"]))
    target = scene.snapshot["objects"][2]["instanceId"]
    action = next(candidate_actions(scene, target))
    started = perf_counter()
    with TemporaryDirectory(prefix="gekko-check-") as directory:
        source = Path(directory) / "fixture.json"
        source.write_text(json.dumps({"snapshot": scene.snapshot, "action": action}))
        workers = []
        try:
            for i in range(8):
                workers.append(subprocess.Popen(
                    [sys.executable, "-m", "scripts.sim_parallel_check", "--worker",
                     str(source), str(i), "--runs", str(runs)],
                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    cwd=Path(__file__).resolve().parent.parent,
                ))
            results = []
            for process in workers:
                output, errors = process.communicate(timeout=60)
                if process.returncode:
                    raise RuntimeError(f"Worker {process.pid} exited {process.returncode}: {errors}")
                results.append(json.loads(output))
        finally:
            for process in workers:
                if process.poll() is None:
                    process.terminate()
                    process.communicate()

    assert len({result["pid"] for result in results}) == 8
    assert len({result["first"] for result in results}) > 1
    for result in results:
        offset = result["index"] * runs
        for key, seed in (("first", offset), ("last", offset + runs - 1)):
            assert fingerprint(scene, action, seed)[0] == result[key], (result["index"], seed)
    return {
        "processes": len(results), "parallel_rollouts": sum(r["runs"] for r in results),
        "serial_replays": 2 * len(results), "wall_s": perf_counter() - started,
        "workers": results,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=50)
    parser.add_argument("--worker", nargs=2, metavar=("FIXTURE", "INDEX"), help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    if args.worker:
        worker(args.worker[0], int(args.worker[1]), args.runs)
    else:
        print(json.dumps(parallel_check(args.runs)))


if __name__ == "__main__":
    main()
