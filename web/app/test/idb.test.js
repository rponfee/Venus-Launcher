'use strict';
// Apertura tardía de IndexedDB simulada; nunca se abre el almacenamiento del usuario.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/shared/idb.js'), 'utf8');

test('si IndexedDB tarda, una apertura tardía se cierra y conserva la sesión en memoria', async () => {
  let timeout, request, opens = 0, closed = 0;
  const context = { setTimeout: (fn) => { timeout = fn; return 1; }, clearTimeout() {}, indexedDB: { open() { opens++; request = {}; return request; } } };
  vm.runInNewContext(source, context);
  const idb = context.VenusApp.idb;
  const writing = idb.set('session-test', 'nueva');
  timeout();
  await writing;
  request.result = { close() { closed++; }, transaction() { assert.fail('no leer una sesión persistida anterior'); } };
  request.onsuccess();
  assert.equal(closed, 1);
  assert.equal(await idb.get('session-test'), 'nueva');
  await idb.clear();
  assert.equal(await idb.get('session-test'), null);
  assert.equal(opens, 1);
});

test('si el navegador bloquea IndexedDB la sesión sigue en memoria hasta recargar', async () => {
  let opens = 0;
  const context = { setTimeout, clearTimeout, indexedDB: { open() { opens++; throw new Error('no disponible'); } } };
  vm.runInNewContext(source, context);
  const idb = context.VenusApp.idb;
  await idb.storage.setItem('session-test', 'temporal');
  assert.equal(await idb.storage.getItem('session-test'), 'temporal');
  await idb.storage.removeItem('session-test');
  assert.equal(await idb.get('session-test'), null);
  assert.equal(opens, 1);
});
