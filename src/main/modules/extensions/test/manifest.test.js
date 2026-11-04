// Validación del manifiesto. node --test "src/main/modules/extensions/test/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateManifest, launcherSupports, addedPermissions, PERMISSIONS, ExtensionError } = require('../manifest');
const { manifest } = require('./helpers');

const rejects = (over, code = 'bad_manifest') => {
  assert.throws(
    () => validateManifest(manifest(over)),
    (err) => err instanceof ExtensionError && err.code === code,
    JSON.stringify(over),
  );
};

test('un manifiesto correcto devuelve una copia limpia', () => {
  const m = validateManifest(JSON.stringify(manifest({ permissions: [...PERMISSIONS], homeCard: 'ui/card.html' })));
  assert.equal(m.id, 'mi-extension');
  assert.deepEqual(m.permissions, [...PERMISSIONS]);
  assert.equal(m.homeCard, 'ui/card.html');
});

test('el id respeta el formato', () => {
  for (const id of ['ab', 'A-B-C', 'con espacio', 'con_guion_bajo', 'x'.repeat(41), '../etc', '-abc', 'abc-', 'ñandu', '', 7, null]) rejects({ id });
  assert.equal(validateManifest(manifest({ id: 'abc' })).id, 'abc');
  assert.equal(validateManifest(manifest({ id: 'a1-b2-c3' })).id, 'a1-b2-c3');
});

test('el esquema es cerrado: una clave desconocida rechaza todo', () => {
  rejects({ nodeIntegration: true });
  rejects({ background: 'x.js' });
  assert.throws(() => validateManifest('{"__proto__":{"x":1},"manifestVersion":1}'), ExtensionError);
});

test('los permisos son los de la lista, sin repetir', () => {
  rejects({ permissions: ['read.accounts'] }, 'bad_permission');
  rejects({ permissions: ['network'] }, 'bad_permission');
  rejects({ permissions: ['read.tokens'] }, 'bad_permission');
  rejects({ permissions: ['storage', 'storage'] });
  rejects({ permissions: 'storage' });
  rejects({ permissions: [1] }, 'bad_permission');
  rejects({ permissions: undefined });
});

test('los textos no traen controles, marcas de dirección ni HTML', () => {
  rejects({ name: '<img src=x onerror=alert(1)>' });
  rejects({ name: 'a\u202eb' });
  rejects({ name: 'a\u200bb' });
  rejects({ name: 'a\nb' });
  rejects({ name: '' });
  rejects({ name: 'x'.repeat(41) });
  rejects({ author: '' });
  rejects({ author: 'x'.repeat(61) });
  rejects({ description: 'x'.repeat(301) });
  rejects({ description: 7 });
});

test('no se puede presentar como el launcher', () => {
  for (const name of ['Venus Launcher', 'Actualización de VENUS', 'V e n u s', 'Vénus', 'Ⅴenus', 'Parche oficial', 'Official pack', 'Mojang', 'Microsoft login']) rejects({ name }, 'reserved_name');
  rejects({ author: 'Equipo de Venus' }, 'reserved_name');
  rejects({ id: 'venus-update' }, 'reserved_name');
});

test('versiones, entrada y página de la tarjeta', () => {
  for (const version of ['1', '1.0', 'v1.0.0', '1.0.0.0', '', 1, '1.0.0-' + 'x'.repeat(40)]) rejects({ version });
  rejects({ minLauncherVersion: 'x' });
  rejects({ minLauncherVersion: undefined });
  rejects({ manifestVersion: 2 });
  for (const entry of ['../index.html', '/index.html', 'C:\\x.html', 'index.js', '', 'a\\b.html', './index.html', 'con.html', 'x.html ']) rejects({ entry });
  rejects({ homeCard: '../card.html' });
  rejects({ homeCard: 'card.js' });
});

test('JSON roto o de otro tipo', () => {
  for (const raw of ['', '{', '[]', 'null', '1', '"x"']) assert.throws(() => validateManifest(raw), ExtensionError);
  assert.throws(() => validateManifest('x'.repeat(20000)), ExtensionError);
});

test('versión mínima del launcher y permisos nuevos', () => {
  const m = validateManifest(manifest({ minLauncherVersion: '3.1.0' }));
  assert.equal(launcherSupports(m, '3.1.0'), true);
  assert.equal(launcherSupports(m, '3.2.0'), true);
  assert.equal(launcherSupports(m, '3.0.9'), false);
  assert.deepEqual(addedPermissions(['storage'], ['storage', 'notify']), ['notify']);
  assert.deepEqual(addedPermissions(['storage', 'notify'], ['storage']), []);
  assert.deepEqual(addedPermissions(null, ['storage']), ['storage']);
});
