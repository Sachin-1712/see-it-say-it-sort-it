import test from 'node:test';
import assert from 'node:assert/strict';
import {SwarmFrames} from '../viewer/swarm-state.mjs';
const frame=(version,id='task',timestamp=1)=>({protocol:'gekko-swarm-v1',task:{task_id:id,scene_version:version},ghosts:[{agent:'a3',task_id:id,scene_version:version,timestamp}]});
test('agent overlays reject stale scenes and duplicate telemetry',()=>{
 const state=new SwarmFrames(),first=frame(1);
 assert.equal(state.accept(first),true);assert.equal(first.ghosts.length,1);
 const duplicate=frame(1);assert.equal(state.accept(duplicate),true);assert.equal(duplicate.ghosts.length,0);
 assert.equal(state.accept(frame(0)),false);assert.equal(state.accept(frame(1,'wrong-task')),false);
 assert.equal(state.accept(frame(2,'new-task')),true);assert.equal(state.accept(frame(1)),false);
 assert.equal(state.accept({protocol:'fake'}),false);
});
