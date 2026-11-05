// Marcos de perfil, segunda parte: retro y pixel, neon y tecnologia, estacionales y fantasia. Dibujos originales hechos con
// codigo (ver kit.js). Cada receta devuelve el interior del <svg> (viewBox 100).
import { f, pt, P, mix, rnd, an, sty, lin, rg, mask, ring, disc, path, rect, g, ellipse, line, each, put, tr, arcPath, bandPath, poly, spark, ticks, glow, leaf, flame, heart, snowflake, bat, feather, star5, shard } from './kit.js';

// ===================== RETRO Y PIXEL =====================
export const retro = {
  bits() {
    // Anillo de cuadraditos de 3 en 3, en damero de dos colores; algunos se prenden y apagan
    const cells = [];
    for (let i = 0; i < 33; i++) {
      for (let j = 0; j < 33; j++) {
        const x = 2 + i * 3;
        const y = 2 + j * 3;
        const d = Math.hypot(x - 50, y - 50);
        if (d >= 42 && d <= 47.4) cells.push([x, y, (i + j) % 2, (i * 7 + j * 13) % 9 === 0]);
      }
    }
    return g(
      cells.map(([x, y, odd, lit], i) => rect(x - 1.5, y - 1.5, 3.05, 3.05, lit ? '#ffffff' : odd ? '#ffcf33' : '#f26b1d', lit ? an('blink', { t: 1.8, d: -(i % 7) * 0.25 }) : undefined)),
      { 'shape-rendering': 'crispEdges' },
    );
  },

  coins() {
    const map = ['00111100', '01222210', '12233221', '12322221', '12222221', '12222221', '01222210', '00111100'];
    const cols = { 1: '#a86a00', 2: '#ffcf33', 3: '#fff6b0' };
    const u = 1.05;
    const coin = g(
      map.flatMap((row, y) => [...row].map((c, x) => (c === '0' ? '' : rect((x - 4) * u, (y - 4) * u, u + 0.05, u + 0.05, cols[c])))),
      { 'shape-rendering': 'crispEdges' },
    );
    return [
      glow('#ffcf33', 0.18),
      ring(42.4, 3.4, '#5a3600', { 'stroke-dasharray': '3 3', 'shape-rendering': 'crispEdges' }),
      ring(42.4, 1.1, '#ffcf33', { 'stroke-dasharray': '3 3', 'shape-rendering': 'crispEdges' }),
      each(6, (a, i) => {
        const [x, y] = pt(a + 12, 44.8);
        return tr(x, y, g(coin, an('coin', { t: 2.4, d: -i * 0.4 })));
      }),
    ].join('');
  },

  arcade() {
    const cols = ['#ff3b8d', '#2ee6ff', '#ffe14a'];
    const row = (n, r, size, salt) =>
      each(n, (a, i) => put(a, r, rect(-size / 2, -size / 2, size, size, cols[i % 3], an('chase', { t: 1.2, d: -(i / n) * 1.2 * salt }))));
    return [
      ring(44.2, 9, '#150f2a'),
      ring(39.8, 0.8, '#7a3cff'),
      ring(48.4, 0.8, '#7a3cff'),
      g([row(28, 42, 2.3, 1), row(32, 46.1, 2.3, 1)], { 'shape-rendering': 'crispEdges' }),
    ].join('');
  },

  glitch() {
    const layer = (stroke, dx, dash, off, w, extra) => g(g(ring(43, w, stroke, { 'stroke-dasharray': dash, 'stroke-dashoffset': off }), extra), { transform: `translate(${dx} 0)` });
    const bars = [20, 78, 132, 204, 252, 322]
      .map((a, i) => {
        const [x, y] = pt(a, 47 + (i % 2) * 1.6);
        return rect(x - 3.5, y - 0.8, 7 - (i % 3), 1.6, i % 2 ? '#19f0ff' : '#ff2bd6', an('glitchbar', { t: 3.1, d: -i * 0.6 }));
      })
      .join('');
    return [
      ring(40.5, 0.6, '#ffffff', { opacity: 0.6 }),
      layer('#19f0ff', -1.4, '72 6 30 4 62 8 40 5 36 7', 0, 3.6, an('glitch', { t: 3.4 })),
      layer('#ff2bd6', 1.4, '58 8 44 5 70 6 34 9 28 7', 20, 3.6, an('glitch', { t: 3.4, d: -1.1 })),
      ring(43, 1.3, '#ffffff', { 'stroke-dasharray': '90 10 60 12 80 18' }),
      bars,
    ].join('');
  },
};

// ===================== NEON Y TECNOLOGIA =====================
export const neon = {
  synth() {
    return [
      glow('#ff3fa4', 0.4, 40, 50, an('pulse', { t: 3.4 })),
      glow('#34f0ff', 0.18),
      ring(43, 3.6, lin(['#ff3fa4', '#ff9a3d', '#7a3cff'], 90)),
      ring(40.8, 0.9, '#34f0ff'),
      path(arcPath(118, 242, 45.9), { fill: 'none', stroke: '#ff9a3d', 'stroke-width': 1.2, 'stroke-linecap': 'round' }),
      path(arcPath(134, 226, 47.5), { fill: 'none', stroke: '#ff5ec4', 'stroke-width': 1.1, 'stroke-linecap': 'round' }),
      path(arcPath(150, 210, 49), { fill: 'none', stroke: '#9a5cff', 'stroke-width': 1, 'stroke-linecap': 'round' }),
      each(4, (a, i) => {
        const [x, y] = pt(a + 45, 46.2);
        return spark(x, y, 2.2, '#34f0ff', an('tw', { t: 2.6, d: -i * 0.65 }));
      }),
    ].join('');
  },

  circuit() {
    const traces = each(12, (a, i) => {
      const bend = i % 2 ? 5 : -5;
      return [path(`M${P(a, 45.2)}L${P(a, 47.1)}L${P(a + bend, 49.3)}`, { fill: 'none', stroke: '#37f2c0', 'stroke-width': 0.8, 'stroke-linejoin': 'round' }), disc(...pt(a + bend, 49.3), 1, '#37f2c0')].join('');
    });
    const chip = (a) => put(a, 45.4, [rect(-3.4, -1.7, 6.8, 3.4, '#0a2a26', { stroke: '#37f2c0', 'stroke-width': 0.6 }), line(-2, 1.7, -2, 3, '#37f2c0', 0.6), line(0, 1.7, 0, 3, '#37f2c0', 0.6), line(2, 1.7, 2, 3, '#37f2c0', 0.6)]);
    return [
      glow('#37f2c0', 0.22),
      ring(43, 5.4, '#06201f'),
      ring(40.8, 0.8, '#37f2c0'),
      ring(43, 0.9, '#37f2c0', { 'stroke-dasharray': '6 10', opacity: 0.9, ...an('dash', { t: 3.6 }) }),
      traces,
      [0, 90, 180, 270].map((a) => chip(a + 45)).join(''),
    ].join('');
  },

  hologram() {
    const slices = Array.from({ length: 8 }, (_, i) => path(bandPath(-40 + i * 5, -35 + i * 5, 40.6, 46.4), { fill: '#7ff6ff', opacity: f(0.06 + i * 0.11) })).join('');
    const hex = (a) => put(a, 48.2, path('M0 -1.9L1.7 -0.95V0.95L0 1.9L-1.7 0.95V-0.95Z', { fill: 'none', stroke: '#7ff6ff', 'stroke-width': 0.5 }));
    return g(
      [
        glow('#59f0ff', 0.34),
        ring(43, 5.4, '#59f0ff', { opacity: 0.42 }),
        g(ring(48.7, 0.6, '#7ff6ff', { 'stroke-dasharray': '1 3' }), an('spin', { t: 22 })),
        ring(40.6, 0.8, '#9ffaff'),
        ring(45.8, 0.8, '#9ffaff'),
        ticks(60, 46.6, 47.6, 0.5, '#7ff6ff', { opacity: 0.85 }, 5, 49),
        g(slices, an('spin', { t: 3.6 })),
        [20, 80, 140, 200, 260, 320].map((a, i) => g(hex(a), an('blink', { t: 2.2, d: -i * 0.4 }))).join(''),
      ],
      an('pulse', { t: 2.8 }),
    );
  },

  radar() {
    const slices = Array.from({ length: 9 }, (_, i) => path(bandPath(-44 + i * 5, -39 + i * 5, 40.8, 46.2), { fill: '#37ff6b', opacity: f(0.05 + i * 0.1) })).join('');
    return [
      glow('#37ff6b', 0.2),
      ring(43.5, 5.8, '#041a0c'),
      ring(40.8, 0.8, '#37ff6b', { opacity: 0.8 }),
      ring(46.3, 0.8, '#37ff6b', { opacity: 0.6 }),
      ticks(36, 41.4, 43, 0.5, '#37ff6b', { opacity: 0.7 }),
      g([slices, line(...pt(0, 40.8), ...pt(0, 46.2), '#d6ffe0', 1.1)], an('spin', { t: 4.5 })),
      [[30, 43.6], [118, 45], [205, 42.8], [290, 44.6]].map(([a, r], i) => disc(...pt(a, r), 1.1, '#b8ffc9', an('blink', { t: 4.5, d: -i * 1.1 }))).join(''),
    ].join('');
  },

  equalizer() {
    const n = 36;
    return [
      glow('#ff4fd8', 0.2),
      ring(41.2, 1.2, '#ff5ec4', { opacity: 0.9 }),
      each(n, (a, i) => {
        const t = Math.abs(i / n - 0.5) * 2; // 0 arriba, 1 abajo
        const h = 3.2 + rnd(i, 3) * 4.6;
        return put(a, 41.8, rect(-0.95, -h, 1.9, h, mix('#27f0ff', '#ff4fd8', t), { rx: 0.9, ...an('eq', { t: 0.9 + rnd(i, 7) * 0.9, d: -rnd(i, 9) * 1.6 }) }));
      }),
    ].join('');
  },
};

// ===================== ESTACIONALES =====================
export const seasonal = {
  cupid() {
    const cols = ['#ff3d78', '#ff7fa8', '#ffd0df', '#ff3d78', '#ff7fa8'];
    return [
      glow('#ff6fa0', 0.34),
      ring(42.8, 4.4, lin(['#ff8fb6', '#ff4f8b', '#ffb0cc'], 90)),
      ring(40.5, 0.6, '#ffffff', { opacity: 0.6 }),
      each(9, (a, i) => {
        const [x, y] = pt(a + 8, 45.4 + (i % 3) * 0.9);
        return tr(x, y, heart(2.5 + (i % 3) * 0.9, cols[i % 5], { stroke: '#ffffff', 'stroke-width': 0.3 }), an('beat', { t: 1.8, d: -i * 0.3 }));
      }),
      each(5, (a, i) => {
        const [x, y] = pt(a + 30, 48.6);
        return spark(x, y, 1.6, '#ffffff', an('tw', { t: 2.6, d: -i * 0.5 }));
      }),
    ].join('');
  },

  spooky() {
    const moonAt = pt(42, 45.6);
    const crescent = mask(`<rect x="-10" y="-10" width="120" height="120" fill="#fff"/>${disc(moonAt[0] + 2, moonAt[1] - 1.2, 3.6, '#000')}`);
    const pumpkin = tr(50, 92.2, [
      ellipse(-3.2, 0, 3.7, 4.8, { fill: '#e8710a', stroke: '#8a3a00', 'stroke-width': 0.3 }),
      ellipse(3.2, 0, 3.7, 4.8, { fill: '#e8710a', stroke: '#8a3a00', 'stroke-width': 0.3 }),
      ellipse(0, 0, 3.6, 5.2, { fill: '#ff8a1f', stroke: '#8a3a00', 'stroke-width': 0.3 }),
      path('M-0.9 -5.2L-0.3 -7.8L1.6 -7.5L0.9 -5.1Z', { fill: '#2f8f3a' }),
      path('M-3.5 -1.2L-1.6 -1.2L-2.55 -3.1Z M1.6 -1.2L3.5 -1.2L2.55 -3.1Z', { fill: '#ffe08a' }),
      path('M-3 1.5L-1.6 2.8L-0.6 1.7L0.6 2.8L1.6 1.7L3 1.5L2.4 3.3L0 4.1L-2.4 3.3Z', { fill: '#ffe08a' }),
    ]);
    const flyer = (a, t, d) =>
      g(tr(...pt(a, 46.6), g(bat(3.1, '#24123f'), { stroke: '#c9a8ff', 'stroke-width': 0.35, ...an('cspin', { t }) })), an('spin', { t, d }));
    return [
      glow('#ff8a1f', 0.28),
      ring(43, 5, lin(['#2a0f45', '#6a2fa8', '#2a0f45'], 135)),
      ring(40.7, 0.8, '#ff8a1f', { opacity: 0.95 }),
      ring(45.5, 0.5, '#b47cff', { opacity: 0.6 }),
      disc(moonAt[0], moonAt[1], 4, '#ffe9a8', { mask: crescent }),
      pumpkin,
      flyer(300, 18, 0),
      flyer(60, 18, -6),
      flyer(180, 18, -12),
      each(5, (a, i) => spark(...pt(a + 70, 47.8), 1.2, '#ffe9a8', an('tw', { t: 2.8, d: -i * 0.6 }))),
    ].join('');
  },

  garland() {
    const bulbs = ['#ff3b3b', '#ffd23f', '#3bb0ff', '#58e07a'];
    const bow = tr(50, 92.6, [
      path('M0 0C-3 -4.8 -8.2 -3.2 -7 0.8C-6.3 3.2 -2.6 2.6 0 0Z', { fill: '#d32f2f', stroke: '#8a1414', 'stroke-width': 0.3 }),
      path('M0 0C3 -4.8 8.2 -3.2 7 0.8C6.3 3.2 2.6 2.6 0 0Z', { fill: '#d32f2f', stroke: '#8a1414', 'stroke-width': 0.3 }),
      path('M-0.7 0.6L-3.2 5.6L-1.3 4.9L-0.4 6.4L0.7 0.6Z', { fill: '#b71c1c' }),
      path('M0.7 0.6L3.2 5.6L1.3 4.9L0.4 6.4L-0.7 0.6Z', { fill: '#b71c1c' }),
      ellipse(0, 0.2, 1.5, 1.3, { fill: '#ff6b6b' }),
    ]);
    return [
      ring(42.3, 3.8, '#1f6b34'),
      each(44, (a, i) => put(a, 41.2, path(`M0 0L${i % 2 ? 1.8 : -1.8} -5.4`, { fill: 'none', stroke: i % 3 ? '#2e9a4a' : '#145a2b', 'stroke-width': 1.1, 'stroke-linecap': 'round' }))),
      ring(40.6, 0.5, '#d4f5d9', { opacity: 0.5 }),
      each(12, (a, i) => {
        const [x, y] = pt(a + 8, 45.2 + (i % 2) * 1.6);
        return [disc(x, y, 3.3, rg([[0, bulbs[i % 4], 0.6], [1, bulbs[i % 4], 0]])), disc(x, y, 1.45, bulbs[i % 4], an('bulb', { t: 1.8, d: -i * 0.3 }))].join('');
      }),
      each(5, (a) => disc(...pt(a + 24, 43.6), 1.3, '#d32f2f')),
      each(4, (a, i) => snowflake(...pt(a + 40, 48.6), 1.9, '#ffffff', 0.5, an('tw', { t: 3, d: -i * 0.8 }))),
      bow,
    ].join('');
  },

  fireworks() {
    const burst = (a, color, d) => {
      const [x, y] = pt(a, 46.4);
      return tr(
        x,
        y,
        g(
          [
            each(10, (b) => `<g transform="rotate(${f(b)})">${line(0, -2, 0, -6, color, 1)}${disc(0, -6.9, 0.9, color)}</g>`),
            disc(0, 0, 1.1, '#ffffff'),
          ],
          an('burst', { t: 3.2, d }),
        ),
      );
    };
    return [
      glow('#5a7bff', 0.28),
      ring(43, 4.6, lin(['#101a5a', '#3a55c8', '#101a5a'], 135)),
      ring(40.7, 0.8, '#ffd27a'),
      burst(22, '#ffd23f', 0),
      burst(142, '#ff6fb0', -1.1),
      burst(262, '#4fe3ff', -2.2),
      each(7, (a, i) => spark(...pt(a + 70, 44.6), 1.4, '#ffe9a8', an('tw', { t: 2.4, d: -i * 0.5 }))),
    ].join('');
  },
};

// ===================== FANTASIA =====================
const RUNES = [
  'M0 -3V3M0 -2L2 -0.6M0 -0.2L2 1.2',
  'M-1.4 -3V3M-1.4 -3L1.6 -1L-1.4 1',
  'M-1.5 -3V3M1.5 -3V3M-1.5 -0.5L1.5 0.5',
  'M0 -3V3M-1.8 -1.6L0 0L1.8 -1.6',
  'M-1.6 -3L0 0L-1.6 3M1.6 -3L0 0L1.6 3',
  'M0 -3V3M0 -3L1.8 -1.2L0 0.6',
  'M-1.8 3L0 -3L1.8 3M-1 1H1',
  'M-1.6 -3L1.6 3M1.6 -3L-1.6 3M0 -3V3',
  'M0 -3L2 0L0 3L-2 0Z',
  'M-1.4 -3V3M-1.4 -0.8L1.6 -3M-1.4 0.6L1.6 3',
  'M-1.6 3L1.6 -3M-1.6 -3L0 -0.2',
  'M0 -3V3M-1.6 -1L1.6 1',
];

export const fantasy = {
  runes() {
    return [
      glow('#8f7bff', 0.3),
      ring(43, 6.8, lin(['#1d1a3a', '#4b4585', '#1d1a3a'], 135)),
      ring(40.6, 0.7, '#7f6bff'),
      ring(45.8, 0.7, '#7f6bff', { opacity: 0.8 }),
      g(
        each(12, (a, i) =>
          put(
            a,
            43.2,
            g(
              [
                path(RUNES[i], { fill: 'none', stroke: '#a99bff', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.5 }),
                path(RUNES[i], { fill: 'none', stroke: '#f1eeff', 'stroke-width': 1.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
              ],
              an('pulse', { t: 3.6, d: -i * 0.3 }),
            ),
          ),
        ),
        an('spin', { t: 90 }),
      ),
    ].join('');
  },

  dragon() {
    const tile = lin(['#3a0709', '#8f1a14', '#e0472a'], 0);
    const horn = lin(['#fff4dc', '#bfa57a'], 90);
    const hornPath = 'M-2.3 0C-2.8 -5 -1.2 -9.4 2.8 -13C1.5 -8.6 1.4 -4.2 2.3 0Z';
    // Escama: base plana y punta redondeada hacia afuera
    const scaleD = 'M-3.7 0V-3Q-3.7 -6.9 0 -7.3Q3.7 -6.9 3.7 -3V0Z';
    const scale = (a, r) => put(a, r, path(scaleD, { fill: tile, stroke: '#240305', 'stroke-width': 0.45, 'stroke-linejoin': 'round' }));
    const shine = (a, r) => put(a, r, path('M-2.6 -3.2Q-2.4 -5.6 0 -6', { fill: 'none', stroke: '#ffb27a', 'stroke-width': 0.4, 'stroke-linecap': 'round' }));
    return [
      glow('#ff4a1a', 0.36, 40, 50, an('breathe', { t: 4.6 })),
      ring(44.4, 7, '#240305'),
      // dos hileras de escamas como cota: la de adentro tapa la base de la de afuera
      each(36, (a) => scale(a + 5, 43.2)),
      each(36, (a) => scale(a, 40.2)),
      each(36, (a) => shine(a, 40.2)),
      put(-20, 45.6, path(hornPath, { fill: horn, stroke: '#7a6644', 'stroke-width': 0.4 })),
      put(20, 45.6, `<g transform="scale(-1 1)">${path(hornPath, { fill: horn, stroke: '#7a6644', 'stroke-width': 0.4 })}</g>`),
      each(6, (a, i) => tr(...pt(a + 20, 48.6), disc(0, 0, 0.9, '#ffb347'), an('rise', { t: 3.2, d: -i * 0.55 }))),
    ].join('');
  },

  phoenix() {
    const body = lin(['#e0301a', '#ff8a1c', '#ffe872'], 0);
    // Un ala: plumas en abanico (dir 1 = derecha; -1 = izquierda, espejada)
    const wing = (dir) =>
      each(9, (_, i) => {
        const k = (i - 4) * 8.4;
        const len = 11.2 - Math.abs(i - 4) * 0.55;
        return put(dir === 1 ? 90 + k : 270 - k, 41, `<g transform="rotate(${-dir * 22})">${feather(len, 2.6, body, { stroke: '#7a1d0a', 'stroke-width': 0.25 })}</g>`);
      });
    return [
      glow('#ff7a1a', 0.5, 40, 50, an('breathe', { t: 3.6 })),
      g(wing(1), an('flap', { t: 3.4 })),
      g(wing(-1), an('flap', { t: 3.4, d: -1.7 })),
      ring(42, 3.2, lin(['#ffd23f', '#ff7a1a', '#ffd23f'], 90)),
      ring(40.4, 0.6, '#fff1b0', { opacity: 0.8 }),
      [-16, 0, 16].map((a, i) => put(a, 42, g([flame(i === 1 ? 11 : 8, 3, lin(['#ff3b0a', '#ffb02a', '#fff08a'], 0))], an('flk', { t: 1.2, d: -i * 0.4 })))).join(''),
      each(6, (a, i) => tr(...pt(a + 150, 48), disc(0, 0, 0.9, '#ffd24a'), an('rise', { t: 3.2, d: -i * 0.55 }))),
    ].join('');
  },

  wings() {
    const white = lin(['#ffffff', '#cfdcf2'], 0);
    const feathers = (dir, count, step, len, w, tilt, r) =>
      each(count, (_, i) => {
        const k = (i - (count - 1) / 2) * step;
        return put(dir === 1 ? 90 + k : 270 - k, r, `<g transform="rotate(${-dir * tilt})">${feather(len, w, white, { stroke: '#a9bddd', 'stroke-width': 0.3 })}</g>`);
      });
    const wing = (dir) => [feathers(dir, 8, 9.2, 11.4, 2.9, 24, 41), feathers(dir, 7, 10.4, 8.6, 2.6, 12, 41), feathers(dir, 6, 11.2, 5.6, 2.3, 0, 41.4)];
    return [
      glow('#fff0b0', 0.4, 40, 50, an('breathe', { t: 4 })),
      g(wing(1), an('flap', { t: 4.2 })),
      g(wing(-1), an('flap', { t: 4.2, d: -2.1 })),
      ring(42.4, 3, lin(['#fff7d6', '#ffd97a', '#fff7d6'], 90)),
      ring(40.4, 0.6, '#ffffff', { opacity: 0.8 }),
      ellipse(50, 5.2, 6.6, 1.9, { fill: 'none', stroke: '#ffd97a', 'stroke-width': 1.4, ...an('pulse', { t: 3 }) }),
      each(5, (a, i) => spark(...pt(a + 160, 49), 1.7, '#ffffff', an('tw', { t: 2.8, d: -i * 0.55 }))),
    ].join('');
  },

};
