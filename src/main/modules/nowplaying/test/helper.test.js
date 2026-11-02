'use strict';
// Proceso ayudante: arranque, comandos con respuesta, reintentos con espera creciente y cierre.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Helper, Backoff } = require('../helper');
const { fakeClock, fakeSpawn } = require('./helpers');

const READY = { t: 'ready', v: 1, smtc: true, audio: true, thumbs: true };

function setup(opts = {}) {
  const clock = fakeClock();
  const sp = fakeSpawn();
  const helper = new Helper({ spawn: sp.spawn, command: () => ({ file: 'powershell.exe', args: ['-Command', 'x'], env: {} }), now: clock.now, timers: clock.timers, ...opts });
  const statuses = [];
  helper.on('status', (s) => statuses.push(s));
  return { clock, sp, helper, statuses };
}

test('Backoff: 1 s, 2 s, 4 s... hasta 60 s, y se reinicia', () => {
  const b = new Backoff();
  assert.deepEqual([b.next(), b.next(), b.next(), b.next(), b.next(), b.next(), b.next(), b.next()], [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  b.reset();
  assert.equal(b.next(), 1000);
});

test('arranca, queda listo y reenvía los mensajes', () => {
  const { sp, helper, statuses } = setup();
  const msgs = [];
  helper.on('message', (m) => msgs.push(m));
  helper.start();
  helper.start(); // idempotente
  assert.equal(sp.children.length, 1);
  const child = sp.last();
  assert.equal(child.file, 'powershell.exe');
  assert.equal(child.opts.windowsHide, true);
  assert.equal(helper.status, 'starting');
  child.line(READY);
  assert.equal(helper.status, 'ready');
  child.line('basura que no es JSON');
  child.line({ t: 'sessions', system: '', list: [] });
  assert.deepEqual(msgs, [{ t: 'sessions', system: '', list: [] }]);
  assert.deepEqual(statuses, ['starting', 'ready']);
});

test('comandos: los de antes de estar listo esperan y la respuesta llega por req', async () => {
  const { sp, helper } = setup();
  helper.start();
  const child = sp.last();
  const p = helper.request('toggle', { id: 'Spotify.exe' });
  assert.equal(child.written.length, 0, 'todavía no está listo');
  child.line(READY);
  assert.deepEqual(child.commands(), [{ cmd: 'toggle', req: 1, id: 'Spotify.exe' }]);
  child.line({ t: 'result', req: 1, ok: true, error: null });
  assert.deepEqual(await p, { t: 'result', req: 1, ok: true, error: null });
  const p2 = helper.request('next', { id: 'Spotify.exe' });
  child.line({ t: 'result', req: 2, ok: false, error: 'rejected' });
  assert.equal((await p2).error, 'rejected');
});

test('comandos: tiempo agotado, comando inválido y sin proceso', async () => {
  const { sp, clock, helper } = setup({ requestTimeoutMs: 3000 });
  await assert.rejects(helper.request('next', { id: 'x' }), { code: 'unavailable' });
  helper.start();
  sp.last().line(READY);
  const p = helper.request('next', { id: 'x' });
  clock.advance(3001);
  await assert.rejects(p, { code: 'timeout' });
  await assert.rejects(helper.request('next', {}), { code: 'badCommand' });
});

test('se cae: reintenta con espera creciente y rechaza lo pendiente', async () => {
  const { sp, clock, helper } = setup();
  helper.start();
  sp.last().line(READY);
  const p = helper.request('next', { id: 'x' });
  sp.last().emit('exit', 1);
  await assert.rejects(p, { code: 'unavailable' });
  assert.equal(helper.status, 'retrying');
  assert.equal(helper.info().retryAt, clock.now() + 1000);
  clock.advance(999);
  assert.equal(sp.children.length, 1);
  clock.advance(1);
  assert.equal(sp.children.length, 2, 'reabrió al segundo');
  sp.last().emit('exit', 1);
  clock.advance(1999);
  assert.equal(sp.children.length, 2);
  clock.advance(1);
  assert.equal(sp.children.length, 3, 'después esperó 2 s');
  sp.last().emit('exit', 1);
  clock.advance(4000);
  assert.equal(sp.children.length, 4, 'y después 4 s');
});

test('si anduvo bien un rato, la espera vuelve a la mínima', () => {
  const { sp, clock, helper } = setup({ stableMs: 60000 });
  helper.start();
  sp.last().emit('exit', 1);
  clock.advance(1000);
  sp.last().emit('exit', 1);
  clock.advance(2000);
  sp.last().line(READY);
  clock.advance(120000);
  sp.last().emit('exit', 1);
  assert.equal(helper.info().retryAt - clock.now(), 1000);
});

test('error al abrir PowerShell (ENOENT o spawn que lanza) también reintenta', () => {
  const clock = fakeClock();
  let calls = 0;
  const helper = new Helper({
    spawn: () => {
      calls++;
      throw new Error('spawn powershell.exe ENOENT');
    },
    command: () => ({ file: 'powershell.exe', args: [], env: {} }),
    now: clock.now,
    timers: clock.timers,
  });
  helper.start();
  assert.equal(helper.status, 'retrying');
  clock.advance(1000);
  assert.equal(calls, 2);
  const sp = setup();
  sp.helper.start();
  sp.sp.last().emit('error', new Error('ENOENT'));
  sp.sp.last().emit('exit', null); // no cuenta dos veces
  assert.equal(sp.helper.status, 'retrying');
  assert.equal(sp.helper.backoff.failures, 1);
});

test('Windows sin SMTC: queda "unsupported" y no se reabre', () => {
  const { sp, clock, helper } = setup();
  helper.start();
  sp.last().line({ t: 'ready', v: 1, smtc: false, audio: true, error: 'Unable to find type' });
  assert.equal(helper.status, 'unsupported');
  sp.last().emit('exit', 3);
  clock.advance(120000);
  assert.equal(sp.children.length, 1);
  helper.start();
  assert.equal(sp.children.length, 1);
  assert.equal(helper.status, 'unsupported');
});

test('no queda listo a tiempo: se mata y se reintenta', () => {
  const { sp, clock, helper } = setup({ readyTimeoutMs: 5000 });
  helper.start();
  clock.advance(5000);
  assert.equal(sp.children[0].killed, true);
  assert.equal(helper.status, 'retrying');
  clock.advance(1000);
  assert.equal(sp.children.length, 2);
});

test('stop: pide salir, cierra stdin y mata si no sale; no se reabre', () => {
  const { sp, clock, helper, statuses } = setup({ killAfterMs: 2000 });
  helper.start();
  const child = sp.last();
  child.line(READY);
  helper.stop();
  assert.deepEqual(child.commands().pop(), { cmd: 'quit' });
  assert.equal(child.ended, true);
  assert.equal(helper.status, 'stopping');
  clock.advance(2000);
  assert.equal(child.killed, true);
  assert.equal(helper.status, 'idle');
  clock.advance(60000);
  assert.equal(sp.children.length, 1);
  assert.deepEqual(statuses, ['starting', 'ready', 'stopping', 'idle']);
});

test('stop y start enseguida: se reabre apenas termina el anterior', () => {
  const { sp, helper } = setup();
  helper.start();
  sp.last().line(READY);
  helper.stop();
  helper.start();
  assert.equal(sp.children.length, 1, 'todavía no terminó');
  sp.last().emit('exit', 0);
  assert.equal(sp.children.length, 2);
  assert.equal(helper.status, 'starting');
});

test('stop mientras espera para reintentar cancela el reintento; retryNow no espera', () => {
  const { sp, clock, helper } = setup();
  helper.start();
  sp.last().emit('exit', 1);
  helper.stop();
  assert.equal(helper.status, 'idle');
  clock.advance(60000);
  assert.equal(sp.children.length, 1);
  helper.start();
  sp.last().emit('exit', 1);
  sp.last().emit('exit', 1);
  assert.equal(helper.status, 'retrying');
  assert.equal(helper.retryNow(), true);
  assert.equal(sp.children.length, 3);
  assert.equal(helper.retryNow(), false, 'solo cuando está esperando');
});

test('notify: solo con el ayudante listo', () => {
  const { sp, helper } = setup();
  assert.equal(helper.notify('poll'), false);
  helper.start();
  sp.last().line(READY);
  assert.equal(helper.notify('poll'), true);
  assert.deepEqual(sp.last().commands(), [{ cmd: 'poll' }]);
});
