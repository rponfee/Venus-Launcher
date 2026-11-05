import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../../../features/communities/logic.js';

// Mismos vectores que la prueba de la migración (private.group_reserved): las dos listas tienen que coincidir.
const RESERVED = ['Admin Team', 'ADMIN', 'V3nus', 'venus', 'STAFF', 'Los Mods', 'mod', 'El Oficial', 'oficial', 'Official', 'Moderador', 'Soporte 24', 'AdminClan', 'ClanVenus', 'Vеnus', '4DM1N', 'M0D'];
const ALLOWED = ['Moderno', 'Badminton', 'Los Creeper', 'Commodore', 'Modpack Club', 'Venecia', 'Oficina', 'CR', 'MO'];

test('palabras reservadas, también disfrazadas', () => {
  for (const name of RESERVED) assert.equal(L.isReserved(name), true, name);
  for (const name of ALLOWED) assert.equal(L.isReserved(name), false, name);
});

test('nombre de la comunidad', () => {
  assert.deepEqual(L.validateCommunityName('  Mina   Central '), { ok: true, error: null, value: 'Mina Central' });
  assert.equal(L.validateCommunityName('ab').error, 'bad_name');
  assert.equal(L.validateCommunityName('x'.repeat(41)).error, 'bad_name');
  assert.equal(L.validateCommunityName('x'.repeat(40)).ok, true);
  assert.equal(L.validateCommunityName('<b>Mina</b>').error, 'bad_name');
  assert.equal(L.validateCommunityName(`Mina${String.fromCharCode(0x202e)}x`).error, 'bad_name');
  assert.equal(L.validateCommunityName('Mina Venus').error, 'reserved_name');
  assert.equal(L.validateCommunityName(null).error, 'bad_name');
});

test('descripción, canal y mensaje', () => {
  assert.equal(L.validateDescription(' hola\nchau ', 500).value, 'hola\nchau');
  assert.equal(L.validateDescription('x'.repeat(501), 500).error, 'bad_description');
  assert.equal(L.validateChannelName(' general ').value, 'general');
  assert.equal(L.validateChannelName('  ').error, 'bad_channel_name');
  assert.equal(L.validateChannelName('x'.repeat(31)).error, 'bad_channel_name');
  assert.equal(L.validateMessage('  hola <b>x</b> ').value, 'hola <b>x</b>');
  assert.equal(L.validateMessage('   ').error, 'bad_body');
  assert.equal(L.validateMessage('x'.repeat(2001)).error, 'bad_body');
  assert.equal(L.validateMessage(`👨${String.fromCharCode(0x200d)}💻`).ok, true);
});

test('códigos de invitación y colores ajenos', () => {
  assert.equal(L.normalizeCode('com-abc234', 'COM'), 'COM-ABC234');
  assert.equal(L.normalizeCode(' ABC 234 ', 'COM'), 'COM-ABC234');
  assert.equal(L.normalizeCode('abc', 'COM'), null);
  assert.equal(L.normalizeCode('abc2345', 'COM'), null);
  assert.equal(L.safeColor('#AABBCC'), '#aabbcc');
  assert.equal(L.safeColor('red;background:url(x)'), '#f6b45a');
});

test('errores: el texto del servidor es el código', () => {
  assert.equal(L.classifyGroupError({ code: '22023', message: 'name_taken' }), 'name_taken');
  assert.equal(L.classifyGroupError({ code: '42501', message: 'embeds_forbidden' }), 'embeds_forbidden');
  assert.equal(L.classifyGroupError({ code: '42501', message: 'user_banned' }), 'user_banned');
  assert.equal(L.classifyGroupError({ code: 'PT429', message: 'rate_limited' }), 'rate_limited');
  assert.equal(L.classifyGroupError({ code: '42501', message: 'not_authenticated' }), 'noSession');
  assert.equal(L.classifyGroupError({ code: 'PGRST202', message: 'Could not find the function' }), 'unavailable');
  assert.equal(L.classifyGroupError({ status: 404, message: 'x' }), 'unavailable');
  assert.equal(L.classifyGroupError(new TypeError('Failed to fetch')), 'network');
  assert.equal(L.classifyGroupError({ message: 'Algo Raro Pasó' }), 'server');
  assert.equal(L.classifyGroupError(null), 'server');
});
