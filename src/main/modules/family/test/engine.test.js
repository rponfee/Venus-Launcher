'use strict';
// El motor con un juego de mentira y el reloj a mano.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createEngine } = require('../engine');
const logic = require('../logic');

const { MIN } = logic;

function setup(config, { start = new Date(2026, 10, 3, 15).getTime(), usage = null } = {}) {
  const ctx = { time: start, events: [], closed: [], saved: [], timers: [] };
  ctx.data = { enabled: true, config, usage };
  ctx.game = { events: new EventEmitter() };
  ctx.engine = createEngine({
    game: ctx.game,
    getData: () => ctx.data,
    saveUsage: async (u) => ctx.saved.push(u),
    notify: (ev) => ctx.events.push(ev),
    closeGame: (id, reason) => ctx.closed.push({ id, reason }),
    now: () => ctx.time,
    setTimer: (fn, ms) => {
      const timer = { fn, at: ctx.time + ms, done: false };
      ctx.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.done = true;
    },
  });
  ctx.engine.start();
  ctx.advance = (ms, step = 5000) => {
    for (let t = 0; t < ms; t += step) {
      ctx.time += step;
      for (const x of ctx.timers) {
        if (!x.done && x.at <= ctx.time) {
          x.done = true;
          x.fn();
        }
      }
      ctx.engine.step();
    }
  };
  ctx.kinds = () => ctx.events.map((e) => e.kind);
  return ctx;
}

test('el tope: avisa a los 10 min, cuenta 60 s y cierra el juego', (t) => {
  const c = setup({ limitMin: 15 });
  t.after(() => c.engine.stop());
  c.game.events.emit('state', 'a', { state: 'running', pid: 1 });
  c.advance(5 * MIN);
  assert.deepEqual(c.kinds(), ['warn']);
  assert.equal(c.events[0].minutes, 10);
  c.advance(10 * MIN);
  assert.deepEqual(c.kinds(), ['warn', 'countdown']);
  assert.ok(c.events[1].endsAt > c.time);
  assert.deepEqual(c.closed, []);
  c.advance(60 * 1000);
  assert.deepEqual(c.kinds(), ['warn', 'countdown', 'closing']);
  assert.deepEqual(c.closed, [{ id: 'a', reason: 'limit' }]);
});

test('dos juegos abiertos no cuentan doble y se cierran los dos', (t) => {
  const c = setup({ limitMin: 15 });
  t.after(() => c.engine.stop());
  c.game.events.emit('state', 'a', { state: 'running', pid: 1 });
  c.game.events.emit('state', 'b', { state: 'running', pid: 2 });
  c.advance(10 * MIN);
  assert.equal(c.engine.status().usedMs, 10 * MIN);
  c.advance(6 * MIN + 5000);
  assert.deepEqual(c.closed.map((x) => x.id).sort(), ['a', 'b']);
});

test('una partida silenciosa no se cuenta ni se cierra', (t) => {
  const c = setup({ limitMin: 1 });
  t.after(() => c.engine.stop());
  c.game.events.emit('state', 'prueba', { state: 'running', pid: 1, quiet: true });
  c.advance(5 * MIN);
  assert.deepEqual(c.closed, []);
  assert.equal(c.engine.status().usedMs, 0);
});

test('con PIN se extiende: se cancela la cuenta regresiva y después vuelve a avisar', (t) => {
  const c = setup({ limitMin: 15 });
  t.after(() => c.engine.stop());
  c.game.events.emit('state', 'a', { state: 'running', pid: 1 });
  c.advance(15 * MIN + 5000);
  assert.ok(c.kinds().includes('countdown'));
  c.engine.extend(30);
  assert.equal(c.kinds().at(-1), 'cancelled');
  c.advance(21 * MIN);
  assert.equal(c.kinds().filter((k) => k === 'warn').length, 2);
  assert.deepEqual(c.closed, []);
  c.advance(10 * MIN + 65 * 1000);
  assert.deepEqual(c.closed, [{ id: 'a', reason: c.closed[0].reason }]);
});

test('fuera de horario no deja arrancar; el tiempo guardado sobrevive a reabrir el launcher', (t) => {
  const start = new Date(2026, 10, 3, 21).getTime();
  const c = setup({ schedule: { enabled: true, from: '16:00', to: '20:00' } }, { start });
  t.after(() => c.engine.stop());
  const res = c.engine.canLaunch();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'schedule');
  c.engine.extend(30);
  assert.equal(c.engine.canLaunch().ok, true);

  const noon = new Date(2026, 10, 3, 12).getTime();
  const d = setup({ limitMin: 60 }, { start: noon, usage: { day: logic.dayKey(noon), usedMs: 60 * MIN } });
  t.after(() => d.engine.stop());
  assert.equal(d.engine.canLaunch().ok, false);
  assert.equal(d.engine.canLaunch().reason, 'limit');
});

test('servidor no permitido: avisa y cierra a los 15 s', (t) => {
  const c = setup({ servers: { enabled: true, list: ['ok.example.com'] } });
  t.after(() => c.engine.stop());
  c.game.events.emit('state', 'a', { state: 'running', pid: 1 });
  c.game.events.emit('log', 'a', [{ text: '[x] [Render thread/INFO]: Connecting to ok.example.com, 25565' }]);
  assert.deepEqual(c.kinds(), [], 'el permitido no avisa');
  c.game.events.emit('log', 'a', [{ text: '[x] [Render thread/INFO]: [CHAT] Connecting to evil.example, 25565' }]);
  assert.deepEqual(c.kinds(), [], 'el chat no cuenta');
  c.game.events.emit('log', 'a', [{ text: '[x] [Render thread/INFO]: Connecting to evil.example, 25565' }]);
  assert.deepEqual(c.kinds(), ['server']);
  assert.equal(c.events[0].address, 'evil.example');
  c.advance(10 * 1000);
  assert.deepEqual(c.closed, []);
  c.advance(10 * 1000);
  assert.deepEqual(c.closed, [{ id: 'a', reason: 'server' }]);
  assert.deepEqual(c.kinds(), ['server', 'serverClosing']);
});

test('servidor: con el PIN se deja seguir y cerrar el juego cancela el cierre', (t) => {
  const c = setup({ servers: { enabled: true, list: [] } });
  t.after(() => c.engine.stop());
  c.game.events.emit('state', 'a', { state: 'running', pid: 1 });
  c.game.events.emit('log', 'a', [{ text: 'Connecting to otro.example, 25570' }]);
  assert.equal(c.engine.allowServer('a'), 'otro.example:25570');
  c.advance(20 * 1000);
  assert.deepEqual(c.closed, []);
  c.game.events.emit('log', 'a', [{ text: 'Connecting to otro.example, 25570' }]);
  assert.equal(c.kinds().filter((k) => k === 'server').length, 1, 'ya permitido en esta sesión');

  c.game.events.emit('log', 'a', [{ text: 'Connecting to tercero.example, 25565' }]);
  c.game.events.emit('state', 'a', { state: 'stopped' });
  c.advance(20 * 1000);
  assert.deepEqual(c.closed, []);
});

test('sin lista de servidores no se mira nada, y apagar el modo corta todo', (t) => {
  const c = setup({ limitMin: 1, servers: { enabled: false, list: [] } });
  t.after(() => c.engine.stop());
  c.game.events.emit('state', 'a', { state: 'running', pid: 1 });
  c.game.events.emit('log', 'a', [{ text: 'Connecting to evil.example, 25565' }]);
  assert.deepEqual(c.kinds(), ['warn']);
  c.advance(60 * 1000 + 5000);
  assert.ok(c.kinds().includes('countdown'));
  c.data = { enabled: false };
  c.engine.reload();
  assert.equal(c.kinds().at(-1), 'cancelled');
  c.advance(5 * MIN);
  assert.deepEqual(c.closed, []);
});
