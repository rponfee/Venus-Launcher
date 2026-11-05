'use strict';
// Perfil y social 3.1 (features/profile-editor/model.js): tema, burbuja, entrada y cancion de card_style, emoji y
// vencimiento del estado, poses, fondos e insignias raras de showcase, limites de los regalos, URL de KLIPY y el
// nombre del archivo de audio. Uso: node --test "src/renderer/js/features/profile-editor/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = require('url').pathToFileURL(path.join(__dirname, '..', 'model.js')).href;
let M;
test.before(async () => {
  M = await import(SRC);
});

const UID = '0b5b9a3e-1f0c-4c55-9a51-2d1c7e3f4a10';
const OTHER = '9d9d9d9d-1111-4222-8333-444455556666';
// Cancion de perfil (4.6): formato de Openverse (music-logic.js)
const song = (extra = {}) => ({
  provider: 'openverse',
  id: '3de3576d-6bc6-4493-a75d-cd48e40e154d',
  title: 'Tema',
  creator: 'Autora',
  license: 'by-sa',
  licenseVersion: '4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  landing: 'https://www.jamendo.com/track/1132192',
  url: 'https://prod-1.storage.jamendo.com/?trackid=1132192&format=mp32',
  start: 10,
  len: 30,
  ...extra,
});
const OLD_SONG = `https://abcdefgh.supabase.co/storage/v1/object/public/profile-audio/${UID}/song.webm`;

// ---------- card_style ----------
test('cardStyle: tema, burbuja, entrada, cancion y libro validos', () => {
  const ctx = { userId: UID, premium: true };
  assert.equal(M.validateField('cardStyle', { theme: { id: 'nether' } }, ctx), null);
  assert.equal(M.validateField('cardStyle', { theme: { id: 'space', particles: true } }, ctx), null);
  assert.equal(M.validateField('cardStyle', { bubble: { style: 'pixel', color: '#7df9ff' } }, ctx), null);
  assert.equal(M.validateField('cardStyle', { bubble: { style: 'round', color: null } }, ctx), null);
  assert.equal(M.validateField('cardStyle', { entry: 'ender' }, ctx), null);
  assert.equal(M.validateField('cardStyle', { song: song() }, ctx), null);
  assert.equal(M.validateField('cardStyle', { song: null, guestbook: true }, ctx), null);
});

test('cardStyle: rechaza lo que no esta en el catalogo o no es del usuario', () => {
  const ctx = { userId: UID, premium: false };
  assert.equal(M.validateField('cardStyle', { theme: { id: 'lava' } }, ctx), 'bad_cardStyle');
  assert.equal(M.validateField('cardStyle', { theme: { id: 'end', particles: 'si' } }, ctx), 'bad_cardStyle');
  assert.equal(M.validateField('cardStyle', { theme: { id: 'end', particles: true } }, ctx), 'premium_required:cardStyle');
  assert.equal(M.validateField('cardStyle', { theme: { id: 'end', particles: true } }, { ...ctx, owned: ['extra_particles'] }), null);
  assert.equal(M.validateField('cardStyle', { bubble: { style: 'cloud' } }, ctx), 'bad_cardStyle');
  assert.equal(M.validateField('cardStyle', { bubble: { style: 'round', color: 'red' } }, ctx), 'bad_cardStyle');
  assert.equal(M.validateField('cardStyle', { entry: 'fire' }, ctx), 'bad_cardStyle');
  assert.equal(M.validateField('cardStyle', { guestbook: 'yes' }, ctx), 'bad_cardStyle');
  assert.equal(M.validateField('cardStyle', { song: { url: OLD_SONG, title: 'Tema' } }, ctx), 'bad_cardStyle', 'el archivo propio de la 3.1 ya no vale');
  assert.equal(M.validateField('cardStyle', { song: song({ url: 'https://evil.invalid/a.mp3' }) }, ctx), 'bad_cardStyle');
  assert.equal(M.validateField('cardStyle', { song: song({ title: 'x'.repeat(81) }) }, ctx), 'bad_cardStyle');
  assert.equal(M.validateField('cardStyle', { song: song({ license: 'by-nc', licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/' }) }, ctx), 'bad_cardStyle');
  assert.equal(M.validateField('cardStyle', { song: song({ title: '<b>Tema</b>' }) }, ctx), 'bad_cardStyle');
  assert.equal(M.validateField('cardStyle', { song: song({ extra: 1 }) }, ctx), 'bad_cardStyle');
  assert.equal(M.validateField('cardStyle', { pattern: 'dots', tema: 'x' }, ctx), 'bad_cardStyle');
});

test('cardStyle: se normaliza y lo que queda por defecto no viaja en el patch', () => {
  const n = M.normalizeProfile({ id: UID, card_style: { theme: { id: 'ocean', particles: true }, bubble: { style: 'sharp', color: '#ABCDEF' }, entry: 'snow', song: song({ title: 'Hola' }), guestbook: true } });
  assert.deepEqual(n.cardStyle.theme, { id: 'ocean', particles: true });
  assert.deepEqual(n.cardStyle.bubble, { style: 'sharp', color: '#abcdef' });
  assert.equal(n.cardStyle.entry, 'snow');
  assert.deepEqual(n.cardStyle.song, song({ title: 'Hola' }));
  assert.equal(n.cardStyle.guestbook, true);
  const bad = M.normalizeProfile({ id: UID, card_style: { theme: { id: 'nope' }, bubble: { style: 'x', color: 'y' }, entry: 'z', song: { url: OLD_SONG, title: 'viejo' } } });
  assert.deepEqual(bad.cardStyle.theme, { id: 'none', particles: false });
  assert.deepEqual(bad.cardStyle.bubble, { style: 'default', color: null });
  assert.equal(bad.cardStyle.entry, 'none');
  assert.equal(bad.cardStyle.song, null);
  const c = M.canonical({ cardStyle: { theme: { id: 'none', particles: false }, bubble: { style: 'default', color: null }, entry: 'none', song: null, guestbook: false } });
  assert.deepEqual(c.cardStyle, {});
  const c2 = M.canonical({ cardStyle: { theme: { id: 'aurora', particles: false }, bubble: { style: 'default', color: '#112233' }, entry: 'spark', song: song(), guestbook: true } });
  assert.deepEqual(c2.cardStyle, { theme: { id: 'aurora' }, bubble: { style: 'default', color: '#112233' }, entry: 'spark', song: song(), guestbook: true });
  const patch = M.buildPatch({ cardStyle: { theme: { id: 'aurora' } } }, { cardStyle: { theme: { id: 'aurora', particles: false }, bubble: { style: 'default', color: null } } });
  assert.deepEqual(patch, {});
});

// ---------- showcase ----------
test('showcase: pose, fondo e insignias raras', () => {
  assert.equal(M.validateField('showcase', { skinPose: 'wave', skinBg: 'cave', rareBadges: ['dragon_1', 'night_owl'] }), null);
  assert.equal(M.validateField('showcase', { skinPose: 'fly' }), 'bad_showcase');
  assert.equal(M.validateField('showcase', { skinBg: 'lava' }), 'bad_showcase');
  assert.equal(M.validateField('showcase', { rareBadges: ['a', 'b', 'c', 'd'] }), 'bad_showcase');
  assert.equal(M.validateField('showcase', { rareBadges: ['Bad Id'] }), 'bad_showcase');
  const n = M.normalizeProfile({ id: UID, showcase: { skinPose: 'sit', skinBg: 'snow', rareBadges: [{ id: 'dragon_1', at: '2025-01-01T00:00:00Z' }, 'night_owl', 'x y', 'cc', 'dd'] } });
  assert.equal(n.showcase.skinPose, 'sit');
  assert.equal(n.showcase.skinBg, 'snow');
  assert.deepEqual(n.showcase.rareBadges.map((a) => a.id), ['dragon_1', 'night_owl', 'cc']);
  const d = M.normalizeProfile({ id: UID, showcase: { skinPose: 'nope' } });
  assert.equal(d.showcase.skinPose, 'stand');
  assert.equal(d.showcase.skinBg, 'none');
  const c = M.canonical({ showcase: { skin: false, skinPose: 'stand', skinBg: 'none', rareBadges: [] } });
  assert.deepEqual(c.showcase, {});
  const c2 = M.canonical({ showcase: { skinPose: 'walk', skinBg: 'end', rareBadges: ['a', 'b', 'c', 'd'] } });
  assert.deepEqual(c2.showcase, { skinPose: 'walk', skinBg: 'end', rareBadges: ['a', 'b', 'c'] });
  assert.deepEqual(M.customOf(n).showcase.rareBadges, ['dragon_1', 'night_owl', 'cc']);
});

// ---------- estado ----------
test('estado: emoji, union, vencimiento', () => {
  assert.ok(M.isEmoji('🔥'));
  assert.ok(M.isEmoji('❤️'));
  assert.ok(M.isEmoji('👍🏽'));
  assert.ok(!M.isEmoji('a'));
  assert.ok(!M.isEmoji('🔥🔥'));
  assert.ok(!M.isEmoji(''));
  assert.ok(M.STATUS_EMOJIS.length === 60 && M.STATUS_EMOJIS.every(M.isEmoji));
  assert.deepEqual(M.splitStatus('🔥 Jugando bedwars'), { emoji: '🔥', text: 'Jugando bedwars' });
  assert.deepEqual(M.splitStatus('Jugando bedwars'), { emoji: null, text: 'Jugando bedwars' });
  assert.deepEqual(M.splitStatus(''), { emoji: null, text: '' });
  assert.equal(M.joinStatus('🔥', '  hola '), '🔥 hola');
  assert.equal(M.joinStatus(null, 'hola'), 'hola');
  assert.equal(M.joinStatus('xx', ''), null);
  // el emoji ocupa dos unidades UTF-16: 2 + espacio + 70 de texto
  assert.equal(M.joinStatus('🔥', 'x'.repeat(100)).length, 73);
  assert.ok(M.joinStatus('🔥', 'x'.repeat(100)).length <= M.LIMITS.statusText);
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);
  assert.equal(Date.parse(M.statusUntil('30m', now)) - now, 30 * 60_000);
  assert.equal(Date.parse(M.statusUntil('1h', now)) - now, 60 * 60_000);
  assert.equal(Date.parse(M.statusUntil('4h', now)) - now, 4 * 60 * 60_000);
  assert.equal(M.statusUntil('never', now), null);
  const today = Date.parse(M.statusUntil('today', now));
  assert.ok(today > now && today - now <= 24 * 60 * 60_000);
  assert.equal(M.statusExpired(new Date(now - 1000).toISOString(), now), true);
  assert.equal(M.statusExpired(new Date(now + 1000).toISOString(), now), false);
  assert.equal(M.statusExpired(null, now), false);
  assert.equal(M.liveStatusText('hola', new Date(now - 1).toISOString(), now), '');
  assert.equal(M.liveStatusText('hola', null, now), 'hola');
  const n = M.normalizeProfile({ id: UID, status_text: 'vencido', status_until: new Date(now - 1).toISOString() });
  assert.equal(n.statusText, '');
});

// ---------- regalos ----------
test('regalos: las mismas reglas que gift_send', () => {
  assert.equal(M.validateGift({ kind: 'points', value: 50, balance: 100, sentToday: 0 }), null);
  assert.equal(M.validateGift({ kind: 'points', value: 5, balance: 100 }), 'bad_amount');
  assert.equal(M.validateGift({ kind: 'points', value: 501, balance: 1000 }), 'bad_amount');
  assert.equal(M.validateGift({ kind: 'points', value: 10.5, balance: 1000 }), 'bad_amount');
  assert.equal(M.validateGift({ kind: 'points', value: 500, balance: 1000, sentToday: 600 }), 'daily_limit');
  assert.equal(M.validateGift({ kind: 'points', value: 500, balance: 1000, sentToday: 500 }), null);
  assert.equal(M.validateGift({ kind: 'points', value: 200, balance: 150 }), 'not_enough_points');
  const item = { id: 'frame_cupid', price: 1800, premiumOnly: false, active: true };
  assert.equal(M.validateGift({ kind: 'item', value: 'frame_cupid', balance: 2000, item }), null);
  assert.equal(M.validateGift({ kind: 'item', value: 'frame_cupid', balance: 1000, item }), 'not_enough_points');
  assert.equal(M.validateGift({ kind: 'item', value: 'frame_cupid', balance: 2000, item, ownedByTarget: ['frame_cupid'] }), 'owned');
  assert.equal(M.validateGift({ kind: 'item', value: 'frame_venus', balance: 2000, item: { id: 'frame_venus', price: 0, premiumOnly: true } }), 'premium_item');
  assert.equal(M.validateGift({ kind: 'item', value: 'nope', balance: 2000, item: null }), 'bad_item');
  assert.equal(M.validateGift({ kind: 'cosa', value: 1 }), 'bad_kind');
  const now = Date.now();
  const hist = [
    { reason: 'gift_out', delta: -100, at: new Date(now - 3600_000).toISOString() },
    { reason: 'gift_out', delta: -50, at: new Date(now - 2 * 86_400_000).toISOString() },
    { reason: 'gift_in', delta: 30, at: new Date(now - 60_000).toISOString() },
    { reason: 'shop', delta: -500, at: new Date(now - 60_000).toISOString() },
  ];
  assert.equal(M.giftSentToday(hist, now), 100);
  assert.equal(M.giftSenderOf(`${OTHER}:20261103120000123`), OTHER);
  assert.equal(M.giftSenderOf('frame_cupid'), null);
});

// ---------- burbujas, KLIPY y audio ----------
test('burbujas: texto claro u oscuro segun el fondo', () => {
  assert.equal(M.bubbleColors('#ffffff').fg, '#1b130e');
  assert.equal(M.bubbleColors('#111111').fg, '#ffffff');
  assert.equal(M.bubbleColors('#7DF9FF').bg, '#7df9ff');
  assert.equal(M.bubbleColors('red'), null);
  for (const hex of ['#f29a2e', '#3b1450', '#9be36a', '#2a7fd4', '#808080', '#ff00ff']) {
    const c = M.bubbleColors(hex);
    assert.ok(M.contrastRatio(c.bg, c.fg) >= 4.5, `${hex} legible`);
  }
  assert.equal(M.bubbleColors('#3b1450').adjusted, false);
  assert.equal(M.bubbleColors('#2a7fd4').adjusted, true);
});

test('mensajes: solo las direcciones de KLIPY son un GIF', () => {
  assert.ok(M.isKlipyUrl('https://static.klipy.com/ii/abc/def.webp'));
  assert.ok(M.isKlipyUrl('https://static2.klipy.com/ii/abc/def.gif?x=1'));
  assert.ok(!M.isKlipyUrl('https://example.com/a.gif'));
  assert.ok(!M.isKlipyUrl('https://static.klipy.com.evil.invalid/a.gif'));
  assert.ok(!M.isKlipyUrl('http://static.klipy.com/a.gif'));
});

test('cancion: lo de la 3.1 (archivo propio en profile-audio) ya no existe en el modelo', () => {
  for (const name of ['isProfileAudioUrl', 'AUDIO_FILE', 'audioSourceError', 'audioUrlWithVersion', 'audioFileName']) assert.equal(M[name], undefined, name);
  assert.equal(M.LIMITS.songTitle, 80);
  assert.equal(M.LIMITS.songCreator, 60);
  assert.equal(M.LIMITS.songSeconds, 30);
  assert.equal(M.normalizeProfile({ id: UID, card_style: { song: { url: OLD_SONG } } }).cardStyle.song, null);
});

test('cosmeticos del pase y marcos nuevos en el catalogo', () => {
  for (const tt of ['season1', 'traveler', 'pro']) assert.ok(M.TITLES.includes(tt), tt);
  assert.equal(M.frameStyle('frame_spooky'), 'spooky');
  assert.equal(M.frameStyle('pass_frame_8'), 'pass8');
  assert.equal(M.titleStyle('title_season1'), 'season1');
  assert.ok(M.EFFECTS.includes('season1'));
  // El efecto del pase pide el item aunque la cuenta sea premium
  assert.equal(M.canUseEffect('season1', { premium: true }), false);
  assert.equal(M.canUseEffect('season1', { premium: false, owned: ['effect_season1'], items: [{ id: 'effect_season1', kind: 'name_effect', style: 'season1', premiumOnly: false }] }), true);
  assert.equal(M.validateField('equipped', { frame: 'frame_cupid' }, { owned: ['frame_cupid'] }), null);
  assert.equal(M.validateField('equipped', { frame: 'frame_cupid' }, { owned: [] }), 'not_owned:frame_cupid');
});
