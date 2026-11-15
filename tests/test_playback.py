"""Exercise real pyserial against a PTY firmware mock; never touch physical USB."""
import asyncio
import copy
import json
import os
import select
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from swarm.hardware import configuration
from swarm.playback import Playback
from swarm.saved_plan import sha, identity
from swarm.serial_bridge import SerialBridge
from swarm.supervisor import Swarm
from test_demo import validated


class Firmware:
    def __init__(self, ack=True, tilt=10):
        self.master,slave=os.openpty();self.device=os.ttyname(slave);os.close(slave)
        self.angle=90;self.tilt=tilt;self.ack=ack;self.events=[];self.acks=[];self.closed=False;self.tilt_reader=None
        self.thread=threading.Thread(target=self.run,daemon=True);self.thread.start()

    def run(self):
        buffer=b''
        while not self.closed:
            try:
                if not select.select([self.master],[],[],.05)[0]:continue
                raw=os.read(self.master,512)
                buffer+=raw
                while b'\n' in buffer:
                    line,buffer=buffer.split(b'\n',1)
                    if not line.startswith(b'@'):continue
                    token,cmd=line[1:].decode().split()
                    self.events.append((cmd,time.monotonic()))
                    if cmd=='?':
                        tilt=self.tilt_reader() if self.tilt_reader else self.tilt
                        reply=f'STATUS {token} {self.angle} {tilt} test-rig 0 180 VERIFIED\n'
                    elif cmd=='S':reply=f'DONE {token} S {self.angle}\n'
                    elif self.ack:
                        self.angle={'L':0,'R':180,'C':90}[cmd]
                        # A stale DONE must not satisfy this request.
                        os.write(self.master,f'DONE stale {cmd} {self.angle}\n'.encode())
                        reply=f'DONE {token} {cmd} {self.angle}\n'
                    else:continue
                    if cmd in 'LRC':self.acks.append(time.monotonic())
                    os.write(self.master,reply.encode())
            except OSError:time.sleep(.005)

    def close(self):
        self.closed=True;self.thread.join(timeout=.2);os.close(self.master)


def cfg_for(firmware):
    cfg=configuration()
    cfg.update(serial_port=firmware.device,enabled=True,calibration_verified=True,acknowledgement_verified=True,
        completion_verified=True,completion_verification_id='measured-bound',calibration_id='test-rig',
        servo_limits_deg=[0,180],tilt_limits_deg=[0,27],direction_commands={'increasing':'R','decreasing':'L'},
        endpoint_angles_deg={'L':0,'R':180,'C':90},
        tilt_verification={'mode':'sensor','verified':True,'calibration_id':'inclinometer-test','tolerance_deg':1,'angle_deg':None})
    return cfg


def bridge_test(coro):return asyncio.run(coro)


def test_pyserial_exclusive_owner_correlated_ack_and_no_gp():
    async def run():
        fw=Firmware();a=SerialBridge();b=SerialBridge();cfg=cfg_for(fw)
        try:
            a.connect(cfg)
            with pytest.raises(ValueError):b.connect(cfg)
            cancel=threading.Event()
            assert (await a.request('?',cancel))[2]=='test-rig'
            assert await a.request('R',cancel)==180
            with pytest.raises(ValueError,match='Unsafe'):a.write('G','x')
            assert a.stop_now()
            assert all(cmd in '?LRSC' for cmd,_ in fw.events)
        finally:a.close();b.close();fw.close()
    bridge_test(run())


def test_serial_timeout_and_disconnect_are_errors():
    async def run():
        fw=Firmware(ack=False);bridge=SerialBridge()
        try:
            bridge.connect(cfg_for(fw))
            with pytest.raises(TimeoutError):await bridge.request('L',threading.Event(),.15)
            fw.close()
            with pytest.raises((ValueError,OSError)):await bridge.request('?',threading.Event(),.2)
        finally:bridge.close()
    bridge_test(run())


def controller_from(validated,cfg,bridge):
    _,original,bundle=validated
    # Genuine simulation evidence/trajectories from the fixture. The mock's
    # physical calibration only configures transport; no physical success is claimed.
    swarm=SimpleNamespace(stopped=True,task=copy.deepcopy(original.task),saved_bundle=copy.deepcopy(bundle))
    swarm.saved_bundle['hashes']=identity(swarm.task,cfg)
    controller=Playback(swarm,bridge=bridge,config_reader=lambda:cfg)
    return controller


def test_timed_dry_run_uses_saved_order_and_full_three_second_gaps(validated):
    async def run():
        cfg=configuration();controller=controller_from(validated,cfg,SerialBridge())
        # Capture each state as it enters a wait, without replacing the real clock.
        waits=[];wait=controller.wait
        async def record(seconds,guard):
            waits.append((seconds,controller.state['target'],time.monotonic()))
            await wait(seconds,guard)
        controller.wait=record
        await controller.start(dry_run=True);await controller.job
        assert controller.state['status']=='dry_run_finished'
        assert not controller.state['acknowledged'] and controller.bridge.port is None
        actions=controller.swarm.saved_bundle['plan']['actions']
        assert [target for seconds,target,_ in waits if seconds!=3]==[a['target'] for a in actions]
        intervals=[(i,w) for i,w in enumerate(waits) if w[0]==3]
        assert len(intervals)==2
        for i,(_,_,started) in intervals:assert waits[i+1][2]-started>=3
    bridge_test(run())


def test_unverified_hardware_cannot_arm_or_start(validated):
    async def run():
        cfg=configuration();p=controller_from(validated,cfg,SerialBridge())
        with pytest.raises(ValueError,match='disabled'):await p.arm()
        with pytest.raises(ValueError,match='Arm'):await p.start(dry_run=False)
        cfg.update(enabled=True,calibration_verified=True,acknowledgement_verified=True,completion_verified=True,calibration_id='test',completion_verification_id='test')
        with pytest.raises(ValueError,match='tilt'):p.profiles(p.swarm.saved_bundle,cfg)
    bridge_test(run())


def test_stop_interrupts_countdown_without_sending_any_sweep(validated):
    async def run():
        cfg=configuration();p=controller_from(validated,cfg,SerialBridge())
        await p.start()
        deadline=time.monotonic()+5
        while p.state['status']!='interval' and time.monotonic()<deadline:await asyncio.sleep(.02)
        assert p.state['status']=='interval'
        p.stop();await p.job
        assert p.state['status']=='interrupted' and p.state['step']==2 and not p.armed
    bridge_test(run())


def test_verified_playback_acknowledges_and_checks_next_tilt(validated):
    async def run():
        fw=Firmware();cfg=cfg_for(fw);bridge=SerialBridge()
        p=controller_from(validated,cfg,bridge)
        actions=p.swarm.saved_bundle['plan']['actions']
        start=90
        for a in actions:
            command=cfg['direction_commands']['increasing' if a['sweep_end_deg']>a['sweep_start_deg'] else 'decreasing']
            end=cfg['endpoint_angles_deg'][command]
            cfg['action_profiles'][sha(a)]={'verified':True,'command':command,'start_deg':start,'end_deg':end,'timeout_s':1}
            start=end
        p.swarm.saved_bundle['hashes']=identity(p.swarm.task,cfg)
        fw.tilt=actions[0]['tilt_deg']
        try:
            await p.connect();await p.arm();await p.start(dry_run=False)
            while p.state['status'] not in ('interval','failed'):await asyncio.sleep(.01)
            assert p.state['status']=='interval' and len([c for c,_ in fw.events if c in 'LR'])==1
            await p.job # mock tilt stays at step 1 angle: next physical sweep must fail
            assert p.state['status']=='failed' and 'tilt' in p.state['message']
            assert len([c for c,_ in fw.events if c in 'LR'])==1 and not p.armed
        finally:bridge.close();fw.close()
    bridge_test(run())


def test_three_physical_mock_steps_after_one_start_and_three_seconds_after_done(validated):
    async def run():
        fw=Firmware();cfg=cfg_for(fw);bridge=SerialBridge()
        p=controller_from(validated,cfg,bridge)
        actions=p.swarm.saved_bundle['plan']['actions'];start=90;commands=[]
        for a in actions:
            command=cfg['direction_commands']['increasing' if a['sweep_end_deg']>a['sweep_start_deg'] else 'decreasing']
            end=cfg['endpoint_angles_deg'][command];commands.append(command)
            cfg['action_profiles'][sha(a)]={'verified':True,'command':command,'start_deg':start,'end_deg':end,'timeout_s':1};start=end
        p.swarm.saved_bundle['hashes']=identity(p.swarm.task,cfg)
        fw.tilt_reader=lambda:actions[min(len([c for c,_ in fw.events if c in 'LR']),len(actions)-1)]['tilt_deg']
        try:
            await p.connect();await p.arm();await p.start(dry_run=False)
            with pytest.raises(ValueError,match='Stop playback'):await p.start_keyboard('C',True)
            await p.job
            assert p.state['status']=='completed' and p.state['acknowledged'] and not p.armed
            moves=[(c,t) for c,t in fw.events if c in 'LR']
            assert [c for c,_ in moves]==commands
            assert all(moves[i+1][1]-fw.acks[i]>=3 for i in range(2))
            with pytest.raises(ValueError,match='Arm'):await p.start(dry_run=False)
        finally:bridge.close();fw.close()
    bridge_test(run())


def test_unknown_initial_position_requires_explicit_keyboard_home():
    async def run():
        fw=Firmware();fw.angle='NA';cfg=cfg_for(fw);bridge=SerialBridge()
        p=Playback(SimpleNamespace(),bridge,lambda:cfg)
        try:
            await p.connect()
            assert (await p.status())['angle'] is None
            await p.start_keyboard('L',True);await p.job
            assert p.state['status']=='failed' and not any(c=='L' for c,_ in fw.events)
            await p.start_keyboard('C',True);await p.job
            assert p.state['status']=='step_completed' and fw.angle==90
        finally:bridge.close();fw.close()
    bridge_test(run())
