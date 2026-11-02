'use strict';
// Rectangulo de la ventana del juego: lineas del ayudante, pixeles fisicos a DIP con la escala de Windows, que
// juego seguir y cuando se ve el overlay. Al final, la cuenta completa hasta la posicion de un widget.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, physicalToDip, sameRect, pickTarget, decide } = require('../geometry');
const { esm } = require('./helpers');

test('lineas del ayudante', () => {
  assert.deepEqual(parseLine('{"ok":0}'), { found: false });
  assert.deepEqual(parseLine('{"end":1}'), { end: true });
  assert.equal(parseLine('basura'), null);
  assert.equal(parseLine('{"ok":1,"x":1}'), null);
  const info = parseLine('{"ok":1,"hwnd":1234,"fgw":1234,"x":-8,"y":31,"w":1920,"h":1009,"min":0,"vis":1,"full":0,"dpi":144}\r');
  assert.deepEqual(info, { found: true, hwnd: '1234', foreground: '1234', rect: { x: -8, y: 31, width: 1920, height: 1009 }, minimized: false, visible: true, fullscreen: false, dpi: 144 });
  assert.equal(parseLine('{"ok":1,"hwnd":5,"fgw":9,"x":0,"y":0,"w":0,"h":0,"min":1,"vis":1,"full":0}').minimized, true);
  assert.equal(parseLine('{"ok":1,"hwnd":5,"fgw":5,"x":0,"y":0,"w":2560,"h":1440,"min":0,"vis":1,"full":1}').fullscreen, true);
});

test('pixeles fisicos a DIP: 100 %, 150 % y dos monitores con escalas distintas', () => {
  const one = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }];
  assert.deepEqual(physicalToDip({ x: 100, y: 50, width: 854, height: 480 }, one), { x: 100, y: 50, width: 854, height: 480 });

  const hi = [{ bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5, nativeOrigin: { x: 0, y: 0 } }];
  assert.deepEqual(physicalToDip({ x: 300, y: 150, width: 1920, height: 1080 }, hi), { x: 200, y: 100, width: 1280, height: 720 });

  // Principal 4K al 150 % (2560x1440 DIP) y a la derecha un 1080p al 100 % (fisico desde x = 3840).
  const mixed = [
    { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5, nativeOrigin: { x: 0, y: 0 } },
    { bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, nativeOrigin: { x: 3840, y: 0 } },
  ];
  assert.deepEqual(physicalToDip({ x: 3940, y: 100, width: 1280, height: 720 }, mixed), { x: 2660, y: 100, width: 1280, height: 720 });
  assert.deepEqual(physicalToDip({ x: 600, y: 300, width: 1500, height: 900 }, mixed), { x: 400, y: 200, width: 1000, height: 600 });
  // Sin nativeOrigin se supone el origen fisico = bounds * escala.
  assert.deepEqual(physicalToDip({ x: 300, y: 150, width: 1920, height: 1080 }, [{ bounds: hi[0].bounds, scaleFactor: 1.5 }]), { x: 200, y: 100, width: 1280, height: 720 });
  // Fuera de todas las pantallas: usa la mas cercana. Sin pantallas: igual que vino.
  assert.equal(physicalToDip({ x: 9000, y: 10, width: 100, height: 100 }, mixed).x, 2560 + 9000 - 3840);
  assert.deepEqual(physicalToDip({ x: 1, y: 2, width: 3, height: 4 }, []), { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(sameRect({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }), true);
  assert.equal(sameRect({ x: 1, y: 2, width: 3, height: 4 }, null), false);
});

const game = (id, info, startedAt = 0) => ({ id, startedAt, info: { found: true, minimized: false, visible: true, rect: { x: 0, y: 0, width: 800, height: 600 }, ...info } });

test('que juego sigue el overlay', () => {
  assert.equal(pickTarget([]), null);
  assert.equal(pickTarget([{ id: 'a', info: { found: false } }]), null);
  const a = game('a', { hwnd: '1', foreground: '9' }, 1);
  const b = game('b', { hwnd: '2', foreground: '9' }, 2);
  assert.equal(pickTarget([a, b]).id, 'b'); // ninguno adelante: el ultimo que abrio
  const a2 = game('a', { hwnd: '1', foreground: '1' }, 1);
  assert.equal(pickTarget([a2, b]).id, 'a'); // el que esta en primer plano
});

test('cuando se ve el overlay', () => {
  const front = game('a', { hwnd: '10', foreground: '10' });
  const back = game('a', { hwnd: '10', foreground: '77' });
  const base = { enabled: true, userHidden: false, editing: false, testing: false, overlayHwnd: '55' };
  assert.deepEqual(decide({ ...base, target: front }), { show: true, mode: 'game' });
  assert.deepEqual(decide({ ...base, target: back }), { show: false, mode: 'game' });
  // si el foco lo tiene el propio overlay (modo edicion), el juego sigue "adelante"
  assert.deepEqual(decide({ ...base, target: game('a', { hwnd: '10', foreground: '55' }) }), { show: true, mode: 'game' });
  assert.deepEqual(decide({ ...base, userHidden: true, target: front }), { show: false, mode: 'game' });
  assert.deepEqual(decide({ ...base, enabled: false, target: front }), { show: false, mode: 'game' });
  assert.deepEqual(decide({ ...base, target: game('a', { hwnd: '10', foreground: '10', minimized: true }) }), { show: false, mode: null });
  assert.deepEqual(decide({ ...base, target: null }), { show: false, mode: null });
  // modo edicion o prueba: siempre se ve; sin juego usable, sobre la pantalla
  assert.deepEqual(decide({ ...base, editing: true, target: back }), { show: true, mode: 'game' });
  assert.deepEqual(decide({ ...base, testing: true, enabled: false, target: null }), { show: true, mode: 'screen' });
  assert.deepEqual(decide({ ...base, editing: true, target: game('a', { hwnd: '10', minimized: true }) }), { show: true, mode: 'screen' });
});

test('cuenta completa: juego al 150 %, widget con escala 1,5 en la esquina inferior derecha', async () => {
  const { anchoredBox, freeBox, sizeOf } = await esm('layout.js');
  // El ayudante informa el area de juego en pixeles fisicos; la ventana del overlay va en DIP.
  const display = [{ bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5, nativeOrigin: { x: 0, y: 0 } }];
  const area = physicalToDip({ x: 150, y: 120, width: 2400, height: 1350 }, display);
  assert.deepEqual(area, { x: 100, y: 80, width: 1600, height: 900 });
  // El widget mide 220x120 DIP sin escalar; con escala 1,5 ocupa 330x180.
  const size = sizeOf({ width: 220 * 1.5, height: 120 * 1.5 }, area);
  const box = anchoredBox('br', size);
  const left = area.x + box.left * area.width;
  const top = area.y + box.top * area.height;
  // Margen de 1,25 % del ancho (20 DIP) y 2 % del alto (18 DIP): el borde del widget queda pegado al margen.
  assert.ok(Math.abs(left + 330 - (area.x + area.width - 20)) < 1e-6);
  assert.ok(Math.abs(top + 180 - (area.y + area.height - 18)) < 1e-6);
  // Una posicion libre en (0.5, 0.5) centra el widget, con cualquier escala.
  const center = freeBox({ x: 0.5, y: 0.5 }, size);
  assert.ok(Math.abs(center.left + size.w / 2 - 0.5) < 1e-9);
  assert.ok(Math.abs(center.top + size.h / 2 - 0.5) < 1e-9);
});
