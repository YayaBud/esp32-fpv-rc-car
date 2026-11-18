#pragma once
#include "WiFi.h"
#include <algorithm>
#include <deque>

// Records datagrams the firmware sends; the test queues datagrams for it to receive.
struct Datagram { IPAddress ip; uint16_t port; std::vector<uint8_t> data; };

class WiFiUDP {
public:
    bool bound = false;
    uint16_t localPort = 0;
    std::deque<Datagram> rx;
    std::vector<Datagram> sent;
    Datagram cur, out;

    uint8_t begin(uint16_t p) { bound = true; localPort = p; return 1; }
    int parsePacket() {
        if (rx.empty()) return 0;
        cur = rx.front(); rx.pop_front();
        return (int)cur.data.size();
    }
    int read(uint8_t* b, size_t n) {
        size_t k = std::min(n, cur.data.size());
        memcpy(b, cur.data.data(), k);
        return (int)k;
    }
    IPAddress remoteIP() { return cur.ip; }
    uint16_t remotePort() { return cur.port; }
    int beginPacket(IPAddress ip, uint16_t port) { out = {ip, port, {}}; return 1; }
    size_t write(const uint8_t* b, size_t n) { out.data.insert(out.data.end(), b, b + n); return n; }
    int endPacket() { sent.push_back(out); return 1; }
};
