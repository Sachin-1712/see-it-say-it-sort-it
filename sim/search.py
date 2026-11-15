"""Bounded candidate generation for the demo and the optional service."""

from itertools import islice

from .api import robust_score, rollout
from .geometry import contact_angles


def candidate_actions(scene, target_id):
    cfg = scene.config()
    items = scene.snapshot["objects"]
    target = next((item for item in items if item["type"] == "box" and item["instanceId"] == target_id), None)
    if target is None:
        return
    side = cfg["rig"]["colour_to_bag"].get(target.get("color"))
    if side is None and target.get("color") is None:
        side = target.get("destination")
    if side not in ("left", "right"):
        return
    rows = [(tilt, angles[side]) for tilt, angles in contact_angles(scene, target_id) if side in angles]
    if not rows:
        return

    # Try all contact heights, starting in the middle of the reachable band.
    midpoint = (rows[0][0] + rows[-1][0]) / 2
    rows.sort(key=lambda row: abs(row[0] - midpoint))
    settings = cfg["sim"]
    low, high = cfg["models"]["sweeper"]["servo"]["limitsDeg"]
    forward = side == "left"
    offsets = settings["demo_angle_offsets_deg"]
    start_offsets = sorted(offsets, reverse=True)
    speeds = settings["demo_speeds_deg_s"]
    if sum(item["type"] == "box" for item in items) == 1:
        # Leave room for the manual tilt error and seek a full, brisk sweep.
        tilt_low, tilt_high = cfg["models"]["sweeper"]["assemblyTilt"]["limitsDeg"]
        margin = cfg["scoring"]["robustness"]["tilt_deg"]
        rows.sort(key=lambda row: not tilt_low + margin <= row[0] <= tilt_high - margin)
        speeds = sorted(speeds, key=lambda speed: abs(speed - settings["single_box_search_speed_deg_s"]))
    for end_offset in offsets:
        for start_offset in start_offsets:
            for speed in speeds:
                for tilt, approach in rows:
                    start = max(low, approach - start_offset) if forward else min(high, approach + start_offset)
                    end = high - end_offset if forward else low + end_offset
                    if (start < end) == forward and start != end:
                        yield dict(target=target_id, tilt_deg=tilt, sweep_start_deg=start,
                                   sweep_end_deg=end, speed_deg_s=speed)


def search_candidates(scene, target_id, budget):
    single = sum(item["type"] == "box" for item in scene.snapshot["objects"]) == 1
    check = scene.config()["scoring"]["single_box_search"] if single else None
    for action in islice(candidate_actions(scene, target_id), budget):
        result = rollout(scene, action)
        if check and result["success"]:
            tested = robust_score(scene, action, trials=check["trials"], seed=check["seed"])
            result["robust_score"] = tested["score"]
            result["robust_trials"] = check["trials"]
            result["meets_search_goal"] = tested["score"] >= check["minimum_score"]
        yield action, result


def meets_search_goal(result):
    return result["success"] and result.get("meets_search_goal", True)


def rank(result):
    target = result["target"]
    touched = any({contact["body_a"], contact["body_b"]} == {"stick", target["id"]}
                  for contact in result["contacts"])
    return (result["score"], result.get("robust_score", 0), target["correct_bag"], not result["invalid"], touched,
            result["stack_stable"] is True, -max(result["others"].values(), default=0))


def best_candidate(scene, target_id, budget=250):
    best = None
    attempts = 0
    for action, result in search_candidates(scene, target_id, budget):
        attempts += 1
        if best is None or rank(result) > rank(best[1]):
            best = action, result
        if meets_search_goal(result):
            break
    return best, attempts
