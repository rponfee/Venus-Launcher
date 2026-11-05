// Marcos del Venus Pass (pass1 a pass8): ocho escalones de rareza creciente, de un anillo de bronce a la estrella de Venus.
// Dibujos originales hechos con codigo (ver kit.js). Se ganan jugando; no se venden.
import { f, pt, an, lin, rg, mask, ring, disc, path, g, ellipse, line, each, put, tr, arcPath, bandPath, poly, spark, star5, ticks, glow, leaf, shard } from './kit.js';

const gold = ['#fff1a8', '#f0b429', '#9a6212', '#ffd27a'];

export const pass = {
  // 1 · Bronce: anillo sencillo con remaches y un brillo que lo recorre
  pass1() {
    return [
      ring(43, 6, lin(['#f3c08a', '#b8733a', '#7a4420', '#d6955a'], 135)),
      ring(40.5, 0.7, '#ffd9b0', { opacity: 0.7 }),
      ring(46, 0.6, '#5a3014', { opacity: 0.8 }),
      each(4, (a) => put(a + 45, 43, disc(0, 0, 1.7, rg([[0, '#fff0d6'], [1, '#a8622a']]), { stroke: '#5a3014', 'stroke-width': 0.3 }))),
      g(path(bandPath(-7, 7, 40.6, 46.4), { fill: '#ffffff', opacity: 0.5 }), an('spin', { t: 9 })),
    ].join('');
  },

  // 2 · Plata: grabado fino y una chispa en orbita
  pass2() {
    return [
      glow('#cfe0ff', 0.26),
      ring(43, 6, lin(['#ffffff', '#98a4b8', '#eef2f8', '#7d889c'], 135)),
      ring(40.5, 0.7, '#ffffff', { opacity: 0.8 }),
      ticks(36, 41.2, 43.4, 0.55, '#5d6a80', { opacity: 0.8 }),
      ring(46.1, 0.6, '#5d6a80', { opacity: 0.7 }),
      g([disc(...pt(0, 47.2), 4, rg([[0, '#ffffff', 0.8], [1, '#ffffff', 0]])), spark(...pt(0, 47.2), 3.2, '#ffffff')], an('spin', { t: 6 })),
    ].join('');
  },

  // 3 · Oro: anillo dorado con laureles y una gema arriba
  pass3() {
    const branch = (dir) =>
      each(7, (_, i) => {
        const a = dir * (92 + i * 13);
        return put(a, 45.6, `<g transform="rotate(${dir * -62})">${leaf(6.2, lin(['#fff1a8', '#d99a1a'], 45), { stroke: '#8a5a12', 'stroke-width': 0.28 })}</g>`);
      });
    return [
      glow('#ffcf5a', 0.42),
      ring(42.6, 6.6, lin(gold, 135)),
      ring(40.4, 0.7, '#fff7d6', { opacity: 0.9 }),
      branch(1),
      branch(-1),
      ...(() => {
        const [x, y] = pt(0, 46.4);
        return [tr(x, y, path('M0 -3.2L2.6 0L0 3.2L-2.6 0Z', { fill: lin(['#ffffff', '#7fdcf0', '#2a8fd0'], 135), stroke: '#fff7d6', 'stroke-width': 0.4 })), spark(x, y, 4.4, '#ffffff', an('tw', { t: 3 }))];
      })(),
      g(path(bandPath(-6, 6, 40.6, 46), { fill: '#ffffff', opacity: 0.45 }), an('spin', { t: 8 })),
    ].join('');
  },

  // 4 · Platino: facetas frias y un anillo punteado que gira
  pass4() {
    const tones = [lin(['#f4feff', '#7fd6e6'], 90), lin(['#7fd6e6', '#2f7f98'], 90), lin(['#c8f4ff', '#3b8fa8'], 90)];
    return [
      glow('#9ff0ff', 0.36),
      ring(43.4, 7.2, '#12363f'),
      each(14, (a, i) => path(bandPath(a, a + 360 / 14, 40.6, 46.8), { fill: tones[i % 3], stroke: '#e8fbff', 'stroke-width': 0.3, 'stroke-linejoin': 'round' })),
      ring(40.4, 0.7, '#ffffff', { opacity: 0.85 }),
      g(ring(48.6, 0.9, '#e8fbff', { 'stroke-dasharray': '3 5', 'stroke-linecap': 'round' }), an('spin', { t: 30 })),
      each(6, (a, i) => spark(...pt(a + 12, 48.2), 2.1, '#ffffff', an('tw', { t: 2.8, d: -i * 0.5 }))),
      g(path(bandPath(-6, 6, 40.6, 46.8), { fill: '#ffffff', opacity: 0.55 }), an('spin', { t: 7 })),
    ].join('');
  },

  // 5 · Amatista estelar: cristales violetas y dos particulas en orbita
  pass5() {
    return [
      glow('#b46bff', 0.46),
      ring(42.6, 5, lin(['#e8d0ff', '#9b4fe0', '#4a1a8a'], 135)),
      ring(40.4, 0.7, '#f3e6ff', { opacity: 0.85 }),
      each(7, (a, i) => put(a + 8, 42.2, shard(i % 2 ? 7.6 : 10.4, 2.5, '#efdcff', '#8f4fd8', { stroke: '#ffffff', 'stroke-width': 0.28 }))),
      each(6, (a, i) => spark(...pt(a + 30, 48.4), 1.9, '#ffffff', an('tw', { t: 3, d: -i * 0.55 }))),
      g([disc(...pt(0, 47.4), 1.5, '#ffffff'), disc(...pt(180, 47.4), 1.5, '#ffffff'), path(arcPath(-34, 0, 47.4), { fill: 'none', stroke: '#e3c9ff', 'stroke-width': 1, 'stroke-linecap': 'round', opacity: 0.7 }), path(arcPath(146, 180, 47.4), { fill: 'none', stroke: '#e3c9ff', 'stroke-width': 1, 'stroke-linecap': 'round', opacity: 0.7 })], an('spin', { t: 8 })),
    ].join('');
  },

  // 6 · Corona carmesi: rubies, filo de oro y una corona arriba
  pass6() {
    const crown = tr(
      50,
      9.6,
      g(
        [
          path('M-8.4 3.2L8.4 3.2L9.8 -3L5.2 0.2L2.6 -5.6L0 0.4L-2.6 -5.6L-5.2 0.2L-9.8 -3Z', { fill: lin(gold, 90), stroke: '#8a5a12', 'stroke-width': 0.4, 'stroke-linejoin': 'round' }),
          disc(-9.8, -3.2, 1, '#ffffff'),
          disc(9.8, -3.2, 1, '#ffffff'),
          disc(-2.6, -5.8, 1, '#ff3b5c'),
          disc(2.6, -5.8, 1, '#ff3b5c'),
          disc(0, 0.9, 1.1, '#ff3b5c'),
          spark(0, -6.2, 3.6, '#ffffff', an('tw', { t: 2.8 })),
        ],
        { transform: 'scale(1.3)' },
      ),
    );
    return [
      glow('#ff3b5c', 0.42, 40, 50, an('breathe', { t: 4 })),
      ring(43.4, 6.4, lin(['#ff7a8a', '#c2183a', '#6e0a22', '#ffb0b8'], 135)),
      ring(40.4, 0.8, '#ffd27a'),
      ring(46.7, 0.8, '#ffd27a'),
      each(5, (a) => put(a + 60, 43.4, g([disc(0, 0, 1.9, rg([[0, '#ff8aa0'], [1, '#b0102e']]), { stroke: '#ffd27a', 'stroke-width': 0.4 }), disc(-0.5, -0.6, 0.55, '#ffffff', { opacity: 0.8 })]))),
      crown,
      each(4, (a, i) => spark(...pt(a + 120, 48.6), 1.7, '#ffe9a8', an('tw', { t: 3, d: -i * 0.7 }))),
    ].join('');
  },

  // 7 · Aurora eterna: cortinas de luz y particulas que dan vueltas en sentidos opuestos
  pass7() {
    const wave = (r, amp, ph) => poly(Array.from({ length: 91 }, (_, i) => pt(i * 4, r + amp * Math.sin(((i * 4 + ph) * Math.PI * 6) / 180))));
    return [
      glow('#4ff0c0', 0.4, 40, 50, an('breathe', { t: 5 })),
      ring(43, 5.4, lin(['#34f0b0', '#38b6ff', '#9a5cff', '#34f0b0'], 90)),
      ring(40.4, 0.7, '#ffffff', { opacity: 0.75 }),
      g(
        [
          path(`${wave(46.4, 1.6, 0)}Z`, { fill: 'none', stroke: lin(['#34f0b0', '#38b6ff', '#b05cff'], 90), 'stroke-width': 2.2, 'stroke-linejoin': 'round', opacity: 0.85 }),
          path(`${wave(44.6, 1.2, 40)}Z`, { fill: 'none', stroke: lin(['#b05cff', '#38b6ff', '#34f0b0'], 90), 'stroke-width': 1.2, 'stroke-linejoin': 'round', opacity: 0.7 }),
        ],
        an('spin', { t: 36 }),
      ),
      g([0, 90, 180, 270].map((a) => disc(...pt(a, 48.4), 1.15, '#ffffff')), an('spin', { t: 12 })),
      g([45, 165, 285].map((a) => disc(...pt(a, 42.6), 0.9, '#ffffff', { opacity: 0.9 })), an('spin rev', { t: 18 })),
      each(8, (a, i) => spark(...pt(a + 14, 49), 1.5, '#ffffff', an('tw', { t: 2.6, d: -i * 0.4 }))),
    ].join('');
  },

  // 8 · Estrella de Venus: rayos dorados, un planeta que orbita y una estrella arriba. El escalon mas alto.
  pass8() {
    const hole = mask(`<rect x="-10" y="-10" width="120" height="120" fill="#fff"/><circle cx="50" cy="50" r="40.4" fill="#000"/>`);
    const rays = each(24, (a, i) => path(`M${f(pt(a - 2.2, 46.6)[0])} ${f(pt(a - 2.2, 46.6)[1])}L${f(pt(a, i % 2 ? 49 : 50.2)[0])} ${f(pt(a, i % 2 ? 49 : 50.2)[1])}L${f(pt(a + 2.2, 46.6)[0])} ${f(pt(a + 2.2, 46.6)[1])}Z`, { fill: i % 2 ? '#ffc562' : '#fff1c8' }));
    return [
      glow('#ffc562', 0.55, 40, 50, an('breathe', { t: 3.6 })),
      g(rays, an('spin', { t: 70 })),
      ring(42.6, 6.4, lin(['#fff1c8', '#ffc562', '#e0719a', '#ffe3a0', '#ffc562'], 135)),
      ring(40.4, 0.8, '#ffffff'),
      ring(45.9, 0.6, '#8a4a3a', { opacity: 0.6 }),
      g(g(ellipse(50, 50, 49.4, 37, { fill: 'none', stroke: '#ffd9e6', 'stroke-width': 1.5, transform: 'rotate(-26 50 50)' }), an('spin', { t: 44 })), { mask: hole }),
      g(`<g transform="rotate(-26 50 50)">${disc(99.4, 50, 3.4, rg([[0, '#fff5d0'], [0.6, '#ffb347'], [1, '#c0652a']]), { stroke: '#fff1c8', 'stroke-width': 0.4 })}</g>`, an('spin', { t: 44 })),
      tr(50, 4.6, [star5(0, 0, 5.2, lin(['#fffbe0', '#ffc562', '#e0719a'], 135), { stroke: '#fff7d6', 'stroke-width': 0.3, 'stroke-linejoin': 'round' }), spark(0, 0, 7.4, '#ffffff', an('tw', { t: 2.6 }))]),
      each(6, (a, i) => spark(...pt(a + 30, 49.2), 1.7, '#fff1c8', an('tw', { t: 2.8, d: -i * 0.5 }))),
    ].join('');
  },
};
