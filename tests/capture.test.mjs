// DOM integration tests with simulated devices, never used by the application.
// Actual physical webcam checks are a separate manual step in docs/camera-inventory.md.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function setup(t, { getUserMedia, secure = true, decode, toBlob } = {}) {
  const html = await readFile(new URL("../viewer/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost:8080/viewer/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window, document = window.document;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  let nextURL = 0; const urls = new Set(), revoked = [], frames = [], streams = [], requests = [];
  window.Blob = Blob;
  window.structuredClone = structuredClone;
  window.URL.createObjectURL = () => { const url = `blob:photo-${++nextURL}`; urls.add(url); return url; };
  window.URL.revokeObjectURL = url => { urls.delete(url); revoked.push(url); };
  Object.defineProperty(window, "isSecureContext", { value: secure });
  function makeStream() {
    const track = new window.EventTarget(); track.stops = 0;
    track.stop = () => track.stops++;
    track.getSettings = () => ({ deviceId: "camera-1" });
    const stream = { track, getTracks: () => [track], getVideoTracks: () => [track] };
    streams.push(stream); return stream;
  }
  Object.defineProperty(window.navigator, "mediaDevices", { value: {
    getUserMedia: async constraints => { requests.push(constraints); return getUserMedia ? getUserMedia(makeStream) : makeStream(); },
    enumerateDevices: async () => [ { kind: "videoinput", deviceId: "camera-1", label: "Laptop camera" }, { kind: "videoinput", deviceId: "camera-2", label: "USB webcam" } ],
  } });
  const video = document.getElementById("camera-preview");
  Object.defineProperties(video, {
    readyState: { get: () => video.srcObject ? 4 : 0 },
    videoWidth: { get: () => video.srcObject ? 640 : 0 }, videoHeight: { get: () => video.srcObject ? 480 : 0 },
  });
  video.play = async () => {};
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage: (...args) => frames.push(args) });
  window.HTMLCanvasElement.prototype.toBlob = toBlob ?? (callback => callback(new Blob(["test photograph"], { type: "image/jpeg" })));
  window.Image = class { naturalWidth = 1800; naturalHeight = 1200; decode() { return decode ? decode() : Promise.resolve(); } };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event("close")); };
  window.fetch = async () => ({ ok: true, json: async () => ({ colour_to_bag: { red: "left", blue: "right" } }) });
  const context = dom.getInternalVMContext(), modules = new Map();
  async function load(url) {
    const key = url.href;
    if (modules.has(key)) return modules.get(key);
    const module = new vm.SourceTextModule(await readFile(url, "utf8"), { context, identifier: key });
    modules.set(key, module);
    await module.link((specifier, parent) => load(new URL(specifier, parent.identifier)));
    return module;
  }
  const module = await load(new URL("../viewer/inventory.mjs", import.meta.url));
  await module.evaluate();
  const $ = id => document.getElementById(id);
  const previewEvents = [];
  document.addEventListener("inventorypreview", event => previewEvents.push(event.detail.id));
  const click = async id => { $(id).click(); await flush(); };
  const choose = (id, value) => { $(id).value = value; $(id).dispatchEvent(new window.Event("change")); };
  const upload = async (file = new Blob(["uploaded photograph"], { type: "image/png" })) => {
    Object.defineProperty($("photo-file"), "files", { configurable: true, value: [file] });
    $("photo-file").dispatchEvent(new window.Event("change")); await flush();
  };
  return { $, click, choose, upload, document, window, inventory: module.namespace.inventory, streams, requests, frames, urls, revoked, makeStream, previewEvents };
}

test("real API path requests video only, draws the live video frame, confirms and retakes", async t => {
  const app = await setup(t);
  await app.click("capture-object");
  assert.equal(app.requests.length, 1); assert.equal(app.requests[0].audio, false);
  assert.equal(app.$("camera-preview").hidden, false); assert.equal(app.$("take-picture").disabled, false);
  await app.click("take-picture");
  assert.equal(app.frames[0][0], app.$("camera-preview"));
  assert.equal(app.$("capture-photo").hidden, false); assert.ok(app.$("capture-photo").src.startsWith("blob:"));
  assert.ok(app.streams[0].track.stops > 0);
  await app.click("retake-picture");
  assert.equal(app.requests.length, 2); assert.equal(app.$("capture-photo").hidden, true);
  assert.equal(app.$("take-picture").disabled, false);
  await app.click("take-picture"); app.choose("capture-color", "blue");
  await app.click("add-inventory");
  assert.equal(app.inventory.list()[0].id, "box"); assert.equal(app.inventory.list()[0].destination, "right");
  assert.equal(app.$("capture-dialog").open, false);
  assert.equal(app.$("inventory-progress").textContent, "1 object type captured · click to place");
  assert.equal(app.document.querySelectorAll(".inventory-thumb").length, 1);
});

test("one Box, one Sweeper and distinct unfamiliar captures coexist and request previews", async t => {
  const app = await setup(t, { getUserMedia: async () => { throw new DOMException("Denied", "NotAllowedError"); } });
  for (let i = 0; i < 4; i++) {
    await app.click("capture-object");
    if (i >= 2) { app.$("capture-object-name").value = i === 2 ? "Bottle" : "Mug"; app.choose("capture-shape", i === 2 ? "bottle" : "mug"); }
    await app.upload(); await app.click("add-inventory");
  }
  assert.equal(app.inventory.list().length, 4);
  assert.deepEqual(app.previewEvents, ["box", "sweeper", "unknown_001", "unknown_002"]);
  assert.equal(app.inventory.previewId(), "unknown_002");
  assert.deepEqual(Array.from(app.inventory.list(), item => item.modelKey), ["box", "sweeper", "procedural:unknown_001", "procedural:unknown_002"]);
  const otherPhoto = app.inventory.getPhoto("unknown_001").url;
  app.document.querySelector('[data-object-id="box"] [aria-label="Recapture Box"]').click(); await flush();
  assert.equal(app.$("capture-replacement").hidden, false);
  await app.upload(); await app.click("add-inventory");
  assert.equal(app.inventory.list().length, 4); assert.equal(app.inventory.getPhoto("unknown_001").url, otherPhoto);
  const color = app.document.querySelector('[data-object-id="box"] select');
  color.value = "blue"; color.dispatchEvent(new app.window.Event("change"));
  assert.equal(app.inventory.get("box").destination, "right");
  app.document.querySelector('[data-object-id="box"] .remove-photo').click();
  assert.equal(app.inventory.list().length, 3); assert.equal(app.inventory.getPhoto("box"), null);
  await app.click("tab-agents"); assert.equal(app.$("view-agents").hidden, false);
  await app.click("tab-inventory"); assert.equal(app.$("view-inventory").hidden, false);
  assert.equal(app.$("silence").disabled, true);
});

test("denied, missing and busy cameras leave upload fallback usable", async t => {
  for (const name of ["NotAllowedError", "NotFoundError", "NotReadableError"]) {
    const app = await setup(t, { getUserMedia: async () => { throw new DOMException("Camera failure", name); } });
    await app.click("capture-object");
    assert.equal(app.$("camera-message").dataset.error, "true");
    assert.equal(app.$("take-picture").disabled, true); assert.equal(app.$("camera-retry").hidden, false);
    await app.upload(); assert.equal(app.$("capture-source").textContent, "UPLOADED PHOTO");
    await app.click("add-inventory"); assert.equal(app.inventory.list()[0].source, "upload");
  }
});

test("late permission grants after close release every acquired camera track", async t => {
  const permission = deferred();
  const app = await setup(t, { getUserMedia: () => permission.promise });
  await app.click("capture-object"); await app.click("capture-close");
  const acquired = app.makeStream(); permission.resolve(acquired); await flush();
  assert.equal(acquired.track.stops, 1); assert.equal(app.$("camera-preview").srcObject, null);
  assert.equal(app.$("capture-dialog").open, false); assert.equal(app.inventory.list().length, 0);
});

test("an upload supersedes pending permission, and canceled capture never saves", async t => {
  const permission = deferred(); const app = await setup(t, { getUserMedia: () => permission.promise });
  await app.click("capture-object"); await app.upload();
  const acquired = app.makeStream(); permission.resolve(acquired); await flush();
  assert.equal(acquired.track.stops, 1); assert.equal(app.$("capture-source").textContent, "UPLOADED PHOTO");
  await app.click("capture-close"); assert.equal(app.inventory.list().length, 0); assert.equal(app.urls.size, 0);
});

test("camera switching, stream disconnection, Escape, and tab hiding release tracks", async t => {
  const app = await setup(t); await app.click("capture-object");
  app.choose("camera-device", "camera-2"); await flush();
  assert.ok(app.streams[0].track.stops > 0); assert.equal(app.requests[1].video.deviceId.exact, "camera-2");
  app.streams[1].track.dispatchEvent(new app.window.Event("ended"));
  assert.equal(app.$("take-picture").disabled, true); assert.match(app.$("camera-message").textContent, /disconnected/);
  await app.click("camera-retry");
  Object.defineProperty(app.document, "visibilityState", { value: "hidden", configurable: true });
  app.document.dispatchEvent(new app.window.Event("visibilitychange"));
  assert.ok(app.streams[2].track.stops > 0);
  await app.click("camera-retry"); app.$("capture-dialog").dispatchEvent(new app.window.Event("cancel"));
  assert.ok(app.streams[3].track.stops > 0);
});

test("unsupported context and invalid uploads fail safely", async t => {
  const app = await setup(t, { secure: false }); await app.click("capture-object");
  assert.equal(app.requests.length, 0); assert.match(app.$("camera-message").textContent, /localhost/);
  await app.upload(new Blob(["invalid"], { type: "text/plain" }));
  assert.equal(app.$("add-inventory").disabled, true); assert.equal(app.inventory.list().length, 0);
  await app.upload(); await app.click("add-inventory"); assert.equal(app.inventory.list().length, 1);
});

test("a file decode finishing after close cannot restore a canceled photograph", async t => {
  const decoding = deferred(); const app = await setup(t, { decode: () => decoding.promise });
  await app.click("capture-object"); await app.upload(); await app.click("capture-close");
  decoding.resolve(); await flush();
  assert.equal(app.$("capture-photo").hidden, true); assert.equal(app.inventory.list().length, 0); assert.equal(app.urls.size, 0);
});

test("corrupt replacement uploads cannot accidentally confirm an older draft", async t => {
  let failDecode = false;
  const app = await setup(t, { decode: () => failDecode ? Promise.reject(new Error("Corrupt image")) : Promise.resolve() });
  await app.click("capture-object"); await app.upload();
  assert.equal(app.$("add-inventory").disabled, false);
  failDecode = true; await app.upload();
  assert.equal(app.$("add-inventory").disabled, true);
  assert.equal(app.$("capture-photo").hidden, true); assert.equal(app.urls.size, 0);
  assert.match(app.$("camera-message").textContent, /could not be read/);
  failDecode = false; await app.upload(); await app.click("add-inventory");
  assert.equal(app.inventory.list().length, 1);
});

test("a canvas encoding failure leaves a usable live camera and no invented photo", async t => {
  const app = await setup(t, { toBlob: callback => callback(null) });
  await app.click("capture-object"); await app.click("take-picture");
  assert.equal(app.$("add-inventory").disabled, true); assert.equal(app.$("take-picture").disabled, false);
  assert.match(app.$("camera-message").textContent, /could not be saved/);
  assert.equal(app.inventory.list().length, 0);
  await app.click("capture-close"); assert.ok(app.streams[0].track.stops > 0);
});
