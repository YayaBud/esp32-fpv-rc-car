#pragma once
#include "Arduino.h"

#define WIFI_STA 1
enum { WL_IDLE_STATUS = 0, WL_CONNECTED = 3, WL_DISCONNECTED = 6 };

struct MockIP { String toString() const { return String("192.168.1.50"); } };

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
};
inline MockWiFi WiFi;
