'use strict';
// Posiciones de los widgets (src/renderer/js/overlay/layout.js): grilla de 3x3, posicion libre, arrastre y teclado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { esm } = require('./helpers');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} != ${b}`);

test('las 9 posiciones de la grilla', async () => {
  const L = await esm('layout.js');
  const size = { w: 0.2, h: 0.1 };
  const m = L.MARGIN;
  const expect = {
    tl: [m.x, m.y],
    tc: [0.5 - size.w / 2, m.y],
    tr: [1 - m.x - size.w, m.y],
    ml: [m.x, 0.5 - size.h / 2],
    mc: [0.5 - size.w / 2, 0.5 - size.h / 2],
    mr: [1 - m.x - size.w, 0.5 - size.h / 2],
    bl: [m.x, 1 - m.y - size.h],
    bc: [0.5 - size.w / 2, 1 - m.y - size.h],
    br: [1 - m.x - size.w, 1 - m.y - size.h],
  };
  for (const [anchor, [left, top]] of Object.entries(expect)) {
    const box = L.anchoredBox(anchor, size);
    near(box.left, left, anchor);
    near(box.top, top, anchor);
  }
  assert.deepEqual(L.anchorCell('mr'), { col: 2, row: 1 });
  assert.equal(L.anchorCell('nada'), null);
  assert.deepEqual(L.anchorFraction('bc'), { x: 0.5, y: 1 });
});

test('posicion libre: nunca se sale del juego y la inversa vuelve al mismo lugar', async () => {
  const L = await esm('layout.js');
  const size = { w: 0.3, h: 0.25 };
  for (const x of [0, 0.1, 0.37, 0.5, 0.9, 1]) {
    for (const y of [0, 0.42, 1]) {
      const box = L.freeBox({ x, y }, size);
      assert.ok(box.left >= L.MARGIN.x - 1e-9 && box.left + size.w <= 1 - L.MARGIN.x + 1e-9);
      assert.ok(box.top >= L.MARGIN.y - 1e-9 && box.top + size.h <= 1 - L.MARGIN.y + 1e-9);
      const back = L.freeFromBox(box, size);
      near(back.x, x, 'x');
      near(back.y, y, 'y');
    }
  }
  // valores fuera de rango se acotan; un widget mas ancho que el juego queda pegado al margen
  assert.deepEqual(L.freeBox({ x: -2, y: 5 }, size), L.freeBox({ x: 0, y: 1 }, size));
  near(L.freeBox({ x: 1, y: 0 }, { w: 1.4, h: 0.1 }).left, L.MARGIN.x);
  assert.deepEqual(L.freeFromBox({ left: 0.2, top: 0.2 }, { w: 1, h: 1 }), { x: 0.5, y: 0.5 });
  // boxFor usa la grilla o la posicion libre segun la configuracion
  assert.deepEqual(L.boxFor({ anchor: 'free', x: 0.25, y: 0.75 }, size), L.freeBox({ x: 0.25, y: 0.75 }, size));
  assert.deepEqual(L.boxFor({ anchor: 'br', x: 0.25, y: 0.75 }, size), L.anchoredBox('br', size));
});

test('la escala agranda el widget pero la grilla lo mantiene en su lugar', async () => {
  const L = await esm('layout.js');
  const area = { width: 1280, height: 720 };
  for (const scale of [0.6, 1, 1.6]) {
    const size = L.sizeOf({ width: 220 * scale, height: 140 * scale }, area);
    const box = L.anchoredBox('tr', size);
    near((box.left + size.w) * area.width, area.width * (1 - L.MARGIN.x), `escala ${scale}`);
    near(box.top * area.height, area.height * L.MARGIN.y);
  }
  assert.equal(L.clampScale(3), 1.6);
  assert.equal(L.clampScale(0.1), 0.6);
  assert.equal(L.clampScale('x'), 1);
  assert.deepEqual(L.sizeOf({ width: 10, height: 10 }, { width: 0, height: 0 }), { w: 0, h: 0 });
});

test('al soltar: se ancla cerca de una celda o queda libre', async () => {
  const L = await esm('layout.js');
  const size = { w: 0.2, h: 0.15 };
  const tr = L.anchoredBox('tr', size);
  assert.deepEqual(L.snap({ left: tr.left - 0.005, top: tr.top + 0.01 }, size), { anchor: 'tr' });
  const mc = L.anchoredBox('mc', size);
  assert.deepEqual(L.snap(mc, size), { anchor: 'mc' });
  const free = L.snap({ left: 0.3, top: 0.62 }, size);
  assert.equal(free.anchor, 'free');
  const box = L.freeBox(free, size);
  assert.ok(Math.abs(box.left - 0.3) < 1e-3 && Math.abs(box.top - 0.62) < 1e-3);
  // el umbral horizontal tiene en cuenta que el juego es mas ancho que alto
  assert.equal(L.snap({ left: tr.left - 0.03, top: tr.top }, size, { aspect: 16 / 9 }).anchor, 'free');
  assert.equal(L.snap({ left: tr.left - 0.03, top: tr.top }, size, { aspect: 1 }).anchor, 'tr');
  // mientras se arrastra no sale del area
  assert.deepEqual(L.clampBox({ left: -0.2, top: 0.95 }, size), { left: 0, top: 0.85 });
});

test('teclado: flechas y teclas 1 a 9', async () => {
  const L = await esm('layout.js');
  assert.deepEqual(L.nudge({ anchor: 'tl' }, 1, 0), { anchor: 'free', x: 0.01, y: 0 });
  assert.deepEqual(L.nudge({ anchor: 'br' }, 0, -1, 0.05), { anchor: 'free', x: 1, y: 0.95 });
  assert.deepEqual(L.nudge({ anchor: 'free', x: 0.995, y: 0.5 }, 1, 0), { anchor: 'free', x: 1, y: 0.5 });
  assert.equal(L.DIGIT_ANCHOR[7], 'tl');
  assert.equal(L.DIGIT_ANCHOR[5], 'mc');
  assert.equal(L.DIGIT_ANCHOR[3], 'br');
  assert.deepEqual(Object.values(L.DIGIT_ANCHOR).sort(), [...L.ANCHORS].sort());
});
