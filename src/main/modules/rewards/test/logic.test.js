'use strict';
// Lógica pura de Venus Points (src/renderer/js/pages/rewards/logic.js): formato de puntos, racha del premio diario,
// logros que corresponden según las estadísticas, mapa de errores de las RPC, códigos de invitación y tienda.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// logic.js es un módulo ES sin imports: se carga desde data: (así Node no avisa por el tipo del paquete)
const FILE = path.join(__dirname, '../../../../renderer/js/pages/rewards/logic.js');
const load = () => import(`data:text/javascript;base64,${fs.readFileSync(FILE).toString('base64')}`);

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 10, 1, 15, 30); // 1 de noviembre de 2026, 15:30 UTC
const daily = (ms) => ({ delta: 10, reason: 'daily', ref: new Date(ms).toISOString().slice(0, 10), at: new Date(ms).toISOString() });

test('formato de puntos y movimientos', async () => {
  const L = await load();
  assert.equal(L.formatPoints(1250, 'es-AR'), '1.250');
  assert.equal(L.formatPoints(1250, 'en-US'), '1,250');
  assert.equal(L.formatPoints(0, 'es-AR'), '0');
  assert.equal(L.formatPoints('abc', 'es-AR'), '0');
  assert.equal(L.formatPoints(12.9, 'es-AR'), '12');
  assert.equal(L.formatPoints(undefined), '0');
  assert.equal(L.formatPoints(500, 'xx-invalido-!!'), '500');
  assert.equal(L.formatDelta(25, 'es-AR'), '+25');
  assert.equal(L.formatDelta(-1500, 'es-AR'), '−1.500');
  assert.equal(L.formatDelta(0, 'en-US'), '+0');
});

test('puntos del premio diario: 10 + 5 por día seguido (hasta +25), premium x2', async () => {
  const L = await load();
  assert.equal(L.dailyPoints(0), 10);
  assert.equal(L.dailyPoints(1), 15);
  assert.equal(L.dailyPoints(4), 30);
  assert.equal(L.dailyPoints(5), 35);
  assert.equal(L.dailyPoints(30), 35);
  assert.equal(L.dailyPoints(2, 2), 40);
  assert.equal(L.dailyPoints(-3, 7), 10, 'valores raros: sin racha y sin multiplicador');
});

test('racha a partir del historial', async () => {
  const L = await load();
  assert.deepEqual(L.dailyStreak([], NOW), { current: 0, claimedToday: false, capped: false });
  // Ayer y anteayer (hoy sin reclamar)
  let s = L.dailyStreak([daily(NOW - DAY), daily(NOW - 2 * DAY)], NOW);
  assert.equal(s.current, 2);
  assert.equal(s.claimedToday, false);
  // Hoy, ayer y un hueco antes
  s = L.dailyStreak([daily(NOW), daily(NOW - DAY), daily(NOW - 3 * DAY)], NOW);
  assert.equal(s.current, 2);
  assert.equal(s.claimedToday, true);
  // Un hueco ayer corta la racha
  s = L.dailyStreak([daily(NOW - 2 * DAY), daily(NOW - 3 * DAY)], NOW);
  assert.equal(s.current, 0);
  // Otros movimientos no cuentan
  s = L.dailyStreak([{ reason: 'achievement', ref: new Date(NOW - DAY).toISOString().slice(0, 10) }, null, { reason: 'daily' }], NOW);
  assert.equal(s.current, 0);
  // El día es UTC: a las 23:59 UTC sigue siendo hoy
  const late = Date.UTC(2026, 10, 1, 23, 59);
  assert.equal(L.dailyStreak([daily(Date.UTC(2026, 10, 1, 0, 5))], late).claimedToday, true);
});

test('estado del premio diario para la interfaz', async () => {
  const L = await load();
  // Racha de 2 hasta ayer: hoy da 20 y se puede reclamar
  let info = L.dailyInfo({ history: [daily(NOW - DAY), daily(NOW - 2 * DAY)], dailyClaimed: false, multiplier: 1 }, NOW);
  assert.equal(info.claimable, true);
  assert.equal(info.streak, 2);
  assert.equal(info.points, 20);
  assert.equal(info.nextAt, null);
  // Ya reclamado hoy: vuelve a la medianoche UTC y mañana da 25 (x2 = 50)
  info = L.dailyInfo({ history: [daily(NOW), daily(NOW - DAY), daily(NOW - 2 * DAY)], dailyClaimed: true, multiplier: 2 }, NOW);
  assert.equal(info.claimable, false);
  assert.equal(info.streak, 3);
  assert.equal(info.points, 50);
  assert.equal(info.nextAt, Date.UTC(2026, 10, 2));
  // El servidor dice que ya se reclamó pero el historial todavía no lo trae: hoy cuenta igual
  info = L.dailyInfo({ history: [daily(NOW - DAY)], dailyClaimed: true }, NOW);
  assert.equal(info.streak, 2);
  assert.equal(info.claimable, false);
  // Racha larga: el bono queda al máximo
  const long = Array.from({ length: 8 }, (_, i) => daily(NOW - (i + 1) * DAY));
  info = L.dailyInfo({ history: long, dailyClaimed: false }, NOW);
  assert.equal(info.points, 35);
  assert.equal(info.maxed, true);
  assert.equal(L.nextUtcMidnight(Date.UTC(2026, 11, 31, 23, 0)), Date.UTC(2027, 0, 1));
});

test('logros de la PC según las estadísticas del launcher', async () => {
  const L = await load();
  const H = 3600 * 1000;
  assert.deepEqual(L.pcAchievementsFor({}), []);
  assert.deepEqual(L.pcAchievementsFor({ sessions: 1 }), ['first_launch']);
  assert.deepEqual(L.pcAchievementsFor({ totalMs: 9.99 * H, sessions: 3 }), ['first_launch']);
  assert.deepEqual(L.pcAchievementsFor({ totalMs: 10 * H, sessions: 3 }), ['first_launch', 'playtime_10h']);
  assert.deepEqual(L.pcAchievementsFor({ totalMs: 120 * H, sessions: 40, instances: 5 }), ['first_launch', 'playtime_10h', 'playtime_100h', 'instances_5']);
  assert.deepEqual(L.pcAchievementsFor({ instances: 4 }), []);
  assert.deepEqual(L.pcAchievementsFor({ instances: 7 }), ['instances_5']);
  // Todos los que devuelve son de la PC
  assert.ok(L.pcAchievementsFor({ totalMs: 1e12, sessions: 1, instances: 99 }).every((id) => L.PC_ACHIEVEMENTS.includes(id)));
});

test('progreso de los logros medibles', async () => {
  const L = await load();
  const H = 3600 * 1000;
  assert.deepEqual(L.achievementProgress('playtime_10h', { totalMs: 4.5 * H }), { value: 4, target: 10, unit: 'hours' });
  assert.deepEqual(L.achievementProgress('playtime_100h', { totalMs: 250 * H }), { value: 100, target: 100, unit: 'hours' });
  assert.deepEqual(L.achievementProgress('instances_5', { instances: 3 }), { value: 3, target: 5, unit: 'count' });
  assert.deepEqual(L.achievementProgress('five_friends', { friends: 2 }), { value: 2, target: 5, unit: 'count' });
  assert.equal(L.achievementProgress('first_launch', {}), null);
});

test('pistas para los logros del servidor', async () => {
  const L = await load();
  assert.deepEqual(L.serverHints({}), []);
  assert.deepEqual(L.serverHints({ premium: true, mcVerified: true, badgeEnrolled: true }), ['premium', 'mc_verified', 'badge_on']);
  assert.deepEqual(L.serverHints({ friends: 5, referralsRewarded: 1 }), ['first_friend', 'five_friends', 'first_referral']);
  assert.ok(L.serverHints({ premium: true, mcVerified: true, badgeEnrolled: true, friends: 9, referralsRewarded: 9 }).every((id) => L.SERVER_ACHIEVEMENTS.includes(id)));
  const { unlocked, locked } = L.splitAchievements([{ id: 'a', unlockedAt: '2026-01-01' }, { id: 'b', unlockedAt: null }, null, { id: 3 }]);
  assert.deepEqual(unlocked.map((a) => a.id), ['a']);
  assert.deepEqual(locked.map((a) => a.id), ['b']);
});

test('cada logro tiene ícono y los ids cumplen el formato del servidor', async () => {
  const L = await load();
  for (const id of [...L.PC_ACHIEVEMENTS, ...L.SERVER_ACHIEVEMENTS]) {
    assert.ok(L.ACHIEVEMENT_ICONS[id], id);
    assert.ok(L.ACHIEVEMENT_ID.test(id), id);
  }
  assert.equal(L.ACHIEVEMENT_ID.test('Bad-Id'), false);
});

test('mapa de errores de las RPC', async () => {
  const L = await load();
  const pg = (message, code = '22023') => ({ message, code, details: null, hint: null });
  for (const code of ['bad_code', 'own_code', 'already_referred', 'too_late', 'loop', 'bad_achievement', 'not_met', 'too_many_today', 'bad_item', 'premium_item', 'owned', 'not_enough_points']) {
    assert.equal(L.classifyError(pg(code)), code);
  }
  assert.equal(L.classifyError(pg('premium_required:nameStyle')), 'premium_required');
  assert.equal(L.classifyError(pg('not_owned:frame_gold')), 'not_owned');
  assert.equal(L.errorDetail(pg('not_owned:frame_gold')), 'frame_gold');
  assert.equal(L.errorDetail(pg('owned')), null);
  assert.equal(L.classifyError(pg('bad_field:color')), 'bad_request');
  assert.equal(L.classifyError(pg('not_authenticated', '42501')), 'noSession');
  assert.equal(L.classifyError(pg('user_banned', '42501')), 'banned');
  assert.equal(L.classifyError(pg('user_muted', '42501')), 'muted');
  assert.equal(L.classifyError(pg('Could not find the function public.points_me without parameters', 'PGRST202')), 'unavailable');
  assert.equal(L.classifyError(pg('relation "public.shop_items" does not exist', '42P01')), 'unavailable');
  assert.equal(L.classifyError({ message: 'Not found', status: 404 }), 'unavailable');
  assert.equal(L.classifyError(pg('JWT expired', 'PGRST301')), 'noSession');
  assert.equal(L.classifyError({ message: 'TypeError: Failed to fetch', code: '' }), 'network');
  assert.equal(L.classifyError(new TypeError('fetch failed')), 'network');
  assert.equal(L.classifyError(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'network');
  assert.equal(L.classifyError(pg('duplicate key value violates unique constraint', '23505')), 'server');
  assert.equal(L.classifyError(null), 'server');
  // Un error ya clasificado se respeta
  assert.equal(L.classifyError({ code: 'not_met', message: 'algo' }), 'not_met');
  assert.equal(L.classifyError({ code: 'network' }), 'network');
});

test('cada código de error tiene su texto en es y en', async () => {
  const L = await load();
  const loadNs = (lang) => import(`data:text/javascript;base64,${fs.readFileSync(path.join(__dirname, `../../../../renderer/i18n/${lang}/rewards.js`)).toString('base64')}`).then((m) => m.default);
  const [es, en] = await Promise.all([loadNs('es'), loadNs('en')]);
  for (const code of [...L.SERVER_CODES, ...L.CLIENT_CODES]) {
    assert.equal(typeof es[`err_${code}`], 'string', `es err_${code}`);
    assert.equal(typeof en[`err_${code}`], 'string', `en err_${code}`);
  }
  for (const id of [...L.PC_ACHIEVEMENTS, ...L.SERVER_ACHIEVEMENTS]) {
    assert.equal(typeof es[`ach_${id}`], 'string', `es ach_${id}`);
    assert.equal(typeof en[`achDesc_${id}`], 'string', `en achDesc_${id}`);
  }
});

test('códigos de invitación', async () => {
  const L = await load();
  assert.equal(L.normalizeReferralCode('VP-7K2QXM'), 'VP-7K2QXM');
  assert.equal(L.normalizeReferralCode(' vp-7k2qxm '), 'VP-7K2QXM');
  assert.equal(L.normalizeReferralCode('vp 7k2 qxm'), 'VP-7K2QXM');
  assert.equal(L.normalizeReferralCode('7K2QXM'), 'VP-7K2QXM');
  assert.equal(L.normalizeReferralCode('VPABCD'), 'VP-VPABCD', 'un código que empieza con VP sin el prefijo');
  assert.equal(L.normalizeReferralCode('VP–7K2QXM'), 'VP-7K2QXM', 'guion largo pegado de otro lado');
  assert.equal(L.normalizeReferralCode('VP-7K2QX0'), null, 'el 0 no está en el alfabeto');
  assert.equal(L.normalizeReferralCode('VP-7K2Q'), null);
  assert.equal(L.normalizeReferralCode(''), null);
  assert.equal(L.normalizeReferralCode(null), null);
  assert.equal(L.normalizeReferralCode('VENUS-ABC123'), null, 'un código de amigo no es de invitación');
});

const SHOP = [
  { id: 'title_explorer', kind: 'title', price: 300, premium_only: false, sort: 110 },
  { id: 'frame_neon', kind: 'frame', price: 800, premium_only: false, sort: 20 },
  { id: 'frame_venus', kind: 'frame', price: 0, premium_only: true, sort: 40 },
  { id: 'frame_gold', kind: 'frame', price: 1500, premium_only: false, sort: 30 },
  { id: 'badge_gold', kind: 'badge_style', price: 0, premium_only: true, sort: 100 },
  { id: 'effect_fire', kind: 'name_effect', price: 2500, premium_only: false, sort: 70 },
  { id: 'banner_x', kind: 'banner', price: 10, premium_only: false, sort: 1 },
];

test('vista de la tienda: grupos, orden y estado de cada ítem', async () => {
  const L = await load();
  const groups = L.shopView(SHOP, { owned: ['frame_neon', 'title_explorer'], premium: false, balance: 1000, equipped: { frame: 'frame_neon' } });
  assert.deepEqual(groups.map((g) => g.kind), ['frame', 'name_effect', 'badge_style', 'title'], 'sin los banners (no se equipan)');
  const frames = groups[0].items;
  assert.deepEqual(frames.map((v) => v.item.id), ['frame_neon', 'frame_gold', 'frame_venus']);
  assert.deepEqual(frames.map((v) => v.state), ['equipped', 'short', 'premium']);
  assert.equal(frames[1].missing, 500);
  assert.equal(groups[3].items[0].state, 'owned');
  assert.equal(groups[1].items[0].state, 'short');
  // Con premium, lo premium viene incluido
  const prem = L.shopView(SHOP, { owned: [], premium: true, balance: 5000, equipped: { badgeStyle: 'badge_gold' } });
  assert.equal(prem.find((g) => g.kind === 'badge_style').items[0].state, 'equipped');
  assert.equal(prem[0].items.find((v) => v.item.id === 'frame_venus').state, 'owned');
  assert.equal(prem[0].items.find((v) => v.item.id === 'frame_gold').state, 'buy');
  assert.deepEqual(L.shopView(null), []);
});

test('equipar: manda todos los casilleros y descarta lo que ya no corresponde', async () => {
  const L = await load();
  const opts = { items: SHOP, owned: ['frame_neon', 'title_explorer'], premium: false };
  assert.deepEqual(L.equipPatch({}, 'frame', 'frame_neon', opts), { frame: 'frame_neon', nameEffect: null, badgeStyle: null, title: null });
  // Desequipar un casillero conserva los otros
  assert.deepEqual(L.equipPatch({ frame: 'frame_neon', title: 'title_explorer' }, 'frame', null, opts), { frame: null, nameEffect: null, badgeStyle: null, title: 'title_explorer' });
  // Lo premium equipado sin premium se descarta (el servidor lo rechazaría con not_owned)
  assert.deepEqual(L.equipPatch({ frame: 'frame_venus', badgeStyle: 'badge_gold' }, 'title', 'title_explorer', opts), { frame: null, nameEffect: null, badgeStyle: null, title: 'title_explorer' });
  // No se puede equipar algo que no se tiene, ni en el casillero equivocado
  assert.equal(L.equipPatch({}, 'frame', 'frame_gold', opts).frame, null);
  assert.equal(L.equipPatch({}, 'title', 'frame_neon', opts).title, null);
  // Con premium, lo premium sí
  assert.equal(L.equipPatch({}, 'frame', 'frame_venus', { ...opts, premium: true }).frame, 'frame_venus');
});

test('historial e ids sin traducción', async () => {
  const L = await load();
  assert.deepEqual(L.historyEntry({ delta: '25', reason: 'daily', ref: '2026-11-01', at: '2026-11-01T12:00:00Z' }), { reason: 'daily', icon: 'calendar', ref: '2026-11-01', delta: 25, at: Date.parse('2026-11-01T12:00:00Z') });
  const odd = L.historyEntry({ delta: -800, reason: 'raro', ref: null, at: 'no-es-fecha' });
  assert.equal(odd.reason, 'admin');
  assert.equal(odd.at, null);
  assert.equal(odd.ref, '');
  assert.equal(L.historyEntry({ reason: 'shop', delta: -300 }).icon, 'tag');
  assert.equal(L.humanizeId('title_explorer'), 'Title explorer');
  assert.equal(L.humanizeId(''), '');
});
