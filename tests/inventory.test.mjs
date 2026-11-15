import test from "node:test";
import assert from "node:assert/strict";
import { InventoryStore, OBJECT_SLOTS } from "../viewer/inventory-store.mjs";
const photo = (color = "red") => ({ blob: new Blob(["test photo"], { type: "image/jpeg" }), color, source: "camera" });
const definition = { shape: "bottle", dimensionsMm: { width: 40, depth: 40, height: 80 } };
function setup() {
  let sequence = 0; const revoked = [];
  return { revoked, store: new InventoryStore({ red: "left", blue: "right" }, { createObjectURL: () => `blob:${++sequence}`, revokeObjectURL: url => revoked.push(url) }) };
}
test("known identities are reusable types; legacy Box identities map to the same asset", () => {
  const { store } = setup();
  store.save("box_1", photo()); store.save("box_2", photo("blue")); store.save("sweeper_1", photo());
  assert.equal(store.list().length, 2); assert.equal(store.get("box").modelKey, "box");
  assert.equal(store.get("box").destination, "right"); assert.equal(store.get("sweeper").color, null);
  assert.deepEqual(OBJECT_SLOTS.map(slot => slot.id), ["box", "sweeper"]);
});
test("unfamiliar objects retain distinct IDs, photographs, names and approximation metadata", () => {
  const { store } = setup();
  for (let i = 0; i < 12; i++) store.save("other", { ...photo(), name: `Object ${i}`, definition });
  const items = store.list(); assert.equal(items.length, 12); assert.equal(new Set(items.map(item => item.id)).size, 12);
  assert.ok(items.every(item => item.type === "unknown" && item.definition.approximation && item.modelKey.startsWith("procedural:")));
  assert.equal(JSON.stringify(items).includes("blob:"), false);
  const other = store.get(items[1].id);
  store.save(items[0].id, { ...photo(), name: "Replacement", definition: { ...definition, shape: "mug" } });
  assert.equal(store.list().length, 12); assert.deepEqual(store.get(items[1].id), other);
});
test("replacement and removal release only the affected photo URLs", () => {
  const { store, revoked } = setup(); store.save("box", photo()); store.save("sweeper", photo());
  const original = store.getPhoto("box").url, other = store.getPhoto("sweeper").url;
  store.save("box", photo("blue")); assert.deepEqual(revoked, [original]);
  store.remove("box"); assert.equal(store.getPhoto("sweeper").url, other); assert.equal(store.get("box"), null);
  store.dispose(); assert.equal(revoked.length, 3); assert.equal(store.list().length, 0);
});
test("routing edits and snapshots leave other inventory metadata unchanged", () => {
  const { store } = setup(); store.save("box", photo()); store.setColor("box", "green");
  assert.equal(store.get("box").destination, null); store.setColor("box", "blue");
  const snapshot = store.list(); snapshot[0].name = "bad";
  assert.equal(store.get("box").name, "Box"); assert.equal(store.get("box").destination, "right");
});
test("invalid captures and unknown geometry never overwrite a valid photograph", () => {
  const { store } = setup(); store.save("box", photo()); const original = store.getPhoto("box").url;
  assert.throws(() => store.save("box", { ...photo(), blob: null }));
  assert.throws(() => store.save("box", { ...photo(), source: "generated" }));
  assert.throws(() => store.save("other", { ...photo(), name: "Mug", definition: { shape: "box" } }));
  assert.throws(() => store.save("other", { ...photo(), name: "Mug", definition: { ...definition, dimensionsMm: { width: -2, depth: 40, height: 80 } } }));
  assert.equal(store.getPhoto("box").url, original);
});
