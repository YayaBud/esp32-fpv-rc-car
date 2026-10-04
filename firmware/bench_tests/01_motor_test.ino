/*
 * Bench Test 01: L298N + 4 motors (tank) - wiring, direction, start duty. Interactive, with debug logs.
 * Board: ESP32 Dev Module (arduino-cli: esp32:esp32:esp32)
 *
 * !! RUN WITH THE WHEELS OFF THE GROUND (car on a box) !!
 *
 * Wiring (L298N <- ESP32):
 *   IN1 <- GPIO32   IN2 <- GPIO33   (left side: OUT1/OUT2, two motors in parallel)
 *   IN3 <- GPIO25   IN4 <- GPIO26   (right side: OUT3/OUT4, two motors in parallel)
 *   ENA, ENB: keep the board jumpers ON.   GND <-> GND.   12V terminal <- battery +.
 *   ESP32 powered from USB.
 *
 * Nothing moves at boot. Send a line over the Serial Monitor (115200 baud, newline):
 *   l <duty>   left side only      r <duty>   right side only     (duty -255..255, default 150)
 *   b <duty>   both sides          p <duty>   pivot (left +, right -)
 *   s          stop                k          short-brake
 *   ramp       duty 0..255 ramp (note where the wheels start turning; PWM mode only)
 *   auto       full test cycle     status     print state     ?   help
 *   pads       measure what each pin is REALLY doing at the chip (not just the PWM register)
 *   selftest   drive one pin at a time and measure all four pads (finds shorts / dead pins)
 *   mode pwm|dig   PWM peripheral (normal) or plain digitalWrite (bypasses PWM entirely; any duty = full)
 *   hold <s>   how long a motion command runs before auto-stop (1-30 s, default 2)
 * A heartbeat line is printed every 10 s so a freeze or USB drop shows up as a gap in the log.
 */

#include <Arduino.h>
#include <driver/gpio.h>
#include <esp_system.h>
#include <stdarg.h>

#define L_IN1 32
#define L_IN2 33
#define R_IN1 25
#define R_IN2 26

#define PWM_FREQ 5000
#define PWM_RES  8
#define FULL_ON  255   // ledcWrite(pin, 255) at 8-bit = 100% on (ledcRead reports it as 256)

static const int PINS[4] = {L_IN1, L_IN2, R_IN1, R_IN2};
static const char* NAMES[4] = {"IN1", "IN2", "IN3", "IN4"};

static bool digitalMode = false;    // false = LEDC PWM on the IN pins, true = plain digitalWrite
static uint32_t runMs = 2000;       // motion command duration before auto-stop
static uint32_t stopAt = 0;
static uint32_t lastBeat = 0;
static int cmdDuty[4] = {0, 0, 0, 0};   // last value written to each pin (0..255)
static int curL = 0, curR = 0;
static bool braked = true;
static esp_reset_reason_t bootReason;

static void logf(const char* fmt, ...) {
    char buf[224];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    Serial.printf("[%8.3f] %s\n", millis() / 1000.0, buf);
}

static const char* resetReasonName(esp_reset_reason_t r) {
    switch (r) {
        case ESP_RST_POWERON:   return "POWERON (normal power-up)";
        case ESP_RST_SW:        return "SW (software reset)";
        case ESP_RST_PANIC:     return "PANIC (crash!)";
        case ESP_RST_INT_WDT:
        case ESP_RST_TASK_WDT:
        case ESP_RST_WDT:       return "WATCHDOG (program hung!)";
        case ESP_RST_BROWNOUT:  return "BROWNOUT (supply voltage dipped: power problem!)";
        case ESP_RST_EXT:       return "EXT (reset button / USB DTR)";
        case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
        default:                return "OTHER";
    }
}

// What the pin is ACTUALLY doing at the chip pad, not what the PWM register says: samples the pad's
// input buffer for ~12 ms (about 60 PWM periods at 5 kHz) and returns the % of samples that were HIGH.
static int padPercent(int pin) {
    const int N = 2000;
    int high = 0;
    for (int i = 0; i < N; i++) {
        high += gpio_get_level((gpio_num_t)pin);
        delayMicroseconds(5);
    }
    return (high * 100 + N / 2) / N;
}

// LEDC leaves the pad's input buffer off, so gpio_get_level() would always read 0. This only enables
// reading; it does not touch the output routing.
static void enablePadReadback() {
    for (int p : PINS) gpio_input_enable((gpio_num_t)p);
}

// The PWM hardware only latches a new duty at the start of its next period (0.2 ms), so wait first.
static void report(const char* what) {
    delay(3);
    unsigned reg[4];
    int pad[4];
    for (int i = 0; i < 4; i++) {
        reg[i] = digitalMode ? (cmdDuty[i] > 0 ? 256 : 0) : ledcRead(PINS[i]);
        pad[i] = padPercent(PINS[i]);
    }
    logf("%s | %s set: IN1(GPIO32)=%u IN2(GPIO33)=%u IN3(GPIO25)=%u IN4(GPIO26)=%u | PAD%%HIGH: IN1=%d IN2=%d IN3=%d IN4=%d",
         what, digitalMode ? "DIG" : "PWM", reg[0], reg[1], reg[2], reg[3], pad[0], pad[1], pad[2], pad[3]);
}

static void setPin(int idx, int duty) {          // duty 0..255
    cmdDuty[idx] = duty;
    if (digitalMode) digitalWrite(PINS[idx], duty > 0 ? HIGH : LOW);
    else ledcWrite(PINS[idx], duty);
}

// duty -255..255. 0 = fast stop (EN jumpers on: both inputs LOW shorts the motor).
static void side(int idxIn1, int idxIn2, int duty) {
    setPin(idxIn1, duty > 0 ? duty : 0);
    setPin(idxIn2, duty < 0 ? -duty : 0);
}

static void drive(int left, int right) {
    left = constrain(left, -255, 255);
    right = constrain(right, -255, 255);
    side(0, 1, left);
    side(2, 3, right);
    curL = left; curR = right; braked = false;
    char what[48];
    snprintf(what, sizeof what, "DRIVE L=%+4d R=%+4d", left, right);
    report(what);
}

static void brake() {
    for (int i = 0; i < 4; i++) setPin(i, FULL_ON);
    curL = curR = 0; braked = true;
    report("BRAKE (all four pins full on)");
}

static void setMode(bool dig) {
    for (int i = 0; i < 4; i++) setPin(i, 0);
    for (int i = 0; i < 4; i++) {
        int pin = PINS[i];
        if (dig) {
            ledcDetach(pin);
            pinMode(pin, OUTPUT);
            digitalWrite(pin, LOW);
        } else {
            bool ok = ledcAttach(pin, PWM_FREQ, PWM_RES);
            ledcWrite(pin, 0);
            if (!ok) logf("ledcAttach %s GPIO%d FAILED", NAMES[i], pin);
        }
        cmdDuty[i] = 0;
    }
    digitalMode = dig;
    enablePadReadback();
    curL = curR = 0; braked = false;
    report(dig ? "MODE DIGITAL (no PWM peripheral; any duty = full on)" : "MODE PWM");
}

static void selftest() {
    logf("SELFTEST (%s): one pin HIGH at a time, measure all four pads", digitalMode ? "DIGITAL" : "PWM");
    int bad = 0;
    for (int i = 0; i < 4; i++) {
        for (int j = 0; j < 4; j++) setPin(j, j == i ? FULL_ON : 0);
        delay(3);
        int pad[4];
        bool ok = true;
        for (int j = 0; j < 4; j++) {
            pad[j] = padPercent(PINS[j]);
            ok = ok && (j == i ? pad[j] >= 99 : pad[j] <= 1);
        }
        if (!ok) bad++;
        logf("  only %s HIGH -> PAD%%HIGH: IN1=%d IN2=%d IN3=%d IN4=%d  %s",
             NAMES[i], pad[0], pad[1], pad[2], pad[3], ok ? "OK" : "WRONG");
    }
    for (int j = 0; j < 4; j++) setPin(j, 0);
    delay(3);
    int low[4];
    bool lowOk = true;
    for (int j = 0; j < 4; j++) { low[j] = padPercent(PINS[j]); lowOk = lowOk && low[j] <= 1; }
    if (!lowOk) bad++;
    logf("  all LOW      -> PAD%%HIGH: IN1=%d IN2=%d IN3=%d IN4=%d  %s", low[0], low[1], low[2], low[3], lowOk ? "OK" : "WRONG");
    if (!digitalMode) {
        setPin(0, 128);
        delay(3);
        int p = padPercent(L_IN1);
        setPin(0, 0);
        bool ok = abs(p - 50) <= 5;
        if (!ok) bad++;
        logf("  IN1 at duty 128/256 -> pad %d%% HIGH (expect ~50)  %s", p, ok ? "OK" : "WRONG");
    }
    curL = curR = 0; braked = false;
    logf("SELFTEST %s: %d problem(s)", bad ? "FAILED" : "PASSED", bad);
}

static void step(const char* msg, int left, int right, int ms) {
    logf("STEP: %s", msg);
    drive(left, right);
    delay(ms);
    drive(0, 0);
    delay(800);
}

static void ramp() {
    if (digitalMode) { logf("ramp needs PWM mode (send: mode pwm)"); return; }
    logf("RAMP: watch the wheels, note the duty where they start turning");
    for (int d = 0; d <= 255; d += 5) {
        drive(d, d);
        delay(400);
    }
    drive(0, 0);
    logf("RAMP done. Set MOTOR_MIN_DUTY a little above the start duty (the floor needs more than in the air).");
}

static void autoCycle() {
    logf("== A. one side at a time ==");
    step("LEFT  forward : both LEFT wheels must roll FORWARD",  200, 0, 2000);
    step("LEFT  reverse",                                      -200, 0, 2000);
    step("RIGHT forward : both RIGHT wheels must roll FORWARD", 0, 200, 2000);
    step("RIGHT reverse",                                       0, -200, 2000);
    logf("== B. start duty ==");
    ramp();
    logf("== C. pivot ==");
    step("Pivot LEFT  (left back, right fwd)", -180, 180, 1500);
    step("Pivot RIGHT (left fwd, right back)",  180, -180, 1500);
    logf("== D. brake: full speed then short-brake ==");
    drive(255, 255);
    delay(1000);
    brake();
    delay(1500);
    drive(0, 0);
    logf("AUTO cycle done.");
}

static void status() {
    logf("STATUS uptime=%lus boot=%s mode=%s hold=%lums freeHeap=%u curL=%d curR=%d braked=%d",
         (unsigned long)(millis() / 1000), resetReasonName(bootReason), digitalMode ? "DIG" : "PWM",
         (unsigned long)runMs, (unsigned)ESP.getFreeHeap(), curL, curR, braked);
    report("pins");
    logf("NOTE: the ESP32 cannot see the battery or the motors. Pads correct but nothing turns = the problem is after the ESP32 pin.");
}

static void help() {
    logf("commands: l|r|b|p <duty>, s, k, ramp, auto, status, pads, selftest, mode pwm|dig, hold <s>, ?   (motion runs %lu ms)",
         (unsigned long)runMs);
}

static void startMotion(int left, int right) {
    drive(left, right);
    stopAt = millis() + runMs;
}

static void run(const String& line) {
    char cmd[16] = {0}, arg[16] = {0};
    int n = sscanf(line.c_str(), "%15s %15s", cmd, arg);
    if (n < 1) return;
    int duty = n >= 2 ? atoi(arg) : 150;
    logf("CMD '%s'%s%s", cmd, n >= 2 ? " " : "", arg);

    if (!strcmp(cmd, "l"))             startMotion(duty, 0);
    else if (!strcmp(cmd, "r"))        startMotion(0, duty);
    else if (!strcmp(cmd, "b"))        startMotion(duty, duty);
    else if (!strcmp(cmd, "p"))        startMotion(duty, -duty);
    else if (!strcmp(cmd, "s"))        { drive(0, 0); stopAt = 0; }
    else if (!strcmp(cmd, "k"))        { brake(); stopAt = 0; }
    else if (!strcmp(cmd, "ramp"))     ramp();
    else if (!strcmp(cmd, "auto"))     autoCycle();
    else if (!strcmp(cmd, "status"))   status();
    else if (!strcmp(cmd, "pads"))     report("pads");
    else if (!strcmp(cmd, "selftest")) { stopAt = 0; selftest(); }
    else if (!strcmp(cmd, "hold"))     { runMs = constrain(n >= 2 ? atoi(arg) : 2, 1, 30) * 1000UL; logf("hold = %lu ms", (unsigned long)runMs); }
    else if (!strcmp(cmd, "mode") && !strcmp(arg, "dig")) { stopAt = 0; setMode(true); }
    else if (!strcmp(cmd, "mode") && !strcmp(arg, "pwm")) { stopAt = 0; setMode(false); }
    else                                help();
}

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println();
    bootReason = esp_reset_reason();
    logf("=== Bench 01 v3 (interactive + pad readback) booting ===");
    logf("chip=%s rev=%d cpu=%dMHz sdk=%s", ESP.getChipModel(), (int)ESP.getChipRevision(),
         (int)ESP.getCpuFreqMHz(), ESP.getSdkVersion());
    logf("reset reason: %s", resetReasonName(bootReason));

    for (int i = 0; i < 4; i++) {
        bool ok = ledcAttach(PINS[i], PWM_FREQ, PWM_RES);
        logf("ledcAttach %s GPIO%d @%dHz %d-bit: %s", NAMES[i], PINS[i], PWM_FREQ, PWM_RES, ok ? "OK" : "FAILED");
    }
    enablePadReadback();
    brake();
    logf("READY. Idle: nothing moves until a command is sent. Wheels must be OFF the ground.");
    help();
}

void loop() {
    if (Serial.available()) {
        String line = Serial.readStringUntil('\n');
        line.trim();
        if (line.length()) run(line);
    }
    if (stopAt && (int32_t)(millis() - stopAt) >= 0) {
        stopAt = 0;
        drive(0, 0);
        logf("auto-stop (command timeout)");
    }
    if (millis() - lastBeat >= 10000) {
        lastBeat = millis();
        logf("heartbeat uptime=%lus mode=%s L=%d R=%d", (unsigned long)(millis() / 1000), digitalMode ? "DIG" : "PWM", curL, curR);
    }
}
