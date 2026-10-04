/*
 * Internet-Controlled RC Tank Firmware
 * Board: classic ESP32 DevKit (ESP32 Dev Module) + L298N + 4 motors (2 per side)
 * Phase 1: drive reliably over WebSocket from a browser via a relay. Movement only.
 *
 * arduino-cli FQBN: esp32:esp32:esp32
 * Required library: "WebSockets" by Markus Sattler (Links2004)
 * Pins, wiring and calibration knobs: config.h.  Wi-Fi/relay settings: secrets.h.
 *
 * Video is compiled out (ENABLE_VIDEO 0); it needs a camera board, see config.h.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include "config.h"
#include "motor.h"
#include "battery.h"
#include "camera_setup.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Copy secrets.example.h to secrets.h and fill in Wi-Fi + relay settings"
#endif

WebSocketsClient wsControl;
#if ENABLE_VIDEO
WebSocketsClient wsVideo;
TaskHandle_t videoTaskHandle = NULL;
#endif

// ponytail: onControlEvent/onVideoEvent and loop() all run from the same
// task (wsControl.loop()/wsVideo.loop() are called synchronously from
// loop()), so this plain struct needs no lock. The video streaming task
// (when ENABLE_VIDEO) never touches control state.
struct ControlState {
    int8_t left_throttle;
    int8_t right_throttle;
    uint8_t flags;
    uint16_t seq;
    uint16_t session_id;
};
static ControlState ctrl = {0, 0, 0, 0, 0};

static uint32_t lastAckMs = 0;

void sendTelemetryACK();  // used by onControlEvent; explicit so the host test build compiles

// ============================================================================
// WEBSOCKET CONTROL CLIENT HANDLER
// ============================================================================
void onControlEvent(WStype_t type, uint8_t * payload, size_t length) {
    switch (type) {
        case WStype_DISCONNECTED:
            Serial.println("[WS-CTRL] Disconnected! Engaging failsafe...");
            motors.tripFailsafe();
            break;

        case WStype_CONNECTED:
            Serial.printf("[WS-CTRL] Connected to relay: %s\n", payload);
            break;

        case WStype_BIN:
            if (length == 8 && payload[7] == 0x01) { // 8-byte binary control packet, version 1
                uint16_t session_id = (payload[0] << 8) | payload[1];
                uint16_t seq        = (payload[2] << 8) | payload[3];
                int8_t left         = constrain((int8_t)payload[4], (int8_t)-100, (int8_t)100);
                int8_t right        = constrain((int8_t)payload[5], (int8_t)-100, (int8_t)100);
                uint8_t flags       = payload[6];

                ctrl.session_id = session_id;
                ctrl.seq = seq;
                ctrl.left_throttle = left;
                ctrl.right_throttle = right;
                ctrl.flags = flags;

                motors.notifyPacketReceived();

                if (millis() - lastAckMs >= TELEMETRY_INTERVAL_MS) {
                    sendTelemetryACK(); // real round-trip latency, not up to 100ms of wait
                }
            }
            break;

        case WStype_PONG:
            // Native WebSocket Pong acknowledged
            break;

        default:
            break;
    }
}

#if ENABLE_VIDEO
// ============================================================================
// WEBSOCKET VIDEO CLIENT HANDLER
// ============================================================================
void onVideoEvent(WStype_t type, uint8_t * payload, size_t length) {
    switch (type) {
        case WStype_DISCONNECTED:
            Serial.println("[WS-VID] Video socket disconnected.");
            break;
        case WStype_CONNECTED:
            Serial.printf("[WS-VID] Video socket connected: %s\n", payload);
            break;
        default:
            break;
    }
}

// ============================================================================
// VIDEO CAPTURE & STREAMING TASK (Pinned to Core 0)
// ============================================================================
void videoStreamingTask(void * pvParameters) {
    Serial.println("[TASK] Video task running on Core 0.");
    TickType_t xLastWakeTime = xTaskGetTickCount();
    const TickType_t xFrequency = pdMS_TO_TICKS(66); // ~15 FPS baseline

    while (true) {
        wsVideo.loop();

        if (wsVideo.isConnected()) {
            camera_fb_t * fb = esp_camera_fb_get();
            if (fb) {
                wsVideo.sendBIN(fb->buf, fb->len);
                esp_camera_fb_return(fb);
            }
        }

        vTaskDelayUntil(&xLastWakeTime, xFrequency);
    }
}
#endif // ENABLE_VIDEO

// ============================================================================
// TELEMETRY TRANSMISSION
// ============================================================================
// Status flag bits:
//   bit0 failsafe active | bit1 throttle limited | bit2 battery warning
//   bit3 battery hard cutoff | bit4 no battery sensor
void sendTelemetryACK() {
    lastAckMs = millis();

    if (!wsControl.isConnected()) return;

    uint16_t batt_mv = battery.getPackMilliVolts();
    int8_t rssi = (int8_t)WiFi.RSSI();

    uint8_t status_flags = 0;
    if (motors.isFailsafeActive())                status_flags |= (1 << 0);
    if (battery.isThrottleLimited())               status_flags |= (1 << 1);
    if (battery.getStatus() == BATT_WARNING)       status_flags |= (1 << 2);
    if (battery.isHardCutoff())                    status_flags |= (1 << 3);
    if (!battery.isSensorPresent())                status_flags |= (1 << 4);

    uint8_t packet[8];
    packet[0] = (ctrl.session_id >> 8) & 0xFF;
    packet[1] = ctrl.session_id & 0xFF;
    packet[2] = (ctrl.seq >> 8) & 0xFF;
    packet[3] = ctrl.seq & 0xFF;
    packet[4] = (batt_mv >> 8) & 0xFF;
    packet[5] = batt_mv & 0xFF;
    packet[6] = (uint8_t)rssi;
    packet[7] = status_flags;

    wsControl.sendBIN(packet, 8);
}

// ============================================================================
// STATUS LED (non-blocking): solid = relay connected, 2 Hz = Wi-Fi only,
// 8 Hz = Wi-Fi down.
// ============================================================================
void updateStatusLed() {
    static uint32_t last_toggle = 0;
    static bool led_on = false;

    if (wsControl.isConnected()) {
        digitalWrite(STATUS_LED_PIN, STATUS_LED_ON);
        return;
    }

    bool wifi_ok = (WiFi.status() == WL_CONNECTED);
    uint32_t half_period_ms = wifi_ok ? 250 : 63; // 2 Hz : 8 Hz

    if (millis() - last_toggle >= half_period_ms) {
        last_toggle = millis();
        led_on = !led_on;
        digitalWrite(STATUS_LED_PIN, led_on ? STATUS_LED_ON : !STATUS_LED_ON);
    }
}

// ============================================================================
// ARDUINO SETUP & MAIN LOOP
// ============================================================================
void setup() {
    Serial.begin(115200);
    Serial.println("\n=======================================================");
    Serial.println("  ESP32 RC Tank Starting                               ");
    Serial.println("=======================================================");

    // 1. Motors first: attaches PWM and forces a brake state before anything
    //    else can request a drive command.
    motors.begin();
    Serial.println("[SYS] Motor driver initialized.");

    // 2. Battery ADC
    battery.begin();
    Serial.printf("[SYS] Battery: %u mV (Status: %d)\n",
                  battery.getPackMilliVolts(), battery.getStatus());

    // 3. Status LED
    pinMode(STATUS_LED_PIN, OUTPUT);
    digitalWrite(STATUS_LED_PIN, !STATUS_LED_ON);

#if ENABLE_VIDEO
    // 4. Camera
    if (!initCamera(FRAMESIZE_QVGA, 12)) {
        Serial.println("[SYS] FATAL: Camera initialization failed!");
    }
#endif

    // 5. Connect to Wi-Fi
    Serial.printf("[WIFI] Connecting to %s", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false); // Disable Wi-Fi modem sleep for minimum latency
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    uint32_t wifi_start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - wifi_start < 10000) {
        delay(300);
        Serial.print(".");
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("\n[WIFI] Connected! IP: %s (RSSI: %d dBm)\n",
                      WiFi.localIP().toString().c_str(), WiFi.RSSI());
    } else {
        Serial.println("\n[WIFI] Connection failed. Will keep retrying in the background.");
    }

    // 6. Configure WebSocket(s)
    String tokenSuffix = (strlen(RELAY_TOKEN) > 0) ? (String("&token=") + RELAY_TOKEN) : String("");
    String controlUrl = String("/ws/control?room=") + ROOM_ID + "&role=car" + tokenSuffix;

#if USE_WSS
    wsControl.beginSSL(RELAY_HOST, RELAY_PORT, controlUrl.c_str());
#else
    wsControl.begin(RELAY_HOST, RELAY_PORT, controlUrl.c_str());
#endif
    wsControl.onEvent(onControlEvent);
    wsControl.setReconnectInterval(1000);
    wsControl.enableHeartbeat(2000, 1000, 2);

#if ENABLE_VIDEO
    String videoUrl = String("/ws/video?room=") + ROOM_ID + "&role=car" + tokenSuffix;
#if USE_WSS
    wsVideo.beginSSL(RELAY_HOST, RELAY_PORT, videoUrl.c_str());
#else
    wsVideo.begin(RELAY_HOST, RELAY_PORT, videoUrl.c_str());
#endif
    wsVideo.onEvent(onVideoEvent);
    wsVideo.setReconnectInterval(1000);
    wsVideo.enableHeartbeat(2000, 1000, 2);

    // 7. Spawn video streaming task
    xTaskCreatePinnedToCore(
        videoStreamingTask,
        "VideoStreamingTask",
        8192,
        NULL,
        3,
        &videoTaskHandle,
        0 // Core 0
    );
#endif // ENABLE_VIDEO

    Serial.printf("[MEM] Post-init Free Heap: %u bytes | Free PSRAM: %u bytes\n",
                  (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram());
}

void loop() {
    static uint32_t last_battery_time = 0;

    // Service Control WebSocket client (runs onControlEvent synchronously)
    wsControl.loop();

    // Evaluate failsafe watchdog (300 ms timeout)
    motors.updateFailsafe();

    // Apply drive commands, or brake if failsafe/hard-cutoff is active
    if (battery.isHardCutoff() || motors.isFailsafeActive()) {
        motors.emergencyBrake();
    } else {
        motors.setDrive(ctrl.left_throttle, ctrl.right_throttle, ctrl.flags, battery.isThrottleLimited());
    }

    // Update Battery ADC (1 Hz)
    if (millis() - last_battery_time >= 1000) {
        battery.update();
        last_battery_time = millis();
    }

    // Fallback telemetry: keeps battery/RSSI flowing even with no control packets
    if (millis() - lastAckMs >= 250) {
        sendTelemetryACK();
    }

    updateStatusLed();

    delay(2); // keep receive latency low; failsafe/telemetry cadence is millis-based anyway
}
