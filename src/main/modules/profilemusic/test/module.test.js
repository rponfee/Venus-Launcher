'use strict';
// Modulo profilemusic.js: canales, interruptor de la conexion opcional (apagado por defecto), Openverse de mentira solo
// con VENUS_DEVSHOT y sin empaquetar, y que nada salga a internet con el interruptor apagado. Sin red.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../../../core/paths');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-profilemusic-'));
paths.setRoot(tmp);
const settings = require('../../../core/settings');
const MODULE = require.resolve('../../profilemusic');

function load({ fake, packaged = false } = {}) {
  delete require.cache[MODULE];
  if (fake) {
    process.env.VENUS_DEVSHOT = '1';
    process.env.VENUS_PROFILEMUSIC_FAKE = fake;
  } else {
    delete process.env.VENUS_DEVSHOT;
    delete process.env.VENUS_PROFILEMUSIC_FAKE;
  }
  const handlers = {};
  require('../../profilemusic').register({ app: { getVersion: () => '4.6.0', isPackaged: packaged }, handle: (ch, fn) => (handlers[ch] = fn) });
  return handlers;
}

test.after(() => {
  delete process.env.VENUS_DEVSHOT;
  delete process.env.VENUS_PROFILEMUSIC_FAKE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('registra los tres canales y la conexion viene apagada', async () => {
  const h = load({ fake: '1' });
  assert.deepEqual(Object.keys(h).sort(), ['profilemusic:clearCache', 'profilemusic:search', 'profilemusic:status']);
  assert.equal(settings.defaults().profileMusic, undefined, 'sin la clave: apagado');
  const st = await h['profilemusic:status']();
  assert.equal(st.enabled, false);
  assert.deepEqual(st.limits, { perMinute: 12, perDay: 160 });
  assert.ok(st.genres.includes('chiptune') && st.sources.includes('wikimedia') && st.lengths.includes('medium'));
  assert.deepEqual(st.license.ids, ['by', 'by-sa', 'by-nd', 'cc0', 'pdm']);
});

test('apagado no busca: devuelve disabled y no toca ni la API', async () => {
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async () => (calls++, new Response('{}'));
  try {
    const h = load({}); // sin modo falso: usaria el fetch real
    assert.deepEqual(await h['profilemusic:search']({ text: 'piano' }), { error: 'disabled' });
    assert.equal(calls, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test('activado con el Openverse de mentira: busca, valida y respeta los filtros', async () => {
  await settings.set({ profileMusic: { enabled: true } });
  const h = load({ fake: '1' });
  const r = await h['profilemusic:search']({ text: 'piano', source: 'jamendo' });
  assert.ok(Array.isArray(r.items) && r.items.length > 0);
  assert.ok(r.items.every((t) => t.source === 'jamendo' && ['by', 'by-sa', 'by-nd', 'cc0', 'pdm'].includes(t.license)));
  const w = await h['profilemusic:search']({ text: 'a', source: 'wikimedia' });
  assert.ok(w.items.length > 0 && w.items.every((t) => t.source === 'wikimedia'));
  assert.deepEqual(await h['profilemusic:search']({}), { error: 'bad_query' });
  assert.deepEqual(await h['profilemusic:search']({ text: '   ' }), { error: 'bad_query' });
});

test('si la API limita, el error llega como dato con retryAfter', async () => {
  await settings.set({ profileMusic: { enabled: true } });
  const h = load({ fake: 'limit' });
  const r = await h['profilemusic:search']({ text: 'rock' });
  assert.equal(r.error, 'rate_limited');
  assert.equal(r.retryAfter, 30);
  const again = await h['profilemusic:search']({ text: 'rock' });
  assert.equal(again.error, 'rate_limited');
  assert.ok(again.retryAfter <= 30);
});

test('sin resultados: lista vacia, no es un error', async () => {
  await settings.set({ profileMusic: { enabled: true } });
  const h = load({ fake: 'empty' });
  const r = await h['profilemusic:search']({ text: 'nada' });
  assert.deepEqual(r.items, []);
  assert.equal(r.total, 0);
});

test('el modo de mentira no existe en la app empaquetada ni sin VENUS_DEVSHOT', async () => {
  await settings.set({ profileMusic: { enabled: true } });
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    throw new TypeError('fetch failed');
  };
  try {
    const packaged = load({ fake: '1', packaged: true });
    assert.equal((await packaged['profilemusic:search']({ text: 'piano' })).error, 'network');
    assert.ok(seen.length >= 1 && seen.every((u) => u.startsWith('https://api.openverse.org/v1/audio/')), 'pide a la API real');
    seen.length = 0;
    process.env.VENUS_PROFILEMUSIC_FAKE = '1';
    delete process.env.VENUS_DEVSHOT;
    delete require.cache[MODULE];
    const h = {};
    require('../../profilemusic').register({ app: { getVersion: () => '4.6.0', isPackaged: false }, handle: (ch, fn) => (h[ch] = fn) });
    assert.equal((await h['profilemusic:search']({ text: 'guitarra' })).error, 'network');
    assert.ok(seen.length >= 1);
  } finally {
    global.fetch = realFetch;
  }
});

test('apagar el interruptor corta al instante y clearCache vacia la memoria', async () => {
  await settings.set({ profileMusic: { enabled: true } });
  const h = load({ fake: '1' });
  assert.ok((await h['profilemusic:search']({ text: 'piano' })).items.length > 0);
  await settings.set({ profileMusic: { enabled: false } });
  assert.deepEqual(await h['profilemusic:search']({ text: 'piano' }), { error: 'disabled' });
  const r = await h['profilemusic:clearCache']();
  assert.equal(typeof r.removed, 'number');
});
