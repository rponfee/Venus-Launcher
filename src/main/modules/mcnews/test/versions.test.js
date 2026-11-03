'use strict';
// Comparacion de versiones del manifiesto con lo ultimo visto.
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../versions');

test('sin nada visto, todo es nuevo (y el modulo lo toma como base)', () => {
  assert.deepEqual(v.newVersions({ release: '1.21.4', snapshot: '25w02a' }, undefined), [
    { id: '1.21.4', type: 'release' },
    { id: '25w02a', type: 'snapshot' },
  ]);
  assert.equal(v.isBaseline(undefined), true);
  assert.equal(v.isBaseline({ release: null }), true);
  assert.equal(v.isBaseline({ release: '1.21.4' }), false);
});

test('solo lo que cambio', () => {
  const seen = { release: '1.21.4', snapshot: '25w02a' };
  assert.deepEqual(v.newVersions({ release: '1.21.4', snapshot: '25w02a' }, seen), []);
  assert.deepEqual(v.newVersions({ release: '1.21.5', snapshot: '25w02a' }, seen), [{ id: '1.21.5', type: 'release' }]);
  assert.deepEqual(v.newVersions({ release: '1.21.4', snapshot: '25w03a' }, seen), [{ id: '25w03a', type: 'snapshot' }]);
});

test('una release nueva suele ser tambien la ultima snapshot: se avisa una sola vez', () => {
  assert.deepEqual(v.newVersions({ release: '1.21.5', snapshot: '1.21.5' }, { release: '1.21.4', snapshot: '1.21.5-rc2' }), [{ id: '1.21.5', type: 'release' }]);
});

test('ids raros se ignoran y lo visto se guarda sin basura', () => {
  assert.deepEqual(v.newVersions({ release: 42, snapshot: 'a b' }, {}), []);
  assert.deepEqual(v.newVersions({ release: '1.21.5' }, { release: { x: 1 } }), [{ id: '1.21.5', type: 'release' }]);
  assert.deepEqual(v.seenPatch({ release: '1.21.5', snapshot: null }, { snapshot: '25w02a' }), { release: '1.21.5', snapshot: '25w02a' });
  assert.deepEqual(v.seenPatch({}, {}), { release: null, snapshot: null });
});

test('fecha de publicacion de una version', () => {
  const manifest = { versions: [{ id: '1.21.5', releaseTime: '2025-03-25T12:00:00+00:00' }, { id: 'x' }] };
  assert.equal(v.releaseTimeOf(manifest, '1.21.5'), Date.parse('2025-03-25T12:00:00+00:00'));
  assert.equal(v.releaseTimeOf(manifest, 'x'), null);
  assert.equal(v.releaseTimeOf(null, '1.21.5'), null);
});
