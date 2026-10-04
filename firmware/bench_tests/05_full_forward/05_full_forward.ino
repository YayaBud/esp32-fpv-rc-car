/*
 * Bench Test 05: all four wheels forward, full speed, forever. No PC needed.
 * Board: ESP32 Dev Module. WHEELS OFF THE GROUND: this never stops until power is removed.
 *   IN1(GPIO32)=HIGH IN2(GPIO33)=LOW  -> left  forward
 *   IN3(GPIO25)=HIGH IN4(GPIO26)=LOW  -> right forward
 */

#include <Arduino.h>

void setup() {
    pinMode(32, OUTPUT); pinMode(33, OUTPUT);
    pinMode(25, OUTPUT); pinMode(26, OUTPUT);
    digitalWrite(32, HIGH); digitalWrite(33, LOW);
    digitalWrite(25, HIGH); digitalWrite(26, LOW);
    Serial.begin(115200);
}

void loop() {
    Serial.println("FULL FORWARD: IN1=HIGH IN2=LOW IN3=HIGH IN4=LOW");
    delay(2000);
}
