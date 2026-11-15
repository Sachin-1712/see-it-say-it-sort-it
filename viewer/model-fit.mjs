// Load-time fitting of the pre-built GLBs to the sizes in config/rig.json and
// config/models.json. Blender is not rerun: each part's bounding box is measured
// from its mesh and scaled so it matches the configured size exactly.
// Sizes come only from config. If the GLBs are regenerated at these sizes,
// every scale factor below becomes 1.
import { toThree } from "./frame.mjs";

const MM = 0.001; // glTF units are metres; ModelLibrary scales the root by 1000.

function node(root, name) {
  const found = root.getObjectByName(name);
  if (!found) throw new Error(`Model is missing node ${name}.`);
  return found;
}
// Scale a mesh node so its geometry bounding box is exactly [x, y, z] mm in its
// own glTF-local axes. Clones share geometry, so the box is computed in place once.
function scaleMeshTo(mesh, [x, y, z]) {
  mesh.geometry.computeBoundingBox();
  const b = mesh.geometry.boundingBox;
  mesh.scale.set(x * MM / (b.max.x - b.min.x), y * MM / (b.max.y - b.min.y), z * MM / (b.max.z - b.min.z));
}
const positive = (label, ...values) => {
  if (!values.every(v => Number.isFinite(v) && v > 0)) throw new Error(`${label} must be positive numbers in config.`);
};
const toLocal = mm => toThree({ x: mm[0], y: mm[1], z: mm[2] }).map(v => v * MM);

function fitBox(THREE, instance, { rig, models }) {
  const spec = models.boxes.find(box => box.id === "box");
  const parcel = rig.parcels?.find(p => p.id === spec?.rigParcel);
  if (!parcel) throw new Error("config/rig.json has no parcel for the Box model.");
  const { width, depth, height, mass_g } = parcel;
  positive("Box size", width, depth, height);
  const { root } = instance, body = node(root, "parcel_body");
  body.geometry.computeBoundingBox();
  const b = body.geometry.boundingBox;
  // Whole-model scale, so the label decals stay on the lid. Body origin is bottom-centre.
  root.scale.set(width / (b.max.x - b.min.x), height / (b.max.y - b.min.y), depth / (b.max.z - b.min.z));
  root.updateMatrixWorld(true);
  return {
    ...instance.metadata,
    dimensionsMm: { width, depth, height }, massG: mass_g, measured: false, placeholderMeasurements: true,
    measurementSource: `config/rig.json parcels.${parcel.id}`,
    collision: { shape: "box", sizeMm: [width, depth, height], centerMm: [0, 0, height / 2] },
  };
}

function fitSweeper(THREE, instance, { models }) {
  const { can, servo, stick, assemblyTilt: tilt } = models.sweeper;
  positive("Can size", can.radiusMm, can.heightMm);
  positive("Servo case size", ...servo.caseDimensionsLocalMm);
  positive("Stick size", stick.lengthMm, stick.widthMm, stick.thicknessMm);
  const { root, joints } = instance, h = can.heightMm;

  // Tilt pivot: the assembly rotates about tilt.pivotMm; the can frame sits back at the origin.
  node(root, "assembly_tilt").position.fromArray(toLocal(tilt.pivotMm));
  node(root, "can_base_frame").position.fromArray(toLocal(tilt.pivotMm)).negate();

  // Can: glTF-local axes are (x, height, depth). Rims and ribs follow the generator's layout.
  scaleMeshTo(node(root, "metal_can"), [2 * can.radiusMm, h, 2 * can.radiusMm]);
  node(root, "metal_can").position.set(0, h / 2 * MM, 0);
  node(root, "bottom_rim").position.set(0, 1 * MM, 0);
  node(root, "top_rim").position.set(0, (h - 1) * MM, 0);
  for (let i = 0; i < 3; i++) node(root, `can_rib_${i}`).position.set(0, h * (0.3 + i * 0.16) * MM, 0);

  // Servo: the mount keeps its baked rotation (shaft axis unchanged), so the configured
  // axis must still match it. Mount-local glTF axes: x, shaft, z.
  const mount = node(root, "servo_mount");
  mount.position.fromArray(toLocal(servo.pivotMm));
  const shaft = new THREE.Vector3(0, 1, 0).applyQuaternion(mount.quaternion);
  const wanted = new THREE.Vector3(...toThree({ x: servo.axisZup[0], y: servo.axisZup[1], z: servo.axisZup[2] })).normalize();
  if (shaft.angleTo(wanted) > 1e-6) throw new Error("config servo.axisZup differs from the pre-built model; rerun Blender to change it.");
  const [cx, cy, cz] = servo.caseDimensionsLocalMm;          // servo-local (x, y, shaft)
  const caseMesh = node(root, "servo_case");
  scaleMeshTo(caseMesh, [cx, cz, cy]);
  caseMesh.position.set(0, -(cz / 2 + 2) * MM, 0);
  node(root, "servo_mount_bracket").position.set(0, -(cz / 2 + 2) * MM, (cy / 2 + 1) * MM);

  // Stick: servo-output glTF axes are (length, shaft, width).
  const stickMesh = node(root, "wooden_stick");
  scaleMeshTo(stickMesh, [stick.lengthMm, stick.thicknessMm, stick.widthMm]);
  stickMesh.position.set((stick.lengthMm / 2 - stick.pivotFromEndMm) * MM, (3 + stick.thicknessMm / 2) * MM, 0);
  node(root, "horn_screw").position.set(0, (3 + stick.thicknessMm + 0.35) * MM, 0);

  // Joints from config. Tilt axis is in the root frame (assembly_tilt has no base rotation).
  const tiltAxis = new THREE.Vector3(...toThree({ x: tilt.axisZup[0], y: tilt.axisZup[1], z: tilt.axisZup[2] })).normalize();
  if (joints.tilt) Object.assign(joints.tilt, { axis: tiltAxis, axisGltfLocal: tiltAxis.toArray(), pivotMm: tilt.pivotMm,
    axisZup: tilt.axisZup, limitsDeg: tilt.limitsDeg, restDeg: 0, direction: 1 });
  if (joints.servo) Object.assign(joints.servo, { pivotMm: servo.pivotMm, axisZup: servo.axisZup,
    limitsDeg: servo.limitsDeg, restDeg: servo.restDeg, direction: servo.direction });

  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()); // mm: root is scaled x1000
  const r3 = v => Math.round(v * 1000) / 1000;
  return {
    ...instance.metadata,
    dimensionsMm: { width: r3(bounds.x), depth: r3(bounds.z), height: r3(bounds.y) },
    massG: can.massG + servo.massG + stick.massG, measured: false, placeholderMeasurements: true,
    measurementSource: "config/models.json sweeper",
    geometry: { can, servo, stick },
    collision: { shape: "compound", frame: "Z-up millimetres", parts: [
      { node: "metal_can", shape: "cylinder", radiusMm: can.radiusMm, heightMm: h, centerMm: [0, 0, h / 2], axisZup: [0, 0, 1] },
      { node: "servo_case", shape: "box", sizeMm: [cx, cy, cz], frame: "servo_mount local", centerMm: [0, 0, -(cz / 2 + 2)] },
      { node: "wooden_stick", shape: "box", sizeMm: [stick.lengthMm, stick.widthMm, stick.thicknessMm], frame: "servo_output local",
        centerMm: [stick.lengthMm / 2 - stick.pivotFromEndMm, 0, 3 + stick.thicknessMm / 2] },
    ] },
    joints: {
      tilt: { ...instance.metadata.joints?.tilt, node: "assembly_tilt", pivotMm: tilt.pivotMm, axisZup: tilt.axisZup,
        axisGltfLocal: toThree({ x: tilt.axisZup[0], y: tilt.axisZup[1], z: tilt.axisZup[2] }), limitsDeg: tilt.limitsDeg, restDeg: 0, direction: 1 },
      servo: { ...instance.metadata.joints?.servo, node: "servo_output", pivotMm: servo.pivotMm, axisZup: servo.axisZup,
        limitsDeg: servo.limitsDeg, restDeg: servo.restDeg, direction: servo.direction },
    },
  };
}

// Returns the same instance with its parts resized and metadata rebuilt from config.
export function fitToConfig(THREE, instance, key, config) {
  const metadata = key === "box" ? fitBox(THREE, instance, config) : key === "sweeper" ? fitSweeper(THREE, instance, config) : null;
  if (!metadata) throw new Error(`No config fitting for model ${key}.`);
  return { ...instance, metadata };
}
