// Requests real MuJoCo rollouts; observer/hardware WebSockets are never used here.
export function simulate(request, { onProgress = () => {}, signal, WebSocketImpl = WebSocket } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl("ws://localhost:8766");
    let done = false;
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timeout);
      signal?.removeEventListener("abort", abort); socket.close();
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new Error("Simulation cancelled."));
    const timeout = setTimeout(() => finish(new Error("MuJoCo timed out.")), 60000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    socket.onopen = () => socket.send(JSON.stringify(request));
    socket.onerror = () => finish(new Error("MuJoCo is unavailable. Start .venv312/bin/python -m sim.server."));
    socket.onclose = () => finish(new Error("MuJoCo disconnected before completing the sweep."));
    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "error") finish(new Error(message.reason));
        else if (message.type === "candidate") onProgress(message.attempt);
        else if (message.type === "preview_result") finish(null, message.result);
        else if (message.type === "search_done") message.best
          ? finish(null, message.best.result) : finish(new Error("No feasible sweep found for this placement."));
      } catch (error) { finish(error); }
    };
  });
}
