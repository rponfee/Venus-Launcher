// Venus Pass: la lógica pura de la página y del módulo (sin DOM), para poder probarla con node:test.
// Lo que manda el servidor (pass_me, 0026) se normaliza acá antes de usarse en cualquier lado.

export const TIERS = ['go', 'pro', 'max'];
export const TRACKS = ['free', 'premium'];
export const PLAY_CAP = 120; // minutos por día que dan XP (el servidor tiene el mismo tope)
export const PLAY_BATCH = 30; // minutos por llamada a pass_playtime (tope del servidor)

const DAY = 24 * 3600 * 1000;
const int = (v, def = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : def);
const num = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
const str = (v) => (typeof v === 'string' ? v : '');

export const tierRank = (tier) => TIERS.indexOf(tier) + 1;

/** Lo que devuelve pass_me, con cada campo validado. null si no hay temporada. */
export function normalizeMe(raw) {
  if (!raw || typeof raw !== 'object' || !raw.season || typeof raw.season !== 'object') return null;
  const s = raw.season;
  const season = {
    id: str(s.id),
    name: str(s.name),
    startsAt: str(s.startsAt) || null,
    endsAt: str(s.endsAt) || null,
    levels: Math.max(1, int(s.levels, 50)),
    xpPerLevel: Math.max(1, int(s.xpPerLevel, 150)),
    started: s.started !== false,
    ended: s.ended === true,
  };
  const x = raw.xp && typeof raw.xp === 'object' ? raw.xp : {};
  const purchase = raw.purchase && typeof raw.purchase === 'object' && TIERS.includes(raw.purchase.tier) ? { tier: raw.purchase.tier, at: str(raw.purchase.at) || null } : null;
  const rewards = (Array.isArray(raw.rewards) ? raw.rewards : [])
    .filter((r) => r && TRACKS.includes(r.track) && int(r.level) >= 1 && (r.kind === 'points' || r.kind === 'item'))
    .map((r) => ({ level: int(r.level), track: r.track, kind: r.kind, amount: r.kind === 'points' ? Math.max(0, int(r.amount)) : 0, itemId: r.kind === 'item' ? str(r.itemId) : null, claimed: r.claimed === true }));
  const tiers = (Array.isArray(raw.tiers) ? raw.tiers : [])
    .filter((t) => t && TIERS.includes(t.tier))
    .map((t) => ({
      tier: t.tier,
      priceUsd: num(t.priceUsd),
      bonusLevels: Math.max(0, int(t.bonusLevels)),
      xpMult: Math.max(1, num(t.xpMult, 1)),
      perkItems: (Array.isArray(t.perkItems) ? t.perkItems : []).filter((i) => typeof i === 'string'),
      owned: t.owned === true,
      upgradePriceUsd: t.upgradePriceUsd === null || t.upgradePriceUsd === undefined ? null : num(t.upgradePriceUsd),
    }))
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
  const level = Math.max(0, Math.min(season.levels, int(raw.level)));
  return {
    season,
    purchase,
    level,
    levelXp: Math.max(0, int(raw.levelXp)),
    xp: {
      xp: Math.max(0, int(x.xp)),
      fromPoints: Math.max(0, int(x.fromPoints)),
      fromPlay: Math.max(0, int(x.fromPlay)),
      bonusLevels: Math.max(0, int(x.bonusLevels)),
      premiumMult: Math.max(1, num(x.premiumMult, 1)),
      tierMult: Math.max(1, num(x.tierMult, 1)),
      total: Math.max(0, int(x.total)),
    },
    playToday: Math.max(0, int(raw.playToday)),
    playCap: Math.max(1, int(raw.playCap, PLAY_CAP)),
    claimable: Math.max(0, int(raw.claimable)),
    rewards,
    tiers,
  };
}

/** 'none' | 'upcoming' | 'active' | 'ended' */
export function seasonState(season, now = Date.now()) {
  if (!season) return 'none';
  const start = Date.parse(season.startsAt || '');
  const end = Date.parse(season.endsAt || '');
  if (Number.isFinite(start) && now < start) return 'upcoming';
  if (Number.isFinite(end) && now >= end) return 'ended';
  if (season.ended) return 'ended';
  if (season.started === false) return 'upcoming';
  return 'active';
}

/** Días enteros que faltan hasta la fecha (0 si ya pasó). */
export function daysLeft(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t) || t <= now) return 0;
  return Math.ceil((t - now) / DAY);
}

/** Progreso del nivel: { level, levels, xpPerLevel, levelXp, pct, maxed, toNext } */
export function levelInfo(me) {
  const levels = me.season.levels;
  const per = me.season.xpPerLevel;
  const maxed = me.level >= levels;
  const levelXp = maxed ? per : Math.min(per, me.levelXp);
  return { level: me.level, levels, xpPerLevel: per, levelXp, pct: Math.round((levelXp / per) * 100), maxed, toNext: maxed ? 0 : per - levelXp };
}

/** Estado de un premio para quien mira: 'claimed' | 'claimable' | 'locked' | 'needsPass' */
export function tileState(reward, { level, hasPass }) {
  if (reward.claimed) return 'claimed';
  if (reward.track === 'premium' && !hasPass) return reward.level <= level ? 'needsPass' : 'locked';
  return reward.level <= level ? 'claimable' : 'locked';
}

/** Los premios agrupados por nivel, del 1 al último, con el estado de cada uno. */
export function rewardsByLevel(me) {
  const hasPass = Boolean(me.purchase);
  const byLevel = new Map();
  for (const r of me.rewards) {
    if (!byLevel.has(r.level)) byLevel.set(r.level, { level: r.level, free: null, premium: null });
    byLevel.get(r.level)[r.track] = { ...r, state: tileState(r, { level: me.level, hasPass }) };
  }
  const out = [];
  for (let lv = 1; lv <= me.season.levels; lv++) out.push(byLevel.get(lv) || { level: lv, free: null, premium: null });
  return out;
}

export function claimableList(me) {
  const hasPass = Boolean(me.purchase);
  return me.rewards.filter((r) => tileState(r, { level: me.level, hasPass }) === 'claimable');
}

/** Las ediciones con lo que puede hacer el usuario con cada una: 'owned' (la tiene o una mejor), 'buy', 'upgrade'. */
export function tierOffers(me) {
  const ownedRank = me.purchase ? tierRank(me.purchase.tier) : 0;
  return me.tiers.map((t) => {
    const rank = tierRank(t.tier);
    let action = 'buy';
    if (rank <= ownedRank) action = 'owned';
    else if (ownedRank > 0) action = 'upgrade';
    const price = action === 'upgrade' && t.upgradePriceUsd !== null ? t.upgradePriceUsd : t.priceUsd;
    return { ...t, action, current: me.purchase?.tier === t.tier, price, planId: `pass_${t.tier}` };
  });
}

/** Cuántas llamadas de a PLAY_BATCH minutos hacen falta para reportar n minutos (sin pasar del tope del día). */
export function playtimeBatches(minutes, playToday = 0, cap = PLAY_CAP) {
  const room = Math.max(0, cap - Math.max(0, int(playToday)));
  const n = Math.max(0, Math.min(int(minutes), room));
  const out = [];
  let left = n;
  while (left > 0) {
    out.push(Math.min(PLAY_BATCH, left));
    left -= Math.min(PLAY_BATCH, left);
  }
  return out;
}

/** Lo que vale cada fuente de XP, para la tarjeta "Cómo subir de nivel". */
export function xpSources(me) {
  const x = me.xp;
  return [
    { id: 'points', value: x.fromPoints },
    { id: 'play', value: x.fromPlay, today: me.playToday, cap: me.playCap },
    { id: 'premium', mult: x.premiumMult, active: x.premiumMult > 1 },
    { id: 'tier', mult: x.tierMult, active: x.tierMult > 1 },
    { id: 'bonus', levels: x.bonusLevels, active: x.bonusLevels > 0 },
  ];
}

/** Al subir de nivel entre dos lecturas: cuántos niveles se ganaron (0 si no hubo cambio o no había lectura previa). */
export function levelsGained(prev, next) {
  if (!prev || !next || prev.season?.id !== next.season?.id) return 0;
  return Math.max(0, next.level - prev.level);
}
