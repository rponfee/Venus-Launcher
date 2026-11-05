// Marcos de perfil, primera parte: cosmicos, naturaleza, elementos y gemas. Dibujos originales hechos con codigo (ver kit.js).
// Cada receta devuelve el interior del <svg> (viewBox 100): el avatar ocupa el circulo de radio 40 y el marco va afuera.
import { f, pt, P, mix, rnd, an, sty, begin, lin, rg, rgAbs, mask, ring, disc, path, g, ellipse, line, each, put, tr, arcPath, bandPath, poly, spark, ticks, glow, leaf, petal, drop, flame, shard, flower, snowflake } from './kit.js';

// ===================== COSMICOS =====================
export const cosmic = {
  nebula() {
    return [
      glow('#a15cff', 0.5),
      ring(42.8, 5.4, lin(['#4b3fe0', '#b24fe0', '#ff6fb5', '#4aa3ff'], 120)),
      ring(40.4, 0.7, '#ffffff', { opacity: 0.5 }),
      // nubes de polvo estelar que giran despacio
      g(
        each(6, (a, i) => {
          const [x, y] = pt(a + 8, 44 + (i % 2) * 1.2);
          return disc(x, y, 6.6, rg([[0, i % 2 ? '#ff7ad1' : '#8bb4ff', 0.85], [1, '#ffffff', 0]]));
        }),
        an('spin', { t: 70 }),
      ),
      // estrellas que titilan
      each(11, (a, i) => {
        const [x, y] = pt(a + ((i * 13) % 30), 41.5 + ((i * 7) % 8));
        return spark(x, y, i % 3 ? 1.7 : 2.9, '#ffffff', an('tw', { t: 2.6, d: -i * 0.41 }));
      }),
    ].join('');
  },

  comet() {
    return [
      glow('#6aa2ff', 0.28),
      ring(43, 3.8, lin(['#16246b', '#3b5bd9', '#8fc2ff'], 135)),
      ring(40.5, 0.6, '#cfe4ff', { opacity: 0.55 }),
      // la estela y la cabeza del cometa dan vueltas
      g(
        [
          path(arcPath(-80, 0, 45.6), { fill: 'none', stroke: '#8fc2ff', 'stroke-width': 1.2, 'stroke-linecap': 'round', opacity: 0.28 }),
          path(arcPath(-50, 0, 45.6), { fill: 'none', stroke: '#cfe6ff', 'stroke-width': 2.3, 'stroke-linecap': 'round', opacity: 0.5 }),
          path(arcPath(-22, 0, 45.6), { fill: 'none', stroke: '#ffffff', 'stroke-width': 3.3, 'stroke-linecap': 'round', opacity: 0.85 }),
          disc(...pt(0, 45.6), 4.8, rg([[0, '#9fd0ff', 0.55], [1, '#9fd0ff', 0]])),
          disc(...pt(0, 45.6), 2.7, '#ffffff'),
        ],
        an('spin', { t: 5.5 }),
      ),
      each(6, (a, i) => {
        const [x, y] = pt(a + 40, 46 + (i % 2) * 2);
        return spark(x, y, 1.6, '#e3efff', an('tw', { t: 2.8, d: -i * 0.6 }));
      }),
    ].join('');
  },

  rings() {
    const hole = mask(`<rect x="-10" y="-10" width="120" height="120" fill="#fff"/><circle cx="50" cy="50" r="40.4" fill="#000"/>`);
    const orbit = (tilt, stroke, w, bead) =>
      g([ellipse(50, 50, 49.2, 36.5, { fill: 'none', stroke, 'stroke-width': w, transform: `rotate(${tilt} 50 50)` }), `<g transform="rotate(${tilt} 50 50)">${disc(99.2, 50, 2.4, bead)}</g>`]);
    return [
      glow('#ffd9a0', 0.26),
      ring(42.4, 3.6, lin(['#f6e6bd', '#c99a5b', '#7a4f2a'], 135)),
      ring(40.5, 0.6, '#fff1cf', { opacity: 0.5 }),
      g(g([orbit(28, '#f0d9a8', 2.2, '#ffe9b8'), orbit(-28, '#9fb8ff', 1.8, '#d6e2ff')], an('spin', { t: 46 })), { mask: hole }),
    ].join('');
  },

  eclipse() {
    return [
      glow('#ffcf70', 0.42, 42, 50, an('breathe', { t: 5 })),
      ring(43, 6.2, '#0a0514'),
      ring(40.9, 0.8, '#7b4fd6', { opacity: 0.8 }),
      ring(45.9, 0.9, '#ffd27a'),
      // la corona del sol
      g(
        each(18, (a, i) => {
          const [x0, y0] = pt(a, 46.6);
          const [x1, y1] = pt(a, 49.6 - (i % 2) * 1.8);
          return `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" stroke="${i % 2 ? '#ffb347' : '#ffe9b0'}" stroke-width="${i % 2 ? 0.9 : 1.2}" stroke-linecap="round"/>`;
        }),
        an('spin', { t: 90 }),
      ),
      // el destello del anillo de diamante
      ...(() => {
        const [x, y] = pt(-34, 45.9);
        return [disc(x, y, 3.6, rg([[0, '#fff6d6', 0.95], [1, '#ffd27a', 0]])), spark(x, y, 4.6, '#ffffff', an('tw', { t: 3.2 }))];
      })(),
    ].join('');
  },

  constellation() {
    const stars = [[8, 44.2], [47, 46.8], [82, 43.2], [120, 46.2], [154, 44.4], [196, 47.2], [233, 43.4], [270, 46.4], [318, 44.6]];
    const pts = stars.map(([a, r]) => pt(a, r));
    return [
      glow('#6a8cff', 0.3),
      ring(43, 4.6, lin(['#0b1550', '#2a4396', '#0b1550'], 135)),
      ring(40.5, 0.6, '#a9c4ff', { opacity: 0.6 }),
      g(
        [
          path(`${poly(pts)}L${f(pts[0][0])} ${f(pts[0][1])}`, { fill: 'none', stroke: '#b4cbff', 'stroke-width': 0.6, opacity: 0.6, 'stroke-linejoin': 'round' }),
          ...pts.map(([x, y], i) => spark(x, y, i % 3 === 0 ? 3.2 : 2.2, '#ffffff', an('tw', { t: 2.4 + (i % 3) * 0.5, d: -i * 0.53 }))),
          ...pts.map(([x, y]) => disc(x, y, 0.9, '#ffffff')),
        ],
        an('spin', { t: 150 }),
      ),
    ].join('');
  },
};

// ===================== NATURALEZA =====================
export const nature = {
  leaves() {
    return [
      ring(42.4, 3.2, '#5a3d24'),
      ring(40.6, 0.6, '#c9e8a8', { opacity: 0.5 }),
      g(
        [
          each(16, (a, i) => put(a, 42.4, `<g transform="rotate(${i % 2 ? 38 : -38})">${leaf(6 + (i % 3) * 0.7, i % 3 ? '#4fae4a' : '#2f8a3e')}<path d="M0 0L0 -7" stroke="#1d5a2b" stroke-width="0.5" fill="none" opacity="0.7"/></g>`)),
          each(5, (a, i) => {
            const [x, y] = pt(a + 20, 44.5);
            return disc(x, y, 1.4, '#d8362e');
          }),
        ],
        an('sway', { t: 7 }),
      ),
    ].join('');
  },

  vines() {
    const wave = Array.from({ length: 121 }, (_, i) => pt(i * 3, 43.4 + 2.1 * Math.sin((i * 3 * Math.PI * 9) / 180)));
    const flowers = [['#ffffff', '#ffd45e'], ['#ffd1e3', '#ff6f9e'], ['#fff3b0', '#ff9a3d'], ['#ffffff', '#ffd45e'], ['#ffd1e3', '#ff6f9e']];
    return [
      ring(41.6, 2.6, '#2a5a31'),
      ring(40.4, 0.5, '#b6e8b0', { opacity: 0.5 }),
      g(
        [
          path(`${poly(wave)}Z`, { fill: 'none', stroke: '#58b062', 'stroke-width': 1.7, 'stroke-linejoin': 'round' }),
          each(14, (a, i) => put(a + 10, 45.2, `<g transform="rotate(${i % 2 ? 50 : -50})">${leaf(3.8, i % 2 ? '#7fd070' : '#3f9a4c')}</g>`)),
          ...flowers.map(([p, c], i) => {
            const [x, y] = pt(i * 72 + 30, 46.2);
            return flower(x, y, 3.4, p, c, an('tw', { t: 3.4, d: -i * 0.7 }));
          }),
        ],
        an('sway', { t: 9 }),
      ),
    ].join('');
  },

  blossom() {
    return [
      glow('#ffb3d1', 0.3),
      ring(42.8, 3.6, lin(['#ffd9e6', '#ff9cc2', '#ffd9e6'], 90)),
      ring(40.5, 0.6, '#ffffff', { opacity: 0.55 }),
      each(7, (a, i) => {
        const [x, y] = pt(a + 6, 44.4);
        return `<g transform="rotate(${i * 17} ${f(x)} ${f(y)})">${flower(x, y, 3.9 + (i % 3) * 0.5, i % 2 ? '#ffc2d9' : '#ffe3ee', '#ff6f9e')}</g>`;
      }),
      // petalos que caen
      each(6, (a, i) => {
        const [x, y] = pt(a + 32, 47.5);
        return tr(x, y, petal(2.2, '#ffd1e3', { opacity: 0.95 }), an('fall', { t: 5.5, d: -i * 0.95 }));
      }),
    ].join('');
  },

  dandelion() {
    return [
      glow('#fff6c8', 0.42),
      ring(41.4, 1.4, '#cfe0a0'),
      each(24, (a, i) => {
        const r1 = 41.5;
        const r2 = i % 2 ? 45.4 : 47.4;
        const [x0, y0] = pt(a, r1);
        const [x1, y1] = pt(a, r2);
        const [ax, ay] = pt(a - 6, r2 + 1.2);
        const [bx, by] = pt(a + 6, r2 + 1.2);
        return [line(x0, y0, x1, y1, '#fffbe8', 0.5), line(ax, ay, x1, y1, '#fffbe8', 0.35), line(bx, by, x1, y1, '#fffbe8', 0.35), disc(x1, y1, 0.85, '#ffffff')].join('');
      }),
      each(4, (a) => put(a + 45, 42, leaf(4.4, '#7bbf5a'))),
      // semillas que se van con el viento
      each(4, (a, i) => {
        const [x, y] = pt(a + 20, 48);
        return tr(x, y, [line(0, 0, 0, -3, '#fffbe8', 0.5), disc(0, -3, 0.9, '#ffffff')], an('drift', { t: 7, d: -i * 1.7 }));
      }),
    ].join('');
  },

  firefly() {
    const spots = [[12, 43], [50, 47], [86, 41.5], [124, 48], [158, 44], [200, 48.5], [238, 42], [276, 47.5], [320, 44.5]];
    return [
      ring(43, 6.4, lin(['#07180d', '#14402a', '#07180d'], 135)),
      ring(40.5, 0.7, '#4ad78a', { opacity: 0.5 }),
      each(10, (a, i) => put(a + 5, 44.5, `<ellipse rx="3" ry="1.6" cy="0" fill="${i % 2 ? '#1f5a36' : '#2f7a45'}" opacity="0.9"/>`)),
      ...spots.map(([a, r], i) => {
        const [x, y] = pt(a, r);
        return tr(
          x,
          y,
          g([disc(0, 0, 4.4, rg([[0, '#fffbb0', 0.95], [0.35, '#c8ff4d', 0.5], [1, '#c8ff4d', 0]])), disc(0, 0, 1, '#fffde0')], an('pulse', { t: 2.4 + (i % 3) * 0.6, d: -i * 0.5 })),
          an('drift', { t: 8 + (i % 4), d: -i * 1.3 }),
        );
      }),
    ].join('');
  },
};

// ===================== ELEMENTOS =====================
export const elements = {
  flame() {
    const body = lin(['#ff2f0a', '#ff8a1c', '#ffd24a'], 0);
    const core = lin(['#ff9a1a', '#fff08a'], 0);
    return [
      glow('#ff7a1a', 0.55),
      ring(42.2, 4.4, lin(['#5a0f06', '#c8300a', '#ff8a1c'], 90)),
      ring(40.5, 0.6, '#ffd08a', { opacity: 0.6 }),
      each(15, (a, i) => put(a, 42, g([flame(10 + (i % 3) * 2.6, 3.9, body), `<g transform="scale(0.5)">${flame(10 + (i % 3) * 2.6, 3.9, core)}</g>`], an('flk', { t: 1.1 + (i % 4) * 0.18, d: -i * 0.23 })))),
      // brasas que suben
      each(6, (a, i) => {
        const [x, y] = pt(a + 12, 47);
        return tr(x, y, disc(0, 0, 0.9, '#ffd24a'), an('rise', { t: 3, d: -i * 0.5 }));
      }),
    ].join('');
  },

  frost() {
    return [
      glow('#aeeaff', 0.4),
      ring(42.4, 4.6, lin(['#ffffff', '#bdeeff', '#6cc7f0', '#ffffff'], 135)),
      ring(40.4, 0.6, '#ffffff', { opacity: 0.8 }),
      each(12, (a, i) => put(a + 6, 41.6, shard(i % 2 ? 7 : 11.5, i % 2 ? 2 : 2.7, '#e8fbff', '#74c9ee', { stroke: '#ffffff', 'stroke-width': 0.3 }))),
      each(4, (a, i) => {
        const [x, y] = pt(a + 20, 47.2);
        return snowflake(x, y, 2.6, '#ffffff', 0.6, an('tw', { t: 3, d: -i * 0.8 }));
      }),
      g(path(arcPath(-14, 14, 42.4), { fill: 'none', stroke: '#ffffff', 'stroke-width': 3.2, 'stroke-linecap': 'round', opacity: 0.85 }), an('spin', { t: 6 })),
    ].join('');
  },

  tide() {
    const crest = Array.from({ length: 145 }, (_, i) => pt(i * 2.5, 46.2 + 1.7 * Math.sin((i * 2.5 * Math.PI * 14) / 180)));
    return [
      glow('#4fc1ff', 0.3),
      ring(42.8, 4.4, lin(['#0a3d7a', '#1e7fd0', '#5fd0ff'], 90)),
      ring(40.4, 0.6, '#bdf1ff', { opacity: 0.6 }),
      g(path(`${poly(crest)}Z`, { fill: 'none', stroke: '#c8f3ff', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }), an('spin', { t: 40 })),
      ring(44.4, 0.8, '#9be3ff', an('ripple', { t: 3.2 })),
      ring(44.4, 0.8, '#9be3ff', an('ripple', { t: 3.2, d: -1.6 })),
      each(3, (a, i) => {
        const [x, y] = pt(a + 40, 48.6);
        return tr(x, y, drop(1.5, '#d6f6ff'), an('bob', { t: 2.6, d: -i * 0.9 }));
      }),
    ].join('');
  },

  storm() {
    const bolt = '<path d="M0 0L2.6 -3.4L-0.9 -4.8L2.4 -9.6" fill="none"/>';
    return [
      glow('#7fb2ff', 0.34),
      ring(43, 5.8, lin(['#161d38', '#47568f', '#161d38'], 135)),
      ring(40.5, 0.6, '#bfe0ff', { opacity: 0.6 }),
      each(10, (a, i) => {
        const [x, y] = pt(a + 4, 44.6);
        return disc(x, y, 3.4 - (i % 2) * 0.6, i % 2 ? '#6b7bb4' : '#8190c4', { opacity: 0.95 });
      }),
      ring(47, 0.8, '#cfe6ff', { 'stroke-dasharray': '2 3 1 5', ...an('dash', { t: 2.4 }) }),
      ...[18, 108, 200, 292].map((a, i) =>
        put(a, 41.4, g([`<g stroke="#ffe14a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.45">${bolt}</g>`, `<g stroke="#fffbd0" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${bolt}</g>`], an('flash', { t: 3.4 + i * 0.7, d: -i * 1.1 }))),
      ),
    ].join('');
  },

  gale() {
    const swirl = (a0, a1, r, w, op, t, d) => g([path(arcPath(a0, a1, r), { fill: 'none', stroke: '#e9fffb', 'stroke-width': w, 'stroke-linecap': 'round', opacity: op }), disc(...pt(a1, r), w * 0.9, '#ffffff', { opacity: op })], an('spin', { t, d }));
    return [
      glow('#8fe7d4', 0.3),
      ring(42.5, 3.2, lin(['#bdf0e3', '#5cc4b0', '#bdf0e3'], 90)),
      ring(40.4, 0.6, '#ffffff', { opacity: 0.55 }),
      swirl(0, 110, 45.8, 1.8, 0.95, 4.8),
      swirl(140, 220, 47.8, 1.2, 0.75, 7.5, -2),
      swirl(250, 390, 44.2, 1.5, 0.8, 11, -5),
      each(6, (a, i) => {
        const [x, y] = pt(a + 25, 46.5);
        return disc(x, y, 0.7, '#ffffff', an('tw', { t: 2.4, d: -i * 0.4 }));
      }),
    ].join('');
  },
};

// ===================== GEMAS Y CRISTAL =====================
export const gems = {
  ruby() {
    const tones = [lin(['#ff8b98', '#d41c3d'], 90), lin(['#d41c3d', '#8a0f2b'], 90), lin(['#ff5470', '#a8112f'], 90)];
    return [
      glow('#ff3b5c', 0.4),
      ring(43.2, 7.4, '#3a0612'),
      each(16, (a, i) => path(bandPath(a, a + 22.5, 40.6, 46.6), { fill: tones[i % 3], stroke: '#ffd0d6', 'stroke-width': 0.3, 'stroke-linejoin': 'round' })),
      ring(40.4, 0.6, '#ffd0d6', { opacity: 0.8 }),
      g(path(bandPath(-5, 5, 40.6, 46.6), { fill: '#ffffff', opacity: 0.55 }), an('spin', { t: 7 })),
      each(4, (a, i) => {
        const [x, y] = pt(a + 22, 48.4);
        return spark(x, y, 2.4, '#ffffff', an('tw', { t: 3.2, d: -i * 0.8 }));
      }),
    ].join('');
  },

  sapphire() {
    const gem = lin(['#8fbcff', '#1a50d8', '#0a2a80'], 135);
    return [
      glow('#5a8cff', 0.34),
      ring(43.4, 7.6, lin(['#f5f9ff', '#98a8c0', '#eef4fb', '#8393ad'], 135)),
      ring(40.4, 0.6, '#ffffff', { opacity: 0.8 }),
      each(8, (a, i) => put(a, 43.4, g([ellipse(0, 0, 5.1, 3.1, { fill: gem, stroke: '#eaf2ff', 'stroke-width': 0.5 }), ellipse(-1.5, -0.9, 1.7, 0.8, { fill: '#ffffff', opacity: 0.65 })]))),
      each(8, (a, i) => put(a + 22.5, 43.4, path('M0 -1.6L1.2 0L0 1.6L-1.2 0Z', { fill: '#ffffff' }), an('tw', { t: 2.8, d: -i * 0.45 }))),
    ].join('');
  },

  prism() {
    const cols = ['#ff4d6d', '#ff9a3d', '#ffe14a', '#4fe08a', '#38c8ff', '#5a7bff', '#b05cff'];
    return [
      glow('#ffffff', 0.22),
      ring(43.4, 6.6, '#14112a'),
      g(cols.map((c, i) => path(arcPath((i * 360) / 7 + 1, ((i + 1) * 360) / 7 - 1, 43.4), { fill: 'none', stroke: c, 'stroke-width': 5.6 })), an('spin', { t: 26 })),
      ring(46.9, 0.6, '#ffffff', { opacity: 0.6 }),
      ring(40.4, 0.6, '#ffffff', { opacity: 0.7 }),
      g(path(bandPath(-8, 8, 40.6, 46.6), { fill: '#ffffff', opacity: 0.6 }), an('spin', { t: 9, d: -2 })),
      ...[40, 160, 280].map((a, i) => {
        const [x, y] = pt(a, 48.2);
        return tr(x, y, path('M0 -2.4L2.2 1.6H-2.2Z', { fill: '#ffffff', opacity: 0.85 }), an('tw', { t: 3, d: -i * 1 }));
      }),
    ].join('');
  },

  opal() {
    const blob = (c, r, a, rr) => {
      const [x, y] = pt(a, rr);
      return disc(x, y, r, rg([[0, c, 0.95], [1, c, 0]]));
    };
    return [
      glow('#d9c6ff', 0.34),
      ring(43, 6.8, lin(['#b9a4ff', '#8fe3ff', '#ffb7de', '#b6ffd0', '#b9a4ff'], 135)),
      ring(40.4, 0.6, '#ffffff', { opacity: 0.9 }),
      g(['#ff5fb8', '#38d8ff', '#6dffa0', '#ffc94d', '#9a7bff', '#ff7a6a'].map((c, i) => blob(c, 6.2, i * 60, 43)), an('spin', { t: 22 })),
      g(['#4f86ff', '#ff9ad6', '#7dffc4', '#ffe07a'].map((c, i) => blob(c, 4.6, i * 90 + 30, 43.4)), an('spin rev', { t: 31 })),
      path(arcPath(-30, 60, 43), { fill: 'none', stroke: '#ffffff', 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0.45, ...an('pulse', { t: 4 }) }),
      ...[30, 150, 270].map((a, i) => {
        const [x, y] = pt(a, 47.6);
        return spark(x, y, 2.4, '#ffffff', an('tw', { t: 3, d: -i * 1 }));
      }),
    ].join('');
  },
};
