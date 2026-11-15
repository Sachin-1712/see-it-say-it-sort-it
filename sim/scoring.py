"""Bag detection and scoring using the actual integrated motion."""

import math

import numpy as np


def landed_bag(position, extent_mm, bags, base_contacts, tolerance):
    for name, bag in bags.items():
        wall = bag["wall_thickness"]
        if (name in base_contacts
                and position["z"] - extent_mm[2] >= wall - tolerance
                and abs(position["x"] - bag["x"]) + extent_mm[0] <= bag["width"] / 2 - wall + tolerance
                and abs(position["y"] - bag["y"]) + extent_mm[1] <= bag["depth"] / 2 - wall + tolerance
                and position["z"] + extent_mm[2] <= bag["height"]):
            return name
    return "none"


def stack_stable(other_indices, rotations, velocities, support, settings):
    min_up = math.cos(math.radians(settings["upright_tolerance_deg"]))
    return all(
        index in support
        and rotations[index, 2, 2] >= min_up
        and np.linalg.norm(velocities[index]) <= settings["settled_speed_mm_s"]
        for index in other_indices
    )


def outcome(target, position, bag, assigned, others, stable, stalled_before, touched, tolerance):
    disturbed = [key for key, distance in others.items() if distance >= tolerance]
    correct = assigned is not None and bag == assigned
    if stalled_before:
        reason = "servo stalled before contacting target"
    elif assigned is None:
        reason = "target has no assigned bag"
    elif not touched:
        reason = "stick never contacted target"
    elif bag == "none":
        reason = "target did not land in a bag"
    elif not correct:
        reason = "target landed in the wrong bag"
    elif disturbed:
        reason = "other parcels exceeded the displacement tolerance"
    elif not stable:
        reason = "remaining stack did not stay standing"
    else:
        reason = None
    return {
        "success": reason is None, "score": float(reason is None), "invalid": False,
        "reason": reason,
        "target": dict(id=target, pose=position, landed_bag=bag, correct_bag=correct),
        "others": others, "disturbed": disturbed, "stack_stable": stable,
    }
