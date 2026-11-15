"""Fresh, deterministic MuJoCo rollouts of placed workbench objects."""

import math
from functools import lru_cache
from typing import Any

import numpy as np

from .geometry import contact_angles
from .mjcf import MM, box_friction, compile_scene, initial_data
from .scene import Scene, build_scene, number
from .scoring import landed_bag, outcome, stack_stable

type Result = dict[str, Any]

__all__ = [
    "Result", "Scene", "apply_result", "build_scene", "feasible_tilts", "robust_score",
    "rollout", "rollout_sequence",
]


def validate_action(action, target, sweeper, cfg):
    if not isinstance(action, dict):
        raise ValueError("action must be an object")
    if target is None:
        raise ValueError("target is not a box in the snapshot")
    if sweeper is None:
        raise ValueError("snapshot has no sweeper")
    spec = cfg["models"]["sweeper"]
    settings = cfg["sim"]
    servo = settings["servo"]
    t_min, t_max = spec["assemblyTilt"]["limitsDeg"]
    a_min, a_max = spec["servo"]["limitsDeg"]
    validated = {"target": action["target"]}
    for field in ("tilt_deg", "sweep_start_deg", "sweep_end_deg"):
        low, high = (t_min, t_max) if field == "tilt_deg" else (a_min, a_max)
        value = number(action.get(field), field)
        if not low <= value <= high:
            raise ValueError(f"{field} outside limits [{low}, {high}]")
        validated[field] = value
    speed = number(action.get("speed_deg_s", servo["default_speed_deg_s"]),
                   "speed_deg_s", positive=True)
    if speed > servo["max_speed_deg_s"]:
        raise ValueError("speed_deg_s exceeds the configured limit")
    duration = abs(validated["sweep_end_deg"] - validated["sweep_start_deg"]) / speed
    if not 0 < duration <= settings["max_sweep_duration_s"]:
        raise ValueError("sweep duration outside limits")
    validated["speed_deg_s"] = speed
    return validated, duration


def invalid_result(target_id, reason, *, engine_ran=False):
    return {
        "success": False, "score": 0.0, "invalid": True, "reason": reason, "engine_ran": engine_ran,
        "target": {"id": target_id, "pose": None, "landed_bag": "none", "correct_bag": False},
        "others": {}, "disturbed": [], "stack_stable": None, "servo_stalled": False,
        "servo_stalled_before_contact": False, "trajectories": {}, "contacts": [], "final_poses": {},
    }


def angles(rotation):
    # Intrinsic yaw/pitch/roll, reported as roll, pitch, yaw.
    horizontal = math.hypot(rotation[0, 0], rotation[1, 0])
    pitch = math.atan2(-rotation[2, 0], horizontal)
    if horizontal > 1e-10:
        roll = math.atan2(rotation[2, 1], rotation[2, 2])
        yaw = math.atan2(rotation[1, 0], rotation[0, 0])
    else:
        roll = 0.0
        yaw = math.atan2(-rotation[0, 1], rotation[1, 1])
    return list(map(math.degrees, (roll, pitch, yaw)))


def pose(position_m, rotation):
    return [*(position_m / MM).tolist(), *angles(rotation)]


def contact_pairs(data, labels):
    # MuJoCo exposes contact fields as arrays; avoid a Python wrapper per contact.
    contacts = data.contact
    for first, second, distance in zip(contacts.geom1, contacts.geom2, contacts.dist):
        a, b = labels[first], labels[second]
        yield ((a, b) if a < b else (b, a)), distance


def parameter_for(params, key, item_id, default):
    value = params.get(key, default)
    return value.get(item_id, default) if isinstance(value, dict) else value


def perturbed_scene(scene, params, snapshot, cfg):
    if params == {}:
        return scene
    allowed = {"friction_scale", "mass_scale", "position_offset_mm", "tilt_offset_deg", "max_torque_nm"}
    if not isinstance(params, dict) or params.keys() - allowed:
        raise ValueError("unsupported physics_params")
    for item in snapshot["objects"]:
        if item["type"] != "box":
            continue
        key = item["instanceId"]
        scale = number(parameter_for(params, "friction_scale", key, 1), "friction_scale", positive=True)
        coeff = box_friction(item, cfg["sim"]["friction"])
        item["friction"] = [v * scale for v in coeff]
        item["massG"] *= number(parameter_for(params, "mass_scale", key, 1), "mass_scale", positive=True)
        offset = parameter_for(params, "position_offset_mm", key, [0, 0])
        if not isinstance(offset, (tuple, list)) or len(offset) != 2:
            raise ValueError("position_offset_mm must be [dx, dy]")
        for axis, delta in zip(("x", "y"), offset):
            item["position"][axis] += number(delta, "position_offset_mm")
    return scene.with_snapshot(snapshot)


@lru_cache(maxsize=32)
def trial_model(scene, tilt, cap):
    # The cached model is read-only by convention. Each invocation allocates MjData.
    return compile_scene(scene, tilt_deg=tilt, torque_cap=cap)


def rollout(scene: Scene, action, physics_params=None, seed=None) -> Result:
    """Simulate one sweep from rest at its requested start angle.

    A nominal rollout is deterministic for any seed. Randomization happens in
    robust_score, or the caller can pass realized offsets in physics_params.
    """
    cfg, snapshot = scene.config(), scene.snapshot
    target_id = action.get("target") if isinstance(action, dict) else None
    target_id = target_id if isinstance(target_id, str) else None
    boxes = [(i, obj) for i, obj in enumerate(snapshot["objects"]) if obj["type"] == "box"]
    target_index = next((i for i, (_, obj) in enumerate(boxes) if obj["instanceId"] == target_id), None)
    sweeper = next((obj for obj in snapshot["objects"] if obj["type"] == "sweeper"), None)
    params = {} if physics_params is None else physics_params
    try:
        action, duration = validate_action(action, target_index, sweeper, cfg)
        trial_scene = perturbed_scene(scene, params, snapshot, cfg)
        tilt = action["tilt_deg"] + number(params.get("tilt_offset_deg", 0), "tilt_offset_deg")
        low, high = cfg["models"]["sweeper"]["assemblyTilt"]["limitsDeg"]
        if not low <= tilt <= high:
            raise ValueError("realized tilt_deg outside limits")
        cap = number(params.get("max_torque_nm", cfg["sim"]["servo"]["max_torque_nm"]),
                     "max_torque_nm", positive=True)
    except ValueError as exc:
        return invalid_result(target_id, str(exc))

    import mujoco

    model = trial_model(trial_scene, tilt, cap)
    start, end = map(math.radians, (action["sweep_start_deg"], action["sweep_end_deg"]))
    servo_low, servo_high = map(math.radians, cfg["models"]["sweeper"]["servo"]["limitsDeg"])
    data = initial_data(model, action["sweep_start_deg"])
    body_ids = [model.body(f"parcel_{index}").id for index, _ in boxes]
    box_geom_ids = [model.geom(f"box_{index}").id for index, _ in boxes]
    stick_geom = model.geom("stick").id
    ids = [obj["instanceId"] for _, obj in boxes]
    labels = [model.geom(i).name for i in range(model.ngeom)]
    for geom_id, key in zip(box_geom_ids, ids):
        labels[geom_id] = key
    settings, scoring = cfg["sim"], cfg["scoring"]
    table = cfg["rig"]["table"]
    target_center = data.xpos[body_ids[target_index]] / MM
    target_up = data.xmat[body_ids[target_index]].reshape(3, 3)[2]
    target_bottom = target_center[2] - abs(target_up) @ model.geom_size[box_geom_ids[target_index]] / MM
    if (not 0 <= target_center[0] <= table["width"]
            or not 0 <= target_center[1] <= table["depth"]
            or target_bottom < table["height"] - scoring["support_tolerance_mm"]):
        return invalid_result(target_id, "target must start on or over the bench", engine_ran=True)
    overlap = scoring["initial_overlap_tolerance_mm"] * MM
    attached = {"stick", "servo_case", "servo_mount_bracket", "can"}
    for pair, distance in contact_pairs(data, labels):
        if distance < -overlap and attached.intersection(pair) and any(x in ids for x in pair):
            return invalid_result(target_id, f"initial overlap between {pair[0]} and {pair[1]}", engine_ran=True)

    target_pair = tuple(sorted((target_id, "stick")))
    # Preserve parcels still on the bench, not boxes already collected in bins.
    # The main viewer retains collected boxes as real colliders on later sweeps.
    other_indices = []
    for i, body in enumerate(body_ids):
        center = data.xpos[body] / MM
        rotation = data.xmat[body].reshape(3, 3)
        bottom = center[2] - abs(rotation[2]) @ model.geom_size[box_geom_ids[i]] / MM
        if (i != target_index and 0 <= center[0] <= table["width"]
                and 0 <= center[1] <= table["depth"]
                and bottom >= table["height"] - scoring["support_tolerance_mm"]):
            other_indices.append(i)
    contacts = {}
    tracks = {key: [] for key in [*ids, "stick"]}
    max_motion = np.zeros(len(boxes))
    initial = data.xpos[body_ids].copy()
    dt = model.opt.timestep
    before_s = settings["settle_before_s"]
    after_s = settings["settle_after_s"]
    steps = math.ceil((before_s + duration + after_s) / dt)
    rate = settings["sample_rate_hz"]
    servo = settings["servo"]
    stall_error = math.radians(servo["stall_error_deg"])
    stall_speed = math.radians(servo["stall_speed_deg_s"])
    qpos = model.joint("servo").qposadr[0]
    qvel = model.joint("servo").dofadr[0]
    jammed_s = 0.0
    stalled = stalled_before = False
    frame = 0
    servo_track = []
    peak_torque = 0.0
    max_penetration = 0.0
    deepest_pair = None
    for step in range(steps + 1):
        t = step * dt
        alpha = min(1, max(0, (t - before_s) / duration))
        data.ctrl[0] = start + alpha * (end - start)
        mujoco.mj_step1(model, data)
        positions = data.xpos[body_ids]
        delta = positions - initial
        np.maximum(max_motion, np.einsum("ij,ij->i", delta, delta), out=max_motion)
        for pair, distance in contact_pairs(data, labels):
            if distance <= 0:
                contacts.setdefault(pair, round(t, 6))
                if -distance > max_penetration:
                    max_penetration, deepest_pair = -distance, pair
        if t + dt / 2 >= frame / rate:
            timestamp = frame / rate
            for key, body, position in zip(ids, body_ids, positions):
                tracks[key].append([timestamp, *pose(position, data.xmat[body].reshape(3, 3))])
            tracks["stick"].append([timestamp, *pose(data.geom_xpos[stick_geom],
                                                     data.geom_xmat[stick_geom].reshape(3, 3))])
            servo_track.append([timestamp, math.degrees(data.qpos[qpos])])
            frame += 1
        if step == steps:
            break
        mujoco.mj_step2(model, data)
        # MuJoCo's inequality constraint is compliant. Model the hard stops
        # as inelastic if an external contact pushes past the configured travel.
        if data.qpos[qpos] < servo_low:
            data.qpos[qpos] = servo_low
            data.qvel[qvel] = max(0, data.qvel[qvel])
        elif data.qpos[qpos] > servo_high:
            data.qpos[qpos] = servo_high
            data.qvel[qvel] = min(0, data.qvel[qvel])
        torque = abs(data.actuator_force[0])
        peak_torque = max(peak_torque, torque)
        if (alpha > 0 and abs(data.ctrl[0] - data.qpos[qpos]) >= stall_error
                and abs(data.qvel[qvel]) <= stall_speed and torque >= cap * 0.999):
            jammed_s += dt
            if jammed_s >= servo["stall_duration_s"]:
                stalled = True
                stalled_before |= target_pair not in contacts
        else:
            jammed_s = 0.0

    if data.warning.number.any():
        return invalid_result(target_id, "MuJoCo reported a numerical warning", engine_ran=True)
    rotations = data.xmat[body_ids].reshape(-1, 3, 3)
    extents = np.einsum("nij,nj->ni", abs(rotations), model.geom_size[box_geom_ids]) / MM
    final = {}
    for index, (key, position, rotation) in enumerate(zip(ids, positions, rotations)):
        final[key] = dict(zip(("x", "y", "z", "roll", "pitch", "yaw"), pose(position, rotation)))
        final[key]["baseZ"] = final[key]["z"] - extents[index, 2]
    item = boxes[target_index][1]
    target_pose = final[target_id]
    bags = cfg["rig"]["bags"]
    # A parcel may rest on another parcel already inside the bin. Prove a final
    # support chain to that bin's floor, never infer a landing from an old touch.
    final_pairs_for_bags = {pair for pair, distance in contact_pairs(data, labels) if distance <= 0}
    bag_support = {name: set() for name in bags}
    for index in sorted(range(len(ids)), key=lambda i: positions[i, 2]):
        for name in bags:
            neighbors = {b if a == ids[index] else a for a,b in final_pairs_for_bags if ids[index] in (a,b)}
            if f"bag_{name}_base" in neighbors or neighbors.intersection(bag_support[name]):
                if landed_bag(final[ids[index]], extents[index], bags, {name}, scoring["support_tolerance_mm"]) == name:
                    bag_support[name].add(ids[index])
    bag_assignments = {key: next((name for name, supported in bag_support.items() if key in supported), "none") for key in ids}
    bag = bag_assignments[target_id]
    others = {ids[i]: float(math.sqrt(max_motion[i]) / MM) for i in other_indices}

    # A remaining parcel must be upright and supported above the floor, directly
    # by the table or through another remaining parcel. A transient touch is insufficient.
    support = set()
    indices = dict(zip(ids, range(len(ids))))
    final_pairs = {pair for pair, distance in contact_pairs(data, labels) if distance <= 0}
    for i in sorted(other_indices, key=lambda i: positions[i, 2]):
        for pair in final_pairs:
            if ids[i] not in pair:
                continue
            neighbor = pair[1] if pair[0] == ids[i] else pair[0]
            j = indices.get(neighbor)
            if neighbor == "bench" or (j in support and positions[j, 2] < positions[i, 2]):
                support.add(i)
                break
    velocities = np.array([data.qvel[model.jnt_dofadr[model.body_jntadr[body]]:][:3]
                           for body in body_ids]) / MM
    stable = stack_stable(other_indices, rotations, velocities, support, scoring)
    assigned = item.get("destination") or cfg["rig"]["colour_to_bag"].get(item.get("color"))
    if item.get("color") is None and item.get("destination") in cfg["rig"]["bags"]:
        assigned = item["destination"]
    result = outcome(target_id, target_pose, bag, assigned, others, stable, stalled_before,
                     target_pair in contacts, scoring["displacement_tolerance_mm"])
    result.update(
        engine_ran=True, integration_steps=steps, action=action, realized_tilt_deg=tilt, servo_stalled=stalled, servo_stalled_before_contact=stalled_before,
        servo_final_deg=math.degrees(data.qpos[qpos]), peak_servo_torque_nm=float(peak_torque),
        trajectories=tracks, servo_trajectory=servo_track, final_poses=final, bag_assignments=bag_assignments, max_contact_penetration_mm=float(max_penetration / MM),
        deepest_contact_pair=list(deepest_pair) if deepest_pair else None,
        contacts=[dict(t_s=t, body_a=a, body_b=b) for (a, b), t in contacts.items()],
    )
    return result


def robust_score(scene: Scene, action, trials=10, seed=None) -> dict:
    """Return the fraction of inclusive, independent uncertainty trials that sort."""
    if isinstance(trials, bool) or not isinstance(trials, int) or trials < 1:
        raise ValueError("trials must be a positive integer")
    uncertainty = scene.config()["scoring"]["robustness"]
    ids = [obj["instanceId"] for obj in scene.snapshot["objects"] if obj["type"] == "box"]
    rng = np.random.default_rng(seed)
    results = []
    for _ in range(trials):
        friction = uncertainty["friction_fraction"]
        mass = uncertainty["mass_fraction"]
        position = uncertainty["position_mm"]
        tilt = uncertainty["tilt_deg"]
        params = {
            "friction_scale": {key: float(rng.uniform(1 - friction, 1 + friction)) for key in ids},
            "mass_scale": {key: float(rng.uniform(1 - mass, 1 + mass)) for key in ids},
            "position_offset_mm": {key: rng.uniform(-position, position, size=2).tolist() for key in ids},
            "tilt_offset_deg": float(rng.uniform(-tilt, tilt)),
        }
        results.append(rollout(scene, action, physics_params=params))
    return {"score": sum(result["success"] for result in results) / trials, "results": results}


def apply_result(scene: Scene, result: Result) -> Scene:
    """Carry forward every final parcel pose and remove a parcel caught by a bag."""
    if result["invalid"]:
        return scene
    snapshot = scene.snapshot
    poses = result["final_poses"]
    target = result["target"]
    removed = target["id"] if target["landed_bag"] != "none" else None
    cfg = scene.config()["models"]["sweeper"]
    servo_min, servo_max = cfg["servo"]["limitsDeg"]
    items = []
    standing = []
    for item in snapshot["objects"]:
        key = item["instanceId"]
        if key == removed:
            continue
        if item["type"] == "box":
            p = poses[key]
            item["position"] = {axis: p[axis] for axis in ("x", "y", "z")}
            item.update({field: p[field] for field in ("baseZ", "roll", "pitch", "yaw")})
            standing.append(item)
        elif item["type"] == "sweeper":
            item["tiltDeg"] = result["realized_tilt_deg"]
            item["servoDeg"] = min(servo_max, max(servo_min, result["servo_final_deg"]))
        items.append(item)
    for i, item in enumerate(sorted(standing, key=lambda item: item["baseZ"])):
        item["stackIndex"] = i
    snapshot["objects"] = items
    if snapshot.get("selectedId") == removed:
        snapshot["selectedId"] = None
    return scene.with_snapshot(snapshot)


def rollout_sequence(scene: Scene, actions, seed=None) -> list[Result]:
    """Roll each action forward from the preceding final scene."""
    results = []
    for action in actions:
        result = rollout(scene, action, seed=seed)
        results.append(result)
        scene = apply_result(scene, result)
    return results


def feasible_tilts(scene: Scene, target_id) -> list[float]:
    """Sample tilts with a kinematic approach to the target from either side."""
    return [tilt for tilt, _ in contact_angles(scene, target_id)]
