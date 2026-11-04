'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createCloudClient } = require('../cloud');

const CFG = { configured: true, url: 'https://project.test', anonKey: 'public-test-key' };
const SESSION = { access_token: 'session-for-test', user: { id: 'test-user' }, expires_at: 2000 };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function setup(overrides = {}) {
  const calls = [];
  let session = SESSION;
  let refreshes = 0;
  const client = createCloudClient({
    fetch: async (url, init) => { calls.push({ url, init }); return json({ configured: true }); },
    cloudConfig: () => CFG, readSession: async () => session,
    refreshSession: () => { refreshes++; }, t: (key) => key, now: () => 100000,
    sleep: async () => {}, ...overrides,
  });
  return { client, calls, setSession: (s) => { session = s; }, refreshes: () => refreshes };
}

test('estado público sin sesión ni claves privadas; actualización forzada después de configurar', async () => {
  let configured = false;
  let requests = 0;
  const { client } = setup({ fetch: async (url, init) => {
    requests++;
    assert.equal(url, CFG.url + '/rest/v1/rpc/curseforge_status');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers['x-api-key'], undefined);
    return json({ configured });
  } });
  assert.equal(await client.configured(), false);
  configured = true;
  assert.equal(await client.configured(), false);
  assert.equal(await client.configured({ force: true }), true);
  assert.equal(requests, 2);
});

test('consulta con sesión envía el contrato al servidor de Venus', async () => {
  const { client, calls } = setup();
  await client.request('/v1/mods', { method: 'POST', body: { modIds: [12], filterPcOnly: true } });
  assert.equal(calls[0].url, CFG.url + '/functions/v1/curseforge');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer session-for-test');
  assert.equal(calls[0].init.headers['x-api-key'], undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), { method: 'POST', path: '/v1/mods', body: { modIds: [12], filterPcOnly: true } });
  assert.equal(calls[0].init.redirect, 'error');
});

test('sin sesión pide iniciar sesión antes de consultar el catálogo', async () => {
  const { client, calls } = setup({ readSession: async () => null });
  await assert.rejects(client.request('/v1/categories?gameId=432'), { code: 'noSession', message: 'curseforge.errSignIn' });
  assert.equal(calls.length, 0);
});

test('sesión vencida espera la renovación compartida de la interfaz', async () => {
  let current = { ...SESSION, expires_at: 1 };
  let renewals = 0;
  const { client, calls } = setup({
    readSession: async () => current,
    refreshSession: () => { renewals++; },
    sleep: async () => { current = { ...SESSION, access_token: 'renewed-test-session' }; },
  });
  await Promise.all([client.request('/v1/mods/1'), client.request('/v1/mods/2')]);
  assert.equal(renewals, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.init.headers.Authorization === 'Bearer renewed-test-session'));
});

test('cerrar sesión o cambiar cuenta durante la renovación cancela el pedido anterior', async () => {
  for (const next of [null, { ...SESSION, user: { id: 'another-user' } }]) {
    let current = { ...SESSION, expires_at: 1 };
    const { client, calls } = setup({ readSession: async () => current, sleep: async () => { current = next; } });
    await assert.rejects(client.request('/v1/mods/1'), { code: 'noSession' });
    assert.equal(calls.length, 0);
  }
});

test('sesión ilegible y backend sin configurar no disparan consultas', async () => {
  const invalid = setup({ readSession: async () => '{' });
  await assert.rejects(invalid.client.request('/v1/mods/1'), { code: 'noSession' });
  const missing = setup({ cloudConfig: () => ({ configured: false }) });
  assert.equal(await missing.client.configured(), false);
  await assert.rejects(missing.client.request('/v1/mods/1'), { code: 'nokey' });
  assert.equal(missing.calls.length + invalid.calls.length, 0);
});

function apiSetup({ configured = true, compiled = '', reply = () => json({ data: [] }), session = SESSION } = {}) {
  const calls = [];
  const exports = {};
  const context = {
    module: { exports }, exports, AbortSignal, structuredClone, setTimeout,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/rpc/curseforge_status')) return json({ configured });
      return reply(url, init);
    },
    require: (name) => {
      const modules = {
        '../../core/app-config': { get: () => ({ curseforgeApiKey: compiled }) },
        '../../core/http': { getUserAgent: () => 'VenusLauncher/test' },
        '../../core/i18n': { t: (key) => key },
        '../../core/util': { sleep: async () => {} },
        '../../core/search-filters': {},
        './cloud': { createCloudClient: (deps) => createCloudClient({ ...deps, now: () => 100000 }) },
        '../../core/cloud-defaults': { config: () => CFG },
        '../../core/secure': { get: async () => session },
      };
      if (!(name in modules)) throw new Error('Dependencia no prevista: ' + name);
      return modules[name];
    },
    process: { env: {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8'), context, { filename: 'curseforge/api.js' });
  return { api: context.module.exports, calls };
}

test('la clave del panel tiene prioridad sobre la compilada y no viaja al cliente', async () => {
  const { api, calls } = apiSetup({ compiled: 'legacy-test-key' });
  assert.equal(await api.hasKey(), true);
  await api.request('/v1/mods/12');
  const catalog = calls.filter((c) => !c.url.includes('/rpc/'));
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].url, CFG.url + '/functions/v1/curseforge');
  assert.equal(catalog[0].init.headers['x-api-key'], undefined);
});

test('sin configuración central se conserva el catálogo de un build anterior', async () => {
  const { api, calls } = apiSetup({ configured: false, compiled: 'legacy-test-key' });
  await api.request('/v1/mods/12');
  const last = calls.at(-1);
  assert.equal(last.url, 'https://api.curseforge.com/v1/mods/12');
  assert.equal(last.init.headers['x-api-key'], 'legacy-test-key');
  assert.equal(last.init.headers.Authorization, undefined);
});

test('configuración retirada en el servidor avisa sin reintentar tres veces', async () => {
  const { api, calls } = apiSetup({ reply: () => json({ error: { code: 'not_configured' } }, 503) });
  await assert.rejects(api.request('/v1/mods/12'), { code: 'nokey' });
  assert.equal(calls.filter((c) => c.url.includes('/functions/')).length, 1);
});

test('HTTP 401 central pide sesión y sin ninguna clave indica indisponible', async () => {
  const session = apiSetup({ reply: () => json({ error: { code: 'unauthorized' } }, 401) });
  await assert.rejects(session.api.request('/v1/mods/12'), { code: 'noSession' });
  const empty = apiSetup({ configured: false });
  await assert.rejects(empty.api.request('/v1/mods/12'), { code: 'nokey' });
  assert.equal(empty.calls.filter((c) => c.url.includes('/functions/')).length, 0);
});
