"""Compile primitive collision geometry from a workbench scene."""

from xml.etree.ElementTree import Element, SubElement, tostring

import mujoco

MM = 0.001
GRAM = 0.001


def vector(values):
    return " ".join(map(str, values))


def si(values):
    return vector(value * MM for value in values)


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
    return mujoco.MjModel.from_xml_string(tostring(root, encoding="unicode"))
