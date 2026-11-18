/*
 * Bench Test 05: all four wheels forward, full speed, forever. No PC needed.
 * Board: ESP32 Dev Module. WHEELS OFF THE GROUND: this never stops until power is removed.
 *   IN1(GPIO14)=HIGH IN2(GPIO27)=LOW  -> left  forward
 *   IN3(GPIO26)=HIGH IN4(GPIO32)=LOW  -> right forward
 */

#include <Arduino.h>

void setup() {
    pinMode(14, OUTPUT); pinMode(27, OUTPUT);
    pinMode(26, OUTPUT); pinMode(32, OUTPUT);
    digitalWrite(14, HIGH); digitalWrite(27, LOW);
    digitalWrite(26, HIGH); digitalWrite(32, LOW);
    Serial.begin(115200);
}

void loop() {
    Serial.println("FULL FORWARD: IN1=HIGH IN2=LOW IN3=HIGH IN4=LOW");
    delay(2000);
}
