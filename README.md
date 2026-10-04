# ESP32 FPV RC Car — drive a car over the internet from a browser

A tank-drive RC car you can drive from any phone or laptop browser. The car connects out to a small Node.js relay over WebSockets. The browser cockpit connects to the same relay, so neither side needs a public IP.

```
 browser cockpit  ──ws──►  relay (Node.js)  ◄──ws──  ESP32 car
 (keyboard / touch /        /ws/control  8-byte packets, ~50 Hz        (L298N, 4 TT motors)
  gamepad)                  /ws/video    JPEG frames (optional)
```

## What's in here

| Path | What it is |
|---|---|
| `firmware/esp32_car/` | Car firmware (Arduino, arduino-esp32 core 3.x). Tank drive over an L298N, failsafe, battery monitor, optional camera. |
| `firmware/bench_tests/` | Step-by-step bring-up sketches: motor test, ADC calibration, camera bench, standalone drive. |
| `firmware/test/` | Host-side unit test. Compiles the real `.ino` + `motor.cpp` + `battery.cpp` on a PC against Arduino mocks. |
| `relay/` | Node.js relay: rooms, optional shared token, backpressure dropping, `/health`, and serves the cockpit. Includes `sim_car.js`, a protocol-exact simulated car. |
| `cockpit/` | Plain HTML/CSS/JS driver UI: video, telemetry, joystick, keyboard and gamepad. |

## Safety behaviour

- **Failsafe:** the car brakes if no control packet arrives for 300 ms, and immediately if the control socket drops.
- **Lost focus stops the car:** alt-tab or switching tabs while holding a key releases every input and sends a brake packet, because the key-up would never arrive.
- **Battery:** with a voltage divider wired, the firmware caps throttle at 60 % below 6.6 V and cuts off after 3 s sustained under 6.2 V. With no divider it reports `NO SENSOR` and still drives, so use a pack with its own low-voltage alarm.
- **Relay hardening:** an optional `RELAY_TOKEN` (constant-time compare), room-name validation, a cap of 64 rooms, and newest-wins dropping so latency can't build up under congestion.

## Measured

- Relay end-to-end tests (`cd relay && npm test`): **16/16 pass** (Node test runner, ~4 s).
- Relay + simulated car on one machine: control round trip p50 **0.89 ms** / p99 **3.34 ms**. This is loopback, not over the air.
- A phone on home Wi-Fi driving the simulated car: **64 ms** controller RTT. That is a single sample, not a distribution.
- Video forwarding over that session: 1,054 frames, **0 dropped**.

Not yet measured: a real car on a real network path, and the internet route through a VPS with `wss`.

## Run it

```bash
# relay + cockpit
cd relay && npm install && npm start          # cockpit at http://localhost:8080
npm run sim                                    # simulated car, no hardware needed

# firmware host test (needs a C++17 compiler)
bash firmware/test/run_tests.sh               # CXX defaults to "python -m ziglang c++"
```

For the car: copy `firmware/esp32_car/secrets.example.h` to `secrets.h` (gitignored) and fill in Wi-Fi, relay host, room and token. Then flash with Board = *ESP32 Dev Module*. Wiring is documented at the top of `firmware/esp32_car/config.h`.
