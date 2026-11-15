"""Compile primitive collision geometry from a workbench scene."""

from xml.etree.ElementTree import Element, SubElement, tostring

import mujoco
import numpy as np

from .geometry import (
    element_rotation, mount_rotation, shaft_rotation, stick_shape, sweeper_origin, tilt_rotation, unit,
)

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


def add_sweeper(root, world, item, spec, settings, tilt_deg):
    """Evaluate the manually locked tilt hinge as a rigid transform."""
    tilt = spec["assemblyTilt"]
    can = spec["can"]
    servo = spec["servo"]
    pivot = np.asarray(tilt["pivotMm"])
    assembly = SubElement(world, "body", name="assembly_tilt",
                          pos=si(sweeper_origin(item) + pivot),
                          quat=vector(tilt_rotation(tilt, tilt_deg)))
    can_axis = unit(can["axisZup"])
    can_center = np.asarray(can["baseCentreMm"]) + can_axis * can["heightMm"] / 2
    can_body = SubElement(assembly, "body", name="can", pos=si(can_center - pivot),
                          quat=vector(shaft_rotation(can_axis)))
    SubElement(can_body, "geom", name="can", type="cylinder",
               size=si((can["radiusMm"], can["heightMm"] / 2)), mass=str(can["massG"] * GRAM))

    mount = SubElement(assembly, "body", name="servo_case",
                       pos=si(np.asarray(servo["pivotMm"]) - pivot),
                       quat=vector(mount_rotation(servo)))
    width, depth, height = servo["caseDimensionsLocalMm"]
    gap = servo["caseShaftGapMm"]
    SubElement(mount, "geom", name="servo_case", type="box",
               pos=si((0, 0, -height / 2 - gap)), size=si((width / 2, depth / 2, height / 2)),
               mass=str(servo["massG"] * GRAM))
    riser = servo.get("riserMm", 0)
    if riser > 0:
        SubElement(mount, "geom", name="servo_mount_bracket", type="box",
                   pos=si((0, 0, -height - gap - riser / 2)),
                   size=si((width / 2, depth / 2, riser / 2)), mass="0")

    output = SubElement(mount, "body", name="stick")
    limits = np.deg2rad(servo["limitsDeg"])
    SubElement(output, "joint", name="servo", type="hinge",
               axis=vector((0, 0, servo["direction"])), ref=str(np.deg2rad(servo["restDeg"])),
               limited="true", range=vector(limits), armature=str(settings["armature_kg_m2"]),
               damping=str(settings["damping_nm_s_rad"]))
    size, center = stick_shape(spec)
    SubElement(output, "geom", name="stick", pos=si(center), type="box",
               size=si(size / 2), mass=str(spec["stick"]["massG"] * GRAM))

    # Exclude rigid assembly components from colliding with their own output.
    contact = SubElement(root, "contact")
    for part in ("can", "servo_case"):
        SubElement(contact, "exclude", body1=part, body2="stick")
    actuator = SubElement(root, "actuator")
    torque = settings["max_torque_nm"]
    SubElement(actuator, "position", name="servo", joint="servo",
               kp=str(settings["position_gain_nm_rad"]), ctrllimited="true", ctrlrange=vector(limits),
               forcelimited="true", forcerange=vector((-torque, torque)))


def compile_scene(scene, *, tilt_deg=None):
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
        if item["type"] == "sweeper":
            locked = item.get("tiltDeg", 0) if tilt_deg is None else tilt_deg
            add_sweeper(root, world, item, cfg["models"]["sweeper"], sim["servo"], locked)
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



def initial_data(model, servo_deg=None):
    data = mujoco.MjData(model)
    if servo_deg is not None:
        address = model.joint("servo").qposadr[0]
        data.qpos[address] = data.ctrl[0] = np.deg2rad(servo_deg)
    mujoco.mj_forward(model, data)
    return data
