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
