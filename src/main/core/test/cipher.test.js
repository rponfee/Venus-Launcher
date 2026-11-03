'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCipher } = require('../cipher');

const SECRET = 'token-super-secreto';
const fakeStorage = (over = {}) => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`cifrado(${s})`),
  decryptString: (b) => b.toString().slice('cifrado('.length, -1),
  ...over,
});

test('con almacén del sistema cifra y descifra', () => {
  const c = createCipher(fakeStorage(), 'win32');
  const stored = c.encrypt(SECRET);
  assert.match(stored, /^enc:/);
  assert.equal(c.decrypt(stored), SECRET);
});

test('sin almacén el secreto nunca queda en lo que se guarda, ni en base64', () => {
  const c = createCipher(fakeStorage({ isEncryptionAvailable: () => false }), 'win32');
  const stored = c.encrypt(SECRET);
  assert.match(stored, /^mem:/);
  assert.ok(!stored.includes(SECRET));
  assert.ok(!stored.includes(Buffer.from(SECRET).toString('base64')));
  assert.equal(c.decrypt(stored), SECRET);
});

test('lo que quedó en memoria se pierde al reiniciar: hay que volver a iniciar sesión', () => {
  const stored = createCipher(undefined, 'win32').encrypt(SECRET);
  assert.equal(createCipher(undefined, 'win32').decrypt(stored), '');
});

test('Linux sin llavero (basic_text) cuenta como sin almacén', () => {
  const basic = fakeStorage({ getSelectedStorageBackend: () => 'basic_text' });
  assert.match(createCipher(basic, 'linux').encrypt(SECRET), /^mem:/);
  const keyring = fakeStorage({ getSelectedStorageBackend: () => 'gnome_libsecret' });
  assert.match(createCipher(keyring, 'linux').encrypt(SECRET), /^enc:/);
});

test('los valores viejos "raw:" se siguen leyendo', () => {
  const c = createCipher(undefined, 'win32');
  assert.equal(c.decrypt(`raw:${Buffer.from(SECRET).toString('base64')}`), SECRET);
  assert.equal(c.decrypt(''), '');
  assert.equal(c.decrypt('sin-prefijo'), 'sin-prefijo');
});
