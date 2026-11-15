"""Connection feedback and non-moving discovery probes, without physical USB."""
import asyncio
import re
import threading
from types import SimpleNamespace

import pytest
from swarm.playback import Playback
from swarm.serial_bridge import SerialBridge, resolve_device
from test_playback import Firmware, cfg_for


def test_detects_only_one_unambiguous_uno_q(monkeypatch):
    from serial.tools import list_ports
    ports=[SimpleNamespace(device='/dev/cu.usbmodem123',description='UNO Q - arduino')]
    monkeypatch.setattr(list_ports,'comports',lambda:ports)
    assert resolve_device({'serial_port':None})=='/dev/cu.usbmodem123'
    ports.append(SimpleNamespace(device='/dev/cu.usbmodem456',description='UNO Q - arduino'))
    with pytest.raises(ValueError,match='single UNO Q'):resolve_device({'serial_port':None})


def test_status_probe_cannot_trigger_legacy_letter_commands():
    class Port:
        is_open=True
        def __init__(self):self.written=[]
        def write(self,packet):self.written.append(packet);return len(packet)
        def readline(self):return b''
    async def run():
        bridge=SerialBridge();bridge.port=Port()
        with pytest.raises(TimeoutError):await bridge.request('?',threading.Event(),.02)
        assert len(bridge.port.written)==1
        packet=bridge.port.written[0]
        assert re.fullmatch(rb'@[0-9]+ \?\n',packet)
        assert not set(packet).intersection(b'LRSC lrsc')-{ord(' ')}
    asyncio.run(run())


def test_connect_failure_is_retained_in_status_panel():
    async def run():
        firmware=Firmware();config=cfg_for(firmware);owner=SerialBridge()
        playback=Playback(SimpleNamespace(),config_reader=lambda:config)
        try:
            owner.connect(config)
            with pytest.raises(ValueError):await playback.connect()
            status=playback.snapshot()
            assert status['status']=='failed' and 'Connection failed' in status['message']
            assert not status['running'] and not status['armed']
        finally:owner.close();playback.bridge.close();firmware.close()
    asyncio.run(run())
