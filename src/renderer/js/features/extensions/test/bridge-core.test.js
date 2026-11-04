// Validación del puente: mensajes malformados, permisos faltantes, tamaños y frecuencia.
// node --test "src/renderer/js/features/extensions/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, parseEnvelope, checkJson, cleanText, instanceView, gameStateView, createLimiter, LIMITS, ROUTES, METHOD_NAMES } from '../bridge-core.js';

const ALL = ['storage', 'notify', 'read.instances', 'read.gameState', 'action.openPage', 'action.launchInstance'];

function bridge(permissions = ALL, over = {}, now) {
  const calls = [];
  const handlers = {
    storage: async (op, key, value) => {
      calls.push(['storage', op, key, value]);
      return op === 'get' ? { guardado: 1 } : true;
    },
    notify: (title, text) => {
      calls.push(['notify', title, text]);
      return true;
    },
    instances: () => [{ id: 'a', name: 'Mi mundo', mcVersion: '1.21', loader: 'fabric', dir: 'C:/Users/secreto', java: { path: 'x' }, modrinth: {} }],
    gameState: () => ({ running: false, instances: [] }),
    openPage: (route) => {
      calls.push(['openPage', route]);
      return true;
    },
    launchInstance: (id) => {
      calls.push(['launch', id]);
      return { launched: true };
    },
    ...over,
  };
  return { core: createBridge({ permissions, handlers, now }), calls };
}
const req = (method, params, id = 1) => ({ venus: 1, id, method, params });

test('mensajes que no son del esquema se ignoran sin responder', async () => {
  const { core, calls } = bridge();
  for (const bad of [null, undefined, 1, 'hola', [], true, new Date(), new Map(), {}, { venus: 2, id: 1, method: 'x' }, { venus: '1', id: 1 }, { venus: 1 }, { venus: 1, id: {} }, { venus: 1, id: 1.5 }, { venus: 1, id: '' }, { venus: 1, id: 'x'.repeat(41) }, { venus: 1, id: null }]) {
    assert.equal(await core.handle(bad), null);
  }
  assert.equal(calls.length, 0);
});

test('un método desconocido o con la forma mal se rechaza', async () => {
  const { core, calls } = bridge();
  const code = async (msg) => (await core.handle(msg)).error;
  assert.equal(await code(req('accounts.list')), 'unknown_method');
  assert.equal(await code(req('__proto__')), 'unknown_method');
  assert.equal(await code(req('constructor')), 'unknown_method');
  assert.equal(await code({ venus: 1, id: 1, method: 7 }), 'bad_request');
  assert.equal(await code({ venus: 1, id: 1, method: 'x'.repeat(41) }), 'bad_request');
  assert.equal(await code({ venus: 1, id: 1, method: 'game.state', extra: 1 }), 'bad_request');
  assert.equal(await code(req('game.state', 'no')), 'bad_request');
  assert.equal(await code(req('game.state', [])), 'bad_request');
  assert.equal(await code(req('game.state', { otro: 1 })), 'bad_request');
  assert.equal(await code(req('storage.get', {})), 'bad_request');
  assert.equal(await code(req('storage.get', { key: 7 })), 'bad_request');
  assert.equal(await code(req('storage.get', { key: '../x' })), 'bad_request');
  assert.equal(await code(req('storage.get', { key: '__proto__' })), 'bad_request');
  assert.equal(await code(req('storage.get', { key: 'x'.repeat(65) })), 'bad_request');
  assert.equal(await code(req('storage.get', { key: 'k', extensionId: 'otra' })), 'bad_request');
  assert.equal(await code(req('notify.show', { title: 7 })), 'bad_request');
  assert.equal(await code(req('notify.show', { title: '' })), 'bad_request');
  assert.equal(await code(req('notify.show', { title: 'x'.repeat(1000) })), 'bad_request');
  assert.equal(await code(req('notify.show', { title: '   ' })), 'bad_request');
  assert.equal(await code(req('launcher.launchInstance', { instanceId: '../../x' })), 'bad_request');
  assert.equal(calls.length, 0);
});

test('cada pedido exige su permiso', async () => {
  const { core, calls } = bridge([]);
  const params = { 'storage.get': { key: 'k' }, 'storage.set': { key: 'k', value: 1 }, 'storage.remove': { key: 'k' }, 'notify.show': { title: 't' }, 'launcher.openPage': { route: 'home' }, 'launcher.launchInstance': { instanceId: 'a' } };
  for (const method of METHOD_NAMES) {
    const res = await core.handle(req(method, params[method]));
    assert.deepEqual(res, { venus: 1, id: 1, ok: false, error: 'permission_denied' }, method);
  }
  assert.equal(calls.length, 0);
  // Un permiso no abre los demás
  const only = bridge(['storage']);
  assert.equal((await only.core.handle(req('storage.get', { key: 'k' }))).ok, true);
  assert.equal((await only.core.handle(req('notify.show', { title: 't' }))).error, 'permission_denied');
});

test('lo pedido con permiso llega y vuelve como copia plana', async () => {
  const stored = { a: [1, { b: 2 }] };
  const { core, calls } = bridge(ALL, { storage: async () => stored });
  const res = await core.handle(req('storage.get', { key: 'k' }, 'id-7'));
  assert.equal(res.ok, true);
  assert.equal(res.id, 'id-7');
  assert.deepEqual(res.result, stored);
  assert.notEqual(res.result, stored);
  assert.notEqual(res.result.a, stored.a);
  assert.equal(calls.length, 0);
});

test('read.instances no deja pasar rutas ni otros datos', async () => {
  const { core } = bridge();
  const res = await core.handle(req('instances.list'));
  assert.deepEqual(res.result, [{ id: 'a', name: 'Mi mundo', version: '1.21', loader: 'fabric' }]);
  assert.ok(!JSON.stringify(res).includes('secreto'));
  assert.deepEqual(instanceView({ id: 1 }), { id: '1', name: '', version: '', loader: '' });
  assert.deepEqual(gameStateView({ a: { state: 'running', pid: 77, startedAt: 1 }, b: { state: 'preparing' } }), { running: true, instances: ['a'] });
  assert.deepEqual(gameStateView(null), { running: false, instances: [] });
});

test('action.openPage solo abre rutas de la lista blanca', async () => {
  const { core, calls } = bridge();
  for (const route of ['settings', 'admin', 'messages', 'settings/cloud', 'home/x', '../settings', 'welcome', 'extensions', 'ext-otra', 'support', 'assistant', '']) {
    assert.equal((await core.handle(req('launcher.openPage', { route }))).ok, false, route);
  }
  assert.equal(calls.length, 0);
  for (const route of ['settings', 'admin', 'messages', 'extensions', 'welcome', 'assistant', 'support']) assert.ok(!ROUTES.includes(route), route);
  const fresh = bridge();
  assert.equal((await fresh.core.handle(req('launcher.openPage', { route: 'stats' }))).ok, true);
  assert.deepEqual(fresh.calls, [['openPage', 'stats']]);
  assert.equal((await bridge().core.handle(req('launcher.openPage', { route: 'settings' }))).error, 'not_allowed');
});

test('storage.set: tamaños y tipos', async () => {
  const { core, calls } = bridge();
  const code = async (value) => (await core.handle(req('storage.set', { key: 'k', value }))).error;
  assert.equal(await code('x'.repeat(LIMITS.valueChars + 1)), 'too_large');
  assert.equal(await code(new Array(LIMITS.valueNodes + 1).fill(0)), 'too_large');
  assert.equal(await code(new Date()), 'too_large');
  assert.equal(await code(new Map()), 'too_large');
  assert.equal(await code(new Uint8Array(4)), 'too_large');
  assert.equal(await code(Infinity), 'too_large');
  assert.equal(await code(10n), 'too_large');
  assert.equal(await code(JSON.parse('{"__proto__":{"x":1}}')), 'too_large');
  let deep = 1;
  for (let i = 0; i < LIMITS.valueDepth + 2; i++) deep = [deep];
  assert.equal(await code(deep), 'too_large');
  const cycle = {};
  cycle.self = cycle;
  assert.equal(await code(cycle), 'too_large');
  assert.equal(calls.length, 0);
  assert.equal((await core.handle(req('storage.set', { key: 'k', value: { a: [1, 'dos', null, true] } }))).ok, true);
  assert.equal(calls.length, 1);
});

test('checkJson corta apenas se pasa del presupuesto', () => {
  const budget = { nodes: 3, chars: 10 };
  assert.equal(checkJson([1, 2, 3, 4, 5], budget), false);
  assert.equal(checkJson({ a: 'x'.repeat(5) }), true);
  assert.equal(checkJson(() => 1), false);
  assert.equal(checkJson(undefined), false);
});

test('los textos de los avisos se limpian y se cortan', async () => {
  const { core, calls } = bridge();
  await core.handle(req('notify.show', { title: 'Hola\u202e<img src=x onerror=alert(1)>', text: 'x'.repeat(500) }));
  const [, title, text] = calls[0];
  assert.ok(title.length <= LIMITS.notifyTitle);
  assert.ok(!title.includes('\u202e'));
  assert.equal(text.length, LIMITS.notifyText);
  assert.equal(cleanText('a\u200bb\nc', 10), 'a b c');
});

test('frecuencia: admit descarta y después corta', () => {
  let clock = 0;
  const { core } = bridge(ALL, {}, () => clock);
  const seen = { ok: 0, drop: 0, flood: 0 };
  for (let i = 0; i < LIMITS.flood + 5; i++) seen[core.admit()] += 1;
  assert.equal(seen.ok, LIMITS.burst);
  assert.equal(seen.drop, LIMITS.flood - LIMITS.burst);
  assert.equal(seen.flood, 5);
  clock += LIMITS.windowMs;
  assert.equal(core.admit(), 'ok');
});

test('tope por minuto de avisos, páginas y lanzamientos', async () => {
  let clock = 0;
  const { core, calls } = bridge(ALL, {}, () => clock);
  const send = (m, p) => core.handle(req(m, p));
  for (let i = 0; i < LIMITS.notifyPerMinute; i++) assert.equal((await send('notify.show', { title: 't' })).ok, true);
  assert.equal((await send('notify.show', { title: 't' })).error, 'rate_limited');
  for (let i = 0; i < LIMITS.openPagePerMinute; i++) assert.equal((await send('launcher.openPage', { route: 'home' })).ok, true);
  assert.equal((await send('launcher.openPage', { route: 'home' })).error, 'rate_limited');
  for (let i = 0; i < LIMITS.launchPerMinute; i++) assert.equal((await send('launcher.launchInstance', { instanceId: 'a' })).ok, true);
  assert.equal((await send('launcher.launchInstance', { instanceId: 'a' })).error, 'rate_limited');
  const before = calls.length;
  clock += 60000;
  assert.equal((await send('notify.show', { title: 't' })).ok, true);
  assert.equal(calls.length, before + 1);
});

test('pedidos en curso: no se acumulan sin límite', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { core } = bridge(ALL, { storage: () => gate });
  const pending = Array.from({ length: LIMITS.inFlight }, (_, i) => core.handle(req('storage.keys', undefined, i)));
  assert.equal((await core.handle(req('storage.keys', undefined, 99))).error, 'busy');
  release(true);
  for (const r of await Promise.all(pending)) assert.equal(r.ok, true);
});

test('un error de adentro no se le cuenta a la extensión', async () => {
  const { core } = bridge(ALL, {
    storage: async () => {
      throw new Error('C:/Users/secreto/.venuslauncher/token.json');
    },
    gameState: () => {
      throw Object.assign(new Error('x'), { code: 'quota_exceeded' });
    },
    instances: () => {
      throw Object.assign(new Error('x'), { code: 'CODIGO_RARO' });
    },
  });
  const res = await core.handle(req('storage.keys'));
  assert.deepEqual(res, { venus: 1, id: 1, ok: false, error: 'internal' });
  assert.equal((await core.handle(req('game.state'))).error, 'quota_exceeded');
  assert.equal((await core.handle(req('instances.list'))).error, 'internal');
});

test('createLimiter vuelve a abrir al pasar la ventana', () => {
  let clock = 0;
  const lim = createLimiter(2, 100, () => clock);
  assert.equal(lim.take(), true);
  assert.equal(lim.take(), true);
  assert.equal(lim.take(), false);
  clock = 100;
  assert.equal(lim.take(), true);
});

test('parseEnvelope no se deja engañar por objetos con otro prototipo', () => {
  class Falso {
    venus = 1;
    id = 1;
    method = 'game.state';
  }
  assert.equal(parseEnvelope(new Falso()), null);
});
