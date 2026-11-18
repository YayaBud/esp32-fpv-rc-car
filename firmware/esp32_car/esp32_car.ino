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
// Wi-Fi firmware updates (ArduinoOTA). Off unless secrets.h sets OTA_PASSWORD, so nobody
// else on a shared network can flash the car. The host test build has no ArduinoOTA.h.
// Not __has_include: arduino-cli's library scan sees it false and silently drops OTA.
#ifdef ARDUINO_ARCH_ESP32
#include <ArduinoOTA.h>
#define HAVE_OTA 1
#else
#define HAVE_OTA 0
#endif
#include "config.h"
#include "motor.h"
#include "battery.h"
#include "camera_setup.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Copy secrets.example.h to secrets.h and fill in Wi-Fi + relay settings"
#endif

// UDP control path: the relay sends every command over UDP *and* the WebSocket; newest seq wins.
// On a weak link TCP went silent for >= 1.5 s while ping never passed 327 ms (measured 2026-10-24).
// ponytail: off with USE_WSS until UDP packets are authenticated (HMAC with RELAY_TOKEN); over the
// internet it would otherwise be a plaintext path next to a TLS WebSocket.
#ifndef USE_UDP_CONTROL
#define USE_UDP_CONTROL (!USE_WSS)
#endif
#ifndef RELAY_UDP_PORT
#define RELAY_UDP_PORT 8081
#endif
#define CAR_UDP_PORT   4211
#include <WiFiUdp.h>
static WiFiUDP udp;
static IPAddress relayIP;          // RELAY_HOST, resolved once Wi-Fi is up
static bool udpEverRx = false;
static uint32_t lastUdpRxMs = 0;   // last control datagram from the relay
static uint32_t wsFrames = 0;      // control frames seen on the WebSocket (drain loop)
static bool udpFresh() { return udpEverRx && millis() - lastUdpRxMs < 1000; }

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

void sendTelemetryACK();  // used by applyControl; explicit so the host test build compiles

// One entry point for both paths. Returns true if the packet was applied.
static bool applyControl(const uint8_t *payload, size_t length) {
    if (length != 8 || payload[7] != 0x01) return false; // 8-byte binary control packet, version 1
    uint16_t session_id = (payload[0] << 8) | payload[1];
    uint16_t seq        = (payload[2] << 8) | payload[3];
    // Newest wins: each command arrives twice (UDP + WebSocket) and a TCP stall replays old ones in
    // a burst. Stale copies are dropped and do not refresh the failsafe. After a full failsafe any
    // valid packet re-syncs (new page = new session id; also covers a session id collision).
    if (!motors.isFailsafeActive() && session_id == ctrl.session_id && (int16_t)(seq - ctrl.seq) <= 0)
        return false;

    ctrl.session_id = session_id;
    ctrl.seq = seq;
    ctrl.left_throttle  = constrain((int8_t)payload[4], (int8_t)-100, (int8_t)100);
    ctrl.right_throttle = constrain((int8_t)payload[5], (int8_t)-100, (int8_t)100);
    ctrl.flags = payload[6];

    motors.notifyPacketReceived();

    if (millis() - lastAckMs >= TELEMETRY_INTERVAL_MS) {
        sendTelemetryACK(); // real round-trip latency, not up to 100ms of wait
    }
    return true;
}

// ============================================================================
// WEBSOCKET CONTROL CLIENT HANDLER
// ============================================================================
void onControlEvent(WStype_t type, uint8_t * payload, size_t length) {
    switch (type) {
        case WStype_DISCONNECTED:
            // Brake at once, unless UDP is still delivering: then the fade/failsafe timer covers it.
            if (udpFresh()) {
                Serial.println("[WS-CTRL] Disconnected; UDP control still live.");
            } else {
                Serial.println("[WS-CTRL] Disconnected! Engaging failsafe...");
                motors.tripFailsafe();
            }
            break;

        case WStype_CONNECTED:
            Serial.printf("[WS-CTRL] Connected to relay: %s\n", payload);
            break;

        case WStype_BIN:
            wsFrames++;
            applyControl(payload, length);
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
//   bit3 battery hard cutoff | bit4 no battery sensor | bit5 link degraded (fading)
// One line per change of what the motors are told: to Serial and, on real hardware, as a UDP
// datagram to RELAY_HOST:DRIVE_LOG_PORT so a drive can be verified with no USB cable attached.
// ponytail: plain UDP, fire-and-forget; lines can drop on bad Wi-Fi. It's a debug aid, not telemetry.
#define DRIVE_LOG_PORT 4210
void logDriveChange() {
    static int last = -1;
    const char *mode = battery.isHardCutoff() ? "CUTOFF" : motors.isFailsafeActive() ? "FAILSAFE"
                     : (ctrl.flags & 1) ? "BRAKE" : "DRIVE";
    int key = (ctrl.left_throttle + 128) | (ctrl.right_throttle + 128) << 8 | (mode[0] << 16);
    if (key == last) return;
    last = key;
    char line[80];
    snprintf(line, sizeof line, "[DRIVE] t=%lu %s L=%d R=%d seq=%u", (unsigned long)millis(), mode,
             ctrl.left_throttle, ctrl.right_throttle, ctrl.seq);
    Serial.println(line);
    if (WiFi.status() == WL_CONNECTED && relayIP != IPAddress()) {
        udp.beginPacket(relayIP, DRIVE_LOG_PORT);
        udp.write((const uint8_t *)line, strlen(line));
        udp.endPacket();
    }
}

// Hello every 1 s registers this car's address with the relay (and keeps a NAT mapping open),
// then every queued datagram is read, so a burst costs one loop pass.
static void serviceUdp() {
    static uint32_t lastHelloMs = 0, lastDnsMs = 0;
    static bool bound = false;
    if (WiFi.status() != WL_CONNECTED) return;
    if (relayIP == IPAddress()) {
        if (lastDnsMs && millis() - lastDnsMs < 5000) return;   // don't block every loop on DNS
        lastDnsMs = millis() | 1;
        if (!WiFi.hostByName(RELAY_HOST, relayIP)) return;
    }
#if USE_UDP_CONTROL
    if (!bound) bound = udp.begin(CAR_UDP_PORT);
    if (millis() - lastHelloMs >= 1000) {
        lastHelloMs = millis();
        char hello[80];
        int n = snprintf(hello, sizeof hello, "HELLO %s %s", ROOM_ID, RELAY_TOKEN);
        udp.beginPacket(relayIP, RELAY_UDP_PORT);
        udp.write((const uint8_t *)hello, n);
        udp.endPacket();
    }
    uint8_t buf[16];
    for (int i = 0; i < 32; i++) {
        if (udp.parsePacket() <= 0) break;
        // Only the relay may steer: anything from another address or port is dropped.
        bool fromRelay = udp.remoteIP() == relayIP && udp.remotePort() == RELAY_UDP_PORT;
        int n = udp.read(buf, sizeof buf);
        if (!fromRelay || n != 8) continue;
        lastUdpRxMs = millis();
        udpEverRx = true;
        applyControl(buf, 8);
    }
#endif
}

void sendTelemetryACK() {
    lastAckMs = millis();

    // Over UDP while UDP is delivering (a stalled TCP uplink would hold ACKs back), else WebSocket.
    bool viaUdp = USE_UDP_CONTROL && udpFresh();
    if (!viaUdp && !wsControl.isConnected()) return;

    uint16_t batt_mv = battery.getPackMilliVolts();
    int8_t rssi = (int8_t)WiFi.RSSI();

    uint8_t status_flags = 0;
    if (motors.isFailsafeActive())                status_flags |= (1 << 0);
    if (battery.isThrottleLimited())               status_flags |= (1 << 1);
    if (battery.getStatus() == BATT_WARNING)       status_flags |= (1 << 2);
    if (battery.isHardCutoff())                    status_flags |= (1 << 3);
    if (!battery.isSensorPresent())                status_flags |= (1 << 4);
    if (motors.isFading())                         status_flags |= (1 << 5);

    uint8_t packet[8];
    packet[0] = (ctrl.session_id >> 8) & 0xFF;
    packet[1] = ctrl.session_id & 0xFF;
    packet[2] = (ctrl.seq >> 8) & 0xFF;
    packet[3] = ctrl.seq & 0xFF;
    packet[4] = (batt_mv >> 8) & 0xFF;
    packet[5] = batt_mv & 0xFF;
    packet[6] = (uint8_t)rssi;
    packet[7] = status_flags;

    if (viaUdp) {
        udp.beginPacket(relayIP, RELAY_UDP_PORT);
        udp.write(packet, 8);
        udp.endPacket();
    } else {
        wsControl.sendBIN(packet, 8);
    }
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
#if HAVE_OTA
    // Why a join fails: 15/204 = wrong password, 201 = SSID not found (5 GHz-only?), 2/202 = auth
    WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
        Serial.printf("[WIFI] Disconnected, reason %u\n", info.wifi_sta_disconnected.reason);
    }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
#endif
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
#if HAVE_OTA
    // Only after begin(): before it the radio isn't started and setTxPower() is ignored.
    WiFi.setTxPower(WIFI_TX_POWER);
    Serial.printf(" [TX %.1f dBm]", WiFi.getTxPower() / 4.0f);
#endif

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

#if HAVE_OTA && defined(OTA_PASSWORD)
    if (strlen(OTA_PASSWORD) > 0) {
        ArduinoOTA.setHostname("fpv-car");
        ArduinoOTA.setPassword(OTA_PASSWORD);
        ArduinoOTA.onStart([]() { motors.tripFailsafe(); }); // brake before flashing
        ArduinoOTA.begin();
        Serial.println("[OTA] Wi-Fi updates enabled (fpv-car, port 3232).");
    }
#endif

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
    // Ping every 3 s, drop after 2 pongs later than 3 s. Was (2000, 1000, 2): phone hotspot
    // RTT spikes to ~850 ms dropped the socket 18x in 75 s. Motor safety is the failsafe (config.h).
    wsControl.enableHeartbeat(3000, 3000, 2);

#if ENABLE_VIDEO
    String videoUrl = String("/ws/video?room=") + ROOM_ID + "&role=car" + tokenSuffix;
#if USE_WSS
    wsVideo.beginSSL(RELAY_HOST, RELAY_PORT, videoUrl.c_str());
#else
    wsVideo.begin(RELAY_HOST, RELAY_PORT, videoUrl.c_str());
#endif
    wsVideo.onEvent(onVideoEvent);
    wsVideo.setReconnectInterval(1000);
    wsVideo.enableHeartbeat(3000, 3000, 2);

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

    // Service the control WebSocket (runs onControlEvent synchronously). Drain every queued frame:
    // the library hands over one per loop() call, so a post-stall burst replayed ~200 ms of old
    // commands one pass at a time. Then the UDP path.
    for (int i = 0; i < 32; i++) {
        uint32_t before = wsFrames;
        wsControl.loop();
        if (wsFrames == before) break;
    }
    serviceUdp();
#if HAVE_OTA && defined(OTA_PASSWORD)
    ArduinoOTA.handle();
#endif

    // Link-loss watchdog: hold, fade, brake (config.h)
    motors.updateFailsafe();

    // Apply drive commands, or brake if failsafe/hard-cutoff is active
    if (battery.isHardCutoff() || motors.isFailsafeActive()) {
        motors.emergencyBrake();
    } else {
        motors.setDrive(ctrl.left_throttle, ctrl.right_throttle, ctrl.flags, battery.isThrottleLimited());
    }
    logDriveChange();

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
