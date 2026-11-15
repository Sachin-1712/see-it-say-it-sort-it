"""Immutable scene inputs, with one copy of the external workbench snapshot."""

import json
import math
from dataclasses import dataclass
from pathlib import Path

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config"


def number(value, label, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise ValueError(f"{label} must be a finite number")
    if positive and value <= 0:
        raise ValueError(f"{label} must be positive")
    return float(value)


@dataclass(frozen=True, slots=True)
class Scene:
    _snapshot_json: str
    _config_json: str

    @property
    def snapshot(self):
        """Return a copy suitable for serialization or further placement."""
        return json.loads(self._snapshot_json)

    def config(self):
        return json.loads(self._config_json)

    def with_snapshot(self, snapshot):
        validate_snapshot(snapshot)
        return Scene(json.dumps(snapshot, allow_nan=False), self._config_json)


def validate_snapshot(snapshot):
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("objects"), list):
        raise ValueError("snapshot.objects must be a list")
    if snapshot.get("units", "mm") != "mm" or snapshot.get("axes", "Z-up") != "Z-up":
        raise ValueError("snapshot must use mm and Z-up")
    seen = {"bench", "floor", "stick", "can", "servo_case", "servo_mount_bracket"}
    has_sweeper = False
    for item in snapshot["objects"]:
        if not isinstance(item, dict):
            raise ValueError("snapshot objects must be dictionaries")
        item_id = item.get("instanceId")
        if not isinstance(item_id, str) or not item_id or item_id in seen:
            raise ValueError(f"invalid or duplicate instanceId: {item_id!r}")
        seen.add(item_id)
        position = item.get("position")
        if not isinstance(position, dict):
            raise ValueError(f"{item_id}.position must be an object")
        for axis in ("x", "y", "z"):
            number(position.get(axis), f"{item_id}.position.{axis}")
        kind = item.get("type")
        if kind == "sweeper":
            if has_sweeper:
                raise ValueError("snapshot can contain one sweeper")
            has_sweeper = True
            number(item.get("baseZ"), f"{item_id}.baseZ")
            number(item.get("tiltDeg", 0), f"{item_id}.tiltDeg")
            number(item.get("servoDeg", 0), f"{item_id}.servoDeg")
        elif kind == "box":
            dimensions = item.get("dimensionsMm")
            if not isinstance(dimensions, dict):
                raise ValueError(f"{item_id}.dimensionsMm must be an object")
            for axis in ("width", "depth", "height"):
                number(dimensions.get(axis), f"{item_id}.{axis}", positive=True)
            number(item.get("massG"), f"{item_id}.massG", positive=True)
            for axis in ("roll", "pitch", "yaw"):
                number(item.get(axis, 0), f"{item_id}.{axis}")
        else:
            raise ValueError(f"{item_id}: unsupported physics object type {kind!r}")


def build_scene(snapshot: dict, config_dir="config") -> Scene:
    directory = Path(config_dir)
    if config_dir == "config" and not directory.is_dir():
        directory = DEFAULT_CONFIG
    names = ("rig", "models", "sim", "scoring")
    config = {}
    for name in names:
        path = directory / f"{name}.json"
        if name != "scoring" or path.exists():
            config[name] = json.loads(path.read_text())
    return Scene("", json.dumps(config, allow_nan=False)).with_snapshot(snapshot)


def demo_snapshot(colours, config_dir=DEFAULT_CONFIG, *, sweeper=True):
    """Generate the same placement as WorkbenchState for the configured rig."""
    directory = Path(config_dir)
    rig = json.loads((directory / "rig.json").read_text())
    models = json.loads((directory / "models.json").read_text())
    parcel_id = models["boxes"][0]["rigParcel"]
    parcel = next(p for p in rig["parcels"] if p["id"] == parcel_id)
    pick = rig["zones"]["pick"]
    surface = rig["table"]["height"]
    dimensions = {axis: parcel[axis] for axis in ("width", "depth", "height")}
    objects = []
    for i, colour in enumerate(colours):
        base = surface + i * parcel["height"]
        objects.append(dict(
            instanceId=f"world_box_{i + 1:04}", type="box", color=colour,
            destination=rig["colour_to_bag"].get(colour), stackIndex=i,
            position=dict(x=pick["x"], y=pick["y"], z=base + parcel["height"] / 2),
            baseZ=base, dimensionsMm=dimensions.copy(), massG=parcel["mass_g"],
            friction=None,
        ))
    if sweeper:
        spec = models["sweeper"]
        y = (pick["y"] + parcel["depth"] / 2 + models["workbench"]["sweeperGapToStackMm"]
             + spec["can"]["heightMm"] / 2)
        objects.append(dict(
            instanceId=f"world_sweeper_{len(objects) + 1:04}", type="sweeper",
            position=dict(x=pick["x"], y=y, z=surface), baseZ=surface,
            tiltDeg=0, servoDeg=spec["servo"]["restDeg"],
        ))
    return {"mode": "visual-placement", "units": "mm", "axes": "Z-up", "objects": objects}
