#include <Arduino_RouterBridge.h>
#include <HardwareServo.h>

#ifndef GEKKO_OPERATOR_CALIBRATION
#define GEKKO_OPERATOR_CALIBRATION 0
#endif

// Match these to measured rig calibration before enabling any movement.
// Merely changing a flag is NOT a measurement. Defaults cannot move the servo.
const bool MOTION_CALIBRATED = false;
const bool COMPLETION_TIME_VERIFIED = false;
const char CALIBRATION_ID[] = "UNVERIFIED";
const int SERVO_PIN = 9;
const int CALIBRATED_MIN_PULSE_US = 500, CALIBRATED_MAX_PULSE_US = 2500;
const int MIN_ANGLE = 0, MAX_ANGLE = 180, CENTER_ANGLE = 90;
// Preserve the operator's existing firmware semantics; letters are not directions.
const int L_ANGLE = 180, R_ANGLE = 0;
const int STEP_DEGREES = 1;
const unsigned long STEP_MS = 10, VERIFIED_SETTLE_MS = 500;
// Optional tilt sensor, calibrated independently against an inclinometer.
const bool TILT_SENSOR_CALIBRATED = false;
const float TILT_DEG_PER_ADC = 0.0f, TILT_ZERO_DEG = 0.0f;
const int TILT_PIN = A0;

HardwareServo sweeper;
int currentAngle = CENTER_ANGLE, targetAngle = CENTER_ANGLE;
bool moving = false, settling = false, positionKnown = false;
unsigned long lastStep = 0, reachedAt = 0;
String incoming, activeId;
char activeCommand = 0;

void reply(const char *kind, const String &id, const String &details) {
  Monitor.print(kind); Monitor.print(" "); Monitor.print(id);
  Monitor.print(" "); Monitor.println(details);
}

void command(char cmd, const String &id) {
  if (cmd == '?') {
    String tilt = TILT_SENSOR_CALIBRATED ? String(analogRead(TILT_PIN) * TILT_DEG_PER_ADC + TILT_ZERO_DEG, 2) : "NA";
    reply("STATUS", id, (positionKnown ? String(currentAngle) : String("NA")) + " " + tilt + " " + CALIBRATION_ID + " " + MIN_ANGLE + " " + MAX_ANGLE + " " +
          (MOTION_CALIBRATED && COMPLETION_TIME_VERIFIED ? "VERIFIED" : GEKKO_OPERATOR_CALIBRATION ? "CALIBRATION" : "UNVERIFIED"));
    return;
  }
  if (cmd == 'S') {
    moving = settling = false; targetAngle = currentAngle; positionKnown = false;
    activeId = ""; activeCommand = 0;
    reply("DONE", id, String("S ") + currentAngle); // stopped command ramp, not emergency power removal
    return;
  }
  if (cmd != 'L' && cmd != 'R' && cmd != 'C') { reply("ERROR", id, "UNKNOWN_COMMAND"); return; }
  // Build-time opt-in permits individual framed operator tests only. It does
  // not assert measured completion or enable host automatic-plan validation.
  bool operatorTest = GEKKO_OPERATOR_CALIBRATION && id != "raw";
  if ((!MOTION_CALIBRATED || !COMPLETION_TIME_VERIFIED) && !operatorTest) { reply("ERROR", id, "CALIBRATION_REQUIRED"); return; }
  if (!positionKnown && cmd != 'C') { reply("ERROR", id, "HOME_WITH_C_FIRST"); return; }
  if (moving || settling) { reply("ERROR", id, "BUSY"); return; }
  int end = cmd == 'L' ? L_ANGLE : cmd == 'R' ? R_ANGLE : CENTER_ANGLE;
  if (end < MIN_ANGLE || end > MAX_ANGLE) { reply("ERROR", id, "LIMIT"); return; }
  if (!sweeper.attached() && sweeper.attach(SERVO_PIN, CALIBRATED_MIN_PULSE_US, CALIBRATED_MAX_PULSE_US) == INVALID_SERVO) { reply("ERROR", id, "ATTACH"); return; }
  targetAngle = end; activeId = id; activeCommand = cmd;
  if (!positionKnown) {
    // Explicit armed C is the only homing movement; its full-travel settling
    // bound must also have been measured before COMPLETION_TIME_VERIFIED.
    currentAngle = CENTER_ANGLE; sweeper.write(currentAngle);
    moving = false; settling = true; reachedAt = millis();
  } else { moving = true; settling = false; lastStep = millis(); }
}

void setup() {
  Bridge.begin(); Monitor.begin(115200);
  // No attach, centre command or movement on boot / USB connection.
}

void loop() {
  while (Monitor.available()) {
    char ch = Monitor.read();
    if (incoming.length()) {
      if (ch == '\n') {
        int space = incoming.indexOf(' ');
        if (space > 1 && incoming.length() == (unsigned int)space + 2)
          command(incoming[space + 1], incoming.substring(1, space));
        else reply("ERROR", "raw", "BAD_FRAME");
        incoming = "";
      } else if (ch != '\r') {
        if (incoming.length() < 70) incoming += ch;
        else { incoming = ""; command('S', "overflow"); }
      }
    } else if (ch == '@') incoming = "@";
    else if (ch == 'L' || ch == 'R' || ch == 'S' || ch == 'C' || ch == '?') command(ch, "raw");
    else if (ch >= 'a' && ch <= 'z') command(ch - 'a' + 'A', "raw");
  }
  if (moving && millis() - lastStep >= STEP_MS) {
    lastStep = millis();
    if (currentAngle < targetAngle) currentAngle = min(currentAngle + STEP_DEGREES, targetAngle);
    else if (currentAngle > targetAngle) currentAngle = max(currentAngle - STEP_DEGREES, targetAngle);
    sweeper.write(currentAngle);
    if (currentAngle == targetAngle) { moving = false; settling = true; reachedAt = millis(); }
  }
  if (settling && millis() - reachedAt >= VERIFIED_SETTLE_MS) {
    settling = false; positionKnown = true;
    // VERIFIED mode: calibrated ramp + measured conservative settling bound.
    // CALIBRATION mode: command-ramp acknowledgement only; operator must observe.
    // HardwareServo.read() is only the commanded PWM, never a position sensor.
    reply("DONE", activeId, String(activeCommand) + " " + currentAngle);
    activeId = ""; activeCommand = 0;
  }
}
