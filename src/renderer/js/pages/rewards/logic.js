// Venus Points: lógica pura (sin DOM ni imports) que comparten la página, features/rewards.js y features/premium.js.
// Se prueba con Node en src/main/modules/rewards/test/logic.test.js. Reglas del servidor: 0021_puntos.sql.

export const DOWNLOAD_URL = 'https://github.com/rponfee/Venus-Launcher/releases/latest';

// Premio diario: 10 por día (UTC) + 5 por cada día seguido antes de hoy, hasta +25; premium x2 (points_daily_claim).
export const DAILY_BASE = 10;
export const DAILY_STEP = 5;
export const DAILY_MAX_BONUS = 25;
// Invitaciones: el que invita gana 500 y el invitado 200, cuando el invitado verifica una cuenta de Minecraft.
export const REFERRAL_POINTS = { referrer: 500, referred: 200 };
export const REFERRAL_DAYS = 14;

// Logros que se comprueban en esta PC (contrato 3: window 'venus:achievement') y los que comprueba el servidor.
export const PC_ACHIEVEMENTS = ['first_launch', 'playtime_10h', 'playtime_100h', 'instances_5', 'first_screenshot', 'first_clip', 'first_party', 'skin_created'];
export const SERVER_ACHIEVEMENTS = ['profile_complete', 'first_friend', 'five_friends', 'mc_verified', 'badge_on', 'first_share', 'first_referral', 'five_referrals', 'theme_published', 'premium'];
export const ACHIEVEMENT_ICONS = {
  first_launch: 'rocket',
  playtime_10h: 'clock',
  playtime_100h: 'trophy',
  instances_5: 'layers',
  first_screenshot: 'image',
  first_clip: 'camera',
  first_party: 'users',
  skin_created: 'palette',
  profile_complete: 'user',
  first_friend: 'userPlus',
  five_friends: 'users',
  mc_verified: 'shieldCheck',
  badge_on: 'star',
  first_share: 'share',
  first_referral: 'heart',
  five_referrals: 'crown',
  theme_published: 'sparkles',
  premium: 'crown',
};
export const ACHIEVEMENT_ID = /^[a-z0-9_]{2,40}$/;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Tienda: tipo de cosmético -> casillero de profiles.equipped (profile_customize).
export const SLOT_BY_KIND = { frame: 'frame', name_effect: 'nameEffect', badge_style: 'badgeStyle', title: 'title' };
export const KIND_ORDER = ['frame', 'name_effect', 'badge_style', 'title'];

// Errores de las RPC de 0020/0021 (texto de la excepción) y los que arma el cliente.
export const SERVER_CODES = [
  'bad_code', 'own_code', 'already_referred', 'too_late', 'loop',
  'bad_achievement', 'not_met', 'too_many_today',
  'bad_item', 'premium_item', 'owned', 'not_enough_points',
  'premium_required', 'not_owned', 'bad_equipped', 'bad_request',
];
export const CLIENT_CODES = ['noSession', 'banned', 'muted', 'unavailable', 'network', 'server'];

// ---------- Formatos ----------
function numberFormat(locale) {
  try {
    return new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: 0 });
  } catch {
    return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
  }
}

/** Saldo con separador de miles del idioma ("1.250" en español). Lo que no es un número cuenta como 0. */
export function formatPoints(n, locale) {
  const v = Number(n);
  return numberFormat(locale).format(Number.isFinite(v) ? Math.trunc(v) : 0);
}

/** Movimiento del historial con signo: "+25" o "−800" (signo menos tipográfico). */
export function formatDelta(n, locale) {
  const v = Math.trunc(Number(n) || 0);
  const abs = numberFormat(locale).format(Math.abs(v));
  return v < 0 ? `−${abs}` : `+${abs}`;
}

// ---------- Premio diario ----------
/** Día UTC 'YYYY-MM-DD' (el servidor guarda el premio diario con esa fecha como ref). */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Medianoche UTC siguiente: cuándo vuelve el premio diario. */
export function nextUtcMidnight(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Puntos del premio de hoy según los días seguidos antes de hoy y el multiplicador (1 o 2). */
export function dailyPoints(streakBefore, multiplier = 1) {
  const days = Math.max(0, Math.trunc(Number(streakBefore) || 0));
  const mult = Number(multiplier) === 2 ? 2 : 1;
  return (DAILY_BASE + Math.min(days * DAILY_STEP, DAILY_MAX_BONUS)) * mult;
}

/**
 * Racha a partir del historial de points_me (últimos 30 movimientos): días seguidos con premio diario que terminan
 * hoy (si ya se reclamó) o ayer. capped = el historial podría estar cortado (la racha real puede ser mayor).
 */
export function dailyStreak(history, now) {
  const days = new Set((Array.isArray(history) ? history : []).filter((r) => r && r.reason === 'daily' && typeof r.ref === 'string').map((r) => r.ref));
  const today = utcDay(now);
  const claimedToday = days.has(today);
  let cursor = claimedToday ? now : now - DAY;
  let count = 0;
  while (count < 31 && days.has(utcDay(cursor))) {
    count++;
    cursor -= DAY;
  }
  const capped = Array.isArray(history) && history.length >= 30 && count > 0 && count === days.size;
  return { current: count, claimedToday, capped };
}

/**
 * Estado del premio diario para la interfaz.
 *   claimable: se puede reclamar ahora; points: lo que da ahora (o mañana si ya se reclamó)
 *   streak: días seguidos (contando hoy si ya se reclamó); nextAt: cuándo vuelve (null si se puede reclamar)
 */
export function dailyInfo({ history, dailyClaimed, multiplier } = {}, now = Date.now()) {
  const s = dailyStreak(history, now);
  const claimed = Boolean(dailyClaimed) || s.claimedToday;
  // Si ya se reclamó pero el historial no lo muestra todavía, hoy cuenta igual.
  const streak = claimed && !s.claimedToday ? s.current + 1 : s.current;
  return {
    claimable: !claimed,
    streak,
    capped: s.capped,
    points: claimed ? dailyPoints(streak, multiplier) : dailyPoints(s.current, multiplier),
    nextAt: claimed ? nextUtcMidnight(now) : null,
    maxed: Math.min(streak * DAILY_STEP, DAILY_MAX_BONUS) >= DAILY_MAX_BONUS,
  };
}

// ---------- Logros ----------
/** Logros de la PC que ya se cumplen con los datos del launcher (stats:summary y store.instances). */
export function pcAchievementsFor({ sessions = 0, totalMs = 0, instances = 0 } = {}) {
  const out = [];
  if (Number(sessions) > 0 || Number(totalMs) > 0) out.push('first_launch');
  if (Number(totalMs) >= 10 * HOUR) out.push('playtime_10h');
  if (Number(totalMs) >= 100 * HOUR) out.push('playtime_100h');
  if (Number(instances) >= 5) out.push('instances_5');
  return out;
}

/** Progreso de un logro medible ({ value, target, unit: 'hours' o 'count' }) o null. */
export function achievementProgress(id, { totalMs = 0, instances = 0, friends = 0, referralsRewarded = 0 } = {}) {
  const clamp = (value, target, unit) => ({ value: Math.max(0, Math.min(value, target)), target, unit });
  switch (id) {
    case 'playtime_10h': return clamp(Math.floor((Number(totalMs) || 0) / HOUR), 10, 'hours');
    case 'playtime_100h': return clamp(Math.floor((Number(totalMs) || 0) / HOUR), 100, 'hours');
    case 'instances_5': return clamp(Number(instances) || 0, 5, 'count');
    case 'five_friends': return clamp(Number(friends) || 0, 5, 'count');
    case 'five_referrals': return clamp(Number(referralsRewarded) || 0, 5, 'count');
    default: return null;
  }
}

/** Logros del servidor que vale la pena probar con lo que sabe la interfaz (achievement_claim tolera not_met). */
export function serverHints({ premium = false, mcVerified = false, referralsRewarded = 0, friends = 0, badgeEnrolled = false } = {}) {
  const out = [];
  if (premium) out.push('premium');
  if (mcVerified) out.push('mc_verified');
  if (badgeEnrolled) out.push('badge_on');
  if (Number(friends) >= 1) out.push('first_friend');
  if (Number(friends) >= 5) out.push('five_friends');
  if (Number(referralsRewarded) >= 1) out.push('first_referral');
  if (Number(referralsRewarded) >= 5) out.push('five_referrals');
  return out;
}

/** Separa los logros de points_me en ganados y por ganar, en el orden del servidor. */
export function splitAchievements(list) {
  const rows = (Array.isArray(list) ? list : []).filter((a) => a && typeof a.id === 'string');
  return { unlocked: rows.filter((a) => a.unlockedAt), locked: rows.filter((a) => !a.unlockedAt) };
}

// ---------- Invitaciones ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Normaliza un código de invitación ("vp 7k2q xm", "7K2QXM" -> "VP-7K2QXM"); null si no puede ser válido. */
export function normalizeReferralCode(raw) {
  const SEP = /[\s_‐-―-]+/g;
  let s = String(raw ?? '').toUpperCase().trim();
  // "VP-" o "VP " al principio es el prefijo; "VPABCD" sin separador puede ser un código sin el prefijo
  const prefixed = /^VP[\s_‐-―-]/.test(s);
  s = s.replace(SEP, '');
  if (prefixed || (s.length === 8 && s.startsWith('VP'))) s = s.slice(2);
  if (s.length !== 6 || [...s].some((c) => !CODE_CHARS.includes(c))) return null;
  return `VP-${s}`;
}

// ---------- Errores ----------
/**
 * Código estable para un error de supabase-js (PostgrestError), de red o ya clasificado. Los del servidor son el
 * texto de la excepción ('not_met', 'premium_required:nameStyle' -> 'premium_required'); los demás, CLIENT_CODES.
 */
export function classifyError(err) {
  if (!err) return 'server';
  const code = typeof err.code === 'string' ? err.code : '';
  if (CLIENT_CODES.includes(code) || SERVER_CODES.includes(code)) return code;
  const msg = String(err.message ?? err ?? '').trim();
  const head = /^([a-z_]+)(?::.*)?$/.exec(msg)?.[1];
  if (head === 'not_authenticated') return 'noSession';
  if (head === 'user_banned') return 'banned';
  if (head === 'user_muted') return 'muted';
  if (head === 'bad_field') return 'bad_request';
  if (head && SERVER_CODES.includes(head)) return head;
  if (['PGRST202', 'PGRST205', 'PGRST204', '42883', '42P01', '42703'].includes(code) || err.status === 404) return 'unavailable';
  if (code === 'PGRST301' || code === 'PGRST302' || err.status === 401 || /\bJWT\b/i.test(msg)) return 'noSession';
  if (err.name === 'AbortError' || /failed to fetch|network|fetch failed|load failed|timed? ?out|ECONN|ENOTFOUND/i.test(msg)) return 'network';
  return 'server';
}

/** Lo que viene después de los dos puntos ('not_owned:frame_gold' -> 'frame_gold') o null. */
export function errorDetail(err) {
  const m = /^[a-z_]+:(.+)$/.exec(String(err?.message ?? '').trim());
  return m ? m[1] : null;
}

// ---------- Tienda ----------
/**
 * Arma la vista de la tienda: grupos por tipo (en KIND_ORDER) con el estado de cada ítem.
 *   state: 'equipped' | 'owned' (comprado o incluido con premium) | 'buy' | 'short' (faltan puntos) | 'premium' (solo premium)
 */
export function shopView(items, { owned = [], premium = false, balance = 0, equipped = {} } = {}) {
  const have = new Set(Array.isArray(owned) ? owned : []);
  const eq = equipped && typeof equipped === 'object' ? equipped : {};
  const groups = new Map(KIND_ORDER.map((k) => [k, []]));
  // Lo que viene del Venus Pass (source 'pass', 0026) no se vende: no va en la tienda.
  const rows = (Array.isArray(items) ? items : []).filter((it) => it && typeof it.id === 'string' && SLOT_BY_KIND[it.kind] && it.active !== false && (!it.source || it.source === 'shop'));
  rows.sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || a.id.localeCompare(b.id));
  for (const it of rows) {
    const slot = SLOT_BY_KIND[it.kind];
    const price = Math.max(0, Number(it.price) || 0);
    const premiumOnly = it.premium_only === true || it.premiumOnly === true;
    const isOwned = have.has(it.id) || (premiumOnly && premium);
    let state;
    if (isOwned) state = eq[slot] === it.id ? 'equipped' : 'owned';
    else if (premiumOnly) state = 'premium';
    else state = Number(balance) >= price ? 'buy' : 'short';
    groups.get(it.kind).push({ item: it, slot, price, premiumOnly, owned: isOwned, state, missing: state === 'short' ? price - Number(balance) : 0 });
  }
  return KIND_ORDER.map((kind) => ({ kind, items: groups.get(kind) })).filter((g) => g.items.length);
}

/**
 * equipped nuevo para profile_customize: el servidor reemplaza todo el objeto y rechaza lo que no se tiene, así que
 * se mandan todos los casilleros y se descartan los que ya no corresponden (por ejemplo, lo premium sin premium).
 * itemId null desequipa ese casillero.
 */
export function equipPatch(equipped, slot, itemId, { items = [], owned = [], premium = false } = {}) {
  const byId = new Map((Array.isArray(items) ? items : []).filter((it) => it && it.id).map((it) => [it.id, it]));
  const have = new Set(Array.isArray(owned) ? owned : []);
  const valid = (s, id) => {
    const it = byId.get(id);
    if (!it || SLOT_BY_KIND[it.kind] !== s) return false;
    return have.has(id) || ((it.premium_only === true || it.premiumOnly === true) && premium);
  };
  const out = {};
  for (const s of Object.values(SLOT_BY_KIND)) {
    const id = s === slot ? itemId : equipped?.[s];
    out[s] = id && valid(s, id) ? id : null;
  }
  return out;
}

// ---------- Historial ----------
const REASON_ICONS = { daily: 'calendar', achievement: 'trophy', referral: 'userPlus', referred: 'heart', shop: 'tag', admin: 'shieldCheck', gift_in: 'sparkles', gift_out: 'heart' };

/** Normaliza una fila del historial de points_me para dibujarla. */
export function historyEntry(row) {
  const reason = REASON_ICONS[row?.reason] ? row.reason : 'admin';
  const at = Date.parse(row?.at);
  return { reason, icon: REASON_ICONS[reason], ref: String(row?.ref ?? ''), delta: Math.trunc(Number(row?.delta) || 0), at: Number.isFinite(at) ? at : null };
}

/** Texto genérico para un id sin traducción ("title_explorer" -> "Title explorer"). */
export function humanizeId(id) {
  const s = String(id || '').replace(/[_-]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}
