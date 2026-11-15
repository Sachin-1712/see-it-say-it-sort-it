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

The timed dry run needs one Start click and never moves the real servo. It
animates yellow outlines from stored MuJoCo body trajectories. If a scene edit
unloads the plan, reload the matching demo and saved plan; the disabled button
explains this prerequisite. It follows the saved action order and
waits a full three seconds after each complete stored trajectory before the next simulated
movement. No sweep bytes are transmitted, and no physical completion is claimed.
Required **MANUAL tilt** is displayed throughout the next-step countdown. A timer
does not verify tilt or servo completion.

## Real hardware prerequisites

The current rig has now been flashed and its endpoint tests observed by the operator; see the confirmation record below. Movement still requires explicit arming. The supplied sketch compiled for `arduino:zephyr:unoq` with the
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

## Supervised endpoint calibration on this rig

The operator confirmed full 0–180° travel and L toward the RED/LEFT bin (viewed
from behind the sweeper). Those observations are recorded in `operator_calibration`
in `config/uno-q.json`; they do not certify settling, action profiles or tilt.

The explicit `GEKKO_OPERATOR_CALIBRATION=1` firmware build permits individual,
framed operator tests and reports `CALIBRATION`, never `VERIFIED`. The default
build still refuses motion without full calibration. Boot never moves the servo.

Connect UNO Q, check the operator-presence box, then **Arm supervised tests**.
Press **Center · C** first, then one **L · RED bin** or **R · BLUE bin** command
at a time while observing the real mechanism. STOP cancels and disarms tests.
A command-ramp acknowledgement is shown separately from physical completion.
Keep hands clear of the arm and keep servo-power disconnection within reach.

For the same controls from a terminal, through the single serial owner:

```sh
.venv/bin/python -m scripts.servo_keys --calibration --arm
```

The can has no tilt sensor. This supervised mode does not unlock automatic
three-step saved-plan execution. Completion timing and each physical action
profile still require observation/testing; the software never marks them
verified from a command acknowledgement alone.


To rebuild the exact supervised-test firmware (stop the GEKKO server first so
only the upload tool owns USB):

```sh
arduino-cli compile --fqbn arduino:zephyr:unoq \
  --build-property compiler.cpp.extra_flags=-DGEKKO_OPERATOR_CALIBRATION=1 \
  --build-path /tmp/gekko-operator-calibration-build firmware/gekko_playback
arduino-cli upload --fqbn arduino:zephyr:unoq \
  --port /dev/cu.usbmodem42325750942 \
  --build-path /tmp/gekko-operator-calibration-build firmware/gekko_playback
```


## Endpoint calibration confirmed for this UNO Q

On 2026-11-15 the operator reported that C centres and stops, and both L/R endpoint
sweeps fully stop before their command-ramp acknowledgement. The recorded range is
0–180°, L routes toward RED/LEFT, and R toward BLUE/RIGHT. This rig's firmware and
configuration use calibration ID `gekko-unoq-20261115-endpoints-v1`.

Device arming now checks that endpoint calibration, limits, completion evidence,
USB configuration and firmware ID match. It does not claim tilt or three-box
sorting is verified. Automatic-plan readiness is a separate check, with its reason
shown beside Start Hardware Playback. Manual tilt without a sensor still prevents
unattended playback; no physical three-box action profiles have been certified.
The firmware flags in this checkout describe this specific tested rig, not a
factory calibration suitable for another servo.


## Automatic servo-only demo (operator-authorized manual tilt)

The operator explicitly chose automatic endpoint motion with hand-adjusted tilt,
without claiming verified box sorting. This is a separate mode from verified
three-box physical-plan execution; the stricter tilt/action-profile checks remain
in force for that mode.

Load Three-Box Demo → Load Saved Plan → Connect UNO Q → Arm Hardware Once →
**Start Automatic Servo Demo**. Only Start is needed during the sequence. It uses
the saved action order and calibrated direction mapping, sends each endpoint
command once, waits for the correlated DONE and then a full three seconds before
the next movement. If the firmware reports an unknown initial position, Start
first centres the servo with C and waits DONE + three seconds before step 1.
Set the first displayed manual tilt before Start; adjust the next tilt during the
countdown. The can is not moved or verified by GEKKO. The status explicitly says
manual tilt and box sorting are unverified; simulated start angles/speeds are not
claimed to be reproduced by this endpoint-only firmware.

STOP, lost connection/position, timeout, scenario/calibration mismatch and owner
client disconnect interrupt the sequence. There is no automatic restart. No
per-step confirmation is requested. The wire command is
`{"cmd":"hardware_start","mode":"servo_demo","manual_tilt":true}`; the mode
still requires explicit device arming and all saved-plan identity/evidence checks.
