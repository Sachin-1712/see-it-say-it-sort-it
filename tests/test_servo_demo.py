"""Automatic endpoint demo uses genuine saved-plan order and real pyserial PTY IO."""
import asyncio
import time
import pytest
from test_playback import Firmware,cfg_for,controller_from,validated
from swarm.serial_bridge import SerialBridge


def test_single_start_runs_endpoints_without_tilt_profiles_and_homes_if_needed(validated):
    async def run():
        fw=Firmware();fw.angle='NA';cfg=cfg_for(fw)
        cfg.update(tilt_verification={'mode':'none','verified':False},action_profiles={})
        p=controller_from(validated,cfg,SerialBridge())
        actions=p.swarm.saved_bundle['plan']['actions']
        expected=[cfg['direction_commands']['increasing' if a['sweep_end_deg']>a['sweep_start_deg'] else 'decreasing'] for a in actions]
        try:
            with pytest.raises(ValueError,match='Explicit Arm'):await p.arm_and_send(False,True)
            assert p.bridge.port is None
            with pytest.raises(ValueError,match='manual-tilt'):await p.start(False,servo_demo=True)
            await p.arm_and_send(True,True) # one action connects, arms, then runs
            await p.job
            assert p.state['status']=='servo_demo_completed'
            assert p.state['completed_steps']==len(actions)+1 and p.state['acknowledged']
            assert not p.state['tilt_verified'] and not p.state['sorting_verified']
            assert not p.armed
            assert p.state['steps']==len(actions)+1 and p.state['box']=='Extra demo command L'
            assert p.state['endpoint_held'] is (expected[-1]=='L')
            assert len(p.swarm.saved_bundle['plan']['actions'])==len(actions)
            moves=[(c,t) for c,t in fw.events if c in 'LRC']
            assert [c for c,_ in moves]==['C',*expected,'L']
            assert all(moves[i+1][1]-fw.acks[i]>=3 for i in range(len(moves)-1))
        finally:p.bridge.close();fw.close()
    asyncio.run(run())


def test_stop_during_demo_gap_prevents_remaining_physical_commands(validated):
    async def run():
        fw=Firmware();cfg=cfg_for(fw)
        cfg.update(tilt_verification={'mode':'none','verified':False},action_profiles={})
        p=controller_from(validated,cfg,SerialBridge())
        try:
            await p.connect();await p.arm();await p.start(False,servo_demo=True,manual_tilt=True)
            deadline=time.monotonic()+3
            while p.state['status']!='interval' and time.monotonic()<deadline:await asyncio.sleep(.01)
            assert p.state['status']=='interval'
            p.stop();await p.job
            assert p.state['status']=='interrupted' and not p.armed
            assert len([c for c,_ in fw.events if c in 'LR'])==1
        finally:p.bridge.close();fw.close()
    asyncio.run(run())
