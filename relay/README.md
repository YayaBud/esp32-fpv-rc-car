# FPV Battle Car Cloud Relay Server

Ultra-low-latency dual-WebSocket relay server for Internet-controlled FPV RC battle cars. Built with Node.js and `ws`.

## Features
- **Dual WebSocket Isolation**: Dedicated `/ws/control` (8-byte binary @ 50 Hz) and `/ws/video` (binary JPEG/PNG stream) endpoints preventing TCP Head-of-Line blocking.
- **Room-Based Routing**: Multi-car support with query parameters: `?room=room_1&role=car` or `?room=room_1&role=controller`.
- **Optional Shared Token**: Set `RELAY_TOKEN` in the environment (or `relay/.env`, never committed) to require `&token=...` on every WebSocket connection. Unset/empty means no auth.
- **Bounded Drop-on-Backpressure**: 32 KB HWM drops stale camera frames, 1 KB HWM drops stale control packets, on network congestion — newest wins, preventing latency buildup.
- **Native RFC 6455 Ping/Pong**: Server-initiated ping frames measure transport RTT to car and browser independently.
- **Health & Telemetry API**: Endpoint `/health` outputs real-time frame rates, drop rates, and connection states.
- **Cockpit Static Hosting**: Serves `cockpit/` (`/`, `/index.html`, `/app.js`, `/style.css`) so a player can just open `http://<relay-host>:<port>/`.
- **Simulated Car**: `npm run sim` runs `sim_car.js`, a protocol-exact simulated car (physics + failsafe + a synthetic top-down video feed) for testing the relay/cockpit without hardware.

## Quick Start (Local)

1. Install Node.js (v18 or higher):
   ```bash
   node -v
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run the relay server:
   ```bash
   npm start
   ```
   The relay will listen on port `8080` (or `PORT` environment variable).
   Set `RELAY_TOKEN` to require a shared secret on every WebSocket connection.

4. Run the tests:
   ```bash
   npm test
   ```

5. Drive a simulated car (no hardware needed):
   ```bash
   npm run sim -- --room battle_room_1
   ```
   Then open the cockpit at `http://localhost:8080/`.

## Deployment to Cloud VPS (Ubuntu / Debian)

1. Clone repository or upload `relay/` folder to `/opt/relay`.
2. Install PM2 process manager:
   ```bash
   npm install -g pm2
   pm2 start server.js --name "fpv-relay"
   pm2 save
   pm2 startup
   ```
3. Set up Nginx reverse proxy with SSL (`wss://`) using Let's Encrypt / Certbot:
   ```nginx
   server {
       server_name relay.yourdomain.com;

       location /ws/ {
           proxy_pass http://localhost:8080;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "Upgrade";
           proxy_set_header Host $host;
           proxy_read_timeout 86400s;
           proxy_send_timeout 86400s;
       }

       location / {
           proxy_pass http://localhost:8080;
       }
   }
   ```
