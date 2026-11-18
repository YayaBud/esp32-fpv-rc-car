/*
 * Pixel-art night scene behind the lobby and the cockpit. Drawn in code into a 256x144 canvas and
 * scaled up with `image-rendering: pixelated` (style.css .scene), so it costs one tiny texture.
 * Stars twinkle everywhere; the floor grid scrolls only when the script tag has data-scroll (the
 * lobby), so nothing moves at the edge of view while driving. Reduced motion: drawn once.
 */
(() => {
    const W = 256, H = 144, HZ = 94, CX = W / 2;   // HZ = horizon row
    const scroll = document.currentScript.hasAttribute('data-scroll');
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.className = 'scene';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
    const g = canvas.getContext('2d');

    // Sky, moon and mountains never change: drawn once into their own canvas
    const base = document.createElement('canvas');
    base.width = W;
    base.height = H;
    const b = base.getContext('2d');
    const px = (ctx, x, y, c, w = 1, h = 1) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };

    let seed = 1101;   // fixed seed: the same sky on every load
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

    // Sky: hard colour bands, checker-dithered where two meet
    const SKY = [[0, '#0b0a26'], [34, '#0f0d33'], [54, '#141243'], [68, '#1a1755'], [79, '#221e69'], [87, '#2b2680'], [HZ]];
    for (let i = 0; i < SKY.length - 1; i++) {
        const [y0, c] = SKY[i];
        px(b, 0, y0, c, W, SKY[i + 1][0] - y0);
        if (i > 0) for (let x = y0 & 1; x < W; x += 2) px(b, x, y0 - 1, c);
    }

    // Moon: pixel disc shaded lower right, light streaks across it, dithered halo
    const MX = CX, MY = 34, MR = 17;
    for (let y = -MR - 3; y < MR + 3; y++) {
        for (let x = -MR - 3; x < MR + 3; x++) {
            const d = Math.hypot(x + 0.5, y + 0.5);
            if (d <= MR) px(b, MX + x, MY + y, d > MR - 1.3 ? '#6aa6e6' : x + y > MR * 0.8 ? '#79bdee' : '#8ed2f8');
            else if (d <= MR + 3 && (x + y) & 1) px(b, MX + x, MY + y, '#1c2268');
        }
    }
    for (const [y, x, w] of [[-11, -9, 12], [-6, -14, 9], [-5, 2, 8], [1, -12, 18], [6, -6, 11], [7, 7, 5], [11, -8, 8]]) {
        px(b, MX + x, MY + y, '#dff6ff', w);
    }

    // Moonlight on the water between the two ranges (even widths keep it on whole pixels)
    for (const [dy, w] of [[2, 22], [4, 14], [6, 10], [8, 6]]) px(b, CX - w / 2, HZ - dy, dy < 5 ? '#6aa6e6' : '#4152b8', w);

    // Mountains: triangular peaks [x, height, slope] plus a random wobble on the ridge line
    const PEAKS = [[16, 54, 0.95], [58, 36, 0.8], [92, 18, 0.7], [166, 20, 0.75], [196, 38, 0.85], [240, 50, 0.9]];
    const top = new Array(W), litCol = new Array(W);
    let wob = 0;
    for (let x = 0; x < W; x++) {
        wob = Math.max(-3, Math.min(3, wob + Math.round((rnd() - 0.5) * 2.4)));
        let h = 0, peakX = 0;
        for (const [x0, ph, slope] of PEAKS) {
            const v = ph - Math.abs(x - x0) * slope;
            if (v > h) { h = v; peakX = x0; }
        }
        top[x] = h > 0 ? Math.min(HZ, HZ - Math.round(h + wob)) : HZ;
        // The side of its peak that faces the middle faces the moon and catches the light
        litCol[x] = peakX < CX ? x >= peakX : x <= peakX;
    }
    for (let x = 0; x < W; x++) {
        const y0 = top[x];
        if (y0 >= HZ) continue;
        const lit = litCol[x];
        for (let y = y0; y < HZ; y++) {
            const k = y - y0;
            let c = k < 2 ? (lit ? '#f06bb0' : '#8a2a7a')
                  : k < 9 ? (lit ? '#b8357f' : '#4a1660')
                  : (lit ? '#6e1d68' : '#2e0f48');
            if (k === 9 && (x + y) & 1) c = lit ? '#b8357f' : '#4a1660';   // dither the band edge
            if (y >= HZ - 3) c = '#1f0b38';
            px(b, x, y, c);
        }
    }

    // Stars only in open sky: not behind the mountains or the moon
    const stars = [];
    for (let i = 0; i < 70; i++) {
        const x = Math.floor(rnd() * W), y = Math.floor(rnd() * (HZ - 14));
        if (y >= top[x] - 3 || Math.hypot(x - MX, y - MY) < MR + 6) continue;
        stars.push({ x, y, big: rnd() < 0.12, tw: rnd() < 0.4, c: rnd() < 0.65 ? '#6f7cf0' : '#dfe8ff' });
    }

    // Floor: perspective grid on a glossy blue plane, brighter toward the viewer
    const shade = (y, far, mid, near) => { const d = (y - HZ) / (H - HZ); return d < 0.2 ? far : d < 0.5 ? mid : near; };
    function drawFloor(phase) {
        for (let y = HZ; y < H; y++) {
            px(g, 0, y, shade(y, '#11154c', '#151d64', '#1a2880'), W);
            const w = Math.round(3 + (y - HZ) * 0.45);   // moon reflection down the middle
            px(g, CX - w, y, shade(y, '#151d64', '#1b2a7c', '#22389a'), w * 2);
        }
        // Near the horizon the lines would be denser than the pixels: a glow band instead
        px(g, 0, HZ + 1, '#2a3aa8', W);
        for (let y = HZ + 8; y < H; y++) {
            // the outer lines run nearly flat out here, so they stay dim until well into the near half
            const d = (y - HZ) / (H - HZ);
            const c = d < 0.35 ? '#25308a' : d < 0.6 ? '#4f7ee0' : '#8fe3ff', thick = y - HZ > 30 ? 2 : 1;
            for (let i = -16; i <= 16; i++) {
                // span to where the line is on the next row, so shallow lines don't break into dots
                const xa = Math.round(CX + i * 0.62 * (y - HZ)), xb = Math.round(CX + i * 0.62 * (y + 1 - HZ));
                px(g, Math.min(xa, xb), y, c, Math.max(thick, Math.abs(xb - xa)));
            }
        }
        for (let j = 0; j < 40; j++) {
            const y = Math.round(HZ + 44 / (j + 1 - phase));
            if (y >= H) continue;
            if (y - HZ < 5) break;
            px(g, 0, y, shade(y, '#3346b8', '#4f7ee0', '#8fe3ff'), W, y > H - 16 ? 2 : 1);
        }
        px(g, 0, HZ, '#8fe3ff', W);
    }

    let tick = 0, phase = 0;
    function draw() {
        g.drawImage(base, 0, 0);
        const beat = Math.floor(tick / 6);
        for (const s of stars) {
            if (s.tw && (beat + s.x) % 4 === 0) continue;   // twinklers go dark one beat in four
            px(g, s.x, s.y, s.c);
            if (s.big) {
                px(g, s.x - 1, s.y, '#4b56c8');
                px(g, s.x + 1, s.y, '#4b56c8');
                px(g, s.x, s.y - 1, '#4b56c8');
                px(g, s.x, s.y + 1, '#4b56c8');
            }
        }
        drawFloor(phase);
    }

    draw();
    if (still) return;
    setInterval(() => {
        tick++;
        if (scroll) phase = (phase + 0.05) % 1;
        if (scroll || tick % 6 === 0) draw();
    }, 100);
})();
