"""Supervised tests may command real endpoints, but never certify completion."""
import asyncio
from types import SimpleNamespace
import pytest
from swarm.playback import Playback
from swarm.serial_bridge import SerialBridge
from test_playback import Firmware,cfg_for


def setup():
    fw=Firmware();fw.completion='CALIBRATION'
    cfg=cfg_for(fw)
    cfg.update(enabled=False,calibration_verified=False,completion_verified=False,acknowledgement_verified=False)
    cfg['operator_calibration']={'enabled':True,'range_confirmed':True,'servo_limits_deg':[0,180],'command_timeout_s':1}
    return fw,cfg,Playback(SimpleNamespace(),SerialBridge(),lambda:cfg)


def test_individual_operator_tests_do_not_enable_automatic_playback():
    async def run():
        fw,cfg,p=setup()
        try:
            await p.connect()
            with pytest.raises(ValueError,match='operator presence'):await p.arm_calibration(False)
            await p.arm_calibration(True)
            assert p.calibration_armed and not p.armed
            await p.start_calibration_move('C');await p.job
            assert p.state['status']=='calibration_review' and fw.angle==90
            assert not p.state['acknowledged'] and not p.state['test_result']['physical_completion_verified']
            await p.start_calibration_move('L');await p.job
            assert fw.angle==0 and p.state['status']=='calibration_review'
            with pytest.raises(ValueError,match='disabled'):p.profiles({'plan':{'actions':[]}},cfg)
            p.stop();assert not p.calibration_armed
            with pytest.raises(ValueError,match='Arm supervised'):await p.start_calibration_move('R')
        finally:p.bridge.close();fw.close()
    asyncio.run(run())


def test_supervised_tests_require_confirmed_range_and_matching_firmware():
    async def run():
        fw,cfg,p=setup()
        try:
            await p.connect();cfg['operator_calibration']['range_confirmed']=False
            with pytest.raises(ValueError,match='range'):await p.arm_calibration(True)
            cfg['operator_calibration']['range_confirmed']=True;fw.completion='UNVERIFIED'
            with pytest.raises(ValueError,match='build'):await p.arm_calibration(True)
            assert not any(c in 'LRC' for c,_ in fw.events)
        finally:p.bridge.close();fw.close()
    asyncio.run(run())
