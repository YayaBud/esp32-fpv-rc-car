#pragma once
#include <Arduino.h>

#if !CONFIG_IDF_TARGET_ESP32
#error "Needs the classic ESP32 chip. Select: Tools > Board > esp32 > ESP32 Dev Module"
#endif

#include <esp_arduino_version.h>
#if ESP_ARDUINO_VERSION_MAJOR < 3
#error "Needs arduino-esp32 core 3.x"
#endif

// ============================================================================
// HARDWARE: ESP32 DevKit + L298N (HW-095) + 4 TT motors driven as a tank
// ============================================================================
// Two motors per side wired in parallel (same polarity):
//   left pair  -> L298N OUT1/OUT2     right pair -> L298N OUT3/OUT4
//
// Wiring (L298N pin <- ESP32 pin), as wired on DevKit V1 board #2 (2026-10-26):
//   IN1 <- GPIO14   IN2 <- GPIO27   (left side)
//   IN3 <- GPIO26   IN4 <- GPIO32   (right side)
//   ENA, ENB: leave the board's jumpers ON (always enabled; speed = PWM on IN pins)
//   L298N GND <-> ESP32 GND (and battery -)       L298N 12V terminal <- battery +
// Power the ESP32 from USB (or a power bank). Do NOT also wire L298N 5V -> ESP32 VIN
// while USB is plugged in.
//
// Pins avoided on purpose: 0/2/5/12/15 (boot strapping), 6-11 (flash), 34-39 (input only),
// ADC2 *as analog input* (unusable while Wi-Fi is on; fine as motor outputs).
// ponytail: GPIO14 is used anyway because that's how it's wired. It outputs PWM for a moment
// at boot, so the left side can twitch at power-up; move that wire to GPIO33 to stop it.
#ifndef MOTOR_L_IN1_PIN
#define MOTOR_L_IN1_PIN     14
#endif
#ifndef MOTOR_L_IN2_PIN
#define MOTOR_L_IN2_PIN     27
#endif
#ifndef MOTOR_R_IN1_PIN
#define MOTOR_R_IN1_PIN     26
#endif
#ifndef MOTOR_R_IN2_PIN
#define MOTOR_R_IN2_PIN     32
#endif

// --- Status LED (onboard blue LED, active HIGH) ---
#define STATUS_LED_PIN       2
#define STATUS_LED_ON     HIGH

// ============================================================================
// PWM / LEDC MOTOR CONFIGURATION
// ============================================================================
// With the L298N's EN jumpers on, IN1/IN2 = PWM/LOW drives, and LOW/LOW (duty 0) or
// HIGH/HIGH (emergency brake) both short the motor = fast stop. There is no coast.
#define MOTOR_PWM_FREQ      5000   // L298N is slow; 1-5 kHz. Lower it if the driver runs hot.
#define MOTOR_PWM_RES           8  // 8-bit resolution (0-255 duty cycle)

// --- Calibration knobs (override with -D for tests) ---
#ifndef MOTOR_L_INVERT
#define MOTOR_L_INVERT          0  // set 1 if the left side spins backwards
#endif
#ifndef MOTOR_R_INVERT
#define MOTOR_R_INVERT          0  // set 1 if the right side spins backwards
#endif
#ifndef MOTOR_MIN_DUTY
// 0..255. Any nonzero throttle maps to MIN_DUTY..255. Raise it (bench test 01 prints
// the duty where the wheels start turning) if the motors hum without moving at low stick.
#define MOTOR_MIN_DUTY          0
#endif

// ============================================================================
// BATTERY VOLTAGE MONITORING (off until the divider is wired)
// ============================================================================
// Divider: battery+ -> 100k -> pin -> 47k -> GND (+100nF pin->GND). Then set the pin to 35
// (ADC1, input only). While -1, the car reports "no sensor" and never limits/cuts: a floating
// ADC pin reads garbage, which could look like a flat battery and cut the motors.
#ifndef BATTERY_ADC_PIN
#define BATTERY_ADC_PIN        -1
#endif

#define DIVIDER_R1_OHMS     100000.0f  // 100 kΩ top resistor
#define DIVIDER_R2_OHMS      47000.0f  // 47 kΩ bottom resistor
#define DIVIDER_RATIO       ((DIVIDER_R1_OHMS + DIVIDER_R2_OHMS) / DIVIDER_R2_OHMS) // 3.12766f

#define BATTERY_WARN_MV     7000       // 7.0 V (3.5 V/cell advisory warning)
#define BATTERY_LIMIT_MV    6600       // 6.6 V (3.3 V/cell progressive throttle limit: 60% max)
#define BATTERY_CUTOFF_MV   6200       // 6.2 V (3.1 V/cell sustained cutoff)
#define CUTOFF_SUSTAIN_MS   3000       // Must remain below cutoff for 3s to trigger shutdown

// Below this, the divider is treated as not connected (a real 2S pack can't
// power the car below ~6 V anyway, so this only fires with no battery wired).
#define BATTERY_PRESENT_MIN_MV 3000

// ============================================================================
// TIMING & FAILSAFE CONSTANTS
// ============================================================================
// Link loss, staged (Betaflight-style guard period): the last command holds for HOLD, then
// throttle fades linearly to 0, and at BRAKE the motors short-brake and the FAILSAFE flag is set.
// A valid packet at any point restores full control at once. Weak Wi-Fi gaps of 200-330 ms are
// normal (measured), so a 300 ms cliff braked the car ~14x a minute.
#ifndef FAILSAFE_HOLD_MS
#define FAILSAFE_HOLD_MS     300
#endif
#ifndef FAILSAFE_BRAKE_MS
#define FAILSAFE_BRAKE_MS    800
#endif
#define TELEMETRY_INTERVAL_MS 100      // Transmit telemetry ACK at 10 Hz

// Wi-Fi transmit power. Max by default; a low value (-DWIFI_TX_POWER=WIFI_POWER_2dBm) makes
// the link weak on purpose, to test link-loss handling on the bench.
#ifndef WIFI_TX_POWER
#define WIFI_TX_POWER  WIFI_POWER_19_5dBm
#endif

// ============================================================================
// VIDEO (phase 2: needs a camera board, which a plain ESP32 DevKit is not)
// ============================================================================
#ifndef ENABLE_VIDEO
#define ENABLE_VIDEO 0
#endif
#if ENABLE_VIDEO
#error "ENABLE_VIDEO needs a camera board (ESP32-CAM / XIAO ESP32S3 Sense). Add its pin map to config.h first."
#endif

// arduino-esp32 3.x maps LEDC channel N to a timer by channel number; motors take channels
// 0-3 (auto-assigned by ledcAttach, since they attach first). A camera XCLK must not reuse
// channel 0/timer 0 or it clobbers the left motor PWM.
#define CAMERA_LEDC_CHANNEL LEDC_CHANNEL_7
#define CAMERA_LEDC_TIMER   LEDC_TIMER_3
