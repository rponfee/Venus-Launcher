import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../../features/communities/greeting.js';

test('la plantilla da lo mismo que private.community_greeting_render', () => {
  // Mismo vector que supabase/tests/communities-local.sql: las dos implementaciones tienen que coincidir.
  assert.equal(G.renderGreeting('Hola {usuario} en {Comunidad}, somos {MIEMBROS} ({user}/{community}/{members})', { user: 'A{b}c\\d&e', community: 'Co{x}', members: 3 }),
    'Hola Abc\\d&e en Cox, somos 3 (Abc\\d&e/Cox/3)');
  assert.equal(G.renderGreeting('', { user: 'A', community: 'B', members: 1 }), '');
  assert.equal(G.renderGreeting('  {nombre} {usuario}  ', { user: 'Ana' }), '{nombre} Ana');
  assert.equal(G.renderGreeting('Somos {miembros}', { members: -4 }), 'Somos 0');
  assert.equal(G.renderGreeting('{usuario}', { user: '{comunidad}', community: 'Mina' }), 'comunidad', 'un nombre con llaves no se vuelve a reemplazar');
});

test('solo variables conocidas', () => {
  assert.equal(G.greetingVariablesOk('Hola {usuario} {comunidad} {miembros} {user} {community} {members}'), true);
  assert.equal(G.greetingVariablesOk('Hola {nombre}'), false);
  assert.equal(G.greetingVariablesOk('{}'), false);
  assert.equal(G.greetingVariablesOk('sin variables'), true);
  assert.equal(G.greetingVariablesOk('llave sola { sin cerrar'), true);
  assert.equal(G.greetingVariablesOk('entre llaves { y otra }'), false, 'cualquier par de llaves se toma por una variable (igual que el servidor)');
});

test('canales donde se puede publicar', () => {
  const channels = [{ id: 'a', kind: 'text' }, { id: 'b', kind: 'announcement' }, { id: 'c', kind: 'voice' }, { id: 'd', kind: 'forum' }, { id: 'e', kind: 'text', isPrivate: true }];
  assert.deepEqual(G.greetingChannels(channels).map((c) => c.id), ['a', 'b']);
  assert.deepEqual(G.greetingChannels(null), []);
});

test('validación antes de guardar', () => {
  const channels = [{ id: 'a', kind: 'text' }, { id: 'p', kind: 'text', isPrivate: true }];
  const ok = G.validateGreeting({ enabled: true, channelId: 'a', body: ' Hola {usuario} ', media: null }, channels);
  assert.deepEqual(ok, { ok: true, value: { enabled: true, channelId: 'a', body: 'Hola {usuario}', media: null } });
  assert.equal(G.validateGreeting({ enabled: true, channelId: null, body: 'x' }, channels).error, 'greeting_needs_channel');
  assert.equal(G.validateGreeting({ enabled: true, channelId: 'a', body: '' }, channels).error, 'greeting_empty');
  assert.equal(G.validateGreeting({ enabled: true, channelId: 'a', body: '', media: { kind: 'klipy', url: 'https://static.klipy.com/a.gif' } }, channels).ok, true);
  assert.equal(G.validateGreeting({ enabled: false, channelId: 'p', body: 'x' }, channels).error, 'bad_greeting_channel');
  assert.equal(G.validateGreeting({ body: 'Hola {nombre}' }, channels).error, 'bad_greeting_variable');
  assert.equal(G.validateGreeting({ body: 'x'.repeat(501) }, channels).error, 'bad_greeting_text');
  assert.equal(G.validateGreeting({ enabled: false, channelId: null, body: '' }, channels).ok, true);
});

test('solo se manda lo que cambió', () => {
  const saved = { enabled: true, channelId: 'a', body: 'Hola', media: null };
  assert.equal(G.greetingPatch(saved, { ...saved }), null);
  assert.deepEqual(G.greetingPatch(saved, { ...saved, body: 'Chau' }), { body: 'Chau' });
  assert.deepEqual(G.greetingPatch(saved, { ...saved, enabled: false, channelId: null }), { enabled: false, channelId: null });
  assert.deepEqual(G.greetingPatch(null, { enabled: false, channelId: null, body: '', media: { kind: 'upload', id: 'x' } }), { media: { kind: 'upload', id: 'x' } });
  assert.deepEqual(G.greetingPatch(saved, { ...saved, media: null }), null);
});

test('GIF de KLIPY con la forma que acepta el servidor', () => {
  assert.deepEqual(G.klipyMedia({ url: 'https://static.klipy.com/a.gif', still: 'https://static.klipy.com/a.jpg', slug: 'gato', title: 'x', thumb: 'y' }),
    { kind: 'klipy', url: 'https://static.klipy.com/a.gif', still: 'https://static.klipy.com/a.jpg', slug: 'gato' });
  assert.deepEqual(G.klipyMedia({ url: 'https://static.klipy.com/a.gif', slug: null }), { kind: 'klipy', url: 'https://static.klipy.com/a.gif' });
});
