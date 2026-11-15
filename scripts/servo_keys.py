"""Keyboard client of the single GEKKO serial owner (never opens a serial port)."""
import argparse
import asyncio
import json
import sys
import termios
import tty
from websockets.asyncio.client import connect


async def run(args):
    async with connect(args.url,max_size=4*1024*1024) as ws:
        async def read():
            async for raw in ws:
                frame=json.loads(raw)
                if frame.get('type')=='error':print(frame['reason'],flush=True)
                status=frame.get('hardware_playback')
                if status and status['message']!=read.last:
                    print(status['connection']+' · '+status['message'],flush=True);read.last=status['message']
        read.last=None
        reader=asyncio.create_task(read())
        await ws.send(json.dumps({'cmd':'hardware_connect'}))
        print('L/R/C = calibrated endpoint movement; S or Escape = stop; Q = quit. This client never owns USB.')
        try:
            while True:
                key=(await asyncio.to_thread(sys.stdin.read,1)).upper()
                if key in ('Q','') or key=='\x1b':break
                if key in 'LRSC':await ws.send(json.dumps({'cmd':'hardware_key','key':key,'armed':args.arm}))
        finally:
            await ws.send(json.dumps({'cmd':'hardware_stop'}));reader.cancel()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url',default='ws://localhost:8765')
    p.add_argument('--arm',action='store_true',help='Explicit operator arming; verified calibration is still required')
    args=p.parse_args()
    if not sys.stdin.isatty():p.error('Use an interactive terminal')
    old=termios.tcgetattr(sys.stdin)
    try:
        tty.setcbreak(sys.stdin.fileno());asyncio.run(run(args))
    except KeyboardInterrupt:pass
    finally:termios.tcsetattr(sys.stdin,termios.TCSADRAIN,old)

if __name__=='__main__':main()
