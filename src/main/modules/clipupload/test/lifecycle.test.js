'use strict';
// Registro IPC real con proveedores y almacenamiento en memoria; no abre navegador ni usa cuentas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => new Promise(r => setImmediate(r));

function rig(over = {}) {
  const handles = new Map();
  const loops = [];
  const writes = [];
  const exchange = deferred();
  const ready = [];
  let opened = 0;
  const deps = {
    'fs/promises': {},
    '../core/secure': { set: async (...args) => writes.push(args) },
    '../core/i18n': { t: x => x },
    './worlds/media': {},
    './clipupload/config': { get: () => ({ youtubeClientId: 'test-id' }) },
    './clipupload/youtube': { createYoutube: () => ({ authorizeUrl: () => 'https://example.test/authorize', exchange: () => exchange.promise }) },
    './clipupload/tiktok': {},
    electron: { shell: { openExternal: async () => { opened++; } } },
    './clipupload/oauth': {
      randomVerifier: () => 'test-verifier', randomState: () => 'test-state', challengeS256: () => 'test-challenge',
      startLoopback: () => {
        const result = deferred();
        result.promise.catch(() => {});
        const loop = { redirectUri: 'http://127.0.0.1:1234/', result: result.promise, resolve: result.resolve, closed: false,
          close() { this.closed = true; result.reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })); } };
        loops.push(loop);
        const start = deferred();
        ready.push(() => start.resolve(loop));
        return start.promise;
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../clipupload.js'), 'utf8'), { module, console, AbortController, require: id => { assert.ok(id in deps || id in over, id); return over[id] || deps[id]; } });
  module.exports.register({ handle: (key, fn) => handles.set(key, fn), send() {}, onQuit() {} });
  return { invoke: (key, ...args) => handles.get('clipupload:' + key)(...args), loops, ready, exchange, writes, opened: () => opened };
}

test('cancelar mientras abre el retorno no abre el navegador despues', async () => {
  const r = rig();
  const connect = r.invoke('connect', 'youtube');
  r.invoke('cancelConnect');
  r.ready[0]();
  await assert.rejects(connect, { code: 'cancelled' });
  assert.equal(r.opened(), 0);
  assert.equal(r.loops[0].closed, true);
  assert.equal(r.writes.length, 0);
});

test('cancelar durante el intercambio no guarda la cuenta', async () => {
  const r = rig();
  const connect = r.invoke('connect', 'youtube');
  r.ready[0]();
  await turn();
  r.loops[0].resolve('test-code');
  await turn();
  r.invoke('cancelConnect');
  r.exchange.resolve({ access_token: 'test-token' });
  await assert.rejects(connect, { code: 'cancelled' });
  assert.equal(r.writes.length, 0);
});

test('el cierre de una conexion anterior no pierde el control de cancelar la nueva', async () => {
  const r = rig();
  const first = r.invoke('connect', 'youtube');
  first.catch(() => {});
  r.ready[0]();
  await turn();
  const second = r.invoke('connect', 'youtube');
  second.catch(() => {});
  r.ready[1]();
  await assert.rejects(first, { code: 'cancelled' });
  await turn();
  r.invoke('cancelConnect');
  await assert.rejects(second, { code: 'cancelled' });
  assert.equal(r.loops[1].closed, true);
});


test('cancelar mientras consulta el archivo no inicia la subida despues', async () => {
  const stat = deferred(); let opens = 0;
  const r = rig({
    'fs/promises': { stat: () => stat.promise, open: async () => { opens++; } },
    './worlds/media': { checkMediaPath: () => ({ kind: 'clip', full: 'test.webm' }) },
  });
  const upload = r.invoke('upload', { jobId: 'test-job', provider: 'youtube', path: 'test.webm' });
  r.invoke('cancel', 'test-job');
  stat.resolve({ size: 100, isFile: () => true });
  await assert.rejects(upload, { code: 'cancelled' });
  assert.equal(opens, 0);
});
