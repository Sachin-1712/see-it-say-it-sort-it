"""Bounded candidate generation for the demo and the optional service."""

from itertools import islice

from .api import rollout
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
    for end_offset in offsets:
        for start_offset in offsets:
            for speed in settings["demo_speeds_deg_s"]:
                for tilt, approach in rows:
                    start = max(low, approach - start_offset) if forward else min(high, approach + start_offset)
                    end = high - end_offset if forward else low + end_offset
                    if (start < end) == forward and start != end:
                        yield dict(target=target_id, tilt_deg=tilt, sweep_start_deg=start,
                                   sweep_end_deg=end, speed_deg_s=speed)


def search_candidates(scene, target_id, budget):
    for action in islice(candidate_actions(scene, target_id), budget):
        yield action, rollout(scene, action)


def rank(result):
    target = result["target"]
    touched = any({contact["body_a"], contact["body_b"]} == {"stick", target["id"]}
                  for contact in result["contacts"])
    return (result["score"], target["correct_bag"], not result["invalid"], touched,
            result["stack_stable"] is True, -max(result["others"].values(), default=0))


def best_candidate(scene, target_id, budget=250):
    best = None
    attempts = 0
    for action, result in search_candidates(scene, target_id, budget):
        attempts += 1
        if best is None or rank(result) > rank(best[1]):
            best = action, result
        if result["success"]:
            break
    return best, attempts
