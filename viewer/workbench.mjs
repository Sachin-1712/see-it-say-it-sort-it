import * as THREE from "three";
import { assetRouter } from "./assets.mjs";
import { applyJoint } from "./model-assets.mjs";
import { workbenchState as state } from "./workbench-state.mjs";

const $ = id => document.getElementById(id);
// One scene controller. Observer frames never call add(), clear() or setJoint().
export class Workbench {
  instances = new Map(); queue = Promise.resolve();
  constructor({ scene, camera, canvas, toThree, onBoundsChanged, table, setup, tagColour = null }) {
    Object.assign(this, { scene, camera, canvas, toThree, onBoundsChanged, tagColour });
    state.configure(table, setup);
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    document.addEventListener("worldplace", event => {
      const record = structuredClone(event.detail.record), epoch = state.epoch;
      this.queue = this.queue.then(() => this.place(record, epoch)).catch(error => { $("world-message").textContent = `Could not place object: ${error.message}`; });
    });
    state.subscribe(() => this.synchronise());
    $("world-clear").onclick = () => {
      state.clear(); this.onBoundsChanged();
      $("world-message").textContent = "Workbench cleared. Your inventory is kept.";
      document.dispatchEvent(new CustomEvent("workbenchclear"));
    };
    $("world-reset-view").onclick = onBoundsChanged;
    $("world-selection").onchange = () => state.select($("world-selection").value);
    $("world-deselect").onclick = () => state.select(null);
    for (const name of ["tilt", "servo"]) $(`world-${name}`).oninput = () => state.setJoint(state.selectedId, name, $(`world-${name}`).value);
    const raycaster = new THREE.Raycaster();
    let pointerStart = null;
    canvas.addEventListener("pointerdown", event => { pointerStart = [event.clientX, event.clientY]; });
    canvas.addEventListener("pointerup", event => {
      if (!pointerStart || Math.hypot(event.clientX - pointerStart[0], event.clientY - pointerStart[1]) > 6) return;
      pointerStart = null;
      const rect = canvas.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
      const hit = raycaster.intersectObjects([...this.instances.values()].map(instance => instance.root), true)[0];
      let object = hit?.object;
      while (object && !object.userData.worldInstanceId) object = object.parent;
      state.select(object?.userData.worldInstanceId ?? null);
    });
    this.synchronise(); state.setReady(true);
  }
  async place(record, epoch) {
    if (epoch !== state.epoch || !record) return;
    const existing = record.type === "sweeper" && state.list().find(item => item.type === "sweeper");
    if (existing) { state.select(existing.instanceId); return; }
    const instance = await assetRouter.instantiate(record);
    if (epoch !== state.epoch) return; // clear while loading must not repopulate the bench
    const item = state.add(record, instance.metadata);
    instance.root.position.copy(this.toThree({ ...item.position, z: item.baseZ }).pos);
    instance.root.userData.worldInstanceId = item.instanceId;
    instance.root.traverse(node => { if (node.isMesh) node.castShadow = node.receiveShadow = true; });
    // The box's tag keeps its routing colour; everything else on the model stays grey.
    const tag = record.type === "box" && item.color && this.tagColour && instance.root.getObjectByName("shipping_label");
    if (tag) { tag.material = tag.material.clone(); tag.material.color.set(this.tagColour(item.color)); }
    instance.currentTilt = item.tiltDeg; instance.currentServo = item.servoDeg;
    this.instances.set(item.instanceId, instance); this.scene.add(instance.root);
    instance.root.updateMatrixWorld(true);
    this.onBoundsChanged();
    $("world-message").textContent = record.type === "box" ? `${state.count(record.id)} boxes stacked. Click Box to add another.` : `${record.name} placed. ${record.type === "sweeper" ? "Select it to adjust the tilt." : "Shape approximation."}`;
  }
  synchronise() {
    const items = state.list(); this.items = items; const ids = new Set(items.map(item => item.instanceId));
    for (const [id, instance] of this.instances) if (!ids.has(id)) { this.scene.remove(instance.root); this.instances.delete(id); }
    $("world-count").textContent = `${items.length} ${items.length === 1 ? "object" : "objects"} · Visual placement`;
    const selection = $("world-selection");
    selection.replaceChildren(Object.assign(document.createElement("option"), { value: "", textContent: items.length ? "Select a placed object" : "No objects placed" }),
      ...items.map((item, index) => Object.assign(document.createElement("option"), { value: item.instanceId,
        textContent: item.type === "box" ? `${item.name} ${item.stackIndex + 1}` : item.type === "sweeper" ? item.name : `${item.name} ${index + 1}` })));
    selection.value = state.selectedId ?? "";
    const selected = items.find(item => item.instanceId === state.selectedId);
    $("world-tilt-panel").hidden = selected?.type !== "sweeper";
    if (selected?.type === "sweeper") for (const name of ["tilt", "servo"]) {
      const input = $(`world-${name}`); [input.min, input.max] = selected.jointLimits[name];
      input.value = selected[name === "tilt" ? "tiltDeg" : "servoDeg"];
      $(`world-${name}-value`).textContent = `${input.value}°`;
    }
    document.dispatchEvent(new CustomEvent("workbenchchange", { detail: state.snapshot() }));
  }
  update(dt) {
    const alpha = this.reducedMotion.matches ? 1 : 1 - Math.exp(-Math.min(dt, .1) / .08);
    for (const item of this.items ?? []) {
      const instance = this.instances.get(item.instanceId); if (!instance?.joints.tilt) continue;
      for (const [joint, actual, target] of [["tilt", "currentTilt", "tiltDeg"], ["servo", "currentServo", "servoDeg"]]) {
        instance[actual] += (item[target] - instance[actual]) * alpha;
        if (Math.abs(item[target] - instance[actual]) < .01) instance[actual] = item[target];
        applyJoint(instance.joints[joint], instance[actual]);
      }
    }
  }
  // Meshes the debug overlay measures, named for the console table.
  debugParts() {
    const parts = [];
    for (const item of this.items ?? []) {
      const root = this.instances.get(item.instanceId)?.root; if (!root) continue;
      // group: parts in the same group are one rigid assembly and are not checked against each other.
      if (item.type === "box") parts.push({ name: `Box ${item.stackIndex + 1}`, object: root.getObjectByName("parcel_body"), group: item.instanceId });
      else if (item.type === "sweeper") for (const [name, node] of [["Can", "metal_can"], ["Servo riser", "servo_mount_bracket"], ["Servo case", "servo_case"], ["Stick", "wooden_stick"]])
        parts.push({ name, object: root.getObjectByName(node), group: item.instanceId });
      else parts.push({ name: item.name, object: root, group: item.instanceId });
    }
    return parts.filter(part => part.object?.visible !== false && part.object);
  }
  bounds() {
    const bounds = new THREE.Box3();
    for (const instance of this.instances.values()) { instance.root.updateMatrixWorld(true); bounds.expandByObject(instance.root); }
    return bounds;
  }
}
