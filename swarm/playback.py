"""Single-start saved-plan playback; all waits are interruptible, no agent changes."""
import asyncio
import copy
import math
import threading
import time
import uuid
from .hardware import configuration, prepare
from .saved_plan import identity, sha, check_plan
from .serial_bridge import SerialBridge

INTERVAL_S=3.0


class Playback:
    def __init__(self, swarm, bridge=None, config_reader=configuration):
        self.swarm=swarm
        self.bridge=bridge or SerialBridge()
        self.config_reader=config_reader
        self.cancel=threading.Event()
        self.job=None
        self.control_busy=False
        self.armed=False
        self.calibration_armed=False
        self.armed_hash=None
        self.state=dict(status='idle',mode='dry_run',step=0,steps=0,acknowledged=False,message='Load a saved plan')

    @property
    def running(self):return self.control_busy or bool(self.job and not self.job.done())

    def snapshot(self):
        return dict(self.state,connection=self.bridge.connection,armed=self.armed,calibration_armed=self.calibration_armed,running=self.running,
                    remaining_s=max(0,math.ceil(self.state.get('next_at',0)-time.monotonic())),
                    replay_elapsed_s=min(self.state.get('replay_duration_s',0),max(0,time.monotonic()-self.state.get('replay_started_at',time.monotonic()))))

    def bundle(self):
        s=self.swarm
        if not s.stopped or not s.task or not s.saved_bundle:raise ValueError('Stop live search and load a saved plan first')
        b=s.saved_bundle
        if not -60 <= time.time()-b['created_at'] <= 86400:raise ValueError('Saved plan is stale')
        if b['hashes']!=identity(s.task,self.config_reader()):raise ValueError('Plan/scenario/calibration mismatch; reload a compatible saved plan')
        return b

    def require_idle(self):
        if self.running:raise ValueError('Stop playback before changing the scene, connection or plan')

    async def connect(self):
        self.require_idle();self.armed=False;self.calibration_armed=False;self.control_busy=True;self.cancel.clear()
        self.state.update(status='connecting',message='Connecting to UNO Q; checking port ownership and firmware. No sweep requested.')
        try:
            await asyncio.to_thread(self.bridge.connect,self.config_reader())
            try:await self.status()
            except TimeoutError as error:
                raise ValueError('UNO Q did not answer the status probe. Upload firmware/gekko_playback/gekko_playback.ino, close Serial Monitor, then reconnect. No sweep was requested.') from error
            self.state.update(status='connected',message='UNO Q connected; movement remains disabled until calibration and arming.')
        except Exception as error:
            self.bridge.close()
            self.state.update(status='failed',message=str(error))
            raise
        finally:self.control_busy=False

    async def status(self,guard=lambda:None):
        values=await self.bridge.request('?',self.cancel,2,guard)
        if len(values)!=6:raise ValueError('Unsupported firmware STATUS; install the GEKKO acknowledgement sketch')
        angle,tilt,calibration,low,high,completion=values
        angle=None if angle=='NA' else float(angle);low=float(low);high=float(high)
        tilt=None if tilt=='NA' else float(tilt)
        if not all(math.isfinite(x) for x in (low,high)) or (angle is not None and not math.isfinite(angle)) or (tilt is not None and not math.isfinite(tilt)):
            raise ValueError('Invalid firmware position/tilt')
        return dict(angle=angle,tilt=tilt,calibration=calibration,limits=[low,high],completion=completion)

    def profiles(self, bundle, config):
        if not all(config.get(k) is True for k in ('enabled','calibration_verified','acknowledgement_verified','completion_verified')):
            raise ValueError('Physical execution disabled: verify mapping, servo limits and completion mechanism')
        if not config.get('calibration_id') or not config.get('completion_verification_id'):
            raise ValueError('Missing measured calibration/completion evidence IDs')
        tilt=config.get('tilt_verification',{})
        if tilt.get('verified') is not True or tilt.get('mode') not in ('sensor','fixed') or not tilt.get('calibration_id'):
            raise ValueError('Manual tilt is unverified: use timed dry-run playback')
        tolerance=tilt.get('tolerance_deg')
        if not isinstance(tolerance,(int,float)) or not math.isfinite(tolerance) or not 0<tolerance<=1:
            raise ValueError('Tilt tolerance must be calibrated and at most 1 degree')
        if not config.get('serial_port'):raise ValueError('Set the calibrated serial_port explicitly before physical playback')
        profiles=[]
        for action in bundle['plan']['actions']:
            prepared=prepare(action,config)
            if not prepared['calibrated']:raise ValueError('Unverified direction mapping or servo limits')
            profile=config.get('action_profiles',{}).get(sha(action))
            if not profile or profile.get('verified') is not True or profile.get('command')!=prepared['command']:
                raise ValueError('Endpoint firmware needs a physically verified profile for each saved action (including start, speed and end)')
            start,end,timeout=(profile.get(k) for k in ('start_deg','end_deg','timeout_s'))
            if any(not isinstance(v,(int,float)) or not math.isfinite(v) for v in (start,end,timeout)) or not 0<timeout<=30:
                raise ValueError('Invalid calibrated action profile')
            lo,hi=config['servo_limits_deg']
            if not lo<=start<=hi or not lo<=end<=hi or config['endpoint_angles_deg'].get(profile['command'])!=end:
                raise ValueError('Action profile exceeds calibrated endpoint limits')
            if tilt['mode']=='fixed' and abs(action['tilt_deg']-tilt.get('angle_deg',-999))>tolerance:
                raise ValueError('Fixed mechanical tilt cannot reproduce this plan; use a verified sensor or dry run')
            if profiles and profiles[-1]['end_deg']!=start:
                raise ValueError('Calibrated actions require an unverified reposition between sweeps')
            profiles.append(profile)
        return profiles

    async def arm(self):
        self.require_idle();self.armed=False;self.cancel.clear();self.control_busy=True
        try:
            b=self.bundle();check_plan(self.swarm.task,b['plan'])
            config=self.config_reader();self.profiles(b,config)
            status=await self.status()
            self.verify_status(status,config)
            if self.cancel.is_set():raise InterruptedError('Arming stopped')
            if self.bridge.config!=config:raise ValueError('Serial configuration changed; reconnect')
            self.armed=True;self.armed_hash=sha(config)
            self.state.update(message='Armed for one playback. Tilt remains manual; verify the required angle at each sweep.')
        finally:self.control_busy=False

    def verify_status(self,status,config):
        if status['calibration']!=config['calibration_id'] or status['limits']!=config['servo_limits_deg'] or status['completion']!='VERIFIED':
            raise ValueError('Firmware calibration/limits/completion mismatch')

    async def start(self,dry_run=True):
        self.require_idle()
        bundle=copy.deepcopy(self.bundle());config=copy.deepcopy(self.config_reader())
        check_plan(self.swarm.task,bundle['plan'])
        profiles=[]
        if not dry_run:
            if not self.armed or self.armed_hash!=sha(config):raise ValueError('Arm hardware once before the initial Start action')
            profiles=self.profiles(bundle,config)
        self.calibration_armed=False
        self.armed=False # every start consumes the one-time arm
        self.cancel.clear()
        self.state=dict(run_id=uuid.uuid4().hex,status='starting',mode='dry_run' if dry_run else 'hardware',step=0,
                        steps=len(bundle['plan']['actions']),acknowledged=False,completed_steps=0,message='PREVIOUSLY VALIDATED PLAN')
        self.job=asyncio.create_task(self.run(bundle,config,profiles,dry_run))

    def guard(self,bundle,config):
        if self.cancel.is_set():raise InterruptedError('Playback stopped; no automatic restart')
        if sha(self.config_reader())!=sha(config) or self.bundle()['hashes']!=bundle['hashes']:
            raise ValueError('Scenario or hardware calibration changed during playback')

    async def wait(self,seconds,guard):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            guard()
            await asyncio.sleep(min(.05,max(0,deadline-time.monotonic())))
        guard()

    async def run(self,bundle,config,profiles,dry_run):
        guard=lambda:self.guard(bundle,config)
        try:
            actions=bundle['plan']['actions']
            objects={o['instanceId']:o for o in self.swarm.task['snapshot']['objects']}
            for index,action in enumerate(actions):
                guard()
                prepared=prepare(action,config)
                self.state.update(step=index+1,target=action['target'],box=objects[action['target']].get('name',action['target']),
                    destination=self.swarm.task['goals'][action['target']],tilt_deg=action['tilt_deg'],
                    direction=action.get('direction'),command=prepared['command'],acknowledged=False,next_at=0)
                if index:
                    self.state.update(status='interval',next_at=time.monotonic()+INTERVAL_S,
                                      message='Next sweep in countdown; set required MANUAL tilt. GEKKO does not adjust tilt.')
                    await self.wait(INTERVAL_S,guard)
                if dry_run:
                    self.state.update(status='dry_run_sweeping',message='DRY RUN — no serial command sent; no movement acknowledged')
                    duration=bundle['plan']['results'][index]['trajectories']['stick'][-1][0]
                    self.state.update(replay_step=index+1,replay_started_at=time.monotonic(),replay_duration_s=duration)
                    await self.wait(duration,guard)
                else:
                    p=profiles[index]
                    status=await self.status(guard);self.verify_status(status,config)
                    tilt=config['tilt_verification']
                    actual=status['tilt'] if tilt['mode']=='sensor' else tilt['angle_deg']
                    if actual is None or abs(actual-action['tilt_deg'])>tilt['tolerance_deg']:
                        raise ValueError('Required manual tilt is unverified; next physical sweep blocked')
                    if status['angle'] is None or abs(status['angle']-p['start_deg'])>.5:raise ValueError('Servo start position mismatch; no automatic reposition')
                    self.state.update(status='sweeping',message='Sweeping — waiting for correlated DONE; box outcome unverified')
                    end=await self.bridge.request(p['command'],self.cancel,p['timeout_s'],guard)
                    guard()
                    if not math.isfinite(end) or abs(end-p['end_deg'])>.5:raise ValueError('Acknowledged endpoint mismatch')
                    self.state['completed_steps']+=1
                    self.state['last_acknowledged']=dict(step=index+1,target=action['target'],command=p['command'],timestamp=time.time())
                    self.state.update(status='step_completed',acknowledged=True,message='Completed — firmware acknowledged servo movement. Box sorting is unverified.')
            self.state.update(status='dry_run_finished' if dry_run else 'completed',next_at=0,
                message='Dry-run playback finished — nothing sent or acknowledged' if dry_run else 'Playback completed — all servo movements acknowledged; box outcomes unverified')
        except (Exception,asyncio.CancelledError) as error:
            sent=False if dry_run else self.bridge.stop_now()
            self.state.update(status='interrupted' if self.cancel.is_set() else 'failed',next_at=0,
                              message=f'{error}. STOP '+('sent (not yet acknowledged)' if sent else 'not confirmed')+'. Disconnect servo power physically.')
        finally:self.armed=False

    def stop(self):
        self.cancel.set();self.armed=False;self.calibration_armed=False
        sent=self.bridge.stop_now()
        self.state.update(status='interrupted',next_at=0,message='STOP '+('sent; acknowledgement pending' if sent else 'not transmitted (no connection)')+'. Disconnect servo power physically. No automatic restart.')

    def calibration_config(self):
        config=self.config_reader();test=config.get('operator_calibration',{})
        if test.get('enabled') is not True or test.get('range_confirmed') is not True:
            raise ValueError('Operator-tested travel range is required for supervised calibration')
        limits=config.get('servo_limits_deg')
        if limits!=test.get('servo_limits_deg') or not isinstance(limits,list) or len(limits)!=2 or not 0<=limits[0]<limits[1]<=180:
            raise ValueError('Supervised test limits do not match operator-confirmed range')
        if not config.get('serial_port') or self.bridge.config!=config:raise ValueError('Reconnect using the operator-confirmed USB configuration')
        return config

    async def arm_calibration(self,confirmed):
        self.require_idle();self.armed=False;self.calibration_armed=False
        if confirmed is not True:raise ValueError('Explicit operator presence and supervised-test arming required')
        config=self.calibration_config();self.cancel.clear();self.control_busy=True
        try:
            status=await self.status()
            if self.cancel.is_set():raise InterruptedError('Calibration arming stopped')
            if status['completion']!='CALIBRATION' or status['limits']!=config['servo_limits_deg']:
                raise ValueError('Upload the operator-calibration build first; reported test limits must match')
            self.calibration_armed=True
            self.state.update(status='calibration_ready',mode='calibration',message='Supervised servo tests armed. Center first, then choose L or R. These buttons move real hardware; automatic playback remains disabled.')
        finally:self.control_busy=False

    async def start_calibration_move(self,command):
        self.require_idle()
        if not self.calibration_armed:raise ValueError('Arm supervised calibration tests first')
        if command not in ('L','R','C'):raise ValueError('Calibration supports L/R/C; use STOP to interrupt')
        config=self.calibration_config();end=config.get('endpoint_angles_deg',{}).get(command)
        if not isinstance(end,(int,float)) or not math.isfinite(end) or not config['servo_limits_deg'][0]<=end<=config['servo_limits_deg'][1]:
            raise ValueError('Test endpoint exceeds operator-confirmed limits')
        self.cancel.clear();self.job=asyncio.create_task(self.calibration_move(command,end,config))

    async def calibration_move(self,command,end,config):
        started=time.monotonic()
        def guard():
            if self.cancel.is_set():raise InterruptedError('Supervised test stopped')
            if self.config_reader()!=config:raise ValueError('Calibration configuration changed')
        try:
            status=await self.status(guard)
            if status['completion']!='CALIBRATION' or status['limits']!=config['servo_limits_deg']:
                raise ValueError('Firmware is not in the expected supervised test mode')
            if status['angle'] is None and command!='C':raise ValueError('Press Center first to establish the commanded start position')
            self.state.update(status='calibration_moving',mode='calibration',command=command,acknowledged=False,message=f'REAL SERVO TEST: {command} toward {end}°. Waiting for firmware ramp acknowledgement; watch the physical servo.')
            actual=await self.bridge.request(command,self.cancel,config['operator_calibration'].get('command_timeout_s',8),guard)
            guard()
            if not math.isfinite(actual) or abs(actual-end)>.5:raise ValueError('Test endpoint acknowledgement mismatch')
            record=dict(command=command,commanded_endpoint_deg=actual,round_trip_s=round(time.monotonic()-started,3),timestamp=time.time(),physical_completion_verified=False)
            self.state.update(status='calibration_review',test_result=record,command_acknowledged=True,acknowledged=False,
                message=f'{command} command ramp acknowledged at {actual}°. Observe the actual stop and direction. Physical settling and box outcome are NOT yet verified.')
        except Exception as error:
            self.stop();self.state.update(status='failed',message=str(error))

    async def start_keyboard(self,command,armed=False):
        if command=='S':self.stop();return
        self.require_idle()
        if command not in ('L','R','C'):raise ValueError('Keyboard supports L/R/S/C only')
        config=self.config_reader()
        if not armed or not all(config.get(k) is True for k in ('enabled','calibration_verified','completion_verified','acknowledgement_verified')):
            raise ValueError('Keyboard movement requires explicit arming and verified limits/completion')
        if self.bridge.config!=config:raise ValueError('Reconnect after calibration/configuration changes')
        expected=config.get('endpoint_angles_deg',{}).get(command)
        if not isinstance(expected,(int,float)) or not config['servo_limits_deg'][0]<=expected<=config['servo_limits_deg'][1]:
            raise ValueError('Uncalibrated keyboard endpoint')
        self.armed=False;self.cancel.clear()
        self.job=asyncio.create_task(self.keyboard(command,config,expected))

    async def keyboard(self,command,config,expected):
        try:
            def guard():
                if self.cancel.is_set():raise InterruptedError('Keyboard stopped')
                if self.config_reader()!=config:raise ValueError('Calibration changed')
            status=await self.status(guard);self.verify_status(status,config)
            if status['angle'] is None and command!='C':raise ValueError('Home with an explicit armed C first')
            self.state.update(status='sweeping',mode='keyboard',command=command,acknowledged=False)
            end=await self.bridge.request(command,self.cancel,config.get('command_timeout_s',5),guard)
            guard()
            if not math.isfinite(end) or abs(end-expected)>.5:raise ValueError('Keyboard endpoint mismatch')
            self.state.update(status='step_completed',acknowledged=True,message='Keyboard movement acknowledged; box outcome unverified')
        except Exception as error:
            self.stop();self.state.update(status='failed',message=str(error))
