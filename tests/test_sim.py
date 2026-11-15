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
