#pragma once
#include <Arduino.h>
#include "config.h"

class MotorController {
public:
    MotorController();
    void begin();
    void setDrive(int8_t left_throttle, int8_t right_throttle, uint8_t flags, bool limit_speed = false);
    void emergencyBrake();
    void updateFailsafe();
    void notifyPacketReceived();
    void tripFailsafe();
    bool isFailsafeActive() const;

private:
    uint32_t last_packet_time;
    bool failsafe_tripped;

    int throttleToDuty(int8_t throttle, bool invert, bool limit_speed);
    void applyChannelPWM(uint8_t pin1, uint8_t pin2, int duty);
};

extern MotorController motors;
