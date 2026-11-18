// End-to-end: real relay + SimCar (firmware protocol twin) + raw controller sockets.
process.env.RELAY_TOKEN = 'testtoken';
process.env.UDP_PORT = '0';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const dgram = require('node:dgram');
const WebSocket = require('ws');
const { server, udp } = require('../server');
const { SimCar, throttleToDuty } = require('../sim_car');

const TOKEN = 'testtoken';
let port, udpPort;
const cleanup = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 1000, what = 'condition') {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return; await sleep(5); }
    assert.fail(`timeout waiting for ${what}`);
}

// Resolves to an open ws, or rejects with the HTTP status code.
function open(path, { room = 'r1', role = 'controller', token = TOKEN, raw } = {}) {
    let q = raw ?? `room=${room}&role=${role}` + (token ? `&token=${token}` : '');
    const ws = new WebSocket(`ws://localhost:${port}${path}?${q}`);
    ws.binaryType = 'nodebuffer';
    ws.on('error', () => {});
    cleanup.push(() => ws.terminate());
    return new Promise((resolve, reject) => {
        ws.once('open', () => resolve(ws));
        ws.once('unexpected-response', (req, res) => reject(res.statusCode));
        ws.once('close', () => reject('closed'));
    });
}

const status = (p) => p.then(() => 101, (code) => code);

function sim(room, opts = {}) {
    const car = new SimCar({ url: `ws://localhost:${port}`, room, token: TOKEN, ...opts }).start();
    cleanup.push(() => car.stop());
    return car;
}

let seq = 0;
function pkt(left, right, flags = 0, version = 1) {
    const b = Buffer.alloc(8);
    b.writeUInt16BE(0xBEEF, 0);
    b.writeUInt16BE(++seq & 0xFFFF, 2);
    b.writeInt8(left, 4); b.writeInt8(right, 5);
    b[6] = flags; b[7] = version;
    return b;
}

function get(path) {
    return new Promise((resolve, reject) => {
        http.get({ host: 'localhost', port, path }, (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

test.before(() => new Promise((r) => {
    udp.once('listening', () => { udpPort = udp.address().port; r(); });
    server.listen(0, () => { port = server.address().port; });
}));
test.afterEach(async () => { while (cleanup.length) cleanup.pop()(); await sleep(50); });
test.after(() => new Promise((r) => server.close(r)));

test('token: missing and wrong rejected with 401, correct accepted', async () => {
    assert.strictEqual(await status(open('/ws/control', { token: '' })), 401);
    assert.strictEqual(await status(open('/ws/control', { token: 'nope' })), 401);
    assert.strictEqual(await status(open('/ws/control')), 101);
});

test('validation: missing role 400, bad room 400, unknown path 404', async () => {
    assert.strictEqual(await status(open('/ws/control', { raw: `room=r1&token=${TOKEN}` })), 400);
    assert.strictEqual(await status(open('/ws/control', { raw: `room=a/b&role=car&token=${TOKEN}` })), 400);
    assert.strictEqual(await status(open('/ws/control', { room: 'x'.repeat(40) })), 400);
    assert.strictEqual(await status(open('/ws/nope')), 404);
});

test('controller -> car forwarding; malformed frames not forwarded', async () => {
    const car = sim('fwd');
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const ctl = await open('/ws/control', { room: 'fwd' });
    ctl.send(pkt(50, -30));
    await waitFor(() => car.packetsReceived === 1, 1000, 'packet');
    assert.deepStrictEqual([car.left, car.right], [50, -30]);

    ctl.send(pkt(10, 10).subarray(0, 7));
    ctl.send(Buffer.concat([pkt(10, 10), Buffer.from([0])]));
    ctl.send('hello');
    ctl.send(pkt(10, 10, 0, 2));            // wrong version: relay forwards, car rejects
    await sleep(150);
    assert.strictEqual(car.packetsReceived, 1);
    assert.deepStrictEqual([car.left, car.right], [50, -30]);
});

test('throttle clamp: -128/127 clamp to -100/100', async () => {
    const car = sim('clamp');
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const ctl = await open('/ws/control', { room: 'clamp' });
    ctl.send(pkt(127, -128));
    await waitFor(() => car.packetsReceived === 1);
    assert.deepStrictEqual([car.left, car.right], [100, -100]);
});

test('car ACK reaches controller echoing seq, battery 7800', async () => {
    const car = sim('ack');
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const ctl = await open('/ws/control', { room: 'ack' });
    const acks = [];
    ctl.on('message', (d) => acks.push(d));
    const p = pkt(20, 20);
    const sent = p.readUInt16BE(2);
    await sleep(120);   // let the fallback ACK clock pass the 100 ms gate
    ctl.send(p);
    await waitFor(() => acks.some((a) => a.readUInt16BE(2) === sent), 500, 'ACK with seq');
    const a = acks.find((x) => x.readUInt16BE(2) === sent);
    assert.strictEqual(a.length, 8);
    assert.strictEqual(a.readUInt16BE(0), 0xBEEF);
    assert.strictEqual(a.readUInt16BE(4), 7800);
    assert.strictEqual(a.readInt8(6), -55);
});

test('link loss: holds 300 ms, fades, brakes ~800 ms after last packet, re-arms on next', async () => {
    const car = sim('fs');
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const ctl = await open('/ws/control', { room: 'fs' });
    const full = throttleToDuty(80);
    const t0 = Date.now();
    while (Date.now() - t0 < 300) { ctl.send(pkt(80, 80)); await sleep(20); }
    assert.strictEqual(car.failsafe, false);
    assert.strictEqual(car.dutyL, full);
    const last = Date.now();
    await sleep(150);
    assert.strictEqual(car.dutyL, full, 'full command during the hold');
    await waitFor(() => car.fading && car.dutyL > 0 && car.dutyL < full, 500, 'fade');
    const fadeAt = Date.now() - last;
    assert.ok(fadeAt >= 280 && fadeAt <= 650, `fade started ${fadeAt} ms after the last packet`);
    await waitFor(() => car.failsafe, 900, 'failsafe');
    const dt = Date.now() - last;
    assert.ok(dt >= 780 && dt <= 950, `failsafe after ${dt} ms`);
    assert.strictEqual(car.dutyL, 0);
    ctl.send(pkt(80, 80));
    await waitFor(() => !car.failsafe && car.dutyL === full, 300, 're-arm');
});

test('controller disconnect -> car stops within failsafe window', async () => {
    const car = sim('dc');
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const ctl = await open('/ws/control', { room: 'dc' });
    ctl.send(pkt(100, 100));
    await waitFor(() => car.dutyL === 255);
    ctl.terminate();
    await waitFor(() => car.failsafe && car.dutyL === 0, 1000, 'stop after controller drop');
});

test('brake flag -> zero duty', async () => {
    const car = sim('brake');
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const ctl = await open('/ws/control', { room: 'brake' });
    ctl.send(pkt(100, 100));
    await waitFor(() => car.dutyL === 255);
    ctl.send(pkt(100, 100, 1));
    await waitFor(() => car.dutyL === 0 && car.dutyR === 0, 200, 'brake');
    assert.strictEqual(car.failsafe, false);
});

test('rooms are isolated', async () => {
    const carB = sim('roomB');
    await waitFor(() => carB.controlConnected, 2000, 'car connect');
    const ctlA = await open('/ws/control', { room: 'roomA' });
    ctlA.send(pkt(60, 60));
    await sleep(150);
    assert.strictEqual(carB.packetsReceived, 0);
});

test('second controller replaces the first and drives', async () => {
    const car = sim('repl');
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const c1 = await open('/ws/control', { room: 'repl' });
    const closed = new Promise((r) => c1.once('close', r));
    const c2 = await open('/ws/control', { room: 'repl' });
    await closed;
    c2.send(pkt(-40, 40));
    await waitFor(() => car.left === -40 && car.right === 40, 500, 'c2 drives');
});

test('oversized control frame closes that socket; relay survives', async () => {
    const car = sim('big');
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const bad = await open('/ws/control', { room: 'big2' });
    const closed = new Promise((r) => bad.once('close', r));
    bad.send(Buffer.alloc(100));
    await closed;
    assert.strictEqual((await get('/health')).status, 200);
    const ctl = await open('/ws/control', { room: 'big' });
    ctl.send(pkt(30, 30));
    await waitFor(() => car.left === 30, 500, 'still forwarding');
});

test('empty rooms are removed from /health', async () => {
    const ctl = await open('/ws/control', { room: 'tmp' });
    assert.ok(JSON.parse((await get('/health')).body).rooms.tmp);
    ctl.close();
    await sleep(100);
    assert.strictEqual(JSON.parse((await get('/health')).body).rooms.tmp, undefined);
});

test('lobby: each claim gets a different free car, none when all taken, hold ends on connect', async () => {
    const a = sim('lobby_a'), b = sim('lobby_b');
    await waitFor(() => a.controlConnected && b.controlConnected, 2000, 'cars connect');
    const claim = async () => JSON.parse((await get('/claim')).body);

    const first = await claim(), second = await claim(), third = await claim();
    assert.deepStrictEqual([first.room, second.room].sort(), ['lobby_a', 'lobby_b']);
    assert.strictEqual(third.room, null);
    assert.strictEqual(third.cars, 2);

    // The player for lobby_a drives, then leaves: lobby_a is free again, not held
    const ctl = await open('/ws/control', { room: 'lobby_a' });
    assert.strictEqual((await claim()).room, null);
    ctl.close();
    await sleep(100);
    assert.strictEqual((await claim()).room, 'lobby_a');
});

test('lobby: a picked car is claimed only while free, and shows as claimed', async () => {
    const a = sim('pick_a'), b = sim('pick_b');
    await waitFor(() => a.controlConnected && b.controlConnected, 2000, 'cars connect');
    const claim = async (room) => JSON.parse((await get('/claim?room=' + room)).body);

    assert.strictEqual((await claim('pick_b')).room, 'pick_b');
    assert.strictEqual((await claim('pick_b')).room, null);   // held for the first picker
    assert.strictEqual(JSON.parse((await get('/health')).body).rooms.pick_b.claimed, true);
    assert.strictEqual((await claim('no_such_car')).room, null);
    assert.strictEqual((await claim('pick_a')).room, 'pick_a');

    // Its player connects: still taken, but no longer "claimed"
    const ctl = await open('/ws/control', { room: 'pick_b' });
    assert.strictEqual((await claim('pick_b')).room, null);
    assert.strictEqual(JSON.parse((await get('/health')).body).rooms.pick_b.claimed, false);
    ctl.close();
});

test('virtual track: ghost follows commands, stops on link loss like the car, reset returns it', async () => {
    const car = sim('trk_a');
    await waitFor(() => car.controlConnected, 2000, 'car connects');
    // Listener before 'open': the layout is sent on connect and can arrive with the handshake
    const vid = new WebSocket(`ws://localhost:${port}/ws/video?room=trk_a&role=controller&token=${TOKEN}`);
    cleanup.push(() => vid.terminate());
    const msgs = [];
    vid.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d)); });
    await new Promise((r) => vid.once('open', r));
    const pose = () => [...msgs].reverse().find((m) => m.t === 'cars' && m.cars.trk_a)?.cars.trk_a;
    await waitFor(() => msgs[0]?.t === 'track' && pose(), 1000, 'track layout + pose');
    assert.ok(msgs[0].pts.length > 50 && msgs[0].width > 0);
    const start = pose();
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    // Full forward for 600 ms: ~0.36 m at 0.6 m/s, straight ahead
    const ctl = await open('/ws/control', { room: 'trk_a' });
    for (let i = 0; i < 30; i++) { ctl.send(pkt(100, 100)); await sleep(20); }
    const moved = pose();
    assert.ok(dist(start, moved) > 0.2, `moved ${dist(start, moved).toFixed(3)} m`);
    assert.ok(Math.abs(moved.h - start.h) < 0.01, 'equal tracks drive straight');

    // Commands stop: fades and stops by 800 ms, then holds still
    await sleep(1000);
    const p1 = pose();
    await sleep(300);
    assert.ok(dist(p1, pose()) < 0.005, 'stopped after failsafe');

    // Left track faster turns right (clockwise = heading grows)
    for (let i = 0; i < 15; i++) { ctl.send(pkt(100, 0)); await sleep(20); }
    assert.ok(pose().h > p1.h + 0.1, 'left-only command turns clockwise');

    vid.send('reset');
    await waitFor(() => dist(pose(), start) < 0.01 && Math.abs(pose().h - start.h) < 0.01, 1000, 'back on the grid');
});

test('static cockpit whitelist', async () => {
    const lobby = await get('/');
    assert.strictEqual(lobby.status, 200);
    assert.match(lobby.body, /\/claim/);
    const idx = await get('/index.html');
    assert.strictEqual(idx.status, 200);
    assert.match(idx.body, /fpv-canvas/);
    assert.strictEqual((await get('/app.js')).status, 200);
    assert.strictEqual((await get('/bg.js')).status, 200);
    assert.strictEqual((await get('/style.css')).status, 200);
    assert.strictEqual((await get('/server.js')).status, 404);
    assert.strictEqual((await get('/../relay/server.js')).status, 404);
    assert.strictEqual((await get('/..%2frelay%2fserver.js')).status, 404);
    assert.strictEqual((await get('/package.json')).status, 404);
});

test('video: sim car PNG frames reach the controller', async () => {
    sim('vid', { video: true });
    const v = await open('/ws/video', { room: 'vid' });
    const frame = await new Promise((r) => v.once('message', r));
    assert.deepStrictEqual([...frame.subarray(0, 4)], [0x89, 0x50, 0x4E, 0x47]);
});

test('physics: straight drive moves ~0.3 m in 0.5 s; spin turns in place', async () => {
    const car = sim('phys');
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const ctl = await open('/ws/control', { room: 'phys' });
    const drive = async (l, r, ms) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { ctl.send(pkt(l, r)); await sleep(20); }
    };
    await drive(0, 0, 60);
    const y0 = car.y, x0 = car.x;
    await drive(100, 100, 500);
    const d = Math.hypot(car.x - x0, car.y - y0);
    assert.ok(d > 0.21 && d < 0.39, `moved ${d.toFixed(3)} m`);
    assert.ok(car.y > y0, 'moved forward (+y)');

    const h0 = car.heading, x1 = car.x, y1 = car.y;
    await drive(100, -100, 300);
    assert.ok(car.heading - h0 > 1, `turned ${(car.heading - h0).toFixed(2)} rad clockwise`);
    assert.ok(Math.hypot(car.x - x1, car.y - y1) < 0.02, 'spun in place');
});

test('duty mapping matches motor.cpp throttleToDuty', () => {
    assert.strictEqual(throttleToDuty(0), 0);
    assert.strictEqual(throttleToDuty(100), 255);
    assert.strictEqual(throttleToDuty(-100), -255);
    assert.strictEqual(throttleToDuty(1), 3);          // (1*255+50)/100 = 3
    assert.strictEqual(throttleToDuty(50), 128);       // (50*255+50)/100 = 128
    assert.strictEqual(throttleToDuty(1, 70), 72);     // 70 + (185+50)/100
    assert.strictEqual(throttleToDuty(100, 70), 255);
});

// ---- UDP control path (weak-link transport) ----
const health = async () => JSON.parse((await get('/health')).body);

test('UDP: hello registers the car; every command arrives twice and is applied once', async () => {
    const car = sim('u1', { udpPort });
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const h0 = Date.now();
    while (!(await health()).rooms.u1?.carUdp) {
        assert.ok(Date.now() - h0 < 2500, 'car UDP registered');
        await sleep(50);
    }
    const ctl = await open('/ws/control', { room: 'u1' });
    for (let i = 0; i < 20; i++) { ctl.send(pkt(40 + i, 40 + i)); await sleep(15); }
    await waitFor(() => car.udpApplied + car.wsApplied + car.staleDropped >= 40, 1000, 'both copies');
    assert.strictEqual(car.packetsReceived, 20, 'each command applied exactly once');
    assert.strictEqual(car.staleDropped, 20, 'the second copy of each is dropped');
    assert.strictEqual(car.udpArrived, 20, 'every command also arrived over UDP');
    assert.strictEqual(car.left, 59);
    assert.ok((await health()).rooms.u1.stats.udpToCar >= 20);
});

test('UDP: ACKs come back over UDP and reach the controller', async () => {
    const car = sim('u2', { udpPort });
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const ctl = await open('/ws/control', { room: 'u2' });
    const acks = [];
    ctl.on('message', (d) => acks.push(d));
    const t0 = Date.now();
    while (Date.now() - t0 < 2500 && !(car._udpFresh() && acks.length > 3)) { ctl.send(pkt(30, 30)); await sleep(20); }
    assert.ok(car._udpFresh(), 'UDP delivering to the car');
    const before = (await health()).rooms.u2.stats.udpFromCar;
    for (let i = 0; i < 15; i++) { ctl.send(pkt(30, 30)); await sleep(20); }
    const h = (await health()).rooms.u2.stats;
    assert.ok(h.udpFromCar > before, `ACKs over UDP: ${before} -> ${h.udpFromCar}`);
    assert.ok(acks.length > 3 && acks.every((a) => a.length === 8));
});

test('UDP: hello with a wrong token or bad room is ignored', async () => {
    const s = dgram.createSocket('udp4');
    cleanup.push(() => s.close());
    await new Promise((r) => s.bind(0, r));
    for (const m of ['HELLO u3 wrongtoken', 'HELLO u3', 'HELLO a/b testtoken', 'HELLO ' + 'x'.repeat(40) + ' testtoken']) {
        s.send(m, udpPort, '127.0.0.1');
    }
    await sleep(150);
    const rooms = (await health()).rooms;
    assert.strictEqual(rooms.u3, undefined, 'no room from a bad hello');
    s.send('HELLO u3 testtoken', udpPort, '127.0.0.1');
    await waitFor(() => true, 10);
    await sleep(100);
    assert.strictEqual((await health()).rooms.u3?.carUdp, true, 'good hello registers');
});

test('UDP: car keeps driving when its WebSocket drops while UDP is live', async () => {
    const car = sim('u4', { udpPort });
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const ctl = await open('/ws/control', { room: 'u4' });
    let driving = true;
    (async () => { while (driving) { ctl.send(pkt(60, 60)); await sleep(20); } })();
    await waitFor(() => car._udpFresh() && car.dutyL > 0, 2500, 'driving over UDP');
    car._sockets.control.terminate();          // TCP path dies, UDP keeps going
    await waitFor(() => !car.controlConnected, 500, 'ws closed');
    await sleep(200);
    assert.strictEqual(car.failsafe, false, 'no brake while UDP delivers');
    assert.strictEqual(car.dutyL, throttleToDuty(60));
    driving = false;
    await waitFor(() => car.failsafe, 1200, 'brake once UDP stops too');
});
