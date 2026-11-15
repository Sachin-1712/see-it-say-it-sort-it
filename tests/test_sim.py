import mujoco
import numpy as np

from sim.api import build_scene
from sim.mjcf import compile_scene
from sim.scene import demo_snapshot


def test_empty_bench_steps():
    scene = build_scene(demo_snapshot([], sweeper=False))
    model = compile_scene(scene)
    data = mujoco.MjData(model)
    mujoco.mj_step(model, data, nstep=1000)
    assert model.njnt == 0
    assert model.geom("bench").id >= 0
    for bag in ("left", "right"):
        for part in ("base", "front", "back", "left", "right"):
            assert model.geom(f"bag_{bag}_{part}").id >= 0
    assert np.isclose(data.time, 1000 * model.opt.timestep)
    assert not data.warning.number.any()


def test_three_independent_boxes_rest_on_contacts():
    scene = build_scene(demo_snapshot(["red", "blue", "red"], sweeper=False))
    model = compile_scene(scene)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    initial = data.xpos.copy()
    mujoco.mj_step(model, data, nstep=round(5 / model.opt.timestep))
    mujoco.mj_forward(model, data)
    drift_mm = np.linalg.norm((data.xpos - initial) * 1000, axis=1).max()
    print(f"5 s stack drift: {drift_mm:.6f} mm")
    assert model.njnt == 3
    assert drift_mm < 0.1
    assert np.abs(data.qvel).max() < 1e-5
    assert not data.warning.number.any()


def test_sweeper_matches_config_and_keeps_bench_clear():
    from sim.mjcf import initial_data

    scene = build_scene(demo_snapshot([]))
    cfg = scene.config()
    spec = cfg["models"]["sweeper"]
    bench = cfg["rig"]["table"]["height"]
    start, end = spec["servo"]["limitsDeg"]
    low, high = spec["assemblyTilt"]["limitsDeg"]
    positions = []
    minimum = np.inf
    for tilt in np.linspace(low, high, 14):
        model = compile_scene(scene, tilt_deg=tilt)
        for angle in np.linspace(start, end, 91):
            data = initial_data(model, angle)
            stick = data.geom("stick")
            orientation = stick.xmat.reshape(3, 3)
            stick_bottom = stick.xpos[2] - abs(orientation[2]) @ model.geom("stick").size
            can = data.geom("can")
            axis_z = can.xmat.reshape(3, 3)[2, 2]
            radius, half_length = model.geom("can").size[:2]
            can_bottom = can.xpos[2] - abs(axis_z) * half_length - radius * np.sqrt(1 - axis_z**2)
            minimum = min(minimum, (min(stick_bottom, can_bottom) * 1000 - bench))
            if angle == (start + end) / 2:
                positions.append((stick.xpos + orientation[:, 0] * model.geom("stick").size[0]) * 1000)
    print(f"minimum primitive clearance: {minimum:.3f} mm; tip drop: {positions[0][2] - positions[-1][2]:.3f} mm")
    assert minimum >= -1e-6
    assert positions[0][2] > positions[-1][2]
    assert positions[0][1] < scene.snapshot["objects"][0]["position"]["y"]
    model = compile_scene(scene, tilt_deg=low)
    first, last = (initial_data(model, angle).geom("stick").xpos[0] for angle in (start, end))
    assert first > last


def test_single_box_rehearsals_both_bags_and_deliberate_miss():
    from sim.api import rollout
    from sim.search import best_candidate

    for colour, bag in (("red", "left"), ("blue", "right")):
        scene = build_scene(demo_snapshot([colour]))
        key = scene.snapshot["objects"][0]["instanceId"]
        best, attempts = best_candidate(scene, key)
        assert best is not None, f"{bag}: no candidate approaches"
        action, result = best
        print(f"{bag}: {attempts} attempts, {action}, {result['target']}, {result['reason']}")
        assert result["success"], result["reason"]
        assert result["target"]["landed_bag"] == bag
        assert result["robust_score"] >= 0.8
        assert result["max_contact_penetration_mm"] < 2
        assert any({contact["body_a"], contact["body_b"]} == {key, f"bag_{bag}_base"}
                   for contact in result["contacts"])
        assert any({contact["body_a"], contact["body_b"]} == {key, "stick"}
                   for contact in result["contacts"])
        assert result["trajectories"]["stick"][1][0] == 1 / scene.config()["sim"]["sample_rate_hz"]
        assert len(result["servo_trajectory"]) == len(result["trajectories"]["stick"])
        assert abs(result["servo_trajectory"][-1][1] - result["servo_final_deg"]) < 0.1
    spec = scene.config()["models"]["sweeper"]
    start, end = spec["servo"]["limitsDeg"]
    miss = rollout(scene, dict(target=key, tilt_deg=spec["assemblyTilt"]["limitsDeg"][0],
                               sweep_start_deg=start, sweep_end_deg=end))
    assert not miss["invalid"] and not miss["success"]
    assert miss["reason"] == "stick never contacted target"


def test_stack_sorts_in_sequence_without_disturbing_remaining_parcels():
    from sim.api import apply_result, rollout_sequence
    from sim.search import best_candidate

    original = build_scene(demo_snapshot(["red", "blue", "red"]))
    scene = original
    actions = []
    for obj in reversed(original.snapshot["objects"][:-1]):
        key = obj["instanceId"]
        best, attempts = best_candidate(scene, key)
        assert best is not None
        action, result = best
        print(f"stack {key}: {attempts} attempts, {action}, {result['target']}, "
              f"{result['others']}, {result['reason']}")
        assert result["success"], result["reason"]
        assert result["target"]["landed_bag"] == obj["destination"]
        assert result["stack_stable"] and not result["disturbed"]
        actions.append(action)
        scene = apply_result(scene, result)
    assert all(result["success"] for result in rollout_sequence(original, actions))
    assert [obj["type"] for obj in scene.snapshot["objects"]] == ["sweeper"]


def test_robustness_sequence_deterministic_and_immutable():
    from sim.api import apply_result, feasible_tilts, robust_score, rollout, rollout_sequence
    from sim.search import candidate_actions

    original = demo_snapshot(["red", "blue", "red"])
    scene = build_scene(original)
    top = original["objects"][2]["instanceId"]
    middle = original["objects"][1]["instanceId"]
    assert feasible_tilts(scene, top)
    assert not feasible_tilts(scene, "missing")
    action = next(candidate_actions(scene, top))
    next_action = {**action, "target": middle}
    valid = rollout(scene, action)
    assert not valid["invalid"]
    after = apply_result(scene, valid)
    assert rollout_sequence(scene, [action, next_action], seed=42) == [
        valid, rollout(after, next_action, seed=42),
    ]
    for item in after.snapshot["objects"]:
        if item["type"] == "box":
            assert item["position"]["z"] == valid["final_poses"][item["instanceId"]]["z"]
    first = robust_score(scene, action, trials=3, seed=42)
    assert first == robust_score(scene, action, trials=3, seed=42)
    assert first["score"] == sum(row["success"] for row in first["results"]) / 3
    invalid = rollout(scene, {**action, "tilt_deg": -1})
    assert invalid["invalid"] and apply_result(scene, invalid) is scene
    assert scene.snapshot == original


def test_eight_processes_isolate_trials():
    from scripts.sim_parallel_check import parallel_check

    report = parallel_check(runs=2)
    assert report["processes"] == 8
    assert report["parallel_rollouts"] == 16
    assert report["serial_replays"] == 16


def test_sweep_moves_a_single_box_and_respects_torque_cap():
    from sim.api import rollout
    from sim.search import candidate_actions

    scene = build_scene(demo_snapshot(["red"]))
    key = scene.snapshot["objects"][0]["instanceId"]
    action = next(candidate_actions(scene, key))
    result = rollout(scene, action)
    assert not result["invalid"], result["reason"]
    track = np.array(result["trajectories"][key])[:, 1:4]
    distance = np.linalg.norm(track - track[0], axis=1).max()
    print(f"single-box commanded sweep: {distance:.3f} mm displacement, "
          f"{result['peak_servo_torque_nm']:.6f} N·m peak")
    assert distance > 1
    assert result["peak_servo_torque_nm"] <= scene.config()["sim"]["servo"]["max_torque_nm"] + 1e-12


def test_collected_boxes_remain_colliders_without_invalidating_later_workbench_sweeps():
    """The browser retains landed boxes; the batch demo removes them."""
    from sim.search import best_candidate

    scene = build_scene(demo_snapshot(["red", "blue", "red"]))
    for key in ["world_box_0003", "world_box_0002", "world_box_0001"]:
        best, attempts = best_candidate(scene, key, budget=200)
        assert best is not None
        action, result = best
        assert result["success"], (key, attempts, result["reason"])
        snapshot = scene.snapshot
        for item in snapshot["objects"]:
            if item["type"] == "box":
                pose = result["final_poses"][item["instanceId"]]
                item["position"] = {axis: pose[axis] for axis in ("x", "y", "z")}
                item.update({axis: pose[axis] for axis in ("baseZ", "roll", "pitch", "yaw")})
            else:
                item["servoDeg"] = result["servo_final_deg"]
                item["tiltDeg"] = result["realized_tilt_deg"]
        scene = scene.with_snapshot(snapshot)
        assert compile_scene(scene).ngeom >= 16  # all three parcel colliders remain
        print(f"retained bins {key}: {attempts} attempts, {result['target']['landed_bag']}")
    assert len([item for item in scene.snapshot["objects"] if item["type"] == "box"]) == 3
    assert result["bag_assignments"] == {"world_box_0001":"left","world_box_0002":"right","world_box_0003":"left"}


def test_collected_box_can_be_supported_by_another_box_inside_the_bin():
    from sim.api import rollout
    snapshot=demo_snapshot(["red","red","red"])
    cfg=build_scene(snapshot).config();bag=cfg["rig"]["bags"]["left"]
    for item,base in zip(snapshot["objects"][:2],[bag["wall_thickness"],bag["wall_thickness"]+25]):
        item["position"]={"x":bag["x"],"y":bag["y"],"z":base+12.5};item["baseZ"]=base
    target=snapshot["objects"][2]
    target["position"]["z"]=cfg["rig"]["table"]["height"]+12.5
    target["baseZ"]=cfg["rig"]["table"]["height"]
    result=rollout(build_scene(snapshot),dict(target=target["instanceId"],tilt_deg=0,sweep_start_deg=0,sweep_end_deg=180,speed_deg_s=280))
    assert not result["invalid"]
    assert result["bag_assignments"]["world_box_0001"]=="left"
    assert result["bag_assignments"]["world_box_0002"]=="left"
    assert abs(result["final_poses"]["world_box_0002"]["baseZ"]-27.5)<.1
