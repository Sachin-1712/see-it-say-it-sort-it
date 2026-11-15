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
    assert drift_mm < 1
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
        assert any({contact["body_a"], contact["body_b"]} == {key, "stick"}
                   for contact in result["contacts"])
        assert result["trajectories"]["stick"][1][0] == 0.05
    spec = scene.config()["models"]["sweeper"]
    start, end = spec["servo"]["limitsDeg"]
    miss = rollout(scene, dict(target=key, tilt_deg=spec["assemblyTilt"]["limitsDeg"][0],
                               sweep_start_deg=start, sweep_end_deg=end))
    assert not miss["invalid"] and not miss["success"]
    assert miss["reason"] == "stick never contacted target"


def test_top_search_records_a_physics_outcome():
    from sim.search import best_candidate

    scene = build_scene(demo_snapshot(["red", "blue", "red"]))
    key = scene.snapshot["objects"][2]["instanceId"]
    best, attempts = best_candidate(scene, key)
    assert attempts > 0
    action, result = best
    print(f"stack top: {attempts} attempts, {action}, {result['target']}, {result['others']}, {result['reason']}")
    assert not result["invalid"]
    assert result["score"] in (0.0, 1.0)
    assert len(result["others"]) == 2


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
