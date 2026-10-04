#pragma once

// Copy this file to secrets.h (same folder) and fill in your own values.
// secrets.h is gitignored / private - never commit real credentials.

#define WIFI_SSID     "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Local IP or cloud VPS domain of the relay server.
#define RELAY_HOST    "192.168.1.100"
#define RELAY_PORT    8080
#define ROOM_ID       "battle_room_1"

// Leave "" if the relay has no token requirement. Letters/digits only -
// it is sent as a URL query parameter.
#define RELAY_TOKEN   ""

// 0 = plain ws:// (local bench testing), 1 = secure wss:// (cloud VPS).
#define USE_WSS       0
