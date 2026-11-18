/**
 * Virtual race track for cars without cameras. The track exists only on screen; each real car
 * gets a "ghost" here, driven by the same commands the relay forwards to it, with the car's own
 * failsafe timing. Position is dead reckoning (no sensors), so it drifts from the real car:
 * players put the car back on the start line and press reset.
 *
 * World units are metres, y down (like the screen). heading 0 = +x, positive = clockwise.
 */

const { throttleToDuty, decodeControl } = require('./sim_car');

// Calibration knobs. Measure on the real floor and adjust:
//   MAX_SPEED: drive straight at full for 3 s, distance / 3.
//   TURN_GAIN: spin in place at full for 5 s and count turns n; gain = n*2*PI/5 / (MAX_SPEED/WHEEL_BASE).
const MAX_SPEED = 0.6;          // m/s at duty 255 (same guess as sim_car.js)
const WHEEL_BASE = 0.12;        // m between tracks
const TURN_GAIN = 0.35;         // skid-steer tracks slip: real turn rate / ideal
const FAILSAFE_HOLD_MS = 300;   // firmware config.h
const FAILSAFE_BRAKE_MS = 800;

// Circuit centreline control points (closed, clockwise), sampled as a Catmull-Rom spline.
// About 3 x 1.6 m plus the track width: the empty floor the cars need.
const CONTROL = [[0.5, 0.5], [1.5, 0.4], [2.6, 0.5], [3.0, 1.0], [2.6, 1.5], [1.9, 1.3], [1.3, 1.7], [0.6, 1.8], [0.3, 1.2]];
const WIDTH = 0.45;
const START_AT = 4;             // sample index of the start line (on the top straight)

function buildTrack() {
    const pts = [];
    const n = CONTROL.length;
    for (let i = 0; i < n; i++) {
        const [p0, p1, p2, p3] = [-1, 0, 1, 2].map((k) => CONTROL[(i + k + n) % n]);
        for (let s = 0; s < 10; s++) {
            const t = s / 10, t2 = t * t, t3 = t2 * t;
            pts.push([0, 1].map((a) => 0.5 * (2 * p1[a] + (p2[a] - p0[a]) * t +
                (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (3 * p1[a] - p0[a] - 3 * p2[a] + p3[a]) * t3)));
        }
    }
    const loop = pts.slice(START_AT).concat(pts.slice(0, START_AT)).map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]);
    const cum = [0];
    for (let i = 1; i <= loop.length; i++) {
        const [a, b] = [loop[i - 1], loop[i % loop.length]];
        cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const xs = loop.map((p) => p[0]), ys = loop.map((p) => p[1]);
    const m = WIDTH / 2 + 0.3;
    const bounds = [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m];
    return { pts: loop, cum, length: cum[loop.length], width: WIDTH, bounds };
}

const TRACK = buildTrack();

// Distance along the centreline (0..length) and distance from it, for a point.
function locate(x, y) {
    const { pts, cum } = TRACK;
    let best = { d: Infinity, s: 0 };
    for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        if (d < best.d) best = { d, s: cum[i] + t * (cum[i + 1] - cum[i]) };
    }
    return best;
}

// Grid slot k: behind the start line, alternating sides.
function gridPose(k) {
    const [sx, sy] = TRACK.pts[0], [nx, ny] = TRACK.pts[1];
    const h = Math.atan2(ny - sy, nx - sx);
    const back = 0.25 + 0.3 * Math.floor(k / 2), side = k % 2 ? 0.1 : -0.1;
    return {
        x: sx - Math.cos(h) * back - Math.sin(h) * side,
        y: sy - Math.sin(h) * back + Math.cos(h) * side,
        h
    };
}

class Ghosts {
    constructor() { this.cars = new Map(); }

    _get(room) {
        if (!this.cars.has(room)) {
            const g = { left: 0, right: 0, flags: 0, lastAt: 0, slot: this.cars.size, online: false };
            this.cars.set(room, g);
            this.reset(room);
        }
        return this.cars.get(room);
    }

    command(room, buf) {
        const p = decodeControl(buf);
        if (!p) return;
        Object.assign(this._get(room), { left: p.left, right: p.right, flags: p.flags, lastAt: Date.now() });
    }

    reset(room) {
        const g = this.cars.get(room);
        if (!g) return;
        // The player has carried the car to the line: it is standing still until the next command
        Object.assign(g, gridPose(g.slot), { left: 0, right: 0, laps: 0, lapStart: 0, last: 0, best: 0, half: false, s: null, off: false });
    }

    remove(room) { this.cars.delete(room); }

    // online: rooms whose car is connected. Only those move; the rest hold still.
    tick(online, dt, now = Date.now()) {
        for (const room of online) this._get(room);
        const [x0, y0, x1, y1] = TRACK.bounds, L = TRACK.length;
        for (const [room, g] of this.cars) {
            g.online = online.has(room);
            if (!g.online) { g.v = 0; continue; }

            // Same staged failsafe as the car: hold, fade to 0, stop. Brake flag stops at once.
            const gap = now - g.lastAt;
            const fade = gap <= FAILSAFE_HOLD_MS ? 1 : Math.max(0, (FAILSAFE_BRAKE_MS - gap) / (FAILSAFE_BRAKE_MS - FAILSAFE_HOLD_MS));
            const go = g.flags & 1 ? 0 : fade;
            const vL = throttleToDuty(g.left) / 255 * MAX_SPEED * go;
            const vR = throttleToDuty(g.right) / 255 * MAX_SPEED * go;
            const v = g.v = (vL + vR) / 2;
            g.h += (vL - vR) / WHEEL_BASE * TURN_GAIN * dt;   // left faster -> turn right (clockwise)
            // ponytail: invisible walls at the map edge, but the real car won't stop there
            g.x = Math.max(x0, Math.min(x1, g.x + v * Math.cos(g.h) * dt));
            g.y = Math.max(y0, Math.min(y1, g.y + v * Math.sin(g.h) * dt));

            // Laps: cross the start line forward after passing halfway round
            const { d, s } = locate(g.x, g.y);
            g.off = d > TRACK.width / 2;
            if (s > 0.4 * L && s < 0.6 * L) g.half = true;
            if (g.s !== null && g.s > 0.8 * L && s < 0.2 * L) {          // forward over the line
                if (g.half && g.lapStart) {
                    g.last = now - g.lapStart;
                    g.best = g.best ? Math.min(g.best, g.last) : g.last;
                    g.laps++;
                }
                if (g.half || !g.lapStart) g.lapStart = now;
                g.half = false;
            } else if (g.s !== null && g.s < 0.2 * L && s > 0.8 * L) {   // backwards over it
                g.half = false;
            }
            g.s = s;
        }
    }

    snapshot(now = Date.now()) {
        const cars = {};
        for (const [room, g] of this.cars) {
            cars[room] = {
                x: +g.x.toFixed(3), y: +g.y.toFixed(3), h: +g.h.toFixed(3), off: g.off, online: g.online,
                v: +(g.v || 0).toFixed(3),                                   // m/s, estimated
                p: g.s === null ? 0 : +(g.s / TRACK.length).toFixed(4),       // 0..1 round the lap
                laps: g.laps, cur: g.lapStart ? now - g.lapStart : 0, last: g.last, best: g.best
            };
        }
        return { t: 'cars', cars };
    }
}

const trackMessage = JSON.stringify({ t: 'track', pts: TRACK.pts, width: TRACK.width, bounds: TRACK.bounds });

module.exports = { Ghosts, TRACK, trackMessage, locate, gridPose };
