'use strict';
// Pruebas de una consulta: cómo se clasifica cada respuesta o error.
const test = require('node:test');
const assert = require('node:assert/strict');
const { probeRequest, probeService, errCode } = require('../probe');
const { fakeClock, fakeFetch, netError } = require('./helpers');

const REQ = { url: 'https://api.modrinth.com/', method: 'HEAD', headers: { 'User-Agent': 'VenusLauncher/test' } };

async function probe(rule, opts = {}) {
  const clock = fakeClock();
  const fetch = fakeFetch({ 'api.modrinth.com': rule }, clock);
  const out = await probeRequest(REQ, { fetch, now: clock.now, timeoutMs: 40, slowMs: 2500, ...opts });
  return { out, fetch };
}

test('2xx, 3xx y 4xx cuentan como "responde"', async () => {
  for (const status of [200, 204, 301, 302, 401, 403, 404, 405, 429]) {
    const { out } = await probe(status);
    assert.equal(out.state, 'ok', `HTTP ${status}`);
    assert.equal(out.httpStatus, status);
  }
});

test('5xx = no responde (salvo 501, que es el servidor diciendo que no acepta HEAD)', async () => {
  for (const status of [500, 502, 503, 504]) {
    const { out } = await probe(status);
    assert.equal(out.state, 'down', `HTTP ${status}`);
    assert.equal(out.reason, 'http');
    assert.equal(out.detail, `HTTP ${status}`);
  }
  assert.equal((await probe(501)).out.state, 'ok');
});

test('más de 2,5 s = lento (reloj falso)', async () => {
  const { out } = await probe({ status: 200, delay: 3000 });
  assert.equal(out.state, 'slow');
  assert.equal(out.ms, 3000);
  assert.equal((await probe({ status: 200, delay: 2500 })).out.state, 'ok');
});

test('sin respuesta a tiempo = no responde (timeout)', async () => {
  const { out } = await probe('timeout');
  assert.equal(out.state, 'down');
  assert.equal(out.reason, 'timeout');
  assert.equal(out.ms, 40);
});

test('errores de red: DNS, TLS, conexión rechazada y cortada', async () => {
  assert.deepEqual(pick((await probe({ error: 'ENOTFOUND' })).out), { state: 'down', reason: 'dns', detail: 'ENOTFOUND' });
  assert.deepEqual(pick((await probe({ error: 'EAI_AGAIN' })).out), { state: 'down', reason: 'dns', detail: 'EAI_AGAIN' });
  assert.deepEqual(pick((await probe({ error: 'CERT_HAS_EXPIRED' })).out), { state: 'down', reason: 'tls', detail: 'CERT_HAS_EXPIRED' });
  assert.deepEqual(pick((await probe({ error: 'SELF_SIGNED_CERT_IN_CHAIN' })).out), { state: 'down', reason: 'tls', detail: 'SELF_SIGNED_CERT_IN_CHAIN' });
  assert.deepEqual(pick((await probe({ error: 'ECONNRESET' })).out), { state: 'down', reason: 'reset', detail: 'ECONNRESET' });
  assert.deepEqual(pick((await probe({ error: 'ENETUNREACH' })).out), { state: 'down', reason: 'unreachable', detail: 'ENETUNREACH' });
  // IPv4 + IPv6: undici deja los errores en cause.errors[]
  const agg = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { errors: [netError('ECONNREFUSED').cause] }) }));
  assert.deepEqual(pick((await probe(agg)).out), { state: 'down', reason: 'refused', detail: 'ECONNREFUSED' });
  // Error raro sin código: "network" (nunca el texto del error)
  const odd = () => Promise.reject(new Error('algo raro con https://x.y/?token=secreto'));
  assert.deepEqual(pick((await probe(odd)).out), { state: 'down', reason: 'network', detail: 'network' });
});

test('HEAD sin seguir redirecciones, sin cookies y solo con las cabeceras permitidas', async () => {
  const { fetch } = await probe(200);
  const init = fetch.calls[0].init;
  assert.equal(init.method, 'HEAD');
  assert.equal(init.redirect, 'manual');
  assert.deepEqual(Object.keys(init.headers), ['User-Agent']);
  assert.ok(!('credentials' in init) && !('body' in init));
});

test('el cuerpo de un GET se cancela sin leerlo', async () => {
  let cancelled = false;
  const fetch = async () => ({ status: 200, body: { cancel: async () => (cancelled = true) } });
  const out = await probeRequest({ ...REQ, method: 'GET' }, { fetch, timeoutMs: 1000 });
  assert.equal(out.state, 'ok');
  assert.equal(cancelled, true);
});

test('prueba de conexión: vale el mejor pedido y se nota cuando falla solo el DNS', async () => {
  const clock = fakeClock();
  const def = {
    id: 'internet',
    group: 'connection',
    requests: [
      { url: 'https://www.cloudflare.com/cdn-cgi/trace', method: 'HEAD', via: 'name' },
      { url: 'https://1.1.1.1/cdn-cgi/trace', method: 'HEAD', via: 'ip' },
    ],
  };
  const ctx = (rules) => ({ fetch: fakeFetch(rules, clock), now: clock.now, timeoutMs: 40, slowMs: 2500 });
  let out = await probeService(def, ctx({ 'www.cloudflare.com': { error: 'ENOTFOUND' }, '1.1.1.1': 200 }));
  assert.equal(out.state, 'ok');
  assert.equal(out.dns, 'down');
  out = await probeService(def, ctx({ '*': 200 }));
  assert.equal(out.state, 'ok');
  assert.equal(out.dns, 'ok');
  // Fallan los dos: si por IP tampoco hay camino, el motivo es la red (no el DNS)
  out = await probeService(def, ctx({ 'www.cloudflare.com': { error: 'EAI_AGAIN' }, '1.1.1.1': { error: 'ENETUNREACH' } }));
  assert.equal(out.state, 'down');
  assert.equal(out.reason, 'unreachable');
  assert.equal(out.dns, 'ok');
  // Sin motivo de DNS de por medio, vale el primero (por nombre)
  out = await probeService(def, ctx({ 'www.cloudflare.com': { error: 'ECONNRESET' }, '1.1.1.1': { error: 'ENETUNREACH' } }));
  assert.equal(out.reason, 'reset');
});

test('prueba de conexión (anyAnswer): un 5xx de Cloudflare igual prueba que internet anda', async () => {
  const clock = fakeClock();
  const def = {
    id: 'internet',
    group: 'connection',
    anyAnswer: true,
    requests: [
      { url: 'https://www.cloudflare.com/cdn-cgi/trace', method: 'HEAD', via: 'name' },
      { url: 'https://1.1.1.1/cdn-cgi/trace', method: 'HEAD', via: 'ip' },
    ],
  };
  const ctx = (rules) => ({ fetch: fakeFetch(rules, clock), now: clock.now, timeoutMs: 40, slowMs: 2500 });
  let out = await probeService(def, ctx({ 'www.cloudflare.com': 503, '1.1.1.1': 'timeout' }));
  assert.deepEqual([out.state, out.httpStatus, out.reason], ['ok', 503, undefined]);
  // Por IP con 5xx y por nombre sin DNS: contestó (internet anda) aunque el DNS falle
  out = await probeService(def, ctx({ 'www.cloudflare.com': { error: 'ENOTFOUND' }, '1.1.1.1': 500 }));
  assert.equal(out.state, 'ok');
  assert.equal(out.dns, 'down');
  // En un servicio normal (sin anyAnswer) el 5xx sigue siendo "no responde"
  out = await probeService({ ...def, anyAnswer: false }, ctx({ '*': 503 }));
  assert.deepEqual([out.state, out.reason], ['down', 'http']);
});

test('un servicio salteado no consulta nada', async () => {
  const fetch = fakeFetch({});
  const out = await probeService({ id: 'curseforge', group: 'content', skip: 'noKey', requests: [] }, { fetch });
  assert.deepEqual(out, { id: 'curseforge', group: 'content', state: 'skipped', ms: null, reason: 'noKey' });
  assert.equal(fetch.calls.length, 0);
});

test('errCode busca el código en cause y en el texto', () => {
  assert.equal(errCode(netError('ETIMEDOUT')), 'ETIMEDOUT');
  assert.equal(errCode(new Error('getaddrinfo ENOTFOUND api.modrinth.com')), 'ENOTFOUND');
  assert.equal(errCode(new Error('fetch failed')), '');
});

function pick(o) {
  return { state: o.state, reason: o.reason, detail: o.detail };
}
