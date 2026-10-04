#include "battery.h"

BatteryMonitor battery;

BatteryMonitor::BatteryMonitor()
    : pack_mv(8400), status(BATT_OK), cutoff_start_time(0), cutoff_active(false) {}

void BatteryMonitor::begin() {
#if BATTERY_ADC_PIN >= 0
    // MANDATORY: Explicit 11 dB attenuation configuration (0.15 - 3.1 V range)
    analogSetPinAttenuation(BATTERY_ADC_PIN, ADC_11db);
    update();
#else
    status = BATT_NO_SENSOR;
    pack_mv = 0;
#endif
}

uint32_t BatteryMonitor::readTrimmedAverage() {
    const int NUM_SAMPLES = 32;
    uint32_t samples[NUM_SAMPLES];

    for (int i = 0; i < NUM_SAMPLES; i++) {
        samples[i] = analogReadMilliVolts(BATTERY_ADC_PIN);
        delayMicroseconds(300);
    }

    // Sort to eliminate outliers
    for (int i = 0; i < NUM_SAMPLES - 1; i++) {
        for (int j = 0; j < NUM_SAMPLES - i - 1; j++) {
            if (samples[j] > samples[j + 1]) {
                uint32_t temp = samples[j];
                samples[j] = samples[j + 1];
                samples[j + 1] = temp;
            }
        }
    }

    // Average middle 24 samples (discard 4 lowest, 4 highest)
    uint32_t sum = 0;
    for (int i = 4; i < NUM_SAMPLES - 4; i++) {
        sum += samples[i];
    }
    return sum / (NUM_SAMPLES - 8);
}

void BatteryMonitor::update() {
#if BATTERY_ADC_PIN >= 0
    uint32_t pin_mv = readTrimmedAverage();
    pack_mv = (uint16_t)(pin_mv * DIVIDER_RATIO);

    // No divider connected (or battery unplugged) - never limit/cut without a
    // real reading. A real 2S pack can't power the car below ~6 V anyway, so
    // this only fires when the ADC pin is floating/grounded.
    if (pack_mv < BATTERY_PRESENT_MIN_MV) {
        status = BATT_NO_SENSOR;
        cutoff_active = false;
        cutoff_start_time = 0;
        return;
    }

    // Evaluate Multi-Stage Protection Thresholds
    if (pack_mv <= BATTERY_CUTOFF_MV) {
        if (cutoff_start_time == 0) {
            cutoff_start_time = millis();
        } else if (millis() - cutoff_start_time > CUTOFF_SUSTAIN_MS) {
            cutoff_active = true;
            status = BATT_SHUTDOWN;
        }
    } else {
        cutoff_start_time = 0; // Reset timer if transient dip recovers
        if (cutoff_active && pack_mv > (BATTERY_CUTOFF_MV + 400)) {
            cutoff_active = false; // Hysteresis recovery (+400mV)
        }
    }

    if (!cutoff_active) {
        if (pack_mv <= BATTERY_LIMIT_MV) {
            status = BATT_LIMITING;
        } else if (pack_mv <= BATTERY_WARN_MV) {
            status = BATT_WARNING;
        } else {
            status = BATT_OK;
        }
    }
#else
    status = BATT_NO_SENSOR;
    pack_mv = 0;
#endif
}

uint16_t BatteryMonitor::getPackMilliVolts() const {
    return pack_mv;
}

BatteryStatus BatteryMonitor::getStatus() const {
    return status;
}

bool BatteryMonitor::isThrottleLimited() const {
    return (status == BATT_LIMITING || status == BATT_SHUTDOWN);
}

bool BatteryMonitor::isHardCutoff() const {
    return cutoff_active;
}

bool BatteryMonitor::isSensorPresent() const {
    return status != BATT_NO_SENSOR;
}
