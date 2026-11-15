// JSON-ready simulation coordinates: millimetres, Z-up. Visual placement, not physics.
export class WorkbenchState {
  #items = []; #listeners = new Set(); #sequence = 0;
  constructor() { this.ready = false; this.epoch = 0; this.selectedId = null; this.configure({ height: 40 }, {}); }
  configure(table, setup) {
    this.surfaceZ = table.height;
    this.stackPosition = { x: 145, y: 75, ...setup.stackPositionMm };
    this.sweeperPosition = { x: 52, y: 120, ...setup.sweeperPositionMm };
    this.otherPosition = { x: 55, y: 40, ...setup.otherPositionMm };
  }
  list() { return structuredClone(this.#items); }
  count(id) { return this.#items.filter(item => item.inventoryId === id).length; }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  notify() { for (const listener of this.#listeners) listener(this.snapshot()); }
  snapshot() { return { mode: "visual-placement", units: "mm", axes: "Z-up", selectedId: this.selectedId, objects: this.list() }; }
  setReady(ready) { this.ready = ready; this.notify(); }
  add(record, metadata) {
    if (record.type === "sweeper") {
      const existing = this.#items.find(item => item.type === "sweeper");
      if (existing) { this.select(existing.instanceId); return structuredClone(existing); }
    }
    const dimensions = structuredClone(metadata.dimensionsMm ?? { width: 66, depth: 66, height: 125 });
    if (![dimensions.width, dimensions.depth, dimensions.height].every(value => Number.isFinite(value) && value > 0)) throw new Error("Model dimensions are invalid.");
    const isBox = record.type === "box", stack = this.#items.filter(item => item.type === "box");
    const baseZ = isBox ? this.surfaceZ + stack.reduce((height, item) => height + item.dimensionsMm.height, 0) : this.surfaceZ;
    const xy = isBox ? this.stackPosition : record.type === "sweeper" ? this.sweeperPosition :
      { x: this.otherPosition.x + (this.#items.filter(item => item.type === "unknown").length % 3) * 55, y: this.otherPosition.y };
    const item = { instanceId: `world_${record.type}_${String(++this.#sequence).padStart(4, "0")}`, inventoryId: record.id,
      modelKey: record.modelKey, name: record.name, type: record.type, stackIndex: isBox ? stack.length : null,
      color: record.color ?? null, destination: record.destination ?? null,
      position: { ...xy, z: baseZ + dimensions.height / 2 }, baseZ, dimensionsMm: dimensions,
      collision: structuredClone(metadata.collision), definition: structuredClone(record.definition ?? null),
      massG: metadata.massG ?? null, friction: structuredClone(metadata.friction ?? null),
      approximation: !!metadata.approximation, placeholderMeasurements: !!metadata.placeholderMeasurements,
      tiltDeg: metadata.joints?.tilt.restDeg ?? 0, servoDeg: metadata.joints?.servo.restDeg ?? 0,
      jointLimits: { tilt: metadata.joints?.tilt.limitsDeg ?? null, servo: metadata.joints?.servo.limitsDeg ?? null } };
    this.#items.push(item); this.selectedId = item.instanceId; this.notify(); return structuredClone(item);
  }
  select(id) { this.selectedId = this.#items.some(item => item.instanceId === id) ? id : null; this.notify(); }
  setJoint(id, name, degrees) {
    const item = this.#items.find(item => item.instanceId === id), limits = item?.jointLimits[name];
    if (!limits || !Number.isFinite(Number(degrees))) return;
    item[name === "tilt" ? "tiltDeg" : "servoDeg"] = Math.max(limits[0], Math.min(limits[1], Number(degrees)));
    this.notify();
  }
  clear() { this.epoch++; this.#items = []; this.selectedId = null; this.notify(); }
}
export const workbenchState = new WorkbenchState();
