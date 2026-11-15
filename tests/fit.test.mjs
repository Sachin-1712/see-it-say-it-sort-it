// Load-time fitting of the pre-built GLBs to config, stacking contact, manifest sync,
// and whether the stick tip can reach the top box. Uses the real GLBs, the real
// fitting code and the real workbench placement rules.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBB } from "three/addons/math/OBB.js";
import { ModelLibrary, applyJoint } from "../viewer/model-assets.mjs";
import { fitToConfig } from "../viewer/model-fit.mjs";
import { WorkbenchState } from "../viewer/workbench-state.mjs";
import { toThree, fromThree } from "../viewer/frame.mjs";

const read = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const manifest = await read("../assets/models/manifest.json");
const rig = await read("../config/rig.json"), models = await read("../config/models.json");
const config = { rig, models };
const parse = async name => {
  const data = await readFile(new URL(`../assets/models/${name}`, import.meta.url));
  return new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), "");
};
const library = new ModelLibrary({ loadAsync: url => parse(url.split("/").at(-1)) }, {
  manifestUrl: "http://localhost/assets/models/manifest.json", fetchImpl: async () => ({ ok: true, json: async () => manifest }),
});
const fitted = async key => fitToConfig(THREE, await library.instantiate(key), key, config);
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`);
// World AABB of a mesh in table-frame mm (valid for axis-aligned parts at rest).
const tableBox = object => {
  const box = new THREE.Box3().setFromObject(object), a = fromThree(box.min.toArray()), b = fromThree(box.max.toArray());
  return { min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: a.z }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: b.z },
    size: { x: Math.abs(b.x - a.x), y: Math.abs(b.y - a.y), z: b.z - a.z } };
};
// Parts under the baked 90-degree servo mount carry ~5 nm of float32 rotation slop in their
// world AABB, so 0.1 µm tolerance; their local-frame size is exact (checked separately below).
const sizeIs = (object, [x, y, z], tolerance = 1e-4) => { const { size } = tableBox(object); near(size.x, x, tolerance); near(size.y, y, tolerance); near(size.z, z, tolerance); };
// Exact size in the part's own axes: geometry box x its scale x the root's mm scale
// (every node between them has unit scale).
const localSize = mesh => { mesh.geometry.computeBoundingBox(); let root = mesh; while (root.parent) root = root.parent;
  return mesh.geometry.boundingBox.getSize(new THREE.Vector3()).multiply(mesh.scale).multiply(root.scale); };

async function buildScene() {
  const scene = new THREE.Scene(), state = new WorkbenchState();
  state.configure(rig.table, { ...models.workbench, stackPositionMm: { x: rig.zones.pick.x, y: rig.zones.pick.y } });
  const put = (instance, record) => {
    const item = state.add(record, instance.metadata);
    instance.root.position.set(...toThree({ ...item.position, z: item.baseZ }));
    scene.add(instance.root); instance.root.updateMatrixWorld(true);
    return item;
  };
  const sweeper = await fitted("sweeper");
  put(sweeper, { id: "sweeper", type: "sweeper", modelKey: "sweeper", name: "Sweeper" });
  const boxes = [];
  for (let i = 0; i < 3; i++) { const box = await fitted("box"); put(box, { id: "box", type: "box", modelKey: "box", name: "Box", color: "red" }); boxes.push(box); }
  return { scene, state, sweeper, boxes };
}

test("fitted GLB parts match the config sizes exactly", async () => {
  const box = await fitted("box"), p = rig.parcels.find(parcel => parcel.id === "p1");
  sizeIs(box.root.getObjectByName("parcel_body"), [p.width, p.depth, p.height]);
  near(tableBox(box.root.getObjectByName("parcel_body")).min.z, 0);
  const { root } = await fitted("sweeper"), { can, servo, stick } = models.sweeper;
  sizeIs(root.getObjectByName("metal_can"), [2 * can.radiusMm, 2 * can.radiusMm, can.heightMm]);
  sizeIs(root.getObjectByName("servo_case"), [23, 12, 23]);
  // The stick lies along +x with its 10 mm width vertical and 3 mm along the shaft.
  sizeIs(root.getObjectByName("wooden_stick"), [stick.lengthMm, stick.thicknessMm, stick.widthMm]);
  const exactCase = localSize(root.getObjectByName("servo_case")), exactStick = localSize(root.getObjectByName("wooden_stick"));
  near(exactCase.x, 23, 1e-9); near(exactCase.y, 12, 1e-9); near(exactCase.z, 23, 1e-9);
  near(exactStick.x, stick.lengthMm, 1e-9); near(exactStick.y, stick.thicknessMm, 1e-9); near(exactStick.z, stick.widthMm, 1e-9);
  near(tableBox(root.getObjectByName("metal_can")).min.z, 0);
  const shaft = fromThree(root.getObjectByName("servo_output").getWorldPosition(new THREE.Vector3()).toArray());
  near(shaft.z, can.heightMm - 4); assert.deepEqual(servo.axisZup, [0, 1, 0]);
  // The case sits outside the can wall, not inside it.
  const caseBox = tableBox(root.getObjectByName("servo_case"));
  const nearestX = Math.max(caseBox.min.x, 0), nearestY = Math.max(caseBox.min.y, Math.min(0, caseBox.max.y));
  assert.ok(Math.hypot(nearestX, nearestY) >= can.radiusMm, "servo case intersects the can");
  // The stick hangs on the horn by one end: 5 mm of stick behind the shaft.
  near(tableBox(root.getObjectByName("wooden_stick")).min.x, shaft.x - stick.pivotFromEndMm);
});

test("the tilt pivot is the can's bottom edge facing the boxes, within -35..35 degrees", async () => {
  const { root, joints, metadata } = await fitted("sweeper");
  assert.deepEqual(metadata.joints.tilt.limitsDeg, [-35, 35]);
  const can = root.getObjectByName("metal_can"), edge = new THREE.Vector3(...toThree({ x: 33, y: 0, z: 0 }));
  const before = can.worldToLocal(edge.clone());
  applyJoint(joints.tilt, 20); root.updateMatrixWorld(true);
  near(can.localToWorld(before.clone()).distanceTo(edge), 0);
  const top = fromThree(can.localToWorld(new THREE.Vector3(0, 0.0575, 0)).toArray());
  assert.ok(top.x > 1, "positive tilt tips the can towards the boxes (+x)");
  assert.equal(applyJoint(joints.tilt, 90), 35);
});

test("stacked boxes rest exactly on the bench and on each other", async () => {
  const { boxes, state, sweeper } = await buildScene();
  const bodies = boxes.map(box => tableBox(box.root.getObjectByName("parcel_body")));
  near(bodies[0].min.z, rig.table.height);
  for (let i = 1; i < bodies.length; i++) near(bodies[i].min.z, bodies[i - 1].max.z);
  near(bodies[2].max.z, rig.table.height + 3 * 25);
  for (const body of bodies) { near((body.min.x + body.max.x) / 2, rig.zones.pick.x); near((body.min.y + body.max.y) / 2, rig.zones.pick.y); }
  near(tableBox(sweeper.root.getObjectByName("metal_can")).min.z, rig.table.height);
  const can = state.list().find(item => item.type === "sweeper").position;
  near(Math.hypot(rig.zones.pick.x - can.x, rig.zones.pick.y - can.y), 160);
  near(can.x, 70); near(rig.table.depth - can.y, 80);
});

test("manifest collision primitives and joints match config", async () => {
  for (const key of ["box", "sweeper"]) {
    const { metadata } = await fitted(key), entry = manifest.models[key];
    assert.deepEqual(entry.dimensionsMm, metadata.dimensionsMm);
    assert.deepEqual(entry.collision, metadata.collision);
    assert.equal(entry.massG, metadata.massG); assert.equal(entry.measured, false);
  }
  for (const joint of ["tilt", "servo"]) for (const field of ["pivotMm", "axisZup", "limitsDeg"])
    assert.deepEqual(manifest.models.sweeper.joints[joint][field], (await fitted("sweeper")).metadata.joints[joint][field]);
});

test("stick tip reach to the top box over every tilt and servo angle", async () => {
  const { sweeper, boxes } = await buildScene();
  const { root, joints } = sweeper, stick = root.getObjectByName("wooden_stick"), canMesh = root.getObjectByName("metal_can");
  const boxBounds = boxes.map(box => new THREE.Box3().setFromObject(box.root.getObjectByName("parcel_body")));
  const top = boxBounds.at(-1);
  stick.geometry.computeBoundingBox(); canMesh.geometry.computeBoundingBox();
  const g = stick.geometry.boundingBox, tipFace = [];              // far end of the stick from the horn
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 3; j++)
    tipFace.push(new THREE.Vector3(g.max.x, g.min.y + (g.max.y - g.min.y) * j / 3, g.min.z + (g.max.z - g.min.z) * i / 10));
  const point = new THREE.Vector3();
  function evaluate(tilt, servo) {
    applyJoint(joints.tilt, tilt); applyJoint(joints.servo, servo); root.updateMatrixWorld(true);
    const stickBox = new OBB().fromBox3(g).applyMatrix4(stick.matrixWorld);
    // No part of the stick may pass through any box or the can (can as its bounding box).
    if (boxBounds.some(box => stickBox.intersectsBox3(box))) return null;
    if (stickBox.intersectsOBB(new OBB().fromBox3(canMesh.geometry.boundingBox).applyMatrix4(canMesh.matrixWorld))) return null;
    let best = Infinity, at = null;
    for (const p of tipFace) { point.copy(p).applyMatrix4(stick.matrixWorld); const d = top.distanceToPoint(point); if (d < best) { best = d; at = point.clone(); } }
    return { tilt, servo, distance: best, at };
  }
  const [tMin, tMax] = models.sweeper.assemblyTilt.limitsDeg, [sMin, sMax] = models.sweeper.servo.limitsDeg;
  let results = [];
  for (let t = tMin; t <= tMax; t += 1) for (let s = sMin; s <= sMax; s += 1) { const r = evaluate(t, s); if (r) results.push(r); }
  results.sort((a, b) => a.distance - b.distance);
  let best = results[0];
  for (const seed of results.slice(0, 8)) for (let dt = -1; dt <= 1; dt += 0.02) for (let ds = -1; ds <= 1; ds += 0.02) {
    const t = seed.tilt + dt, s = seed.servo + ds;
    if (t < tMin || t > tMax || s < sMin || s > sMax) continue;
    const r = evaluate(t, s); if (r && r.distance < best.distance) best = r;
  }
  const contact = fromThree(best.at.toArray()), topBox = tableBox(boxes.at(-1).root.getObjectByName("parcel_body"));
  console.log(`REACH: closest stick-tip distance to the top box = ${best.distance.toFixed(3)} mm at tilt ${best.tilt.toFixed(2)}°, servo ${best.servo.toFixed(2)}° ` +
    `(tip at x ${contact.x.toFixed(1)}, y ${contact.y.toFixed(1)}, z ${contact.z.toFixed(1)}; top box x ${topBox.min.x}..${topBox.max.x}, y ${topBox.min.y}..${topBox.max.y}, top z ${topBox.max.z}); ` +
    `no part of the stick inside any box or the can`);
  // Reported honestly either way; the current placeholder geometry is expected to reach.
  assert.ok(best.distance < 0.5, `stick tip cannot reach the top box: closest ${best.distance.toFixed(2)} mm`);
});
