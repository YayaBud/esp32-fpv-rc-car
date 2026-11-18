/**
 * FPV Tank cockpit: drives the car through the relay, shows its video and link health.
 * Protocol: 8-byte control packets at 50 Hz, 8-byte telemetry ACKs (INVARIANTS.md).
 */

// ============================================================================
// CONFIGURATION & STATE
// ============================================================================
// Served by the relay (http/https) -> talk to the same host. Opened as a file -> localhost:8080.
const servedByRelay = location.protocol === 'http:' || location.protocol === 'https:';
const defaultSSL = location.protocol === 'https:';
const defaultHost = servedByRelay ? location.hostname : 'localhost';
const defaultPort = servedByRelay ? (location.port || (defaultSSL ? '443' : '80')) : '8080';

function stored(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}
function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
}

// Controller preferences (Settings > Controls), stored as JSON under `fpv_controls`.
const TOUCH_LAYOUTS = ['one', 'two', 'tank'];
const PAD_LAYOUTS = ['split', 'single', 'triggers', 'tank'];
const CONTROL_DEFAULTS = {
    touchLayout: 'one',   // one stick | two: throttle stick + steering stick | tank: one slider per track
    padLayout: 'split',   // split: left Y + right X | single: left stick | triggers: RT/LT + left X | tank: left Y / right Y
    deadzone: 12,         // % of stick travel ignored around centre
    expo: 60,             // % cubic curve: 0 linear, 100 fine control near centre
    steerMax: 60,         // % steering at full deflection (100 = spin in place)
    speedLimit: 100,      // % cap on both tracks
    accel: 8,             // tenths of a second from stop to full speed (0 = instant); slowing down is always instant
    steerAtSpeed: 60,     // % of steering left at full throttle, so fast turns don't spin (100 = off)
    swapSteer: false      // flip left/right if the car turns the wrong way
};
const clampInt = (v, lo, hi, def) => Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : def;

function sanitizeControls(p) {
    const d = CONTROL_DEFAULTS;
    return {
        touchLayout: TOUCH_LAYOUTS.includes(p.touchLayout) ? p.touchLayout : d.touchLayout,
        padLayout: PAD_LAYOUTS.includes(p.padLayout) ? p.padLayout : d.padLayout,
        deadzone: clampInt(p.deadzone, 0, 30, d.deadzone),
        expo: clampInt(p.expo, 0, 100, d.expo),
        steerMax: clampInt(p.steerMax, 30, 100, d.steerMax),
        speedLimit: clampInt(p.speedLimit, 25, 100, d.speedLimit),
        accel: clampInt(p.accel, 0, 30, d.accel),
        steerAtSpeed: clampInt(p.steerAtSpeed, 30, 100, d.steerAtSpeed),
        swapSteer: p.swapSteer === true
    };
}

function loadControls() {
    try { return sanitizeControls(JSON.parse(stored('fpv_controls') || '{}')); }
    catch (e) { return { ...CONTROL_DEFAULTS }; }
}
const prefs = loadControls();

// Set by the lobby (/): the car it handed this player. Not saved, so a plain visit keeps the
// room from Settings.
const lobbyRoom = new URLSearchParams(location.search).get('room');

const state = {
    relayHost: stored('fpv_host') || defaultHost,
    relayPort: stored('fpv_port') || defaultPort,
    roomId:    lobbyRoom || stored('fpv_room') || 'battle_room_1',
    token:     stored('fpv_token') || '',
    useSSL:    stored('fpv_ssl') !== null ? stored('fpv_ssl') === 'true' : defaultSSL,

    // Sockets
    wsControl: null,
    wsVideo:   null,
    connected: false,        // control socket open (video is best-effort)
    wantConnected: false,    // user intent; drives auto-reconnect
    reconnectDelay: 1000,
    reconnectTimer: null,

    // Protocol State
    sessionId: Math.floor(Math.random() * 65535),
    seq: 0,
    sentTimestamps: new Map(), // seq -> send performance.now()

    // Input sources, merged every control tick. {t, s} = throttle/steer; tank sources use {l, r}.
    kb:    { t: 0, s: 0, sTarget: 0, name: 'Keyboard' },
    touch: { t: 0, s: 0, l: 0, r: 0, tank: false, active: false, name: 'Touch sticks' },
    pad:   { t: 0, s: 0, l: 0, r: 0, tank: false, moved: false, brake: false, connected: false,
             prevY: false, prevRB: false, name: 'Gamepad' },
    src: null,
    brakeHeld: false,        // Space key or brake button

    // Resolved outputs
    throttle: 0, // -100 to +100
    steering: 0, // -steerMax to +steerMax
    leftMotor: 0,
    rightMotor: 0,
    leftOut: 0,              // unrounded track outputs the acceleration ramp works on
    rightOut: 0,
    dynamicBrake: false,
    headlight: false,
    weaponTrigger: false,

    // Car telemetry
    lastTelemetryAt: 0,
    carFlags: 0,

    // Latency Telemetry (Rolling 100 samples)
    ackLatencies: [],
    p50: 0,
    p95: 0,
    p99: 0,

    // Video Metrics
    framesReceived: 0,
    framesRendered: 0,
    lastFrameAt: -Infinity,
    decoding: false,
    pendingFrame: null,      // newest decoded frame awaiting draw
    drawScheduled: false,
    prevRelayStats: null,

    // Virtual track: the relay sends it on the video socket when the car has no camera
    track: null,             // { pts, width, bounds } in metres
    trackSnaps: [],          // the last two pose messages, [{ at, cars }], for interpolation
    trackAt: -Infinity,      // when the last pose message arrived
    offTrack: false,         // this car is off the virtual track: speed capped
    trackMe: null,           // this car's latest pose
    touching: null,          // unit vector toward a car we are touching, or null
    stunUntil: 0,            // crash: no drive until then
    crashAt: -Infinity
};
state.src = state.kb;

// Car status flag bits (firmware sendTelemetryACK)
const FLAG_FAILSAFE = 1 << 0, FLAG_LIMITED = 1 << 1, FLAG_BATT_WARN = 1 << 2,
      FLAG_CUTOFF = 1 << 3, FLAG_NO_SENSOR = 1 << 4, FLAG_WEAK_LINK = 1 << 5;  // car is fading: packets late
const CAR_TIMEOUT_MS = 1000;

// -1..1 in -> -1..1 out, with deadzone rescale and expo curve (Settings > Controls).
function shapeAxis(v) {
    const dz = prefs.deadzone / 100, expo = prefs.expo / 100;
    const a = Math.abs(v);
    if (a <= dz) return 0;
    const x = Math.min(1, (a - dz) / (1 - dz));
    return Math.sign(v) * (expo * x ** 3 + (1 - expo) * x);
}

// Move `cur` toward `target`, growing in magnitude by at most `step`. Shrinking, stopping and
// reversing are instant (a reverse drops to 0 first), so letting go always stops the car at once.
function rampUp(cur, target, step) {
    if (Math.sign(cur) !== Math.sign(target)) cur = 0;
    if (Math.abs(target) <= Math.abs(cur)) return target;
    return cur + Math.sign(target) * Math.min(step, Math.abs(target - cur));
}

// Keyboard A/D eases in like a stick being pushed: a tap is a nudge, a hold is full steering.
const KB_STEER_RAMP_S = 0.25;

// DOM Elements
const $ = (id) => document.getElementById(id);
const radio = $('radio');
const canvas = $('fpv-canvas');
const ctx = canvas.getContext('2d');
const btnConnect = $('btn-connect');
const btnConnectText = $('btn-connect-text');
const vehicleStatus = $('vehicle-status');
const batteryVal = $('battery-value');
const batteryBar = $('battery-bar');
const rssiVal = $('rssi-value');
const rssiBars = $('rssi-bars');
const latencyP50 = $('latency-p50');
const warningBanner = $('warning-banner');
const warningText = $('warning-text');
const leftWheelBar = $('left-wheel-bar');
const rightWheelBar = $('right-wheel-bar');
const leftWheelText = $('left-wheel-text');
const rightWheelText = $('right-wheel-text');
const videoEmpty = $('video-empty');
const videoEmptyText = $('video-empty-text');
const videoEmptyHint = $('video-empty-hint');
const inputLabel = $('input-device-label');

// Stat Elements
const statCamFps = $('stat-cam-fps');
const statRelayFps = $('stat-relay-fps');
const statRecvFps = $('stat-recv-fps');
const statRenderFps = $('stat-render-fps');
const statDropRate = $('stat-drop-rate');
const statAckP95 = $('stat-ack-p95');
const statRelayRtt = $('stat-relay-rtt');

// Action Buttons
const btnBrake = $('btn-brake');
const btnHeadlight = $('btn-headlight');
const btnWeapon = $('btn-weapon');
const btnTrackReset = $('btn-track-reset');

// Settings
const btnSettings = $('btn-settings');
const modalSettings = $('settings-modal');
const btnSaveSettings = $('btn-save-settings');
const cfgHost = $('cfg-relay-host');
const cfgPort = $('cfg-relay-port');
const cfgRoom = $('cfg-room');
const cfgToken = $('cfg-token');
const cfgSSL = $('cfg-use-ssl');

// ============================================================================
// INITIALIZATION
// ============================================================================
function init() {
    $('room-display').innerText = state.roomId;
    // Link details open by default where there is room for them
    $('lcd-more').open = matchMedia('(min-width: 900px)').matches;

    setupEventListeners();
    setupKeyboardListeners();
    setupSticks();
    setupSafetyListeners();
    setupSettings();
    applyControls();
    updateVideoEmpty();
    startControlLoop();
    startMetricsTimer();
    if (lobbyRoom) onConnectButton();   // came from the lobby: drive straight away
}

// ============================================================================
// WEBSOCKET MANAGEMENT (Dual Sockets: /ws/control & /ws/video)
// ============================================================================
function socketUrl(kind) {
    const proto = state.useSSL ? 'wss' : 'ws';
    let url = `${proto}://${state.relayHost}:${state.relayPort}/ws/${kind}` +
              `?room=${encodeURIComponent(state.roomId)}&role=controller`;
    if (state.token) url += `&token=${encodeURIComponent(state.token)}`;
    return url;
}

function onConnectButton() {
    if (state.wantConnected) {
        state.wantConnected = false;
        closeSockets();
        setBadge('Offline', 'status-offline');
        resetTelemetryDisplay();
    } else {
        state.wantConnected = true;
        state.reconnectDelay = 1000;
        openSockets();
    }
    btnConnectText.innerText = state.wantConnected ? 'Disconnect' : 'Connect';
    btnConnect.classList.toggle('is-live', state.wantConnected);
    btnConnect.setAttribute('aria-pressed', String(state.wantConnected));
    updateVideoEmpty();
}

function openSockets() {
    closeSockets();
    if (!state.wantConnected) return;
    setBadge('Connecting', 'status-offline');

    try {
        const ctl = new WebSocket(socketUrl('control'));
        ctl.binaryType = 'arraybuffer';
        ctl.onopen = () => {
            console.log('[CTRL] Connected to relay.');
            state.connected = true;
            state.reconnectDelay = 1000;
            state.sentTimestamps.clear();
            state.prevRelayStats = null;
            updateBadge();
            updateVideoEmpty();
        };
        ctl.onmessage = handleTelemetryMessage;
        ctl.onerror = () => console.warn('[CTRL] Socket error.');
        ctl.onclose = () => onControlLost();
        state.wsControl = ctl;

        const vid = new WebSocket(socketUrl('video'));
        vid.binaryType = 'blob';
        vid.onopen = () => console.log('[VIDEO] Connected to relay.');
        vid.onmessage = handleVideoMessage;
        vid.onerror = () => console.warn('[VIDEO] Socket error.');
        state.wsVideo = vid;
    } catch (e) {
        console.error('Connection setup failed:', e);
        onControlLost();
    }
}

// Detach handlers before closing so an old socket can never fire into new state.
function closeSockets() {
    clearTimeout(state.reconnectTimer);
    for (const key of ['wsControl', 'wsVideo']) {
        const ws = state[key];
        if (!ws) continue;
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        try { ws.close(); } catch (e) { /* already closed */ }
        state[key] = null;
    }
    state.connected = false;
}

function onControlLost() {
    closeSockets();
    resetTelemetryDisplay();
    updateVideoEmpty();
    if (!state.wantConnected) return;
    setBadge('Reconnecting', 'status-offline');
    state.reconnectTimer = setTimeout(openSockets, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 5000);
}

function setBadge(text, cls) {
    vehicleStatus.className = `status-badge ${cls}`;
    vehicleStatus.innerText = text;
}

function updateBadge() {
    if (!state.connected) return;
    if (performance.now() - state.lastTelemetryAt <= CAR_TIMEOUT_MS) setBadge('Online', 'status-online');
    else setBadge('Car offline', 'status-warn');
}

// ============================================================================
// CONTROL TRANSMITTER (50 Hz / 20 ms Cadence)
// ============================================================================
function sendControl(left, right, flags) {
    // [0..1] session_id (uint16) [2..3] seq (uint16) [4] left (int8)
    // [5] right (int8) [6] flags (uint8) [7] version 0x01
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    state.seq = (state.seq + 1) & 0xFFFF;
    view.setUint16(0, state.sessionId, false);
    view.setUint16(2, state.seq, false);
    view.setInt8(4, left);
    view.setInt8(5, right);
    view.setUint8(6, flags);
    view.setUint8(7, 0x01);

    state.sentTimestamps.set(state.seq, performance.now());
    if (state.sentTimestamps.size > 300) {
        state.sentTimestamps.delete(state.sentTimestamps.keys().next().value);
    }
    state.wsControl.send(buffer);
}

function startControlLoop() {
    const CONTROL_RATE_MS = 20; // 50 Hz

    let last = performance.now();
    setInterval(() => {
        // Measured dt: Windows fires a 20 ms interval every ~15.6 ms. Capped so a stalled tab
        // can't ramp to full speed in one tick.
        const now = performance.now();
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;

        pollGamepad();
        resolveInputs(dt);
        mixDrive(dt);
        updateWheelHUD();

        const ws = state.wsControl;
        if (!state.connected || ws?.readyState !== WebSocket.OPEN) return;
        // Bad uplink: skip rather than queue stale commands behind each other.
        if (ws.bufferedAmount > 256) return;

        let flags = 0;
        if (state.dynamicBrake)   flags |= (1 << 0);
        if (state.headlight)      flags |= (1 << 1);
        if (state.weaponTrigger)  flags |= (1 << 2);
        sendControl(state.leftMotor, state.rightMotor, flags);
    }, CONTROL_RATE_MS);
}

// ============================================================================
// TELEMETRY RECEIVER & LATENCY STATS
// ============================================================================
function rssiLevel(dbm) {
    return dbm >= -55 ? 5 : dbm >= -62 ? 4 : dbm >= -70 ? 3 : dbm >= -78 ? 2 : 1;
}

function handleTelemetryMessage(event) {
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength !== 8) return;

    const view = new DataView(event.data);
    const ackSession = view.getUint16(0, false);
    const ackSeq     = view.getUint16(2, false);
    const battMv     = view.getUint16(4, false);
    const rssi       = view.getInt8(6);
    const flags      = view.getUint8(7);

    state.lastTelemetryAt = performance.now();
    state.carFlags = flags;
    updateBadge();

    // Control pipeline ACK latency (only for our own session's packets)
    if (ackSession === state.sessionId && state.sentTimestamps.has(ackSeq)) {
        recordLatency(performance.now() - state.sentTimestamps.get(ackSeq));
        state.sentTimestamps.delete(ackSeq);
    }

    if (flags & FLAG_NO_SENSOR) {
        batteryVal.innerText = 'NO SNS';
        batteryBar.style.width = '0%';
        batteryBar.dataset.state = 'none';
    } else {
        batteryVal.innerText = `${(battMv / 1000.0).toFixed(2)}V`;
        // 6.0V = 0%, 8.4V = 100%
        const pct = Math.max(0, Math.min(100, Math.round(((battMv - 6000) / 2400) * 100)));
        batteryBar.style.width = `${pct}%`;
        batteryBar.dataset.state = (flags & FLAG_CUTOFF) ? 'cutoff'
            : (flags & (FLAG_LIMITED | FLAG_BATT_WARN)) ? 'low' : 'ok';
    }

    rssiVal.innerText = `${rssi}`;
    rssiBars.dataset.level = rssiLevel(rssi);
    updateWarning();
}

function recordLatency(ms) {
    state.ackLatencies.push(ms);
    if (state.ackLatencies.length > 100) state.ackLatencies.shift();

    const sorted = [...state.ackLatencies].sort((a, b) => a - b);
    state.p50 = Math.round(sorted[Math.floor(sorted.length * 0.50)]);
    state.p95 = Math.round(sorted[Math.floor(sorted.length * 0.95)]);
    state.p99 = Math.round(sorted[Math.floor(sorted.length * 0.99)]);

    latencyP50.innerText = `${state.p50}`;
    statAckP95.innerText = `${state.p95} / ${state.p99} ms`;
}

// Single place that decides the banner, highest priority first.
function updateWarning() {
    const carLive = state.connected && performance.now() - state.lastTelemetryAt <= CAR_TIMEOUT_MS;
    const f = carLive ? state.carFlags : 0;
    let msg = null, level = 'danger';
    if (state.dynamicBrake)          { msg = 'Brake on'; level = 'caution'; }
    else if (f & FLAG_CUTOFF)        msg = 'Battery cutoff: motors off';
    else if (f & FLAG_FAILSAFE)      msg = 'Link lost: motors stopped';
    else if (f & FLAG_WEAK_LINK)     { msg = 'Weak link: car slowing'; level = 'caution'; }
    else if (f & FLAG_LIMITED)       { msg = 'Battery low: speed capped at 60%'; level = 'caution'; }
    else if (f & FLAG_BATT_WARN)     { msg = 'Battery low: stop soon'; level = 'caution'; }

    if (msg) {
        warningText.innerText = msg;
        warningBanner.dataset.level = level;
        warningBanner.classList.remove('hidden');
    } else {
        warningBanner.classList.add('hidden');
    }
}

// ============================================================================
// LOW-LATENCY FPV VIDEO DECODER & CANVAS RENDERER
// ============================================================================
async function handleVideoMessage(event) {
    if (typeof event.data === 'string') return handleTrackMessage(event.data);
    state.framesReceived++;
    if (!(event.data instanceof Blob)) return;
    // A decode still in flight means we're behind: drop this frame, never queue.
    if (state.decoding) return;
    state.decoding = true;

    try {
        // Only the newest decoded frame is kept, with one draw scheduled at a time.
        // rAF pauses while the tab is hidden; queuing a callback per frame would
        // pile up ImageBitmaps in memory until the user comes back.
        const imgBitmap = await createImageBitmap(event.data);
        if (state.pendingFrame) state.pendingFrame.close();
        state.pendingFrame = imgBitmap;
        if (!state.drawScheduled) {
            state.drawScheduled = true;
            requestAnimationFrame(() => {
                state.drawScheduled = false;
                const frame = state.pendingFrame;
                state.pendingFrame = null;
                if (!frame) return;
                ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
                frame.close();
                state.framesRendered++;
                if (performance.now() - state.lastFrameAt > 2000) {
                    state.lastFrameAt = performance.now();
                    updateVideoEmpty();
                }
                state.lastFrameAt = performance.now();
            });
        }
    } catch (e) {
        console.error('Frame decode error:', e);
    } finally {
        state.decoding = false;
    }
}

// ============================================================================
// VIRTUAL TRACK (no camera): the relay moves a "ghost" of each car from the commands it was
// sent and streams the poses here. Shown first person from your car: the track is painted
// top-down into a texture and the floor is projected from it row by row (mode-7 style), at
// 320x240 scaled x2 for chunky pixels.
// ============================================================================
const OFF_TRACK_SPEED = 0.4;     // speed cap while this car is off the virtual track
// Virtual collisions: two tanks touch when their centres are this close (about a car width plus a
// margin for the 20 Hz poses). A bump stops you for CRASH_STUN_MS; while touching you can turn or
// back away but not drive into the other car. Enforced in mixDrive on the commands, so the real car
// stops too and its ghost (which only follows commands) stays in step with it.
const CONTACT_M = 0.14;
const CRASH_STUN_MS = 300;
const CAR_COLORS = ['#8fe3ff', '#ff4fd8', '#ffd34d', '#59f07a'];
const VW = 320, VH = 240, HORIZON = 100;           // view buffer (scaled x2 to the canvas), horizon row
const CAM_H = 0.09, CAM_FWD = 0.05;                // eye 9 cm up, 5 cm ahead of centre: a turret camera
const FOV = 70 * Math.PI / 180, FOCAL = VW / 2 / Math.tan(FOV / 2);
const TEX_PPM = 200;                               // floor texture pixels per metre
const SKY_W = Math.round(VW * 2 * Math.PI / FOV);  // 360 degrees of sky at the view's scale
const DASH_TOP = VH - 46;                          // top of your tank's hull in the view
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const newCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const rgba = (hex) => { const n = parseInt(hex.slice(1), 16); return ((255 << 24) | ((n & 255) << 16) | (n & 0xff00) | (n >> 16)) >>> 0; };
const GROUND = rgba('#120f3d'), GRID = rgba('#3346b8'), FOG = rgba('#2b2680'), HORIZ = rgba('#8fe3ff');
const view = newCanvas(VW, VH), vctx = view.getContext('2d');
vctx.imageSmoothingEnabled = false;
const floorImg = vctx.createImageData(VW, VH), floorPx = new Uint32Array(floorImg.data.buffer);
let tex = null, sky = null, mini = null, dash = null, sprites = [];
let trackLoop = false;           // a drawCockpitView rAF loop is running
// Phone landscape puts the LCD pill, rail and reset button over the top of the view (style.css)
const landscapeMQ = matchMedia('(orientation: landscape) and (max-height: 520px)');

const trackShowing = () => state.connected && performance.now() - state.trackAt < 2000 &&
                           performance.now() - state.lastFrameAt >= 2000;
const carName = (room) => { const n = room.match(/(\d+)$/); return n ? 'Car ' + Number(n[1]) : room; };
const lapTime = (ms) => `${Math.floor(ms / 60000)}:${(ms % 60000 / 1000).toFixed(1).padStart(4, '0')}`;

function handleTrackMessage(text) {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (m.t === 'track') {
        state.track = m;
        buildTrackAssets();
        return;
    }
    if (m.t !== 'cars' || !state.track) return;
    const now = performance.now(), snap = { at: now, cars: m.cars };
    state.trackSnaps = [state.trackSnaps[1] ?? snap, snap];
    const me = state.trackMe = m.cars[state.roomId] ?? null;
    state.offTrack = !!me?.off;
    let touch = null;
    if (me) {
        for (const [room, c] of Object.entries(m.cars)) {   // offline ghosts count: that car is still there
            if (room === state.roomId) continue;
            const dx = c.x - me.x, dy = c.y - me.y, d = Math.hypot(dx, dy);
            if (d < CONTACT_M) { touch = d > 1e-6 ? [dx / d, dy / d] : [Math.cos(me.h), Math.sin(me.h)]; break; }
        }
    }
    if (touch && !state.touching) { state.stunUntil = now + CRASH_STUN_MS; state.crashAt = now; }
    state.touching = touch;
    state.trackAt = now;
    if (!trackLoop && trackShowing()) {
        trackLoop = true;
        updateVideoEmpty();
        requestAnimationFrame(drawCockpitView);
    }
}

// The track seen from above: kerbs, asphalt, centre line, chequered start. Used at full detail
// as the floor texture and plain for the minimap. P maps metres to pixels, k = pixels per metre.
function paintTrack(c, P, k, detail) {
    const T = state.track;
    c.beginPath();
    T.pts.forEach(([x, y], i) => (i ? c.lineTo : c.moveTo).call(c, ...P(x, y)));
    c.closePath();
    c.lineJoin = 'round';
    c.lineWidth = T.width * k + (detail ? 0.06 * k : 2);     // kerbs, 3 cm a side
    c.strokeStyle = '#e8f6ff';
    c.stroke();
    if (detail) {
        c.setLineDash([0.08 * k, 0.08 * k]);
        c.strokeStyle = '#ff3d6e';
        c.stroke();
        c.setLineDash([]);
    }
    c.lineWidth = T.width * k;                               // asphalt
    c.strokeStyle = '#231e66';
    c.stroke();
    if (!detail) return;
    c.lineWidth = 0.012 * k;                                 // centre line
    c.setLineDash([0.06 * k, 0.09 * k]);
    c.strokeStyle = '#6f8fe8';
    c.stroke();
    c.setLineDash([]);
    const [sx, sy] = P(...T.pts[0]), [nx, ny] = P(...T.pts[1]);
    c.save();
    c.translate(sx, sy);
    c.rotate(Math.atan2(ny - sy, nx - sx));
    const sq = 0.04 * k, half = T.width * k / 2;
    for (let j = -half, n = 0; j < half; j += sq, n++) {
        for (let r = 0; r < 2; r++) {
            c.fillStyle = (n + r) % 2 ? '#e8f6ff' : '#05040f';
            c.fillRect((r - 1) * sq, j, sq, Math.min(sq, half - j));
        }
    }
    c.restore();
}

function buildTrackAssets() {
    const T = state.track, [x0, y0, x1, y1] = T.bounds;
    const w = Math.ceil((x1 - x0) * TEX_PPM), h = Math.ceil((y1 - y0) * TEX_PPM);
    const tc = newCanvas(w, h).getContext('2d');
    paintTrack(tc, (x, y) => [(x - x0) * TEX_PPM, (y - y0) * TEX_PPM], TEX_PPM, true);
    tex = { px: new Uint32Array(tc.getImageData(0, 0, w, h).data.buffer), w, h, x0, y0 };

    const mw = 84, mh = 60, mk = Math.min((mw - 8) / (x1 - x0), (mh - 8) / (y1 - y0));
    const mc = newCanvas(mw, mh), m = mc.getContext('2d');
    const mP = (x, y) => [mw / 2 + (x - (x0 + x1) / 2) * mk, mh / 2 + (y - (y0 + y1) / 2) * mk];
    m.fillStyle = 'rgba(7, 6, 28, 0.8)';
    m.fillRect(0, 0, mw, mh);
    m.fillStyle = '#5b45d6';
    m.fillRect(0, 0, mw, 1); m.fillRect(0, mh - 1, mw, 1); m.fillRect(0, 0, 1, mh); m.fillRect(mw - 1, 0, 1, mh);
    paintTrack(m, mP, mk, false);
    mini = { c: mc, P: mP };

    sky = buildSky();
    dash = buildDash();
    sprites = CAR_COLORS.map(buildSprite);
}

// 360-degree night sky: bands, stars, the moon due north (map up), magenta mountains all round.
function buildSky() {
    const c = newCanvas(SKY_W, HORIZON), g = c.getContext('2d');
    const px = (x, y, col, w = 1, h = 1) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
    const bands = [[0, '#0b0a26'], [40, '#0f0d33'], [62, '#141243'], [76, '#1a1755'], [86, '#221e69'], [94, '#2b2680'], [HORIZON]];
    for (let i = 0; i < bands.length - 1; i++) px(0, bands[i][0], bands[i][1], SKY_W, bands[i + 1][0] - bands[i][0]);
    let seed = 7;
    const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
    for (let i = 0; i < 170; i++) px(Math.floor(rnd() * SKY_W), Math.floor(rnd() * 72), rnd() < 0.7 ? '#6f7cf0' : '#dfe8ff');

    const mx = Math.round(SKY_W * 0.75), my = 32, r = 12;    // bearing -90 deg = north
    for (let y = -r; y < r; y++) {
        for (let x = -r; x < r; x++) {
            const d = Math.hypot(x + 0.5, y + 0.5);
            if (d <= r) px(mx + x, my + y, d > r - 1.2 ? '#6aa6e6' : x + y > r * 0.8 ? '#79bdee' : '#8ed2f8');
        }
    }
    for (const [y, x, w] of [[-7, -6, 8], [-2, -10, 14], [4, -3, 9]]) px(mx + x, my + y, '#dff6ff', w);

    const TAU = 2 * Math.PI;
    const ridge = (x) => 12 + 8 * Math.sin(TAU * x / SKY_W * 3 + 1) + 5 * Math.sin(TAU * x / SKY_W * 8 + 2) +
                         2.5 * Math.sin(TAU * x / SKY_W * 23);   // periodic, so the seam is invisible
    for (let x = 0; x < SKY_W; x++) {
        const top = HORIZON - Math.max(2, Math.round(ridge(x))), lit = ridge(x + 1) > ridge(x - 1);
        for (let y = top; y < HORIZON; y++) {
            const k = y - top;
            px(x, y, y >= HORIZON - 2 ? '#1f0b38' : k < 1 ? (lit ? '#f06bb0' : '#8a2a7a')
                   : k < 6 ? (lit ? '#b8357f' : '#4a1660') : (lit ? '#6e1d68' : '#2e0f48'));
        }
    }
    return c;
}

// Your tank: glacis plate, rivets, barrel straight ahead, two instrument wells.
function buildDash() {
    const c = newCanvas(VW, VH), g = c.getContext('2d'), T = DASH_TOP;
    const poly = (pts, col) => {
        g.fillStyle = col;
        g.beginPath();
        pts.forEach(([x, y], i) => (i ? g.lineTo : g.moveTo).call(g, x, y));
        g.fill();
    };
    poly([[0, VH], [0, T + 14], [64, T], [256, T], [VW, T + 14], [VW, VH]], '#05040f');
    poly([[0, VH], [0, T + 18], [66, T + 4], [254, T + 4], [VW, T + 18], [VW, VH]], '#2c2177');
    poly([[0, VH], [0, T + 30], [70, T + 18], [250, T + 18], [VW, T + 30], [VW, VH]], '#191256');
    g.fillStyle = '#5b45d6';
    g.fillRect(66, T + 4, 188, 2);
    for (let x = 76; x < 250; x += 16) g.fillRect(x, T + 10, 2, 2);
    g.fillStyle = '#05040f'; g.fillRect(154, T - 22, 12, 28);
    g.fillStyle = '#2c2177'; g.fillRect(156, T - 20, 8, 26);
    g.fillStyle = '#5b45d6'; g.fillRect(156, T - 20, 2, 26);
    g.fillStyle = '#191256'; g.fillRect(155, T - 24, 10, 4);
    for (const x of [22, 234]) {
        g.fillStyle = '#5b45d6'; g.fillRect(x - 2, T + 20, 68, 24);
        g.fillStyle = '#07061c'; g.fillRect(x, T + 22, 64, 20);
    }
    return c;
}

// Another car from behind: tracks, hull, tail lights, turret.
function buildSprite(color) {
    const c = newCanvas(20, 14), g = c.getContext('2d');
    const box = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
    box(0, 4, 5, 10, '#05040f'); box(15, 4, 5, 10, '#05040f');
    for (let y = 5; y < 14; y += 2) { box(1, y, 3, 1, '#2a2370'); box(16, y, 3, 1, '#2a2370'); }
    box(3, 5, 14, 7, color);
    box(3, 5, 14, 1, 'rgba(255, 255, 255, 0.45)');
    box(3, 11, 14, 1, 'rgba(0, 0, 0, 0.35)');
    box(5, 8, 2, 2, '#ff3d6e'); box(13, 8, 2, 2, '#ff3d6e');
    box(7, 1, 6, 5, color); box(7, 1, 6, 5, 'rgba(0, 0, 0, 0.3)');
    box(8, 2, 2, 1, 'rgba(255, 255, 255, 0.5)');
    return c;
}

// Floor, row by row: each row below the horizon is one distance; walk across it in world space
// and sample the track texture, else the neon ground grid. Far rows dither into the horizon fog.
function renderFloor(cx, cy, h) {
    const fx = Math.cos(h), fy = Math.sin(h), rx = -fy, ry = fx;
    const tanHalf = Math.tan(FOV / 2), { px, w, h: th, x0, y0 } = tex;
    floorPx.fill(HORIZ, HORIZON * VW, (HORIZON + 1) * VW);
    for (let y = HORIZON + 1; y < VH; y++) {
        const d = CAM_H * FOCAL / (y - HORIZON), half = d * tanHalf;
        const fog = Math.min(1, Math.max(0, (d - 1.4) / 1.8));
        const sx = rx * 2 * half / VW, sy = ry * 2 * half / VW;
        let wx = cx + fx * d - rx * half, wy = cy + fy * d - ry * half;
        for (let x = 0, i = y * VW; x < VW; x++, i++, wx += sx, wy += sy) {
            if (fog > BAYER[(y & 3) * 4 + (x & 3)]) { floorPx[i] = FOG; continue; }
            const tx = (wx - x0) * TEX_PPM | 0, ty = (wy - y0) * TEX_PPM | 0;
            const t = tx >= 0 && ty >= 0 && tx < w && ty < th ? px[ty * w + tx] : 0;
            if (t >>> 24 > 127) { floorPx[i] = (t | 0xFF000000) >>> 0; continue; }
            const gx = wx * 4 - Math.floor(wx * 4), gy = wy * 4 - Math.floor(wy * 4);
            floorPx[i] = gx < 0.06 || gy < 0.06 ? GRID : GROUND;
        }
    }
    vctx.putImageData(floorImg, 0, 0, 0, HORIZON, VW, VH - HORIZON);
}

function drawCockpitView() {
    if (!trackShowing() || !tex) { trackLoop = false; return; }   // next pose restarts it
    requestAnimationFrame(drawCockpitView);

    // Draw slightly in the past and interpolate between the last two poses (20 Hz from the relay)
    const [a, b] = state.trackSnaps;
    const alpha = b.at > a.at ? Math.max(0, Math.min(1, (performance.now() - 60 - a.at) / (b.at - a.at))) : 1;
    const rooms = Object.keys(b.cars).sort();
    const poses = rooms.map((room, i) => {
        const q = b.cars[room], p = a.cars[room] ?? q;
        const dh = Math.atan2(Math.sin(q.h - p.h), Math.cos(q.h - p.h));
        return { room, i, q, x: p.x + (q.x - p.x) * alpha, y: p.y + (q.y - p.y) * alpha, h: p.h + dh * alpha };
    });
    const me = poses.find((p) => p.room === state.roomId);
    if (!me) return;
    const fx = Math.cos(me.h), fy = Math.sin(me.h);
    const cx = me.x + fx * CAM_FWD, cy = me.y + fy * CAM_FWD;

    // Sky slides as you turn: bearing grows clockwise, like heading
    const skyX = Math.round(((me.h - FOV / 2) / (2 * Math.PI) % 1 + 1) % 1 * SKY_W);
    vctx.drawImage(sky, -skyX, 0);
    vctx.drawImage(sky, SKY_W - skyX, 0);
    renderFloor(cx, cy, me.h);

    // Other cars, far to near; behind you or lost in the fog: not drawn
    const labels = [];
    poses.filter((p) => p !== me)
        .map((p) => ({ p, f: (p.x - cx) * fx + (p.y - cy) * fy, r: -(p.x - cx) * fy + (p.y - cy) * fx }))
        .filter((o) => o.f > 0.02 && o.f < 3.2)   // a car you are touching is ~7 cm ahead: fills the view
        .sort((u, v) => v.f - u.f)
        .forEach(({ p, f, r }) => {
            const w = 0.11 * FOCAL / f, hgt = w * 14 / 20;
            const x = VW / 2 + r / f * FOCAL, ground = HORIZON + CAM_H * FOCAL / f;
            vctx.globalAlpha = p.q.online ? 1 : 0.45;
            vctx.drawImage(sprites[p.i % sprites.length], Math.round(x - w / 2), Math.round(ground - hgt), Math.round(w), Math.round(hgt));
            vctx.globalAlpha = 1;
            labels.push({ p, x, y: ground - hgt });
        });

    vctx.drawImage(dash, 0, 0);
    [[state.leftMotor, DASH_TOP + 25], [state.rightMotor, DASH_TOP + 33]].forEach(([m, y]) => {
        vctx.fillStyle = m < 0 ? '#ff4fd8' : '#8fe3ff';
        vctx.fillRect(236, y, Math.round(Math.abs(m) * 0.6), 5);
    });
    const drop = landscapeMQ.matches ? 40 : 0;    // view px to move the HUD below the overlays
    const mx = VW - mini.c.width - 6, my = 6 + drop;
    vctx.drawImage(mini.c, mx, my);
    poses.forEach((p) => {
        if (p === me && Math.floor(performance.now() / 300) % 2) return;   // your dot blinks
        const [px, py] = mini.P(p.x, p.y);
        vctx.fillStyle = p === me ? '#ffd34d' : CAR_COLORS[p.i % CAR_COLORS.length];
        vctx.fillRect(Math.round(mx + px) - 1, Math.round(my + py) - 1, 3, 3);
    });

    // A crash shakes the view for a moment
    const sinceCrash = performance.now() - state.crashAt;
    const shake = sinceCrash < 300 ? () => Math.round((Math.random() - 0.5) * 12) : () => 0;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#05040f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(view, shake(), shake(), canvas.width, canvas.height);

    // HUD at full resolution
    const s = canvas.width / VW;
    const text = (str, x, y, color, size, align = 'left') => {
        ctx.font = `${size}px "Jersey 10", monospace`;
        ctx.textAlign = align;
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#05040f';
        ctx.fillText(str, x + 2, y + 2);
        ctx.fillStyle = color;
        ctx.fillText(str, x, y);
    };
    labels.forEach(({ p, x, y }) => text(carName(p.room), x * s, y * s - 20, CAR_COLORS[p.i % CAR_COLORS.length], 18, 'center'));
    const q = me.q;
    const score = (c) => c.laps + (c.cur ? c.p : c.p - 1);   // on the grid, before the line: lap 0
    const pos = rooms.slice().sort((u, v) => score(b.cars[v]) - score(b.cars[u])).indexOf(me.room) + 1;
    const top = drop * s;
    text(lapTime(q.cur || 0), canvas.width / 2, 12 + top, q.cur ? '#e8f6ff' : '#6f63b8', 44, 'center');
    text(`LAP ${q.laps + 1}`, 20, 12 + top, '#8fe3ff', 30);
    text(`POS ${pos}/${rooms.length}`, 20, 42 + top, '#ff4fd8', 24);
    if (q.best) text(`BEST ${lapTime(q.best)}`, 20, 68 + top, '#a99ce8', 20);
    text(String(Math.round(q.v * 100)), 120, (DASH_TOP + 22) * s, '#8fe3ff', 36, 'right');
    text('CM/S', 126, (DASH_TOP + 30) * s, '#a99ce8', 16);
    text('L', 458, (DASH_TOP + 23) * s, '#a99ce8', 14, 'right');
    text('R', 458, (DASH_TOP + 31) * s, '#a99ce8', 14, 'right');
    if (sinceCrash < 700) text('CRASH!', canvas.width / 2, 120, '#ff3d6e', 64, 'center');
    else if (q.off) text(`OFF TRACK · ${OFF_TRACK_SPEED * 100}% SPEED`, canvas.width / 2, 150, '#ffd34d', 30, 'center');
}

function resetTrackPosition() {
    if (state.wsVideo?.readyState === WebSocket.OPEN) state.wsVideo.send('reset');
}

// What the video area says when there is no picture.
function updateVideoEmpty() {
    btnTrackReset.hidden = !trackShowing();
    canvas.parentElement.classList.toggle('is-track', trackShowing());
    const live = state.connected && (performance.now() - state.lastFrameAt < 2000 || trackShowing());
    videoEmpty.hidden = live;
    if (live) return;
    if (!state.wantConnected) {
        videoEmptyText.innerText = 'Not connected';
        videoEmptyHint.innerText = 'Press Connect, then drive with W A S D, a gamepad or the sticks.';
    } else if (!state.connected) {
        videoEmptyText.innerText = 'Connecting to the relay';
        videoEmptyHint.innerText = `${state.relayHost}:${state.relayPort}, room ${state.roomId}`;
    } else {
        videoEmptyText.innerText = 'No video from the car';
        videoEmptyHint.innerText = 'Driving still works without it.';
    }
}

// ============================================================================
// INPUT MERGE + DIFFERENTIAL STEERING MIXER
// ============================================================================
function resolveInputs(dt) {
    const pad = state.pad;
    state.kb.s = rampUp(state.kb.s, state.kb.sTarget, prefs.steerMax * dt / KB_STEER_RAMP_S);
    let src = state.kb;
    if (pad.connected && pad.moved) src = pad;
    else if (state.touch.active) src = state.touch;
    if (src !== state.src) {
        state.src = src;
        inputLabel.innerText = src.name;
    }

    state.throttle = src.tank ? 0 : src.t;
    state.steering = src.tank ? 0 : src.s;
    const brake = state.brakeHeld || pad.brake;
    if (brake !== state.dynamicBrake) {
        state.dynamicBrake = brake;
        btnBrake.classList.toggle('active', brake);
        updateWarning();
    }
}

function mixDrive(dt) {
    if (state.dynamicBrake) {
        state.leftMotor = state.rightMotor = state.leftOut = state.rightOut = 0;
        return;
    }

    let left, right;
    if (state.src.tank) {
        // Tank layouts: each stick is one track, no mixing
        left = state.src.l;
        right = state.src.r;
        if (prefs.swapSteer) [left, right] = [right, left];
    } else {
        // A skid-steer turns toward its slower side, so D slows the RIGHT track and drives the left
        // (turns right); A mirrors it. The slowed side eases to 0 at full steer; with no throttle,
        // full A/D = 100 % on the driven side (it drags the braked side). Flipped 2026-11-01: the
        // 2026-10-05 rule (D drives the right side) made D turn left. A car wired the other way
        // round: tick "Swap left and right" in Settings > Controls.
        // Adaptive steering: the harder the throttle, the less steering (Settings > Steering at
        // speed). Turning on the spot (no throttle) keeps it all.
        const max = prefs.steerMax;
        const atSpeed = 1 - (1 - prefs.steerAtSpeed / 100) * Math.min(1, Math.abs(state.throttle) / 100);
        const s = (prefs.swapSteer ? -state.steering : state.steering) * atSpeed;
        const t = state.throttle !== 0 ? state.throttle : Math.abs(s) * 100 / max;
        const slowed = t * (1 - Math.min(1, Math.abs(s) / max));
        left = t; right = t;
        if (s > 0) right = slowed;        // D: right side slows, left drives -> turns right
        else if (s < 0) left = slowed;    // A: left side slows, right drives -> turns left
    }

    // Virtual collisions (see CONTACT_M): stunned = stop; touching = turning and backing away only
    if (trackShowing()) {
        if (performance.now() < state.stunUntil) {
            left = right = 0;
        } else if (state.touching && state.trackMe) {
            const [nx, ny] = state.touching, h = state.trackMe.h;
            const fwd = (left + right) / 2, turn = (left - right) / 2;
            if (fwd * (Math.cos(h) * nx + Math.sin(h) * ny) > 0.2 * Math.abs(fwd)) { left = turn; right = -turn; }
        }
    }

    // Acceleration ramp per track (Settings > Acceleration): each track speeds up at most
    // 100 % per `accel` seconds; slowing down and stopping are instant (rampUp).
    const k = prefs.speedLimit / 100 * (state.offTrack && trackShowing() ? OFF_TRACK_SPEED : 1);
    const step = prefs.accel ? 100 * dt / (prefs.accel / 10) : Infinity;
    state.leftOut  = rampUp(state.leftOut,  Math.max(-100, Math.min(100, left * k)),  step);
    state.rightOut = rampUp(state.rightOut, Math.max(-100, Math.min(100, right * k)), step);
    state.leftMotor  = Math.round(state.leftOut);
    state.rightMotor = Math.round(state.rightOut);
}

function updateWheelHUD() {
    leftWheelText.innerText = `L ${state.leftMotor}`;
    rightWheelText.innerText = `R ${state.rightMotor}`;

    const leftHeight = Math.abs(state.leftMotor) / 2;
    const rightHeight = Math.abs(state.rightMotor) / 2;

    leftWheelBar.style.height = `${leftHeight}%`;
    rightWheelBar.style.height = `${rightHeight}%`;

    leftWheelBar.style.bottom = state.leftMotor >= 0 ? '50%' : `${50 - leftHeight}%`;
    rightWheelBar.style.bottom = state.rightMotor >= 0 ? '50%' : `${50 - rightHeight}%`;

    drawSticks();
}

// ============================================================================
// INPUT HANDLING: KEYBOARD, GAMEPAD & ON-SCREEN STICKS
// ============================================================================
const keys = {};

function setupKeyboardListeners() {
    window.addEventListener('keydown', (e) => {
        if (modalSettings.open) return;                     // typing in settings
        keys[e.code] = true;

        if (e.code === 'Space') {
            e.preventDefault();   // no page scroll, no click on a focused button
            state.brakeHeld = true;
        }
        if (e.code === 'KeyL' && !e.repeat) toggleHeadlight();
        if (e.code === 'KeyR' && !e.repeat) resetTrackPosition();
        if (e.code === 'KeyF') setWeapon(true);

        updateKeyboardDrive();
    });

    window.addEventListener('keyup', (e) => {
        keys[e.code] = false;

        if (e.code === 'Space') {
            // a focused button would otherwise click on Space release (settings sheet keeps it)
            if (!modalSettings.open) e.preventDefault();
            state.brakeHeld = false;
        }
        if (e.code === 'KeyF') setWeapon(false);

        updateKeyboardDrive();
    });
}

function updateKeyboardDrive() {
    let t = 0;
    let s = 0;

    if (keys['KeyW'] || keys['ArrowUp'])    t += 100;
    if (keys['KeyS'] || keys['ArrowDown'])  t -= 100;
    if (keys['KeyD'] || keys['ArrowRight']) s += prefs.steerMax;
    if (keys['KeyA'] || keys['ArrowLeft'])  s -= prefs.steerMax;

    state.kb.t = t;
    state.kb.sTarget = s;   // resolveInputs eases kb.s toward it
}

// Losing focus means keyup events will never arrive: release everything, so a
// held W can't keep the car driving after alt-tab. Hidden tab also brakes now,
// since background timers get throttled to ~1 Hz.
function releaseAllInputs() {
    for (const k in keys) keys[k] = false;
    state.kb.t = state.kb.s = state.kb.sTarget = 0;
    for (const st of Object.values(sticks)) {
        st.pointer = null;
        st.held = false;
        st.x = st.y = 0;
    }
    updateTouch();
    state.brakeHeld = false;
    setWeapon(false);
}

function setupSafetyListeners() {
    window.addEventListener('blur', releaseAllInputs);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) return;
        releaseAllInputs();
        if (state.connected && state.wsControl?.readyState === WebSocket.OPEN) {
            sendControl(0, 0, 1 << 0);
        }
    });
}

function pollGamepad() {
    const gamepads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
    const gp = gamepads.find((g) => g);
    const pad = state.pad;

    if (!gp) {
        if (pad.connected) {
            Object.assign(pad, { t: 0, s: 0, l: 0, r: 0, moved: false, brake: false, connected: false });
            pad.name = 'Gamepad';
        }
        return;
    }

    if (!pad.connected) pad.name = `Gamepad: ${gp.id.replace(/\s*\(.*$/, '').substring(0, 28)}`;
    pad.connected = true;

    // Standard mapping: axes 0/1 left stick, 2/3 right stick; buttons 6/7 LT/RT (analog value)
    const ax = (i) => gp.axes[i] || 0;
    const trig = (i) => gp.buttons[i]?.value || 0;
    const axis = (v) => shapeAxis(v);
    pad.tank = false;
    pad.t = pad.s = pad.l = pad.r = 0;
    switch (prefs.padLayout) {
        case 'single':
            pad.t = axis(-ax(1)) * 100;
            pad.s = axis(ax(0)) * prefs.steerMax;
            break;
        case 'triggers':
            pad.t = axis(trig(7) - trig(6)) * 100;
            pad.s = axis(ax(0)) * prefs.steerMax;
            break;
        case 'tank':
            pad.tank = true;
            pad.l = axis(-ax(1)) * 100;
            pad.r = axis(-ax(3)) * 100;
            break;
        default:   // split: left stick Y throttle, right stick X steer (fallback left X)
            pad.t = axis(-ax(1)) * 100;
            pad.s = axis(ax(2) || ax(0)) * prefs.steerMax;
    }
    pad.t = Math.round(pad.t); pad.s = Math.round(pad.s);
    pad.l = Math.round(pad.l); pad.r = Math.round(pad.r);
    pad.moved = pad.t !== 0 || pad.s !== 0 || pad.l !== 0 || pad.r !== 0;

    pad.brake = !!gp.buttons[0]?.pressed;          // A / Cross: brake while held
    const y = !!gp.buttons[3]?.pressed;            // Y / Triangle: lights toggle
    if (y && !pad.prevY) toggleHeadlight();
    pad.prevY = y;
    const rb = !!gp.buttons[5]?.pressed;           // RB / R1: fire while held
    if (rb !== pad.prevRB) setWeapon(rb);
    pad.prevRB = rb;
}

// On-screen sticks: pointer events, so touch (multi-finger) and mouse both work.
// Layout (Settings > Controls) decides each stick's axis and meaning.
const sticks = {};

function setupSticks() {
    for (const key of ['a', 'b']) {
        const el = $(`stick-${key}`);
        const st = sticks[key] = { el, thumb: el.querySelector('.gimbal-thumb'), x: 0, y: 0, held: false, pointer: null };

        el.addEventListener('pointerdown', (e) => {
            if (st.pointer !== null) return;
            e.preventDefault();
            st.pointer = e.pointerId;
            st.held = true;
            el.setPointerCapture(e.pointerId);
            moveStick(st, e);
        });
        el.addEventListener('pointermove', (e) => { if (e.pointerId === st.pointer) moveStick(st, e); });
        const release = (e) => {
            if (e.pointerId !== st.pointer) return;
            st.pointer = null;
            st.held = false;
            st.x = st.y = 0;
            updateTouch();
        };
        for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, release);
    }
}

function moveStick(st, e) {
    const r = st.el.getBoundingClientRect();
    const axis = st.el.dataset.axis;   // xy | x | y
    let x = axis === 'y' ? 0 : (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let y = axis === 'x' ? 0 : (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const d = Math.hypot(x, y);
    if (d > 1) { x /= d; y /= d; }
    st.x = x;
    st.y = y;
    updateTouch();
}

function updateTouch() {
    const { a, b } = sticks, T = state.touch, L = prefs.touchLayout;
    T.active = a.held || (L !== 'one' && b.held);
    T.tank = L === 'tank';
    T.t = T.s = T.l = T.r = 0;
    if (L === 'one') {
        T.t = Math.round(shapeAxis(-a.y) * 100);
        T.s = Math.round(shapeAxis(a.x) * prefs.steerMax);
    } else if (L === 'two') {
        T.t = Math.round(shapeAxis(-a.y) * 100);
        T.s = Math.round(shapeAxis(b.x) * prefs.steerMax);
    } else {
        T.l = Math.round(shapeAxis(-a.y) * 100);
        T.r = Math.round(shapeAxis(-b.y) * 100);
    }
}

// A stick nobody is holding mirrors what is driving the car, so keyboard and gamepad
// input shows up on the sticks too.
function drawSticks() {
    const L = prefs.touchLayout;
    const t = state.throttle / 100, s = state.steering / prefs.steerMax;
    const echo = L === 'one' ? { a: [s, -t], b: [0, 0] }
               : L === 'two' ? { a: [0, -t], b: [s, 0] }
               : { a: [0, -state.leftMotor / 100], b: [0, -state.rightMotor / 100] };
    for (const key of ['a', 'b']) {
        const st = sticks[key];
        const [x, y] = st.held ? [st.x, st.y] : echo[key];
        const travelX = (st.el.clientWidth - st.thumb.offsetWidth) / 2;
        const travelY = (st.el.clientHeight - st.thumb.offsetHeight) / 2;
        st.thumb.style.transform = `translate(${(x * travelX).toFixed(1)}px, ${(y * travelY).toFixed(1)}px)`;
    }
}

const STICK_LAYOUT = {
    one:  { a: ['xy', 'Drive'],      b: ['x', ''],            hint: 'One stick: up and down for speed, sideways to steer.' },
    two:  { a: ['y', 'Throttle'],    b: ['x', 'Steer'],       hint: 'Left stick for speed, right stick to steer.' },
    tank: { a: ['y', 'Left track'],  b: ['y', 'Right track'], hint: 'Each slider drives one track. Push both up to go straight.' }
};

function applyControls() {
    const lay = STICK_LAYOUT[prefs.touchLayout];
    radio.dataset.touch = prefs.touchLayout;
    for (const key of ['a', 'b']) {
        sticks[key].el.dataset.axis = lay[key][0];
        $(`stick-${key}-label`).innerText = lay[key][1];
    }
    $('touch-hint').innerText = lay.hint;
    releaseAllInputs();
    updateKeyboardDrive();
}

function saveControls() {
    store('fpv_controls', JSON.stringify(prefs));
    applyControls();
}

function toggleHeadlight() {
    state.headlight = !state.headlight;
    btnHeadlight.setAttribute('aria-pressed', String(state.headlight));
}

function setWeapon(active) {
    state.weaponTrigger = active;
    btnWeapon.classList.toggle('active', active);
}

function resetTelemetryDisplay() {
    batteryVal.innerText = '--.-V';
    batteryBar.style.width = '0%';
    batteryBar.dataset.state = 'none';
    rssiVal.innerText = '---';
    rssiBars.dataset.level = 0;
    latencyP50.innerText = '---';
    statAckP95.innerText = '-- / -- ms';
    state.ackLatencies = [];
    state.carFlags = 0;
    state.lastTelemetryAt = 0;
    updateWarning();
}

// ============================================================================
// METRICS TIMER & RELAY STATS POLLING (1 Hz)
// ============================================================================
function startMetricsTimer() {
    setInterval(async () => {
        statRecvFps.innerText = state.framesReceived;
        statRenderFps.innerText = state.framesRendered;
        state.framesReceived = 0;
        state.framesRendered = 0;

        updateBadge();
        updateWarning();
        updateVideoEmpty();

        if (!state.connected) return;
        try {
            const proto = state.useSSL ? 'https' : 'http';
            const res = await fetch(`${proto}://${state.relayHost}:${state.relayPort}/health`);
            if (!res.ok) return;
            const data = await res.json();
            const cur = data.rooms?.[state.roomId]?.stats;
            if (!cur) return;

            statRelayRtt.innerText = `${cur.carRttMs || '--'} ms`;
            const prev = state.prevRelayStats;
            state.prevRelayStats = cur;
            if (!prev) return;

            // Per-second deltas (relay counters are cumulative)
            const dRecv = cur.framesReceived - prev.framesReceived;
            const dFwd = cur.framesForwarded - prev.framesForwarded;
            const dDrop = cur.framesDropped - prev.framesDropped;
            statCamFps.innerText = Math.max(0, dRecv);
            statRelayFps.innerText = Math.max(0, dFwd);
            statDropRate.innerText = dFwd + dDrop > 0 ? `${Math.round((dDrop / (dFwd + dDrop)) * 100)}%` : '0%';
        } catch (e) {
            // Ignore silent telemetry poll error
        }
    }, 1000);
}

// ============================================================================
// UI EVENT LISTENERS
// ============================================================================
function holdButton(btn, onChange) {
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); onChange(true); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
        btn.addEventListener(ev, () => onChange(false));
    }
}

function setupEventListeners() {
    btnConnect.addEventListener('click', onConnectButton);

    holdButton(btnBrake, (down) => { state.brakeHeld = down; });
    holdButton(btnWeapon, setWeapon);
    btnHeadlight.addEventListener('click', toggleHeadlight);
    btnTrackReset.addEventListener('click', resetTrackPosition);
}

// Settings sheet: Controls apply and save as you change them; Connection on "Save connection".
function setupSettings() {
    const ranges = [
        ['cfg-deadzone', 'out-deadzone', 'deadzone', (v) => `${v}%`],
        ['cfg-expo',     'out-expo',     'expo',     (v) => `${v}%`],
        ['cfg-steer',    'out-steer',    'steerMax', (v) => `${v}%`],
        ['cfg-speed',    'out-speed',    'speedLimit', (v) => `${v}%`],
        ['cfg-accel',    'out-accel',    'accel', (v) => v ? `${(v / 10).toFixed(1)}s` : 'Off'],
        ['cfg-steer-speed', 'out-steer-speed', 'steerAtSpeed', (v) => `${v}%`]
    ];
    const touchRadios = [...document.querySelectorAll('input[name="touchLayout"]')];
    const padSelect = $('cfg-pad-layout');
    const swap = $('cfg-swap-steer');

    const fillControls = () => {
        touchRadios.forEach((r) => { r.checked = r.value === prefs.touchLayout; });
        padSelect.value = prefs.padLayout;
        swap.checked = prefs.swapSteer;
        for (const [inputId, outId, key, fmt] of ranges) {
            $(inputId).value = prefs[key];
            $(outId).value = fmt(prefs[key]);
        }
    };

    const readControls = () => {
        const next = { ...prefs, padLayout: padSelect.value, swapSteer: swap.checked };
        next.touchLayout = touchRadios.find((r) => r.checked)?.value ?? prefs.touchLayout;
        for (const [inputId, , key] of ranges) next[key] = $(inputId).value;
        Object.assign(prefs, sanitizeControls(next));
        saveControls();
        fillControls();
    };

    touchRadios.forEach((r) => r.addEventListener('change', readControls));
    padSelect.addEventListener('change', readControls);
    swap.addEventListener('change', readControls);
    for (const [inputId] of ranges) $(inputId).addEventListener('input', readControls);

    $('btn-reset-controls').addEventListener('click', () => {
        Object.assign(prefs, CONTROL_DEFAULTS);
        saveControls();
        fillControls();
    });

    btnSettings.addEventListener('click', () => {
        releaseAllInputs();
        cfgHost.value = state.relayHost;
        cfgPort.value = state.relayPort;
        cfgRoom.value = state.roomId;
        cfgToken.value = state.token;
        cfgSSL.checked = state.useSSL;
        fillControls();
        modalSettings.showModal();
    });

    btnSaveSettings.addEventListener('click', () => {
        state.relayHost = cfgHost.value.trim() || defaultHost;
        state.relayPort = cfgPort.value.trim() || defaultPort;
        state.roomId    = cfgRoom.value.trim() || 'battle_room_1';
        state.token     = cfgToken.value.trim();
        state.useSSL    = cfgSSL.checked;

        store('fpv_host', state.relayHost);
        store('fpv_port', state.relayPort);
        store('fpv_room', state.roomId);
        store('fpv_token', state.token);
        store('fpv_ssl', state.useSSL);

        $('room-display').innerText = state.roomId;
        if (state.wantConnected) {
            state.reconnectDelay = 1000;
            openSockets();
        }
        updateVideoEmpty();
    });
}

// Launch app
window.addEventListener('DOMContentLoaded', init);
