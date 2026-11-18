#pragma once
#include "Arduino.h"

#define WIFI_STA 1
enum { WL_IDLE_STATUS = 0, WL_CONNECTED = 3, WL_DISCONNECTED = 6 };

struct MockIP { String toString() const { return String("192.168.1.50"); } };
struct IPAddress {
    uint32_t v = 0;
    IPAddress() {}
    IPAddress(uint8_t a, uint8_t b, uint8_t c, uint8_t d) : v((uint32_t)a << 24 | b << 16 | c << 8 | d) {}
    bool operator==(const IPAddress& o) const { return v == o.v; }
    bool operator!=(const IPAddress& o) const { return v != o.v; }
};

struct MockWiFi {
    int status_ = WL_CONNECTED;
    int rssi = -61;
    void mode(int) {}
    void setSleep(bool) {}
    void setAutoReconnect(bool) {}
    void begin(const char*, const char*) {}
    int status() { return status_; }
    int RSSI() { return rssi; }
    MockIP localIP() { return {}; }
    IPAddress relay{192, 168, 1, 5};   // what RELAY_HOST resolves to
    int hostByName(const char*, IPAddress& ip) { ip = relay; return 1; }
};
inline MockWiFi WiFi;
