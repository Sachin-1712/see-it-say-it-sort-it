import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as THREE from "three";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import { JSDOM } from "jsdom";

async function harness(t, overrides = {}) {
  const html = await readFile(new URL("../viewer/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/viewer/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window; window.structuredClone = structuredClone;
  const motion = new window.EventTarget(); motion.matches = false; window.matchMedia = () => motion;
  let time = 0, nextFrame = 0; const frames = new Map();
  window.requestAnimationFrame = callback => { const id = ++nextFrame; frames.set(id, callback); return id; };
  window.cancelAnimationFrame = id => frames.delete(id);
  Object.defineProperty(window.performance, "now", { value: () => time });
  const context = dom.getInternalVMContext(), modules = new Map();
  function synthetic(key, exports) {
    const module = new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context, identifier: key });
    modules.set(key, module); return module;
  }
  synthetic("three", { ...THREE, ...overrides.three });
  synthetic("three/addons/math/MeshSurfaceSampler.js", { MeshSurfaceSampler });
  synthetic(new URL("../viewer/assets.mjs", import.meta.url).href, { assetRouter: { instantiate: overrides.instantiate } });
  async function load(url) {
    const key = typeof url === "string" ? url : url.href;
    if (modules.has(key)) return modules.get(key);
    const module = new vm.SourceTextModule(await readFile(new URL(key), "utf8"), { context, identifier: key });
    modules.set(key, module); await module.link((specifier, parent) => load(specifier.startsWith("three") ? specifier : new URL(specifier, parent.identifier)));
    return module;
  }
  async function evaluate(name) { const module = await load(new URL(`../viewer/${name}`, import.meta.url)); if (module.status !== "evaluated") await module.evaluate(); return module.namespace; }
  return { window, document: window.document, evaluate, motion, frames, tick(milliseconds) { time = milliseconds; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)); } };
}
const record = { id: "box", type: "box", name: "Box", modelKey: "box" };
const SETUP = { stackPositionMm: { x: 230, y: 220 }, sweeperPositionMm: { x: 70, y: 220 }, otherPositionMm: { x: 60, y: 60 }, otherSpacingMm: 60, otherSlots: 3 };
function boxInstance() {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(50, 20, 35), new THREE.MeshStandardMaterial()); mesh.position.y = 10; root.add(mesh);
  return { root, metadata: { dimensionsMm: { width: 50, height: 20, depth: 35 }, collision: { shape: "box" } }, joints: {} };
}

test("three rapid placement clicks create three separate roots and clearing a pending load cancels it", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let slow = false;
  const app = await harness(t, { instantiate: async () => { if (slow) await gate; return boxInstance(); } });
  const { Workbench } = await app.evaluate("workbench.mjs");
  const { workbenchState: state } = await app.evaluate("workbench-state.mjs");
  const scene = new THREE.Scene(), canvas = app.document.createElement("canvas");
  const workbench = new Workbench({ scene, camera: new THREE.PerspectiveCamera(), canvas,
    toThree: pose => ({ pos: new THREE.Vector3(pose.x, pose.z, -pose.y) }), onBoundsChanged() {}, table: { height: 40 }, setup: SETUP });
  const place = () => app.document.dispatchEvent(new app.window.CustomEvent("worldplace", { detail: { record } }));
  place(); place(); place(); await workbench.queue;
  assert.equal(workbench.instances.size, 3);
  assert.deepEqual([...workbench.instances.values()].map(instance => instance.root.position.y), [40, 60, 80]);
  assert.equal(new Set([...workbench.instances.values()].map(instance => instance.root)).size, 3);
  slow = true; place(); await Promise.resolve();
  app.document.getElementById("world-clear").click(); release(); await workbench.queue;
  assert.equal(state.list().length, 0); assert.equal(workbench.instances.size, 0); assert.equal(scene.children.length, 0);
});

test("repeated sweeper requests select the existing root instead of loading another", async t => {
  let loads = 0;
  const app = await harness(t, { instantiate: async () => {
    loads++; const instance = boxInstance(); instance.metadata.joints = { tilt: { restDeg: 0, limitsDeg: [-35, 35] }, servo: { restDeg: 0, limitsDeg: [0, 180] } }; return instance;
  } });
  const { Workbench } = await app.evaluate("workbench.mjs");
  const workbench = new Workbench({ scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), canvas: app.document.createElement("canvas"),
    toThree: pose => ({ pos: new THREE.Vector3(pose.x, pose.z, -pose.y) }), onBoundsChanged() {}, table: { height: 40 }, setup: SETUP });
  for (let i = 0; i < 3; i++) app.document.dispatchEvent(new app.window.CustomEvent("worldplace", { detail: { record: { id: "sweeper", name: "Sweeper", type: "sweeper", modelKey: "sweeper" } } }));
  await workbench.queue; assert.equal(loads, 1); assert.equal(workbench.instances.size, 1);
  assert.equal(app.document.getElementById("world-tilt-panel").hidden, false);
});

test("materialization releases temporary resources and reveals the opaque model after 1200 ms", async t => {
  let loads = 0; const textures = [];
  const app = await harness(t, { three: { TextureLoader: class { async loadAsync() { loads++; const texture = new THREE.Texture({ width: 640, height: 480 }); textures.push(texture); return texture; } } } });
  const { Materializer } = await app.evaluate("materialization.mjs");
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1.5, .1, 1000); camera.position.set(80, 60, 100); camera.lookAt(0, 10, 0);
  const root = boxInstance().root; scene.add(root);
  const effect = new Materializer(scene, camera, () => {});
  const finished = effect.play(root, "blob:actual-captured-photo"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 1); assert.equal(root.visible, false); assert.equal(scene.children.length, 3);
  let disposed = false; textures[0].addEventListener("dispose", () => { disposed = true; });
  app.tick(600); assert.equal(root.visible, false); assert.ok(effect.resources);
  app.tick(1200); await finished;
  assert.equal(root.visible, true); assert.equal(scene.children.length, 1); assert.equal(effect.resources, null); assert.equal(disposed, true); assert.equal(app.frames.size, 0);
  assert.equal(root.children[0].material.transparent, false);
});

test("reduced motion avoids particles and pending photo loads can be canceled safely", async t => {
  let release, loads = 0; const gate = new Promise(resolve => { release = resolve; });
  const texture = new THREE.Texture({ width: 640, height: 480 }); let disposed = false; texture.addEventListener("dispose", () => { disposed = true; });
  const app = await harness(t, { three: { TextureLoader: class { async loadAsync() { loads++; await gate; return texture; } } } });
  const { Materializer } = await app.evaluate("materialization.mjs");
  const scene = new THREE.Scene(), root = boxInstance().root; scene.add(root);
  const effect = new Materializer(scene, new THREE.PerspectiveCamera(), () => {});
  app.motion.matches = true; await effect.play(root, "blob:photo"); assert.equal(loads, 0); assert.equal(scene.children.length, 1);
  app.motion.matches = false; const pending = effect.play(root, "blob:photo"); effect.cancel(); release(); await pending;
  assert.equal(root.visible, true); assert.equal(scene.children.length, 1); assert.equal(disposed, true); assert.equal(app.frames.size, 0);
});
