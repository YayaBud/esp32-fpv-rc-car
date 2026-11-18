#include "motor.h"

MotorController motors;

MotorController::MotorController()
    : last_packet_time(0), failsafe_tripped(true), fade_256(256) {}

void MotorController::begin() {
    if (!ledcAttach(MOTOR_L_IN1_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RES)) {
        Serial.println("[MOTOR] ERROR: ledcAttach failed for MOTOR_L_IN1_PIN");
    }
    if (!ledcAttach(MOTOR_L_IN2_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RES)) {
        Serial.println("[MOTOR] ERROR: ledcAttach failed for MOTOR_L_IN2_PIN");
    }
    if (!ledcAttach(MOTOR_R_IN1_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RES)) {
        Serial.println("[MOTOR] ERROR: ledcAttach failed for MOTOR_R_IN1_PIN");
    }
    if (!ledcAttach(MOTOR_R_IN2_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RES)) {
        Serial.println("[MOTOR] ERROR: ledcAttach failed for MOTOR_R_IN2_PIN");
    }

    emergencyBrake();
}

int MotorController::throttleToDuty(int8_t throttle, bool invert, bool limit_speed) {
    int t = constrain((int)throttle, -100, 100);
    if (t == 0) return 0;

    int mag = abs(t);
    int duty = MOTOR_MIN_DUTY + (mag * (255 - MOTOR_MIN_DUTY) + 50) / 100;
    if (t < 0) duty = -duty;

    if (limit_speed) duty = duty * 60 / 100;
    if (invert) duty = -duty;

    return duty;
}

void MotorController::applyChannelPWM(uint8_t pin1, uint8_t pin2, int duty) {
    if (duty > 0) {
        ledcWrite(pin1, duty);
        ledcWrite(pin2, 0);
    } else if (duty < 0) {
        ledcWrite(pin1, 0);
        ledcWrite(pin2, -duty);
    } else {
        // Both LOW: with the L298N EN jumpers on this is a fast stop, not a coast
        ledcWrite(pin1, 0);
        ledcWrite(pin2, 0);
    }
}

void MotorController::emergencyBrake() {
    // Dynamic short brake (both HIGH on both channels)
    ledcWrite(MOTOR_L_IN1_PIN, 255);
    ledcWrite(MOTOR_L_IN2_PIN, 255);
    ledcWrite(MOTOR_R_IN1_PIN, 255);
    ledcWrite(MOTOR_R_IN2_PIN, 255);
}

void MotorController::setDrive(int8_t left_throttle, int8_t right_throttle, uint8_t flags, bool limit_speed) {
    if (failsafe_tripped || (flags & 0x01)) {
        emergencyBrake();
        return;
    }

    int left_duty  = throttleToDuty(left_throttle, MOTOR_L_INVERT, limit_speed);
    int right_duty = throttleToDuty(right_throttle, MOTOR_R_INVERT, limit_speed);
    left_duty  = left_duty * fade_256 / 256;
    right_duty = right_duty * fade_256 / 256;

    applyChannelPWM(MOTOR_L_IN1_PIN, MOTOR_L_IN2_PIN, left_duty);
    applyChannelPWM(MOTOR_R_IN1_PIN, MOTOR_R_IN2_PIN, right_duty);
}

void MotorController::notifyPacketReceived() {
    last_packet_time = millis();
    failsafe_tripped = false;
    fade_256 = 256;
}

void MotorController::tripFailsafe() {
    failsafe_tripped = true;
    emergencyBrake();
}

void MotorController::updateFailsafe() {
    if (failsafe_tripped) return;
    uint32_t gap = millis() - last_packet_time;
    if (gap > FAILSAFE_BRAKE_MS) {
        failsafe_tripped = true;
        fade_256 = 0;
        emergencyBrake();
    } else if (gap > FAILSAFE_HOLD_MS) {
        fade_256 = (int)((FAILSAFE_BRAKE_MS - gap) * 256 / (FAILSAFE_BRAKE_MS - FAILSAFE_HOLD_MS));
    } else {
        fade_256 = 256;
    }
}

bool MotorController::isFailsafeActive() const {
    return failsafe_tripped;
}
