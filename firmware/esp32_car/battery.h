#pragma once
#include <Arduino.h>
#include "config.h"

enum BatteryStatus {
    BATT_OK,
    BATT_WARNING,     // <= 7.0 V
    BATT_LIMITING,    // <= 6.6 V (throttle capped at 60%)
    BATT_SHUTDOWN,    // <= 6.2 V sustained > 3s
    BATT_NO_SENSOR    // ADC disabled or divider reads below BATTERY_PRESENT_MIN_MV
};

class BatteryMonitor {
public:
    BatteryMonitor();
    void begin();
    void update();
    uint16_t getPackMilliVolts() const;
    BatteryStatus getStatus() const;
    bool isThrottleLimited() const;
    bool isHardCutoff() const;
    bool isSensorPresent() const;

private:
    uint16_t pack_mv;
    BatteryStatus status;
    uint32_t cutoff_start_time;
    bool cutoff_active;

    uint32_t readTrimmedAverage();
};

extern BatteryMonitor battery;
