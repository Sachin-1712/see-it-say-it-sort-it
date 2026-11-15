import test from "node:test";
import assert from "node:assert/strict";
import { simulate } from "../viewer/world-physics.mjs";
class Socket {
  static current;
  constructor(url) { this.url=url; Socket.current=this; }
  send(value) { this.sent=JSON.parse(value); }
  close() { this.closed=true; this.onclose?.(); }
  receive(value) { this.onmessage({data:JSON.stringify(value)}); }
}
test("physics uses its own socket, reports search progress and returns only the completed result", async () => {
  const progress=[], request={cmd:"search",target:"box",snapshot:{objects:[]}};
  const pending=simulate(request,{WebSocketImpl:Socket,onProgress:n=>progress.push(n)}), socket=Socket.current;
  assert.equal(socket.url,"ws://localhost:8766"); socket.onopen(); assert.deepEqual(socket.sent,request);
  socket.receive({type:"candidate",attempt:1,result:{success:false}});
  socket.receive({type:"search_done",best:{result:{success:true}}});
  assert.deepEqual(await pending,{success:true}); assert.deepEqual(progress,[1]); assert.equal(socket.closed,true);
});
test("service errors and disconnects fail without returning invented motion", async () => {
  const pending=simulate({cmd:"preview"},{WebSocketImpl:Socket});
  Socket.current.receive({type:"error",reason:"unsupported physics object"});
  await assert.rejects(pending,/unsupported physics object/);
  const disconnected=simulate({cmd:"preview"},{WebSocketImpl:Socket}); Socket.current.onclose();
  await assert.rejects(disconnected,/disconnected/);
});
test("cancelling a pending physics request closes the socket and ignores late results", async () => {
  const controller=new AbortController(), pending=simulate({cmd:"search"},{WebSocketImpl:Socket,signal:controller.signal});
  const socket=Socket.current; controller.abort();
  await assert.rejects(pending,/cancelled/); assert.equal(socket.closed,true);
  socket.receive({type:"search_done",best:{result:{success:true}}});
});
