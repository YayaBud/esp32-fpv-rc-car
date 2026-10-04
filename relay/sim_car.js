/**
 * Simulated car — speaks the exact firmware protocol so the relay and cockpit
 * can be driven end-to-end without hardware.
 *
 * Mirrors firmware/esp32s3_car: 8-byte control packets (len 8, version 0x01,
 * throttle clamped to ±100), 300 ms failsafe, failsafe on control disconnect,
 * brake flag, duty mapping from motor.cpp, telemetry ACK on receipt (≥100 ms
 * apart) plus a 250 ms fallback. Adds 2-D differential-drive physics and
 * streams a top-down PNG view on the video socket in place of the camera.
 *
 * CLI: node sim_car.js [--host localhost] [--port 8080] [--room battle_room_1]
 *                      [--token X] [--no-video] [--ssl]
 */

const { EventEmitter } = require('events');
const zlib = require('zlib');
const WebSocket = require('ws');

const FAILSAFE_TIMEOUT_MS = 300;
const TELEMETRY_INTERVAL_MS = 100;
const TELEMETRY_FALLBACK_MS = 250;
const TICK_MS = 10;
const MAX_SPEED = 0.6;        // m/s at duty 255
const TRACK = 0.12;           // m between wheels
const ARENA_W = 3, ARENA_H = 2;
const CAR_L = 0.15, CAR_W = 0.10;
const IMG_W = 160, IMG_H = 120;

// Same mapping as MotorController::throttleToDuty (without invert / battery limit).
function throttleToDuty(t, minDuty = 0) {
    t = Math.max(-100, Math.min(100, t));
    if (t === 0) return 0;
    const duty = minDuty + Math.floor((Math.abs(t) * (255 - minDuty) + 50) / 100);
    return t < 0 ? -duty : duty;
}

function decodeControl(buf) {
    if (buf.length !== 8 || buf[7] !== 0x01) return null;
    const clamp = (v) => Math.max(-100, Math.min(100, v));
    return {
        session: buf.readUInt16BE(0),
        seq: buf.readUInt16BE(2),
        left: clamp(buf.readInt8(4)),
        right: clamp(buf.readInt8(5)),
        flags: buf[6]
    };
}

class SimCar extends EventEmitter {
    constructor({ url = 'ws://localhost:8080', room = 'battle_room_1', token = '', video = false, minDuty = 0 } = {}) {
        super();
        Object.assign(this, { url, room, token, video, minDuty });
        this.left = 0; this.right = 0; this.flags = 0;
        this.failsafe = true;
        this.dutyL = 0; this.dutyR = 0;
        this.x = ARENA_W / 2; this.y = ARENA_H / 2;
        this.heading = 0;     // radians; 0 = facing +y ("up" on screen), positive = clockwise
        this.trail = [];
        this.packetsReceived = 0;
        this.lastSession = 0; this.lastSeq = 0;
        this.controlConnected = false;
        this._lastPacketAt = 0; this._lastAckAt = 0;
        this._running = false;
        this._sockets = {};
        this._timers = [];
    }

    _socketUrl(kind) {
        let u = `${this.url}/ws/${kind}?room=${encodeURIComponent(this.room)}&role=car`;
        if (this.token) u += `&token=${encodeURIComponent(this.token)}`;
        return u;
    }

    _open(kind) {
        if (!this._running) return;
        const ws = new WebSocket(this._socketUrl(kind));
        this._sockets[kind] = ws;
        ws.on('error', () => {});  // close follows; reconnect handles it
        ws.on('open', () => {
            if (kind === 'control') { this.controlConnected = true; this.emit('connected'); }
        });
        ws.on('message', (data, isBinary) => {
            if (kind === 'control' && isBinary) this._onControl(data);
        });
        ws.on('close', () => {
            if (kind === 'control') {
                this.controlConnected = false;
                this._tripFailsafe();   // firmware: WStype_DISCONNECTED -> tripFailsafe()
                this.emit('disconnected');
            }
            if (this._running) this._timers.push(setTimeout(() => this._open(kind), 1000));
        });
    }

    _onControl(buf) {
        const p = decodeControl(buf);
        if (!p) return;
        this.packetsReceived++;
        Object.assign(this, { left: p.left, right: p.right, flags: p.flags, lastSession: p.session, lastSeq: p.seq });
        this._lastPacketAt = Date.now();
        if (this.failsafe) { this.failsafe = false; this.emit('failsafe', false); }
        this.emit('packet', p);
        if (Date.now() - this._lastAckAt >= TELEMETRY_INTERVAL_MS) this._sendAck();
    }

    _tripFailsafe() {
        if (!this.failsafe) { this.failsafe = true; this.emit('failsafe', true); }
    }

    _sendAck() {
        this._lastAckAt = Date.now();
        const ws = this._sockets.control;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const b = Buffer.alloc(8);
        b.writeUInt16BE(this.lastSession, 0);
        b.writeUInt16BE(this.lastSeq, 2);
        b.writeUInt16BE(7800, 4);          // fake 2S pack
        b.writeInt8(-55, 6);               // fake RSSI
        b[7] = this.failsafe ? 1 : 0;
        ws.send(b);
    }

    _tick() {
        if (!this.failsafe && Date.now() - this._lastPacketAt > FAILSAFE_TIMEOUT_MS) this._tripFailsafe();
        const stopped = this.failsafe || (this.flags & 1);
        this.dutyL = stopped ? 0 : throttleToDuty(this.left, this.minDuty);
        this.dutyR = stopped ? 0 : throttleToDuty(this.right, this.minDuty);

        // Real elapsed time: Windows timers fire every ~15.6 ms, not TICK_MS.
        const now = performance.now();
        const dt = Math.min(0.1, (now - (this._lastTickAt ?? now)) / 1000);
        this._lastTickAt = now;
        const vL = this.dutyL / 255 * MAX_SPEED, vR = this.dutyR / 255 * MAX_SPEED;
        const v = (vL + vR) / 2;
        this.heading += (vL - vR) / TRACK * dt;   // left faster -> turn right (clockwise)
        this.x = Math.max(0, Math.min(ARENA_W, this.x + v * Math.sin(this.heading) * dt));
        this.y = Math.max(0, Math.min(ARENA_H, this.y + v * Math.cos(this.heading) * dt));

        if (Date.now() - this._lastAckAt >= TELEMETRY_FALLBACK_MS) this._sendAck();
    }

    _sendFrame() {
        const ws = this._sockets.video;
        if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 64 * 1024) return;
        ws.send(renderPng(this));
    }

    start() {
        this._running = true;
        this._open('control');
        if (this.video) {
            this._open('video');
            this._timers.push(setInterval(() => this._sendFrame(), 100));
            this._timers.push(setInterval(() => {
                this.trail.push([this.x, this.y]);
                if (this.trail.length > 60) this.trail.shift();
            }, 200));
        }
        this._timers.push(setInterval(() => this._tick(), TICK_MS));
        return this;
    }

    stop() {
        this._running = false;
        this._timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
        this._timers = [];
        for (const ws of Object.values(this._sockets)) ws.terminate();
    }
}

// ============================================================================
// TOP-DOWN RENDER -> PNG (stdlib only)
// ============================================================================
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = zlib.crc32 || ((buf) => {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
});

function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
}

function encodePng(rgb, w, h) {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2;  // 8-bit RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

function renderPng(car) {
    const rgb = Buffer.alloc(IMG_W * IMG_H * 3);
    const margin = 6;
    const scale = Math.min((IMG_W - 2 * margin) / ARENA_W, (IMG_H - 2 * margin) / ARENA_H);
    const ox = (IMG_W - ARENA_W * scale) / 2, oy = (IMG_H - ARENA_H * scale) / 2;
    const toPx = (x, y) => [ox + x * scale, oy + (ARENA_H - y) * scale];   // +y is up on screen
    const put = (px, py, c) => {
        px = Math.round(px); py = Math.round(py);
        if (px < 0 || py < 0 || px >= IMG_W || py >= IMG_H) return;
        const i = (py * IMG_W + px) * 3;
        rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2];
    };

    rgb.fill(18);
    for (let gx = 0; gx <= ARENA_W; gx += 0.5)
        for (let y = 0; y <= ARENA_H * scale; y++) put(ox + gx * scale, oy + y, [40, 44, 52]);
    for (let gy = 0; gy <= ARENA_H; gy += 0.5)
        for (let x = 0; x <= ARENA_W * scale; x++) put(ox + x, oy + gy * scale, [40, 44, 52]);

    const border = car.failsafe ? [220, 50, 50] : [0, 200, 120];
    for (let x = 0; x <= ARENA_W * scale; x++) { put(ox + x, oy, border); put(ox + x, oy + ARENA_H * scale, border); }
    for (let y = 0; y <= ARENA_H * scale; y++) { put(ox, oy + y, border); put(ox + ARENA_W * scale, oy + y, border); }

    for (const [tx, ty] of car.trail) { const [px, py] = toPx(tx, ty); put(px, py, [90, 110, 160]); }

    // Car body: rotated rectangle, drawn 2x oversize so it's visible at 160x120.
    const L = CAR_L * 2, W = CAR_W * 2;
    const s = Math.sin(car.heading), c = Math.cos(car.heading);
    const [cx, cy] = toPx(car.x, car.y);
    const r = Math.ceil(Math.hypot(L, W) / 2 * scale) + 1;
    for (let py = cy - r; py <= cy + r; py++) {
        for (let px = cx - r; px <= cx + r; px++) {
            const wx = (px - cx) / scale, wy = -(py - cy) / scale;   // world offset
            const fwd = wx * s + wy * c, side = wx * c - wy * s;      // car frame
            if (Math.abs(fwd) <= L / 2 && Math.abs(side) <= W / 2)
                put(px, py, fwd > L / 4 ? [255, 200, 0] : [230, 230, 240]);  // yellow nose
        }
    }
    return encodePng(rgb, IMG_W, IMG_H);
}

module.exports = { SimCar, throttleToDuty, decodeControl, encodePng };

// ============================================================================
// CLI
// ============================================================================
if (require.main === module) {
    const args = process.argv.slice(2);
    const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
    const proto = args.includes('--ssl') ? 'wss' : 'ws';
    const url = `${proto}://${opt('host', 'localhost')}:${opt('port', '8080')}`;
    const car = new SimCar({
        url, room: opt('room', 'battle_room_1'), token: opt('token', ''), video: !args.includes('--no-video')
    }).start();

    car.on('connected', () => console.log(`[SIM] control connected to ${url} room=${car.room}`));
    car.on('disconnected', () => console.log('[SIM] control disconnected — failsafe, retrying in 1 s'));

    let lastLine = '';
    setInterval(() => {
        const sign = (v) => (v >= 0 ? '+' : '') + v;
        const line = `L=${sign(car.left)} R=${sign(car.right)} dutyL=${car.dutyL} dutyR=${car.dutyR} ` +
            `brake=${car.flags & 1} failsafe=${car.failsafe ? 1 : 0} pos=(${car.x.toFixed(2)},${car.y.toFixed(2)}) ` +
            `hdg=${Math.round(((car.heading * 180 / Math.PI) % 360 + 360) % 360)}°`;
        if (line !== lastLine) { console.log(line); lastLine = line; }
    }, 200);
    process.on('SIGINT', () => { car.stop(); process.exit(0); });
}
