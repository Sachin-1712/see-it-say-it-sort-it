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
