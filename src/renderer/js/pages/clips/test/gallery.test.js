'use strict';
// Galeria publica: que se acepta de lo que manda el servidor (modulo ES de la interfaz, sin DOM)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'gallery-logic.js')).href);
const PROJECT = 'https://dzchklzaxyygbvfpagvx.supabase.co';
const GOOD = `${PROJECT}/storage/v1/object/sign/clips/11111111-2222-3333-4444-555555555555/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.webm?token=aa.bb-cc_dd`;

test('solo links firmados de clips del Storage del launcher', async () => {
  const { safeClipUrl } = await load();
  assert.equal(safeClipUrl(GOOD, PROJECT), GOOD);
  for (const bad of [
    'https://evil.example/x.webm',
    'http://dzchklzaxyygbvfpagvx.supabase.co/storage/v1/object/sign/clips/a/b.webm?token=x',
    `${PROJECT}/storage/v1/object/public/clips/a/b.webm`,
    `${PROJECT}/storage/v1/object/sign/screenshots/a/b.png?token=x`,
    `${PROJECT}/storage/v1/object/sign/clips/a/b/c.webm?token=x`,
    `https://x:y@dzchklzaxyygbvfpagvx.supabase.co/storage/v1/object/sign/clips/a/b.webm?token=x`,
    `https://otro.supabase.co/storage/v1/object/sign/clips/a/b.webm?token=x`,
    'javascript:alert(1)',
    'file:///C:/x.webm',
    '',
    null,
  ]) {
    assert.equal(safeClipUrl(bad, PROJECT), null, String(bad));
  }
  assert.equal(safeClipUrl(GOOD, ''), null, 'sin proyecto, nada');
});

test('miniatura: solo una imagen embebida', async () => {
  const { safeThumb } = await load();
  assert.equal(safeThumb('data:image/jpeg;base64,AAAA'), 'data:image/jpeg;base64,AAAA');
  for (const bad of ['https://evil.example/a.jpg', 'data:image/svg+xml;base64,AAAA', 'data:text/html;base64,AAAA', `data:image/jpeg;base64,${'A'.repeat(40000)}`, null, 3]) assert.equal(safeThumb(bad), null);
});

test('una fila del servidor queda limpia y un titulo ajeno es solo texto', async () => {
  const { normalizeClip, cleanTitle } = await load();
  const c = normalizeClip({ id: 'x', title: 'a\nb  <img src=x onerror=alert(1)>', url: GOOD, at: '2026-11-03T12:00:00Z', expiresAt: '2027-01-01T00:00:00Z', likes: 3, likesWeek: '2', liked: true, mine: 1, author: { id: 'u', displayName: 'Ana', mcName: 'ana_mc' } }, PROJECT);
  assert.equal(c.title, 'a b <img src=x onerror=alert(1)>', 'se conserva como texto: la interfaz lo dibuja con h(), nunca como HTML');
  assert.equal(c.url, GOOD);
  assert.equal(c.likes, 3);
  assert.equal(c.likesWeek, 2);
  assert.equal(c.mine, false, 'solo true cuenta');
  assert.equal(c.author.name, 'Ana');
  assert.ok(c.at > 0);
  assert.equal(normalizeClip(null, PROJECT), null);
  assert.equal(normalizeClip({ title: 'sin id' }, PROJECT), null);
  assert.equal(normalizeClip({ id: 'x', url: 'https://evil.example/x' }, PROJECT).url, null);
  assert.equal(cleanTitle('x'.repeat(120)).length, 80);
});

test('la lista publica saca lo que no tiene un link valido; las propias se quedan para dar el aviso', async () => {
  const { visibleClips, ownClips } = await load();
  const rows = [{ id: 'a', url: GOOD, title: 'ok' }, { id: 'b', url: 'https://evil.example/x', title: 'mala' }, { id: 'c', url: null, title: 'vencida', expired: true }, 'basura'];
  assert.deepEqual(visibleClips(rows, PROJECT).map((c) => c.id), ['a']);
  assert.deepEqual(ownClips(rows, PROJECT).map((c) => c.id), ['a', 'b', 'c']);
  assert.deepEqual(visibleClips(null, PROJECT), []);
});

test('estado de un clip propio y aviso de vencimiento', async () => {
  const { ownState, expiresSoon } = await load();
  const now = Date.UTC(2026, 10, 3);
  assert.equal(ownState({ hidden: true }, now), 'hidden');
  assert.equal(ownState({ expired: true }, now), 'expired');
  assert.equal(ownState({ expiresAt: now - 1 }, now), 'expired');
  assert.equal(ownState({ expiresAt: now + 1000 }, now), 'live');
  assert.equal(expiresSoon({ expiresAt: now + 86400000 }, now), true);
  assert.equal(expiresSoon({ expiresAt: now + 40 * 86400000 }, now), false);
  assert.equal(expiresSoon({ expiresAt: now - 1 }, now), false);
});

test('like optimista', async () => {
  const { toggledLike } = await load();
  assert.deepEqual(toggledLike({ liked: false, likes: 2, likesWeek: 1 }), { liked: true, likes: 3, likesWeek: 2 });
  assert.deepEqual(toggledLike({ liked: true, likes: 0, likesWeek: 0 }), { liked: false, likes: 0, likesWeek: 0 });
});

test('los errores de las RPC se reconocen; lo demas es el servicio', async () => {
  const { errorCode } = await load();
  assert.equal(errorCode({ message: 'too_many_today' }), 'too_many_today');
  assert.equal(errorCode({ message: 'user_banned' }), 'user_banned');
  assert.equal(errorCode({ code: 'PGRST202', message: 'Could not find the function' }), 'unavailable');
  assert.equal(errorCode({ code: '42883', message: 'x' }), 'unavailable');
  assert.equal(errorCode(new TypeError('Failed to fetch')), 'network');
  assert.equal(errorCode({ message: 'algo raro' }), 'unavailable');
});
