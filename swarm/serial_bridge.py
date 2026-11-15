"""The only serial owner. Keyboard and playback share this bridge, never a port."""
import asyncio
import fcntl
import hashlib
import os
import subprocess
import tempfile
import termios
import threading
import time
import uuid
from pathlib import Path


def resolve_device(config):
    device=config.get('serial_port')
    if device is None:
        from serial.tools import list_ports
        matches=[p.device for p in list_ports.comports() if 'uno q' in (p.description or '').lower()]
        if len(matches)!=1:
            raise ValueError('No single UNO Q detected. Plug it in, or set serial_port in config/uno-q.json.')
        device=matches[0]
    if not isinstance(device,str) or not device.startswith('/dev/'):
        raise ValueError('Configure a local USB serial device under /dev/')
    return device


class SerialBridge:
    def __init__(self):
        self.port = None
        self.lock_file = None
        self.io_lock = threading.Lock()
        self.requests = asyncio.Lock()
        self.connection = 'Disconnected'
        self.device = None
        self.config = None

    def connect(self, config):
        import serial
        self.close()
        device = resolve_device(config)
        self.device = device
        # cu/tty names address the same macOS device. Cooperating GEKKO tools
        # share a lock; TIOCEXCL also excludes noncooperating future opens.
        canonical = os.path.realpath(device).replace('/dev/cu.', '/dev/tty.')
        lock = Path(tempfile.gettempdir()) / ('gekko-serial-' + hashlib.sha256(canonical.encode()).hexdigest()[:20] + '.lock')
        self.lock_file = lock.open('a')
        try:
            fcntl.flock(self.lock_file,fcntl.LOCK_EX | fcntl.LOCK_NB)
            aliases = {device, canonical, canonical.replace('/dev/tty.','/dev/cu.')}
            try:
                result = subprocess.run(['lsof','-t','--',*sorted(aliases)],capture_output=True,text=True,timeout=2)
                if result.stdout.strip():raise ValueError('Serial port already in use; close Serial Monitor and external servo_keys.py')
            except FileNotFoundError:
                pass  # TIOCEXCL below still enforces exclusive ownership.
            self.port = serial.Serial(device,config.get('baud',115200),timeout=.05,write_timeout=.2,exclusive=True)
            fcntl.ioctl(self.port.fileno(),termios.TIOCEXCL)
            self.port.reset_input_buffer()
            self.device, self.config = device, dict(config)
            self.connection = f'Connected {device} — not armed'
        except Exception as error:
            self.close()
            self.connection = f'Connection failed: {error}'
            raise ValueError(self.connection) from error

    def close(self):
        if self.port:
            try:
                fcntl.ioctl(self.port.fileno(),termios.TIOCNXCL)
            except (OSError,ValueError):pass
            self.port.close()
        self.port = None
        if self.lock_file:self.lock_file.close()
        self.lock_file = None
        self.connection = 'Disconnected'

    def write(self, command, token):
        if command not in ('L','R','S','C','?'):raise ValueError('Unsafe serial command')
        if not self.port or not self.port.is_open:raise ValueError('Serial connection lost')
        packet=f'@{token} {command}\n'.encode('ascii')
        with self.io_lock:
            if self.port.write(packet)!=len(packet):raise ValueError('Incomplete serial write')

    def stop_now(self):
        if not self.port:return False
        try:
            self.write('S',str(uuid.uuid4().int))
            return True  # sent only: no claim of STOP acknowledgement
        except Exception as error:
            self.connection=f'Connection lost: {error}'
            return False

    async def request(self, command, cancel, timeout=5, guard=lambda:None):
        async with self.requests:
            # Digits cannot trigger legacy character-at-a-time L/R/S/C commands.
            token=str(uuid.uuid4().int)
            guard()
            if cancel.is_set():raise InterruptedError('Playback interrupted')
            self.write(command,token)
            deadline=time.monotonic()+timeout
            # Accumulate partial reads: readline() may time out halfway through a reply.
            buffer=b''
            try:
                while time.monotonic()<deadline:
                    guard()
                    if cancel.is_set():raise InterruptedError('Playback interrupted')
                    if not self.port or not self.port.is_open:raise ValueError('Serial connection lost')
                    raw=await asyncio.to_thread(self.port.readline)
                    buffer+=raw
                    if len(buffer)>4096:raise ValueError('Oversized firmware response')
                    while b'\n' in buffer:
                        line,buffer=buffer.split(b'\n',1)
                        fields=line.decode('ascii',errors='strict').strip().split()
                        if len(fields)<2 or fields[1]!=token:continue
                        guard()
                        if cancel.is_set():raise InterruptedError("Request stopped")
                        if fields[0]=='ERROR':raise ValueError('Firmware error: '+' '.join(fields[2:]))
                        if command=='?' and fields[0]=='STATUS':return fields[2:]
                        if command!='?' and fields[0]=='DONE' and len(fields)==4 and fields[2]==command:
                            return float(fields[3])
                        raise ValueError('Unexpected correlated firmware response')
                raise TimeoutError(f'Timeout waiting for {command} acknowledgement')
            except (InterruptedError,TimeoutError):
                raise
            except (OSError,UnicodeError) as error:
                self.connection=f'Connection lost: {error}'
                raise ValueError(self.connection) from error
