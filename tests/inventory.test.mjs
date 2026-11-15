import test from "node:test";
import assert from "node:assert/strict";
import { InventoryStore, OBJECT_SLOTS } from "../viewer/inventory-store.mjs";

const photograph = () => new Blob(["test image bytes"], { type: "image/jpeg" });
function setup() {
  let next = 0; const revoked = [];
  const store = new InventoryStore({ red: "left", blue: "right" }, {
    createObjectURL: () => `blob:test-${++next}`, revokeObjectURL: url => revoked.push(url),
  });
  return { store, revoked };
}
const photo = color => ({ blob: photograph(), color, source: "camera" });

test("all four fixed slots have independent records, model keys and photos", () => {
  const { store } = setup();
  for (const slot of OBJECT_SLOTS) store.save(slot.id, photo("blue"));
  assert.equal(store.list().length, 4);
  assert.equal(store.get("box_1").destination, "right");
  const sweeper = store.get("sweeper_1");
  assert.equal(sweeper.modelKey, "sweeper");
  assert.deepEqual(store.list().map(record => record.modelKey), ["box_1", "box_2", "box_3", "sweeper"]);
  assert.equal(sweeper.color, null);
  assert.equal(sweeper.destination, null);
  assert.equal(sweeper.status, "captured");
  assert.ok(Date.parse(sweeper.capturedAt));
  assert.equal(new Set(OBJECT_SLOTS.map(slot => store.getPhoto(slot.id).url)).size, 4);
  assert.doesNotThrow(() => JSON.stringify(store.list()));
  assert.equal(JSON.stringify(store.list()).includes("blob:"), false);
});

test("replacement and removal release URLs without modifying unrelated slots", () => {
  const { store, revoked } = setup();
  store.save("box_1", photo("red")); store.save("box_2", photo("blue"));
  const other = store.get("box_2"), oldURL = store.getPhoto("box_1").url;
  store.save("box_1", { ...photo("blue"), source: "upload" });
  assert.deepEqual(revoked, [oldURL]);
  assert.equal(store.list().length, 2);
  assert.deepEqual(store.get("box_2"), other);
  assert.equal(store.get("box_1").destination, "right");
  store.remove("box_1");
  assert.equal(store.get("box_1"), null); assert.equal(store.getPhoto("box_1"), null);
  assert.deepEqual(store.get("box_2"), other);
  store.dispose(); assert.equal(store.list().length, 0); assert.equal(revoked.length, 3);
});

test("colour edits use only the configured mapping and snapshots cannot mutate records", () => {
  const { store } = setup(); store.save("box_1", photo("red"));
  store.setColor("box_1", "green"); assert.equal(store.get("box_1").destination, null);
  store.setColor("box_1", "blue"); assert.equal(store.get("box_1").destination, "right");
  store.list()[0].color = "red"; store.get("box_1").destination = "left";
  assert.equal(store.get("box_1").color, "blue"); assert.equal(store.get("box_1").destination, "right");
});

test("invalid records cannot replace a valid photograph", () => {
  const { store, revoked } = setup(); store.save("box_1", photo("red"));
  const original = store.getPhoto("box_1").url;
  assert.throws(() => store.save("unknown", photo("red")));
  assert.throws(() => store.save("box_1", { ...photo("red"), blob: null }));
  assert.throws(() => store.save("box_1", { ...photo("red"), blob: new Blob([]) }));
  assert.throws(() => store.save("box_1", photo(null)));
  assert.throws(() => store.save("box_1", { ...photo("red"), source: "generated" }));
  assert.equal(store.getPhoto("box_1").url, original); assert.equal(revoked.length, 0);
});
