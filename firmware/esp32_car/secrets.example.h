#pragma once

// Copy this file to secrets.h (same folder) and fill in your own values.
// secrets.h is gitignored / private - never commit real credentials.

#define WIFI_SSID     "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Local IP or cloud VPS domain of the relay server.
#define RELAY_HOST    "192.168.1.100"
#define RELAY_PORT    8080
#ifndef ROOM_ID  // car 2 overrides with -DROOM_ID=...
#define ROOM_ID       "battle_room_1"
#endif

// Leave "" if the relay has no token requirement. Letters/digits only -
// it is sent as a URL query parameter.
#define RELAY_TOKEN   ""

// 0 = plain ws:// (local bench testing), 1 = secure wss:// (cloud VPS).
#define USE_WSS       0

// Control also goes over UDP to RELAY_HOST:8081 (much better on weak Wi-Fi). On by default with
// USE_WSS 0, off with USE_WSS 1 until UDP packets are authenticated. Override if needed:
// #define USE_UDP_CONTROL 1
// #define RELAY_UDP_PORT  8081

// Password for Wi-Fi firmware updates (ArduinoOTA). "" = Wi-Fi updates off (USB only).
#define OTA_PASSWORD  ""
