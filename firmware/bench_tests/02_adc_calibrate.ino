/*
 * Bench Test 02: Battery Voltage Divider Calibration & Noise Filter
 * Board: ESP32 Dev Module (arduino-cli: esp32:esp32:esp32)
 *
 * Hardware Wiring:
 *   2S LiPo (+) (or Bench Supply) ---> 100 kΩ (1%) ---+---> ESP32 GPIO35 (ADC1, input only)
 *                                                     |
 *                                                     +---> 47 kΩ (1%) ---> GND
 *                                                     |
 *                                                     +---> 100 nF cap ---> GND
 *
 * Objective:
 *   1. Explicitly configure 11 dB attenuation (ADC_11db: 150 mV to 3100 mV).
 *   2. Read calibrated millivolts using analogReadMilliVolts() via factory eFuse curves.
 *   3. Filter noise using 32-sample trimmed median-average filter.
 *   4. Output computed pack voltage alongside raw pin voltage for DMM calibration.
 */

#include <Arduino.h>

#define BATTERY_ADC_PIN     35  // ADC1: ADC2 pins don't work while Wi-Fi is on

#define DIVIDER_R1_OHMS     100000.0f  // 100 kΩ top resistor
#define DIVIDER_R2_OHMS      47000.0f  // 47 kΩ bottom resistor
#define DIVIDER_RATIO       ((DIVIDER_R1_OHMS + DIVIDER_R2_OHMS) / DIVIDER_R2_OHMS) // 3.12766f

// Trim multiplier (adjust if DMM measurement differs slightly from nominal resistor values)
float calibration_trim = 1.000f;

uint32_t readFilteredPinMilliVolts() {
    const int NUM_SAMPLES = 32;
    uint32_t samples[NUM_SAMPLES];

    for (int i = 0; i < NUM_SAMPLES; i++) {
        samples[i] = analogReadMilliVolts(BATTERY_ADC_PIN);
        delayMicroseconds(500);
    }

    // Simple bubble sort for trimmed average
    for (int i = 0; i < NUM_SAMPLES - 1; i++) {
        for (int j = 0; j < NUM_SAMPLES - i - 1; j++) {
            if (samples[j] > samples[j + 1]) {
                uint32_t temp = samples[j];
                samples[j] = samples[j + 1];
                samples[j + 1] = temp;
            }
        }
    }

    // Discard 4 lowest and 4 highest outliers, average middle 24
    uint32_t sum = 0;
    for (int i = 4; i < NUM_SAMPLES - 4; i++) {
        sum += samples[i];
    }

    return sum / (NUM_SAMPLES - 8);
}

void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("\n=== Battery ADC Calibration Test Initializing ===");

    // MANDATORY: Configure 11 dB attenuation for 0.15 - 3.1 V range
    analogSetPinAttenuation(BATTERY_ADC_PIN, ADC_11db);
    Serial.println("GPIO35 set to 11 dB attenuation (ADC_11db).");
    Serial.println("Connect DMM across battery terminals to compare readings.\n");
    Serial.println("Time (s) | Pin (mV) | Computed Pack (V) | Raw ADC | Status");
    Serial.println("---------+----------+-------------------+---------+------------------");
}

void loop() {
    uint32_t raw_adc = analogRead(BATTERY_ADC_PIN);
    uint32_t pin_mv = readFilteredPinMilliVolts();
    float pack_voltage = (pin_mv * DIVIDER_RATIO * calibration_trim) / 1000.0f;

    String status = "NORMAL";
    if (pack_voltage >= 8.40f) {
        status = "FULL / PEAK";
    } else if (pack_voltage <= 6.20f) {
        status = "CRITICAL CUTOFF";
    } else if (pack_voltage <= 6.60f) {
        status = "THROTTLE LIMIT (60%)";
    } else if (pack_voltage <= 7.00f) {
        status = "LOW BATT WARNING";
    }

    Serial.printf("%8lu | %8u | %17.3f | %7u | %s\n",
                  millis() / 1000, pin_mv, pack_voltage, raw_adc, status.c_str());

    delay(1000);
}
