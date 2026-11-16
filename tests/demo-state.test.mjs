import test from 'node:test';
import assert from 'node:assert/strict';
import {resultLabel,recoveryText,SAVED_LABEL} from '../viewer/demo-state.mjs';
test('previously validated attribution cannot be confused with live discovery',()=>{
 assert.equal(resultLabel({attribution:'previously_validated'}),SAVED_LABEL);
 assert.equal(resultLabel({attribution:'live'}),'VALIDATED IN THIS LIVE RUN');
});
test('recovery waits for actual takeover and trial evidence',()=>{
 const r={dead:'a3',active_before:4,silenced:false};
 assert.match(recoveryText(r),/AGENT A3 TERMINATED.*4 → 3 ACTIVE.*RECOVERY IN PROGRESS/);
 assert.doesNotMatch(recoveryText(r),/TAKES OVER/);
 assert.match(recoveryText({...r,silenced:true}),/UNCONFIRMED/);
 const real={...r,successor:'a2',successor_alive:true,role:'validator',checkpoint_id:'a3:17',recovered_progress:17,recovered_trials:10,new_trials:0};
 assert.match(recoveryText(real),/A2 TAKES OVER A3'S VALIDATION TASK/);
 assert.match(recoveryText(real),/awaiting resumed trials/);
 assert.match(recoveryText({...real,new_trials:2,resumed:true}),/2 new trials.*WORK RESUMED/);
 assert.match(recoveryText({...real,successor_alive:false}),/SUCCESSOR OFFLINE/);
});

test('dry run explains missing scene/plan and works without any hardware calibration',async()=>{
 const {dryRunAvailability}=await import('../viewer/demo-state.mjs');
 assert.equal(dryRunAvailability({task:null}).enabled,false);
 assert.match(dryRunAvailability({task:null}).reason,/Load Three-Box Demo.*Load Saved Plan/);
 const frame={task:{task_id:'scene'},best:{attribution:'previously_validated'},hardware_playback:{running:false,armed:false,connection:'Disconnected'}};
 assert.equal(dryRunAvailability(frame).enabled,true);
 assert.match(dryRunAvailability(frame).reason,/No Arduino calibration or arming required/);
 assert.equal(dryRunAvailability({...frame,best:null}).enabled,false);
 assert.equal(dryRunAvailability(frame,false).enabled,false);
});
