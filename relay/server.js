/**
 * Ultra-Low-Latency Dual-WebSocket Relay Server
 * Architecture: FPV RC Battle Car v3.4 Specification
 *
 * Endpoints:
 *   /ws/control?room=<room_id>&role=<car|controller>&token=<token>
 *   /ws/video?room=<room_id>&role=<car|controller>&token=<token>
 *   /health, /stats - HTTP health check & room statistics
 *   / , /index.html, /app.js, /style.css - static cockpit files
 */

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const VIDEO_HWM_BYTES = 32 * 1024;   // 32 KB drop-on-backpressure threshold for video
const CONTROL_HWM_BYTES = 1024;      // drop stale control packets past this buffered amount
const PING_INTERVAL_MS = 3000;       // 3 seconds transport Ping interval
const MAX_ROOMS = 64;
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const COCKPIT_DIR = path.join(__dirname, '..', 'cockpit');

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
            stats: {
                framesReceived: 0,
                framesForwarded: 0,
                framesDropped: 0,
                controlDropped: 0,
                carRttMs: 0,
                ctrlRttMs: 0,
                lastStatsReset: Date.now()
            }
        });
    }
    return rooms.get(roomId);
}

function maybeCleanupRoom(roomId, room) {
    if (!room.control.car && !room.control.controller && !room.video.car && !room.video.controller) {
        rooms.delete(roomId);
    }
}

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
    '/':           { file: 'index.html', type: 'text/html' },
    '/index.html': { file: 'index.html', type: 'text/html' },
    '/app.js':     { file: 'app.js', type: 'text/javascript' },
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
                stats: room.stats
            };
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), rooms: statsObj }, null, 2));
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
    }

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data, isBinary) => {
        if (!isBinary || role !== 'car') return;

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
        // Ping Control sockets
        [room.control.car, room.control.controller].forEach((ws) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                if (!ws.isAlive) {
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
                if (!ws.isAlive) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            }
        });
    }
}, PING_INTERVAL_MS);
pingInterval.unref();

module.exports = { server, rooms };

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
