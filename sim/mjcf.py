"""Compile primitive collision geometry from a workbench scene."""

from xml.etree.ElementTree import Element, SubElement, tostring

import mujoco
import numpy as np

MM = 0.001
GRAM = 0.001


def vector(values):
    return " ".join(map(str, values))


def si(values):
    return vector(value * MM for value in values)


def box_friction(item, defaults):
    fallback = [defaults[k] for k in ("sliding", "torsional", "rolling")]
    value = item.get("friction")
    if value is None:
        return fallback
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        value = [value, *fallback[1:]]
    if isinstance(value, dict):
        value = [value.get(k, v) for k, v in zip(("sliding", "torsional", "rolling"), fallback)]
    if (not isinstance(value, list) or len(value) != 3
            or any(not isinstance(v, (int, float)) or not np.isfinite(v) or v < 0 for v in value)):
        raise ValueError(f"{item['instanceId']}: friction must be a nonnegative coefficient or triplet")
    return value


def element_rotation(item):
    """Intrinsic yaw/pitch/roll (Rz @ Ry @ Rx), matching tabletop yaw."""
    roll, pitch, yaw = np.deg2rad([item.get(axis, 0) for axis in ("roll", "pitch", "yaw")]) / 2
    cr, cp, cy = np.cos([roll, pitch, yaw])
    sr, sp, sy = np.sin([roll, pitch, yaw])
    return (cy * cp * cr + sy * sp * sr, cy * cp * sr - sy * sp * cr,
            cy * sp * cr + sy * cp * sr, sy * cp * cr - cy * sp * sr)


def compile_scene(scene):
    """Return a fresh MjModel. Any trial state belongs to a separate MjData."""
    cfg = scene.config()
    sim = cfg["sim"]
    root = Element("mujoco", model="gekko")
    SubElement(root, "compiler", angle="radian", autolimits="true")
    SubElement(root, "option", timestep=str(sim["timestep_s"]), integrator="implicitfast",
               gravity=vector((0, 0, -sim["gravity_m_s2"])),
               iterations=str(sim["solver_iterations"]))
    defaults = SubElement(root, "default")
    friction = sim["friction"]
    SubElement(defaults, "geom", condim="4",
               friction=vector(friction[k] for k in ("sliding", "torsional", "rolling")),
               solref=vector(sim["solref"]), solimp=vector(sim["solimp"]))

    world = SubElement(root, "worldbody")
    table = cfg["rig"]["table"]
    width, depth, thickness, height = (table[k] for k in ("width", "depth", "thickness", "height"))
    SubElement(world, "geom", name="bench", type="box",
               pos=si((width / 2, depth / 2, height - thickness / 2)),
               size=si((width / 2, depth / 2, thickness / 2)))
    SubElement(world, "geom", name="floor", type="plane", size="0 0 0.1")
    for index, item in enumerate(scene.snapshot["objects"]):
        if item["type"] != "box":
            continue
        half_size = [item["dimensionsMm"][key] / 2 for key in ("width", "depth", "height")]
        body = SubElement(world, "body", name=f"parcel_{index}",
                          pos=si(item["position"][axis] for axis in ("x", "y", "z")),
                          quat=vector(element_rotation(item)))
        SubElement(body, "freejoint")
        SubElement(body, "geom", name=f"box_{index}", type="box", size=si(half_size),
                   mass=str(item["massG"] * GRAM),
                   priority="1", friction=vector(box_friction(item, friction)))
    return mujoco.MjModel.from_xml_string(tostring(root, encoding="unicode"))
