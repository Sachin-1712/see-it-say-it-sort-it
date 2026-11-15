"""Rebuild permanent low-poly assets using Blender's bundled Python (bpy).

blender --background --factory-startup --python scripts/generate_models.py
Optional after --: --config config/models.json --rig config/rig.json --output assets/models
Input geometry: mm/Z-up. Blender geometry and GLB output: metres; export_yup=True.
No web request or camera image is involved in generation.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector

ROOT = Path(__file__).resolve().parents[1]
MM = 0.001


def material(name, colour, metal=0, roughness=0.75):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    rgba = tuple(int(colour[i:i + 2], 16) / 255 for i in (1, 3, 5)) + (1,)
    # Input colours are sRGB; Principled base colour uses linear values.
    rgba = tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgba[:3]) + (1,)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = rgba
    return mat


def empty(name, parent=None, position=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    obj.location = Vector(position) * MM
    return obj


def finish(obj, name, parent, position, mat, bevel=0):
    obj.name = name
    obj.data.name = name
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        modifier = obj.modifiers.new("Small edge bevel", "BEVEL")
        modifier.width = bevel * MM
        modifier.segments = 2
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.parent = parent
    obj.location = Vector(position) * MM
    obj.data.materials.append(mat)
    return obj


def box(name, dimensions, position, parent, mat, bevel=0.3):
    if any(d <= 0 for d in dimensions):
        raise ValueError(f"{name}: dimensions must be positive")
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.object
    obj.dimensions = Vector(dimensions) * MM
    return finish(obj, name, parent, position, mat, bevel)


def cylinder(name, radius, height, position, parent, mat, bevel=0.25):
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=radius * MM, depth=height * MM)
    obj = finish(bpy.context.object, name, parent, position, mat, bevel)
    for polygon in obj.data.polygons:
        polygon.use_smooth = abs(polygon.normal.z) < 0.5
    return obj


def decal(name, dimensions, position, parent, mat):
    bpy.ops.mesh.primitive_plane_add(size=1)
    obj = bpy.context.object
    obj.scale = (dimensions[0] * MM, dimensions[1] * MM, 1)
    return finish(obj, name, parent, position, mat)


def reset():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.materials):
        bpy.data.materials.remove(block)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0


def export(path):
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", export_yup=True,
                             export_extras=True, export_animations=False, export_cameras=False,
                             export_lights=False, export_apply=True)


def gltf_vector(vector):
    x, y, z = vector
    return [x, z, -y]


def axis(value):
    result = Vector(value)
    if result.length < 1e-8:
        raise ValueError("Joint axes must be nonzero")
    return result.normalized()


def build_box(spec, rig, output):
    reset()
    parcel = next((p for p in rig.get("parcels", []) if p["id"] == spec.get("rigParcel")), None)
    dimensions = [parcel[k] for k in ("width", "depth", "height")] if parcel else spec["fallbackDimensionsMm"]
    mass = parcel["mass_g"] if parcel else spec["fallbackMassG"]
    width, depth, height = dimensions
    root = empty(spec["id"])
    root["modelKey"] = spec["id"]
    root["origin"] = "bottom centre"
    root["placeholderMeasurements"] = True
    root["dimensionsMm"] = dimensions
    body = material("Grey cardboard", spec["colour"], roughness=0.88)
    tape = material("Kraft packing tape", "#858585", roughness=0.85)
    paper = material("Shipping label", "#BEBEBE")
    ink = material("Printed markings", "#444444")
    box("parcel_body", dimensions, (0, 0, height / 2), root, body, min(dimensions) * 0.008)
    # Thin surface decals do not change collision geometry or stacking height.
    decal("packing_tape", (width * 0.19, depth * 0.99), (0, 0, height + 0.005), root, tape)
    decal("shipping_label", (width * 0.31, depth * 0.35), (width * 0.26, 0, height + 0.01), root, paper)
    for i in range(7):
        decal(f"label_bar_{i}", (width * (0.011 if i % 2 else 0.019), depth * 0.19),
              (width * (0.16 + i * 0.032), 0, height + 0.015), root, ink)
    export(output / f'{spec["id"]}.glb')
    return {
        "name": spec["name"], "url": f'{spec["id"]}.glb', "type": "box", "colour": spec["colour"],
        "origin": "bottom-centre", "dimensionsMm": {"width": width, "depth": depth, "height": height},
        "massG": mass, "collision": {"shape": "box", "sizeMm": dimensions, "centerMm": [0, 0, height / 2]},
        "measurementSource": f'config/rig.json parcels.{spec["rigParcel"]}' if parcel else "config/models.json fallbackDimensionsMm",
        "placeholderMeasurements": True, "friction": None,
        "nodes": {"root": spec["id"], "body": "parcel_body"},
    }


def build_sweeper(spec, output):
    reset()
    can, servo, stick, tilt = (spec[k] for k in ("can", "servo", "stick", "assemblyTilt"))
    tilt_axis, servo_axis = axis(tilt["axisZup"]), axis(servo["axisZup"])
    steel = material("Brushed metal can", "#A4A4A4", metal=0.8, roughness=0.32)
    rim = material("Can rolled rims", "#BABABA", metal=0.9, roughness=0.24)
    plastic = material("Servo graphite case", "#3D3D3D", roughness=0.45)
    dark = material("Servo mount and horn", "#303030", roughness=0.6)
    wood = material("Muted grey wooden sweeper", "#777777", roughness=0.85)
    # Asset origin is can-base centre. The tilt pivot may be elsewhere in that frame.
    root = empty("sweeper")
    root["modelKey"] = "sweeper"
    root["placeholderMeasurements"] = True
    assembly = empty("assembly_tilt", root, tilt["pivotMm"])
    assembly["rotationAxisGltf"] = gltf_vector(tilt_axis)
    assembly["role"] = "manual assembly tilt; preview only"
    body_frame = empty("can_base_frame", assembly, -Vector(tilt["pivotMm"]))
    cylinder("metal_can", can["radiusMm"], can["heightMm"], (0, 0, can["heightMm"] / 2), body_frame, steel)
    for name, z in (("bottom_rim", 1), ("top_rim", can["heightMm"] - 1)):
        cylinder(name, can["radiusMm"] + 0.6, 2, (0, 0, z), body_frame, rim)
    for i in range(3):
        cylinder(f"can_rib_{i}", can["radiusMm"] + 0.15, 0.7,
                 (0, 0, can["heightMm"] * (0.3 + i * 0.16)), body_frame, steel, 0.1)
    mount = empty("servo_mount", body_frame, servo["pivotMm"])
    mount.rotation_mode = "QUATERNION"
    mount.rotation_quaternion = (Vector((0, 0, 1)).rotation_difference(servo_axis)
                                 @ Quaternion((0, 0, 1), math.radians(servo.get("mountRollDeg", 0))))
    sx, sy, sz = servo["caseDimensionsLocalMm"]
    box("servo_case", (sx, sy, sz), (0, 0, -sz / 2 - 2), mount, plastic, 0.7)
    box("servo_mount_bracket", (sx + 8, 4, sz + 4), (0, -sy / 2 - 1, -sz / 2 - 2), mount, dark)
    output_node = empty("servo_output", mount)
    output_node.rotation_euler.z = math.radians(servo["restDeg"])
    output_node["rotationAxisGltf"] = [0.0, 1.0, 0.0]  # Blender local +Z exported to glTF local +Y
    output_node["direction"] = servo["direction"]
    output_node["role"] = "servo output; rotates stick only"
    cylinder("servo_horn", 6, 3, (0, 0, 1.5), output_node, dark)
    center = [stick["lengthMm"] / 2 - stick["pivotFromEndMm"], 0, 3 + stick["thicknessMm"] / 2]
    box("wooden_stick", (stick["lengthMm"], stick["widthMm"], stick["thicknessMm"]), center, output_node, wood, 0.4)
    cylinder("horn_screw", 1.5, 0.7, (0, 0, 3 + stick["thicknessMm"] + 0.35), output_node, rim, 0.1)
    bpy.context.view_layer.update()
    corners = [obj.matrix_world @ Vector(corner) for obj in bpy.context.scene.objects
               if obj.type == "MESH" for corner in obj.bound_box]
    extents = [(max(p[i] for p in corners) - min(p[i] for p in corners)) / MM for i in range(3)]
    dimensions = dict(zip(("width", "depth", "height"), (round(value, 3) for value in extents)))
    export(output / "sweeper.glb")
    return {
        "name": spec["name"], "url": "sweeper.glb", "type": "sweeper", "origin": "can-base-centre", "dimensionsMm": dimensions,
        "placeholderMeasurements": True, "measurementSource": "config/models.json sweeper",
        "massG": can["massG"] + servo["massG"] + stick["massG"], "friction": spec["friction"],
        "geometry": {"can": can, "servo": servo, "stick": stick},
        "collision": {"shape": "compound", "frame": "Z-up millimetres", "parts": [
            {"node": "metal_can", "shape": "cylinder", "radiusMm": can["radiusMm"], "heightMm": can["heightMm"], "centerMm": [0, 0, can["heightMm"] / 2], "axisZup": [0, 0, 1]},
            {"node": "servo_case", "shape": "box", "sizeMm": servo["caseDimensionsLocalMm"], "frame": "servo_mount local", "centerMm": [0, 0, -sz / 2 - 2]},
            {"node": "wooden_stick", "shape": "box", "sizeMm": [stick["lengthMm"], stick["widthMm"], stick["thicknessMm"]], "frame": "servo_output local", "centerMm": center}
        ]},
        "joints": {
            "tilt": {"node": "assembly_tilt", "pivotMm": tilt["pivotMm"], "axisZup": list(tilt_axis), "axisGltfLocal": gltf_vector(tilt_axis), "limitsDeg": tilt["limitsDeg"], "restDeg": 0, "direction": 1},
            "servo": {"node": "servo_output", "parent": "servo_mount", "pivotMm": servo["pivotMm"], "axisZup": list(servo_axis), "axisGltfLocal": [0, 1, 0], "limitsDeg": servo["limitsDeg"], "restDeg": servo["restDeg"], "direction": servo["direction"]}
        },
        "nodes": {"root": "sweeper", "assembly": "assembly_tilt", "mount": "servo_mount", "servoOutput": "servo_output", "stick": "wooden_stick"}
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "config/models.json")
    parser.add_argument("--rig", type=Path, default=ROOT / "config/rig.json")
    parser.add_argument("--output", type=Path, default=ROOT / "assets/models")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    config = json.loads(args.config.read_text())
    rig = json.loads(args.rig.read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = {"schemaVersion": 1, "assetUnits": "metres", "assetAxes": "Y-up: x, z, -y from simulation",
                "physicalUnits": "millimetres, grams, degrees", "physicalAxes": "Z-up", "models": {}}
    for spec in config["boxes"]:
        manifest["models"][spec["id"]] = build_box(spec, rig, args.output)
    manifest["models"]["sweeper"] = build_sweeper(config["sweeper"], args.output)
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for legacy in ("box_1.glb", "box_2.glb", "box_3.glb"):
        (args.output / legacy).unlink(missing_ok=True)
    print("Generated reusable Box and Sweeper assets and physical metadata in", args.output)


if __name__ == "__main__":
    main()
