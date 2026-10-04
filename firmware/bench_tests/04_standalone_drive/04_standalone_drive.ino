/*
 * Bench Test 04: standalone drive loop - no PC needed.
 * Board: ESP32 Dev Module (arduino-cli: esp32:esp32:esp32)
 *
 * Power: USB unplugged, L298N 5V terminal -> ESP32 VIN (V5), GND shared. Never with USB plugged in too.
 * Wheels OFF the ground.
 *
 * Loop (plain on/off output, full speed):
 *   5 s wait (LED blinks fast)
 *   LEFT  forward 5 s   (LED 1 blink)  -> pause 3 s
 *   RIGHT forward 5 s   (LED 2 blinks) -> pause 3 s
 *   BOTH  forward 5 s   (LED 3 blinks) -> pause 3 s
 *   BOTH  reverse 5 s   (LED 4 blinks) -> pause 3 s
 *   repeat
 */

#include <Arduino.h>

#define L_IN1 32
#define L_IN2 33
#define R_IN1 25
#define R_IN2 26
#define LED   2

static void set(int in1, int in2, int in3, int in4) {
    digitalWrite(L_IN1, in1); digitalWrite(L_IN2, in2);
    digitalWrite(R_IN1, in3); digitalWrite(R_IN2, in4);
}

static void blinks(int n) {
    for (int i = 0; i < n; i++) { digitalWrite(LED, HIGH); delay(150); digitalWrite(LED, LOW); delay(150); }
}

static void stepRun(const char* name, int n, int a, int b, int c, int d) {
    Serial.printf("[%lus] %s\n", (unsigned long)(millis() / 1000), name);
    blinks(n);
    set(a, b, c, d);
    digitalWrite(LED, HIGH);          // LED on while motors are driven
    delay(5000);
    set(LOW, LOW, LOW, LOW);
    digitalWrite(LED, LOW);
    delay(3000);
}

void setup() {
    const int pins[] = {L_IN1, L_IN2, R_IN1, R_IN2, LED};
    for (int p : pins) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
    Serial.begin(115200);
    Serial.println("\nBench 04 standalone: starting in 5 s");
    for (int i = 0; i < 10; i++) { digitalWrite(LED, i % 2); delay(500); }
}

void loop() {
    stepRun("LEFT  forward", 1, HIGH, LOW,  LOW,  LOW);
    stepRun("RIGHT forward", 2, LOW,  LOW,  HIGH, LOW);
    stepRun("BOTH  forward", 3, HIGH, LOW,  HIGH, LOW);
    stepRun("BOTH  reverse", 4, LOW,  HIGH, LOW,  HIGH);
}
