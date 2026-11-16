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

test("materialization releases temporary resources and reveals the opaque model at the end of its duration", async t => {
  let loads = 0; const textures = [];
  const app = await harness(t, { three: { TextureLoader: class { async loadAsync() { loads++; const texture = new THREE.Texture({ width: 640, height: 480 }); textures.push(texture); return texture; } } } });
  const { Materializer, MATERIALIZATION_DURATION_MS: duration } = await app.evaluate("materialization.mjs");
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1.5, .1, 1000); camera.position.set(80, 60, 100); camera.lookAt(0, 10, 0);
  const root = boxInstance().root; scene.add(root);
  const effect = new Materializer(scene, camera, () => {});
  const finished = effect.play(root, "blob:actual-captured-photo"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 1); assert.equal(root.visible, false); assert.equal(scene.children.length, 3);
  let disposed = false; textures[0].addEventListener("dispose", () => { disposed = true; });
  app.tick(duration / 2); assert.equal(root.visible, false); assert.ok(effect.resources);
  app.tick(duration); await finished;
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

test("main Sweep release uses MuJoCo tracks for boxes and the actual servo, and persists final rotated poses", async t => {
  const app = await harness(t, { instantiate: async record => {
    const instance = boxInstance(); instance.metadata.massG = 30;
    if (record.type === "sweeper") {
      for (const name of ["tilt", "servo"]) {
        const node = new THREE.Group(); instance.root.add(node);
        instance.joints[name] = {node, base:new THREE.Quaternion(), axis:new THREE.Vector3(0,1,0), limitsDeg:[0,180], restDeg:0, direction:1};
      }
      instance.metadata.joints = {tilt:{restDeg:0,limitsDeg:[0,27]},servo:{restDeg:0,limitsDeg:[0,180]}};
    }
    return instance;
  }});
  const { Workbench } = await app.evaluate("workbench.mjs");
  const { workbenchState: state } = await app.evaluate("workbench-state.mjs");
  let request, resolve;
  const workbench = new Workbench({scene:new THREE.Scene(),camera:new THREE.PerspectiveCamera(),canvas:app.document.createElement("canvas"),
    toThree:p=>({pos:new THREE.Vector3(p.x,p.z,-p.y)}),onBoundsChanged(){},table:{height:40},setup:SETUP,
    simulateImpl: payload => {request=payload; return new Promise(done=>{resolve=done;});}});
  await workbench.place(record,state.epoch);
  await workbench.place({id:"sweeper",type:"sweeper",modelKey:"sweeper",name:"Sweeper"},state.epoch);
  const box=state.list()[0], sweeper=state.list()[1], root=workbench.instances.get(box.instanceId).root;
  const input=app.document.getElementById("world-servo"); input.value=180; input.dispatchEvent(new app.window.Event("input"));
  assert.equal(state.list()[1].servoDeg,0,"dragging must not move a collisionless stick");
  const pending=workbench.runPhysics(false,180);
  assert.equal(request.cmd,"preview"); assert.equal(request.action.sweep_start_deg,0);
  assert.equal(workbench.busy,true);
  const final={x:-50,y:60,z:15,baseZ:5,roll:180,pitch:0,yaw:0};
  resolve({invalid:false,reason:null,target:{landed_bag:"left"},realized_tilt_deg:22,servo_final_deg:170,
    servo_trajectory:[[0,0],[1,170]],trajectories:{[box.instanceId]:[[0,230,220,50,0,0,0],[1,-50,60,15,180,0,0]]},
    final_poses:{[box.instanceId]:final},contacts:[{body_a:"stick",body_b:box.instanceId}]});
  await pending; workbench.update(.5);
  assert.ok(root.position.x < 230 && root.position.x > -50);
  assert.ok(Math.abs(workbench.instances.get(sweeper.instanceId).currentServo-85)<1e-6,"render the solved angle, not the requested 180°");
  workbench.update(.5);
  assert.equal(workbench.busy,false); assert.equal(state.list()[0].position.x,-50);
  assert.equal(state.list()[0].roll,180); assert.equal(state.list()[1].servoDeg,170);
  assert.ok(Math.abs(root.position.y-25)<1e-6,"bottom-origin mesh must rotate about the simulated centre of mass");
  assert.equal(state.add(record,boxInstance().metadata).baseZ,40,"a fallen box cannot support new placements");
});

test("physics errors keep the workbench stationary; clearing cancels stale simulation results", async t => {
  const app=await harness(t,{instantiate:async()=>boxInstance()});
  const {Workbench}=await app.evaluate("workbench.mjs");
  const {workbenchState:state}=await app.evaluate("workbench-state.mjs");
  let reject;
  const workbench=new Workbench({scene:new THREE.Scene(),camera:new THREE.PerspectiveCamera(),canvas:app.document.createElement("canvas"),
    toThree:p=>({pos:new THREE.Vector3(p.x,p.z,-p.y)}),onBoundsChanged(){},table:{height:40},setup:SETUP,
    simulateImpl:()=>new Promise((_,no)=>{reject=no;})});
  await workbench.place(record,state.epoch);
  state.add({id:"s",type:"sweeper",name:"Sweeper"},{...boxInstance().metadata,joints:{tilt:{restDeg:0,limitsDeg:[0,27]},servo:{restDeg:0,limitsDeg:[0,180]}}});
  const before=state.snapshot(), pending=workbench.runPhysics(false,180);
  reject(new Error("Service unavailable")); await pending;
  assert.deepEqual(state.snapshot(),before); assert.equal(workbench.busy,false);
  assert.match(app.document.getElementById("world-message").textContent,/Service unavailable/);
  const stale=workbench.runPhysics(false,180);
  app.document.getElementById("world-clear").click(); reject(new Error("cancelled")); await stale;
  assert.equal(state.list().length,0); assert.equal(workbench.playback,null);
});

test("agent ghost worlds stay independent, isolate A3 and ignore new trials after its death", async t => {
  const app=await harness(t);
  app.window.HTMLCanvasElement.prototype.getContext=()=>({fillRect(){},fillText(){},fillStyle:"",font:""});
  const {SwarmOverlay}=await app.evaluate("swarm-overlay.mjs");
  const scene=new THREE.Scene(),physical=boxInstance().root;scene.add(physical);physical.position.set(22,33,44);
  const overlay=new SwarmOverlay(scene),task={task_id:"test",scene_version:1,snapshot:{objects:[{instanceId:"box",dimensionsMm:{width:50,height:20,depth:35}}]}};
  const agents=[1,2,3,4].map(i=>({id:`a${i}`,alive:true,status:"Running"}));
  const trial=(agent,id=1)=>({agent,parcel:"box",trial_id:`${agent}:1:${id}`,success:true,path:[[0,0,20,0],[100,0,20,0]],trajectories:{box:[[0,0,0,20,0,0,0],[1,100,0,20,0,0,0]]}});
  overlay.ingest({task,agents,ghosts:agents.map(a=>trial(a.id))});overlay.update(.5);
  assert.equal(overlay.agents.size,4);
  assert.deepEqual(physical.position.toArray(),[22,33,44]);
  assert.equal(new Set([...overlay.agents.values()].map(a=>a.group)).size,4);
  assert.ok([...overlay.agents.values()].every(a=>Math.abs(a.box.position.x-50)<1e-6));
  overlay.selected="a3";overlay.update(.6);
  assert.ok([...overlay.agents].every(([id,a])=>a.group.visible===(id==="a3")));
  agents[2].alive=false;agents[2].status="Dead";
  overlay.ingest({task,agents,ghosts:[trial("a3",2)]});overlay.update(.7);
  assert.equal(overlay.agents.get("a3").trial.trial_id,"a3:1:1");
  overlay.clear();assert.equal(overlay.agents.size,0);assert.deepEqual(physical.position.toArray(),[22,33,44]);
});

test('timed dry run animates stored tracks, holds the previous result during countdown and stops',async t=>{
 const app=await harness(t),{SwarmOverlay}=await app.evaluate('swarm-overlay.mjs');
 const scene=new THREE.Scene(),overlay=new SwarmOverlay(scene);
 const task={snapshot:{objects:[{type:'box',instanceId:'box',position:{x:0,y:0,z:10},dimensionsMm:{width:20,depth:20,height:20}}]},config:{models:{sweeper:{stick:{lengthMm:100,widthMm:10,thicknessMm:3}}}}};
 const result={trajectories:{box:[[0,0,0,10,0,0,0],[1,100,0,10,0,0,0]],stick:[[0,0,0,30,0,0,0],[1,10,0,30,0,0,0]]}};
 const frame={task,best:{plan:{results:[result]}},hardware_playback:{mode:'dry_run',status:'dry_run_sweeping',running:true,run_id:'run',replay_step:1,replay_elapsed_s:.5}};
 overlay.syncDryRun(frame);overlay.update(0);
 assert.equal(overlay.preview.meshes.get('box').position.x,50);
 const preview=overlay.preview;
 frame.hardware_playback={...frame.hardware_playback,status:'interval',step:2,replay_elapsed_s:1};
 overlay.syncDryRun(frame);overlay.update(0);
 assert.equal(overlay.preview,preview);assert.equal(preview.meshes.get('box').position.x,100);
 assert.equal(task.snapshot.objects[0].position.x,0,'solid setup is not mutated');
 frame.hardware_playback.status='interrupted';overlay.syncDryRun(frame);
 assert.equal(overlay.preview,null);
});

function savedSortingSequence(){
 const objects=[0,1,2].map(index=>({type:'box',instanceId:`box${index}`,name:`Box ${['C','B','A'][index]}`,color:index===1?'blue':'red',position:{x:100,y:100,z:50+20*index},baseZ:40+20*index,dimensionsMm:{width:50,depth:35,height:20}}));
 objects.push({type:'sweeper',instanceId:'sweeper',position:{x:100,y:240,z:40},baseZ:40,tiltDeg:0,servoDeg:0});
 const task={task_id:'saved',scene_version:1,snapshot:{objects},goals:{box0:'left',box1:'right',box2:'left'},config:{models:{sweeper:{stick:{lengthMm:100,widthMm:10,thicknessMm:3}}}}};
 const poses=Object.fromEntries(objects.filter(o=>o.type==='box').map(o=>[o.instanceId,[0,o.position.x,o.position.y,o.position.z,0,0,0]]));
 const actions=['box2','box1','box0'].map((target,index)=>({target,tilt_deg:5+index*5,direction:index===1?'right':'left'}));
 const results=actions.map((action,index)=>{
  const trajectories=Object.fromEntries(Object.entries(poses).map(([id,p])=>[id,[[...p],[1,...p.slice(1)]]]));
  const end=[1,index===1?300:-100,100,10,0,0,0];
  trajectories[action.target][1]=end;poses[action.target]=[0,...end.slice(1)];
  trajectories.stick=[[0,100,170,70,0,0,0],[1,100,170,70,0,0,180]];
  return {engine_ran:true,target:{id:action.target},realized_tilt_deg:action.tilt_deg,servo_trajectory:[[0,index===1?180:0],[1,index===1?0:180]],trajectories};
 });
 return {task,plan:{id:'validated',actions,results}};
}

test('saved preview highlights only top, middle, then bottom by saved target ID',async t=>{
 const app=await harness(t),{SwarmOverlay}=await app.evaluate('swarm-overlay.mjs');
 const overlay=new SwarmOverlay(new THREE.Scene()),{task,plan}=savedSortingSequence(),before=structuredClone(task);
 overlay.playSequence(plan.results,task);const start=overlay.preview.started;
 const visible=()=>[...overlay.preview.meshes].filter(([id,mesh])=>id!=='stick'&&mesh.visible).map(([id])=>id);
 assert.deepEqual(visible(),['box2']);assert.equal(overlay.preview.meshes.get('box2').position.y,90);
 overlay.update(start+.5);assert.equal(overlay.preview.meshes.get('box2').position.x,0);
 overlay.update(start+1);assert.deepEqual(visible(),['box1']);
 overlay.update(start+2);assert.deepEqual(visible(),['box0']);
 overlay.update(start+20);assert.deepEqual(visible(),['box0']);
 assert.deepEqual(task,before,'preview never changes the scenario');
});

test('saved sorting moves solid models with recorded joints, retains final poses and restores on End preview',async t=>{
 const app=await harness(t,{instantiate:async record=>{
  const instance=boxInstance();
  if(record.type==='sweeper'){
   for(const name of ['tilt','servo']){
    const node=new THREE.Group();instance.root.add(node);
    instance.joints[name]={node,base:new THREE.Quaternion(),axis:new THREE.Vector3(0,1,0),limitsDeg:[0,180],restDeg:0,direction:1};
   }
   instance.metadata.joints={tilt:{restDeg:0,limitsDeg:[0,27]},servo:{restDeg:0,limitsDeg:[0,180]}};
  }
  return instance;
 }});
 const {Workbench}=await app.evaluate('workbench.mjs'),{workbenchState:state}=await app.evaluate('workbench-state.mjs');
 const workbench=new Workbench({scene:new THREE.Scene(),camera:new THREE.PerspectiveCamera(),canvas:app.document.createElement('canvas'),toThree:p=>({pos:new THREE.Vector3(p.x,p.z,-p.y)}),onBoundsChanged(){},table:{height:40},setup:SETUP,simulateImpl:()=>assert.fail('saved playback must not rerun physics')});
 const {task,plan}=savedSortingSequence();await workbench.loadSnapshot(task.snapshot);
 const before=state.snapshot(),top=workbench.instances.get('box2').root,middle=workbench.instances.get('box1').root,sweeper=workbench.instances.get('sweeper');
 const initial=top.position.clone();workbench.playSavedPlan(plan,task);workbench.update(.5);
 assert.equal(top.position.x,0);assert.equal(middle.position.x,100);
 assert.equal(sweeper.currentServo,90);assert.equal(sweeper.currentTilt,5);
 assert.ok(Math.abs(sweeper.joints.servo.node.quaternion.angleTo(new THREE.Quaternion()))>1);
 workbench.update(1);assert.equal(top.position.x,-100);assert.equal(middle.position.x,200);
 assert.equal(sweeper.currentTilt,10);assert.equal(workbench.savedPlayback.step,1);
 workbench.update(1.5);assert.equal(workbench.savedPlayback.finished,true);
 assert.equal(workbench.instances.get('box0').root.position.x,-100);assert.equal(middle.position.x,300);
 assert.deepEqual(state.snapshot(),before,'rendered replay cannot invalidate the saved scenario or change evidence');
 workbench.stopSavedPlan();assert.deepEqual(top.position.toArray(),initial.toArray());assert.equal(sweeper.currentServo,0);assert.equal(workbench.busy,false);
 const missing=structuredClone(plan);delete missing.results[0].servo_trajectory;
 assert.throws(()=>workbench.playSavedPlan(missing,task),/tracks are unavailable/);
 workbench.playSavedPlan(plan,task);app.document.getElementById('world-clear').click();workbench.update(20);
 assert.equal(workbench.savedPlayback,null);assert.equal(workbench.instances.size,0);
});
