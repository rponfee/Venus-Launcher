// Traducción de una suscripción de Stripe a una fila de public.ai_subscriptions (ver 0009_billing.sql).
// La usan el webhook (cada evento vuelve a leer la suscripción de Stripe) y "billing" (GET ?sync=1), así el
// orden en que llegan los eventos no importa: siempre se guarda la foto actual de Stripe.
// Sin dependencias externas: se prueba con Node (node --test).
import { UUID_PATTERN } from './config.ts';

export type StoredStatus = 'active' | 'trialing' | 'canceled';

/** price_id de Stripe -> plan_id (public.billing_price_map(); incluye los precios inactivos). */
export type PriceMap = Readonly<Record<string, string>>;

export interface Logger {
  info?(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Id de un campo de Stripe que puede venir como texto o expandido como objeto. */
export function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  const o = obj(value);
  return o && typeof o.id === 'string' && o.id ? o.id : null;
}

function list(value: unknown): Obj[] {
  const data = obj(value)?.data;
  return Array.isArray(data) ? (data.map(obj).filter(Boolean) as Obj[]) : [];
}

export function isoFromUnix(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** uuid válido (en minúsculas) o null. */
export function asUserId(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/** metadata.user_id de un objeto de Stripe (lo pone billing al crear el checkout). */
export function userIdFromMetadata(value: unknown): string | null {
  return asUserId(obj(obj(value)?.metadata)?.user_id);
}

/** Suscripción a la que se refiere un evento del webhook, o null si no tiene. */
export function subscriptionIdFromEvent(event: unknown): string | null {
  const ev = obj(event);
  const type = typeof ev?.type === 'string' ? ev.type : '';
  const object = obj(obj(ev?.data)?.object);
  if (!object) return null;
  let id: string | null = null;
  if (type === 'checkout.session.completed') {
    id = object.mode === 'subscription' ? idOf(object.subscription) : null;
  } else if (type.startsWith('customer.subscription.')) {
    id = idOf(object.id);
  } else if (type.startsWith('invoice.')) {
    // Forma vieja (invoice.subscription) y la de 2025-03-31.basil en adelante (invoice.parent.subscription_details).
    id = idOf(object.subscription) ?? idOf(obj(obj(object.parent)?.subscription_details)?.subscription);
    if (!id) {
      for (const line of list(object.lines)) {
        id =
          idOf(line.subscription) ??
          idOf(obj(obj(line.parent)?.subscription_item_details)?.subscription) ??
          idOf(obj(obj(line.parent)?.subscription_details)?.subscription);
        if (id) break;
      }
    }
  }
  return id && /^sub_[A-Za-z0-9_]{1,250}$/.test(id) ? id : null;
}

/** Ítem de la suscripción cuyo precio corresponde a un plan conocido (el primero que encuentre). */
export function pickPlanItem(sub: unknown, prices: PriceMap): { item: Obj; priceId: string; planId: string } | null {
  for (const item of list(obj(sub)?.items)) {
    const priceId = idOf(item.price) ?? idOf(item.plan);
    if (priceId && Object.prototype.hasOwnProperty.call(prices, priceId)) return { item, priceId, planId: prices[priceId] };
  }
  return null;
}

/** Precios de todos los ítems (para los logs cuando ninguno es conocido). */
export function itemPriceIds(sub: unknown): string[] {
  return list(obj(sub)?.items)
    .map((item) => idOf(item.price) ?? idOf(item.plan))
    .filter((id): id is string => Boolean(id))
    .slice(0, 5);
}

/** Fin del período pago (segundos). Del ítem del plan (API nueva) o de la suscripción (API vieja). */
export function periodEnd(sub: unknown, item?: Obj | null): number | null {
  const s = obj(sub);
  const fromItem = num(item?.current_period_end);
  if (fromItem) return fromItem;
  const top = num(s?.current_period_end);
  if (top) return top;
  const ends = list(s?.items).map((i) => num(i.current_period_end)).filter((n): n is number => n !== null);
  return ends.length ? Math.max(...ends) : null;
}

/** Inicio del período actual (segundos). */
export function periodStart(sub: unknown, item?: Obj | null): number | null {
  const s = obj(sub);
  const fromItem = num(item?.current_period_start);
  if (fromItem) return fromItem;
  const top = num(s?.current_period_start);
  if (top) return top;
  const starts = list(s?.items).map((i) => num(i.current_period_start)).filter((n): n is number => n !== null);
  return starts.length ? Math.min(...starts) : null;
}

/**
 * Momento del pago fallido (segundos), fijo para todo el episodio: así los reintentos de Stripe no estiran la
 * gracia. Se toma de la última factura (cuándo se finalizó, que es cuando se intenta cobrar) o, si no vino
 * expandida, del inicio del período (la renovación). Sin ninguno de los dos, ahora.
 */
export function failureTime(sub: unknown, nowSec: number, item?: Obj | null): number {
  const invoice = obj(obj(sub)?.latest_invoice);
  if (invoice) {
    const finalized = num(obj(invoice.status_transitions)?.finalized_at);
    const created = num(invoice.created);
    const at = finalized ?? created;
    if (at) return Math.min(at, nowSec);
  }
  return periodStart(sub, item) ?? nowSec;
}

export interface Access {
  status: StoredStatus;
  /** Fin del período de Stripe (sin gracia). */
  periodEnd: number | null;
  /** Lo que se guarda en ai_subscriptions.current_period_end (con la gracia o la cancelación programada). */
  currentPeriodEnd: number | null;
  graceUntil: number | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * Estado de Stripe -> acceso:
 *   active / trialing -> igual, hasta el fin del período (o hasta cancel_at si es antes);
 *   past_due          -> 'active' hasta least(fin del período, falla + días de gracia), con grace_until;
 *   unpaid, canceled, incomplete, incomplete_expired, paused y cualquier otro -> 'canceled'.
 * cancel_at_period_end no corta nada: el acceso sigue hasta el fin del período.
 */
export function computeAccess(sub: unknown, options: { graceDays: number; nowSec: number; item?: Obj | null }): Access {
  const s = obj(sub) ?? {};
  const status = typeof s.status === 'string' ? s.status : '';
  const item = options.item ?? null;
  const end = periodEnd(s, item);
  const cancelAt = num(s.cancel_at);
  const cancelAtPeriodEnd = s.cancel_at_period_end === true || cancelAt !== null;
  const limitedEnd = cancelAt !== null && end !== null ? Math.min(end, cancelAt) : (end ?? cancelAt);

  if (status === 'active') {
    return { status: 'active', periodEnd: end, currentPeriodEnd: limitedEnd, graceUntil: null, cancelAtPeriodEnd };
  }
  if (status === 'trialing') {
    const trialEnd = num(s.trial_end);
    return { status: 'trialing', periodEnd: end ?? trialEnd, currentPeriodEnd: limitedEnd ?? trialEnd, graceUntil: null, cancelAtPeriodEnd };
  }
  if (status === 'past_due') {
    const grace = failureTime(s, options.nowSec, item) + Math.round(Math.max(0, options.graceDays) * 86400);
    const current = limitedEnd === null ? grace : Math.min(limitedEnd, grace);
    return { status: 'active', periodEnd: end, currentPeriodEnd: current, graceUntil: grace, cancelAtPeriodEnd };
  }
  return { status: 'canceled', periodEnd: end, currentPeriodEnd: num(s.ended_at) ?? limitedEnd, graceUntil: null, cancelAtPeriodEnd };
}

export interface Snapshot {
  subscriptionId: string;
  customerId: string;
  priceId: string;
  planId: string;
  stripeStatus: string;
  status: StoredStatus;
  periodEnd: string | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  cancelAtPeriodEnd: boolean;
  livemode: boolean;
  /** metadata.user_id de la suscripción (o null). */
  userId: string | null;
  createdAt: number;
}

export type SnapshotResult =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; reason: 'invalid' | 'unknown_price' | 'no_period_end'; subscriptionId: string | null; priceIds: string[] };

/** Foto de una suscripción de Stripe lista para guardar. */
export function snapshotFromSubscription(sub: unknown, prices: PriceMap, options: { graceDays: number; nowSec: number }): SnapshotResult {
  const s = obj(sub);
  const subscriptionId = idOf(s?.id);
  const customerId = idOf(s?.customer);
  const stripeStatus = typeof s?.status === 'string' ? s.status : '';
  if (!s || s.object !== 'subscription' || !subscriptionId?.startsWith('sub_') || !customerId?.startsWith('cus_') || !/^[a-z_]{1,40}$/.test(stripeStatus)) {
    return { ok: false, reason: 'invalid', subscriptionId, priceIds: [] };
  }
  const picked = pickPlanItem(s, prices);
  if (!picked) return { ok: false, reason: 'unknown_price', subscriptionId, priceIds: itemPriceIds(s) };
  const access = computeAccess(s, { ...options, item: picked.item });
  if (access.status !== 'canceled' && access.currentPeriodEnd === null) {
    return { ok: false, reason: 'no_period_end', subscriptionId, priceIds: [picked.priceId] };
  }
  return {
    ok: true,
    snapshot: {
      subscriptionId,
      customerId,
      priceId: picked.priceId,
      planId: picked.planId,
      stripeStatus,
      status: access.status,
      periodEnd: isoFromUnix(access.periodEnd),
      currentPeriodEnd: isoFromUnix(access.currentPeriodEnd),
      graceUntil: isoFromUnix(access.graceUntil),
      cancelAtPeriodEnd: access.cancelAtPeriodEnd,
      livemode: s.livemode === true,
      userId: userIdFromMetadata(s),
      createdAt: num(s.created) ?? 0,
    },
  };
}

/** Argumentos de public.billing_apply_subscription. */
export function applyArgs(snapshot: Snapshot, userId: string, syncedAt: Date): Record<string, unknown> {
  return {
    p_user: userId,
    p_plan: snapshot.planId,
    p_status: snapshot.status,
    p_current_period_end: snapshot.currentPeriodEnd,
    p_grace_until: snapshot.graceUntil,
    p_cancel_at_period_end: snapshot.cancelAtPeriodEnd,
    p_customer: snapshot.customerId,
    p_subscription: snapshot.subscriptionId,
    p_price: snapshot.priceId,
    p_stripe_status: snapshot.stripeStatus,
    p_synced_at: syncedAt.toISOString(),
    p_livemode: snapshot.livemode,
  };
}

const STATUS_RANK: Readonly<Record<string, number>> = { active: 0, trialing: 1, past_due: 2 };

/**
 * De las suscripciones de un cliente, la que manda: primero las vivas (active, trialing, past_due) y entre
 * iguales la más nueva. Solo cuentan las que tienen un precio de un plan conocido.
 */
export function chooseSubscription(subscriptions: unknown[], prices: PriceMap): Obj | null {
  const known = subscriptions.map(obj).filter((s): s is Obj => Boolean(s && pickPlanItem(s, prices)));
  known.sort((a, b) => {
    const ra = STATUS_RANK[String(a.status)] ?? 9;
    const rb = STATUS_RANK[String(b.status)] ?? 9;
    if (ra !== rb) return ra - rb;
    return (num(b.created) ?? 0) - (num(a.created) ?? 0);
  });
  return known[0] ?? null;
}

/** Carga el mapa de precios con una caché corta en memoria (por instancia de la función). */
export function createPriceMapLoader(
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  ttlMs: number,
  now: () => number = Date.now,
): (force?: boolean) => Promise<PriceMap> {
  let cache: PriceMap | null = null;
  let at = 0;
  return async (force = false) => {
    if (!force && cache && now() - at < ttlMs) return cache;
    const data = obj(await rpc('billing_price_map', {})) ?? {};
    const map: Record<string, string> = {};
    for (const [price, plan] of Object.entries(data)) if (typeof plan === 'string') map[price] = plan;
    cache = map;
    at = now();
    return cache;
  };
}

export interface ApplyContext {
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  priceMap(force?: boolean): Promise<PriceMap>;
  graceDays: number;
  nowMs: number;
  /** Cuándo se leyó la suscripción de Stripe (una lectura más vieja nunca pisa una más nueva). */
  syncedAt: Date;
  /** Usuario a usar si la suscripción no trae metadata.user_id ni el cliente está guardado. */
  fallbackUserId?: string | null;
  /** Si se indica, la suscripción tiene que ser de este usuario (sincronización pedida por él). */
  expectUserId?: string | null;
  logger: Logger;
  tag: string;
}

/**
 * Guarda una suscripción de Stripe en ai_subscriptions. Devuelve el resultado ('applied', 'stale',
 * 'other_active', 'unknown_price', 'no_user', 'unknown_user'...). Las fallas de la base se propagan (el
 * webhook responde 500 y Stripe reintenta).
 */
export async function applySubscription(sub: unknown, ctx: ApplyContext): Promise<string> {
  const options = { graceDays: ctx.graceDays, nowSec: Math.floor(ctx.nowMs / 1000) };
  let result = snapshotFromSubscription(sub, await ctx.priceMap(false), options);
  // Un precio desconocido puede ser uno recién cargado: se vuelve a leer el mapa una vez.
  if (!result.ok && result.reason === 'unknown_price') result = snapshotFromSubscription(sub, await ctx.priceMap(true), options);
  if (!result.ok) {
    const extra = result.reason === 'unknown_price' ? ` (precios: ${result.priceIds.join(', ') || 'ninguno'}; cargalos en ai_plan_prices)` : '';
    ctx.logger.warn(`[${ctx.tag}] suscripción ${result.subscriptionId ?? '?'} ignorada: ${result.reason}${extra}`);
    return result.reason;
  }
  const snap = result.snapshot;

  let userId = snap.userId;
  if (!userId) userId = asUserId(await ctx.rpc('billing_user_for_customer', { p_customer: snap.customerId }));
  if (!userId) userId = asUserId(ctx.fallbackUserId);
  if (!userId) {
    ctx.logger.warn(`[${ctx.tag}] suscripción ${snap.subscriptionId} sin usuario: falta metadata.user_id y el cliente ${snap.customerId} no está en stripe_customers`);
    return 'no_user';
  }
  if (ctx.expectUserId && userId !== ctx.expectUserId) return 'other_user';

  const out = obj(await ctx.rpc('billing_apply_subscription', applyArgs(snap, userId, ctx.syncedAt))) ?? {};
  if (out.applied === true) {
    if (out.switched === true) {
      ctx.logger.warn(`[${ctx.tag}] el usuario ${userId} tenía otra suscripción activa; ahora manda ${snap.subscriptionId} (revisá si tiene dos)`);
    }
    return 'applied';
  }
  const reason = typeof out.reason === 'string' && out.reason ? out.reason : 'not_applied';
  if (reason === 'unknown_user') ctx.logger.warn(`[${ctx.tag}] suscripción ${snap.subscriptionId}: el usuario ${userId} ya no existe`);
  return reason;
}
