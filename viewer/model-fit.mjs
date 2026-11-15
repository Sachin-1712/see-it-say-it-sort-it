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

// Sweeper frame (config/models.json): origin on the bench top under the can's centre,
// x right, y away from the front, z up. The can lies along y; the servo shaft is vertical.
function fitSweeper(THREE, instance, { models }) {
  const { can, servo, stick, assemblyTilt: tilt } = models.sweeper;
  positive("Can size", can.radiusMm, can.heightMm);
  positive("Servo case size", ...servo.caseDimensionsLocalMm);
  positive("Stick size", stick.lengthMm, stick.widthMm, stick.thicknessMm);
  const { root, joints } = instance, h = can.heightMm;
  const minus = (a, b) => a.map((v, i) => v - b[i]);
  const dir = v => new THREE.Vector3(...toThree({ x: v[0], y: v[1], z: v[2] })).normalize();
  const UP = new THREE.Vector3(0, 1, 0);                      // glTF-local axis of the can and of the shaft

  // Tilt: the whole assembly rotates about tilt.axisZup through tilt.pivotMm.
  const tiltNode = node(root, "assembly_tilt");
  tiltNode.position.fromArray(toLocal(tilt.pivotMm));
  tiltNode.quaternion.identity();

  // Can: its local +Y (back end -> front end) turned to can.axisZup, back-end centre at can.baseCentreMm.
  const canFrame = node(root, "can_base_frame");
  canFrame.position.fromArray(toLocal(minus(can.baseCentreMm, tilt.pivotMm)));
  canFrame.quaternion.setFromUnitVectors(UP, dir(can.axisZup));
  scaleMeshTo(node(root, "metal_can"), [2 * can.radiusMm, h, 2 * can.radiusMm]);
  node(root, "metal_can").position.set(0, h / 2 * MM, 0);
  // Rims and ribs keep the generator's lip over the can radius (0.6 and 0.15 mm).
  for (const name of ["bottom_rim", "top_rim"]) scaleMeshTo(node(root, name), [2 * (can.radiusMm + 0.6), 2, 2 * (can.radiusMm + 0.6)]);
  node(root, "bottom_rim").position.set(0, 1 * MM, 0);
  node(root, "top_rim").position.set(0, (h - 1) * MM, 0);
  for (let i = 0; i < 3; i++) {
    scaleMeshTo(node(root, `can_rib_${i}`), [2 * (can.radiusMm + 0.15), 0.7, 2 * (can.radiusMm + 0.15)]);
    node(root, `can_rib_${i}`).position.set(0, h * (0.3 + i * 0.16) * MM, 0);
  }

  // Servo: re-parented beside the can (not inside its rotated frame), shaft turned to
  // servo.axisZup. Mount-local glTF axes: x, shaft, z.
  const mount = node(root, "servo_mount");
  tiltNode.add(mount);
  mount.position.fromArray(toLocal(minus(servo.pivotMm, tilt.pivotMm)));
  mount.quaternion.setFromUnitVectors(UP, dir(servo.axisZup))
    .multiply(new THREE.Quaternion().setFromAxisAngle(UP, (servo.mountRollDeg ?? 0) * Math.PI / 180));
  const [cx, cy, cz] = servo.caseDimensionsLocalMm;          // servo-local (x, y, shaft)
  const caseMesh = node(root, "servo_case");
  scaleMeshTo(caseMesh, [cx, cz, cy]);
  caseMesh.position.set(0, -(cz / 2 + 2) * MM, 0);
  // The bracket becomes the riser block between the can's top line and the case.
  const riser = servo.riserMm ?? 0, bracket = node(root, "servo_mount_bracket");
  bracket.visible = riser > 0;
  if (riser > 0) { scaleMeshTo(bracket, [cx, riser, cy]); bracket.position.set(0, -(cz + 2 + riser / 2) * MM, 0); }

  // Stick: servo-output glTF axes are (length, shaft, width).
  const stickMesh = node(root, "wooden_stick");
  scaleMeshTo(stickMesh, [stick.lengthMm, stick.thicknessMm, stick.widthMm]);
  stickMesh.position.set((stick.lengthMm / 2 - stick.pivotFromEndMm) * MM, (3 + stick.thicknessMm / 2) * MM, 0);
  node(root, "horn_screw").position.set(0, (3 + stick.thicknessMm + 0.35) * MM, 0);

  // Joints from config. Tilt axis is in the root frame; the servo turns about its local shaft.
  const tiltAxis = dir(tilt.axisZup);
  if (joints.tilt) Object.assign(joints.tilt, { axis: tiltAxis, axisGltfLocal: tiltAxis.toArray(), pivotMm: tilt.pivotMm,
    axisZup: tilt.axisZup, limitsDeg: tilt.limitsDeg, restDeg: 0, direction: 1, base: tiltNode.quaternion.clone() });
  if (joints.servo) Object.assign(joints.servo, { pivotMm: servo.pivotMm, axisZup: servo.axisZup, axis: UP.clone(),
    limitsDeg: servo.limitsDeg, restDeg: servo.restDeg, direction: servo.direction });

  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()); // mm: root is scaled x1000
  const r3 = v => Math.round(v * 1000) / 1000;
  const canCentre = can.baseCentreMm.map((v, i) => r3(v + can.axisZup[i] * h / 2));
  return {
    ...instance.metadata,
    dimensionsMm: { width: r3(bounds.x), depth: r3(bounds.z), height: r3(bounds.y) },
    massG: can.massG + servo.massG + stick.massG, measured: false, placeholderMeasurements: true,
    measurementSource: "config/models.json sweeper",
    frame: "sweeper frame: origin on the bench top under the can centre, Z-up millimetres",
    geometry: { can, servo, stick },
    collision: { shape: "compound", frame: "Z-up millimetres, sweeper frame", parts: [
      { node: "metal_can", shape: "cylinder", radiusMm: can.radiusMm, heightMm: h, centerMm: canCentre, axisZup: can.axisZup },
      { node: "servo_case", shape: "box", sizeMm: [cx, cy, cz], frame: "servo_mount local (shaft = local z)", centerMm: [0, 0, -(cz / 2 + 2)] },
      ...(servo.riserMm > 0 ? [{ node: "servo_mount_bracket", shape: "box", sizeMm: [cx, cy, servo.riserMm], frame: "servo_mount local (shaft = local z)",
        centerMm: [0, 0, -(cz + 2 + servo.riserMm / 2)], role: "riser" }] : []),
      { node: "wooden_stick", shape: "box", sizeMm: [stick.lengthMm, stick.widthMm, stick.thicknessMm], frame: "servo_output local",
        centerMm: [stick.lengthMm / 2 - stick.pivotFromEndMm, 0, 3 + stick.thicknessMm / 2] },
    ] },
    joints: {
      tilt: { ...instance.metadata.joints?.tilt, node: "assembly_tilt", pivotMm: tilt.pivotMm, axisZup: tilt.axisZup,
        axisGltfLocal: toThree({ x: tilt.axisZup[0], y: tilt.axisZup[1], z: tilt.axisZup[2] }).map(v => v + 0), limitsDeg: tilt.limitsDeg, restDeg: 0, direction: 1 },
      servo: { ...instance.metadata.joints?.servo, node: "servo_output", parent: "servo_mount", pivotMm: servo.pivotMm, axisZup: servo.axisZup,
        axisGltfLocal: [0, 1, 0], limitsDeg: servo.limitsDeg, restDeg: servo.restDeg, direction: servo.direction },
    },
  };
}

// Returns the same instance with its parts resized and metadata rebuilt from config.
export function fitToConfig(THREE, instance, key, config) {
  const metadata = key === "box" ? fitBox(THREE, instance, config) : key === "sweeper" ? fitSweeper(THREE, instance, config) : null;
  if (!metadata) throw new Error(`No config fitting for model ${key}.`);
  return { ...instance, metadata };
}
