import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import { WorkbenchState } from "../viewer/workbench-state.mjs";
import { AssetRouter } from "../viewer/asset-router.mjs";
import { createPrimitiveModel } from "../viewer/primitive-models.mjs";
import { sampleModelSurface } from "../viewer/surface-points.mjs";
import { readFileSync } from "node:fs";
const rig = JSON.parse(readFileSync(new URL("../config/rig.json", import.meta.url), "utf8"));
const models = JSON.parse(readFileSync(new URL("../config/models.json", import.meta.url), "utf8"));
const setup = { ...models.workbench, stackPositionMm: { x: rig.zones.pick.x, y: rig.zones.pick.y } };
const configured = () => { const state = new WorkbenchState(); state.configure(rig.table, setup); return state; };
const box = { id: "box", name: "Box", modelKey: "box", type: "box" };
const metadata = { dimensionsMm: { width: 95, depth: 70, height: 25 }, collision: { shape: "box" } };
const sweeperMeta = { ...metadata, joints: { tilt: { restDeg: 0, limitsDeg: [-35, 35] }, servo: { restDeg: 0, limitsDeg: [0, 180] } } };

test("without config the workbench refuses to place; sizes never fall back to built-in values", () => {
  assert.throws(() => new WorkbenchState().add(box, metadata), /not configured/);
  assert.throws(() => new WorkbenchState().configure({ height: 90 }, {}), /missing/);
  assert.throws(() => configured().add(box, { collision: { shape: "box" } }), /dimensions/);
});
test("bench starts empty; three clicks produce independent IDs with exact stacked centre heights", () => {
  const state = configured(); assert.equal(state.list().length, 0);
  const placed = [1, 2, 3].map(() => state.add(box, metadata));
  assert.deepEqual(placed.map(item => item.position.z), [102.5, 127.5, 152.5]);
  assert.deepEqual(placed.map(item => item.baseZ), [90, 115, 140]);
  assert.deepEqual(placed.map(item => item.stackIndex), [0, 1, 2]);
  assert.equal(new Set(placed.map(item => item.instanceId)).size, 3);
  assert.ok(placed.every(item => item.position.x === rig.zones.pick.x && item.position.y === rig.zones.pick.y));
  assert.equal(state.count("box"), 3); assert.equal(state.snapshot().mode, "visual-placement");
});
test("cumulative geometry heights support mixed heights and no three-box cap", () => {
  const state = configured();
  state.add(box, metadata); state.add(box, { ...metadata, dimensionsMm: { ...metadata.dimensionsMm, height: 30 } });
  const third = state.add(box, metadata); assert.equal(third.baseZ, 145); assert.equal(third.position.z, 157.5);
  for (let i = 0; i < 20; i++) state.add(box, metadata);
  assert.equal(state.count("box"), 23);
});
test("sweeper is a singleton and its two setup angles are independent and clamped", () => {
  const state = configured(), record = { id: "sweeper", type: "sweeper", modelKey: "sweeper", name: "Sweeper" };
  const first = state.add(record, sweeperMeta); state.add(record, sweeperMeta);
  assert.equal(state.list().length, 1); state.setJoint(first.instanceId, "servo", 90); state.setJoint(first.instanceId, "tilt", 20);
  assert.equal(state.list()[0].servoDeg, 90); assert.equal(state.list()[0].tiltDeg, 20);
  state.setJoint(first.instanceId, "tilt", 100); assert.equal(state.list()[0].tiltDeg, 35);
});
test("clear increments the placement epoch, retains unique IDs and cannot mutate a prior scene snapshot", () => {
  const state = configured(); const item = state.add(box, metadata), snapshot = state.snapshot(), epoch = state.epoch;
  state.clear(); assert.equal(state.list().length, 0); assert.equal(state.epoch, epoch + 1);
  const next = state.add(box, metadata); assert.notEqual(next.instanceId, item.instanceId); assert.equal(next.baseZ, 90);
  assert.equal(snapshot.objects.length, 1); assert.doesNotThrow(() => JSON.stringify(snapshot));
});
test("placed routing and physical metadata are snapshots independent of later inventory edits", () => {
  const state = configured(), captured = { ...box, color: "red", destination: "left" };
  state.add(captured, { ...metadata, massG: 25, friction: null, placeholderMeasurements: true });
  captured.color = "blue"; captured.destination = "right";
  assert.equal(state.list()[0].color, "red"); assert.equal(state.list()[0].destination, "left");
  assert.equal(state.list()[0].massG, 25); assert.equal(state.list()[0].placeholderMeasurements, true);
});
test("known routing never generates primitives; unknown routing never silently substitutes a Box GLB", async () => {
  let loads = 0, generations = 0;
  const router = new AssetRouter({ instantiate: async () => { loads++; return { root: new THREE.Group(), metadata }; } }, record => { generations++; return createPrimitiveModel(THREE, record); });
  await router.instantiate(box); await router.instantiate({ type: "sweeper" });
  assert.equal(generations, 0); assert.equal(loads, 2);
  const record = { id: "unknown_1", type: "unknown", name: "Bottle", definition: { approximation: true, shape: "bottle", dimensionsMm: { width: 40, depth: 35, height: 90 } } };
  const first = await router.instantiate(record), second = await router.instantiate(record);
  assert.equal(loads, 2); assert.equal(generations, 1); assert.notEqual(first.root, second.root);
  assert.equal(first.root.children[0].geometry, second.root.children[0].geometry);
  first.root.position.x = 100; assert.equal(second.root.position.x, 0);
  assert.equal(first.metadata.approximation, true);
});
test("all unfamiliar primitive types are opaque grey and retain measured envelopes with bottom origins", () => {
  for (const shape of ["cuboid", "cylinder", "bottle", "mug"]) {
    const model = createPrimitiveModel(THREE, { id: "test", name: "Test", definition: { shape, dimensionsMm: { width: 40, depth: 35, height: 90 } } });
    const bounds = new THREE.Box3().setFromObject(model.root), size = bounds.getSize(new THREE.Vector3());
    for (const [actual, expected] of [[size.x, 40], [size.y, 90], [size.z, 35], [bounds.min.y, 0]]) assert.ok(Math.abs(actual - expected) < .001);
    model.root.traverse(node => { if (node.isMesh) { assert.equal(node.material.transparent, false); assert.equal(node.material.color.r, node.material.color.g); assert.equal(node.material.color.g, node.material.color.b); } });
  }
});
test("particle targets lie on the actual transformed model envelope and are bounded in count", () => {
  const root = new THREE.Group(); root.add(new THREE.Mesh(new THREE.BoxGeometry(50, 20, 35), new THREE.MeshBasicMaterial())); root.position.set(10, 30, 20);
  const points = sampleModelSurface(THREE, MeshSurfaceSampler, root, 1800);
  assert.equal(points.length, 5400); const bounds = new THREE.Box3().setFromObject(root).expandByScalar(.001);
  for (let i = 0; i < points.length; i += 3) assert.ok(bounds.containsPoint(new THREE.Vector3().fromArray(points, i)));
});
