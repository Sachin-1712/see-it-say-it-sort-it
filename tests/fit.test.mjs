// Load-time fitting of the pre-built GLBs to config, placement, manifest sync, and the
// sideways sort: can the stick contact the top box's side face and carry that contact
// point past each bench edge? Uses the real GLBs, the real fitting code, the real joints
// and the real workbench placement rules.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ModelLibrary, applyJoint } from "../viewer/model-assets.mjs";
import { fitToConfig } from "../viewer/model-fit.mjs";
import { WorkbenchState, sweeperPositionFromConfig } from "../viewer/workbench-state.mjs";
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
// World AABB of an object in table-frame mm.
const tableBox = object => {
  object.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(object), a = fromThree(box.min.toArray()), b = fromThree(box.max.toArray());
  return { min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: a.z }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: b.z },
    size: { x: Math.abs(b.x - a.x), y: Math.abs(b.y - a.y), z: b.z - a.z } };
};
// Rotated parts carry ~nm float32 slop in their world AABB, hence 0.1 µm.
const sizeIs = (object, [x, y, z], tolerance = 1e-4) => { const { size } = tableBox(object); near(size.x, x, tolerance); near(size.y, y, tolerance); near(size.z, z, tolerance); };
const tipOf = stick => {
  stick.geometry.computeBoundingBox();
  return fromThree(new THREE.Vector3(stick.geometry.boundingBox.max.x, 0, 0).applyMatrix4(stick.matrixWorld).toArray());
};

async function buildScene() {
  const scene = new THREE.Scene(), state = new WorkbenchState();
  state.configure(rig.table, { ...models.workbench, stackPositionMm: { x: rig.zones.pick.x, y: rig.zones.pick.y },
    sweeperPositionMm: sweeperPositionFromConfig(rig, models) });
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

test("fitted GLB parts match the config sizes, with the can lying along y and the shaft vertical", async () => {
  const box = await fitted("box"), p = rig.parcels.find(parcel => parcel.id === "p1");
  sizeIs(box.root.getObjectByName("parcel_body"), [p.width, p.depth, p.height]);
  near(tableBox(box.root.getObjectByName("parcel_body")).min.z, 0);
  const { root } = await fitted("sweeper"), { can, servo, stick } = models.sweeper;
  sizeIs(root.getObjectByName("metal_can"), [2 * can.radiusMm, can.heightMm, 2 * can.radiusMm]);   // axis along y
  sizeIs(root.getObjectByName("servo_case"), [23, 12, 23]);
  sizeIs(root.getObjectByName("wooden_stick"), [stick.lengthMm, stick.widthMm, stick.thicknessMm]); // flat, along +x at servo 0
  // Rests on its rims; the case sits on the can's top line near the front end; shaft 2 mm above the case.
  near(Math.min(tableBox(root.getObjectByName("bottom_rim")).min.z, tableBox(root.getObjectByName("top_rim")).min.z), 0, 1e-4);
  const caseBox = tableBox(root.getObjectByName("servo_case")), canBox = tableBox(root.getObjectByName("metal_can"));
  near(caseBox.min.z, canBox.max.z, 1e-4);
  assert.ok(caseBox.min.y >= canBox.min.y && caseBox.min.y - canBox.min.y < 10, "servo is near the can's front end");
  const shaft = fromThree(root.getObjectByName("servo_output").getWorldPosition(new THREE.Vector3()).toArray());
  near(shaft.z, caseBox.max.z + 2, 1e-4); assert.deepEqual(servo.axisZup, [0, 0, 1]);
});

test("servo 0/90/180 point right/forward/left; positive tilt about the bottom-back edge lowers the tip", async () => {
  const { root, joints, metadata } = await fitted("sweeper"), stick = root.getObjectByName("wooden_stick");
  assert.deepEqual(metadata.joints.tilt.limitsDeg, [-20, 35]); assert.deepEqual(metadata.joints.servo.limitsDeg, [0, 180]);
  const shaft = () => fromThree(joints.servo.node.getWorldPosition(new THREE.Vector3()).toArray());
  const heading = s => { applyJoint(joints.servo, s); root.updateMatrixWorld(true); const t = tipOf(stick), o = shaft(); return [t.x - o.x, t.y - o.y]; };
  const [rx, ry] = heading(0), [fx, fy] = heading(90), [lx, ly] = heading(180);
  assert.ok(rx > 100 && Math.abs(ry) < 1e-6, "0 deg points right (+x)");
  assert.ok(fy < -100 && Math.abs(fx) < 1e-6, "90 deg points forward (-y)");
  assert.ok(lx < -100 && Math.abs(ly) < 1e-6, "180 deg points left (-x)");
  const can = root.getObjectByName("metal_can"), edge = new THREE.Vector3(...toThree({ x: 0, y: 57.5, z: 0 }));
  const local = can.worldToLocal(edge.clone()), before = tipOf(stick).z;
  applyJoint(joints.tilt, 20); root.updateMatrixWorld(true);
  near(can.localToWorld(local.clone()).distanceTo(edge), 0, 1e-6);
  assert.ok(tipOf(stick).z < before - 10, "positive tilt lowers the tip");
  assert.equal(applyJoint(joints.tilt, -90), -20);
});

test("the can sits behind the stack on the centreline, on the bench, 15 mm behind it; boxes rest exactly", async () => {
  const { boxes, sweeper } = await buildScene();
  const bodies = boxes.map(box => tableBox(box.root.getObjectByName("parcel_body")));
  near(bodies[0].min.z, rig.table.height);
  for (let i = 1; i < bodies.length; i++) near(bodies[i].min.z, bodies[i - 1].max.z);
  for (const body of bodies) { near((body.min.x + body.max.x) / 2, rig.table.width / 2); near((body.min.y + body.max.y) / 2, rig.zones.pick.y); }
  const can = tableBox(sweeper.root.getObjectByName("metal_can"));
  near((can.min.x + can.max.x) / 2, rig.table.width / 2);
  near(can.min.y - bodies[2].max.y, models.workbench.sweeperGapToStackMm);
  near(Math.min(tableBox(sweeper.root.getObjectByName("bottom_rim")).min.z, tableBox(sweeper.root.getObjectByName("top_rim")).min.z), rig.table.height, 1e-4);
  assert.ok(can.max.y <= rig.table.depth + 1e-6, "can stays on the bench");
  for (const [side, bag] of Object.entries(rig.bags)) {
    const inner = side === "left" ? bag.x + bag.width / 2 : bag.x - bag.width / 2;
    near(inner, side === "left" ? 0 : rig.table.width);                     // bins just below the bench edges
    near(bag.height, rig.table.height);                                       // rims level with the bench top
  }
});

test("manifest collision primitives and joints match config", async () => {
  for (const key of ["box", "sweeper"]) {
    const { metadata } = await fitted(key), entry = manifest.models[key];
    assert.deepEqual(entry.dimensionsMm, metadata.dimensionsMm);
    assert.deepEqual(entry.collision, metadata.collision);
    assert.equal(entry.massG, metadata.massG); assert.equal(entry.measured, false);
  }
  const { metadata } = await fitted("sweeper");
  for (const joint of ["tilt", "servo"]) for (const field of ["pivotMm", "axisZup", "axisGltfLocal", "limitsDeg", "direction"])
    assert.deepEqual(manifest.models.sweeper.joints[joint][field], metadata.joints[joint][field]);
});

// Kinematic check only: the box is assumed to slide straight sideways at its own y and
// height. Rotation, friction and toppling are for the physics simulation.
test("sideways sort: the stick contacts the top box's side face and carries it past both bench edges", async () => {
  const { sweeper, boxes } = await buildScene();
  const { root, joints } = sweeper, stick = root.getObjectByName("wooden_stick");
  const [bottom, middle, top] = boxes.map(box => tableBox(box.root.getObjectByName("parcel_body")));
  stick.geometry.computeBoundingBox();
  const g = stick.geometry.boundingBox, samples = [];
  for (let x = g.min.x; x <= g.max.x + 1e-9; x += 0.002) for (const z of [g.min.z, 0, g.max.z]) for (const y of [g.min.y, g.max.y]) samples.push(new THREE.Vector3(x, y, z));
  const W = rig.table.width, tol = 1;
  const inBand = p => p.y >= top.min.y && p.y <= top.max.y && p.z >= top.min.z && p.z <= top.max.z;
  const strictlyIn = (p, b) => p.x > b.min.x + tol && p.x < b.max.x - tol && p.y > b.min.y + tol && p.y < b.max.y - tol && p.z > b.min.z + tol && p.z < b.max.z - tol;
  const sides = { left: { face: top.max.x, past: p => -p.x }, right: { face: top.min.x, past: p => p.x - W } };
  const perTilt = [];
  const [tMin, tMax] = models.sweeper.assemblyTilt.limitsDeg, [sMin, sMax] = models.sweeper.servo.limitsDeg;
  for (let tilt = tMin; tilt <= tMax; tilt += 0.5) {
    const row = { tilt, left: { contact: null, margin: -Infinity, carry: null, xs: [] }, right: { contact: null, margin: -Infinity, carry: null, xs: [] } };
    for (let servo = sMin; servo <= sMax; servo += 0.5) {
      applyJoint(joints.tilt, tilt); applyJoint(joints.servo, servo); root.updateMatrixWorld(true);
      const pts = samples.map(s => fromThree(s.clone().applyMatrix4(stick.matrixWorld).toArray()));
      if (pts.some(p => strictlyIn(p, middle) || strictlyIn(p, bottom))) continue;   // never through the boxes below
      const insideTop = pts.some(p => strictlyIn(p, top));
      for (const [name, side] of Object.entries(sides)) {
        const r = row[name];
        if (!insideTop && r.contact === null && pts.some(p => inBand(p) && Math.abs(p.x - side.face) <= tol)) r.contact = servo;
        for (const p of pts) if (inBand(p)) { r.xs.push(p.x); const past = side.past(p); if (past > r.margin) { r.margin = past; r.carry = servo; } }
      }
    }
    perTilt.push(row);
  }
  const report = {};
  for (const name of ["left", "right"]) {
    const best = perTilt.filter(row => row[name].contact !== null).sort((a, b) => b[name].margin - a[name].margin)[0];
    assert.ok(best, `no tilt lets the stick touch the top box's ${name === "left" ? "right" : "left"} face`);
    const r = best[name], xs = r.xs.sort((a, b) => a - b);
    // Continuity: every face position from the start to past the edge is reachable at this tilt.
    const from = name === "left" ? -r.margin : sides[name].face, to = name === "left" ? sides[name].face : W + r.margin;
    let gap = 0; const span = xs.filter(x => x >= from - 1e-6 && x <= to + 1e-6);
    for (let i = 1; i < span.length; i++) gap = Math.max(gap, span[i] - span[i - 1]);
    report[name] = { tilt: best.tilt, contactServo: r.contact, carryServo: r.carry, margin: r.margin, largestGap: gap };
  }
  // How far the can goes below the bench top at the sweep tilt (it pivots on its bottom-back edge).
  applyJoint(joints.tilt, report.left.tilt); applyJoint(joints.servo, 90); root.updateMatrixWorld(true);
  let lowest = Infinity; const v = new THREE.Vector3();
  for (const name of ["metal_can", "bottom_rim", "top_rim"]) {
    const mesh = root.getObjectByName(name), pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) lowest = Math.min(lowest, fromThree(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).toArray()).z);
  }
  report.canBelowBenchMm = rig.table.height - lowest;
  for (const name of ["left", "right"]) {
    const r = report[name];
    console.log(`SWEEP ${name.toUpperCase()} (${name === "left" ? "red" : "blue"}): tilt ${r.tilt}°, first contact on the top box's ${name === "left" ? "right" : "left"} face at servo ${r.contactServo}°, ` +
      `contact carried ${r.margin.toFixed(1)} mm past the ${name} bench edge at servo ${r.carryServo}° (largest reach gap ${r.largestGap.toFixed(1)} mm)`);
  }
  console.log(`SWEEP CAN: at tilt ${report.left.tilt}° the can's lowest point is ${report.canBelowBenchMm.toFixed(1)} mm below the bench top`);
  const works = perTilt.filter(row => ["left", "right"].every(n => row[n].contact !== null && row[n].margin > 0));
  if (works.length) {
    const t = works[0].tilt; applyJoint(joints.tilt, t); applyJoint(joints.servo, 90); root.updateMatrixWorld(true);
    let low = Infinity;
    for (const name of ["metal_can", "bottom_rim", "top_rim"]) {
      const mesh = root.getObjectByName(name), pos = mesh.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) low = Math.min(low, fromThree(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).toArray()).z);
    }
    console.log(`SWEEP RANGE: both sides work at tilt ${works.map(r => r.tilt).join(", ")}°; at the smallest, ${t}°, margins are ` +
      `${works[0].left.margin.toFixed(1)} / ${works[0].right.margin.toFixed(1)} mm and the can goes ${(rig.table.height - low).toFixed(1)} mm below the bench top`);
  }
  for (const name of ["left", "right"]) {
    assert.ok(report[name].margin > 0, `${name}: contact point stops ${(-report[name].margin).toFixed(1)} mm short of the bench edge`);
    assert.ok(report[name].largestGap <= 3, `${name}: sweep has a ${report[name].largestGap.toFixed(1)} mm gap in reach`);
  }
});
