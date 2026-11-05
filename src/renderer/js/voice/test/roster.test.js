// Quien se saca de la lista de la sala y quien no cuando falla la señalizacion: el audio directo manda.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldDropMember, ROSTER } from '../roster.js';

const base = { now: 100000, awaySince: 100000 };

test('con presencia confiable: sale a los 15 s si no hay presencia, o enseguida si la conexion directa no esta viva', () => {
  assert.equal(shouldDropMember({ ...base, peerState: 'connected', trusted: true }), false);
  assert.equal(shouldDropMember({ ...base, now: 100000 + ROSTER.AWAY_GRACE_MS - 1, peerState: 'connected', trusted: true }), false);
  assert.equal(shouldDropMember({ ...base, now: 100000 + ROSTER.AWAY_GRACE_MS, peerState: 'connected', trusted: true }), true);
  assert.equal(shouldDropMember({ ...base, peerState: 'reconnecting', trusted: true }), true);
});

test('sin conexion directa no hay nada que cuidar: sale siempre', () => {
  for (const trusted of [true, false]) {
    assert.equal(shouldDropMember({ ...base, peerState: null, trusted }), true);
    assert.equal(shouldDropMember({ ...base, peerState: 'failed', trusted }), true);
    assert.equal(shouldDropMember({ ...base, peerState: 'closed', trusted }), true);
  }
});

test('señalizacion caida (presencia desconocida): una llamada que sigue conectada nunca se corta, por mucho que pase', () => {
  for (const mins of [1, 5, 60, 600]) {
    assert.equal(shouldDropMember({ now: 100000 + mins * 60000, awaySince: 100000, peerState: 'connected', trusted: false }), false, `${mins} min`);
  }
});

test('señalizacion caida y conexion directa tambien caida: se espera un minuto antes de sacarlo', () => {
  assert.equal(shouldDropMember({ ...base, now: 100000 + ROSTER.BLACKOUT_GRACE_MS - 1, peerState: 'reconnecting', trusted: false }), false);
  assert.equal(shouldDropMember({ ...base, now: 100000 + ROSTER.BLACKOUT_GRACE_MS, peerState: 'reconnecting', trusted: false }), true);
});
