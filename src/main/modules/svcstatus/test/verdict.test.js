'use strict';
// Pruebas del veredicto: ¿es tu internet o es un servicio?
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeVerdict } = require('../verdict');

const r = (id, state, extra = {}) => ({ id, state, ...extra });
const base = (results, extra = {}) => ({ offlineMode: false, internet: 'ok', dns: 'ok', internetSlow: false, results, ...extra });

test('modo sin conexión', () => {
  assert.deepEqual(computeVerdict({ offlineMode: true, results: [] }), { kind: 'offline', ids: [] });
});

test('internet caído manda sobre todo lo demás', () => {
  const s = base([r('internet', 'down', { reason: 'timeout' }), r('modrinth', 'down', { reason: 'timeout' })], { internet: 'down', internetReason: 'timeout' });
  assert.equal(computeVerdict(s).kind, 'internet');
  assert.equal(computeVerdict({ ...s, internetReason: 'tls' }).kind, 'tls');
});

test('un 5xx es del servicio aunque falle el DNS de otro', () => {
  const s = base([r('modrinth', 'down', { reason: 'http' }), r('curseforge', 'down', { reason: 'dns' })], { dns: 'down' });
  assert.deepEqual(computeVerdict(s), { kind: 'down', ids: ['modrinth', 'curseforge'] });
});

test('solo DNS: internet anda por IP pero no por nombre', () => {
  const s = base([r('microsoft', 'down', { reason: 'dns' }), r('xbox', 'down', { reason: 'dns' })], { dns: 'down' });
  assert.equal(computeVerdict(s).kind, 'dns');
  // Si el DNS anda, que un servicio no se encuentre es de ese servicio
  assert.equal(computeVerdict({ ...s, dns: 'ok' }).kind, 'down');
});

test('certificados rotos en todos los que fallan: antivirus, proxy o la hora de la PC', () => {
  const s = base([r('microsoft', 'down', { reason: 'tls' }), r('modrinth', 'down', { reason: 'tls' }), r('venus', 'ok')]);
  assert.equal(computeVerdict(s).kind, 'tls');
});

test('internet anda pero no contesta nadie de varias empresas: la red bloquea', () => {
  const s = base([r('microsoft', 'down', { reason: 'timeout' }), r('modrinth', 'down', { reason: 'timeout' }), r('venus', 'down', { reason: 'refused' })]);
  assert.equal(computeVerdict(s).kind, 'blocked');
  // Todos de la misma empresa (Mojang es de Microsoft): es ese servicio
  const mojang = base([r('mojangMeta', 'down', { reason: 'timeout' }), r('mojangLibraries', 'down', { reason: 'timeout' }), r('mojangAssets', 'down', { reason: 'timeout' })]);
  assert.deepEqual(computeVerdict(mojang), { kind: 'down', ids: ['mojangMeta', 'mojangLibraries', 'mojangAssets'] });
});

test('nadie contestó y no se pudo probar la conexión: lo más probable es tu internet', () => {
  const s = base([r('microsoft', 'down', { reason: 'timeout' })], { internet: 'unknown' });
  assert.equal(computeVerdict(s).kind, 'internet');
});

test('lentitud: de tu conexión o de un servicio', () => {
  assert.deepEqual(computeVerdict(base([r('modrinth', 'slow'), r('venus', 'ok')])), { kind: 'slow', ids: ['modrinth'] });
  assert.equal(computeVerdict(base([r('internet', 'slow'), r('modrinth', 'slow')], { internetSlow: true })).kind, 'internetSlow');
  assert.equal(computeVerdict(base([r('modrinth', 'down', { reason: 'timeout' })], { internetSlow: true })).kind, 'internetSlow');
});

test('todo bien, salteados ignorados y alcance', () => {
  assert.deepEqual(computeVerdict(base([r('internet', 'ok'), r('curseforge', 'skipped'), r('modrinth', 'ok')])), { kind: 'ok', ids: [] });
  const s = base([r('microsoft', 'ok'), r('modrinth', 'down', { reason: 'http' })]);
  assert.equal(computeVerdict(s, ['microsoft']).kind, 'ok');
  assert.equal(computeVerdict(s, ['modrinth']).kind, 'down');
});
