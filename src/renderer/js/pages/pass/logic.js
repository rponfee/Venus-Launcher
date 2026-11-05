// Venus Pass: la lógica pura de la página y del módulo (sin DOM), para poder probarla con node:test.
// Lo que manda el servidor (pass_me, 0041) se normaliza acá antes de usarse en cualquier lado. El pase se gana solo
// jugando: una sola pista de niveles, sin ediciones ni compra. Plan de premios: pages/pass/plan.js.
import { LEVELS, XP_PER_LEVEL, PLAY_CAP } from './plan.js';

export { PLAY_CAP };
export const PLAY_BATCH = 30; // minutos por llamada a pass_playtime (tope del servidor)
export const RANGE_SIZE = 50; // niveles por página de la lista

const DAY = 24 * 3600 * 1000;
const int = (v, def = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : def);
const num = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
const str = (v) => (typeof v === 'string' ? v : '');

/** Lo que devuelve pass_me, con cada campo validado. null si no hay temporada. */
export function normalizeMe(raw) {
  if (!raw || typeof raw !== 'object' || !raw.season || typeof raw.season !== 'object') return null;
  const s = raw.season;
  const season = {
    id: str(s.id),
    name: str(s.name),
    startsAt: str(s.startsAt) || null,
    endsAt: str(s.endsAt) || null,
    levels: Math.max(1, int(s.levels, LEVELS)),
    xpPerLevel: Math.max(1, int(s.xpPerLevel, XP_PER_LEVEL)),
    started: s.started !== false,
    ended: s.ended === true,
    permanent: s.permanent === true,
  };
  const x = raw.xp && typeof raw.xp === 'object' ? raw.xp : {};
  // Un premio por nivel (si el servidor mandara dos del mismo nivel gana el último); solo niveles que existen.
  const byLevel = new Map();
  for (const r of Array.isArray(raw.rewards) ? raw.rewards : []) {
    if (!r || int(r.level) < 1 || int(r.level) > season.levels || (r.kind !== 'points' && r.kind !== 'item')) continue;
    byLevel.set(int(r.level), { level: int(r.level), kind: r.kind, amount: r.kind === 'points' ? Math.max(0, int(r.amount)) : 0, itemId: r.kind === 'item' ? str(r.itemId) : null, claimed: r.claimed === true });
  }
  const level = Math.max(0, Math.min(season.levels, int(raw.level)));
  return {
    season,
    level,
    levelXp: Math.max(0, int(raw.levelXp)),
    xp: {
      xp: Math.max(0, int(x.xp)),
      fromPlay: Math.max(0, int(x.fromPlay)),
      fromBonus: Math.max(0, int(x.fromBonus)),
      premiumMult: Math.max(1, num(x.premiumMult, 1)),
      total: Math.max(0, int(x.total)),
    },
    playToday: Math.max(0, int(raw.playToday)),
    playCap: Math.max(1, int(raw.playCap, PLAY_CAP)),
    claimable: Math.max(0, int(raw.claimable)),
    rewards: [...byLevel.values()].sort((a, b) => a.level - b.level),
  };
}

/** 'none' | 'upcoming' | 'active' | 'ended'. Una temporada permanente no vence nunca. */
export function seasonState(season, now = Date.now()) {
  if (!season) return 'none';
  const start = Date.parse(season.startsAt || '');
  if (Number.isFinite(start) && now < start) return 'upcoming';
  if (season.permanent) return season.started === false ? 'upcoming' : 'active';
  const end = Date.parse(season.endsAt || '');
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

/** Qué clase de cosmético es un ítem del pase, por su id: 'frame' | 'title' | 'name_effect' | 'badge_style' | 'cape' | 'item'. */
export function itemKind(id) {
  const s = String(id || '');
  if (/frame/.test(s)) return 'frame';
  if (/title/.test(s)) return 'title';
  if (/effect/.test(s)) return 'name_effect';
  if (/badge/.test(s)) return 'badge_style';
  if (/cape/.test(s)) return 'cape';
  return 'item';
}

/** Estado de un premio para quien mira: 'claimed' | 'claimable' | 'locked' */
export function rewardState(reward, level) {
  if (reward.claimed) return 'claimed';
  return reward.level <= level ? 'claimable' : 'locked';
}

/** Los premios del 1 al último nivel, uno por nivel (reward null si el nivel no tiene), con su estado. */
export function levelTiles(me) {
  const byLevel = new Map(me.rewards.map((r) => [r.level, r]));
  const out = [];
  for (let level = 1; level <= me.season.levels; level++) {
    const r = byLevel.get(level) || null;
    out.push({ level, reward: r, state: r ? rewardState(r, me.level) : level <= me.level ? 'reached' : 'locked', current: level === me.level });
  }
  return out;
}

export function claimableList(me) {
  return me.rewards.filter((r) => rewardState(r, me.level) === 'claimable');
}

// ---------- Páginas de la lista (de a RANGE_SIZE niveles) ----------
/** [{ index, from, to }] cubriendo 1..levels. */
export function levelRanges(levels, size = RANGE_SIZE) {
  const out = [];
  for (let from = 1; from <= levels; from += size) out.push({ index: out.length, from, to: Math.min(levels, from + size - 1) });
  return out;
}

/** Índice de la página que contiene el nivel (el 0 va con la primera; pasado el último, la última). */
export function rangeIndexOf(level, ranges) {
  const lv = Math.max(1, level);
  const i = ranges.findIndex((r) => lv >= r.from && lv <= r.to);
  return i < 0 ? ranges.length - 1 : i;
}

/** Cuántos premios hay para reclamar, ya reclamados y en total dentro de una página. */
export function rangeStats(me, range) {
  let claimable = 0;
  let claimed = 0;
  let total = 0;
  for (const r of me.rewards) {
    if (r.level < range.from || r.level > range.to) continue;
    total++;
    const st = rewardState(r, me.level);
    if (st === 'claimable') claimable++;
    else if (st === 'claimed') claimed++;
  }
  return { claimable, claimed, total };
}

// ---------- Premios destacados y tiempos ----------
/** Los premios con cosmético (marcos, títulos, efectos), en orden de nivel, cada uno con su estado. */
export function itemRewards(me) {
  return me.rewards.filter((r) => r.kind === 'item').map((r) => ({ ...r, state: rewardState(r, me.level) }));
}

/** XP que faltan para llegar a un nivel (0 si ya se llegó). */
export function xpToLevel(me, level) {
  return Math.max(0, level * me.season.xpPerLevel - me.xp.total);
}

/** Minutos de juego que faltan para sumar esa XP (con Premium rinde 1,2 XP por minuto). */
export function minutesForXp(me, xp) {
  return Math.max(0, Math.ceil(xp / Math.max(1, me.xp.premiumMult)));
}

/** El próximo cosmético que todavía no se alcanzó: { reward, levelsLeft, xpLeft, minutesLeft } o null. */
export function nextItem(me) {
  const reward = itemRewards(me).find((r) => r.level > me.level);
  if (!reward) return null;
  const xpLeft = xpToLevel(me, reward.level);
  return { reward, levelsLeft: reward.level - me.level, xpLeft, minutesLeft: minutesForXp(me, xpLeft) };
}

/** Minutos de juego del pase (fromPlay) en horas y minutos, y lo de hoy. */
export function playSummary(me) {
  const total = me.xp.fromPlay;
  return { hours: Math.floor(total / 60), minutes: total % 60, today: Math.min(me.playToday, me.playCap), cap: me.playCap, left: Math.max(0, me.playCap - me.playToday), capped: me.playToday >= me.playCap };
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

/** Al subir de nivel entre dos lecturas: cuántos niveles se ganaron (0 si no hubo cambio o no había lectura previa). */
export function levelsGained(prev, next) {
  if (!prev || !next || prev.season?.id !== next.season?.id) return 0;
  return Math.max(0, next.level - prev.level);
}
