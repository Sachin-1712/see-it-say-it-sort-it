# Saved-plan playback

```sh
.venv/bin/pip install -r requirements-sim.txt
# Offline export: genuine MuJoCo agents, >=80% and >=20 full-plan trials:
.venv/bin/python -m scripts.prepare_demo --workers 4 --timeout 180
# Inspect the accepted action order and action-profile keys without search:
.venv/bin/python -m scripts.prepare_demo --inspect
.venv/bin/python -m swarm.server
# Separate terminal:
.venv/bin/python -m http.server 8000 --bind 127.0.0.1
```

Open http://127.0.0.1:8000/viewer/?offline=1. Load Three-Box Demo → Load Saved
Plan → Preview or Start Timed Dry Run. Loading/previewing uses the original
validated evidence and trajectories, never reruns search. Scenario, fixture,
physics/configuration, hardware configuration, source and engine hashes must match;
the existing 24-hour expiry and 80%/20-trial requirements remain. The cached file
is local at `.gekko/validated-three-box.json`. Regenerate after calibration changes.

The timed dry run needs one Start click. It follows the saved action order and
waits a full three seconds after each simulated sweep before the next simulated
movement. No sweep bytes are transmitted, and no physical completion is claimed.
Required **MANUAL tilt** is displayed throughout the next-step countdown. A timer
does not verify tilt or servo completion.

## Real hardware prerequisites

Defaults stay disabled. No physical UNO Q was commanded or flashed during this
implementation. The supplied sketch compiled for `arduino:zephyr:unoq` with the
locally installed RouterBridge 0.4.4 and HardwareServo 0.0.1 libraries.

1. Measure real travel and direction with servo power readily disconnectable.
   The inspected local sketch maps L to 180° and R to 0°; **these are command
   endpoints, not a claim of physical left/right**. Record measured mapping in
   `config/uno-q.json`: `direction_commands.increasing/decreasing`,
   `endpoint_angles_deg`, `servo_limits_deg`, `tilt_limits_deg` and `calibration_id`.
2. Review `firmware/gekko_playback/gekko_playback.ino`. Set the actual pin, verified
   angle/pulse range, measured ramp and conservative settling time. Set
   `MOTION_CALIBRATED`, `COMPLETION_TIME_VERIFIED` and `CALIBRATION_ID` only after
   measurement; false defaults refuse movement. Install/flash through Arduino IDE
   after review. Boot/connection does not attach the servo or move it to centre.
   Initial position is reported as NA. Establish it with an explicit armed
   keyboard C (including a verified full-travel settling bound), then verify the
   first profile position. Stop marks the position unknown and requires re-homing.
3. Verify DONE arrival against actual servo settling under load and record
   `completion_verified:true`, `acknowledgement_verified:true` and a
   `completion_verification_id`. DONE acknowledges a measured ramp/settle mechanism,
   **not encoder feedback and not a sorted box**. `HardwareServo.read()` reports
   commanded PWM; it is not used as a motion sensor.
4. Multi-angle manual tilt needs an actual calibrated tilt sensor before each
   physical sweep. Configure the sketch's ADC scale/offset and sensor flag, and
   `tilt_verification` with mode `sensor`, verified true, calibration ID and a
   measured tolerance no larger than 1°. Missing/wrong tilt stops before the sweep.
   `fixed` mode accepts a calibrated mechanical angle only if it satisfies **every**
   saved action. A fixed can cannot satisfy this plan's different tilt angles;
   use a sensor or the timed dry run. GEKKO never adjusts the tilt itself.
5. Endpoint firmware cannot reproduce arbitrary simulated start/end/speed values
   by direction alone. Physically validate each complete sweep under the real
   ramp, scene and tilt. Under `action_profiles`, use the full `action_hash` printed
   by `--inspect` as the key. Each measured record has `verified:true`, `command`,
   `start_deg`, `end_deg`, `timeout_s` (0–30 seconds). It certifies this physical
   endpoint sweep against that saved action, including timing. The initial servo
   angle must match the first profile; subsequent start angles must match the last
   endpoint. Hidden repositioning is refused. Do not mark an untested profile true.
6. Connect auto-detects one attached UNO Q when `serial_port` is unset and
   displays a persistent connecting/success/error message. Multiple devices require
   an explicit selection in configuration. For real execution, set the calibrated
   USB device (`serial_port`, e.g. `/dev/cu.usbmodem...`), baud, and
   `enabled:true`. Re-export after configuration changes, then reload the bundle.
   Close external `servo_keys.py` and Serial Monitor. Connect UNO Q → Arm Hardware
   Once → **Start Hardware Playback**. Arming is consumed by Start. No clicks are
   needed between steps; every next motion still needs verified tilt and position.

The bridge holds a per-device process lock and POSIX exclusive-open lock; macOS
cu/tty aliases share ownership. It refuses an already-open port. The GEKKO keyboard
client shares this service and cannot interrupt playback with a sweep:

```sh
.venv/bin/python -m scripts.servo_keys --arm
# L/R/C: calibrated keyboard movement; S/Escape/Q: stop/quit.
```

Raw firmware L/R/S/C keyboard control is preserved when calibration is enabled.
Discovery uses digits-only IDs so legacy character-at-a-time firmware cannot
interpret a `c` inside an ID as Centre. The status query itself never requests a
sweep. Service commands use `@<unique-id> <L|R|S|C|?>\n`; no G/P is transmitted. Firmware
replies with correlated `STATUS`, `DONE` or `ERROR`. STATUS includes angle, tilt
(or NA), calibration ID, limits and verified-completion state. Stale DONE replies
cannot complete a new action. STOP bypasses the running request and cancels future
steps; the UI says sent/acknowledgement pending, not physically stopped.
**Disconnect servo power for an immediate physical stop.** S stops further command
ramping; it cannot remove power or eliminate mechanical inertia.

Connection loss, acknowledgement timeout, bad endpoint/tilt, source/scene/config
change, control-client disconnect or Stop aborts playback. Nothing auto-restarts.
An interrupted sequence requires a physical scene reset and fresh arming.

## Verification

```sh
.venv/bin/python -m pytest tests/test_playback.py tests/test_demo.py tests/test_swarm.py -q
npm test --prefix tests
'/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli' \
  compile --fqbn arduino:zephyr:unoq firmware/gekko_playback
```

Tests use a pseudo-terminal firmware mock through real pyserial: exclusive port
ownership, stale DONE rejection, timeouts/disconnection, a real three-second gap,
one-start three-action playback, Stop, wrong tilt and disabled calibration.
No mock acknowledgement is presented as a result from the physical UNO Q.

API references: [Arduino RouterBridge](https://github.com/arduino-libraries/Arduino_RouterBridge)
and [Arduino HardwareServo](https://github.com/arduino-libraries/Arduino_HardwareServo).
Remaining hardware blockers: measured direction/travel/action profiles, actual
completion timing, actual tilt verification and confirmation of the board's USB
Monitor route. The firmware is compiled, not physically verified.
