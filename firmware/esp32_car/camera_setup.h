#pragma once
#include <Arduino.h>
#include "config.h"

#if ENABLE_VIDEO
#include "esp_camera.h"

bool initCamera(framesize_t frame_size = FRAMESIZE_QVGA, int jpeg_quality = 12);
#endif
