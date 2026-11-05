'use strict';
// Logica de features/overlay.js (src/renderer/js/overlay/logic.js): limite de frecuencia de la voz, deteccion de
// cambios, foto del Voice Chat y atajos de teclado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { esm, fakeClock } = require('./helpers');

test('limite: como mucho 5 envios por segundo aunque lleguen 60 eventos', async () => {
  const { createLimiter } = await esm('logic.js');
  const clock = fakeClock();
  const sent = [];
  const lim = createLimiter({ interval: 200, flush: () => sent.push(clock.now()), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  for (let i = 0; i < 60; i++) {
    lim.mark();
    clock.advance(1000 / 60);
  }
  clock.advance(300);
  assert.ok(sent.length >= 5 && sent.length <= 6, `envios: ${sent.length}`);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i] - sent[i - 1] >= 200 - 1e-6, 'separados por 200 ms');
});

test('limite: un pedido suelto sale enseguida y varios seguidos se juntan en uno', async () => {
  const { createLimiter } = await esm('logic.js');
  const clock = fakeClock();
  let count = 0;
  const lim = createLimiter({ interval: 200, flush: () => count++, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  lim.mark();
  lim.mark();
  lim.mark();
  assert.equal(lim.waiting, true);
  clock.advance(0);
  assert.equal(count, 1);
  lim.mark();
  clock.advance(100);
  assert.equal(count, 1); // espera a que pasen 200 ms desde el anterior
  clock.advance(100);
  assert.equal(count, 2);
  lim.mark();
  lim.cancel();
  clock.advance(1000);
  assert.equal(count, 2);
  assert.equal(clock.pending(), 0);
});

test('solo se manda si algo cambio', async () => {
  const { createChangeGate } = await esm('logic.js');
  const gate = createChangeGate();
  assert.equal(gate.changed({ a: 1 }), true);
  assert.equal(gate.changed({ a: 1 }), false);
  assert.equal(gate.changed({ a: 2 }), true);
  gate.reset();
  assert.equal(gate.changed({ a: 2 }), true);
});

test('foto del Voice Chat con la forma del contrato', async () => {
  const { voiceSnapshot } = await esm('logic.js');
  const off = voiceSnapshot({ room: null, members: [{ userId: 'x' }], state: { muted: true } });
  assert.deepEqual(off, { kind: 'voice', room: null, self: { muted: true, deafened: false }, members: [] });
  const snap = voiceSnapshot(
    {
      room: { name: 'Sala', code: 'ABC123', ownerId: 'u1', members: [] },
      state: { muted: false, deafened: true },
      members: [
        { userId: 'u1', name: 'Steve', avatar: 'abc', self: true, speaking: true, muted: false, deafened: true, ping: 20 },
        { userId: 'u2', name: 'Alex', avatar: null, speaking: true, muted: true },
      ],
    },
    { avatarUrl: (a) => (a ? `https://mc-heads.net/avatar/${a}/32` : null) },
  );
  assert.deepEqual(snap.room, { name: 'Sala', code: 'ABC123' });
  assert.deepEqual(snap.self, { muted: false, deafened: true });
  assert.deepEqual(snap.members[0], { id: 'u1', name: 'Steve', avatar: 'https://mc-heads.net/avatar/abc/32', speaking: true, muted: false, deafened: true, self: true });
  assert.equal(snap.members[1].speaking, false); // silenciado: no puede estar hablando
  assert.equal(snap.members[1].avatar, null);
  assert.equal(voiceSnapshot({ room: { name: 'x' }, members: Array.from({ length: 30 }, (_, i) => ({ userId: i })) }).members.length, 16);
});

test('atajos desde el teclado', async () => {
  const { accelFromKey, accelParts } = await esm('logic.js');
  assert.equal(accelFromKey({ code: 'KeyO', altKey: true, shiftKey: true }), 'Alt+Shift+O');
  assert.equal(accelFromKey({ code: 'Digit5', ctrlKey: true }), 'Ctrl+5');
  assert.equal(accelFromKey({ code: 'F9', ctrlKey: true, metaKey: true }), 'Ctrl+Super+F9');
  assert.equal(accelFromKey({ code: 'Numpad3', altKey: true }), 'Alt+num3');
  assert.equal(accelFromKey({ code: 'ArrowUp', ctrlKey: true }), 'Ctrl+Up');
  assert.equal(accelFromKey({ code: 'F13' }), 'F13');
  assert.equal(accelFromKey({ code: 'KeyO' }), null); // sin modificador se la robaria al juego
  assert.equal(accelFromKey({ code: 'F3' }), null);
  assert.equal(accelFromKey({ code: 'ShiftLeft', shiftKey: true }), null);
  assert.equal(accelFromKey({ code: 'IntlBackslash', ctrlKey: true }), null);
  assert.deepEqual(accelParts('CommandOrControl+Shift+O'), ['Ctrl', 'Shift', 'O']);
  assert.deepEqual(accelParts('Super+F13'), ['Win', 'F13']);
  assert.deepEqual(accelParts(''), []);
});

test('los atajos que arma la interfaz los acepta el proceso principal', async () => {
  const { accelFromKey } = await esm('logic.js');
  const { validAccelerator } = require('../config');
  const samples = [
    { code: 'KeyO', altKey: true, shiftKey: true },
    { code: 'Digit0', ctrlKey: true, altKey: true },
    { code: 'F24' },
    { code: 'Backquote', shiftKey: true },
    { code: 'Numpad9', ctrlKey: true },
    { code: 'PageDown', altKey: true },
    { code: 'Space', ctrlKey: true, shiftKey: true },
  ];
  for (const e of samples) assert.equal(validAccelerator(accelFromKey(e)), true, accelFromKey(e));
});

test('cola serial: un error no corta la cola y todo corre en orden', async () => {
  const { createSerial } = await esm('logic.js');
  const errors = [];
  const run = createSerial((e) => errors.push(e.message));
  const order = [];
  run(async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push('a');
  });
  run(() => {
    throw new Error('layout roto');
  });
  run(() => Promise.reject(new Error('idioma que no carga')));
  await run(() => order.push('d'));
  assert.deepEqual(order, ['a', 'd']);
  assert.deepEqual(errors, ['layout roto', 'idioma que no carga']);
  // Aunque el aviso de error tambien falle, sigue andando
  const loud = createSerial(() => {
    throw new Error('el aviso tambien');
  });
  loud(() => {
    throw new Error('x');
  });
  let ran = false;
  await loud(() => {
    ran = true;
  });
  assert.equal(ran, true);
});

test('Voice Chat: si no entran todos, quien habla y uno mismo se ven antes que el resto', async () => {
  const { pickVoiceRows } = await esm('logic.js');
  const room = Array.from({ length: 12 }, (_, i) => ({ id: 'm' + i, speaking: i === 10, self: i === 3 }));
  const shown = pickVoiceRows(room, 8);
  assert.equal(shown.length, 8);
  assert.ok(shown.some((m) => m.id === 'm10'), 'el que habla esta, aunque sea el 11');
  assert.ok(shown.some((m) => m.id === 'm3'), 'uno mismo tambien');
  assert.deepEqual(shown.map((m) => m.id), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm10'], 'en el orden de la sala');
  // Muchos hablando a la vez: se quedan los primeros 8 que hablan
  const loud = room.map((m, i) => ({ ...m, speaking: i >= 2 }));
  assert.equal(pickVoiceRows(loud, 8).filter((m) => m.speaking).length, 8);
  // Si entran todos, no se toca nada
  const small = room.slice(0, 5);
  assert.equal(pickVoiceRows(small, 8), small);
  assert.deepEqual(pickVoiceRows(null, 8), []);
});
