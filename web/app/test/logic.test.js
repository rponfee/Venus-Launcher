'use strict';
// Lógica pura de la app del celular: presencia, listas, links, rutas, errores y validación de medios.
const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../js/shared/texts.js');
const media = require('../js/shared/media.js');

const logic = import('../js/logic.js');
const BASE = 'https://proyecto.supabase.co';
const A = '11111111-2222-4333-8444-555555555555';
const B = '99999999-2222-4333-8444-555555555555';
const S = '77777777-2222-4333-8444-555555555555';
const tr = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

test('presencia: 2,5 minutos sin latido es desconectado y el celular no inventa actividad', async () => {
  const { presenceOf, STALE_MS } = await logic;
  const now = Date.now();
  const row = (status, age, activity = null) => ({ status, activity, updated_at: new Date(now - age).toISOString() });
  assert.deepEqual(presenceOf(null, now), { presence: 'offline', activity: null });
  assert.equal(presenceOf(row('online', 1000), now).presence, 'online');
  assert.equal(presenceOf(row('online', STALE_MS + 1), now).presence, 'offline');
  assert.equal(presenceOf(row('offline', 0), now).presence, 'offline');
  assert.equal(presenceOf(row('raro', 0), now).presence, 'online');
  assert.equal(presenceOf(row('online', 0, { type: 'menu', mcVersion: '1.21' }), now).activity.type, 'menu');
  assert.equal(presenceOf(row('online', STALE_MS + 1, { type: 'menu' }), now).activity, null);
});

test('actividad: lo que manda un amigo se valida antes de mostrarlo', async () => {
  const { sanitizeActivity, activityLine, publicAddress } = await logic;
  assert.equal(sanitizeActivity('x'), null);
  assert.equal(sanitizeActivity({ type: 'otro' }), null);
  assert.equal(sanitizeActivity({ type: 'server', address: '192.168.0.10', mcVersion: '1.21' }).address, null);
  assert.equal(sanitizeActivity({ type: 'server', address: 'mc.hypixel.net:25565' }).address, 'mc.hypixel.net:25565');
  assert.equal(sanitizeActivity({ type: 'menu', mcVersion: '<img src=x>' }).mcVersion, '');
  assert.equal(sanitizeActivity({ type: 'menu', loader: '__proto__' }).loader, '');
  assert.equal(publicAddress('localhost'), null);
  assert.equal(publicAddress('10.0.0.1'), null);
  assert.equal(publicAddress('mi.server.local'), null);
  assert.equal(publicAddress('8.8.8.8'), '8.8.8.8');
  assert.equal(activityLine(null, tr), '');
  assert.match(activityLine({ type: 'server', mcVersion: '1.21.1', loader: 'fabric', address: 'mc.hypixel.net' }, tr), /act_server.*1\.21\.1 Fabric.*mc\.hypixel\.net/);
  assert.match(activityLine({ type: 'server', mcVersion: '1.21.1', loader: '', address: null }, tr), /act_multiplayer/);
  assert.match(activityLine({ type: 'singleplayer', mcVersion: '', loader: '', world: 'Base' }, tr), /act_world.*Minecraft.*Base/);
  assert.match(activityLine({ type: 'menu', mcVersion: '1.8', loader: '' }, tr), /act_menu/);
});

test('agregar por código: formato y tu propio código', async () => {
  const { validFriendQuery } = await logic;
  assert.deepEqual(validFriendQuery('  VENUS-AB12CD '), { ok: true, query: 'VENUS-AB12CD' });
  assert.equal(validFriendQuery('venusab12cd').ok, true);
  assert.equal(validFriendQuery('@luna_mc').ok, true);
  assert.equal(validFriendQuery('a b').error, 'invalid_query');
  assert.equal(validFriendQuery('').error, 'invalid_query');
  assert.equal(validFriendQuery('venus-ab12cd', 'VENUS-AB12CD').error, 'cannot_add_self');
  assert.equal(validFriendQuery('VENUSAB12CD', 'VENUS-AB12CD').error, 'cannot_add_self');
});

test('listas: en línea primero, solicitudes separadas y bloqueos fuera', async () => {
  const { buildLists } = await logic;
  const now = Date.now();
  const me = 'yo';
  const profiles = new Map([
    ['a', { id: 'a', username: 'ana' }],
    ['b', { id: 'b', display_name: ' Beto ', username: 'beto' }],
    ['c', { id: 'c', username: 'caro' }],
    ['d', { id: 'd', username: 'dani' }],
  ]);
  const activity = new Map([['b', { status: 'online', updated_at: new Date(now).toISOString(), activity: null }]]);
  const out = buildLists({
    friendships: [
      { id: '1', requester: me, addressee: 'a', status: 'accepted' },
      { id: '2', requester: 'b', addressee: me, status: 'accepted' },
      { id: '3', requester: 'c', addressee: me, status: 'pending', created_at: new Date(now).toISOString() },
      { id: '4', requester: me, addressee: 'd', status: 'pending', created_at: new Date(now).toISOString() },
      { id: '5', requester: me, addressee: 'x', status: 'blocked' },
    ],
    profiles,
    activity,
    chatFor: () => null,
    me,
    nowMs: now,
    someone: 'Alguien',
  });
  assert.deepEqual(out.friends.map((f) => f.name), ['Beto', 'ana']);
  assert.equal(out.friends[0].presence, 'online');
  assert.deepEqual(out.incoming.map((r) => r.id), ['c']);
  assert.deepEqual(out.outgoing.map((r) => r.id), ['d']);
});

test('el estado escrito vencido no se muestra', async () => {
  const { statusTextOf } = await logic;
  const now = Date.now();
  assert.equal(statusTextOf({ status_text: 'hola' }, now), 'hola');
  assert.equal(statusTextOf({ status_text: 'hola', status_until: new Date(now - 1).toISOString() }, now), '');
  assert.equal(statusTextOf({ status_text: 'hola', status_until: new Date(now + 9999).toISOString() }, now), 'hola');
  assert.equal(statusTextOf({ status_text: 'con\u0000control' }, now), 'concontrol');
});

test('mensajes: orden, reemplazo por id y la copia local no pisa a la del servidor', async () => {
  const { upsertMessage } = await logic;
  let list = [];
  list = upsertMessage(list, { id: 'b', created_at: '2026-01-01T00:00:02Z', body: 'dos' });
  list = upsertMessage(list, { id: 'a', created_at: '2026-01-01T00:00:01Z', body: 'uno' });
  assert.deepEqual(list.map((m) => m.id), ['a', 'b']);
  list = upsertMessage(list, { id: 'b', created_at: '2026-01-01T00:00:02Z', body: 'editado' });
  assert.equal(list[1].body, 'editado');
  const before = list;
  assert.equal(upsertMessage(list, { id: 'b', created_at: '2026-01-01T00:00:02Z', body: 'viejo', _local: 'pending' }), before);
  list = upsertMessage(list, { id: 'c', created_at: '2026-01-01T00:00:03Z', body: 'x', _local: 'pending' });
  list = upsertMessage(list, { id: 'c', created_at: '2026-01-01T00:00:03Z', body: 'x' });
  assert.equal(list[2]._local, undefined);
});

test('links: solo http y https, sin el signo de puntuación final', async () => {
  const { splitLinks } = await logic;
  assert.deepEqual(splitLinks('mirá https://a.com/x, dale'), [{ text: 'mirá ' }, { url: 'https://a.com/x' }, { text: ', dale' }]);
  assert.deepEqual(splitLinks('javascript:alert(1) <img src=x>'), [{ text: 'javascript:alert(1) <img src=x>' }]);
  assert.deepEqual(splitLinks('https://es.wikipedia.org/wiki/Foo_(bar)'), [{ url: 'https://es.wikipedia.org/wiki/Foo_(bar)' }]);
  assert.deepEqual(splitLinks(''), []);
});

test('GIF y sticker: solo la dirección exacta, y del que escribió', () => {
  assert.equal(media.gifOf('https://static.klipy.com/ii/a/b.gif'), 'https://static.klipy.com/ii/a/b.gif');
  assert.equal(media.gifOf('https://static12.klipy.com/a.webp?x=1'), 'https://static12.klipy.com/a.webp?x=1');
  for (const no of ['mirá https://static.klipy.com/a.gif', 'https://evil.com/a.gif', 'https://static.klipy.com.evil.com/a.gif', 'http://static.klipy.com/a.gif', 'https://static.klipy.com/a b.gif', 'https://static.klipy.com/"><img>', '', null]) {
    assert.equal(media.gifOf(no), null, String(no));
  }
  const url = `${BASE}/storage/v1/object/public/stickers/${A}/${S}.png`;
  assert.deepEqual(media.stickerOf(url, A, BASE), { id: S, userId: A, url });
  assert.equal(media.stickerOf(url, B, BASE), null, 'de otra carpeta');
  assert.equal(media.stickerOf(url, A, 'https://otro.supabase.co'), null, 'de otro proyecto');
  assert.equal(media.stickerOf(`hola ${url}`, A, BASE), null, 'con texto al lado');
  assert.equal(media.stickerOf(`${BASE}/storage/v1/object/public/stickers/${A}/${S}.svg`, A, BASE), null, 'otro tipo');
  assert.equal(media.stickerOf(`${BASE}/storage/v1/object/public/stickers/${A}/../${S}.png`, A, BASE), null, 'con salto de carpeta');
});

test('medios de clips: solo links firmados del proyecto', () => {
  const ok = `${BASE}/storage/v1/object/sign/clips/${A}/x.webm?token=abc`;
  assert.equal(media.signedMedia(ok, BASE), ok);
  assert.equal(media.signedMedia(`${BASE}/storage/v1/object/sign/screenshots/${A}/x.png?token=abc`, BASE) !== null, true);
  for (const no of [
    `${BASE}/storage/v1/object/public/clips/${A}/x.webm`,
    `${BASE}/storage/v1/object/sign/world-saves/${A}/x?token=a`,
    `https://otro.supabase.co/storage/v1/object/sign/clips/${A}/x.webm?token=a`,
    `http://proyecto.supabase.co/storage/v1/object/sign/clips/${A}/x.webm?token=a`,
    `https://user:clave@proyecto.supabase.co/storage/v1/object/sign/clips/${A}/x.webm?token=a`,
    'javascript:alert(1)',
    `${BASE}/storage/v1/object/sign/clips/${'x'.repeat(2100)}`,
    '',
    null,
  ]) {
    assert.equal(media.signedMedia(no, BASE), null, String(no).slice(0, 80));
  }
});

test('rutas: lo desconocido cae en Amigos y un id raro no abre nada', async () => {
  const { parseRoute } = await logic;
  assert.deepEqual(parseRoute('#/friends'), { page: 'friends' });
  assert.deepEqual(parseRoute(''), { page: 'friends' });
  assert.deepEqual(parseRoute('#/cualquiera'), { page: 'friends' });
  assert.deepEqual(parseRoute('#/messages'), { page: 'messages' });
  assert.deepEqual(parseRoute(`#/messages/${A}`), { page: 'chat', userId: A });
  assert.deepEqual(parseRoute('#/messages/<script>'), { page: 'messages' });
  assert.deepEqual(parseRoute('#/clips/mine'), { page: 'clips', tab: 'mine' });
  assert.deepEqual(parseRoute('#/clips/raro'), { page: 'clips', tab: 'received' });
  assert.deepEqual(parseRoute('#/inbox'), { page: 'inbox' });
  assert.deepEqual(parseRoute('#/account'), { page: 'account' });
});

test('el cliente falso solo se activa en localhost y con el parámetro', async () => {
  const { fakeAllowed } = await logic;
  assert.equal(fakeAllowed({ hostname: 'localhost', search: '?fake=1' }), true);
  assert.equal(fakeAllowed({ hostname: '127.0.0.1', search: '?fake=1' }), true);
  assert.equal(fakeAllowed({ hostname: 'localhost', search: '' }), false);
  assert.equal(fakeAllowed({ hostname: 'localhost', search: '?fake=0' }), false);
  assert.equal(fakeAllowed({ hostname: 'venus.netlify.app', search: '?fake=1' }), false);
  assert.equal(fakeAllowed({ hostname: 'localhost.evil.com', search: '?fake=1' }), false);
});

test('errores: claves conocidas, falta de esquema y red, sin mostrar el detalle técnico', async () => {
  const { errorKey, authErrorKey, isMissing, isNetwork } = await logic;
  assert.equal(errorKey({ message: 'user_not_found', code: 'P0002' }), 'err_user_not_found');
  assert.equal(errorKey({ message: 'user_muted', code: 'P0001' }), 'err_user_muted');
  assert.equal(errorKey({ message: 'Could not find the function public.app_inbox', code: 'PGRST202' }), 'err_service');
  assert.equal(errorKey({ message: 'TypeError: Failed to fetch' }), 'err_network');
  assert.equal(errorKey({ message: 'new row violates row-level security policy', code: '42501' }), 'err_not_friends');
  assert.equal(errorKey({ message: 'select secreto from x failed', code: 'XX000' }), 'err_generic');
  assert.equal(authErrorKey({ code: 'invalid_credentials' }), 'auth_credentials');
  assert.equal(authErrorKey({ message: 'Email not confirmed' }), 'auth_not_confirmed');
  assert.equal(authErrorKey({ code: 'otp_expired' }), 'auth_code');
  assert.equal(authErrorKey({ status: 429 }), 'auth_rate');
  assert.equal(authErrorKey({ name: 'AuthRetryableFetchError' }), 'err_network');
  assert.equal(isMissing({ code: '42883' }), true);
  assert.equal(isMissing({ code: '42501' }), false);
  assert.equal(isNetwork({ status: 0 }), true);
});

test('soporte de avisos: en iPhone sin instalar se pide instalarla', async () => {
  const { pushSupport, deviceLabel, isIos, urlB64ToBytes, sameKeyBytes } = await logic;
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)';
  assert.equal(pushSupport({ hasSW: true, hasPush: true, hasNotification: true, ua: iphone }), 'ok');
  assert.equal(pushSupport({ hasSW: true, hasPush: false, hasNotification: false, standalone: false, ua: iphone }), 'ios_install');
  assert.equal(pushSupport({ hasSW: true, hasPush: false, hasNotification: false, standalone: true, ua: iphone }), 'ios_old');
  assert.equal(pushSupport({ hasSW: false, hasPush: false, hasNotification: false, ua: 'Android' }), 'unsupported');
  assert.equal(isIos('Macintosh', 'MacIntel', 5), true, 'iPad que se presenta como Mac');
  assert.equal(isIos('Macintosh', 'MacIntel', 0), false);
  assert.equal(deviceLabel(iphone), 'iPhone');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14)'), 'Android');
  const bytes = urlB64ToBytes('BAEC_-0');
  assert.deepEqual([...bytes], [4, 1, 2, 255, 237]);
  assert.equal(sameKeyBytes(bytes.buffer, bytes), true);
  assert.equal(sameKeyBytes(new Uint8Array([1]).buffer, bytes), false);
  assert.equal(sameKeyBytes(null, bytes), false);
});

test('clips: se normaliza lo propio, lo recibido y lo de la galería', async () => {
  const { normalizeMine, normalizeReceived, normalizeGallery, formatBytes, previewText } = await logic;
  const mine = normalizeMine({ id: '1', kind: 'clip', file_name: 'a.webm', world: 'Base', size_bytes: 10, expires_at: new Date(Date.now() - 1000).toISOString(), bucket: 'clips', path: 'x' });
  assert.equal(mine.expired, true);
  assert.equal(mine.place, 'Base');
  assert.equal(normalizeReceived({ id: '2', kind: 'otro', name: 'n', from: 'Luna', at: 'x', url: 'u', seen: 1 }).kind, 'screenshot');
  assert.deepEqual(normalizeGallery(null), []);
  assert.deepEqual(normalizeGallery([{ nada: 1 }]), []);
  const g = normalizeGallery({ items: [{ id: 5, title: 'T', author: { name: 'A' }, url: 'u', at: 'c', thumb: 'data:x' }], more: false });
  assert.deepEqual(g, [{ id: '5', kind: 'clip', name: 'T', from: 'A', at: 'c', url: 'u' }]);
  assert.equal(normalizeGallery([{ id: 6, title: 'x', author: 'B' }])[0].from, 'B');
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  const ctx = { me: A, base: BASE, media, tr };
  assert.match(previewText({ senderId: B, body: 'hola' }, ctx), /hola/);
  assert.match(previewText({ senderId: A, body: 'hola' }, ctx), /msg_you/);
  assert.equal(previewText({ senderId: B, deleted: true }, ctx), 'msg_deleted_short');
  assert.equal(previewText({ senderId: B, body: `${BASE}/storage/v1/object/public/stickers/${B}/${S}.png` }, ctx), 'preview_sticker');
  assert.equal(previewText({ senderId: B, body: 'https://static.klipy.com/a.gif' }, ctx), 'preview_gif');
});
