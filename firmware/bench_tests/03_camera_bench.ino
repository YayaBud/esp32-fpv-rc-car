/*
 * PHASE 2 ONLY - does not apply to the plain ESP32 DevKit (it has no camera).
 *
 * Bench Test 03: OV2640 Camera & PSRAM Performance Benchmark
 * Board: Seeed XIAO ESP32S3 Sense (needs the Sense camera add-on board and
 *        Tools > PSRAM: OPI PSRAM).
 *
 * Objective:
 *   1. Initialize OV2640 using the XIAO ESP32S3 Sense pin mapping.
 *   2. Configure QVGA (320x240) JPEG mode in PSRAM frame buffers.
 *   3. Capture continuous frames and measure actual capture FPS and byte sizes.
 *   4. Log free internal SRAM and free PSRAM to verify zero memory leaks.
 */

#include <Arduino.h>
#include "esp_camera.h"

// XIAO ESP32S3 Sense camera pin definitions
#define PWDN_GPIO_NUM       -1
#define RESET_GPIO_NUM      -1
#define XCLK_GPIO_NUM       10
#define SIOD_GPIO_NUM       40
#define SIOC_GPIO_NUM       39

#define Y9_GPIO_NUM         48
#define Y8_GPIO_NUM         11
#define Y7_GPIO_NUM         12
#define Y6_GPIO_NUM         14
#define Y5_GPIO_NUM         16
#define Y4_GPIO_NUM         18
#define Y3_GPIO_NUM         17
#define Y2_GPIO_NUM         15
#define VSYNC_GPIO_NUM      38
#define HREF_GPIO_NUM       47
#define PCLK_GPIO_NUM       13

#define CAMERA_LEDC_CHANNEL LEDC_CHANNEL_7
#define CAMERA_LEDC_TIMER   LEDC_TIMER_3

void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("\n=== OV2640 Camera Benchmark Initializing ===");

    if (!psramFound()) {
        Serial.println("FATAL: PSRAM not found! Please enable PSRAM in Tools -> PSRAM: OPI PSRAM.");
        while (true) delay(1000);
    }
    Serial.printf("PSRAM detected: %u bytes total, %u bytes free\n",
                  ESP.getPsramSize(), ESP.getFreePsram());
    Serial.printf("Internal Heap free: %u bytes\n", ESP.getFreeHeap());

    camera_config_t config;
    config.ledc_channel = CAMERA_LEDC_CHANNEL;
    config.ledc_timer = CAMERA_LEDC_TIMER;
    config.pin_d0 = Y2_GPIO_NUM;
    config.pin_d1 = Y3_GPIO_NUM;
    config.pin_d2 = Y4_GPIO_NUM;
    config.pin_d3 = Y5_GPIO_NUM;
    config.pin_d4 = Y6_GPIO_NUM;
    config.pin_d5 = Y7_GPIO_NUM;
    config.pin_d6 = Y8_GPIO_NUM;
    config.pin_d7 = Y9_GPIO_NUM;
    config.pin_xclk = XCLK_GPIO_NUM;
    config.pin_pclk = PCLK_GPIO_NUM;
    config.pin_vsync = VSYNC_GPIO_NUM;
    config.pin_href = HREF_GPIO_NUM;
    config.pin_sccb_sda = SIOD_GPIO_NUM;
    config.pin_sccb_scl = SIOC_GPIO_NUM;
    config.pin_pwdn = PWDN_GPIO_NUM;
    config.pin_reset = RESET_GPIO_NUM;
    config.xclk_freq_hz = 20000000;
    config.pixel_format = PIXFORMAT_JPEG;
    config.frame_size = FRAMESIZE_QVGA; // 320x240 for battle car
    config.jpeg_quality = 12;            // 10-12 for high quality low latency
    config.fb_count = 2;                 // Double buffering in PSRAM
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_LATEST;

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK) {
        Serial.printf("Camera init failed with error 0x%x\n", err);
        while (true) delay(1000);
    }
    Serial.println("Camera initialized successfully.");

    sensor_t *s = esp_camera_sensor_get();
    if (s) {
        s->set_vflip(s, 1);    // Adjust if camera mounted inverted
        s->set_hmirror(s, 0);
    }
    Serial.println("Beginning 10-second capture throughput test...\n");
}

void loop() {
    static uint32_t frame_count = 0;
    static uint32_t total_bytes = 0;
    static uint32_t start_time = millis();

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        Serial.println("Camera frame capture failed!");
        delay(100);
        return;
    }

    frame_count++;
    total_bytes += fb->len;
    esp_camera_fb_return(fb);

    uint32_t elapsed = millis() - start_time;
    if (elapsed >= 2000) { // Log every 2 seconds
        float fps = (frame_count * 1000.0f) / elapsed;
        float avg_kb = (float)total_bytes / frame_count / 1024.0f;
        float mbps = (total_bytes * 8.0f) / (elapsed / 1000.0f) / 1000000.0f;

        Serial.printf("Capture FPS: %5.1f | Avg Frame: %4.1f KB | Bandwidth: %4.2f Mbps | Free PSRAM: %6u KB | Free Heap: %5u KB\n",
                      fps, avg_kb, mbps, ESP.getFreePsram() / 1024, ESP.getFreeHeap() / 1024);

        frame_count = 0;
        total_bytes = 0;
        start_time = millis();
    }
}
