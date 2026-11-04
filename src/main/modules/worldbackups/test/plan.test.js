'use strict';
// Planificacion y rotacion de las copias automaticas, mas la marca .auto de worlds/backups.
const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../plan');
const backups = require('../../worlds/backups');

const HOUR = 3600000;
const on = (over = {}) => plan.normalize({ enabled: true, ...over });

test('normalize: apagado por defecto y valores fuera de rango', () => {
  assert.deepEqual(plan.normalize(null), { enabled: false, frequency: 'daily', everyHours: 6, keep: 5, instances: 'all', onGameClose: false });
  const c = plan.normalize({ enabled: true, frequency: 'x', everyHours: 9999, keep: 0, instances: ['a', 'a', 3], onGameClose: 'si' });
  assert.equal(c.frequency, 'daily');
  assert.equal(c.everyHours, plan.EVERY_MAX);
  assert.equal(c.keep, plan.KEEP_MIN);
  assert.deepEqual(c.instances, ['a']);
  assert.equal(c.onGameClose, false);
});

test('intervalos: cada N horas, diaria y semanal', () => {
  assert.equal(plan.intervalMs(on({ frequency: 'hours', everyHours: 3 })), 3 * HOUR);
  assert.equal(plan.intervalMs(on({ frequency: 'daily' })), 24 * HOUR);
  assert.equal(plan.intervalMs(on({ frequency: 'weekly' })), 7 * 24 * HOUR);
});

test('qué instancias entran', () => {
  assert.equal(plan.wants(on(), 'x'), true);
  assert.equal(plan.wants(on({ instances: ['a'] }), 'a'), true);
  assert.equal(plan.wants(on({ instances: ['a'] }), 'b'), false);
});

test('toca copiar: apagado nunca, primera vez y al vencer', () => {
  const now = 1000 * HOUR;
  assert.equal(plan.needsCopy({ cfg: plan.normalize({}), lastAt: 0, modifiedAt: now, now }), false);
  assert.equal(plan.needsCopy({ cfg: on(), lastAt: 0, modifiedAt: now, now }), true, 'nunca se copió');
  assert.equal(plan.needsCopy({ cfg: on(), lastAt: now - 23 * HOUR, modifiedAt: now, now }), false, 'todavía no toca');
  assert.equal(plan.needsCopy({ cfg: on(), lastAt: now - 24 * HOUR, modifiedAt: now, now }), true);
});

test('una copia perdida se hace en la primera revisión, por vieja que sea', () => {
  const now = 1000 * HOUR;
  assert.equal(plan.needsCopy({ cfg: on({ frequency: 'weekly' }), lastAt: now - 30 * 24 * HOUR, modifiedAt: now - 20 * 24 * HOUR, now }), true);
});

test('un mundo sin cambios no se vuelve a copiar (empujaría afuera a las copias que sirven)', () => {
  const now = 1000 * HOUR;
  const lastAt = now - 48 * HOUR;
  assert.equal(plan.needsCopy({ cfg: on(), lastAt, modifiedAt: lastAt - HOUR, now }), false);
  assert.equal(plan.needsCopy({ cfg: on({ onGameClose: true }), reason: 'close', lastAt, modifiedAt: lastAt - HOUR, now }), false);
});

test('al cerrar el juego: solo con la opción, salvo lo programado que quedó esperando', () => {
  const now = 1000 * HOUR;
  const recent = now - HOUR;
  assert.equal(plan.needsCopy({ cfg: on({ onGameClose: true }), reason: 'close', lastAt: recent, modifiedAt: now, now }), true);
  assert.equal(plan.needsCopy({ cfg: on(), reason: 'close', lastAt: recent, modifiedAt: now, now }), false);
  assert.equal(plan.needsCopy({ cfg: on(), reason: 'close', lastAt: now - 25 * HOUR, modifiedAt: now, now }), true);
});

test('rotación: quedan las N automáticas más nuevas y nunca toca una manual', () => {
  const list = [
    { name: 'm1', time: 1, auto: false },
    { name: 'a1', time: 2, auto: true },
    { name: 'm2', time: 3 },
    { name: 'a2', time: 4, auto: true },
    { name: 'a3', time: 5, auto: true },
  ];
  assert.deepEqual(plan.rotationVictims(list, 2).map((b) => b.name), ['a1']);
  assert.deepEqual(plan.rotationVictims(list, 1).map((b) => b.name), ['a2', 'a1']);
  assert.deepEqual(plan.rotationVictims(list, 5), []);
  assert.deepEqual(plan.rotationVictims([{ name: 'm', time: 1, auto: false }], 1), []);
  assert.equal(plan.rotationVictims(list, 0).length, 2, 'siempre queda al menos una');
  assert.deepEqual(plan.rotationVictims(null, 3), []);
});

test('nombres: la marca .auto se lee y una copia manual sigue siendo manual', () => {
  const a = backups.parseName('Mi Mundo-2026-10-27_18-03-11.auto.zip');
  assert.equal(a.folder, 'Mi Mundo');
  assert.equal(a.auto, true);
  assert.equal(backups.parseName('Mi Mundo-2026-10-27_18-03-11-2.auto.zip').auto, true);
  const m = backups.parseName('Mi Mundo-2026-10-27_18-03-11.zip');
  assert.equal(m.folder, 'Mi Mundo');
  assert.equal(m.auto, false);
  // Una carpeta que se llama como la marca no vuelve automática a una copia manual
  const odd = backups.parseName('x.auto-2026-10-27_18-03-11.zip');
  assert.equal(odd.folder, 'x.auto');
  assert.equal(odd.auto, false);
  assert.equal(backups.parseName('otro.zip'), null);
});
