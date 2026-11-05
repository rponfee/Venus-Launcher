'use strict';
// Cliente de Openverse con respuestas guardadas: pedido exacto, validacion de lo que vuelve, cache, limite de
// pedidos (429 y topes propios), reintentos, sin internet y archivo de cache alterado. Sin red.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, MINUTE_MAX, DAY_MAX, FRESH_MS } = require('../client');
const { fixture, jsonResponse, fakeClock, memoryStore, fakeFetch } = require('./helpers');

const UA = 'VenusLauncher/4.6.0 (+https://github.com/rponfee/Venus-Launcher; profile music via Openverse)';

function make({ responder, store = memoryStore(), clock = fakeClock(), isOffline = () => false, timeoutMs } = {}) {
  const fetch = fakeFetch(responder);
  const client = createClient({ fetch, userAgent: UA, store, now: clock.now, sleep: clock.sleep, isOffline, timeoutMs });
  return { client, fetch, store, clock };
}
const ok = (name) => () => jsonResponse(200, fixture(name), { 'x-ratelimit-available-anon_burst': '19', 'x-ratelimit-available-anon_sustained': '199' });
const throttled = (retryAfter = '25') => () => jsonResponse(429, fixture('throttled-429.json'), retryAfter ? { 'retry-after': retryAfter } : {});
const catchCode = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  assert.fail('tenia que fallar');
};

test('el pedido: GET a api.openverse.org/v1/audio/ con User-Agent propio y solo licencias comerciales', async () => {
  const { client, fetch } = make({ responder: [ok('jamendo-search.json')] });
  const r = await client.search({ text: 'piano', genre: 'classical', length: 'medium' });
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://api.openverse.org/v1/audio/');
  assert.equal(u.searchParams.get('q'), 'piano classical');
  assert.equal(u.searchParams.get('license'), 'by,by-sa,by-nd,cc0,pdm');
  assert.equal(u.searchParams.get('page_size'), '20');
  assert.equal(u.searchParams.get('length'), 'medium');
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['User-Agent'], UA);
  assert.equal(init.body, undefined);
  assert.equal(r.items.length, 8);
  assert.equal(r.fromCache, false);
  assert.equal(r.total, 195);
  assert.equal(r.pageCount, 10);
});

test('lo que vuelve se valida: licencias NC, Freesound, wav y hosts ajenos se descartan', async () => {
  const mixed = fixture('mixed-search.json');
  const evil = { ...mixed.results[0], id: '99999999-9999-4999-8999-999999999999', url: 'https://evil.example/a.mp3' };
  const nc = { ...mixed.results[1], id: '88888888-8888-4888-8888-888888888888', license: 'by-nc' };
  const body = { ...mixed, results: [...mixed.results, evil, nc, mixed.results[0]] };
  const { client } = make({ responder: [() => jsonResponse(200, body)] });
  const r = await client.search({ text: 'ambient piano', source: 'both' });
  assert.equal(r.items.length, mixed.results.length, 'sin los dos malos ni el repetido');
  assert.ok(r.items.every((t) => ['by', 'by-sa', 'by-nd', 'cc0', 'pdm'].includes(t.license)));
  assert.ok(r.items.every((t) => /^https:\/\/(prod-1\.storage\.jamendo\.com|upload\.wikimedia\.org)\//.test(t.url)));
  assert.equal(new Set(r.items.map((t) => t.id)).size, r.items.length);
  const free = make({ responder: [ok('freesound-search.json')] });
  assert.equal((await free.client.search({ text: 'piano' })).items.length, 0);
});

test('cache: la misma busqueda no gasta cupo durante 12 horas y se guarda en disco', async () => {
  const { client, fetch, store, clock } = make({ responder: [ok('jamendo-search.json')] });
  await client.search({ text: 'piano' });
  const again = await client.search({ text: ' piano ' });
  assert.equal(again.fromCache, true);
  assert.equal(again.stale, false);
  assert.equal(fetch.calls.length, 1);
  assert.ok(store.peek().entries && Object.keys(store.peek().entries).length === 1);
  // otro cliente (otra sesion) con el mismo archivo
  const second = createClient({ fetch: fakeFetch([ok('jamendo-search.json')]), userAgent: UA, store, now: clock.now, sleep: clock.sleep });
  assert.equal((await second.search({ text: 'piano' })).fromCache, true);
  // vencida: vuelve a pedir
  clock.advance(FRESH_MS + 1000);
  const r = await client.search({ text: 'piano' });
  assert.equal(r.fromCache, false);
  assert.equal(fetch.calls.length, 2);
  // otra pagina o filtro es otra busqueda
  await client.search({ text: 'piano', page: 2 });
  assert.equal(fetch.calls.length, 3);
});

test('429: respeta Retry-After, no vuelve a pedir hasta entonces y avisa cuanto falta', async () => {
  const { client, fetch, clock } = make({ responder: [throttled('25'), ok('jamendo-search.json')] });
  const e = await catchCode(client.search({ text: 'rock' }));
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.retryAfter, 25);
  assert.equal(fetch.calls.length, 1);
  clock.advance(10_000);
  const e2 = await catchCode(client.search({ text: 'rock' }));
  assert.equal(e2.code, 'rate_limited');
  assert.equal(e2.retryAfter, 15);
  assert.equal(fetch.calls.length, 1, 'durante la espera no sale ningun pedido');
  clock.advance(16_000);
  const r = await client.search({ text: 'rock' });
  assert.equal(r.items.length, 8);
  assert.equal(fetch.calls.length, 2);
});

test('429 sin cabecera: usa el texto "Expected available in N seconds"; con mas de una hora es el cupo del dia', async () => {
  const a = make({ responder: [throttled(null)] });
  const e = await catchCode(a.client.search({ text: 'rock' }));
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.retryAfter, 25);
  const b = make({ responder: [throttled('43200')] });
  const d = await catchCode(b.client.search({ text: 'rock' }));
  assert.equal(d.code, 'daily_limit');
  assert.equal(d.retryAfter, 43200);
});

test('429 con una copia vieja de esa busqueda: devuelve la copia marcada como vieja', async () => {
  const { client, clock } = make({ responder: [ok('jamendo-search.json'), throttled('60')] });
  await client.search({ text: 'rock' });
  clock.advance(FRESH_MS + 5000);
  const r = await client.search({ text: 'rock' });
  assert.equal(r.fromCache, true);
  assert.equal(r.stale, true);
  assert.equal(r.items.length, 8);
});

test('tope propio por minuto: despues de 12 pedidos no sale el 13 y dice cuando', async () => {
  const { client, fetch, clock } = make({ responder: [ok('jamendo-search.json')] });
  for (let i = 0; i < MINUTE_MAX; i++) {
    await client.search({ text: `busqueda ${i}` });
    clock.advance(1000);
  }
  assert.equal(fetch.calls.length, MINUTE_MAX);
  const e = await catchCode(client.search({ text: 'una mas' }));
  assert.equal(e.code, 'rate_limited');
  assert.ok(e.retryAfter >= 1 && e.retryAfter <= 60);
  assert.equal(fetch.calls.length, MINUTE_MAX);
  clock.advance(e.retryAfter * 1000 + 1000);
  await client.search({ text: 'una mas' });
  assert.equal(fetch.calls.length, MINUTE_MAX + 1);
});

test('tope propio por dia: se corta en 160 y se libera a las 24 horas del primer pedido', async () => {
  const { client, fetch, clock } = make({ responder: [ok('jamendo-search.json')] });
  for (let i = 0; i < DAY_MAX; i++) {
    await client.search({ text: `tema ${i}` });
    clock.advance(6000); // 10 por minuto
  }
  assert.equal(fetch.calls.length, DAY_MAX);
  const e = await catchCode(client.search({ text: 'otro tema' }));
  assert.equal(e.code, 'daily_limit');
  assert.ok(e.retryAfter > 3600);
  assert.equal((await client.status()).usedToday, DAY_MAX);
  clock.advance(e.retryAfter * 1000 + 1000);
  await client.search({ text: 'otro tema' });
  assert.equal(fetch.calls.length, DAY_MAX + 1);
});

test('si la API dice que no queda cupo en el minuto, se espera antes del proximo pedido', async () => {
  const empty = () => jsonResponse(200, fixture('jamendo-search.json'), { 'x-ratelimit-available-anon_burst': '0', 'x-ratelimit-available-anon_sustained': '120' });
  const { client, fetch, clock } = make({ responder: [empty] });
  await client.search({ text: 'uno' });
  const e = await catchCode(client.search({ text: 'dos' }));
  assert.equal(e.code, 'rate_limited');
  assert.ok(e.retryAfter <= 20);
  assert.equal(fetch.calls.length, 1);
  clock.advance(21_000);
  await client.search({ text: 'dos' });
  assert.equal(fetch.calls.length, 2);
  assert.equal((await client.status()).quota.sustained, 120);
});

test('errores del servidor y de red: un reintento y despues el error', async () => {
  const boom = () => jsonResponse(503, 'Service Unavailable');
  const a = make({ responder: [boom, ok('jamendo-search.json')] });
  assert.equal((await a.client.search({ text: 'x' })).items.length, 8);
  assert.equal(a.fetch.calls.length, 2);
  const b = make({ responder: [boom] });
  assert.equal((await catchCode(b.client.search({ text: 'x' }))).code, 'server');
  assert.equal(b.fetch.calls.length, 2);
  const net = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const c = make({ responder: [net, ok('jamendo-search.json')] });
  assert.equal((await c.client.search({ text: 'x' })).items.length, 8);
  const d = make({ responder: [net] });
  assert.equal((await catchCode(d.client.search({ text: 'x' }))).code, 'network');
  const notFound = make({ responder: [() => jsonResponse(404, { detail: 'no' })] });
  assert.equal((await catchCode(notFound.client.search({ text: 'x' }))).code, 'bad_response');
  assert.equal(notFound.fetch.calls.length, 1);
});

test('si el pedido no contesta, se corta por tiempo', async () => {
  const hang = (url, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('abort'))));
  const { client } = make({ responder: [hang], timeoutMs: 30 });
  assert.equal((await catchCode(client.search({ text: 'x' }))).code, 'timeout');
});

test('respuestas raras: JSON roto, otra forma, otro tipo de contenido, demasiado grande', async () => {
  for (const [label, res] of [
    ['json roto', () => jsonResponse(200, '{"results": [')],
    ['sin results', () => jsonResponse(200, { result_count: 1 })],
    ['results no es lista', () => jsonResponse(200, { results: 'hola' })],
    ['html', () => new Response('<html>portal</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['gigante', () => jsonResponse(200, JSON.stringify({ results: [], pad: 'x'.repeat(1_600_000) }))],
  ]) {
    const { client } = make({ responder: [res] });
    assert.equal((await catchCode(client.search({ text: 'x' }))).code, 'bad_response', label);
  }
});

test('sin internet (modo sin conexion): usa la copia o avisa, y no pide nada', async () => {
  let offline = false;
  const { client, fetch, clock } = make({ responder: [ok('jamendo-search.json')], isOffline: () => offline });
  await client.search({ text: 'x' });
  offline = true;
  const same = await client.search({ text: 'x' });
  assert.equal(same.fromCache, true);
  clock.advance(FRESH_MS + 1000);
  const old = await client.search({ text: 'x' });
  assert.equal(old.stale, true);
  assert.equal((await catchCode(client.search({ text: 'otra' }))).code, 'offline');
  assert.equal(fetch.calls.length, 1);
});

test('busqueda vacia: bad_query sin pedir nada', async () => {
  const { client, fetch } = make({ responder: [ok('jamendo-search.json')] });
  assert.equal((await catchCode(client.search({ text: ' ' }))).code, 'bad_query');
  assert.equal(fetch.calls.length, 0);
});

test('el archivo de cache en disco no es de fiar: lo alterado se descarta', async () => {
  const good = fixture('jamendo-search.json').results;
  const { client: seed, store, clock } = make({ responder: [ok('jamendo-search.json')] });
  await seed.search({ text: 'x' });
  const state = store.peek();
  const key = Object.keys(state.entries)[0];
  state.entries[key].data.items[0].url = 'https://evil.example/a.mp3';
  state.entries[key].data.items[1].license = 'by-nc';
  state.entries.roto = { at: 'ayer', data: 5 };
  state.hits = ['a', null, clock.now()];
  const tampered = memoryStore(state);
  const client = createClient({ fetch: fakeFetch([ok('jamendo-search.json')]), userAgent: UA, store: tampered, now: clock.now, sleep: clock.sleep });
  const r = await client.search({ text: 'x' });
  assert.equal(r.fromCache, true);
  assert.equal(r.items.length, good.length - 2);
  assert.ok(r.items.every((t) => t.url.startsWith('https://prod-1.storage.jamendo.com/')));
  assert.equal((await client.status()).usedToday, 1);
  const junk = createClient({ fetch: fakeFetch([ok('jamendo-search.json')]), userAgent: UA, store: memoryStore({ v: 7, entries: 'x' }), now: clock.now, sleep: clock.sleep });
  assert.equal((await junk.search({ text: 'x' })).items.length, 8);
});

test('status y borrar la cache', async () => {
  const { client } = make({ responder: [ok('jamendo-search.json')] });
  await client.search({ text: 'a' });
  await client.search({ text: 'b' });
  const s = await client.status();
  assert.equal(s.cached, 2);
  assert.equal(s.usedToday, 2);
  assert.deepEqual(s.limits, { perMinute: 12, perDay: 160 });
  assert.deepEqual(await client.clearCache(), { removed: 2 });
  assert.equal((await client.status()).cached, 0);
});
