"""Versioned, self-contained task definitions and fixed simulation benchmark."""
import hashlib
import json
from pathlib import Path

from sim.scene import Scene, build_scene, demo_snapshot

ROOT = Path(__file__).resolve().parents[1]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()[:20]


def make_task(snapshot, version=1, settings=None):
    scene = build_scene(snapshot, ROOT / "config")
    settings = settings or json.loads((ROOT / "config/swarm.json").read_text())
    if not .8<=settings.get("robust_threshold",0)<=1:
        raise ValueError("robust_threshold must be between 0.8 and 1")
    if any(settings.get(key,0)<1 for key in ("action_validation_trials","plan_validation_trials","rollout_limit","beam_width","max_candidates","max_nodes")):
        raise ValueError("trial budgets, beam width and cache limits must be positive")
    goals = {o["instanceId"]: o.get("destination") or scene.config()["rig"]["colour_to_bag"].get(o.get("color"))
             for o in snapshot["objects"] if o["type"] == "box"}
    if not goals or any(v not in scene.config()["rig"]["bags"] for v in goals.values()):
        raise ValueError("Every placed box needs a left/right destination")
    body = dict(snapshot=snapshot, config=scene.config(), settings=settings, goals=goals)
    return dict(task_id=digest(body), scene_version=version, **body)


def scene_from(task, snapshot=None):
    return Scene(json.dumps(snapshot or task["snapshot"], allow_nan=False), json.dumps(task["config"], allow_nan=False))


def advance(scene, result):
    """Retain collected parcels as collision bodies, unlike the older batch demo."""
    snapshot = scene.snapshot
    for item in snapshot["objects"]:
        if item["type"] == "box":
            pose = result["final_poses"][item["instanceId"]]
            item["position"] = {axis: pose[axis] for axis in ("x", "y", "z")}
            item.update({axis: pose[axis] for axis in ("baseZ", "roll", "pitch", "yaw")})
        else:
            item["servoDeg"] = result["servo_final_deg"]
            item["tiltDeg"] = result["realized_tilt_deg"]
    return scene.with_snapshot(snapshot)


def golden_snapshot():
    return json.loads((ROOT / "config/golden-three-box-v1.json").read_text())["snapshot"]
