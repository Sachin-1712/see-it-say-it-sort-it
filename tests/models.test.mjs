import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import validator from "gltf-validator";
import { ModelLibrary, applyJoint, ASSET_TO_VIEWER_SCALE } from "../viewer/model-assets.mjs";
import { OBJECT_SLOTS } from "../viewer/inventory-store.mjs";

const directory = new URL("../assets/models/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
const modelConfig = JSON.parse(await readFile(new URL("../config/models.json", import.meta.url), "utf8"));
const rig = JSON.parse(await readFile(new URL("../config/rig.json", import.meta.url), "utf8"));
const parse = async name => {
  const data = await readFile(new URL(name, directory));
  return new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), "");
};
const makeLibrary = (loader = { loadAsync: url => parse(url.split("/").at(-1)) }) => new ModelLibrary(loader, {
  manifestUrl: "http://localhost/assets/models/manifest.json",
  fetchImpl: async () => ({ ok: true, json: async () => manifest }),
});
const near = (a, b, tolerance = 0.0001) => assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`);
const world = node => { node.updateWorldMatrix(true, false); return node.getWorldPosition(new THREE.Vector3()); };

for (const [key, metadata] of Object.entries(manifest.models)) {
  test(`${key}.glb validates as glTF 2.0 and loads with Three.js`, async () => {
    const data = await readFile(new URL(metadata.url, directory));
    const report = await validator.validateBytes(new Uint8Array(data));
    assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
    assert.equal(data.toString("ascii", 0, 4), "glTF");
    const asset = await parse(metadata.url);
    assert.ok(asset.scene.getObjectByName(key));
    let meshes = 0, triangles = 0;
    asset.scene.traverse(node => {
      if (!node.isMesh) return; meshes++;
      triangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3;
    });
    assert.ok(meshes >= 1); assert.ok(triangles < 6000, `${triangles} triangles`);
    assert.equal(metadata.placeholderMeasurements, true);
    assert.ok(metadata.collision.shape); assert.ok(metadata.massG > 0);
  });
}

test("each inventory slot maps to a distinct permanent asset", () => {
  assert.deepEqual(OBJECT_SLOTS.map(slot => slot.modelKey), ["box_1", "box_2", "box_3", "sweeper"]);
  for (const slot of OBJECT_SLOTS) assert.ok(manifest.models[slot.modelKey]);
});

test("boxes preserve rig dimensions, metre/Y-up export and bottom-centre origins", async () => {
  for (const [index, key] of ["box_1", "box_2", "box_3"].entries()) {
    const asset = await parse(`${key}.glb`), body = asset.scene.getObjectByName("parcel_body");
    const bounds = new THREE.Box3().setFromObject(body), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
    const dimensions = manifest.models[key].dimensionsMm;
    const expected = index < 2 ? [rig.parcels[index].width, rig.parcels[index].depth, rig.parcels[index].height] : modelConfig.boxes[2].fallbackDimensionsMm;
    assert.deepEqual(Object.values(dimensions), expected);
    near(size.x * 1000, dimensions.width); near(size.y * 1000, dimensions.height); near(size.z * 1000, dimensions.depth);
    near(bounds.min.y, 0); near(center.x, 0); near(center.z, 0);
    const instance = await makeLibrary().instantiate(key);
    const viewerBounds = new THREE.Box3().setFromObject(instance.root.getObjectByName("parcel_body"));
    near(viewerBounds.getSize(new THREE.Vector3()).y, dimensions.height);
    assert.equal(instance.root.scale.x, ASSET_TO_VIEWER_SCALE);
  }
});

test("servo rotates only its output around the configured horizontal shaft; tilt moves the assembly", async () => {
  const instance = await makeLibrary().instantiate("sweeper");
  const { root, joints } = instance;
  const can = root.getObjectByName("metal_can"), stick = root.getObjectByName("wooden_stick");
  const canBefore = world(can).clone(), stickBefore = world(stick).clone(), pivotBefore = world(joints.servo.node).clone();
  const canQuaternion = can.getWorldQuaternion(new THREE.Quaternion()).clone();
  const configured = new THREE.Vector3(...modelConfig.sweeper.servo.axisZup).normalize();
  const expectedAxis = new THREE.Vector3(configured.x, configured.z, -configured.y);
  const actualAxis = joints.servo.axis.clone().applyQuaternion(joints.servo.node.getWorldQuaternion(new THREE.Quaternion()));
  near(actualAxis.distanceTo(expectedAxis), 0);
  assert.ok(Math.abs(actualAxis.y) < 0.01, "default shaft is explicitly horizontal");
  applyJoint(joints.servo, 90);
  assert.ok(world(stick).distanceTo(stickBefore) > 50);
  near(world(can).distanceTo(canBefore), 0);
  near(world(joints.servo.node).distanceTo(pivotBefore), 0);
  near(can.getWorldQuaternion(new THREE.Quaternion()).angleTo(canQuaternion), 0);
  applyJoint(joints.tilt, 25);
  assert.ok(world(can).distanceTo(canBefore) > 1);
  assert.ok(world(joints.servo.node).distanceTo(pivotBefore) > 1);
  // Local servo angle is independent of its parent's manual tilt.
  near(joints.servo.node.quaternion.angleTo(joints.servo.base), Math.PI / 2);
  applyJoint(joints.tilt, 0); applyJoint(joints.servo, 0);
  near(world(stick).distanceTo(stickBefore), 0); near(world(can).distanceTo(canBefore), 0);
});

test("loading is cached while instances and joint transforms remain independent", async () => {
  let calls = 0;
  const library = makeLibrary({ loadAsync: async url => { calls++; return parse(url.split("/").at(-1)); } });
  const [first, second] = await Promise.all([library.instantiate("sweeper"), library.instantiate("sweeper")]);
  assert.equal(calls, 1); assert.notEqual(first.root, second.root);
  applyJoint(first.joints.servo, 60);
  near(second.joints.servo.node.quaternion.angleTo(second.joints.servo.base), 0);
  assert.equal(applyJoint(first.joints.servo, 999), first.joints.servo.limitsDeg[1]);
  assert.throws(() => applyJoint(first.joints.servo, NaN));
});

test("failed model loads are retryable; unknown keys never request geometry", async () => {
  let calls = 0;
  const library = makeLibrary({ loadAsync: async () => { calls++; if (calls === 1) throw new Error("Unavailable"); return parse("box_1.glb"); } });
  await assert.rejects(library.instantiate("box_1"), /Unavailable/);
  const instance = await library.instantiate("box_1"); assert.ok(instance.root); assert.equal(calls, 2);
  await assert.rejects(library.instantiate("invented"), /Unknown/); assert.equal(calls, 2);
});

test("the browser fetch API retains its required global receiver", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = function () {
    assert.equal(this, globalThis);
    return Promise.resolve({ ok: true, json: async () => manifest });
  };
  try {
    const library = new ModelLibrary({ loadAsync: () => parse("box_1.glb") });
    assert.ok((await library.instantiate("box_1")).root);
  } finally { globalThis.fetch = original; }
});
