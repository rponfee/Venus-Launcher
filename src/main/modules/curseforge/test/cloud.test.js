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

function apiSetup({ configured = true, status = null, compiled = '', reply = () => json({ data: [] }), session = SESSION } = {}) {
  const calls = [];
  const exports = {};
  const context = {
    module: { exports }, exports, AbortSignal, structuredClone, setTimeout,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/rpc/curseforge_status')) return status ? status(url, init) : json({ configured });
      return reply(url, init);
    },
    require: (name) => {
      const modules = {
        '../../core/app-config': { get: () => ({ curseforgeApiKey: compiled }) },
        '../../core/http': { getUserAgent: () => 'VenusLauncher/test' },
        '../../core/i18n': { t: (key) => key },
        '../../core/util': { sleep: async () => {} },
        '../../core/search-filters': require('../../../core/search-filters'),
        './cloud': { createCloudClient: (deps) => createCloudClient({ ...deps, now: () => 100000, sleep: async () => {} }) },
        '../../core/cloud-defaults': { config: () => CFG },
        '../../core/secure': { get: async () => (typeof session === 'function' ? session() : session) },
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

test('403 distingue clave del catálogo rechazada de cuenta sin permiso', async () => {
  for (const [remote, key, code] of [['badkey', 'curseforge.errBadKey', 'badkey'], ['forbidden', 'curseforge.errAccessDenied', 'forbidden']]) {
    const r = apiSetup({ reply: () => json({ error: { code: remote }, detail: 'PRIVATE_BODY' }, 403) });
    await assert.rejects(r.api.request('/v1/mods/search?gameId=432'), { code, message: key });
    assert.equal(r.calls.filter(c => c.url.includes('/functions/')).length, 1);
  }
});

// ---------- Casos de la 4.6: el estado, el respaldo y cada tipo de falla tienen su propio mensaje ----------

const plain = (value) => JSON.parse(JSON.stringify(value)); // objetos del vm: otra realm
const down = () => { throw new TypeError('fetch failed'); };
const errJson = (code, status) => json({ error: { code } }, status);
const SEARCH = '/v1/mods/search?gameId=432&classId=6&pageSize=1';
const functionCalls = (calls) => calls.filter((c) => c.url.includes('/functions/'));

test('el estado distingue configurado, sin configurar y sin poder preguntar', async () => {
  const on = apiSetup({ configured: true });
  assert.deepEqual(plain(await on.api.status()), { state: 'on', source: 'central', ready: true, signedIn: true });
  const off = apiSetup({ configured: false });
  assert.deepEqual(plain(await off.api.status()), { state: 'off', source: null, ready: false, signedIn: true });
  const unknown = apiSetup({ status: down });
  // Que la consulta de estado se caiga NO es "CurseForge no está configurado": el catálogo se intenta igual.
  assert.deepEqual(plain(await unknown.api.status()), { state: 'unknown', source: 'central', ready: true, signedIn: true });
  const server = apiSetup({ status: () => json({ message: 'maintenance' }, 503) });
  assert.equal((await server.api.status()).state, 'unknown');
  const build = apiSetup({ configured: false, compiled: 'legacy-test-key' });
  assert.deepEqual(plain(await build.api.status()), { state: 'off', source: 'build', ready: true, signedIn: true });
  const anonymous = apiSetup({ session: null });
  assert.equal((await anonymous.api.status()).signedIn, false);
});

test('si la consulta de estado falla, el pedido va igual al servidor, que contesta con precisión', async () => {
  const { api, calls } = apiSetup({ status: down, reply: () => json({ data: [{ id: 1 }] }) });
  const res = await api.request(SEARCH);
  assert.deepEqual(res, { data: [{ id: 1 }] });
  assert.equal(functionCalls(calls).length, 1);
});

test('un fallo pasajero del estado no borra lo que se sabía: se sigue con el catálogo central', async () => {
  let failing = false;
  const { api, calls } = apiSetup({ status: () => (failing ? down() : json({ configured: true })) });
  assert.equal((await api.status()).state, 'on');
  failing = true;
  assert.equal((await api.status()).state, 'on');
  await api.request(SEARCH);
  assert.equal(functionCalls(calls).length, 1);
});

test('cada falla del catálogo central llega con su propio código y mensaje', async () => {
  const cases = [
    ['sin sesión guardada', { session: null }, { code: 'noSession', message: 'curseforge.errSignIn' }],
    ['servidor sin configurar', { reply: () => errJson('not_configured', 503) }, { code: 'nokey', message: 'curseforge.errNoKey' }],
    ['403 de la cuenta', { reply: () => errJson('forbidden', 403) }, { code: 'forbidden', message: 'curseforge.errAccessDenied' }],
    ['403 clave rechazada', { reply: () => errJson('badkey', 403) }, { code: 'badkey', message: 'curseforge.errBadKey' }],
    ['403 cortado antes de la clave', { reply: () => errJson('blocked', 403) }, { code: 'blocked', message: 'curseforge.errBlocked' }],
    ['403 sin código (servidor viejo)', { reply: () => json({}, 403) }, { code: 'badkey', message: 'curseforge.errBadKey' }],
    ['429', { reply: () => json({ error: { code: 'rate_limit' } }, 429, { 'retry-after': '1' }) }, { code: 'ratelimit', message: 'curseforge.errRateLimit' }],
    ['503', { reply: () => errJson('unavailable', 503) }, { code: 'server', message: 'curseforge.errServer' }],
    ['502', { reply: () => errJson('upstream', 502) }, { code: 'server', message: 'curseforge.errServer' }],
    ['respuesta que no es JSON', { reply: () => new Response('<html>', { status: 200 }) }, { code: 'parse', message: 'curseforge.errBadResponse' }],
    ['red caída', { reply: down }, { code: 'network', message: 'curseforge.errNetwork' }],
  ];
  for (const [label, setup, expected] of cases) {
    const { api } = apiSetup(setup);
    await assert.rejects(api.request(SEARCH), expected, label);
  }
});

test('una búsqueda sin resultados no es un error: devuelve la lista vacía', async () => {
  const { api } = apiSetup({ reply: () => json({ data: [], pagination: { index: 0, pageSize: 24, resultCount: 0, totalCount: 0 } }) });
  const res = await api.search({ query: 'zzzz no existe' });
  assert.equal(res.hits.length, 0);
  assert.equal(res.total, 0);
  assert.equal(res.exhausted, true);
  const none = apiSetup({ reply: () => json({}) });
  assert.equal((await none.api.search({})).hits.length, 0);
});

test('la búsqueda completa del catálogo usa los parámetros que el servidor acepta', async () => {
  const { api, calls } = apiSetup({ reply: () => json({ data: [], pagination: { totalCount: 0 } }) });
  await api.search({ query: 'sodium', type: 'mod', gameVersion: '1.21.1', loader: 'fabric', sort: 'downloads', categoryId: 407, index: 24, pageSize: 24 });
  const sent = JSON.parse(functionCalls(calls)[0].init.body);
  const query = new URL(sent.path, 'https://x.invalid').searchParams;
  assert.deepEqual(Object.fromEntries(query), { gameId: '432', classId: '6', searchFilter: 'sodium', categoryId: '407', gameVersion: '1.21.1', modLoaderType: '4', sortField: '6', sortOrder: 'desc', index: '24', pageSize: '24' });
});

test('un 401 con un token que parecía vigente pide uno nuevo una vez y reintenta', async () => {
  let stored = SESSION;
  const seen = [];
  const { api } = apiSetup({
    session: () => stored,
    reply: (url, init) => {
      seen.push(init.headers.Authorization);
      return init.headers.Authorization === 'Bearer session-for-test' ? errJson('unauthorized', 401) : json({ data: [{ id: 7 }] });
    },
  });
  api.setRefreshRequester(() => { stored = { ...SESSION, access_token: 'renewed-test-session' }; });
  assert.deepEqual(await api.request('/v1/mods/7'), { data: [{ id: 7 }] });
  assert.deepEqual(seen, ['Bearer session-for-test', 'Bearer renewed-test-session']);
});

test('si la renovación no trae un token distinto, el 401 pide iniciar sesión sin reintentar en bucle', async () => {
  const seen = [];
  const { api } = apiSetup({ reply: (url, init) => { seen.push(init.headers.Authorization); return errJson('unauthorized', 401); } });
  await assert.rejects(api.request('/v1/mods/7'), { code: 'noSession', message: 'curseforge.errSignIn' });
  assert.equal(seen.length, 1);
});

test('con clave compilada, si el catálogo central falla se repite con la clave del build', async () => {
  for (const [label, reply] of [
    ['clave rechazada', () => errJson('badkey', 403)],
    ['cortado por el borde', () => errJson('blocked', 403)],
    ['servidor caído', () => errJson('unavailable', 503)],
    ['sin configurar', () => errJson('not_configured', 503)],
  ]) {
    const { api, calls } = apiSetup({ compiled: 'legacy-test-key', reply: (url) => (url.includes('/functions/') ? reply() : json({ data: [{ id: 3 }] })) });
    const res = await api.request('/v1/mods/12');
    assert.deepEqual(res, { data: [{ id: 3 }] }, label);
    const last = calls.at(-1);
    assert.equal(last.url, 'https://api.curseforge.com/v1/mods/12', label);
    assert.equal(last.init.headers['x-api-key'], 'legacy-test-key', label);
  }
});

test('el respaldo con clave compilada no tapa una sesión vencida, una cuenta bloqueada ni un archivo inexistente', async () => {
  for (const [label, reply, code] of [
    ['sin sesión', () => errJson('unauthorized', 401), 'noSession'],
    ['cuenta bloqueada', () => errJson('forbidden', 403), 'forbidden'],
    ['no existe', () => errJson('not_found', 404), 'notfound'],
  ]) {
    const { api, calls } = apiSetup({ compiled: 'legacy-test-key', reply });
    await assert.rejects(api.request('/v1/mods/12'), { code }, label);
    assert.equal(calls.some((c) => c.url.startsWith('https://api.curseforge.com')), false, label);
  }
});

test('con clave propia del build, el 403 directo se clasifica sin mostrar el texto de CurseForge', async () => {
  const direct = (body, type = 'text/plain') => ({ configured: false, compiled: 'legacy-test-key', reply: () => new Response(body, { status: 403, headers: { 'content-type': type } }) });
  await assert.rejects(apiSetup(direct('Forbidden: API Key missing or invalid')).api.request(SEARCH), { code: 'badkey' });
  await assert.rejects(apiSetup(direct('<!DOCTYPE html><html></html>', 'text/html')).api.request(SEARCH), { code: 'blocked' });
  await assert.rejects(apiSetup(direct('')).api.request(SEARCH), { code: 'badkey' });
  await assert.rejects(apiSetup(direct('')).api.request('/v1/mods/1/files/2'), { code: 'denied', message: 'curseforge.errDenied' });
});

test('la URL de descarga es null cuando el autor no la permite, pero un bloqueo o una cuenta bloqueada no se disfrazan', async () => {
  const forDownload = (reply) => apiSetup({ reply });
  assert.equal(await forDownload(() => errJson('denied', 403)).api.getDownloadUrl(1, 2), null);
  assert.equal(await forDownload(() => errJson('not_found', 404)).api.getDownloadUrl(1, 2), null);
  assert.equal(await forDownload(() => json({ data: 'https://edge.forgecdn.net/files/a.jar' })).api.getDownloadUrl(1, 2), 'https://edge.forgecdn.net/files/a.jar');
  await assert.rejects(forDownload(() => errJson('blocked', 403)).api.getDownloadUrl(1, 2), { code: 'blocked' });
  await assert.rejects(forDownload(() => errJson('forbidden', 403)).api.getDownloadUrl(1, 2), { code: 'forbidden' });
});
