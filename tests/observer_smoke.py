"""Exercise the existing observer protocol on an isolated ephemeral port.

Run from the repo root: .venv/bin/python tests/observer_smoke.py
Does not touch the running demo's state or send commands to hardware.
"""
import asyncio
import contextlib
import importlib.util
import json
from pathlib import Path

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

spec = importlib.util.spec_from_file_location(
    "fake_observer", Path(__file__).resolve().parents[1] / "scripts/fake_observer.py"
)
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


async def main():
    async with serve(observer.handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        tick = asyncio.create_task(observer.tick())
        try:
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                async def until(predicate):
                    async with asyncio.timeout(10):
                        while True:
                            frame = json.loads(await ws.recv())
                            assert {"phase", "items", "arm", "agents", "ghosts", "best", "result"} == frame.keys()
                            if predicate(frame):
                                return frame

                first = await until(lambda f: len(f["agents"]) == 8)
                assert len(first["items"]) == 2
                await ws.send(json.dumps({"cmd": "silence"}))
                await until(lambda f: all(a["silenced"] for a in f["agents"]))
                await ws.send(json.dumps({"cmd": "die", "id": "a1"}))
                await until(lambda f: not f["agents"][0]["alive"])
                await ws.send(json.dumps({"cmd": "unsilence"}))
                await until(lambda f: not any(a["silenced"] for a in f["agents"]))
                ready = await until(lambda f: f["phase"] == "ready")
                assert ready["best"]["robust"] >= 0.8
                assert ready["ghosts"]
                await ws.send(json.dumps({"cmd": "execute"}))
                await until(lambda f: f["phase"] == "executing")
                done = await until(lambda f: f["phase"] == "done")
                assert done["result"]["predicted"] and done["result"]["actual"]
                await ws.send(json.dumps({"cmd": "replan"}))
                await until(lambda f: f["phase"] in ("searching", "ready") and f["result"] is None)
                print("PASS: frames, ghosts, silence, kill, unsilence, execute, results, replan")
        finally:
            tick.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await tick


if __name__ == "__main__":
    asyncio.run(main())
