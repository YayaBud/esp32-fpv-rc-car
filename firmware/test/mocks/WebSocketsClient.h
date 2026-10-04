#pragma once
#include "Arduino.h"

enum WStype_t {
    WStype_ERROR, WStype_DISCONNECTED, WStype_CONNECTED, WStype_TEXT, WStype_BIN,
    WStype_FRAGMENT_TEXT_START, WStype_FRAGMENT_BIN_START, WStype_FRAGMENT, WStype_FRAGMENT_FIN,
    WStype_PING, WStype_PONG
};
typedef void (*WebSocketClientEvent)(WStype_t type, uint8_t* payload, size_t length);

// Records what the firmware sends; the test drives events through `cb`.
class WebSocketsClient {
public:
    std::string host, url;
    uint16_t port = 0;
    bool ssl = false, connected = false;
    WebSocketClientEvent cb = nullptr;
    std::vector<std::vector<uint8_t>> sent;

    void begin(const char* h, uint16_t p, const char* u) { host = h; port = p; url = u; }
    void beginSSL(const char* h, uint16_t p, const char* u) { begin(h, p, u); ssl = true; }
    void onEvent(WebSocketClientEvent e) { cb = e; }
    void setReconnectInterval(unsigned long) {}
    void enableHeartbeat(uint32_t, uint32_t, uint8_t) {}
    void loop() {}
    bool isConnected() { return connected; }
    bool sendBIN(const uint8_t* p, size_t n) {
        if (!connected) return false;
        sent.emplace_back(p, p + n);
        return true;
    }
};
