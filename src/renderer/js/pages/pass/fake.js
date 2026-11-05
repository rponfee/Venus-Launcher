// Venus Pass de ejemplo para capturas (VENUS_DEVSHOT + VENUS_REWARDS_FAKE, como el resto de Venus Points): misma
// forma que pass_me (0041), en memoria y sin red. 'demo' va por el nivel 74; 'premium' es una cuenta con Venus Premium
// (+20 % de XP) en el nivel 180; 'new' acaba de empezar (nivel 0). Los premios son los del plan real (plan.js).
import { buildRewards, SEASON_ID, LEVELS, XP_PER_LEVEL, PLAY_CAP, TRACK } from './plan.js';

const wait = (ms) => (typeof document === 'undefined' ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))); // sin pausa en las pruebas
const fail = (code) => Object.assign(new Error(code), { code });

export function createFakePass(scenario = 'demo') {
  const season = { id: SEASON_ID, name: 'Venus Pass', startsAt: '2026-01-01T12:00:00Z', endsAt: '2099-12-31T23:59:59Z', levels: LEVELS, xpPerLevel: XP_PER_LEVEL, started: true, ended: false, permanent: true };
  const premium = scenario === 'premium';
  let play = scenario === 'new' ? 25 : premium ? 9010 : 4470; // minutos jugados en el pase
  let premiumMinutes = premium ? play : 0; // de esos, los jugados con Premium
  let playToday = scenario === 'new' ? 25 : 70;
  const plan = buildRewards();
  const claimed = new Set(scenario === 'new' ? [] : plan.filter((r) => r.level <= (premium ? 175 : 52)).map((r) => r.level));

  function me() {
    const bonus = Math.floor(premiumMinutes / 5);
    const total = play + bonus;
    const level = Math.min(season.levels, Math.floor(total / season.xpPerLevel));
    const rewards = plan.map((r) => ({ level: r.level, kind: r.kind, amount: r.kind === 'points' ? r.amount : null, itemId: r.kind === 'item' ? r.itemId : null, claimed: claimed.has(r.level) }));
    return {
      season,
      xp: { xp: total, fromPlay: play, fromBonus: bonus, premiumMult: premium ? 1.2 : 1, total },
      level, levelXp: level >= season.levels ? season.xpPerLevel : total % season.xpPerLevel, playToday, playCap: PLAY_CAP,
      claimable: rewards.filter((r) => !r.claimed && r.level <= level).length,
      rewards,
    };
  }

  function grant(r) {
    claimed.add(r.level);
    return { level: r.level, track: TRACK, kind: r.kind, points: r.kind === 'points' ? r.amount : 0, itemId: r.itemId || null };
  }

  return {
    async rpc(name, args) {
      await wait(name === 'pass_me' ? 300 : 500);
      if (name === 'pass_me') return me();
      if (name === 'pass_playtime') {
        const before = playToday;
        playToday = Math.min(PLAY_CAP, playToday + Math.max(1, Math.min(30, Number(args?.p_minutes) || 0)));
        play += playToday - before;
        if (premium) premiumMinutes += playToday - before;
        return { today: playToday, added: playToday - before };
      }
      if (name === 'pass_claim') {
        const state = me();
        const r = state.rewards.find((x) => x.level === Number(args?.p_level));
        if (!r) throw fail('bad_reward');
        if (r.level > state.level) throw fail('locked');
        if (r.claimed) throw fail('already');
        return { ...grant(r), balance: 999 };
      }
      if (name === 'pass_claim_all') {
        const state = me();
        const out = state.rewards.filter((r) => !r.claimed && r.level <= state.level).map(grant);
        return { claimed: out, points: out.reduce((a, r) => a + r.points, 0), balance: 999 };
      }
      throw fail('unavailable');
    },
  };
}
