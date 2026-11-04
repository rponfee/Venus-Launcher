'use strict';
// Service worker ejecutado en VM: no usa red, cuentas ni navegador reales.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');

function world(windows = []) {
  const handlers = {};
  const deleted = [], shown = [], posted = [], opened = [], calls = [];
  const memory = new Map();
  const auth = { getSession: async () => ({ data: { session: null } }) };
  const client = { auth, rpc: async (name) => { calls.push(name); return { error: null }; } };
  const cache = { match: async () => ({ headers: new Headers({ etag: 'same' }) }), put: async () => assert.fail('no reescribir lo que no cambió') };
  const self = {
    location: { origin: 'https://venus.example' },
    navigator: { userAgent: 'Android', language: 'es' },
    registration: { scope: 'https://venus.example/app/', showNotification: async (...args) => shown.push(args) },
    clients: { matchAll: async () => windows, claim: async () => {}, openWindow: async (url) => opened.push(url) },
    VenusApp: {
      config: { url: 'https://proyecto.example' },
      idb: { get: async (k) => memory.get(k), set: async (k, v) => memory.set(k, v) },
      session: { createClient: () => client },
      texts: { pickLang: () => 'es', translator: () => (k) => k },
      notify: { buildNotification: () => ({ title: 'Venus', body: 'Novedades', tag: 'test', hash: '#/inbox' }), safeHash: (hash) => hash === '#/friends' ? hash : '#/inbox' },
    },
    addEventListener: (name, fn) => { handlers[name] = fn; },
  };
  const context = { self, URL, Headers, Uint8Array, atob, setTimeout, clearTimeout, console: { warn() {} }, importScripts() {},
    caches: { keys: async () => ['venus-app-0', 'venus-app-1', 'web-gallery'], delete: async (k) => deleted.push(k), open: async () => cache, match: async () => 'shell' },
    fetch: async () => ({ ok: true, headers: new Headers({ etag: 'same' }) }),
  };
  vm.runInNewContext(source, context);
  const fire = async (name, data = {}) => {
    const waits = [];
    let response;
    handlers[name]({ ...data, waitUntil: (p) => waits.push(p), respondWith: (p) => { response = p; } });
    await Promise.all(waits);
    return response;
  };
  const window = (url, visible = false) => ({ url, visibilityState: visible ? 'visible' : 'hidden', focused: visible, postMessage: (msg) => posted.push({ url, msg }), focus: async () => {} });
  return { fire, window, deleted, shown, posted, opened, client, calls, memory };
}

test('activar conserva las cachés de la web y elimina solo versiones viejas de la PWA', async () => {
  const w = world();
  await w.fire('activate');
  assert.deepEqual(w.deleted, ['venus-app-0']);
});

test('una pestaña de la web visible no suprime el aviso ni recibe mensajes de la PWA', async () => {
  const windows = [];
  const w = world(windows);
  windows.push(w.window('https://venus.example/', true), w.window('https://venus.example/app/#/friends'));
  await w.fire('push');
  assert.equal(w.shown.length, 1);
  assert.deepEqual(w.posted.map((x) => x.url), ['https://venus.example/app/#/friends']);
});

test('con la PWA visible en Android se actualiza su bandeja sin aviso duplicado', async () => {
  const windows = [];
  const w = world(windows);
  windows.push(w.window('https://venus.example/app/', true));
  await w.fire('push');
  assert.equal(w.shown.length, 0);
  assert.equal(w.posted.length, 1);
});

test('tocar un aviso abre /app/ si solo está abierta la web', async () => {
  const windows = [];
  const w = world(windows);
  windows.push(w.window('https://venus.example/', true));
  await w.fire('notificationclick', { notification: { data: { hash: '#/friends' }, close() {} } });
  assert.deepEqual(w.opened, ['https://venus.example/app/#/friends']);
});

test('navegar conserva la cáscara y no reescribe archivos con el mismo ETag', async () => {
  const w = world();
  assert.equal(await w.fire('fetch', { request: { method: 'GET', mode: 'navigate', url: 'https://venus.example/app/?fake=1' } }), 'shell');
  assert.ok(w.memory.has('shell.checked'));
  assert.equal(await w.fire('fetch', { request: { method: 'GET', mode: 'navigate', url: 'https://venus.example/' } }), undefined);
});

test('si renovar la suscripción falla no borra la anterior en la base', async () => {
  const w = world();
  w.client.auth.getSession = async () => ({ data: { session: { user: { id: 'simulado' } } } });
  w.client.rpc = async (name) => { w.calls.push(name); return { error: { message: 'sin red' } }; };
  await w.fire('pushsubscriptionchange', { oldSubscription: { endpoint: 'anterior' }, newSubscription: { endpoint: 'nueva' } });
  assert.deepEqual(w.calls, ['push_subscribe']);
});
