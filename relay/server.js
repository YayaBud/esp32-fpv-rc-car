/**
 * Ultra-Low-Latency Dual-WebSocket Relay Server
 * Architecture: FPV RC Battle Car v3.4 Specification
 *
 * Endpoints:
 *   /ws/control?room=<room_id>&role=<car|controller>&token=<token>
 *   /ws/video?room=<room_id>&role=<car|controller>&token=<token>
 *   udp :UDP_PORT (8081) - car control path for weak links: "HELLO <room> <token>" registers
 *                          the car's address; 8-byte commands go out, 8-byte ACKs come back
 *   /health, /stats - HTTP health check & room statistics
 *   / , /index.html, /app.js, /style.css - static cockpit files
 */

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const { WebSocketServer, WebSocket } = require('ws');
const { Ghosts, trackMessage } = require('./track');

const PORT = process.env.PORT || 8080;
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const VIDEO_HWM_BYTES = 32 * 1024;   // 32 KB drop-on-backpressure threshold for video
const CONTROL_HWM_BYTES = 1024;      // drop stale control packets past this buffered amount
const PING_INTERVAL_MS = 3000;       // 3 seconds transport Ping interval
const MAX_MISSED_PONGS = 3;          // drop a socket after ~9 s with no pong
const MAX_ROOMS = 64;
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const COCKPIT_DIR = path.join(__dirname, '..', 'cockpit');
const CLAIM_HOLD_MS = 10000;   // lobby hold on a handed-out room until its player connects
// UDP control path: on a weak link TCP stalled >= 1.5 s while ping stayed under 327 ms (measured).
// Every controller command goes to the car over UDP and the WebSocket; the car keeps the newest.
const UDP_PORT = Number(process.env.UDP_PORT ?? 8081);
const UDP_FRESH_MS = 3000;           // car's UDP address is used while hellos/ACKs keep arriving
const HELLO_RE = /^HELLO ([A-Za-z0-9_-]{1,32}) ?([A-Za-z0-9]*)$/;

// Room State Dictionary:
// rooms[roomId] = {
//   control: { car: ws, controller: ws },
//   video:   { car: ws, controller: ws },
//   stats:   { framesReceived, framesForwarded, framesDropped, controlDropped, carRttMs, ctrlRttMs }
// }
const rooms = new Map();

function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            control: { car: null, controller: null },
            video:   { car: null, controller: null },
            carUdp: null,    // { key, address, port, lastSeen } from the car's last hello
            stats: {
                framesReceived: 0,
                framesForwarded: 0,
                framesDropped: 0,
                controlDropped: 0,
                carRttMs: 0,
                ctrlRttMs: 0,
                udpToCar: 0,
                udpFromCar: 0,
                lastStatsReset: Date.now()
            }
        });
    }
    return rooms.get(roomId);
}

function maybeCleanupRoom(roomId, room) {
    if (!room.control.car && !room.control.controller && !room.video.car && !room.video.controller &&
        !carUdpFresh(room)) {
        if (room.carUdp) udpCars.delete(room.carUdp.key);
        rooms.delete(roomId);
        ghosts.remove(roomId);
    }
}

// ============================================================================
// UDP CONTROL PATH
// ============================================================================
const udpCars = new Map();   // "address:port" -> roomId
const udp = dgram.createSocket('udp4');
const carUdpFresh = (room) => !!room.carUdp && Date.now() - room.carUdp.lastSeen < UDP_FRESH_MS;

udp.on('error', (err) => console.error('[UDP] Socket error (control stays on WebSocket):', err.message));

udp.on('message', (msg, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`;

    if (msg.length === 8) {
        // Telemetry ACK, only from the address that said hello for its room
        const room = rooms.get(udpCars.get(key));
        if (!room || room.carUdp?.key !== key) return;
        room.carUdp.lastSeen = Date.now();
        room.stats.udpFromCar++;
        const ctl = room.control.controller;
        if (!ctl || ctl.readyState !== WebSocket.OPEN) return;
        if (ctl.bufferedAmount > CONTROL_HWM_BYTES) {
            room.stats.controlDropped++;
            return;
        }
        ctl.send(msg, { binary: true });
        return;
    }

    const m = msg.length <= 80 && HELLO_RE.exec(msg.toString('latin1'));
    if (!m) return;
    const [, roomId, token] = m;
    if (RELAY_TOKEN && !tokenMatches(token)) return;
    if (!rooms.has(roomId) && rooms.size >= MAX_ROOMS) return;

    const room = getOrCreateRoom(roomId);
    if (room.carUdp?.key !== key) {
        if (room.carUdp) udpCars.delete(room.carUdp.key);
        const other = rooms.get(udpCars.get(key));
        if (other) other.carUdp = null;    // one address drives one room
        udpCars.set(key, roomId);
        console.log(`[UDP] Car hello: Room '${roomId}' from ${key}`);
    }
    room.carUdp = { key, address: rinfo.address, port: rinfo.port, lastSeen: Date.now() };
});

// ============================================================================
// TOKEN CHECK (constant-time, via sha256 digest to avoid length leaks/mismatch)
// ============================================================================
function tokenMatches(provided) {
    const a = crypto.createHash('sha256').update(String(provided)).digest();
    const b = crypto.createHash('sha256').update(String(RELAY_TOKEN)).digest();
    return crypto.timingSafeEqual(a, b);
}

// ============================================================================
// STATIC COCKPIT FILES (fixed whitelist only - never joins user input)
// ============================================================================
const STATIC_FILES = {
    '/':           { file: 'lobby.html', type: 'text/html' },
    '/index.html': { file: 'index.html', type: 'text/html' },
    '/app.js':     { file: 'app.js', type: 'text/javascript' },
    '/bg.js':      { file: 'bg.js', type: 'text/javascript' },
    '/style.css':  { file: 'style.css', type: 'text/css' }
};

// ============================================================================
// HTTP SERVER (Health & Telemetry API + static cockpit)
// ============================================================================
const server = http.createServer((req, res) => {
    let parsedUrl;
    try {
        parsedUrl = new URL(req.url, 'http://localhost');
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request\n');
        return;
    }
    const pathname = parsedUrl.pathname;

    if (pathname === '/health' || pathname === '/stats') {
        const statsObj = {};
        for (const [id, room] of rooms.entries()) {
            statsObj[id] = {
                carConnected: !!room.control.car,
                controllerConnected: !!room.control.controller,
                videoCarConnected: !!room.video.car,
                videoControllerConnected: !!room.video.controller,
                carUdp: carUdpFresh(room),
                claimed: room.claimedUntil > Date.now(),
                stats: room.stats
            };
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), rooms: statsObj }, null, 2));
        return;
    }

    // Lobby: hand a new player the car they picked (?room=) or else the first online car nobody
    // is driving. The room is held for CLAIM_HOLD_MS so two players picking together can't both
    // land in it (the second controller would kick the first). The hold ends when a controller connects.
    if (pathname === '/claim') {
        const now = Date.now();
        const isFree = (id) => {
            const r = rooms.get(id);
            return r?.control.car?.readyState === WebSocket.OPEN && !r.control.controller &&
                   !(r.claimedUntil > now);
        };
        const want = parsedUrl.searchParams.get('room');
        const free = want ? (isFree(want) ? want : null) : [...rooms.keys()].sort().find(isFree);
        if (free) rooms.get(free).claimedUntil = now + CLAIM_HOLD_MS;
        res.writeHead(free ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        const cars = [...rooms.values()].filter((r) => r.control.car?.readyState === WebSocket.OPEN).length;
        res.end(JSON.stringify({ room: free || null, cars }));
        return;
    }

    const staticEntry = STATIC_FILES[pathname];
    if (staticEntry) {
        fs.readFile(path.join(COCKPIT_DIR, staticEntry.file), (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found\n');
                return;
            }
            res.writeHead(200, { 'Content-Type': staticEntry.type });
            res.end(data);
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
});

server.on('clientError', (err, socket) => {
    socket.destroy();
});

// ============================================================================
// DUAL WEBSOCKET SERVERS
// ============================================================================
const wssControl = new WebSocketServer({ noServer: true, maxPayload: 64 });
const wssVideo   = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

function rejectUpgrade(socket, code, reason) {
    socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
}

// Route + validate HTTP Upgrade Requests BEFORE handing off to the ws server
server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});

    let parsed;
    try {
        parsed = new URL(req.url, 'http://localhost');
    } catch (e) {
        return rejectUpgrade(socket, 400, 'Bad Request');
    }

    const pathname = parsed.pathname;
    if (pathname !== '/ws/control' && pathname !== '/ws/video') {
        return rejectUpgrade(socket, 404, 'Not Found');
    }

    const role = parsed.searchParams.get('role');
    if (role !== 'car' && role !== 'controller') {
        return rejectUpgrade(socket, 400, 'Bad Request');
    }

    const roomId = parsed.searchParams.get('room') || '';
    if (!ROOM_ID_RE.test(roomId)) {
        return rejectUpgrade(socket, 400, 'Bad Request');
    }

    if (RELAY_TOKEN) {
        const token = parsed.searchParams.get('token') || '';
        if (!tokenMatches(token)) {
            return rejectUpgrade(socket, 401, 'Unauthorized');
        }
    }

    if (!rooms.has(roomId) && rooms.size >= MAX_ROOMS) {
        return rejectUpgrade(socket, 503, 'Service Unavailable');
    }

    const wss = pathname === '/ws/control' ? wssControl : wssVideo;
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, { roomId, role });
    });
});

// ============================================================================
// CONTROL WEBSOCKET HANDLER
// ============================================================================
wssControl.on('connection', (ws, req, { roomId, role }) => {
    const room = getOrCreateRoom(roomId);
    ws.roomId = roomId;
    ws.role = role;
    ws.isAlive = true;
    ws.lastPingSent = 0;

    ws.on('error', (err) => {
        console.error(`[CTRL] Socket error (Room '${roomId}', Role '${role}'):`, err.message);
    });

    console.log(`[CTRL] Connection: Room '${roomId}', Role '${role}'`);

    // Assign slot
    if (role === 'car') {
        if (room.control.car && room.control.car.readyState === WebSocket.OPEN) {
            room.control.car.close(1000, 'Replaced by new car connection');
        }
        room.control.car = ws;
    } else {
        if (room.control.controller && room.control.controller.readyState === WebSocket.OPEN) {
            room.control.controller.close(1000, 'Replaced by new controller');
        }
        room.control.controller = ws;
        room.claimedUntil = 0;
    }

    // Native Pong listener for transport RTT measurement
    ws.on('pong', () => {
        ws.isAlive = true;
        if (ws.lastPingSent > 0) {
            const rtt = Date.now() - ws.lastPingSent;
            if (role === 'car') room.stats.carRttMs = rtt;
            else room.stats.ctrlRttMs = rtt;
        }
    });

    ws.on('message', (data, isBinary) => {
        if (!isBinary || !Buffer.isBuffer(data) || data.length !== 8) return;
        if (role === 'controller') ghosts.command(roomId, data);   // virtual track (read only)

        // Weak-link path: every command also goes over UDP; the car keeps the newest copy
        if (role === 'controller' && carUdpFresh(room)) {
            udp.send(data, room.carUdp.port, room.carUdp.address);
            room.stats.udpToCar++;
        }

        // Newest wins: forward only 8-byte control/telemetry frames, drop stale ones
        const target = role === 'controller' ? room.control.car : room.control.controller;
        if (!target || target.readyState !== WebSocket.OPEN) return;

        if (target.bufferedAmount > CONTROL_HWM_BYTES) {
            room.stats.controlDropped++;
            return;
        }

        target.send(data, { binary: true });
    });

    ws.on('close', () => {
        console.log(`[CTRL] Disconnected: Room '${roomId}', Role '${role}'`);
        if (role === 'car' && room.control.car === ws) room.control.car = null;
        if (role === 'controller' && room.control.controller === ws) room.control.controller = null;
        maybeCleanupRoom(roomId, room);
    });
});

// ============================================================================
// VIDEO WEBSOCKET HANDLER (Bounded Drop-on-Backpressure)
// ============================================================================
wssVideo.on('connection', (ws, req, { roomId, role }) => {
    const room = getOrCreateRoom(roomId);
    ws.roomId = roomId;
    ws.role = role;
    ws.isAlive = true;

    ws.on('error', (err) => {
        console.error(`[VIDEO] Socket error (Room '${roomId}', Role '${role}'):`, err.message);
    });

    console.log(`[VIDEO] Connection: Room '${roomId}', Role '${role}'`);

    if (role === 'car') {
        if (room.video.car && room.video.car.readyState === WebSocket.OPEN) {
            room.video.car.close(1000, 'Replaced by new video car stream');
        }
        room.video.car = ws;
    } else {
        if (room.video.controller && room.video.controller.readyState === WebSocket.OPEN) {
            room.video.controller.close(1000, 'Replaced by new video viewer');
        }
        room.video.controller = ws;
        ws.send(trackMessage);   // virtual track layout; poses follow at 20 Hz
    }

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data, isBinary) => {
        if (role === 'controller') {
            if (!isBinary && data.toString() === 'reset') ghosts.reset(roomId);   // car put back on the start line
            return;
        }
        if (!isBinary) return;

        room.stats.framesReceived++;

        const viewer = room.video.controller;
        if (!viewer || viewer.readyState !== WebSocket.OPEN) {
            return;
        }

        // BOUNDED DROP-ON-BACKPRESSURE:
        // If the viewer's socket buffer exceeds 32 KB, drop incoming frame
        if (viewer.bufferedAmount > VIDEO_HWM_BYTES) {
            room.stats.framesDropped++;
            return; // Frame dropped - zero buffer bloat!
        }

        viewer.send(data, { binary: true }, (err) => {
            if (!err) room.stats.framesForwarded++;
        });
    });

    ws.on('close', () => {
        console.log(`[VIDEO] Disconnected: Room '${roomId}', Role '${role}'`);
        if (role === 'car' && room.video.car === ws) room.video.car = null;
        if (role === 'controller' && room.video.controller === ws) room.video.controller = null;
        maybeCleanupRoom(roomId, room);
    });
});

// ============================================================================
// PERIODIC PROTOCOL PING (Every 3 seconds)
// ============================================================================
const pingInterval = setInterval(() => {
    const now = Date.now();

    for (const [roomId, room] of rooms.entries()) {
        if (room.carUdp && !carUdpFresh(room)) {
            udpCars.delete(room.carUdp.key);
            room.carUdp = null;
            maybeCleanupRoom(roomId, room);
        }

        // Ping Control sockets
        [room.control.car, room.control.controller].forEach((ws) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                // Phone hotspots spike RTT to ~1 s (measured 849 ms); allow a few missed pongs
                ws.missedPongs = ws.isAlive ? 0 : (ws.missedPongs || 0) + 1;
                if (ws.missedPongs >= MAX_MISSED_PONGS) {
                    console.log(`[PING] Heartbeat timeout. Terminating socket (${ws.role}, Room: ${roomId})`);
                    return ws.terminate();
                }
                ws.isAlive = false;
                ws.lastPingSent = now;
                ws.ping(); // Native RFC 6455 Ping
            }
        });

        // Ping Video sockets
        [room.video.car, room.video.controller].forEach((ws) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.missedPongs = ws.isAlive ? 0 : (ws.missedPongs || 0) + 1;
                if (ws.missedPongs >= MAX_MISSED_PONGS) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            }
        });
    }
}, PING_INTERVAL_MS);
pingInterval.unref();

// ============================================================================
// VIRTUAL TRACK (cars without a camera): move each online car's ghost from the
// commands it was sent, then send every ghost's pose to every camera-less viewer.
// ============================================================================
const ghosts = new Ghosts();
let lastTrackTick = performance.now();
const trackInterval = setInterval(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastTrackTick) / 1000);   // measured: Windows timers drift
    lastTrackTick = now;
    const online = new Set([...rooms]
        .filter(([, r]) => r.control.car?.readyState === WebSocket.OPEN || carUdpFresh(r))
        .map(([id]) => id));
    ghosts.tick(online, dt);
    if (!ghosts.cars.size) return;
    const msg = JSON.stringify(ghosts.snapshot());
    for (const room of rooms.values()) {
        const viewer = room.video.controller;
        if (room.video.car || viewer?.readyState !== WebSocket.OPEN || viewer.bufferedAmount > VIDEO_HWM_BYTES) continue;
        viewer.send(msg);
    }
}, 50);
trackInterval.unref();

// UDP lives and dies with the HTTP server (tests listen on port 0 for both)
server.on('listening', () => udp.bind(UDP_PORT));
server.on('close', () => udp.close());
udp.on('listening', () => console.log(`  UDP control: port ${udp.address().port}`));

module.exports = { server, rooms, udp };

// Start server only when run directly (tests require() this file instead)
if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`=======================================================`);
        console.log(`  FPV Battle Car Cloud Relay listening on port ${PORT} `);
        console.log(`  Control: ws://localhost:${PORT}/ws/control           `);
        console.log(`  Video:   ws://localhost:${PORT}/ws/video             `);
        console.log(`  Stats:   http://localhost:${PORT}/health             `);
        console.log(`  Cockpit: http://localhost:${PORT}/                   `);
        console.log(`  Auth:    ${RELAY_TOKEN ? 'RELAY_TOKEN required' : 'no token required'}`);
        console.log(`=======================================================`);
    });
}
