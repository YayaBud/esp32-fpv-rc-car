// Host-side stand-in for the Arduino-ESP32 core: just enough for the car firmware
// to compile on a PC, with every hardware effect recorded in `mock::`.
#pragma once
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#define HIGH 1
#define LOW 0
#define OUTPUT 3
#define constrain(amt, low, high) ((amt) < (low) ? (low) : ((amt) > (high) ? (high) : (amt)))

enum { ADC_0db, ADC_2_5db, ADC_6db, ADC_11db };

namespace mock {
inline uint32_t now_ms = 0;
inline uint32_t now_us_frac = 0;
inline int duty[64] = {};          // last ledcWrite per pin
inline int digital[64] = {};       // last digitalWrite per pin
inline bool attached[64] = {};
inline uint32_t adc_mv = 0;        // what analogReadMilliVolts returns (pin voltage)
inline std::vector<std::string> events;   // ordered hardware log
inline bool verbose = false;
}

inline uint32_t millis() { return mock::now_ms; }
inline void delay(uint32_t ms) { mock::now_ms += ms; }
inline void delayMicroseconds(uint32_t us) {
    mock::now_us_frac += us;
    mock::now_ms += mock::now_us_frac / 1000;
    mock::now_us_frac %= 1000;
}

inline void pinMode(uint8_t pin, uint8_t) { mock::events.push_back("pinMode " + std::to_string(pin)); }
inline void digitalWrite(uint8_t pin, uint8_t v) {
    mock::digital[pin] = v;
    mock::events.push_back("digitalWrite " + std::to_string(pin) + " " + std::to_string(v));
}
inline int digitalRead(uint8_t pin) { return mock::digital[pin]; }

inline bool ledcAttach(uint8_t pin, uint32_t, uint8_t) {
    mock::attached[pin] = true;
    mock::events.push_back("ledcAttach " + std::to_string(pin));
    return true;
}
inline bool ledcWrite(uint8_t pin, uint32_t d) {
    if (!mock::attached[pin]) mock::events.push_back("UNATTACHED_WRITE " + std::to_string(pin));
    mock::duty[pin] = (int)d;
    return true;
}

inline void analogSetPinAttenuation(uint8_t, int) {}
inline uint32_t analogReadMilliVolts(uint8_t) { return mock::adc_mv; }

class String {
public:
    String(const char* s = "") : s_(s) {}
    String(const std::string& s) : s_(s) {}
    const char* c_str() const { return s_.c_str(); }
    friend String operator+(const String& a, const String& b) { return String(a.s_ + b.s_); }
    friend String operator+(const String& a, const char* b) { return String(a.s_ + b); }
private:
    std::string s_;
};

struct MockSerial {
    void begin(unsigned long) {}
    void print(const char* s) { if (mock::verbose) fputs(s, stdout); }
    void println(const char* s = "") { if (mock::verbose) puts(s); }
    void printf(const char* fmt, ...) {
        if (!mock::verbose) return;
        va_list ap; va_start(ap, fmt); vprintf(fmt, ap); va_end(ap);
    }
};
inline MockSerial Serial;

struct MockESP {
    uint32_t getFreeHeap() { return 280000; }
    uint32_t getFreePsram() { return 0; }
};
inline MockESP ESP;
