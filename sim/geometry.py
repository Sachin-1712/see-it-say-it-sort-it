"""Sweeper transforms in the same z-up frames as the fitted viewer model."""

import math

import numpy as np


def quat_multiply(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ])


def unit(axis):
    axis = np.asarray(axis, dtype=float)
    norm = np.linalg.norm(axis)
    if norm == 0:
        raise ValueError("rotation axis must be nonzero")
    return axis / norm


def axis_angle(axis, radians):
    return np.r_[math.cos(radians / 2), unit(axis) * math.sin(radians / 2)]


def shaft_rotation(axis):
    """Shortest rotation from the model's local +Z shaft to its configured axis."""
    direction = unit(axis)
    if direction[2] < -1 + 1e-12:
        return np.array([0, 0, -1, 0], dtype=float)
    return unit([1 + direction[2], -direction[1], direction[0], 0])


def matrix(q):
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)],
        [2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w)],
        [2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y)],
    ])


def mount_rotation(servo):
    return quat_multiply(shaft_rotation(servo["axisZup"]),
                         axis_angle((0, 0, 1), math.radians(servo.get("mountRollDeg", 0))))


def tilt_rotation(tilt, tilt_deg):
    return axis_angle(tilt["axisZup"], math.radians(tilt_deg))


def sweeper_origin(item):
    return np.array([item["position"]["x"], item["position"]["y"], item["baseZ"]])


def stick_shape(spec):
    stick = spec["stick"]
    size = np.array([stick["lengthMm"], stick["widthMm"], stick["thicknessMm"]])
    center = np.array([size[0] / 2 - stick["pivotFromEndMm"], 0,
                       spec["servo"]["hornRiseMm"] + size[2] / 2])
    return size, center
