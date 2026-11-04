'use strict';
// El botón de los avisos: cuándo se pide el permiso y qué se anota en el servidor, con el navegador de mentira.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const loaded = import('../js/push.js');
const KEY = 'BAEC_-0'; // bytes 4, 1, 2, 255, 237
const ANDROID = 'Mozilla/5.0 (Linux; Android 14)';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/celular-de-prueba';

function world({ permission = 'default', answer = 'granted', sub = null, keyStatus = 200, rpcError = null, ready = true } = {}) {
  const order = [];
  const rpcs = [];
  const state = { sub };
  const Notification = {
    permission,
    requestPermission: async () => {
      order.push('permiso');
      Notification.permission = answer;
      return answer;
    },
  };
  const makeSub = (endpoint, bytes) => ({
    endpoint,
    options: { applicationServerKey: new Uint8Array(bytes).buffer },
    unsubscribe: async () => {
      order.push('baja');
      state.sub = null;
    },
  });
  if (sub) state.sub = makeSub(sub.endpoint, sub.key);
  const pushManager = {
    getSubscription: async () => state.sub,
    subscribe: async ({ userVisibleOnly, applicationServerKey }) => {
      order.push('alta');
      assert.equal(userVisibleOnly, true);
      state.sub = makeSub(ENDPOINT, [...applicationServerKey]);
      return state.sub;
    },
  };
  const nav = {
    userAgent: ANDROID,
    platform: 'Linux',
    maxTouchPoints: 5,
    serviceWorker: { ready: ready ? Promise.resolve({ pushManager }) : new Promise(() => {}) },
  };
  const client = {
    rpc: async (name, args) => {
      rpcs.push({ name, args });
      return { data: true, error: rpcError };
    },
  };
  const memory = new Map();
  const idb = { get: async (k) => memory.get(k) ?? null, set: async (k, v) => void memory.set(k, v) };
  const fetchFn = async (url) => {
    order.push('clave');
    assert.equal(url, 'https://proyecto.supabase.co/functions/v1/push-notify');
    return new Response(JSON.stringify(keyStatus === 200 ? { publicKey: KEY } : {}), { status: keyStatus });
  };
  return {
    order,
    rpcs,
    state,
    Notification,
    make: async () => {
      const { createPush } = await loaded;
      return createPush({ client, config: { pushFunction: 'https://proyecto.supabase.co/functions/v1/push-notify' }, idb, deps: { nav, notification: Notification, fetchFn, standalone: () => false, hasPush: true } });
    },
  };
}

test('mirar el estado nunca pide permiso', async () => {
  const w = world();
  const push = await w.make();
  assert.deepEqual(await push.status(), { support: 'ok', permission: 'default', enabled: false });
  assert.ok(!w.order.includes('permiso'));
});

test('activar: el permiso va primero, y se anota solo el endpoint', async () => {
  const w = world();
  const push = await w.make();
  await push.enable();
  assert.equal(w.order[0], 'permiso');
  assert.deepEqual(w.order, ['permiso', 'clave', 'alta']);
  assert.deepEqual(w.rpcs, [{ name: 'push_subscribe', args: { p_endpoint: ENDPOINT, p_label: 'Android' } }]);
  assert.equal((await push.status()).enabled, true);
});

test('si dice que no: no se anota nada', async () => {
  const w = world({ answer: 'denied' });
  const push = await w.make();
  await assert.rejects(() => push.enable(), (e) => e.code === 'push_denied');
  assert.equal(w.rpcs.length, 0);
  assert.ok(!w.order.includes('alta'));
  assert.equal((await push.status()).permission, 'denied');
});

test('sin la Edge Function desplegada: avisa que no está disponible', async () => {
  const w = world({ keyStatus: 404 });
  const push = await w.make();
  await assert.rejects(() => push.enable(), (e) => e.code === 'push_unavailable');
  assert.equal(w.rpcs.length, 0);
});

test('sin la migración: el error llega para mostrar el aviso', async () => {
  const w = world({ rpcError: { code: 'PGRST202', message: 'Could not find the function' } });
  const push = await w.make();
  await assert.rejects(() => push.enable(), (e) => e.code === 'PGRST202');
});

test('desactivar: baja en el navegador y en el servidor', async () => {
  const w = world({ permission: 'granted', sub: { endpoint: ENDPOINT, key: [4, 1, 2, 255, 237] } });
  const push = await w.make();
  await push.disable();
  assert.deepEqual(w.order, ['baja']);
  assert.deepEqual(w.rpcs, [{ name: 'push_unsubscribe', args: { p_endpoint: ENDPOINT } }]);
  assert.equal(w.state.sub, null);
});

test('al abrir: refresca el mismo celular y corrige si cambió la clave', async () => {
  const same = world({ permission: 'granted', sub: { endpoint: ENDPOINT, key: [4, 1, 2, 255, 237] } });
  await (await same.make()).refresh();
  assert.deepEqual(same.rpcs.map((r) => r.name), ['push_subscribe']);
  assert.ok(!same.order.includes('permiso'));

  const old = 'https://fcm.googleapis.com/fcm/send/clave-vieja';
  const rotated = world({ permission: 'granted', sub: { endpoint: old, key: [9, 9] } });
  await (await rotated.make()).refresh();
  assert.deepEqual(rotated.rpcs, [
    { name: 'push_unsubscribe', args: { p_endpoint: old } },
    { name: 'push_subscribe', args: { p_endpoint: ENDPOINT, p_label: 'Android' } },
  ]);

  const none = world({ permission: 'default' });
  await (await none.make()).refresh();
  assert.equal(none.rpcs.length, 0);
  assert.ok(!none.order.includes('permiso'));
});

test('el texto en el aviso viene prendido y se puede apagar', async () => {
  const w = world();
  const push = await w.make();
  assert.equal(await push.previewEnabled(), true);
  await push.setPreview(false);
  assert.equal(await push.previewEnabled(), false);
});

test('fuera de un toque nadie pide permiso', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const files = ['js/main.js', 'js/screens/inbox.js', 'js/screens/account.js', 'sw.js', 'js/store.js'];
  for (const f of files) assert.ok(!fs.readFileSync(path.join(root, f), 'utf8').includes('requestPermission'), f);
  const src = fs.readFileSync(path.join(root, 'js/push.js'), 'utf8');
  assert.equal([...src.matchAll(/requestPermission\(/g)].length, 1);
  assert.match(fs.readFileSync(path.join(root, 'js/screens/inbox.js'), 'utf8'), /onclick: onTap\(\(\) => push\.enable\(\)/);
});
