'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoClipGate, AFTER_MS } = require('../autoclip');
const logic = require('../logic');

const on = (extra = {}) => logic.normalizeAuto({ enabled: true, cooldown: 30, maxPerSession: 3, ...extra });

function gateAt(start = 1000000) {
  const clock = { t: start };
  const gate = new AutoClipGate({ now: () => clock.t });
  return { gate, clock };
}

test('apagado por defecto y un interruptor por tipo de evento', () => {
  const { gate } = gateAt();
  const defaults = logic.normalizeAuto(undefined);
  assert.equal(defaults.enabled, false, 'el interruptor general arranca apagado');
  assert.deepEqual(gate.offer('death', defaults), { action: 'ignore', why: 'off' });
  assert.deepEqual(gate.offer('death', null), { action: 'ignore', why: 'off' });
  assert.deepEqual(gate.offer('death', on({ death: false })), { action: 'ignore', why: 'off' });
  assert.deepEqual(gate.offer('boss', on({ boss: false })), { action: 'ignore', why: 'off' });
  assert.deepEqual(gate.offer('advancement', on({ advancement: false })), { action: 'ignore', why: 'off' });
  assert.deepEqual(gate.offer('otro', on()), { action: 'ignore', why: 'off' });
  assert.equal(gate.count, 0);
  assert.equal(gate.offer('death', on({ advancement: false })).action, 'schedule');
});

test('espera unos segundos antes de cortar y entrega el motivo con su contexto', () => {
  const { gate } = gateAt();
  const res = gate.offer('death', on(), { instanceId: 'i1' });
  assert.deepEqual(res, { action: 'schedule', reason: 'death', delay: AFTER_MS.death });
  assert.ok(AFTER_MS.death >= 3000 && AFTER_MS.boss > AFTER_MS.death, 'el dragon tarda mas en morir');
  const p = gate.take();
  assert.equal(p.reason, 'death');
  assert.deepEqual(p.ctx, { instanceId: 'i1' });
  assert.equal(gate.take(), null, 'se entrega una vez');
});

test('enfriamiento: no abre otro clip hasta que pase el tiempo elegido', () => {
  const { gate, clock } = gateAt();
  const auto = on({ cooldown: 30 });
  assert.equal(gate.offer('death', auto).action, 'schedule');
  gate.take();
  clock.t += 29999;
  assert.deepEqual(gate.offer('death', auto), { action: 'ignore', why: 'cooldown' });
  assert.deepEqual(gate.offer('boss', auto), { action: 'ignore', why: 'cooldown' }, 'vale para todos los motivos');
  clock.t += 1;
  assert.equal(gate.offer('advancement', auto).action, 'schedule');
  assert.equal(gate.count, 2);
});

test('el mismo evento repetido (chat y servidor integrado) es un solo clip', () => {
  const { gate } = gateAt();
  const auto = on();
  assert.equal(gate.offer('death', auto).action, 'schedule');
  assert.deepEqual(gate.offer('death', auto), { action: 'ignore', why: 'pending' });
  assert.equal(gate.count, 1);
  gate.take();
  assert.deepEqual(gate.offer('death', auto), { action: 'ignore', why: 'cooldown' });
  assert.equal(gate.count, 1);
});

test('dos eventos juntos: un solo clip con el motivo mas importante y la espera mas larga', () => {
  const { gate, clock } = gateAt();
  const auto = on();
  gate.offer('advancement', auto, { instanceId: 'i1' });
  clock.t += 1000;
  const up = gate.offer('death', auto);
  assert.deepEqual(up, { action: 'schedule', reason: 'death', delay: AFTER_MS.death });
  clock.t += 1000;
  const boss = gate.offer('boss', auto);
  assert.equal(boss.reason, 'boss');
  assert.equal(boss.delay, AFTER_MS.boss);
  assert.deepEqual(gate.offer('death', auto), { action: 'ignore', why: 'pending' }, 'uno menos importante no cambia nada');
  assert.equal(gate.count, 1, 'cuenta como un clip');
  const p = gate.take();
  assert.equal(p.reason, 'boss');
  assert.deepEqual(p.ctx, { instanceId: 'i1' });
  // Si el jefe llego casi al final de la espera de otro, no se acorta
  const { gate: g2, clock: c2 } = gateAt();
  g2.offer('boss', auto);
  c2.t += 11000;
  assert.deepEqual(g2.offer('death', auto), { action: 'ignore', why: 'pending' });
});

test('limite por partida: se avisa una sola vez y una partida nueva vuelve a contar', () => {
  const { gate, clock } = gateAt();
  const auto = on({ cooldown: 5, maxPerSession: 2 });
  for (let i = 0; i < 2; i++) {
    assert.equal(gate.offer('death', auto).action, 'schedule');
    gate.take();
    clock.t += 5000;
  }
  assert.deepEqual(gate.offer('death', auto), { action: 'ignore', why: 'limit' });
  assert.equal(gate.noteLimit(), true);
  assert.equal(gate.noteLimit(), false);
  assert.equal(gate.count, 2);
  gate.reset();
  assert.equal(gate.count, 0);
  assert.equal(gate.noteLimit(), true);
  assert.equal(gate.offer('death', auto).action, 'schedule');
});

test('ajustes de los clips automaticos: rangos y valores por defecto', () => {
  const d = logic.normalizeSettings({}).auto;
  assert.deepEqual(d, { enabled: false, death: true, advancement: true, boss: true, cooldown: 30, maxPerSession: 20, seconds: 60 });
  const s = logic.normalizeAuto({ enabled: true, death: false, cooldown: 1, maxPerSession: 9999, seconds: 45 });
  assert.equal(s.enabled, true);
  assert.equal(s.death, false);
  assert.equal(s.advancement, true);
  assert.equal(s.cooldown, 5, 'con menos no serviria para no llenar el disco');
  assert.equal(s.maxPerSession, 200);
  assert.equal(s.seconds, 60, 'un largo que no existe vuelve al de siempre');
  assert.equal(logic.normalizeAuto({ cooldown: 'x', maxPerSession: null }).cooldown, 30);
  assert.equal(logic.normalizeAuto({ cooldown: 'x', maxPerSession: null }).maxPerSession, 20);
  assert.equal(logic.normalizeAuto({ cooldown: '120' }).cooldown, 120);
  assert.equal(logic.normalizeAuto({ enabled: 'si' }).enabled, false);
  // El largo del clip no pasa de lo que guarda la repeticion en el plan
  assert.equal(logic.autoSeconds({ seconds: 300 }, false), 60);
  assert.equal(logic.autoSeconds({ seconds: 300 }, true), 300);
  assert.equal(logic.autoSeconds({ seconds: 30 }, true), 30);
  assert.equal(logic.autoSeconds(undefined, true), 60);
});
