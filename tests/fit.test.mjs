// Load-time fitting of the pre-built GLBs to config, placement, manifest sync, and the
// sideways sort: can the stick contact the top box's side face and carry that contact
// point past each bench edge? Uses the real GLBs, the real fitting code, the real joints
// and the real workbench placement rules.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBB } from "three/addons/math/OBB.js";
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
  // Rests on its rims; the case sits on a riser on the can's top line near the front end; shaft 2 mm above the case.
  near(Math.min(tableBox(root.getObjectByName("bottom_rim")).min.z, tableBox(root.getObjectByName("top_rim")).min.z), 0, 1e-4);
  const caseBox = tableBox(root.getObjectByName("servo_case")), canBox = tableBox(root.getObjectByName("metal_can"));
  near(tableBox(root.getObjectByName("servo_mount_bracket")).min.z, canBox.max.z, 1e-4);
  near(caseBox.min.z, canBox.max.z + servo.riserMm, 1e-4);
  // At tilt 0 the stick's underside is 10 mm above a 3-box stack.
  near(tableBox(root.getObjectByName("wooden_stick")).min.z, 3 * rig.parcels[0].height + 10, 1e-4);
  assert.ok(caseBox.min.y >= canBox.min.y && caseBox.min.y - canBox.min.y < 10, "servo is near the can's front end");
  const shaft = fromThree(root.getObjectByName("servo_output").getWorldPosition(new THREE.Vector3()).toArray());
  near(shaft.z, caseBox.max.z + 2, 1e-4); assert.deepEqual(servo.axisZup, [0, 0, 1]);
});

test("servo 0/90/180 point right/forward/left; positive tilt about the front-bottom edge lifts the back and lowers the tip", async () => {
  const { root, joints, metadata } = await fitted("sweeper"), stick = root.getObjectByName("wooden_stick");
  assert.deepEqual(metadata.joints.tilt.limitsDeg, models.sweeper.assemblyTilt.limitsDeg); assert.equal(metadata.joints.tilt.limitsDeg[0], 0); assert.deepEqual(metadata.joints.servo.limitsDeg, [0, 180]);
  const shaft = () => fromThree(joints.servo.node.getWorldPosition(new THREE.Vector3()).toArray());
  const heading = s => { applyJoint(joints.servo, s); root.updateMatrixWorld(true); const t = tipOf(stick), o = shaft(); return [t.x - o.x, t.y - o.y]; };
  const [rx, ry] = heading(0), [fx, fy] = heading(90), [lx, ly] = heading(180);
  assert.ok(rx > 100 && Math.abs(ry) < 1e-6, "0 deg points right (+x)");
  assert.ok(fy < -100 && Math.abs(fx) < 1e-6, "90 deg points forward (-y)");
  assert.ok(lx < -100 && Math.abs(ly) < 1e-6, "180 deg points left (-x)");
  const can = root.getObjectByName("metal_can"), front = models.sweeper.assemblyTilt.pivotMm;
  assert.equal(front[1], -models.sweeper.can.heightMm / 2, "pivot is on the front end"); assert.equal(front[2], 0, "pivot is on the bench");
  const edge = new THREE.Vector3(...toThree({ x: front[0], y: front[1], z: front[2] }));
  applyJoint(joints.servo, 90); root.updateMatrixWorld(true);              // stick forward, over the stack
  const local = can.worldToLocal(edge.clone()), back = can.localToWorld(new THREE.Vector3(0, 0, 0)).clone(), before = tipOf(stick).z;
  applyJoint(joints.tilt, 20); root.updateMatrixWorld(true);
  near(can.localToWorld(local.clone()).distanceTo(edge), 0, 1e-6);
  assert.ok(fromThree(can.localToWorld(new THREE.Vector3(0, 0, 0)).toArray()).z > fromThree(back.toArray()).z + 10, "positive tilt lifts the back");
  assert.ok(tipOf(stick).z < before - 10, "positive tilt lowers the tip");
  assert.equal(applyJoint(joints.tilt, -90), 0);
});

test("the can sits behind the stack on the centreline, on the bench, at the configured gap; boxes rest exactly", async () => {
  const { boxes, sweeper } = await buildScene();
  const bodies = boxes.map(box => tableBox(box.root.getObjectByName("parcel_body")));
  near(bodies[0].min.z, rig.table.height);
  for (let i = 1; i < bodies.length; i++) near(bodies[i].min.z, bodies[i - 1].max.z);
  for (const body of bodies) { near((body.min.x + body.max.x) / 2, rig.table.width / 2); near((body.min.y + body.max.y) / 2, rig.zones.pick.y); }
  const can = tableBox(sweeper.root.getObjectByName("metal_can"));
  near((can.min.x + can.max.x) / 2, rig.table.width / 2);
  near(can.min.y - bodies[2].max.y, models.workbench.sweeperGapToStackMm);
  near(Math.min(tableBox(sweeper.root.getObjectByName("bottom_rim")).min.z, tableBox(sweeper.root.getObjectByName("top_rim")).min.z), rig.table.height, 1e-4);
  assert.ok(can.max.y - rig.table.depth <= 10 + 1e-6, `can overhangs the back edge by ${(can.max.y - rig.table.depth).toFixed(1)} mm`);
  assert.ok(can.min.y < rig.table.depth, "can's front end is on the bench");
  for (const [side, bag] of Object.entries(rig.bags)) {
    const inner = side === "left" ? bag.x + bag.width / 2 : bag.x - bag.width / 2;
    near(inner, side === "left" ? 0 : rig.table.width);                     // bins just below the bench edges
    near(bag.height, rig.table.height);                                       // rims level with the bench top
  }
});

// Zero penetration over the whole tilt range: no part of the can, riser, servo or stick ever
// goes below the bench top (stick at every servo angle too), and the can, riser and servo
// never enter a box. The stick entering a box depends on the servo angle; the viewer's
// debug mode outlines those poses in red.
test("no tilt within limits puts the can, servo or stick into the bench, or the can or servo into a box", async () => {
  const { sweeper, boxes } = await buildScene(), { root, joints } = sweeper, v = new THREE.Vector3();
  const boxBounds = boxes.map(box => new THREE.Box3().setFromObject(box.root.getObjectByName("parcel_body")).expandByScalar(-0.5));
  const lowest = names => {
    let z = Infinity;
    for (const name of names) {
      const mesh = root.getObjectByName(name), pos = mesh.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) z = Math.min(z, fromThree(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).toArray()).z);
    }
    return z;
  };
  const body = ["metal_can", "bottom_rim", "top_rim", "servo_mount_bracket", "servo_case"];
  const [tMin, tMax] = models.sweeper.assemblyTilt.limitsDeg;
  let stickLow = Infinity, stickLowAt = null;
  for (let tilt = tMin; tilt <= tMax + 1e-9; tilt += 0.5) {
    applyJoint(joints.tilt, tilt); applyJoint(joints.servo, 90); root.updateMatrixWorld(true);
    assert.ok(lowest(body) >= rig.table.height - 1e-6, `can or servo below the bench top at tilt ${tilt}`);
    for (const name of body) {
      const mesh = root.getObjectByName(name); mesh.geometry.computeBoundingBox();
      const obb = new OBB().fromBox3(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      assert.ok(!boxBounds.some(b => obb.intersectsBox3(b)), `${name} enters a box at tilt ${tilt}`);
    }
    for (let servo = 0; servo <= 180; servo += 2) {
      applyJoint(joints.servo, servo); root.updateMatrixWorld(true);
      const z = lowest(["wooden_stick"]); if (z < stickLow) { stickLow = z; stickLowAt = { tilt, servo }; }
    }
  }
  console.log(`CLEARANCE: lowest stick point ${(stickLow - rig.table.height).toFixed(2)} mm above the bench top (tilt ${stickLowAt.tilt}°, servo ${stickLowAt.servo}°)`);
  assert.ok(stickLow >= rig.table.height - 1e-6, `stick goes ${(rig.table.height - stickLow).toFixed(2)} mm below the bench top at tilt ${stickLowAt.tilt}, servo ${stickLowAt.servo}`);
  // The front-bottom edge stays on the bench while the back lifts.
  applyJoint(joints.tilt, tMax); root.updateMatrixWorld(true);
  const can = tableBox(root.getObjectByName("metal_can")), rims = ["bottom_rim", "top_rim"].map(n => tableBox(root.getObjectByName(n)));
  near(Math.min(...rims.map(r => r.min.z)), rig.table.height, 1e-3);
  assert.ok(can.max.z > rig.table.height + 2 * models.sweeper.can.radiusMm + 20, "back of the can is lifted at full tilt");
  applyJoint(joints.tilt, 0); applyJoint(joints.servo, 0); root.updateMatrixWorld(true);
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

// Kinematic check only: the pushed box is assumed to slide straight sideways at its own y
// and height. Rotation, friction and toppling are for the physics simulation.
// Zero penetration: no stick sample (2 mm along the stick, both faces and edges) may be
// below the bench top or more than 1 mm inside any box other than the one being pushed;
// first contact must also be outside the pushed box. "Contact" means within 1 mm of its face.
async function sweepReport() {
  const { sweeper, boxes } = await buildScene();
  const { root, joints } = sweeper, stick = root.getObjectByName("wooden_stick");
  const bodies = boxes.map(box => tableBox(box.root.getObjectByName("parcel_body")));
  stick.geometry.computeBoundingBox();
  const g = stick.geometry.boundingBox, samples = [];
  const xs = []; for (let x = g.min.x; x < g.max.x; x += 0.002) xs.push(x); xs.push(g.max.x);       // always include the tip
  for (const x of xs) for (const z of [g.min.z, 0, g.max.z]) for (const y of [g.min.y, g.max.y]) samples.push(new THREE.Vector3(x, y, z));
  const W = rig.table.width, tol = 1;
  const strictlyIn = (p, b) => p.x > b.min.x + tol && p.x < b.max.x - tol && p.y > b.min.y + tol && p.y < b.max.y - tol && p.z > b.min.z + tol && p.z < b.max.z - tol;
  const [tMin, tMax] = models.sweeper.assemblyTilt.limitsDeg, [sMin, sMax] = models.sweeper.servo.limitsDeg;
  const poses = [];
  for (let tilt = tMin; tilt <= tMax; tilt += 0.5) for (let servo = sMin; servo <= sMax; servo += 0.5) {
    applyJoint(joints.tilt, tilt); applyJoint(joints.servo, servo); root.updateMatrixWorld(true);
    poses.push({ tilt, servo, pts: samples.map(s => fromThree(s.clone().applyMatrix4(stick.matrixWorld).toArray())) });
  }
  const names = ["bottom", "middle", "top"], report = {};
  for (let k = 2; k >= 0; k--) {
    const target = bodies[k], others = bodies.filter((_, i) => i !== k);
    const inBand = p => p.y >= target.min.y && p.y <= target.max.y && p.z >= target.min.z && p.z <= target.max.z;
    const sides = { left: { face: target.max.x, past: p => -p.x }, right: { face: target.min.x, past: p => p.x - W } };
    const rows = new Map();
    let alignTilt = null, alignBlockedBy = null;
    for (const { tilt, servo, pts } of poses) {
      const touchesFace = pts.some(p => inBand(p) && Math.abs(p.x - sides.left.face) <= tol);
      const blocked = pts.some(p => p.z < rig.table.height - 1e-9) ? "the bench" :
        others.map((b, i) => pts.some(p => strictlyIn(p, b)) ? names[bodies.indexOf(b)] + " box" : null).find(Boolean);
      if (touchesFace && alignTilt === null) { alignTilt = tilt; alignBlockedBy = blocked ?? (pts.some(p => strictlyIn(p, target)) ? `${names[k]} box itself` : null); }
      if (blocked) continue;
      if (!rows.has(tilt)) rows.set(tilt, { left: { contact: null, margin: -Infinity, carry: null, xs: [] }, right: { contact: null, margin: -Infinity, carry: null, xs: [] } });
      const row = rows.get(tilt), insideTarget = pts.some(p => strictlyIn(p, target));
      for (const [name, side] of Object.entries(sides)) {
        const r = row[name];
        if (!insideTarget && r.contact === null && pts.some(p => inBand(p) && Math.abs(p.x - side.face) <= tol)) r.contact = servo;
        for (const p of pts) if (inBand(p)) { r.xs.push(p.x); const past = side.past(p); if (past > r.margin) { r.margin = past; r.carry = servo; } }
      }
    }
    const gapOf = (r, name) => {
      const xs = r.xs.sort((a, b) => a - b), from = name === "left" ? -r.margin : sides[name].face, to = name === "left" ? sides[name].face : W + r.margin;
      let gap = 0; const span = xs.filter(x => x >= from - 1e-6 && x <= to + 1e-6);
      for (let i = 1; i < span.length; i++) gap = Math.max(gap, span[i] - span[i - 1]);
      return gap;
    };
    const working = [...rows.entries()].filter(([, row]) => ["left", "right"].every(n => row[n].contact !== null && row[n].margin > 0 && gapOf(row[n], n) <= 3));
    const best = working.sort((a, b) => Math.min(b[1].left.margin, b[1].right.margin) - Math.min(a[1].left.margin, a[1].right.margin))[0];
    report[names[k]] = { alignTilt, alignBlockedBy, workingTilts: working.map(([t]) => t).sort((a, b) => a - b),
      best: best && { tilt: best[0], left: best[1].left, right: best[1].right } };
  }
  return report;
}

test("sideways sort per box: tilt to line up, servo angles into each bag, margin past the bench edge", async () => {
  const report = await sweepReport();
  for (const name of ["top", "middle", "bottom"]) {
    const r = report[name];
    if (r.best) {
      const t = r.workingTilts;
      console.log(`SWEEP ${name.toUpperCase()}: works for tilt ${t[0]}..${t.at(-1)}°; at ${r.best.tilt}°: ` +
        `red -> left bag: contact on the right face at servo ${r.best.left.contact}°, sweep to ${r.best.left.carry}°, ${r.best.left.margin.toFixed(1)} mm past the left edge; ` +
        `blue -> right bag: contact on the left face at servo ${r.best.right.contact}°, sweep to ${r.best.right.carry}°, ${r.best.right.margin.toFixed(1)} mm past the right edge`);
    } else {
      console.log(`SWEEP ${name.toUpperCase()}: NOT REACHABLE without penetration. ` +
        (r.alignTilt === null ? "No tilt within limits brings the stick to this box's side face at all." :
          `The stick first reaches its side face at tilt ${r.alignTilt}°, but every such pose passes through ${r.alignBlockedBy ?? "an obstacle"}.`));
    }
  }
  // The top box must stay sortable both ways; middle and bottom are reported as found.
  assert.ok(report.top.best, "the top box can no longer be swept into both bags");
  assert.ok(report.top.best.left.margin >= 10 && report.top.best.right.margin >= 10, "top box must clear both edges by at least 10 mm");
});
