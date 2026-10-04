// End-to-end: real relay + SimCar (firmware protocol twin) + raw controller sockets.
process.env.RELAY_TOKEN = 'testtoken';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { server } = require('../server');
const { SimCar, throttleToDuty } = require('../sim_car');

const TOKEN = 'testtoken';
let port;
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

test.before(() => new Promise((r) => server.listen(0, () => { port = server.address().port; r(); })));
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

test('failsafe trips 300 ms after last packet, re-arms on next packet', async () => {
    const car = sim('fs');
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const ctl = await open('/ws/control', { room: 'fs' });
    const t0 = Date.now();
    while (Date.now() - t0 < 300) { ctl.send(pkt(80, 80)); await sleep(20); }
    assert.strictEqual(car.failsafe, false);
    assert.ok(car.dutyL > 0);
    const last = Date.now();
    await waitFor(() => car.failsafe, 600, 'failsafe');
    const dt = Date.now() - last;
    assert.ok(dt >= 280 && dt <= 450, `failsafe after ${dt} ms`);
    assert.strictEqual(car.dutyL, 0);
    ctl.send(pkt(80, 80));
    await waitFor(() => !car.failsafe && car.dutyL > 0, 300, 're-arm');
});

test('controller disconnect -> car stops within failsafe window', async () => {
    const car = sim('dc');
    await waitFor(() => car.controlConnected, 2000, 'car connect');
    const ctl = await open('/ws/control', { room: 'dc' });
    ctl.send(pkt(100, 100));
    await waitFor(() => car.dutyL === 255);
    ctl.terminate();
    await waitFor(() => car.failsafe && car.dutyL === 0, 450, 'stop after controller drop');
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

test('static cockpit whitelist', async () => {
    const idx = await get('/');
    assert.strictEqual(idx.status, 200);
    assert.match(idx.body, /fpv-canvas/);
    assert.strictEqual((await get('/app.js')).status, 200);
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
