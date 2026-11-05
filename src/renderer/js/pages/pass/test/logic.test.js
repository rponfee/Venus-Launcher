import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMe, seasonState, daysLeft, levelInfo, rewardState, levelTiles, claimableList, levelRanges, rangeIndexOf, rangeStats,
  itemRewards, itemKind, xpToLevel, minutesForXp, nextItem, playSummary, playtimeBatches, levelsGained, RANGE_SIZE,
} from '../logic.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const season = { id: 'venus-pass', name: 'Venus Pass', startsAt: '2026-01-01T00:00:00Z', endsAt: '2099-12-31T23:59:59Z', levels: 380, xpPerLevel: 60, started: true, ended: false, permanent: true };
// Nivel 3 con 40 de XP: 220 minutos jugados
const rewards = [
  { level: 1, kind: 'points', amount: 10, claimed: true },
  { level: 2, kind: 'points', amount: 10, claimed: false },
  { level: 3, kind: 'points', amount: 10, claimed: false },
  { level: 25, kind: 'item', itemId: 'pass_frame_1', claimed: false },
  { level: 35, kind: 'item', itemId: 'title_explorer', claimed: false },
  { level: 380, kind: 'item', itemId: 'pass_frame_8', claimed: false },
];
const raw = { season, level: 3, levelXp: 40, xp: { xp: 220, fromPlay: 220, fromBonus: 0, premiumMult: 1, total: 220 }, playToday: 90, playCap: 120, claimable: 2, rewards };

test('normalizeMe valida y descarta lo raro', () => {
  const me = normalizeMe(raw);
  assert.equal(me.level, 3);
  assert.equal(me.rewards.length, 6);
  assert.equal(me.season.permanent, true);
  assert.equal(normalizeMe({ season: null }), null);
  assert.equal(normalizeMe(null), null);
  const dirty = normalizeMe({ ...raw, level: 9999, rewards: [...rewards, { level: 0, kind: 'points', amount: 5 }, { level: 381, kind: 'points', amount: 5 }, { level: 2, kind: 'raro', amount: 5 }, { level: 3, kind: 'points', amount: 99, claimed: true }] });
  assert.equal(dirty.level, 380);
  assert.equal(dirty.rewards.length, 6, 'sin niveles fuera de rango ni tipos raros');
  assert.equal(dirty.rewards.find((r) => r.level === 3).amount, 99, 'si un nivel viene dos veces, gana el último');
  const old = normalizeMe({ season: { id: 'x', name: 'x' }, level: 1 });
  assert.equal(old.season.levels, 380);
  assert.equal(old.season.xpPerLevel, 60);
  assert.equal(old.season.permanent, false);
});

test('estado de la temporada: la permanente no vence; las demás sí', () => {
  assert.equal(seasonState(season, NOW), 'active');
  assert.equal(seasonState(season, Date.parse('2150-01-01T00:00:00Z')), 'active');
  assert.equal(seasonState({ ...season, started: false }, NOW), 'upcoming');
  assert.equal(seasonState({ ...season, permanent: false, endsAt: '2027-01-05T00:00:00Z' }, NOW), 'active');
  assert.equal(seasonState({ ...season, permanent: false, endsAt: '2027-01-05T00:00:00Z' }, Date.parse('2027-02-01T00:00:00Z')), 'ended');
  assert.equal(seasonState({ ...season, startsAt: '2026-12-01T00:00:00Z' }, NOW), 'upcoming');
  assert.equal(seasonState(null, NOW), 'none');
  assert.equal(daysLeft('2027-01-05T00:00:00Z', NOW), 46);
  assert.equal(daysLeft('2027-01-05T00:00:00Z', Date.parse('2027-01-06T00:00:00Z')), 0);
  assert.equal(daysLeft('no es fecha', NOW), 0);
});

test('nivel y progreso (nivel 0, medio y 380)', () => {
  const me = normalizeMe(raw);
  assert.deepEqual(levelInfo(me), { level: 3, levels: 380, xpPerLevel: 60, levelXp: 40, pct: 67, maxed: false, toNext: 20 });
  const zero = levelInfo(normalizeMe({ ...raw, level: 0, levelXp: 0, rewards: [] }));
  assert.equal(zero.pct, 0);
  assert.equal(zero.toNext, 60);
  const maxed = levelInfo(normalizeMe({ ...raw, level: 380, levelXp: 60 }));
  assert.equal(maxed.maxed, true);
  assert.equal(maxed.pct, 100);
  assert.equal(maxed.toNext, 0);
});

test('estado de cada premio: reclamado, para reclamar o bloqueado', () => {
  const me = normalizeMe(raw);
  assert.equal(rewardState(me.rewards[0], me.level), 'claimed');
  assert.equal(rewardState(me.rewards[1], me.level), 'claimable');
  assert.equal(rewardState(me.rewards[3], me.level), 'locked');
  assert.equal(claimableList(me).map((r) => r.level).join(), '2,3');
  const tiles = levelTiles(me);
  assert.equal(tiles.length, 380);
  assert.equal(tiles[2].current, true);
  assert.equal(tiles[3].reward, null, 'un nivel sin premio no rompe la lista');
  assert.equal(tiles[3].state, 'locked');
  assert.equal(tiles[379].state, 'locked');
  // Antes del nivel: bloqueado; con el nivel justo: se puede reclamar
  assert.equal(rewardState({ level: 25, claimed: false }, 24), 'locked');
  assert.equal(rewardState({ level: 25, claimed: false }, 25), 'claimable');
});

test('páginas de la lista: 380 niveles de a 50', () => {
  const ranges = levelRanges(380);
  assert.equal(RANGE_SIZE, 50);
  assert.equal(ranges.length, 8);
  assert.deepEqual(ranges[0], { index: 0, from: 1, to: 50 });
  assert.deepEqual(ranges[7], { index: 7, from: 351, to: 380 });
  assert.equal(rangeIndexOf(0, ranges), 0, 'el nivel 0 va con la primera');
  assert.equal(rangeIndexOf(50, ranges), 0);
  assert.equal(rangeIndexOf(51, ranges), 1);
  assert.equal(rangeIndexOf(380, ranges), 7);
  assert.equal(rangeIndexOf(999, ranges), 7);
  const me = normalizeMe(raw);
  assert.deepEqual(rangeStats(me, ranges[0]), { claimable: 2, claimed: 1, total: 5 });
  assert.deepEqual(rangeStats(me, ranges[7]), { claimable: 0, claimed: 0, total: 1 });
  assert.equal(levelRanges(30).length, 1);
});

test('premios destacados, próximo cosmético y tiempos', () => {
  const me = normalizeMe(raw);
  assert.deepEqual(itemRewards(me).map((r) => `${r.level}:${r.state}`), ['25:locked', '35:locked', '380:locked']);
  assert.equal(itemKind('pass_frame_3'), 'frame');
  assert.equal(itemKind('title_explorer'), 'title');
  assert.equal(itemKind('pass_s1_free_title'), 'title');
  assert.equal(itemKind('effect_gold'), 'name_effect');
  assert.equal(itemKind('pass_s1_effect'), 'name_effect');
  assert.equal(itemKind('badge_nebula'), 'badge_style');
  assert.equal(itemKind('algo'), 'item');
  // Al nivel 25 hacen falta 25 * 60 - 220 = 1280 XP
  assert.equal(xpToLevel(me, 25), 1280);
  assert.equal(xpToLevel(me, 2), 0);
  assert.equal(minutesForXp(me, 1280), 1280);
  const premium = normalizeMe({ ...raw, xp: { ...raw.xp, premiumMult: 1.2 } });
  assert.equal(minutesForXp(premium, 1200), 1000, 'con Premium cada minuto rinde 1,2 XP');
  const next = nextItem(me);
  assert.equal(next.reward.level, 25);
  assert.equal(next.levelsLeft, 22);
  assert.equal(next.xpLeft, 1280);
  assert.equal(next.minutesLeft, 1280);
  assert.equal(nextItem(normalizeMe({ ...raw, level: 380, levelXp: 60 })), null);
});

test('minutos jugados: resumen y lotes de 30 sin pasar del tope del día', () => {
  const me = normalizeMe(raw);
  assert.deepEqual(playSummary(me), { hours: 3, minutes: 40, today: 90, cap: 120, left: 30, capped: false });
  assert.equal(playSummary(normalizeMe({ ...raw, playToday: 120 })).capped, true);
  assert.deepEqual(playtimeBatches(75), [30, 30, 15]);
  assert.deepEqual(playtimeBatches(75, 100), [20]);
  assert.deepEqual(playtimeBatches(10, 120), []);
  assert.deepEqual(playtimeBatches(-5), []);
});

test('niveles ganados entre dos lecturas', () => {
  const a = normalizeMe(raw);
  const b = normalizeMe({ ...raw, level: 5 });
  assert.equal(levelsGained(a, b), 2);
  assert.equal(levelsGained(b, a), 0);
  assert.equal(levelsGained(null, b), 0);
  assert.equal(levelsGained(a, normalizeMe({ ...raw, level: 9, season: { ...season, id: 'otra' } })), 0);
});
