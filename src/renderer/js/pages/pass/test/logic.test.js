import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMe, seasonState, daysLeft, levelInfo, tileState, rewardsByLevel, claimableList, tierOffers, playtimeBatches, levelsGained, xpSources } from '../logic.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const season = { id: 'temporada-1', name: 'Amanecer en Venus', startsAt: '2026-11-10T00:00:00Z', endsAt: '2027-01-05T00:00:00Z', levels: 50, xpPerLevel: 150, started: true, ended: false };
const tiers = [
  { tier: 'go', priceUsd: 1.99, bonusLevels: 0, xpMult: 1, perkItems: [], owned: false, upgradePriceUsd: 1.99 },
  { tier: 'pro', priceUsd: 4.99, bonusLevels: 10, xpMult: 1, perkItems: ['pass_pro_title'], owned: false, upgradePriceUsd: 4.99 },
  { tier: 'max', priceUsd: 6.99, bonusLevels: 25, xpMult: 1.25, perkItems: ['pass_pro_title', 'pass_max_frame'], owned: false, upgradePriceUsd: 6.99 },
];
const rewards = [
  { level: 1, track: 'free', kind: 'points', amount: 20, claimed: true },
  { level: 1, track: 'premium', kind: 'item', itemId: 'pass_s1_frame', claimed: false },
  { level: 2, track: 'premium', kind: 'points', amount: 50, claimed: false },
  { level: 3, track: 'free', kind: 'points', amount: 20, claimed: false },
  { level: 40, track: 'free', kind: 'item', itemId: 'pass_s1_free_frame', claimed: false },
];
const raw = { season, purchase: null, level: 3, levelXp: 40, xp: { xp: 490, fromPoints: 400, fromPlay: 90, bonusLevels: 0, premiumMult: 1, tierMult: 1, total: 490 }, playToday: 90, playCap: 120, claimable: 2, rewards, tiers };

test('normalizeMe valida y descarta lo raro', () => {
  const me = normalizeMe(raw);
  assert.equal(me.level, 3);
  assert.equal(me.rewards.length, 5);
  assert.equal(me.tiers.map((t) => t.tier).join(), 'go,pro,max');
  assert.equal(normalizeMe({ season: null }), null);
  assert.equal(normalizeMe(null), null);
  const dirty = normalizeMe({ ...raw, level: 999, rewards: [...rewards, { level: 0, track: 'free', kind: 'points', amount: 5 }, { level: 2, track: 'vip', kind: 'points', amount: 5 }], tiers: [...tiers, { tier: 'ultra', priceUsd: 1 }] });
  assert.equal(dirty.level, 50);
  assert.equal(dirty.rewards.length, 5);
  assert.equal(dirty.tiers.length, 3);
});

test('estado de la temporada y días que faltan', () => {
  assert.equal(seasonState(season, NOW), 'active');
  assert.equal(seasonState(season, Date.parse('2026-11-01T00:00:00Z')), 'upcoming');
  assert.equal(seasonState(season, Date.parse('2027-02-01T00:00:00Z')), 'ended');
  assert.equal(seasonState(null, NOW), 'none');
  assert.equal(daysLeft(season.endsAt, NOW), 46);
  assert.equal(daysLeft(season.endsAt, Date.parse('2027-01-06T00:00:00Z')), 0);
  assert.equal(daysLeft('no es fecha', NOW), 0);
});

test('nivel y progreso', () => {
  const me = normalizeMe(raw);
  assert.deepEqual(levelInfo(me), { level: 3, levels: 50, xpPerLevel: 150, levelXp: 40, pct: 27, maxed: false, toNext: 110 });
  const maxed = levelInfo(normalizeMe({ ...raw, level: 50, levelXp: 150 }));
  assert.equal(maxed.maxed, true);
  assert.equal(maxed.pct, 100);
});

test('estado de cada premio según nivel y pase', () => {
  const me = normalizeMe(raw);
  const by = rewardsByLevel(me);
  assert.equal(by.length, 50);
  assert.equal(by[0].free.state, 'claimed');
  assert.equal(by[0].premium.state, 'needsPass'); // nivel alcanzado pero sin pase
  assert.equal(by[2].free.state, 'claimable');
  assert.equal(by[39].free.state, 'locked');
  assert.equal(by[9].free, null);
  assert.equal(claimableList(me).map((r) => `${r.level}:${r.track}`).join(), '3:free');
  const withPass = normalizeMe({ ...raw, purchase: { tier: 'go', at: '2026-11-11T00:00:00Z' } });
  assert.equal(claimableList(withPass).length, 3);
  assert.equal(tileState({ level: 45, track: 'premium', claimed: false }, { level: 3, hasPass: false }), 'locked');
});

test('ediciones: comprar, pasar a una mejor o ya tenerla', () => {
  const none = tierOffers(normalizeMe(raw));
  assert.deepEqual(none.map((t) => t.action), ['buy', 'buy', 'buy']);
  assert.equal(none[0].planId, 'pass_go');
  const withGo = tierOffers(normalizeMe({ ...raw, purchase: { tier: 'go' }, tiers: tiers.map((t) => ({ ...t, owned: t.tier === 'go', upgradePriceUsd: t.tier === 'go' ? null : Math.round((t.priceUsd - 1.99) * 100) / 100 })) }));
  assert.deepEqual(withGo.map((t) => t.action), ['owned', 'upgrade', 'upgrade']);
  assert.equal(withGo[0].current, true);
  assert.equal(withGo[2].price, 5);
  const withMax = tierOffers(normalizeMe({ ...raw, purchase: { tier: 'max' } }));
  assert.deepEqual(withMax.map((t) => t.action), ['owned', 'owned', 'owned']);
});

test('los minutos jugados se reportan de a 30, sin pasar el tope del día', () => {
  assert.deepEqual(playtimeBatches(75), [30, 30, 15]);
  assert.deepEqual(playtimeBatches(75, 100), [20]);
  assert.deepEqual(playtimeBatches(10, 120), []);
  assert.deepEqual(playtimeBatches(-5), []);
});

test('niveles ganados entre dos lecturas y fuentes de XP', () => {
  const a = normalizeMe(raw);
  const b = normalizeMe({ ...raw, level: 5 });
  assert.equal(levelsGained(a, b), 2);
  assert.equal(levelsGained(b, a), 0);
  assert.equal(levelsGained(null, b), 0);
  assert.equal(levelsGained(a, normalizeMe({ ...raw, level: 9, season: { ...season, id: 'otra' } })), 0);
  const src = xpSources(a);
  assert.equal(src.find((s) => s.id === 'play').today, 90);
  assert.equal(src.find((s) => s.id === 'premium').active, false);
});
