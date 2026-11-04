'use strict';
// Ciclo de vida con un host simulado: no se abre ningún puerto ni se inicia Minecraft.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(t, get = async () => ({ id: 'demo' })) {
  const file = path.resolve(__dirname, '../../serverremote.js');
  const realRequire = createRequire(file);
  const made = [];
  const openings = new Map();
  const opening = (index) => {
    if (!openings.has(index)) openings.set(index, deferred());
    return openings.get(index);
  };
  const quit = [];
  const sent = [];
  const servers = { get, logs: () => [], venusLog() {}, events: { on() {} } };
  const stubs = {
    '../core/servers': servers,
    '../core/tasks': {},
    '../core/i18n': { t: (key) => key, getLanguage: () => 'es' },
    './netplay/netinfo': { localInterfaces: () => [{ name: 'Prueba', kind: 'lan', address: '192.168.1.5' }] },
    './serverremote/qr': { encodeQr: () => ({ size: 1, rows: [] }) },
    './serverremote/host': {
      createRemoteHost({ onEvent }) {
        const ready = deferred();
        const index = made.length;
        const host = {
          ready, stopped: false,
          start() { opening(index).resolve(); return ready.promise; },
          stop(reason) { if (this.stopped) return; this.stopped = true; onEvent('stopped', { reason }); },
          isStopped() { return this.stopped; },
          info() { return { on: !this.stopped, address: '192.168.1.5', url: 'simulated-session' }; },
          pushLine() {},
        };
        made.push(host);
        return host;
      },
    },
  };
  const context = { module: { exports: {} }, require: (id) => stubs[id] || realRequire(id), process: { env: {} }, console, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const remote = context.module.exports;
  remote.register({ app: {}, handle() {}, send: (...args) => sent.push(args), onQuit: (fn) => quit.push(fn) });
  t.after(() => quit.forEach((fn) => fn()));
  return { remote, made, sent, waitForHost: (index = 0) => opening(index).promise };
}

test('dos encendidos simultáneos comparten el mismo host', async (t) => {
  const { remote, made, waitForHost } = fixture(t);
  const first = remote.start('demo');
  const second = remote.start('demo');
  await waitForHost();
  assert.equal(made.length, 1);
  made[0].ready.resolve();
  assert.equal((await first).on, true);
  assert.equal((await second).on, true);
  assert.equal(remote.stopFor('demo'), true);
  assert.equal(made[0].stopped, true);
  assert.equal(remote.status('demo').on, false);
});

test('apagar durante el encendido no deja un host activo', async (t) => {
  const { remote, made, sent, waitForHost } = fixture(t);
  const pending = remote.start('demo');
  await waitForHost();
  assert.equal(remote.stopFor('demo'), true);
  made[0].ready.resolve();
  assert.equal((await pending).on, false);
  assert.equal(made[0].stopped, true);
  assert.equal(remote.status('demo').on, false);
  assert.equal(sent.some((args) => args[2]?.kind === 'started'), false);
});

test('cerrar cancela también los inicios que esperan los datos del servidor', async (t) => {
  const lookup = deferred();
  const { remote, made } = fixture(t, () => lookup.promise);
  const pending = remote.start('demo');
  remote.stopAll('quit');
  lookup.resolve({ id: 'demo' });
  assert.equal((await pending).on, false);
  assert.equal(made.length, 0);
});

test('un inicio fallido se cierra y permite volver a intentar', async (t) => {
  const { remote, made, waitForHost } = fixture(t);
  const first = remote.start('demo');
  const rejected = assert.rejects(first, { code: 'listen' });
  await waitForHost();
  made[0].ready.reject(new Error('fallo simulado'));
  await rejected;
  assert.equal(made[0].stopped, true);
  const retry = remote.start('demo');
  await waitForHost(1);
  assert.equal(made.length, 2);
  made[1].ready.resolve();
  assert.equal((await retry).on, true);
});
