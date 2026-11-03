// Venus Points de ejemplo para capturas (VENUS_DEVSHOT + VENUS_REWARDS_FAKE): misma interfaz que el backend real
// de backend.js, en memoria y sin red. Escenarios: 'demo' (cuenta con puntos, invitación pendiente de verificar),
// 'premium' (con plan, x2 y lo premium incluido), 'new' (cuenta nueva que puede canjear un código), 'signedOut' y
// 'unavailable' (el servicio no responde). Nunca se carga en el uso normal del launcher.
import { RewardsError } from './backend.js';
import { dailyPoints, dailyStreak, utcDay } from './logic.js';

const DAY = 24 * 3600 * 1000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// El catálogo de 0021_puntos.sql
const SHOP = [
  ['frame_pixel', 'frame', 500, false, 10, { style: 'pixel' }],
  ['frame_neon', 'frame', 800, false, 20, { style: 'neon' }],
  ['frame_gold', 'frame', 1500, false, 30, { style: 'gold' }],
  ['frame_venus', 'frame', 0, true, 40, { style: 'venus' }],
  ['effect_shimmer', 'name_effect', 1200, false, 50, { effect: 'shimmer' }],
  ['effect_rainbow', 'name_effect', 2000, false, 60, { effect: 'rainbow' }],
  ['effect_fire', 'name_effect', 2500, false, 70, { effect: 'fire' }],
  ['badge_nebula', 'badge_style', 1000, false, 80, { style: 'nebula' }],
  ['badge_ice', 'badge_style', 1000, false, 90, { style: 'ice' }],
  ['badge_gold', 'badge_style', 0, true, 100, { style: 'gold' }],
  ['title_explorer', 'title', 300, false, 110, { title: 'explorer' }],
  ['title_builder', 'title', 300, false, 120, { title: 'builder' }],
  ['title_redstoner', 'title', 600, false, 130, { title: 'redstoner' }],
  ['title_legend', 'title', 3000, false, 140, { title: 'legend' }],
  ['title_supporter', 'title', 0, true, 150, { title: 'supporter' }],
].map(([id, kind, price, premium_only, sort, data]) => ({ id, kind, price, premium_only, sort, data }));

const ACHIEVEMENTS = [
  ['first_launch', 50, 'client'], ['playtime_10h', 100, 'client'], ['playtime_100h', 400, 'client'], ['instances_5', 50, 'client'],
  ['first_screenshot', 25, 'client'], ['first_clip', 50, 'client'], ['first_party', 75, 'client'], ['skin_created', 50, 'client'],
  ['profile_complete', 100, 'server'], ['first_friend', 50, 'server'], ['five_friends', 150, 'server'], ['mc_verified', 100, 'server'],
  ['badge_on', 50, 'server'], ['first_share', 50, 'server'], ['first_referral', 200, 'server'], ['five_referrals', 1000, 'server'],
  ['theme_published', 100, 'server'], ['premium', 300, 'server'],
].map(([id, points, kind]) => ({ id, points, kind }));

function seed(state, now) {
  const premium = state === 'premium';
  const fresh = state === 'new';
  const mult = premium ? 2 : 1;
  const ledger = [];
  const add = (delta, reason, ref, ago) => ledger.push({ delta, reason, ref, at: new Date(now - ago).toISOString() });
  const unlocked = new Map();
  if (!fresh) {
    add(1000, 'admin', 'beta-tester', 40 * DAY);
    for (const [id, ago] of [['first_launch', 30], ['instances_5', 21], ['first_friend', 18], ['playtime_10h', 12], ['first_screenshot', 9], ['first_referral', 6]]) {
      const a = ACHIEVEMENTS.find((x) => x.id === id);
      unlocked.set(id, now - ago * DAY);
      add(a.points * mult, 'achievement', id, ago * DAY);
    }
    add(500, 'referral', 'aaaaaaaa-0000-4000-8000-000000000001', 6 * DAY + 3600e3);
    add(500, 'referral', 'aaaaaaaa-0000-4000-8000-000000000002', 2 * DAY);
    add(-800, 'shop', 'frame_neon', 5 * DAY);
    add(-300, 'shop', 'title_explorer', 4 * DAY);
    // Racha de 4 días que termina ayer (demo: el de hoy está para reclamar) u hoy (premium)
    for (let d = premium ? 3 : 4; d >= 1; d--) {
      const day = utcDay(now - d * DAY);
      add(dailyPoints(Math.max(0, (premium ? 3 : 4) - d), mult), 'daily', day, d * DAY);
    }
    if (premium) {
      unlocked.set('premium', now - 2 * DAY);
      unlocked.set('mc_verified', now - 3 * DAY);
      add(300 * mult, 'achievement', 'premium', 2 * DAY);
      add(100 * mult, 'achievement', 'mc_verified', 3 * DAY);
      add(dailyPoints(3, mult), 'daily', utcDay(now), 2 * 3600e3);
    }
  }
  ledger.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    premium,
    mult,
    ledger,
    unlocked,
    items: new Set(fresh ? [] : ['frame_neon', 'title_explorer']),
    equipped: fresh ? {} : premium ? { frame: 'frame_venus', title: 'title_supporter', badgeStyle: 'badge_gold' } : { frame: 'frame_neon', title: 'title_explorer' },
    referralCode: fresh ? null : 'VP-7K2QXM',
    referredBy: state === 'demo' ? { username: 'TomiCraft', rewarded: false } : null,
    canClaimReferral: fresh,
    referrals: fresh ? { total: 0, rewarded: 0 } : { total: 3, rewarded: 2 },
    mcVerified: premium,
  };
}

export function createFakeBackend(state = 'demo') {
  const now = Date.now();
  const s = seed(state, now);
  const balance = () => s.ledger.reduce((sum, r) => sum + r.delta, 0);
  const fail = (code, detail) => {
    throw new RewardsError(code, detail ? `${code}:${detail}` : code, detail);
  };
  const award = (delta, reason, ref) => s.ledger.unshift({ delta, reason, ref, at: new Date().toISOString() });
  const signedIn = state !== 'signedOut';

  const me = () => ({
    balance: balance(),
    premium: s.premium,
    multiplier: s.mult,
    dailyClaimed: s.ledger.some((r) => r.reason === 'daily' && r.ref === utcDay(Date.now())),
    referralCode: s.referralCode,
    referredBy: s.referredBy,
    canClaimReferral: s.canClaimReferral,
    referrals: { ...s.referrals },
    mcVerified: s.mcVerified,
    achievements: ACHIEVEMENTS.map((a) => ({ ...a, unlockedAt: s.unlocked.has(a.id) ? new Date(s.unlocked.get(a.id)).toISOString() : null })),
    items: [...s.items],
    history: s.ledger.slice(0, 30).map((r) => ({ ...r })),
  });

  const rpcs = {
    points_me: me,
    achievements_me: () => ({
      unlocked: Object.fromEntries(['playtime_1', 'playtime_5', 'playtime_10h', 'sessions_5', 'first_launch', 'streak_3', 'blocks_100', 'blocks_1000', 'diamond_1', 'diamond_10', 'mobs_10', 'mobs_100', 'dragon_1', 'first_friend', 'night_owl', 'instances_1', 'instances_3'].map((id) => [id, '2026-10-30T12:00:00Z'])),
      rarity: { playtime_1: 92, playtime_25: 41, diamond_50: 12, dragon_1: 4, dragon_5: 0.8 },
      totalUsers: 1200,
      metrics: { friends: 3, messages: 42, memberDays: 12, pointsEarned: 860, missions: 4, items: 2, achievements: 17, dailies: 9 },
      clientToday: 0,
      clientCap: 40,
    }),
    achievements_claim: () => ({ unlocked: [], skipped: 0, balance: balance() }),
    achievements_sweep: () => ({ unlocked: [], balance: balance() }),
    missions_me: () => {
      const d = new Date();
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
      return {
        multiplier: s.mult,
        daily: { key: d.toISOString().slice(0, 10), endsAt: end, bonus: 25, bonusClaimed: false, missions: [{ id: 'd_play_30', metric: 'playMinutes', target: 30, points: 25, claimed: false }, { id: 'd_shot_1', metric: 'screenshots', target: 1, points: 15, claimed: true }, { id: 'd_message_1', metric: 'messages', target: 1, points: 15, claimed: false }] },
        weekly: { key: 'demo', endsAt: new Date(Date.now() + 3 * 86400000).toISOString(), bonus: 100, bonusClaimed: false, missions: [{ id: 'w_play_300', metric: 'playMinutes', target: 300, points: 90, claimed: false }, { id: 'w_voice_3', metric: 'voiceJoins', target: 3, points: 70, claimed: false }, { id: 'w_ach_3', metric: 'achievements', target: 3, points: 70, claimed: false }] },
      };
    },
    mission_claim: () => ({ points: 25, bonus: 0, balance: balance() }),
    venus_is_premium: () => s.premium,
    points_daily_claim() {
      const today = utcDay(Date.now());
      if (s.ledger.some((r) => r.reason === 'daily' && r.ref === today)) return { points: 0, already: true, balance: balance() };
      const streak = dailyStreak(s.ledger, Date.now()).current;
      const points = dailyPoints(streak, s.mult);
      award(points, 'daily', today);
      return { points, streak: streak + 1, balance: balance() };
    },
    achievement_claim({ p_id: id } = {}) {
      const a = ACHIEVEMENTS.find((x) => x.id === id);
      if (!a) fail('bad_achievement');
      if (s.unlocked.has(id)) return { unlocked: true, points: 0, already: true };
      if (a.kind === 'server') {
        const met = { premium: s.premium, mc_verified: s.mcVerified, first_friend: true, five_friends: false }[id];
        if (!met) fail('not_met');
      }
      s.unlocked.set(id, Date.now());
      award(a.points * s.mult, 'achievement', id);
      return { unlocked: true, points: a.points * s.mult, balance: balance() };
    },
    shop_buy({ p_item: id } = {}) {
      const it = SHOP.find((x) => x.id === id);
      if (!it) fail('bad_item');
      if (it.premium_only) fail('premium_item');
      if (s.items.has(id)) fail('owned');
      if (balance() < it.price) fail('not_enough_points');
      if (it.price > 0) award(-it.price, 'shop', id);
      s.items.add(id);
      return { ok: true, balance: balance() };
    },
    referral_my_code() {
      s.referralCode ||= 'VP-N3WCQD';
      return s.referralCode;
    },
    referral_claim({ p_code: code } = {}) {
      if (!s.canClaimReferral) fail('already_referred');
      if (code === s.referralCode) fail('own_code');
      if (!/^VP-[A-HJ-NP-Z2-9]{6}$/.test(String(code || ''))) fail('bad_code');
      s.canClaimReferral = false;
      s.referredBy = { username: 'LuliMC', rewarded: s.mcVerified };
      return { ok: true, rewarded: s.mcVerified };
    },
    profile_public: () => ({ id: 'fake-me', username: 'Ringo', displayName: 'Ringo', nameStyle: { font: 'pixel', color: '#ffc562' }, equipped: { ...s.equipped }, premium: s.premium, badges: [] }),
    profile_customize({ p_patch: patch } = {}) {
      if (patch?.equipped) {
        for (const [slot, id] of Object.entries(patch.equipped)) {
          if (!id) continue;
          const it = SHOP.find((x) => x.id === id);
          if (!it || !(s.items.has(id) || (it.premium_only && s.premium))) fail('not_owned', id);
        }
        s.equipped = Object.fromEntries(Object.entries(patch.equipped).filter(([, v]) => v));
      }
      return { equipped: { ...s.equipped }, premium: s.premium };
    },
  };

  return {
    fake: true,
    signedIn: () => signedIn,
    userId: () => (signedIn ? 'fake-me' : null),
    async rpc(name, args) {
      await wait(name === 'points_me' ? 350 : 500);
      if (!signedIn) fail('noSession');
      if (state === 'unavailable') fail('unavailable');
      const fn = rpcs[name];
      if (!fn) fail('unavailable');
      return fn(args);
    },
    async shopItems() {
      await wait(200);
      if (!signedIn) fail('noSession');
      if (state === 'unavailable') fail('unavailable');
      return SHOP.map((it) => ({ ...it, data: { ...it.data } }));
    },
    onAuth: () => () => {},
    // La verificación de ejemplo del proceso principal (rewards/fake.js) marca la cuenta como verificada acá.
    noteVerified(result) {
      s.mcVerified = true;
      if (s.referredBy && !s.referredBy.rewarded && result?.rewarded) {
        s.referredBy.rewarded = true;
        award(200, 'referred', 'fake-referrer');
      }
    },
  };
}
