"""Real worker observer: python -m swarm.server --workers 6 --demo."""
import os
for option in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(option, "1")

import argparse
import asyncio
import json
import re
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from .supervisor import Swarm

LOCAL_ORIGIN = re.compile(r"https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?")


async def run(args):
    swarm = Swarm(workers=args.workers, seed=args.seed, directory=args.directory,
                  settings={"rollout_limit":args.rollouts,"time_limit_s":args.timeout})
    clients = set()
    async def handler(ws):
        clients.add(ws)
        try:
            async for raw in ws:
                try:
                    message=json.loads(raw)
                    cmd=message.get("cmd")
                    if cmd == "die":
                        swarm.kill(message.get("id"))
                    elif cmd in ("silence", "unsilence"):
                        swarm.silence(cmd == "silence")
                    elif cmd == "load_demo":
                        await asyncio.to_thread(swarm.start, source="golden")
                    elif cmd == "plan_workbench":
                        await asyncio.to_thread(swarm.start, message.get("snapshot"))
                    elif cmd == "replay_plan":
                        await ws.send(json.dumps(await asyncio.to_thread(swarm.replay),allow_nan=False))
                    elif cmd == "invalidate":
                        await asyncio.to_thread(swarm.invalidate)
                    elif cmd == "replan" and swarm.task:
                        await asyncio.to_thread(swarm.start, swarm.task["snapshot"], source=swarm.source)
                    elif cmd == "execute":
                        # Human-confirmed Send: dry run only. Logs the firmware lines; nothing reaches hardware.
                        await ws.send(json.dumps(await asyncio.to_thread(swarm.dry_run), allow_nan=False))
                    elif cmd == "confirm_ready":
                        await ws.send(json.dumps(dict(type="error",reason="Hardware execution is disabled; Send runs as a dry run only.")))
                    else:
                        raise ValueError("unsupported command")
                except (ValueError, KeyError, TypeError) as error:
                    await ws.send(json.dumps(dict(type="error",reason=str(error))))
        except ConnectionClosed:
            pass
        finally:
            clients.discard(ws)
    try:
        if args.demo:
            swarm.start(source="golden")
        async with serve(handler, "localhost", args.port, origins=[LOCAL_ORIGIN,None], max_size=2*1024*1024):
            print(f"Real GEKKO swarm observer ws://localhost:{args.port}; {args.workers} workers; hardware disabled (Send is a dry run)",flush=True)
            while True:
                frame = json.dumps(swarm.frame(),allow_nan=False)
                for ws in list(clients):
                    try:
                        await ws.send(frame)
                    except ConnectionClosed:
                        clients.discard(ws)
                await asyncio.sleep(.25)
    finally:
        swarm.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers",type=int,default=6)
    parser.add_argument("--seed",type=int,default=2026)
    parser.add_argument("--rollouts",type=int,default=2500)
    parser.add_argument("--timeout",type=float,default=600)
    parser.add_argument("--port",type=int,default=8765)
    parser.add_argument("--directory")
    parser.add_argument("--demo",action="store_true")
    args=parser.parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
