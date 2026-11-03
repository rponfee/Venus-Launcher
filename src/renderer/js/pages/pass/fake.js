// Venus Pass de ejemplo para capturas (VENUS_DEVSHOT + VENUS_REWARDS_FAKE, como el resto de Venus Points): misma
// forma que pass_me (0026), en memoria y sin red. 'premium' tiene la edición Max; 'demo', la Go; 'new', ninguna.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY = 24 * 3600 * 1000;

function seasonRewards() {
  const out = [];
  for (let lv = 1; lv <= 50; lv++) {
    if (lv === 20) out.push({ level: lv, track: 'free', kind: 'item', itemId: 'pass_s1_free_title' });
    else if (lv === 40) out.push({ level: lv, track: 'free', kind: 'item', itemId: 'pass_s1_free_frame' });
    else if (lv % 10 === 0) out.push({ level: lv, track: 'free', kind: 'points', amount: 50 });
    else if (lv % 2 === 1) out.push({ level: lv, track: 'free', kind: 'points', amount: 20 });
    if (lv === 1) out.push({ level: lv, track: 'premium', kind: 'item', itemId: 'pass_s1_frame' });
    else if (lv === 15) out.push({ level: lv, track: 'premium', kind: 'item', itemId: 'pass_s1_effect' });
    else if (lv === 30) out.push({ level: lv, track: 'premium', kind: 'item', itemId: 'pass_s1_title' });
    else if (lv === 50) out.push({ level: lv, track: 'premium', kind: 'item', itemId: 'pass_s1_frame_legend' });
    else if (lv % 10 === 0) out.push({ level: lv, track: 'premium', kind: 'points', amount: 150 });
    else out.push({ level: lv, track: 'premium', kind: 'points', amount: 50 });
  }
  return out;
}

export function createFakePass(scenario = 'demo') {
  const now = Date.now();
  const season = { id: 'temporada-1', name: 'Amanecer en Venus', startsAt: new Date(now - 12 * DAY).toISOString(), endsAt: new Date(now + 44 * DAY).toISOString(), levels: 50, xpPerLevel: 150, started: true, ended: false };
  let tier = scenario === 'premium' ? 'max' : scenario === 'new' ? null : 'go';
  const claimed = new Set(scenario === 'new' ? [] : ['1:free', '3:free', '1:premium', '2:premium']);
  let points = scenario === 'new' ? 60 : 1180;
  let play = scenario === 'new' ? 25 : 640;
  let playToday = scenario === 'new' ? 25 : 70;
  const rewards = seasonRewards();
  const tiersBase = [
    { tier: 'go', priceUsd: 1.99, bonusLevels: 0, xpMult: 1, perkItems: [] },
    { tier: 'pro', priceUsd: 4.99, bonusLevels: 10, xpMult: 1, perkItems: ['pass_pro_title'] },
    { tier: 'max', priceUsd: 6.99, bonusLevels: 25, xpMult: 1.25, perkItems: ['pass_pro_title', 'pass_max_frame'] },
  ];
  const rank = (t) => ['go', 'pro', 'max'].indexOf(t) + 1;
  function me() {
    const t = tiersBase.find((x) => x.tier === tier);
    const premiumMult = scenario === 'premium' ? 1.2 : 1;
    const xp = Math.floor((points + play) * premiumMult * (t?.xpMult || 1));
    const total = xp + (t?.bonusLevels || 0) * season.xpPerLevel;
    const level = Math.min(season.levels, Math.floor(total / season.xpPerLevel));
    const owned = tier ? rank(tier) : 0;
    const list = rewards.map((r) => ({ ...r, claimed: claimed.has(`${r.level}:${r.track}`) }));
    const claimable = list.filter((r) => !r.claimed && r.level <= level && (r.track === 'free' || tier)).length;
    return {
      season, purchase: tier ? { tier, at: new Date(now - 10 * DAY).toISOString() } : null,
      xp: { xp, fromPoints: points, fromPlay: play, bonusLevels: t?.bonusLevels || 0, premiumMult, tierMult: t?.xpMult || 1, total },
      level, levelXp: level >= season.levels ? season.xpPerLevel : total % season.xpPerLevel, playToday, playCap: 120, claimable,
      rewards: list,
      tiers: tiersBase.map((x) => ({ ...x, owned: rank(x.tier) <= owned, upgradePriceUsd: rank(x.tier) > owned ? Math.round((x.priceUsd - (t?.priceUsd || 0)) * 100) / 100 : null })),
    };
  }
  return {
    async rpc(name, args) {
      await wait(name === 'pass_me' ? 300 : 500);
      if (name === 'pass_me') return me();
      if (name === 'pass_playtime') {
        const before = playToday;
        playToday = Math.min(120, playToday + Math.max(1, Math.min(30, Number(args?.p_minutes) || 0)));
        play += playToday - before;
        return { today: playToday, added: playToday - before };
      }
      if (name === 'pass_claim' || name === 'pass_claim_all') {
        const state = me();
        const list = name === 'pass_claim' ? state.rewards.filter((r) => r.level === Number(args?.p_level) && r.track === args?.p_track) : state.rewards;
        const out = [];
        let pts = 0;
        for (const r of list) {
          if (r.claimed || r.level > state.level || (r.track === 'premium' && !tier)) {
            if (name === 'pass_claim') throw Object.assign(new Error(r.claimed ? 'already' : r.track === 'premium' && !tier ? 'no_pass' : 'locked'), { code: r.claimed ? 'already' : r.track === 'premium' && !tier ? 'no_pass' : 'locked' });
            continue;
          }
          claimed.add(`${r.level}:${r.track}`);
          pts += r.kind === 'points' ? r.amount : 0;
          out.push({ level: r.level, track: r.track, kind: r.kind, points: r.kind === 'points' ? r.amount : 0, itemId: r.itemId || null });
        }
        return name === 'pass_claim' ? { ...out[0], balance: 999 } : { claimed: out, points: pts, balance: 999 };
      }
      throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
    },
    // Para la demo del pago: la "compra" se acredita sola.
    grant(newTier) {
      tier = newTier;
    },
  };
}
