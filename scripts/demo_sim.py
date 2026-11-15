"""Run real single-box and stack searches. Usage: python -m scripts.demo_sim."""

import argparse
import json

from sim.api import build_scene, rollout
from sim.scene import demo_snapshot
from sim.search import best_candidate


def summary(label, action, result, attempts):
    return {
        "case": label, "attempts": attempts, "action": action,
        "score": result["score"], "reason": result["reason"], "target": result["target"],
        "others_mm": result["others"], "servo_stalled": result["servo_stalled"],
        "peak_servo_torque_nm": result.get("peak_servo_torque_nm"),
        "stack_stable": result["stack_stable"],
    }


def report(label, scene, target, budget):
    candidate, attempts = best_candidate(scene, target, budget)
    if candidate is None:
        print(json.dumps({"case": label, "attempts": attempts, "score": 0,
                          "reason": "no clear kinematic approach in the sampled tilt and angle grid"}))
        return False
    action, result = candidate
    print(json.dumps(summary(label, action, result, attempts)))
    return result["success"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--budget", type=int, default=250)
    args = parser.parse_args()
    if args.budget < 1:
        parser.error("--budget must be at least 1")
    single = []
    for label, colour in (("single-left", "red"), ("single-right", "blue")):
        scene = build_scene(demo_snapshot([colour]))
        target = scene.snapshot["objects"][0]["instanceId"]
        single.append(report(label, scene, target, args.budget))
    scene = build_scene(demo_snapshot(["red"]))
    target = scene.snapshot["objects"][0]["instanceId"]
    cfg = scene.config()
    sweeper = cfg["models"]["sweeper"]
    low = sweeper["assemblyTilt"]["limitsDeg"][0]
    start, end = sweeper["servo"]["limitsDeg"]
    bad = dict(target=target, tilt_deg=low, sweep_start_deg=start, sweep_end_deg=end)
    result = rollout(scene, bad)
    print(json.dumps(summary("deliberately bad", bad, result, 1)))
    stack = build_scene(demo_snapshot(["red", "blue", "red"]))
    target = stack.snapshot["objects"][2]["instanceId"]
    report("three-stack top", stack, target, args.budget)
    return 0 if all(single) and not result["success"] and not result["invalid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
