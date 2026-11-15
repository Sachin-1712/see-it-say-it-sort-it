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


def element_rotation(item):
    """Intrinsic yaw/pitch/roll (Rz @ Ry @ Rx), matching tabletop yaw."""
    roll, pitch, yaw = np.deg2rad([item.get(axis, 0) for axis in ("roll", "pitch", "yaw")]) / 2
    cr, cp, cy = np.cos([roll, pitch, yaw])
    sr, sp, sy = np.sin([roll, pitch, yaw])
    return (cy * cp * cr + sy * sp * sr, cy * cp * sr - sy * sp * cr,
            cy * sp * cr + sy * cp * sr, sy * cp * cr - cy * sp * sr)


def angle_grid(limits, step):
    count = math.ceil((limits[1] - limits[0]) / step)
    return np.linspace(*limits, count + 1)


def stick_poses(spec, origin, tilt_deg, angles_deg):
    tilt = spec["assemblyTilt"]
    servo = spec["servo"]
    rotation = matrix(tilt_rotation(tilt, tilt_deg))
    pivot = np.asarray(tilt["pivotMm"])
    shaft = origin + pivot + rotation @ (np.asarray(servo["pivotMm"]) - pivot)
    mount = rotation @ matrix(mount_rotation(servo))
    theta = np.deg2rad((angles_deg - servo["restDeg"]) * servo["direction"])
    angles = np.repeat(np.eye(3)[None, :, :], len(theta), axis=0)
    angles[:, 0, 0] = angles[:, 1, 1] = np.cos(theta)
    angles[:, 1, 0] = np.sin(theta)
    angles[:, 0, 1] = -angles[:, 1, 0]
    frames = mount @ angles
    size, center = stick_shape(spec)
    return shaft + frames @ center, frames, size / 2


def intersects_box(box, centers, frames, half_size):
    """Separating-axis test for all stick poses against one oriented parcel."""
    center = np.array([box["position"][axis] for axis in ("x", "y", "z")])
    axes = matrix(element_rotation(box))
    half = np.array([box["dimensionsMm"][axis] for axis in ("width", "depth", "height")]) / 2

    # Parcel face normals, stick face normals, then nine edge-cross-edge axes.
    parcel_normals = np.broadcast_to(axes.T, frames.shape)
    stick_normals = frames.transpose(0, 2, 1)
    crosses = np.cross(parcel_normals[:, :, None, :], stick_normals[:, None, :, :])
    probes = np.concatenate((parcel_normals, stick_normals, crosses.reshape(-1, 9, 3)), axis=1)
    distance = abs(np.einsum("nki,ni->nk", probes, centers - center))
    extent = abs(probes @ axes) @ half + abs(probes @ frames) @ half_size
    return np.all(distance <= extent + 1e-9, axis=1)


def contact_angles(scene, target_id):
    """Candidate first contacts from each side of the parked sweeper."""
    items = scene.snapshot["objects"]
    target = next((item for item in items if item["instanceId"] == target_id and item["type"] == "box"), None)
    sweeper = next((item for item in items if item["type"] == "sweeper"), None)
    if target is None or sweeper is None:
        return []
    obstacles = [item for item in items if item["type"] == "box" and item is not target]
    cfg = scene.config()
    spec, settings = cfg["models"]["sweeper"], cfg["sim"]
    angles = angle_grid(spec["servo"]["limitsDeg"], settings["alignment_servo_resolution_deg"])
    rows = []
    for tilt in angle_grid(spec["assemblyTilt"]["limitsDeg"], settings["tilt_resolution_deg"]):
        poses = stick_poses(spec, sweeper_origin(sweeper), tilt, angles)
        target_hits = intersects_box(target, *poses)
        hits = np.flatnonzero(target_hits)
        if not len(hits):
            continue
        occupied = np.zeros(len(angles), dtype=bool)
        for obstacle in obstacles:
            occupied |= intersects_box(obstacle, *poses)
        touches = {}
        first, last = hits[0], hits[-1]
        if first > 0 and not occupied[first - 1:first + 1].any():
            touches["left"] = float(angles[first - 1])
        if last < len(angles) - 1 and not occupied[last:last + 2].any():
            touches["right"] = float(angles[last + 1])
        if touches:
            rows.append((float(tilt), touches))
    return rows
