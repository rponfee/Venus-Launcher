// Catalogo de logros y misiones: ids estables, medidas que son solo de Venus, textos en es/en y migraciones al dia.
// node --test "src/renderer/js/pages/achievements/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACHIEVEMENTS, ACHIEVEMENT_BY_ID, CLIENT_IDS, GROUPS, TIERS, MISSIONS, MISSION_BONUS, families, familyState, clientMet, metricsFrom, rarityOf, roman, dailyKey, weeklyKey } from '../catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..', '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const SERVER_METRICS = ['friends', 'referrals', 'messages', 'shares', 'themes', 'reviews', 'memberDays', 'pointsEarned', 'pointsSpent', 'missions', 'dailies', 'items', 'achievements', 'profile', 'verified', 'badge', 'premium'];
// Lo unico que puede medir un logro de esta PC: sesiones, archivos y galeria del launcher (nada de los mundos ni de Minecraft)
const CLIENT_METRICS = ['hours', 'sessions', 'bestStreak', 'longestHours', 'daysPlayed', 'instancesPlayed', 'versions', 'loaders', 'instances', 'mods', 'shaders', 'resourcepacks', 'localServers', 'screenshots', 'clips', 'flagNightOwl', 'flagEarlyBird', 'flagWeekend', 'flagCrashSurvivor', 'flagAnniversary'];

async function dict(lang) {
  return (await import(new URL(`file:///${path.join(root, 'src/renderer/i18n', lang, 'achievements.js').replace(/\\/g, '/')}`).href)).default;
}

// Filas del insert de public.achievements que genera scripts/gen-achievements-sql.js
const ROW = /^\s*\('([a-z0-9_]+)', (\d+), '(client|server)', (\d+), '([a-z0-9_]+)', '([a-z]+)', (null|'[A-Za-z]+'), (\d+)\)/;
function rows(sql) {
  const out = new Map();
  for (const line of sql.split(/\r?\n/)) {
    const m = ROW.exec(line);
    if (m) out.set(m[1], { points: Number(m[2]), kind: m[3], sort: Number(m[4]), family: m[5], tier: m[6], metric: m[7] === 'null' ? null : m[7].slice(1, -1), target: Number(m[8]) });
  }
  return out;
}
// ids que 0043 desactiva
function retiredIn(sql) {
  const m = /set active = false\s+where active and id in \(([^)]*)\)/.exec(sql);
  assert.ok(m, '0043 tiene que desactivar logros');
  return [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
}

test('ids unicos y con el formato que acepta la base', () => {
  assert.equal(ACHIEVEMENT_BY_ID.size, ACHIEVEMENTS.length);
  for (const a of ACHIEVEMENTS) {
    assert.match(a.id, /^[a-z0-9_]{2,40}$/, a.id);
    assert.ok(TIERS.includes(a.tier), a.id);
    assert.ok(GROUPS.includes(a.group), a.id);
    assert.ok(a.points > 0 && a.points <= 10000, a.id);
  }
  assert.ok(ACHIEVEMENTS.length >= 150, 'el catalogo no tiene que quedar flaco');
});

test('no se perdieron los logros de la 2.x (sus ids no cambian)', () => {
  for (const id of ['first_launch', 'playtime_10h', 'playtime_100h', 'instances_5', 'first_screenshot', 'first_clip', 'first_party', 'skin_created', 'profile_complete', 'first_friend', 'five_friends', 'mc_verified', 'badge_on', 'first_share', 'first_referral', 'five_referrals', 'theme_published', 'premium']) {
    assert.ok(ACHIEVEMENT_BY_ID.has(id), id);
  }
  assert.equal(ACHIEVEMENT_BY_ID.get('five_referrals').points, 1000);
  assert.equal(ACHIEVEMENT_BY_ID.get('playtime_100h').points, 400);
});

test('los logros son solo de Venus: ninguna medida sale de los mundos ni de los logros de Minecraft', () => {
  assert.deepEqual(GROUPS, ['time', 'collection', 'capture', 'social', 'venus', 'special']);
  for (const a of ACHIEVEMENTS) {
    if (a.metric === null) continue;
    const allowed = a.kind === 'server' ? SERVER_METRICS : CLIENT_METRICS;
    assert.ok(allowed.includes(a.metric), `${a.id}: la medida ${a.metric} no es del launcher ni de la cuenta de Venus`);
  }
  // Lo que se retiro en la 4.6 no vuelve por descuido
  for (const f of ['blocks', 'diamond', 'mobs', 'deaths', 'distance', 'jumps', 'advancements', 'worlds', 'servers', 'gametime', 'breeder', 'dragon']) {
    assert.ok(!families().some((x) => x.id === f), `familia ${f}`);
  }
});

test('los del servidor usan medidas que el servidor conoce', () => {
  const sql = read('supabase/migrations/0023_venus3.sql') + read('supabase/migrations/0043_logros_venus.sql');
  for (const a of ACHIEVEMENTS.filter((x) => x.kind === 'server')) {
    assert.ok(SERVER_METRICS.includes(a.metric), a.id);
    assert.ok(sql.includes(`when '${a.metric}'`), a.metric);
  }
});

test('la migracion 0043 deja el catalogo al dia y retira los de dentro del juego', () => {
  const old = rows(read('supabase/migrations/0024_logros_catalogo.sql'));
  const now = rows(read('supabase/migrations/0043_logros_venus.sql'));
  const retired = retiredIn(read('supabase/migrations/0043_logros_venus.sql'));
  // Cada logro del catalogo esta en 0043 con sus mismos datos
  assert.equal(now.size, ACHIEVEMENTS.length);
  for (const a of ACHIEVEMENTS) {
    const r = now.get(a.id);
    assert.ok(r, `${a.id}: correr scripts/gen-achievements-sql.js con --since`);
    assert.deepEqual(r, { points: a.points, kind: a.kind, sort: a.sort, family: a.family, tier: a.tier, metric: a.metric, target: a.target }, a.id);
  }
  // Se desactiva todo lo que 0024 definio y el catalogo ya no tiene, y nada mas
  const expected = [...old.keys()].filter((id) => !ACHIEVEMENT_BY_ID.has(id));
  assert.deepEqual([...retired].sort(), [...expected].sort());
  assert.equal(new Set(retired).size, retired.length);
  for (const id of retired) assert.ok(!ACHIEVEMENT_BY_ID.has(id), id);
  // Los que siguen no cambian de puntos, tipo, familia, nivel, medida ni objetivo (no se tocan los premios futuros)
  for (const [id, r] of old) {
    if (!ACHIEVEMENT_BY_ID.has(id)) continue;
    const { sort, ...rest } = r;
    const { sort: _s, ...cur } = now.get(id);
    assert.deepEqual(cur, rest, `${id} cambio respecto de 0024`);
  }
  // 0043 no borra nada: ni logros ni desbloqueos ni puntos
  const sql = read('supabase/migrations/0043_logros_venus.sql');
  assert.ok(!/delete\s+from\s+public\.(achievements|user_achievements|points_ledger)/i.test(sql));
  assert.ok(!/drop\s+table/i.test(sql));
});

test('la migracion de las misiones sigue al dia (0024)', () => {
  const sql = read('supabase/migrations/0024_logros_catalogo.sql');
  for (const m of MISSIONS) assert.ok(sql.includes(`('${m.id}', '${m.period}', '${m.metric}', ${m.target}, ${m.points})`), m.id);
});

test('cada familia y mision tiene texto en espanol e ingles, y no sobran los de los logros retirados', async () => {
  const ids = new Set(families().map((f) => f.id));
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
    for (const key of Object.keys(d)) {
      const m = /^fam(?:Desc)?_(.+?)(?:_one)?$/.exec(key);
      if (m) assert.ok(ids.has(m[1]), `${lang} ${key}: de un logro que ya no existe`);
      assert.ok(!/^(tab_minecraft|group_(mining|combat|explore|life))$/.test(key), `${lang} ${key}`);
    }
    assert.ok(!/Minecraft/.test(d.subtitle), `${lang} subtitle`);
  }
});

test('la pagina de Logros ya no tiene la pestana de Minecraft', () => {
  assert.ok(!fs.existsSync(path.join(root, 'src/renderer/js/pages/achievements/minecraft.js')));
  const page = read('src/renderer/js/pages/achievements.js');
  assert.match(page, /const TABS = \[\s*\{ id: 'list', icon: 'trophy' \},\s*\];/);
  assert.ok(!/minecraft\.js|stats:ingame|openWorldStats|advancementsCard|'pages\/stats'/.test(page));
  // #/achievements/minecraft (y cualquier pestana que no exista) abre la lista y corrige la direccion
  assert.match(page, /TABS\.some\(\(x\) => x\.id === params\?\.\[0\]\) \? params\[0\] : 'list'/);
  assert.match(page, /history\.replaceState\(null, '', `#\/achievements\/\$\{st\.tab\}`\)/);
  assert.ok(!/stats:ingame/.test(read('src/renderer/js/features/achievements.js')));
  assert.ok(!/picks|PICKS/.test(read('src/main/modules/statsplus/ingame.js')), 'los conteos que solo servian a los logros');
});

test('niveles de una escalera en orden', () => {
  const mods = families().find((f) => f.id === 'mods');
  assert.equal(mods.steps[0].tier, 'bronze');
  assert.equal(mods.steps.at(-1).tier, 'netherite');
  const order = mods.steps.map((s) => TIERS.indexOf(s.tier));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(roman(3), 'III');
  // Cazalogros conserva el nivel y los puntos de siempre aunque sus ultimos pasos se retiraron
  const achiever = families().find((f) => f.id === 'achiever');
  assert.deepEqual(achiever.steps.map((s) => [s.id, s.tier, s.points]), [['achiever_10', 'bronze', 15], ['achiever_25', 'bronze', 15], ['achiever_50', 'silver', 30], ['achiever_100', 'gold', 60]]);
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
  const fam = families().find((f) => f.id === 'mods');
  const s = familyState(fam, { unlocked: new Map([['mods_1', 'x'], ['mods_10', 'x']]), metrics: { mods: 25 } });
  assert.equal(s.current.id, 'mods_10');
  assert.equal(s.next.id, 'mods_50');
  assert.equal(s.progress, 0.5);
  assert.equal(s.done, false);
  const none = familyState(fam, {});
  assert.equal(none.current, null);
  assert.equal(none.value, null);
  assert.equal(none.progress, 0);
});

test('metricsFrom arma las medidas del launcher y tolera datos que faltan', () => {
  assert.deepEqual(metricsFrom({}), {});
  const m = metricsFrom({
    report: { totals: { ms: 7200000, sessions: 3, versionsPlayed: 2, loadersPlayed: 1, daysPlayed: 4, instancesPlayed: 2 }, streak: { longest: { days: 5 } }, records: { longestSession: { ms: 3600000 } }, milestones: [{ id: 'worlds5', value: 4 }, { id: 'servers1', value: 2 }, { id: 'nightOwl', achievedAt: 1 }] },
    local: { mods: 40, screenshots: 2, clips: 1 },
    instances: 6,
    localServers: 2,
  });
  assert.equal(m.hours, 2);
  assert.equal(m.bestStreak, 5);
  assert.equal(m.longestHours, 1);
  assert.equal(m.daysPlayed, 4);
  assert.equal(m.instancesPlayed, 2);
  assert.equal(m.flagNightOwl, 1);
  assert.equal(m.mods, 40);
  assert.equal(m.instances, 6);
  assert.equal(m.localServers, 2);
  // Los mundos y servidores que detecta el launcher mirando el registro del juego ya no cuentan
  assert.equal(m.worlds, undefined);
  assert.equal(m.servers, undefined);
  // Las estadisticas de los mundos se ignoran aunque alguien las pase
  const ig = metricsFrom({ ingame: { totals: { blocksMined: 10, distanceCm: 250000, picks: { minedDiamond: 3 } }, advancements: { done: 9 } } });
  assert.deepEqual(ig, {});
  for (const k of Object.keys(m)) assert.ok(CLIENT_METRICS.includes(k), k);
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
