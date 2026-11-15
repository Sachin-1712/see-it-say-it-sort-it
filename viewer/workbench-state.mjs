// JSON-ready simulation coordinates: millimetres, Z-up. Placement and retained physics poses.
// Every size and position comes from config (via configure) or from the fitted model's
// metadata. There are no built-in fallbacks: missing config is an error.
const point = (label, value) => {
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) throw new Error(`Workbench config is missing ${label}.`);
  return { x: value.x, y: value.y };
};
// Where the sweeper goes: behind the stack on the same x, the lying can's front end
// sweeperGapToStackMm behind the stack's back face. Returns the can centre (sweeper origin).
export function sweeperPositionFromConfig(rig, models) {
  const pick = rig?.zones?.pick, box = rig?.parcels?.find(p => p.id === models?.boxes?.[0]?.rigParcel);
  const gap = models?.workbench?.sweeperGapToStackMm, can = models?.sweeper?.can;
  if (!pick || !box || !Number.isFinite(gap) || !can) return null;
  return { x: pick.x, y: pick.y + box.depth / 2 + gap + can.heightMm / 2 };
}
export class WorkbenchState {
  #items = []; #listeners = new Set(); #sequence = 0;
  constructor() { this.ready = false; this.configured = false; this.epoch = 0; this.selectedId = null; }
  configure(table, setup) {
    if (!Number.isFinite(table?.height)) throw new Error("Workbench config is missing table.height.");
    if (!Number.isFinite(setup?.otherSpacingMm) || !(setup?.otherSlots >= 1)) throw new Error("Workbench config is missing otherSpacingMm or otherSlots.");
    this.surfaceZ = table.height;
    this.stackPosition = point("stackPositionMm", setup.stackPositionMm);
    this.sweeperPosition = point("sweeperPositionMm", setup.sweeperPositionMm);
    this.otherPosition = point("otherPositionMm", setup.otherPositionMm);
    this.otherSpacing = setup.otherSpacingMm; this.otherSlots = setup.otherSlots;
    this.configured = true;
  }
  list() { return structuredClone(this.#items); }
  count(id) { return this.#items.filter(item => item.inventoryId === id).length; }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  notify() { for (const listener of this.#listeners) listener(this.snapshot()); }
  snapshot() { return { mode: "visual-placement", units: "mm", axes: "Z-up", selectedId: this.selectedId, objects: this.list() }; }
  setReady(ready) { this.ready = ready; this.notify(); }
  add(record, metadata) {
    if (!this.configured) throw new Error("Workbench is not configured from config yet.");
    if (record.type === "sweeper") {
      const existing = this.#items.find(item => item.type === "sweeper");
      if (existing) { this.select(existing.instanceId); return structuredClone(existing); }
    }
    const dimensions = structuredClone(metadata?.dimensionsMm);
    if (![dimensions?.width, dimensions?.depth, dimensions?.height].every(value => Number.isFinite(value) && value > 0)) throw new Error("Model dimensions are missing or invalid.");
    const isBox = record.type === "box", stack = this.#items.filter(item => item.type === "box" &&
      Math.abs(item.position.x - this.stackPosition.x) < 1 && Math.abs(item.position.y - this.stackPosition.y) < 1 && item.baseZ >= this.surfaceZ - 1);
    // Boxes rest exactly on the bench and on each other: base = bench top + heights below.
    const baseZ = isBox ? stack.reduce((top, item) => Math.max(top, item.position.z + item.dimensionsMm.height / 2), this.surfaceZ) : this.surfaceZ;
    const xy = isBox ? this.stackPosition : record.type === "sweeper" ? this.sweeperPosition :
      { x: this.otherPosition.x + (this.#items.filter(item => item.type === "unknown").length % this.otherSlots) * this.otherSpacing, y: this.otherPosition.y };
    const item = { instanceId: `world_${record.type}_${String(++this.#sequence).padStart(4, "0")}`, inventoryId: record.id,
      modelKey: record.modelKey, name: record.name, type: record.type, stackIndex: isBox ? stack.length : null,
      color: record.color ?? null, destination: record.destination ?? null,
      position: { ...xy, z: baseZ + dimensions.height / 2 }, baseZ, dimensionsMm: dimensions,
      collision: structuredClone(metadata.collision), definition: structuredClone(record.definition ?? null),
      massG: metadata.massG ?? null, friction: structuredClone(metadata.friction ?? null),
      approximation: !!metadata.approximation, placeholderMeasurements: !!metadata.placeholderMeasurements, measured: metadata.measured ?? null,
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
  loadSnapshot(snapshot, metadata) {
    this.#items = snapshot.objects.map((item, index) => {
      const model = metadata[item.instanceId];
      return {...structuredClone(item), inventoryId:`demo_${item.instanceId}`, modelKey:item.type,
        name:item.name ?? (item.type === "box" ? "Box" : "Cylindrical Sweeper"),
        stackIndex:item.type === "box" ? index : null, dimensionsMm:structuredClone(item.dimensionsMm ?? model.dimensionsMm),
        tiltDeg:item.tiltDeg ?? 0, servoDeg:item.servoDeg ?? 0,
        jointLimits:{tilt:model.joints?.tilt.limitsDeg ?? null,servo:model.joints?.servo.limitsDeg ?? null}};
    });
    this.selectedId=this.#items.find(item=>item.type === "sweeper")?.instanceId ?? null;
    this.notify();
  }
  applyPhysics(result, sweeperId) {
    if (result.invalid) return;
    for (const item of this.#items) {
      const pose = result.final_poses[item.instanceId];
      if (item.type === "box" && pose) {
        item.position = { x: pose.x, y: pose.y, z: pose.z };
        for (const key of ["baseZ", "roll", "pitch", "yaw"]) item[key] = pose[key];
        item.simulated = true;
      } else if (item.instanceId === sweeperId) {
        item.tiltDeg = result.realized_tilt_deg; item.servoDeg = result.servo_final_deg;
      }
    }
    this.notify();
  }
  clear() { this.epoch++; this.#items = []; this.selectedId = null; this.notify(); }
}
export const workbenchState = new WorkbenchState();
