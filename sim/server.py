"""Loopback-only MuJoCo preview and candidate search over WebSockets."""

import argparse
import asyncio
import json
import re

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from .api import build_scene, rollout
from .search import rank, search_candidates

HOST, PORT = "localhost", 8766
LOCAL_ORIGIN = re.compile(r"https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?")


async def send(ws, message):
    await ws.send(json.dumps(message, allow_nan=False))


async def dispatch(ws, request):
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    cmd = request.get("cmd")
    if cmd not in ("preview", "search"):
        raise ValueError("cmd must be preview or search")
    scene = build_scene(request.get("snapshot"))
    if cmd == "preview":
        if not isinstance(request.get("action"), dict):
            raise ValueError("preview requires an action")
        result = await asyncio.to_thread(rollout, scene, request["action"])
        await send(ws, {"type": "preview_result", "result": result})
        return

    target = request.get("target")
    if not isinstance(target, str) or not any(
        item["instanceId"] == target and item["type"] == "box"
        for item in scene.snapshot["objects"]
    ):
        raise ValueError("search requires the instanceId of a placed box")
    budget = request.get("budget", 200)
    if isinstance(budget, bool) or not isinstance(budget, int) or not 1 <= budget <= 2000:
        raise ValueError("budget must be an integer from 1 to 2000")
    iterator = search_candidates(scene, target, budget)
    best = None
    attempts = 0
    while (candidate := await asyncio.to_thread(next, iterator, None)) is not None:
        action, result = candidate
        attempts += 1
        payload = {"attempt": attempts, "action": action, "result": result}
        if best is None or rank(result) > rank(best["result"]):
            best = payload
        await send(ws, {"type": "candidate", **payload})
        if result["success"]:
            break
    await send(ws, {"type": "search_done", "attempts": attempts, "best": best})


async def handler(ws):
    try:
        async for raw in ws:
            try:
                await dispatch(ws, json.loads(raw))
            except (ValueError, TypeError, KeyError) as exc:
                await send(ws, {"type": "error", "reason": str(exc)})
    except ConnectionClosed:
        pass


async def main(port=PORT):
    async with serve(handler, HOST, port, origins=[LOCAL_ORIGIN, None], max_size=2 * 1024 * 1024):
        print(f"MuJoCo preview on ws://{HOST}:{port}", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    try:
        asyncio.run(main(args.port))
    except KeyboardInterrupt:
        pass
