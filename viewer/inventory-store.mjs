// Inventory records describe captured assets, never observer physical-world items.
export const OBJECT_SLOTS = Object.freeze([
  { id: "box_1", type: "box", name: "Box 1", modelKey: "box_1" },
  { id: "box_2", type: "box", name: "Box 2", modelKey: "box_2" },
  { id: "box_3", type: "box", name: "Box 3", modelKey: "box_3" },
  { id: "sweeper_1", type: "sweeper", name: "Cylindrical Sweeper", modelKey: "sweeper" },
].map(Object.freeze));

export class InventoryStore {
  #records = new Map();
  #photos = new Map();
  constructor(colourToBag = {}, urls = URL) {
    this.colourToBag = { ...colourToBag };
    this.urls = urls;
  }
  list() { return [...this.#records.values()].map(record => ({ ...record })); }
  get(id) { const record = this.#records.get(id); return record ? { ...record } : null; }
  getPhoto(id) { const photo = this.#photos.get(id); return photo ? { ...photo } : null; }
  destination(color) { return this.colourToBag[color] ?? null; }
  save(id, { blob, color = null, source, capturedAt = new Date().toISOString() }) {
    const slot = OBJECT_SLOTS.find(slot => slot.id === id);
    if (!slot) throw new Error("Choose one of the four object slots.");
    if (!(blob instanceof Blob) || !blob.size || !blob.type.startsWith("image/")) throw new Error("A captured photograph is required.");
    if (!["camera", "upload"].includes(source)) throw new Error("A photo source is required.");
    if (slot.type === "box" && !color) throw new Error("Choose a colour for the box.");
    if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("Invalid capture date.");
    color = slot.type === "box" ? color : null;
    const record = { ...slot, color, destination: color ? this.destination(color) : null,
      status: "captured", capturedAt, source };
    const photo = { blob, url: this.urls.createObjectURL(blob) };
    const previous = this.#photos.get(id);
    this.#records.set(id, record);
    this.#photos.set(id, photo);
    if (previous) this.urls.revokeObjectURL(previous.url);
    return { ...record };
  }
  setColor(id, color) {
    const record = this.#records.get(id);
    if (!record || record.type !== "box" || !color) return;
    this.#records.set(id, { ...record, color, destination: this.destination(color) });
  }
  remove(id) {
    const photo = this.#photos.get(id);
    if (photo) this.urls.revokeObjectURL(photo.url);
    this.#photos.delete(id);
    this.#records.delete(id);
  }
  dispose() { for (const id of this.#records.keys()) this.remove(id); }
}
