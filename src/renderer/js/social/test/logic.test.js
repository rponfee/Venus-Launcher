'use strict';
// Logica pura de lo social de la 3.1 (social/logic.js): bandeja de regalos, quien entro a una sala, libro de
// visitas y la cancion del perfil. Uso: node --test "src/renderer/js/social/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = require('url').pathToFileURL(path.join(__dirname, '..', 'logic.js')).href;
let L;
test.before(async () => {
  L = await import(SRC);
});

const at = (ms) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);

test('regalos nuevos: solo los mas nuevos que lo ultimo visto, del mas viejo al mas nuevo', () => {
  const list = [
    { id: 'c', kind: 'points', value: '50', points: 50, at: at(T0 + 3000) },
    { id: 'a', kind: 'item', value: 'frame_pulse', points: 1800, at: at(T0 + 1000) },
    { id: 'old', kind: 'points', value: '10', points: 10, at: at(T0 - 5000) },
    { id: 'bad', kind: 'cosa', at: at(T0 + 9000) },
    null,
  ];
  assert.deepEqual(L.newGifts(list, at(T0)).map((g) => g.id), ['a', 'c']);
  assert.deepEqual(L.newGifts(list, null).map((g) => g.id), ['old', 'a', 'c']);
  assert.equal(L.latestGiftAt(list, at(T0)), at(T0 + 9000));
  assert.equal(L.latestGiftAt([], at(T0)), at(T0));
  assert.equal(L.latestGiftAt([], null), null);
  assert.equal(L.hasNewGiftIn([{ reason: 'gift_in', at: at(T0 + 1) }], at(T0)), true);
  assert.equal(L.hasNewGiftIn([{ reason: 'gift_in', at: at(T0 - 1) }], at(T0)), false);
  assert.equal(L.hasNewGiftIn([{ reason: 'gift_out', at: at(T0 + 1) }], at(T0)), false);
});

test('salas de voz: quien entro (sin el propio ni la primera lista)', () => {
  const prev = [{ userId: 'me', self: true }, { userId: 'a' }];
  const next = [{ userId: 'me', self: true }, { userId: 'a' }, { userId: 'b' }, { userId: 'c' }];
  assert.deepEqual(L.joinedMembers(prev, next), ['b', 'c']);
  assert.deepEqual(L.joinedMembers(prev, next, { initial: true }), []);
  assert.deepEqual(L.joinedMembers(null, next, { initial: true }), []);
  assert.deepEqual(L.joinedMembers([], [{ userId: 'me', self: true }, { userId: 'x' }], { selfId: 'me' }), ['x']);
  assert.deepEqual(L.joinedMembers(next, prev), []);
  assert.equal(L.ENTRY_EFFECT_MS, 1500);
});

test('libro de visitas: quien puede escribir y como se juntan las paginas', () => {
  assert.equal(L.canPostGuestbook({ isFriend: true, enabled: true }), true);
  assert.equal(L.canPostGuestbook({ isOwner: true, enabled: true }), true);
  assert.equal(L.canPostGuestbook({ isFriend: false, enabled: true }), false);
  assert.equal(L.canPostGuestbook({ isFriend: true, enabled: false }), false);
  assert.equal(L.canPostGuestbook({ isFriend: true, enabled: true, blocked: true }), false);
  assert.equal(L.canPostGuestbook({ isFriend: true, enabled: true, moderation: { muted: true } }), false);
  assert.equal(L.canPostGuestbook({ isFriend: true, enabled: true, moderation: { muted: false, banned: false } }), true);
  const a = [{ id: '1', at: at(T0 + 2000) }, { id: '2', at: at(T0 + 1000) }];
  const b = [{ id: '2', at: at(T0 + 1000) }, { id: '3', at: at(T0) }, { bad: true }];
  assert.deepEqual(L.mergeGuestbook(a, b).map((e) => e.id), ['1', '2', '3']);
  assert.equal(L.oldestGuestbookAt(L.mergeGuestbook(a, b)), at(T0));
  assert.equal(L.oldestGuestbookAt([]), null);
  assert.equal(L.GUESTBOOK_PAGE, 10);
});

test('cancion del perfil: cuando arranca sola y el paso del volumen', () => {
  const song = { url: 'https://x.supabase.co/storage/v1/object/public/profile-audio/u/song.webm' };
  assert.equal(L.shouldAutoplaySong({ song, friend: true }), true);
  assert.equal(L.shouldAutoplaySong({ song, self: true }), true);
  assert.equal(L.shouldAutoplaySong({ song, friend: true, allowed: false }), false);
  assert.equal(L.shouldAutoplaySong({ song, friend: true, preview: true }), false);
  assert.equal(L.shouldAutoplaySong({ song }), false);
  assert.equal(L.shouldAutoplaySong({ song: null, friend: true }), false);
  assert.equal(L.volumeStep(0.6, 1), 0.7);
  assert.equal(L.volumeStep(1, 1), 1);
  assert.equal(L.volumeStep(0.05, -1), 0);
  assert.equal(L.volumeStep(NaN, 1), 0.7);
});
