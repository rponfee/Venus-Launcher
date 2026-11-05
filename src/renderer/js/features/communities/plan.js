// Planes de clan (Clanes Go, Pro, Max y Ultra), lógica pura sin DOM. El plan es de UNA comunidad y lo paga su dueño con el mismo
// camino de pago que los planes de IA (Mercado Pago o PayPal): cada pago da un período de 30 días que se renueva a mano, sin
// débito automático. Los límites salen de la tabla community_plans del servidor (0044_clanes_planes.sql), no de acá: las
// constantes de este archivo solo sirven de reemplazo cuando el servidor no responde. Guía: docs/wip/planes-clan-46.md.
export const PLAN_IDS = ['free', 'go', 'pro', 'max', 'ultra'];
export const PAID_PLANS = PLAN_IDS.filter((id) => id !== 'free');
export const LIMIT_KEYS = ['media', 'backdrops', 'stages', 'members', 'channels', 'roles'];
export const CLAN_PLAN_ID = /^clan_(go|pro|max|ultra)$/;
const SOON_DAYS = 7;
const DAY_MS = 86400000;

const int = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
};

/** Límites de un plan, siempre con todos los campos (lo que el servidor no mande vale 0 o falso). */
export function normalizeLimits(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    media: int(o.media), pending: int(o.pending), backdrops: int(o.backdrops), stages: int(o.stages), animated: o.animated === true,
    members: int(o.members), channels: int(o.channels), roles: int(o.roles), priority: o.priority === true,
  };
}

export function normalizePlan(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const id = PLAN_IDS.includes(o.id) ? o.id : 'free';
  const ends = typeof o.endsAt === 'string' && Number.isFinite(Date.parse(o.endsAt)) ? o.endsAt : null;
  return {
    id,
    name: typeof o.name === 'string' && o.name ? o.name.slice(0, 30) : id,
    rank: PLAN_IDS.indexOf(id),
    priceUsd: Number.isFinite(Number(o.priceUsd)) ? Number(o.priceUsd) : 0,
    periodDays: int(o.periodDays, 30) || 30,
    endsAt: id === 'free' ? null : ends,
    limits: normalizeLimits(o.limits),
  };
}

/** Lo que devuelve community_plan_get, o null si no es una respuesta con forma de plan. */
export function normalizePlanState(raw) {
  if (!raw || typeof raw !== 'object' || !raw.plan || typeof raw.plan !== 'object') return null;
  const u = raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
  return {
    plan: normalizePlan(raw.plan),
    isOwner: raw.isOwner === true,
    usage: { media: int(u.media), pending: int(u.pending), backdrops: int(u.backdrops), stages: int(u.stages), members: int(u.members), channels: int(u.channels), roles: int(u.roles) },
    hiddenMedia: int(raw.hiddenMedia),
    periods: (Array.isArray(raw.periods) ? raw.periods : []).filter((p) => p && PAID_PLANS.includes(p.plan)).map((p) => ({ plan: p.plan, startsAt: p.startsAt, endsAt: p.endsAt, current: p.current === true })),
    plans: (Array.isArray(raw.plans) ? raw.plans : []).filter((p) => p && PLAN_IDS.includes(p.id)).map((p) => normalizePlan(p)).sort((a, b) => a.rank - b.rank),
  };
}

/** Días que le quedan al plan (redondeado hacia arriba); null si no vence (gratis). */
export function daysLeft(endsAt, now = Date.now()) {
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - now) / DAY_MS));
}

/** 'free' | 'active' | 'soon' (vence en una semana o menos). */
export function planStatus(state, now = Date.now()) {
  if (!state || state.plan.id === 'free') return 'free';
  const days = daysLeft(state.plan.endsAt, now);
  return days !== null && days <= SOON_DAYS ? 'soon' : 'active';
}

/** Filas "12 de 50" para mostrar el uso. Un cupo de 0 es "no incluido". */
export function usageRows(state) {
  if (!state) return [];
  return LIMIT_KEYS.map((key) => {
    const used = state.usage[key] ?? 0;
    const max = state.plan.limits[key] ?? 0;
    return { key, used, max, included: max > 0, full: max > 0 && used >= max, pct: max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0 };
  });
}

/** ¿Queda lugar para sumar uno más de eso? */
export const hasRoom = (state, key) => !state || (state.plan.limits[key] ?? 0) > (state.usage[key] ?? 0);

/**
 * Los planes que se pueden comprar, de menor a mayor, con su precio en cada medio de pago. catalog es lo que devuelve billing:catalog
 * (clans); el servidor manda el precio final (impuestos incluidos) en pesos y en dólares.
 */
export function offers(catalog, state) {
  const current = state?.plan.rank ?? 0;
  return (Array.isArray(catalog?.clans) ? catalog.clans : [])
    .filter((c) => c && CLAN_PLAN_ID.test(String(c.id)))
    .map((c) => ({
      id: c.id,
      tier: c.tier,
      name: c.name,
      priceUsd: c.priceUsd,
      periodDays: c.periodDays || 30,
      limits: normalizeLimits(c.limits),
      prices: { mercado_pago: c.prices?.mercado_pago || null, paypal: c.prices?.paypal || null },
      rank: PLAN_IDS.indexOf(c.tier),
      current: PLAN_IDS.indexOf(c.tier) === current,
      lower: PLAN_IDS.indexOf(c.tier) < current,
    }))
    .sort((a, b) => a.rank - b.rank);
}

/** Lo que recibe el diálogo de pago de plans.js para un plan de clan de esa comunidad. */
export const checkoutPlan = (offer, communityId, { onPaid } = {}) => ({
  id: offer.id, name: offer.name, price: offer.priceUsd, prices: offer.prices, clan: true, communityId, limits: offer.limits, periodDays: offer.periodDays, onPaid,
});

/** Texto corto del botón: comprar el primero, renovar el mismo y "esperar" el menor (empieza cuando terminan los mayores). */
export const buyKind = (offer) => (offer.current ? 'renew' : offer.lower ? 'queue' : 'buy');

/** Mejor medio de pago para mostrar el precio principal: pesos si hay, si no dólares. */
export const mainPrice = (offer) => offer.prices.mercado_pago || offer.prices.paypal || null;

/** El estado del plan que se calcula cuando el pedido de pago termina bien (modo de ejemplo y pruebas). */
export function afterPayment(state, offer, now = Date.now()) {
  if (!state) return state;
  const base = Math.max(now, Date.parse(state.plan.endsAt) || 0);
  const higher = !offer.lower;
  const plan = higher ? { ...state.plan, id: offer.tier, name: offer.name.replace(/^Clanes /, ''), rank: offer.rank, limits: { ...state.plan.limits, ...offer.limits }, priceUsd: offer.priceUsd } : state.plan;
  return { ...state, plan: { ...plan, endsAt: new Date(base + offer.periodDays * DAY_MS).toISOString() } };
}
