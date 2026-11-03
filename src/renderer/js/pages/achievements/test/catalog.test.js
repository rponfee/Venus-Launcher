// Catalogo de logros y misiones: ids estables, medidas conocidas, textos en es/en y migracion al dia.
// node --test "src/renderer/js/pages/achievements/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACHIEVEMENTS, ACHIEVEMENT_BY_ID, CLIENT_IDS, GROUPS, TIERS, MISSIONS, MISSION_BONUS, families, familyState, clientMet, metricsFrom, rarityOf, roman, dailyKey, weeklyKey } from '../catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..', '..', '..', '..');
const SERVER_METRICS = ['friends', 'referrals', 'messages', 'shares', 'themes', 'memberDays', 'pointsEarned', 'missions', 'dailies', 'items', 'achievements', 'profile', 'verified', 'badge', 'premium'];

async function dict(lang) {
  return (await import(new URL(`file:///${path.join(root, 'src/renderer/i18n', lang, 'achievements.js').replace(/\\/g, '/')}`).href)).default;
}

test('ids unicos y con el formato que acepta la base', () => {
  assert.equal(ACHIEVEMENT_BY_ID.size, ACHIEVEMENTS.length);
  for (const a of ACHIEVEMENTS) {
    assert.match(a.id, /^[a-z0-9_]{2,40}$/, a.id);
    assert.ok(TIERS.includes(a.tier), a.id);
    assert.ok(GROUPS.includes(a.group), a.id);
    assert.ok(a.points > 0 && a.points <= 10000, a.id);
  }
  assert.ok(ACHIEVEMENTS.length >= 300);
});

test('no se perdieron los logros de la 2.x (sus ids no cambian)', () => {
  for (const id of ['first_launch', 'playtime_10h', 'playtime_100h', 'instances_5', 'first_screenshot', 'first_clip', 'first_party', 'skin_created', 'profile_complete', 'first_friend', 'five_friends', 'mc_verified', 'badge_on', 'first_share', 'first_referral', 'five_referrals', 'theme_published', 'premium']) {
    assert.ok(ACHIEVEMENT_BY_ID.has(id), id);
  }
  assert.equal(ACHIEVEMENT_BY_ID.get('five_referrals').points, 1000);
  assert.equal(ACHIEVEMENT_BY_ID.get('playtime_100h').points, 400);
});

test('los del servidor usan medidas que el servidor conoce', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/0023_venus3.sql'), 'utf8');
  for (const a of ACHIEVEMENTS.filter((x) => x.kind === 'server')) {
    assert.ok(SERVER_METRICS.includes(a.metric), a.id);
    assert.ok(sql.includes(`when '${a.metric}'`), a.metric);
  }
});

test('la migracion del catalogo esta al dia', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/0024_logros_catalogo.sql'), 'utf8');
  for (const a of ACHIEVEMENTS) assert.ok(sql.includes(`('${a.id}', ${a.points}, '${a.kind}', ${a.sort}, `), `${a.id}: correr scripts/gen-achievements-sql.js`);
  for (const m of MISSIONS) assert.ok(sql.includes(`('${m.id}', '${m.period}', '${m.metric}', ${m.target}, ${m.points})`), m.id);
});

test('cada familia y mision tiene texto en espanol e ingles', async () => {
  for (const lang of ['es', 'en']) {
    const d = await dict(lang);
    for (const f of families()) {
      assert.ok(d[`fam_${f.id}`], `${lang} fam_${f.id}`);
      assert.ok(d[`famDesc_${f.id}`], `${lang} famDesc_${f.id}`);
      // Un objetivo de 1 necesita su singular ("Jugá 1 horas" no)
      if (!f.single && f.steps.some((s) => s.target === 1)) assert.ok(d[`famDesc_${f.id}_one`], `${lang} famDesc_${f.id}_one`);
    }
    for (const m of MISSIONS) {
      assert.ok(d[`mis_${m.metric}`], `${lang} mis_${m.metric}`);
      if (m.target === 1) assert.ok(d[`mis_${m.metric}_one`], `${lang} mis_${m.metric}_one`);
    }
    for (const g of GROUPS) assert.ok(d[`group_${g}`], `${lang} group_${g}`);
    for (const x of TIERS) assert.ok(d[`tier_${x}`], `${lang} tier_${x}`);
  }
});

test('niveles de una escalera en orden', () => {
  const blocks = families().find((f) => f.id === 'blocks');
  assert.equal(blocks.steps[0].tier, 'bronze');
  assert.equal(blocks.steps.at(-1).tier, 'netherite');
  const order = blocks.steps.map((s) => TIERS.indexOf(s.tier));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(roman(3), 'III');
});

test('clientMet: solo los de la PC, cumplidos y sin desbloquear', () => {
  const met = clientMet({ hours: 12, friends: 99 }, new Set(['playtime_1']));
  assert.ok(met.includes('playtime_5'));
  assert.ok(met.includes('playtime_10h'));
  assert.ok(!met.includes('playtime_1'));
  assert.ok(!met.includes('playtime_25'));
  assert.ok(!met.includes('friends_10'), 'los del servidor no se reclaman desde la PC');
  assert.ok(CLIENT_IDS.includes('first_party'));
  assert.deepEqual(clientMet({}, new Set()), []);
});

test('familyState: paso actual, proximo y progreso', () => {
  const fam = families().find((f) => f.id === 'diamond');
  const s = familyState(fam, { unlocked: new Map([['diamond_1', 'x'], ['diamond_10', 'x']]), metrics: { minedDiamond: 25 } });
  assert.equal(s.current.id, 'diamond_10');
  assert.equal(s.next.id, 'diamond_50');
  assert.equal(s.progress, 0.5);
  assert.equal(s.done, false);
  const none = familyState(fam, {});
  assert.equal(none.current, null);
  assert.equal(none.value, null);
  assert.equal(none.progress, 0);
});

test('metricsFrom arma las medidas y tolera datos que faltan', () => {
  assert.deepEqual(metricsFrom({}), {});
  const m = metricsFrom({
    report: { totals: { ms: 7200000, sessions: 3, versionsPlayed: 2, loadersPlayed: 1 }, streak: { longest: { days: 5 } }, records: { longestSession: { ms: 3600000 } }, milestones: [{ id: 'worlds5', value: 4 }, { id: 'servers1', value: 2 }, { id: 'nightOwl', achievedAt: 1 }] },
    ingame: { totals: { blocksMined: 10, distanceCm: 250000, distance: [{ id: 'walk_one_cm', cm: 100000 }], extras: [{ id: 'fish_caught', value: 7 }], picks: { minedDiamond: 3 } }, advancements: { done: 9 } },
    local: { mods: 40, screenshots: 2, clips: 1 },
    instances: 6,
  });
  assert.equal(m.hours, 2);
  assert.equal(m.bestStreak, 5);
  assert.equal(m.longestHours, 1);
  assert.equal(m.worlds, 4);
  assert.equal(m.flagNightOwl, 1);
  assert.equal(m.distanceKm, 2.5);
  assert.equal(m.walkKm, 1);
  assert.equal(m.fished, 7);
  assert.equal(m.minedDiamond, 3);
  assert.equal(m.advancements, 9);
  assert.equal(m.mods, 40);
  assert.equal(m.instances, 6);
});

test('rareza solo con datos reales y suficientes jugadores', () => {
  assert.equal(rarityOf(NaN, 1000), null);
  assert.equal(rarityOf(0.5, 5), null);
  assert.equal(rarityOf(0.5, 1000), 'legendary');
  assert.equal(rarityOf(4, 1000), 'epic');
  assert.equal(rarityOf(15, 1000), 'rare');
  assert.equal(rarityOf(40, 1000), 'uncommon');
  assert.equal(rarityOf(90, 1000), 'common');
});

test('misiones: ids validos, pool suficiente y claves de periodo iguales al servidor', () => {
  for (const period of ['daily', 'weekly']) {
    const metrics = new Set(MISSIONS.filter((m) => m.period === period).map((m) => m.metric));
    assert.ok(metrics.size >= 3, 'el servidor elige 3 con medidas distintas');
    assert.ok(MISSION_BONUS[period] > 0);
  }
  assert.equal(dailyKey(Date.UTC(2026, 10, 3, 2)), '2026-11-03');
  // ISO 8601, igual que to_char(..., 'IYYY-"W"IW')
  assert.equal(weeklyKey(Date.UTC(2026, 10, 3)), '2026-W45');
  assert.equal(weeklyKey(Date.UTC(2021, 0, 3)), '2020-W53');
  assert.equal(weeklyKey(Date.UTC(2024, 11, 30)), '2025-W01');
  assert.equal(weeklyKey(Date.UTC(2023, 0, 1)), '2022-W52');
  assert.equal(weeklyKey(Date.UTC(2023, 0, 2)), '2023-W01');
});
