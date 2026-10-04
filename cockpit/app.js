/**
 * Web Cockpit Controller & FPV HUD
 * Specification: Internet-Controlled Low-Latency FPV Battle Car v3.4
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

const state = {
    relayHost: stored('fpv_host') || defaultHost,
    relayPort: stored('fpv_port') || defaultPort,
    roomId:    stored('fpv_room') || 'battle_room_1',
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

    // Input sources, merged every control tick
    kb:    { t: 0, s: 0 },
    touch: { t: 0, s: 0, active: false },
    pad:   { t: 0, s: 0, brake: false, connected: false },
    brakeHeld: false,        // Space key or brake button

    // Resolved outputs
    throttle: 0, // -100 to +100
    steering: 0, // -100 to +100
    leftMotor: 0,
    rightMotor: 0,
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
    decoding: false,
    pendingFrame: null,      // newest decoded frame awaiting draw
    drawScheduled: false,
    prevRelayStats: null
};

// Car status flag bits (firmware sendTelemetryACK)
const FLAG_FAILSAFE = 1 << 0, FLAG_LIMITED = 1 << 1, FLAG_BATT_WARN = 1 << 2,
      FLAG_CUTOFF = 1 << 3, FLAG_NO_SENSOR = 1 << 4;
const CAR_TIMEOUT_MS = 1000;

// Stick feel (touch + gamepad). Tune here.
const STICK_DEADZONE = 0.12;  // fraction of travel ignored around centre
const STICK_EXPO = 0.6;       // 0 = linear, 1 = fully cubic (fine control near centre)
const STEER_MAX = 60;         // % steering at full deflection (100 = spin in place)

// -1..1 in -> -1..1 out, with deadzone rescale and expo curve.
function shapeAxis(v) {
    const a = Math.abs(v);
    if (a <= STICK_DEADZONE) return 0;
    const x = Math.min(1, (a - STICK_DEADZONE) / (1 - STICK_DEADZONE));
    return Math.sign(v) * (STICK_EXPO * x ** 3 + (1 - STICK_EXPO) * x);
}

// DOM Elements
const canvas = document.getElementById('fpv-canvas');
const ctx = canvas.getContext('2d');
const btnConnect = document.getElementById('btn-connect');
const vehicleStatus = document.getElementById('vehicle-status');
const batteryVal = document.getElementById('battery-value');
const batteryBar = document.getElementById('battery-bar');
const rssiVal = document.getElementById('rssi-value');
const latencyP50 = document.getElementById('latency-p50');
const warningBanner = document.getElementById('warning-banner');
const warningText = document.getElementById('warning-text');
const leftWheelBar = document.getElementById('left-wheel-bar');
const rightWheelBar = document.getElementById('right-wheel-bar');
const leftWheelText = document.getElementById('left-wheel-text');
const rightWheelText = document.getElementById('right-wheel-text');

// Stat Elements
const statCamFps = document.getElementById('stat-cam-fps');
const statRelayFps = document.getElementById('stat-relay-fps');
const statRecvFps = document.getElementById('stat-recv-fps');
const statRenderFps = document.getElementById('stat-render-fps');
const statDropRate = document.getElementById('stat-drop-rate');
const statAckP95 = document.getElementById('stat-ack-p95');
const statRelayRtt = document.getElementById('stat-relay-rtt');

// Action Buttons
const btnBrake = document.getElementById('btn-brake');
const btnHeadlight = document.getElementById('btn-headlight');
const btnWeapon = document.getElementById('btn-weapon');

// Settings Modal
const btnSettings = document.getElementById('btn-settings');
const modalSettings = document.getElementById('settings-modal');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const cfgHost = document.getElementById('cfg-relay-host');
const cfgPort = document.getElementById('cfg-relay-port');
const cfgRoom = document.getElementById('cfg-room');
const cfgToken = document.getElementById('cfg-token');
const cfgSSL = document.getElementById('cfg-use-ssl');

// ============================================================================
// INITIALIZATION
// ============================================================================
function init() {
    cfgHost.value = state.relayHost;
    cfgPort.value = state.relayPort;
    cfgRoom.value = state.roomId;
    cfgToken.value = state.token;
    cfgSSL.checked = state.useSSL;
    document.getElementById('room-display').innerText = `ROOM: ${state.roomId.toUpperCase()}`;

    setupEventListeners();
    setupKeyboardListeners();
    setupTouchJoystick();
    setupSafetyListeners();
    startControlLoop();
    startMetricsTimer();
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
        setBadge('DISCONNECTED', 'status-offline');
        btnConnect.innerText = 'CONNECT';
        btnConnect.classList.remove('btn-danger');
        resetTelemetryDisplay();
    } else {
        state.wantConnected = true;
        state.reconnectDelay = 1000;
        btnConnect.innerText = 'DISCONNECT';
        btnConnect.classList.add('btn-danger');
        openSockets();
    }
}

function openSockets() {
    closeSockets();
    if (!state.wantConnected) return;
    setBadge('CONNECTING...', 'status-offline');

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
    if (!state.wantConnected) return;
    setBadge('RECONNECTING...', 'status-offline');
    state.reconnectTimer = setTimeout(openSockets, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 5000);
}

function setBadge(text, cls) {
    vehicleStatus.className = `status-badge ${cls}`;
    vehicleStatus.innerText = text;
}

function updateBadge() {
    if (!state.connected) return;
    if (performance.now() - state.lastTelemetryAt <= CAR_TIMEOUT_MS) setBadge('ONLINE', 'status-online');
    else setBadge('CAR OFFLINE', 'status-warn');
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

    setInterval(() => {
        pollGamepad();
        resolveInputs();
        mixDrive();
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
        batteryVal.innerText = 'NO SENSOR';
        batteryBar.style.width = '0%';
    } else {
        batteryVal.innerText = `${(battMv / 1000.0).toFixed(2)} V`;
        // 6.0V = 0%, 8.4V = 100%
        const pct = Math.max(0, Math.min(100, Math.round(((battMv - 6000) / 2400) * 100)));
        batteryBar.style.width = `${pct}%`;
        batteryBar.style.background = (flags & FLAG_CUTOFF) ? 'var(--accent-red)'
            : (flags & (FLAG_LIMITED | FLAG_BATT_WARN)) ? 'var(--accent-amber)'
            : 'var(--accent-green)';
    }

    rssiVal.innerText = `${rssi} dBm`;
    updateWarning();
}

function recordLatency(ms) {
    state.ackLatencies.push(ms);
    if (state.ackLatencies.length > 100) state.ackLatencies.shift();

    const sorted = [...state.ackLatencies].sort((a, b) => a - b);
    state.p50 = Math.round(sorted[Math.floor(sorted.length * 0.50)]);
    state.p95 = Math.round(sorted[Math.floor(sorted.length * 0.95)]);
    state.p99 = Math.round(sorted[Math.floor(sorted.length * 0.99)]);

    latencyP50.innerText = `${state.p50} ms`;
    statAckP95.innerText = `${state.p95} / ${state.p99} ms`;
}

// Single place that decides the banner, highest priority first.
function updateWarning() {
    const carLive = state.connected && performance.now() - state.lastTelemetryAt <= CAR_TIMEOUT_MS;
    const f = carLive ? state.carFlags : 0;
    let msg = null;
    if (state.dynamicBrake)          msg = 'DYNAMIC BRAKE ENGAGED';
    else if (f & FLAG_CUTOFF)        msg = 'BATTERY CUTOFF: MOTORS DISABLED';
    else if (f & FLAG_FAILSAFE)      msg = 'FAILSAFE TRIGGERED: MOTORS STOPPED';
    else if (f & FLAG_LIMITED)       msg = 'BATTERY LOW: THROTTLE CAPPED AT 60%';
    else if (f & FLAG_BATT_WARN)     msg = 'BATTERY LOW: LAND SOON';

    if (msg) {
        warningText.innerText = msg;
        warningBanner.classList.remove('hidden');
    } else {
        warningBanner.classList.add('hidden');
    }
}

// ============================================================================
// LOW-LATENCY FPV VIDEO DECODER & CANVAS RENDERER
// ============================================================================
async function handleVideoMessage(event) {
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
            });
        }
    } catch (e) {
        console.error('Frame decode error:', e);
    } finally {
        state.decoding = false;
    }
}

// ============================================================================
// INPUT MERGE + DIFFERENTIAL STEERING MIXER
// ============================================================================
function resolveInputs() {
    const pad = state.pad;
    let src = state.kb;
    if (pad.connected && (pad.t !== 0 || pad.s !== 0)) src = pad;
    else if (state.touch.active) src = state.touch;

    state.throttle = src.t;
    state.steering = src.s;
    const brake = state.brakeHeld || pad.brake;
    if (brake !== state.dynamicBrake) {
        state.dynamicBrake = brake;
        btnBrake.classList.toggle('active', brake);
        updateWarning();
    }
}

function mixDrive() {
    if (state.dynamicBrake) {
        state.leftMotor = 0;
        state.rightMotor = 0;
        return;
    }

    // Arcade drive: Left = Throttle + Steering, Right = Throttle - Steering
    const left  = state.throttle + state.steering;
    const right = state.throttle - state.steering;

    state.leftMotor  = Math.max(-100, Math.min(100, Math.round(left)));
    state.rightMotor = Math.max(-100, Math.min(100, Math.round(right)));
}

function updateWheelHUD() {
    leftWheelText.innerText = `L: ${state.leftMotor}%`;
    rightWheelText.innerText = `R: ${state.rightMotor}%`;

    const leftHeight = Math.abs(state.leftMotor) / 2;
    const rightHeight = Math.abs(state.rightMotor) / 2;

    leftWheelBar.style.height = `${leftHeight}%`;
    rightWheelBar.style.height = `${rightHeight}%`;

    leftWheelBar.style.bottom = state.leftMotor >= 0 ? '50%' : `${50 - leftHeight}%`;
    rightWheelBar.style.bottom = state.rightMotor >= 0 ? '50%' : `${50 - rightHeight}%`;
}

// ============================================================================
// INPUT HANDLING: KEYBOARD, GAMEPAD & TOUCH
// ============================================================================
const keys = {};

function setupKeyboardListeners() {
    window.addEventListener('keydown', (e) => {
        if (e.target instanceof HTMLInputElement) return;   // typing in settings
        keys[e.code] = true;

        if (e.code === 'Space') {
            e.preventDefault();
            state.brakeHeld = true;
        }
        if (e.code === 'KeyL' && !e.repeat) toggleHeadlight();
        if (e.code === 'KeyF') setWeapon(true);

        updateKeyboardDrive();
    });

    window.addEventListener('keyup', (e) => {
        keys[e.code] = false;

        if (e.code === 'Space') state.brakeHeld = false;
        if (e.code === 'KeyF') setWeapon(false);

        updateKeyboardDrive();
    });
}

function updateKeyboardDrive() {
    let t = 0;
    let s = 0;

    if (keys['KeyW'] || keys['ArrowUp'])    t += 100;
    if (keys['KeyS'] || keys['ArrowDown'])  t -= 100;
    if (keys['KeyD'] || keys['ArrowRight']) s += STEER_MAX;
    if (keys['KeyA'] || keys['ArrowLeft'])  s -= STEER_MAX;

    state.kb.t = t;
    state.kb.s = s;
}

// Losing focus means keyup events will never arrive: release everything, so a
// held W can't keep the car driving after alt-tab. Hidden tab also brakes now,
// since background timers get throttled to ~1 Hz.
function releaseAllInputs() {
    for (const k in keys) keys[k] = false;
    state.kb.t = state.kb.s = 0;
    state.touch.t = state.touch.s = 0;
    state.touch.active = false;
    state.brakeHeld = false;
    setWeapon(false);
    document.getElementById('joystick-thumb').style.transform = 'translate(0px, 0px)';
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
            Object.assign(pad, { t: 0, s: 0, brake: false, connected: false });
            document.getElementById('input-device-label').innerText = 'KEYBOARD / TOUCH ACTIVE';
        }
        return;
    }

    if (!pad.connected) {
        document.getElementById('input-device-label').innerText = `GAMEPAD: ${gp.id.substring(0, 16)}...`;
    }
    pad.connected = true;

    // Left Stick Y (Axis 1): Throttle, Right Stick X (Axis 2, fallback Axis 0): Steering
    const rawY = gp.axes[1] || 0;
    const rawX = gp.axes[2] || gp.axes[0] || 0;

    pad.t = Math.round(shapeAxis(-rawY) * 100);
    pad.s = Math.round(shapeAxis(rawX) * STEER_MAX);
    pad.brake = !!gp.buttons[0]?.pressed;   // Button 0 (A / Cross)
}

function setupTouchJoystick() {
    const base = document.getElementById('joystick-base');
    const thumb = document.getElementById('joystick-thumb');
    let touchId = null;

    base.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const touch = e.changedTouches[0];
        touchId = touch.identifier;
        state.touch.active = true;
        moveJoystick(touch, base, thumb);
    });

    window.addEventListener('touchmove', (e) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === touchId) {
                moveJoystick(e.changedTouches[i], base, thumb);
                break;
            }
        }
    });

    const resetJoystick = (e) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === touchId) {
                touchId = null;
                thumb.style.transform = 'translate(0px, 0px)';
                state.touch.t = state.touch.s = 0;
                state.touch.active = false;
                break;
            }
        }
    };

    window.addEventListener('touchend', resetJoystick);
    window.addEventListener('touchcancel', resetJoystick);
}

function moveJoystick(touch, base, thumb) {
    const rect = base.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const maxRadius = rect.width / 2;
    let dx = touch.clientX - centerX;
    let dy = touch.clientY - centerY;

    const distance = Math.hypot(dx, dy);
    if (distance > maxRadius) {
        dx = (dx / distance) * maxRadius;
        dy = (dy / distance) * maxRadius;
    }

    thumb.style.transform = `translate(${dx}px, ${dy}px)`;

    state.touch.s = Math.round(shapeAxis(dx / maxRadius) * STEER_MAX);
    state.touch.t = Math.round(shapeAxis(-dy / maxRadius) * 100);
}

function toggleHeadlight() {
    state.headlight = !state.headlight;
    btnHeadlight.classList.toggle('active', state.headlight);
}

function setWeapon(active) {
    state.weaponTrigger = active;
    btnWeapon.classList.toggle('active', active);
}

function resetTelemetryDisplay() {
    batteryVal.innerText = '--.- V';
    batteryBar.style.width = '0%';
    rssiVal.innerText = '-- dBm';
    latencyP50.innerText = '-- ms';
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

    btnSettings.addEventListener('click', () => modalSettings.classList.remove('hidden'));
    btnCloseSettings.addEventListener('click', () => modalSettings.classList.add('hidden'));

    btnSaveSettings.addEventListener('click', () => {
        state.relayHost = cfgHost.value.trim();
        state.relayPort = cfgPort.value.trim();
        state.roomId    = cfgRoom.value.trim();
        state.token     = cfgToken.value.trim();
        state.useSSL    = cfgSSL.checked;

        store('fpv_host', state.relayHost);
        store('fpv_port', state.relayPort);
        store('fpv_room', state.roomId);
        store('fpv_token', state.token);
        store('fpv_ssl', state.useSSL);

        document.getElementById('room-display').innerText = `ROOM: ${state.roomId.toUpperCase()}`;
        modalSettings.classList.add('hidden');

        if (state.wantConnected) {
            state.reconnectDelay = 1000;
            openSockets();
        }
    });
}

// Launch app
window.addEventListener('DOMContentLoaded', init);
