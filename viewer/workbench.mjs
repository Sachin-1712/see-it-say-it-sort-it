import * as THREE from "three";
import { assetRouter } from "./assets.mjs";
import { applyJoint } from "./model-assets.mjs";
import { workbenchState as state } from "./workbench-state.mjs";

import { simulate } from "./world-physics.mjs";
import { toThree as framePoint } from "./frame.mjs";

const rotation = (pose, target) => {
  target.identity();
  for (const [axis, angle] of [[{z:1}, pose.yaw], [{y:1}, pose.pitch], [{x:1}, pose.roll]])
    target.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...framePoint(axis)), (angle ?? 0) * Math.PI / 180));
};
const $ = id => document.getElementById(id);
// One scene controller. Observer frames never call add(), clear() or setJoint().
export class Workbench {
  instances = new Map(); queue = Promise.resolve(); busy = false;
  constructor({ scene, camera, canvas, toThree, onBoundsChanged, table, setup, tagColour = null, simulateImpl = simulate }) {
    Object.assign(this, { scene, camera, canvas, toThree, onBoundsChanged, tagColour });
    this.tableHeight = table.height; this.simulate = simulateImpl;
    state.configure(table, setup);
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    document.addEventListener("worldplace", event => {
      const record = structuredClone(event.detail.record), epoch = state.epoch;
      this.queue = this.queue.then(() => this.place(record, epoch)).catch(error => { $("world-message").textContent = `Could not place object: ${error.message}`; });
    });
    state.subscribe(() => this.synchronise());
    $("world-clear").onclick = () => {
      this.abort?.abort(); this.playback = null; this.busy = false;
      state.clear(); this.onBoundsChanged();
      $("world-message").textContent = "Workbench cleared. Your inventory is kept.";
      document.dispatchEvent(new CustomEvent("workbenchclear"));
    };
    $("world-reset-view").onclick = onBoundsChanged;
    $("world-selection").onchange = () => state.select($("world-selection").value);
    $("world-deselect").onclick = () => state.select(null);
    $("world-tilt").oninput = () => {
      const selected = state.list().find(item => item.instanceId === state.selectedId);
      if (this.busy || !selected) return;
      if (selected.servoDeg > 1 && selected.servoDeg < 179) {
        $("world-message").textContent = "Sweep to 0° or 180° before adjusting the manual tilt.";
        this.synchronise(); return;
      }
      state.setJoint(selected.instanceId, "tilt", $("world-tilt").value);
    };
    // Dragging chooses an endpoint. Release runs physics, never a visual-only sweep.
    $("world-servo").oninput = () => { $("world-servo-value").textContent = `${$("world-servo").value}° endpoint`; };
    $("world-servo").onchange = () => this.runPhysics(false, Number($("world-servo").value));
    $("world-physics-run").onclick = () => this.runPhysics(true);
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
  async loadSnapshot(snapshot) {
    this.abort?.abort(); this.playback=null;this.busy=false;state.clear();
    const epoch=state.epoch;
    const loaded=await Promise.all(snapshot.objects.map(async item=>[item,await assetRouter.instantiate({type:item.type,modelKey:item.type})]));
    if(epoch!==state.epoch)return;
    state.loadSnapshot(snapshot,Object.fromEntries(loaded.map(([item,instance])=>[item.instanceId,instance.metadata])));
    for(const [item,instance] of loaded) {
      instance.root.userData.worldInstanceId=item.instanceId;
      instance.root.traverse(node=>{if(node.isMesh)node.castShadow=node.receiveShadow=true;});
      if(item.type === "box"){
        const a=instance.metadata.dimensionsMm,b=item.dimensionsMm;
        instance.root.scale.multiply(new THREE.Vector3(b.width/a.width,b.height/a.height,b.depth/a.depth));
        this.applyBoxPose(instance,item,{...item,...item.position});
      }
      else instance.root.position.fromArray(framePoint({...item.position,z:item.baseZ}));
      instance.currentTilt=item.tiltDeg??0;instance.currentServo=item.servoDeg??0;
      if(instance.joints.tilt)applyJoint(instance.joints.tilt,instance.currentTilt);
      if(instance.joints.servo)applyJoint(instance.joints.servo,instance.currentServo);
      this.instances.set(item.instanceId,instance);this.scene.add(instance.root);
    }
    this.onBoundsChanged();
    $("world-message").textContent="Three-box simulation fixture loaded. Geometry is unmeasured; agent ghosts leave this scene unchanged.";
  }
  async place(record, epoch) {
    if (epoch !== state.epoch || !record) return;
    if (this.busy) { $("world-message").textContent = "Wait for the MuJoCo sweep to finish before placing another object."; return; }
    const existing = record.type === "sweeper" && state.list().find(item => item.type === "sweeper");
    if (existing) { state.select(existing.instanceId); return; }
    const instance = await assetRouter.instantiate(record);
    if (epoch !== state.epoch || this.busy) return; // clear while loading must not repopulate the bench
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
    $("world-count").textContent = `${items.length} ${items.length === 1 ? "object" : "objects"} · MuJoCo sweeps`;
    const selection = $("world-selection");
    selection.replaceChildren(Object.assign(document.createElement("option"), { value: "", textContent: items.length ? "Select a placed object" : "No objects placed" }),
      ...items.map((item, index) => Object.assign(document.createElement("option"), { value: item.instanceId,
        textContent: item.type === "box" ? `${item.name} ${item.stackIndex + 1}` : item.type === "sweeper" ? item.name : `${item.name} ${index + 1}` })));
    selection.value = state.selectedId ?? "";
    const selected = items.find(item => item.instanceId === state.selectedId);
    $("world-tilt-panel").hidden = selected?.type !== "sweeper";
    if (selected?.type === "sweeper") for (const name of ["tilt", "servo"]) {
      const input = $(`world-${name}`); [input.min, input.max] = selected.jointLimits[name];
      input.disabled = this.busy;
      input.value = selected[name === "tilt" ? "tiltDeg" : "servoDeg"];
      $(`world-${name}-value`).textContent = `${input.value}°`;
    }
    $("world-physics-run").disabled = this.busy;
    document.dispatchEvent(new CustomEvent("workbenchchange", { detail: state.snapshot() }));
  }
  async runPhysics(search, endpoint) {
    if (this.busy) return;
    const snapshot = state.snapshot(), epoch = state.epoch;
    const sweeper = snapshot.objects.find(item => item.type === "sweeper");
    const boxes = snapshot.objects.filter(item => item.type === "box" && item.baseZ >= this.tableHeight - 1);
    const target = boxes.sort((a, b) => b.position.z - a.position.z)[0];
    if (!sweeper || !target) {
      $("world-message").textContent = "Place a box and the sweeper on the bench to run a physical sweep.";
      this.synchronise(); return;
    }
    if (search && !target.destination) {
      // A box needs a bag before the search can aim for one (config/rig.json colour_to_bag).
      $("world-message").textContent = `${target.name} is ${target.color ?? "uncoloured"}, which has no bag (red → left, blue → right). ` +
        "Change its routing colour in Inventory, then Clear workbench and place it again.";
      this.synchronise(); return;
    }
    if (!search && Math.abs(endpoint - sweeper.servoDeg) < .01) return;
    this.busy = true; this.abort = new AbortController(); this.synchronise();
    $("world-message").textContent = search ? "MuJoCo: finding a collision-tested sweep…" : "MuJoCo: calculating contacts…";
    try {
      const request = search ? {cmd:"search", snapshot, target:target.instanceId, budget:200} :
        {cmd:"preview", snapshot, action:{target:target.instanceId, tilt_deg:sweeper.tiltDeg,
          sweep_start_deg:sweeper.servoDeg, sweep_end_deg:endpoint, speed_deg_s:280}};
      const result = await this.simulate(request, { signal:this.abort.signal, onProgress: attempt => {
        $("world-message").textContent = `MuJoCo: testing sweep ${attempt}…`;
      }});
      if (epoch !== state.epoch) return;
      if (result.invalid) throw new Error(result.reason);
      if (!result.servo_trajectory?.length) throw new Error("Restart sim.server to load the updated physics protocol.");
      const instance = this.instances.get(sweeper.instanceId);
      instance.currentTilt = result.realized_tilt_deg;
      applyJoint(instance.joints.tilt, instance.currentTilt);
      // Search includes manual setup: the chosen tilt and parked start are applied
      // before playback. All movement after that comes from MuJoCo's solved state.
      this.playback = { result, sweeperId:sweeper.instanceId, epoch, time:0,
        duration:result.servo_trajectory.at(-1)[0] };
      $("world-message").textContent = "Playing MuJoCo contacts in the workbench…";
    } catch (error) {
      if (epoch !== state.epoch) return;
      this.busy = false; this.synchronise(); $("world-message").textContent = error.message;
    }
  }
  applyBoxPose(instance, item, pose) {
    rotation(pose, instance.root.quaternion);
    instance.root.position.fromArray(framePoint(pose)).sub(new THREE.Vector3(0, item.dimensionsMm.height / 2, 0).applyQuaternion(instance.root.quaternion));
  }
  update(dt) {
    if (this.playback) {
      const playback = this.playback;
      playback.time = Math.min(playback.duration, playback.time + dt);
      const sample = path => {
        const i = Math.min(path.length - 1, Math.floor(playback.time / (path[1]?.[0] || 1)));
        const a = path[i], b = path[Math.min(i + 1, path.length - 1)];
        const f = b[0] === a[0] ? 0 : Math.min(1, (playback.time - a[0]) / (b[0] - a[0]));
        return a.map((v, k) => v + (b[k] - v) * f);
      };
      const sweeper = this.instances.get(playback.sweeperId);
      sweeper.currentServo = sample(playback.result.servo_trajectory)[1];
      applyJoint(sweeper.joints.servo, sweeper.currentServo);
      for (const item of this.items) {
        const path = playback.result.trajectories[item.instanceId];
        if (!path?.length) continue;
        const [, x,y,z,roll,pitch,yaw] = sample(path);
        this.applyBoxPose(this.instances.get(item.instanceId), item, {x,y,z,roll,pitch,yaw});
      }
      if (playback.time >= playback.duration) {
        this.playback = null; this.busy = false;
        state.applyPhysics(playback.result, playback.sweeperId);
        for (const item of state.list()) if (item.type === "box") this.applyBoxPose(this.instances.get(item.instanceId), item, {...item, ...item.position});
        $("world-message").textContent = `MuJoCo: ${playback.result.reason ?? `box landed in ${playback.result.target.landed_bag} bag`}. ${playback.result.contacts.filter(c => c.body_a === "stick" || c.body_b === "stick").length} stick contact pairs.`;
        this.onBoundsChanged();
      }
      return;
    }
    // Freeze the assembly while the service solves a request.
    if (this.busy) return;
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
