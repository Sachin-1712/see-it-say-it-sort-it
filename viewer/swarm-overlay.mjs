import * as THREE from "three";
import {toThree} from "./frame.mjs";
import {sampleTrack,sequenceAt} from "./plan-replay.mjs";

const YELLOW=0xf5c518;
const pose = (sample, mesh) => {
  mesh.position.fromArray(toThree({x:sample[1],y:sample[2],z:sample[3]}));
  mesh.quaternion.identity();
  for (const [axis, angle] of [[{z:1},sample[6]],[{y:1},sample[5]],[{x:1},sample[4]]])
    mesh.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...toThree(axis)),angle*Math.PI/180));
};
export class SwarmOverlay {
  agents=new Map(); selected=null; visible=true; task=null;
  constructor(scene) { this.scene=scene;this.group=new THREE.Group(); scene.add(this.group); }
  stopSequence(){if(this.preview){this.dispose(this.preview);this.preview=null;}}
  playSequence(results,task){
    this.stopSequence();
    const group=new THREE.Group();this.scene.add(group);
    const meshes=new Map();
    for(const item of task.snapshot.objects.filter(o=>o.type==="box")){
      const d=item.dimensionsMm,mesh=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(d.width,d.height,d.depth)),new THREE.LineBasicMaterial({color:YELLOW}));
      pose([0,item.position.x,item.position.y,item.position.z,item.roll??0,item.pitch??0,item.yaw??0],mesh);
      group.add(mesh);meshes.set(item.instanceId,mesh);
    }
    const d=task.config.models.sweeper.stick;
    const stick=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(d.lengthMm,d.thicknessMm,d.widthMm)),new THREE.LineBasicMaterial({color:YELLOW}));
    group.add(stick);meshes.set("stick",stick);
    this.preview={group,results,meshes,started:performance.now()/1000};
    this.update(this.preview.started);
  }
  syncDryRun(frame) {
    const playback=frame.hardware_playback;
    if(playback?.mode!=='dry_run' || !playback.run_id)return;
    if(['interrupted','failed'].includes(playback.status)){
      if(this.preview?.dryRunId===playback.run_id)this.stopSequence();
      return;
    }
    const result=frame.best?.plan?.results?.[(playback.replay_step??0)-1];
    if(!frame.task || !result || (!playback.running && this.preview?.dryRunId!==playback.run_id))return;
    const key=`${playback.run_id}:${playback.replay_step}`;
    if(this.preview?.dryRunKey!==key){
      this.playSequence([result],frame.task);
      this.preview.dryRunKey=key;this.preview.dryRunId=playback.run_id;
    }
    this.preview.started=performance.now()/1000-playback.replay_elapsed_s;
  }
  clear() { this.stopSequence();for(const agent of this.agents.values()) this.dispose(agent); this.agents.clear(); }
  dispose(agent) { agent.group.removeFromParent(); agent.group.traverse(o=>{if(!o.isSprite)o.geometry?.dispose(); if(o.material){o.material.map?.dispose();o.material.dispose();}}); }
  ingest(frame) {
    const id=frame.task ? `${frame.task.task_id}:${frame.task.scene_version}` : null;
    if(id!==this.task) {this.clear();this.task=id;}
    for(const status of frame.agents ?? []) {
      const agent=this.agents.get(status.id); if(agent){if(!status.alive && !agent.dead){agent.frozenTime=agent.playhead;agent.pending=null;}agent.dead=!status.alive;agent.paused=status.status==="Idle" || status.status==="Disconnected";}
    }
    const live=new Set((frame.agents??[]).filter(a=>a.alive).map(a=>a.id));
    for(const trial of frame.ghosts ?? []) {
      if(!live.has(trial.agent))continue;
      let agent=this.agents.get(trial.agent);
      if(agent && !agent.dead && performance.now()/1000-agent.started < 1.25) {agent.pending=trial;continue;}
      this.install(trial,frame.task);
    }
    this.fixture=frame.task;
  }
  install(trial,task) {
    const old=this.agents.get(trial.agent); if(old) this.dispose(old);
    const group=new THREE.Group();this.group.add(group);
    const index=Number(trial.agent.replace(/\D/g,"")) || 1;
    const color=index%2 ? YELLOW : 0x696969;
    const points=trial.path.map(([x,y,z])=>new THREE.Vector3(...toThree({x,y,z})));
    const geometry=new THREE.BufferGeometry().setFromPoints(points);
    const material=trial.success ? new THREE.LineBasicMaterial({color,transparent:true,opacity:.65}) :
      new THREE.LineDashedMaterial({color,transparent:true,opacity:.4,dashSize:3+index,gapSize:2+index/2});
    const line=new THREE.Line(geometry,material);line.computeLineDistances();group.add(line);
    const item=task.snapshot.objects.find(o=>o.instanceId===trial.parcel), d=item?.dimensionsMm;
    const box=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(d?.width??1,d?.height??1,d?.depth??1)),
      new THREE.LineBasicMaterial({color,transparent:true,opacity:.65}));group.add(box);
    const canvas=document.createElement("canvas");canvas.width=256;canvas.height=64;
    const ctx=canvas.getContext("2d");ctx.fillStyle="#202124";ctx.fillRect(0,0,256,64);ctx.fillStyle=index%2?"#f5c518":"#eee";
    ctx.font="bold 23px system-ui";ctx.fillText(`${trial.agent.toUpperCase()} · #${trial.trial_id.split(":").at(-1)}`,12,40);
    const label=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(canvas),depthTest:false,transparent:true}));
    label.scale.set(39,9.75,1);group.add(label);
    const track=trial.trajectories?.[trial.parcel];
    this.agents.set(trial.agent,{group,box,label,track,trial,started:performance.now()/1000,dead:false,paused:false});
  }
  update(now) {
    this.group.visible=this.visible && !this.preview;
    if(this.preview){
      const preview=this.preview,{index,time:t}=sequenceAt(preview.results,now-preview.started);
      const result=preview.results[index];
      preview.step=index+1;preview.target=result.target?.id;
      for(const [id,mesh] of preview.meshes)mesh.visible=id==='stick'||!preview.target||id===preview.target;
      for(const [id,path] of Object.entries(result.trajectories)){
        const mesh=preview.meshes.get(id);if(!mesh || !path.length)continue;
        pose(sampleTrack(path,t),mesh);
      }
    }
    for(const [id,agent] of [...this.agents]) {
      agent.group.visible=!this.selected || this.selected===id;
      if(agent.pending && now-agent.started>=1.25 && !agent.dead) {this.install(agent.pending,this.fixture);continue;}
      const path=agent.track;if(!path?.length)continue;
      const duration=path.at(-1)[0], historical=agent.dead || agent.paused || this.connected===false;
      agent.group.traverse(object=>{if(object.material){object.userData.baseOpacity??=object.material.opacity;object.material.opacity=historical?.12:object.userData.baseOpacity;object.material.transparent=true;}});
      const t=historical?(agent.frozenTime??duration):(now-agent.started)%(duration+.5);
      agent.playhead=t;
      let i=0;while(i+1<path.length && path[i+1][0]<t)i++;
      const a=path[i],b=path[Math.min(i+1,path.length-1)],f=b===a?0:THREE.MathUtils.clamp((t-a[0])/(b[0]-a[0]),0,1);
      pose(a.map((v,k)=>v+(b[k]-v)*f),agent.box);
      agent.label.position.copy(agent.box.position).add(new THREE.Vector3((Number(id.slice(1))%3)*10,23,0));
    }
  }
}
