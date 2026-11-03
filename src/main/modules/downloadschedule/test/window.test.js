'use strict';
// Franja horaria de las descargas programadas, incluida la que cruza la medianoche.
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../window');

const at = (h, m = 0) => new Date(2026, 10, 3, h, m, 0, 0); // 3 de noviembre de 2026 (hora local)

test('normalizacion de la franja', () => {
  assert.deepEqual(w.normalize(undefined), { enabled: false, from: '02:00', to: '08:00' });
  assert.deepEqual(w.normalize({ enabled: true, from: '7:05', to: '23:59' }), { enabled: true, from: '07:05', to: '23:59' });
  assert.deepEqual(w.normalize({ enabled: 'si', from: '25:00', to: 'x' }), { enabled: false, from: '02:00', to: '08:00' });
  assert.equal(w.parseClock('02:30'), 150);
  assert.equal(w.parseClock('24:00'), null);
  assert.equal(w.fmtClock(150), '02:30');
});

test('franja normal (02:00 a 08:00)', () => {
  assert.equal(w.inWindow(w.minutesOfDay(at(3)), '02:00', '08:00'), true);
  assert.equal(w.inWindow(w.minutesOfDay(at(2)), '02:00', '08:00'), true);
  assert.equal(w.inWindow(w.minutesOfDay(at(7, 59)), '02:00', '08:00'), true);
  assert.equal(w.inWindow(w.minutesOfDay(at(8)), '02:00', '08:00'), false);
  assert.equal(w.inWindow(w.minutesOfDay(at(9)), '02:00', '08:00'), false);
  assert.equal(w.inWindow(w.minutesOfDay(at(1, 59)), '02:00', '08:00'), false);
  assert.equal(w.nextChange(at(3), '02:00', '08:00').getTime(), at(8).getTime());
  assert.equal(w.nextChange(at(9), '02:00', '08:00').getTime(), new Date(2026, 10, 4, 2, 0).getTime());
});

test('franja que cruza la medianoche (22:00 a 06:00)', () => {
  assert.equal(w.inWindow(w.minutesOfDay(at(23)), '22:00', '06:00'), true);
  assert.equal(w.inWindow(w.minutesOfDay(at(3)), '22:00', '06:00'), true);
  assert.equal(w.inWindow(w.minutesOfDay(at(22)), '22:00', '06:00'), true);
  assert.equal(w.inWindow(w.minutesOfDay(at(6)), '22:00', '06:00'), false);
  assert.equal(w.inWindow(w.minutesOfDay(at(12)), '22:00', '06:00'), false);
  assert.equal(w.nextChange(at(23), '22:00', '06:00').getTime(), new Date(2026, 10, 4, 6, 0).getTime());
  assert.equal(w.nextChange(at(12), '22:00', '06:00').getTime(), at(22).getTime());
});

test('misma hora de inicio y fin = todo el dia; sin franja valida, siempre permitido', () => {
  assert.equal(w.inWindow(0, '05:00', '05:00'), true);
  assert.equal(w.inWindow(900, '05:00', '05:00'), true);
  assert.equal(w.nextChange(at(3), '05:00', '05:00'), null);
  assert.equal(w.inWindow(900, 'x', '05:00'), true);
});

test('decide: apagado, dentro, fuera y "Bajar ahora"', () => {
  const cfg = { enabled: true, from: '02:00', to: '08:00' };
  const off = w.decide({ now: at(12), cfg: { ...cfg, enabled: false } });
  assert.equal(off.allowed, true);
  assert.equal(off.nextChangeAt, null);
  const inside = w.decide({ now: at(3), cfg });
  assert.deepEqual([inside.inWindow, inside.allowed, inside.override], [true, true, false]);
  assert.equal(inside.nextChangeAt, at(8).getTime());
  const outside = w.decide({ now: at(12), cfg });
  assert.deepEqual([outside.inWindow, outside.allowed], [false, false]);
  const forced = w.decide({ now: at(12), cfg, overrideUntil: at(14).getTime() });
  assert.deepEqual([forced.inWindow, forced.allowed, forced.override], [false, true, true]);
  const expired = w.decide({ now: at(15), cfg, overrideUntil: at(14).getTime() });
  assert.equal(expired.allowed, false);
});
