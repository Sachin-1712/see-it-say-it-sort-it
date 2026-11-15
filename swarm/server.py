"""Real worker observer: python -m swarm.server --workers 4 --demo."""
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
from .playback import Playback

LOCAL_ORIGIN = re.compile(r"https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?")


async def run(args):
    swarm = Swarm(workers=args.workers, seed=args.seed, directory=args.directory,
                  settings={"rollout_limit":args.rollouts,"time_limit_s":args.timeout})
    playback=Playback(swarm)
    playback_owner=None
    clients = set()
    async def handler(ws):
        nonlocal playback_owner
        clients.add(ws)
        try:
            async for raw in ws:
                try:
                    message=json.loads(raw)
                    cmd=message.get("cmd")
                    if cmd in ('load_demo','start_agents','plan_workbench','invalidate','replan','load_saved') and playback.running:
                        playback.stop()
                        if playback.job:await playback.job
                    if cmd == 'hardware_send':
                        await playback.arm_and_send(message.get('armed'),message.get('manual_tilt'))
                        playback_owner=ws
                    elif cmd == 'hardware_manual_arm':
                        await playback.arm_manual_control(message.get('confirmed'))
                    elif cmd == 'hardware_connect':
                        await playback.connect()
                    elif cmd == 'hardware_status':
                        await ws.send(json.dumps(dict(type='hardware_status',status=await playback.status())))
                    elif cmd == 'hardware_calibration_arm':
                        await playback.arm_calibration(message.get('confirmed'))
                    elif cmd == 'hardware_calibration_move':
                        await playback.start_calibration_move(message.get('key'))
                        playback_owner=ws
                    elif cmd == 'hardware_arm':
                        if message.get('armed') is not True:raise ValueError('Explicit operator arming is required')
                        await playback.arm()
                    elif cmd == 'hardware_start':
                        if message.get('mode') not in ('dry_run','hardware','servo_demo'):raise ValueError('Choose dry_run, hardware or servo_demo')
                        await playback.start(dry_run=message['mode']=='dry_run',servo_demo=message['mode']=='servo_demo',manual_tilt=message.get('manual_tilt') is True)
                        playback_owner=ws
                    elif cmd == 'hardware_key':
                        await playback.start_keyboard(message.get('key'),message.get('armed') is True)
                        playback_owner=ws
                    elif cmd == "die":
                        if not swarm.kill(message.get("id")):raise ValueError("Agent process was already stopped")
                        await ws.send(json.dumps(swarm.frame(),allow_nan=False))
                    elif cmd in ("silence", "unsilence"):
                        swarm.silence(cmd == "silence")
                    elif cmd == "load_demo":
                        await asyncio.to_thread(swarm.start, source="golden", run=False)
                    elif cmd == "start_agents":
                        if not swarm.task:raise ValueError('Load a scene first')
                        await asyncio.to_thread(swarm.start, swarm.task['snapshot'], source=swarm.source)
                    elif cmd == "stop_live":
                        await asyncio.to_thread(swarm.stop_live)
                    elif cmd == "load_saved":
                        await asyncio.to_thread(swarm.load_saved)
                    elif cmd == "prepare_step":
                        await ws.send(json.dumps(await asyncio.to_thread(swarm.prepare_step,message.get('plan_id'),message.get('tilt_confirmed'),message.get('scene_confirmed'))))
                    elif cmd == "confirm_outcome":
                        await ws.send(json.dumps(await asyncio.to_thread(swarm.confirm_outcome,message.get('success'))))
                    elif cmd == "hardware_stop":
                        playback.stop()
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
                except (ValueError, KeyError, TypeError, OSError, TimeoutError) as error:
                    if isinstance(cmd,str) and cmd.startswith('hardware_'):
                        playback.state['message']=str(error)
                        if not playback.running:
                            playback.armed=False
                            playback.calibration_armed=False
                            playback.state['status']='failed'
                    await ws.send(json.dumps(dict(type="error",reason=str(error))))
        except ConnectionClosed:
            pass
        finally:
            if playback_owner is ws and playback.running:playback.stop()
            clients.discard(ws)
    try:
        if args.demo:
            swarm.start(source="golden")
        async with serve(handler, "localhost", args.port, origins=[LOCAL_ORIGIN,None], max_size=2*1024*1024):
            print(f"Real GEKKO swarm observer ws://localhost:{args.port}; {args.workers} workers; serial disabled until calibrated and armed; saved playback available",flush=True)
            while True:
                current=swarm.frame()
                current["hardware_playback"]=playback.snapshot()
                frame = json.dumps(current,allow_nan=False)
                for ws in list(clients):
                    try:
                        await ws.send(frame)
                    except ConnectionClosed:
                        clients.discard(ws)
                await asyncio.sleep(.25)
    finally:
        playback.stop()
        if playback.job:await playback.job
        playback.bridge.close()
        swarm.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers",type=int,default=4)
    parser.add_argument("--seed",type=int,default=2026)
    parser.add_argument("--rollouts",type=int,default=2500)
    parser.add_argument("--timeout",type=float,default=400)
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
