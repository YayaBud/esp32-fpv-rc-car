// Host unit test: compiles the REAL car firmware (unmodified .ino/.cpp) against
// the mocks in ./mocks, then drives setup()/loop() with a fake clock, fake
// WebSocket events and a fake ADC, checking what reaches the motor pins.
//
// Run: bash firmware/test/run_tests.sh      (needs a C++17 compiler; see script)
// Config knobs (BATTERY_ADC_PIN, MOTOR_MIN_DUTY, MOTOR_*_INVERT) come from -D flags.

#include "../esp32_car/esp32_car.ino"
#include "../esp32_car/motor.cpp"
#include "../esp32_car/battery.cpp"
#include "../esp32_car/camera_setup.cpp"

#include <algorithm>

static int checks = 0, failures = 0;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { failures++; \
    printf("FAIL line %d: %s  -- ", __LINE__, #cond); printf(__VA_ARGS__); printf("\n"); } } while (0)

const int BRAKE = 1000;   // both inputs full on
static int wheel(uint8_t in1, uint8_t in2) {
    if (mock::duty[in1] == 255 && mock::duty[in2] == 255) return BRAKE;
    return mock::duty[in1] - mock::duty[in2];
}
// Pin state with the firmware's INVERT knob undone, so "forward" is always positive here.
static int L() { int w = wheel(MOTOR_L_IN1_PIN, MOTOR_L_IN2_PIN); return (MOTOR_L_INVERT && w != BRAKE) ? -w : w; }
static int R() { int w = wheel(MOTOR_R_IN1_PIN, MOTOR_R_IN2_PIN); return (MOTOR_R_INVERT && w != BRAKE) ? -w : w; }
// Expected duty for a throttle: 0 stays 0, anything else lands in MIN_DUTY..255.
static int D(int t) {
    if (t == 0) return 0;
    int d = MOTOR_MIN_DUTY + (abs(t) * (255 - MOTOR_MIN_DUTY) + 50) / 100;
    return t < 0 ? -d : d;
}

static void run(uint32_t ms) {   // wrap-safe: counts elapsed, not absolute time
    uint32_t start = millis();
    while ((uint32_t)(millis() - start) < ms) loop();
}

static uint16_t seq = 0;
static void send(int8_t l, int8_t r, uint8_t flags = 0, uint8_t ver = 1, size_t len = 8) {
    uint8_t b[9] = {0xBE, 0xEF, 0, 0, (uint8_t)l, (uint8_t)r, flags, ver, 0};
    seq++;
    b[2] = seq >> 8; b[3] = seq & 0xFF;
    wsControl.cb(WStype_BIN, b, len);
}
static void sendAs(uint16_t sq, int8_t l, int8_t r, uint16_t session = 0xBEEF) {
    uint8_t b[8] = {(uint8_t)(session >> 8), (uint8_t)session, (uint8_t)(sq >> 8), (uint8_t)sq,
                    (uint8_t)l, (uint8_t)r, 0, 1};
    wsControl.cb(WStype_BIN, b, 8);
}
static void drive(int8_t l, int8_t r, uint32_t ms, uint8_t flags = 0) {
    uint32_t start = millis();
    while ((uint32_t)(millis() - start) < ms) { send(l, r, flags); run(20); }
}
static uint32_t adcForPack(uint32_t pack_mv) { return (uint32_t)(pack_mv / DIVIDER_RATIO + 0.5f); }

struct Ack { uint16_t session, seq, batt; int8_t rssi; uint8_t flags; };
static Ack lastAck() {
    if (wsControl.sent.empty()) return {0, 0, 0, 0, 0xFF};   // fails flag checks instead of crashing
    auto& p = wsControl.sent.back();
    return { (uint16_t)(p[0] << 8 | p[1]), (uint16_t)(p[2] << 8 | p[3]),
             (uint16_t)(p[4] << 8 | p[5]), (int8_t)p[6], p[7] };
}

int main(int argc, char**) {
    mock::verbose = argc > 1;
    printf("config: BATTERY_ADC_PIN=%d MOTOR_MIN_DUTY=%d L_INVERT=%d R_INVERT=%d\n",
           BATTERY_ADC_PIN, MOTOR_MIN_DUTY, MOTOR_L_INVERT, MOTOR_R_INVERT);

    // ---- boot ----
    mock::adc_mv = adcForPack(7800);
    setup();
    auto& ev = mock::events;
    int attaches = (int)std::count_if(ev.begin(), ev.end(), [](const std::string& s) { return s.rfind("ledcAttach", 0) == 0; });
    CHECK(attaches == 4, "exactly the 4 motor pins get PWM: %d", attaches);
    CHECK(mock::attached[MOTOR_L_IN1_PIN] && mock::attached[MOTOR_L_IN2_PIN] &&
          mock::attached[MOTOR_R_IN1_PIN] && mock::attached[MOTOR_R_IN2_PIN], "all four motor pins attached");
    CHECK(L() == BRAKE && R() == BRAKE, "braked at boot: L=%d R=%d", L(), R());
    CHECK(motors.isFailsafeActive(), "failsafe armed at boot");
    if (strcmp(RELAY_TOKEN, "tok123") == 0)
        CHECK(wsControl.url == "/ws/control?room=battle_room_1&role=car&token=tok123", "url=%s", wsControl.url.c_str());
    CHECK(wsControl.host == RELAY_HOST && wsControl.port == RELAY_PORT && !wsControl.ssl, "relay target");

    // ---- no relay yet: stays braked, sends nothing, LED blinks ----
    int toggles = 0, prev = mock::digital[STATUS_LED_PIN];
    for (int i = 0; i < 500; i++) { run(2); if (mock::digital[STATUS_LED_PIN] != prev) { toggles++; prev = mock::digital[STATUS_LED_PIN]; } }
    CHECK(L() == BRAKE, "braked before relay connects");
    CHECK(wsControl.sent.empty(), "nothing sent while disconnected");
    CHECK(toggles >= 3 && toggles <= 5, "LED 2 Hz blink with Wi-Fi up, relay down: %d toggles/s", toggles);

    // ---- relay connects, no controller yet ----
    wsControl.connected = true;
    wsControl.cb(WStype_CONNECTED, (uint8_t*)"/", 1);
    run(300);
    CHECK(mock::digital[STATUS_LED_PIN] == STATUS_LED_ON, "LED solid on when relay connected");
    CHECK(L() == BRAKE, "still braked: no controller packets");
    CHECK(!wsControl.sent.empty(), "fallback telemetry flows without packets");
    Ack a = lastAck();
    CHECK(a.flags & 1, "ACK reports failsafe: flags=%02x", a.flags);
#if BATTERY_ADC_PIN >= 0
    CHECK(a.batt >= 7790 && a.batt <= 7810, "battery ~7800 mV: %u", a.batt);
#else
    CHECK(a.batt == 0 && (a.flags & 0x10), "sensor off: batt=%u flags=%02x", a.batt, a.flags);
#endif
    CHECK(a.rssi == -61, "rssi -61: %d", a.rssi);

    // ---- drive + duty mapping ----
    send(100, 100); run(4);
    CHECK(L() == 255 && R() == 255, "full forward: L=%d R=%d", L(), R());
    send(50, -50); run(4);
    CHECK(L() == D(50) && R() == D(-50), "half: L=%d R=%d (want %d)", L(), R(), D(50));
    send(1, -100); run(4);
    CHECK(L() == D(1) && R() == -255, "min/full reverse: L=%d R=%d", L(), R());
    CHECK(D(1) >= MOTOR_MIN_DUTY && D(1) <= 255 && D(100) == 255, "mapping spans MIN_DUTY..255");
    send(127, -128); run(4);
    CHECK(L() == 255 && R() == -255, "out-of-range clamps: L=%d R=%d", L(), R());
    send(0, 0); run(4);
    CHECK(L() == 0 && R() == 0, "zero throttle: L=%d R=%d", L(), R());

    // ---- tank steering: opposite sides turn opposite ways ----
    send(80, -80); run(4);
    CHECK(L() > 0 && R() < 0, "pivot: L=%d R=%d", L(), R());

    // ---- malformed packets ignored ----
    send(40, 40); run(4);
    send(90, 90, 0, 2);      run(4); CHECK(L() == D(40), "wrong version ignored: L=%d", L());
    send(90, 90, 0, 1, 7);   run(4); CHECK(L() == D(40), "7-byte ignored: L=%d", L());
    send(90, 90, 0, 1, 9);   run(4); CHECK(L() == D(40), "9-byte ignored: L=%d", L());
    wsControl.cb(WStype_TEXT, (uint8_t*)"hello", 5); run(4);
    CHECK(L() == D(40), "text ignored");

    // ---- brake flag ----
    send(100, 100, 1); run(4);
    CHECK(L() == BRAKE && R() == BRAKE, "brake flag");
    CHECK(!motors.isFailsafeActive(), "brake flag is not failsafe");
    send(100, 100); run(4);
    CHECK(L() == 255, "drives again after brake released");

    // ---- link loss: hold 300 ms, fade to 0 by 800 ms, then brake + FAILSAFE ----
    send(80, 80); run(290);
    CHECK(L() == D(80), "full command held at 290 ms: L=%d", L());
    run(260);   // ~550 ms: half way down the fade
    CHECK(!motors.isFailsafeActive() && motors.isFading(), "fading, not failsafe, at ~550 ms");
    CHECK(abs(L() - D(80) / 2) <= D(80) / 8, "about half throttle at ~550 ms: L=%d (full %d)", L(), D(80));
    CHECK(lastAck().flags & 0x20, "ACK reports fading (bit5): %02x", lastAck().flags);
    run(240);   // ~790 ms
    CHECK(L() != BRAKE && !motors.isFailsafeActive(), "not braked yet at ~790 ms: L=%d", L());
    run(20);    // ~810 ms
    CHECK(L() == BRAKE && motors.isFailsafeActive(), "brake + failsafe by ~810 ms: L=%d", L());
    run(260);
    CHECK(lastAck().flags & 1, "ACK reports failsafe");
    send(80, 80); run(4);
    CHECK(L() == D(80), "re-arms on next packet: L=%d", L());
    send(80, 80); run(500);
    CHECK(motors.isFading() && L() < D(80), "fading again 500 ms after the last packet: L=%d", L());
    send(80, 80); run(4);
    CHECK(L() == D(80) && !motors.isFading(), "a packet mid-fade restores the full command: L=%d", L());

    // ---- disconnect = immediate brake (no 300 ms of stale drive) ----
    send(100, 100); run(10);
    wsControl.connected = false;
    wsControl.cb(WStype_DISCONNECTED, nullptr, 0);
    CHECK(L() == BRAKE && R() == BRAKE, "brake inside the disconnect handler");
    run(10);
    CHECK(L() == BRAKE, "stays braked after loop (stale command not re-applied)");
    wsControl.connected = true;
    wsControl.cb(WStype_CONNECTED, (uint8_t*)"/", 1);
    send(60, 60); run(4);
    CHECK(L() == D(60), "drives after reconnect: L=%d", L());

    // ---- ACK: on receipt, echoes seq, rate-limited to 100 ms ----
    // Sync to the 250 ms fallback ACK, then wait 150 ms so the last ACK is >100 ms old.
    // A bare run(300) left the phase to chance: battery.update() advances the mock clock.
    wsControl.sent.clear();
    while (wsControl.sent.empty()) run(1);
    run(150);
    wsControl.sent.clear();
    send(60, 60);
    uint16_t sentSeq = seq;
    CHECK(wsControl.sent.size() == 1, "ACK sent immediately on packet: %zu", wsControl.sent.size());
    a = lastAck();
    CHECK(a.seq == sentSeq && a.session == 0xBEEF, "ACK echoes session/seq: %04x/%u", a.session, a.seq);
    for (int i = 0; i < 9; i++) { run(10); send(60, 60); }
    CHECK(wsControl.sent.size() <= 2, "ACKs rate-limited to 10 Hz: %zu in 90 ms", wsControl.sent.size());

    // ---- newest wins: duplicates (the other path's copy) and older seqs are ignored ----
    send(40, 40); run(4);
    uint16_t cur = seq;
    sendAs(cur, 90, 90); run(4);
    CHECK(L() == D(40), "duplicate seq ignored: L=%d", L());
    sendAs(cur - 5, 90, 90); run(4);
    CHECK(L() == D(40), "older seq ignored: L=%d", L());
    run(250);
    for (int i = 0; i < 10; i++) { sendAs(cur, 40, 40); run(20); }   // ~450 ms of stale copies only
    CHECK(motors.isFading(), "stale copies do not refresh the failsafe");
    sendAs(cur + 1, 60, 60); run(4);
    CHECK(L() == D(60), "next newer seq applies: L=%d", L());
    sendAs(1, 70, 70, 0x1234); run(4);
    CHECK(L() == D(70), "new session (page reload) accepted at once: L=%d", L());
    seq = cur + 2;
    send(40, 40); run(4);
    CHECK(L() == D(40), "back on the old session: L=%d", L());

    // ---- drain: a burst queued behind a TCP stall is applied in one loop pass ----
    for (int i = 1; i <= 20; i++) {
        uint16_t sq = seq + i;
        uint8_t b[8] = {0xBE, 0xEF, (uint8_t)(sq >> 8), (uint8_t)sq, (uint8_t)(i * 5), (uint8_t)(i * 5), 0, 1};
        wsControl.rx.emplace_back(b, b + 8);
    }
    seq += 20;
    loop();
    CHECK(wsControl.rx.empty(), "whole burst drained in one loop(): %zu left", wsControl.rx.size());
    CHECK(L() == D(100), "newest command of the burst applied: L=%d", L());

#if BATTERY_ADC_PIN >= 0
    // ---- battery: throttle cap at 6.5 V ----
    mock::adc_mv = adcForPack(6500);
    drive(100, 100, 1100);
    CHECK(L() == 153, "60%% cap at 6.5 V: L=%d", L());
    CHECK((lastAck().flags & 0x1E) == 0x02, "flags: limited only: %02x", lastAck().flags);

    // ---- battery: transient dip below cutoff does not cut ----
    mock::adc_mv = adcForPack(6000);
    drive(100, 100, 2000);
    mock::adc_mv = adcForPack(6500);
    drive(100, 100, 1100);
    CHECK(L() == 153 && !battery.isHardCutoff(), "2 s dip does not cut: L=%d", L());

    // ---- battery: sustained cutoff brakes despite packets ----
    mock::adc_mv = adcForPack(6000);
    drive(100, 100, 4500);
    CHECK(battery.isHardCutoff(), "cutoff after >3 s below 6.2 V");
    CHECK(L() == BRAKE && R() == BRAKE, "cutoff overrides drive commands: L=%d", L());
    CHECK(lastAck().flags & 0x08, "ACK reports cutoff: %02x", lastAck().flags);
    CHECK(!motors.isFailsafeActive(), "cutoff is independent of failsafe");

    // ---- hysteresis: 6.4 V (>6.2, <6.6) stays cut; 6.7 V recovers ----
    mock::adc_mv = adcForPack(6400);
    drive(100, 100, 2100);
    CHECK(L() == BRAKE, "still cut at 6.4 V (hysteresis): L=%d", L());
    mock::adc_mv = adcForPack(6700);
    drive(100, 100, 1100);
    CHECK(L() == 255, "recovers at 6.7 V, no cap: L=%d", L());
    CHECK((lastAck().flags & 0x1E) == 0x04, "flags: warning only: %02x", lastAck().flags);

    // ---- divider disconnected (pin reads ~0): never limits or cuts ----
    mock::adc_mv = 0;
    drive(100, 100, 5000);
    CHECK(L() == 255, "no divider: full power: L=%d", L());
    a = lastAck();
    CHECK(a.batt == 0 && (a.flags & 0x1E) == 0x10, "no divider: batt=%u flags=%02x", a.batt, a.flags);
    mock::adc_mv = adcForPack(7800);
#else
    // ---- sensor disabled in config: whatever is on the pin must never limit or cut ----
    mock::adc_mv = 100;   // would read as a dead battery if it were sampled
    drive(100, 100, 5000);
    CHECK(L() == 255 && !battery.isHardCutoff(), "sensor off: full power despite pin noise: L=%d", L());
    a = lastAck();
    CHECK(a.batt == 0 && (a.flags & 0x1E) == 0x10, "sensor off: batt=%u flags=%02x", a.batt, a.flags);
#endif

    // ---- UDP path: hello, source check, drive, ACK route, WebSocket drop while UDP is live ----
    IPAddress relay = WiFi.relay;
    udp.sent.clear();
    run(1100);
    std::string hello = std::string("HELLO ") + ROOM_ID + " " + RELAY_TOKEN;
    auto hellos = std::count_if(udp.sent.begin(), udp.sent.end(), [&](const Datagram& d) {
        return d.ip == relay && d.port == RELAY_UDP_PORT && std::string(d.data.begin(), d.data.end()) == hello; });
    CHECK(hellos >= 1, "hello to the relay's UDP port: %d", (int)hellos);
    CHECK(udp.bound && udp.localPort == CAR_UDP_PORT, "UDP socket bound");
    auto udpPkt = [&](IPAddress ip, uint16_t port, int8_t l, int8_t r) {
        seq++;
        uint8_t b[8] = {0xBE, 0xEF, (uint8_t)(seq >> 8), (uint8_t)seq, (uint8_t)l, (uint8_t)r, 0, 1};
        udp.rx.push_back({ip, port, {b, b + 8}});
    };
    udpPkt(IPAddress(10, 0, 0, 9), RELAY_UDP_PORT, 100, 100); run(4);
    CHECK(L() == BRAKE, "UDP control from another address ignored: L=%d", L());
    udpPkt(relay, 9999, 100, 100); run(4);
    CHECK(L() == BRAKE, "UDP control from the relay's address but wrong port ignored: L=%d", L());
    udp.sent.clear();
    udpPkt(relay, RELAY_UDP_PORT, 70, 70); run(4);
    CHECK(L() == D(70), "UDP control from the relay drives: L=%d", L());
    bool ackUdp = std::any_of(udp.sent.begin(), udp.sent.end(), [&](const Datagram& d) {
        return d.ip == relay && d.port == RELAY_UDP_PORT && d.data.size() == 8; });
    CHECK(ackUdp, "ACK goes back over UDP while UDP delivers");
    wsControl.connected = false;
    wsControl.cb(WStype_DISCONNECTED, nullptr, 0);
    CHECK(L() == D(70), "WebSocket drop while UDP is live: no instant brake: L=%d", L());
    udpPkt(relay, RELAY_UDP_PORT, 30, 30); run(4);
    CHECK(L() == D(30), "keeps driving on UDP alone: L=%d", L());
    run(900);
    CHECK(L() == BRAKE, "UDP stops too: failsafe brake: L=%d", L());
    wsControl.connected = true;
    wsControl.cb(WStype_CONNECTED, (uint8_t*)"/", 1);
    run(1200);   // UDP goes stale: ACKs back on the WebSocket

    // ---- millis() wraparound (day 49.7) ----
    drive(50, 50, 1100);
    mock::now_ms = 0xFFFFFFFFu - 150;
    send(50, 50); run(250);
    CHECK(L() == D(50), "driving across millis wrap: L=%d", L());
    run(600);
    CHECK(L() == BRAKE, "failsafe still fires across wrap: L=%d", L());

    CHECK(std::find_if(ev.begin(), ev.end(), [](const std::string& s) { return s.rfind("UNATTACHED", 0) == 0; }) == ev.end(),
          "no PWM write to an unattached pin");

    printf("%d checks, %d failed\n", checks, failures);
    return failures ? 1 : 0;
}
