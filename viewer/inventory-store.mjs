// Acquired asset types. Placed instances belong to WorkbenchState, never this store.
export const OBJECT_SLOTS = Object.freeze([
  Object.freeze({ id: "box", type: "box", name: "Box", modelKey: "box" }),
  Object.freeze({ id: "sweeper", type: "sweeper", name: "Cylindrical Sweeper", modelKey: "sweeper" }),
]);
export const PRIMITIVE_SHAPES = Object.freeze(["cuboid", "cylinder", "bottle", "mug"]);
const aliases = { box_1: "box", box_2: "box", box_3: "box", sweeper_1: "sweeper", cylindrical_sweeper: "sweeper" };
export const canonicalIdentity = id => aliases[id] ?? id;
export function validateApproximation(input = {}) {
  if (!PRIMITIVE_SHAPES.includes(input.shape)) throw new Error("Choose an approximate shape.");
  const dimensionsMm = Object.fromEntries(["width", "depth", "height"].map(key => {
    const value = Number(input.dimensionsMm?.[key]);
    if (!Number.isFinite(value) || value < 1 || value > 2000) throw new Error("Dimensions must be between 1 and 2000 mm.");
    return [key, value];
  }));
  return { shape: input.shape, dimensionsMm, approximation: true };
}
export class InventoryStore {
  #records = new Map(); #photos = new Map(); #next = 0;
  constructor(colourToBag = {}, urls = URL) { this.colourToBag = { ...colourToBag }; this.urls = urls; }
  list() { return [...this.#records.values()].map(record => structuredClone(record)); }
  get(id) { const record = this.#records.get(canonicalIdentity(id)); return record ? structuredClone(record) : null; }
  getPhoto(id) { const photo = this.#photos.get(canonicalIdentity(id)); return photo ? { ...photo } : null; }
  destination(color) { return this.colourToBag[color] ?? null; }
  save(identity, { blob, color = null, source, name, definition, capturedAt = new Date().toISOString() }) {
    identity = canonicalIdentity(identity);
    const known = OBJECT_SLOTS.find(slot => slot.id === identity), previousRecord = this.#records.get(identity);
    if (!known && identity !== "other" && previousRecord?.type !== "unknown") throw new Error("Choose Box, Sweeper or Other object.");
    if (!(blob instanceof Blob) || !blob.size || !blob.type.startsWith("image/")) throw new Error("A captured photograph is required.");
    if (!["camera", "upload"].includes(source)) throw new Error("A photo source is required.");
    if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("Invalid capture date.");
    if (known?.type === "box" && !color) throw new Error("Choose a routing colour for the box.");
    let record;
    if (known) {
      color = known.type === "box" ? color : null;
      record = { ...known, color, destination: color ? this.destination(color) : null, generation: "predefined" };
    } else {
      const approximation = validateApproximation(definition);
      if (!name?.trim()) throw new Error("Give this object a name.");
      const id = identity === "other" ? `unknown_${String(++this.#next).padStart(3, "0")}` : identity;
      record = { id, type: "unknown", name: name.trim().slice(0, 80), modelKey: `procedural:${id}`,
        color: null, destination: null, generation: "primitive-approximation", definition: approximation };
    }
    record = { ...record, status: "captured", capturedAt, source };
    const photo = { blob, url: this.urls.createObjectURL(blob) }, previous = this.#photos.get(record.id);
    this.#records.set(record.id, record); this.#photos.set(record.id, photo);
    if (previous) this.urls.revokeObjectURL(previous.url);
    return structuredClone(record);
  }
  setColor(id, color) {
    id = canonicalIdentity(id);
    const record = this.#records.get(id);
    if (record?.type === "box" && color) this.#records.set(id, { ...record, color, destination: this.destination(color) });
  }
  remove(id) {
    id = canonicalIdentity(id);
    const photo = this.#photos.get(id); if (photo) this.urls.revokeObjectURL(photo.url);
    this.#photos.delete(id); this.#records.delete(id);
  }
  dispose() { for (const id of this.#records.keys()) this.remove(id); }
}
