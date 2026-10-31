// Cupones y códigos de promoción de Stripe para los planes de Venus IA.
//   - Cupón: el descuento (porcentaje o monto fijo en USD), cuánto dura (una vez, N meses o para siempre),
//     a qué planes se aplica, cuántas veces se puede usar y hasta cuándo.
//   - Código de promoción: el texto que escribe el usuario en el checkout de Stripe (por ejemplo VENUS20), con
//     vencimiento, "solo primera compra" y usos máximos propios. El checkout ya acepta códigos
//     (allow_promotion_codes en supabase/functions/billing/handler.ts).
// Validación, pedidos exactos a Stripe y la forma que recibe el panel. Sin dependencias externas.
import { badRequest } from './errors.ts';
import { PLAN_ID_PATTERN, int, obj, optIsoDate, optText } from './validate.ts';
import { idPath, StripeError } from './stripe-admin.ts';
import type { AdminStripe, FormParams } from './stripe-admin.ts';

type Obj = Record<string, unknown>;

export type CouponDuration = 'once' | 'repeating' | 'forever';

export interface PromoInput {
  code: string;
  expiresAt: Date | null;
  firstTimeOnly: boolean;
  maxRedemptions: number | null;
}

export interface CouponInput {
  name: string | null;
  percentOff: number | null;
  /** Centavos de dólar. */
  amountOff: number | null;
  duration: CouponDuration;
  durationInMonths: number | null;
  /** Ids de plan (ai_plans.id); vacío = todos los productos. */
  appliesTo: string[];
  maxRedemptions: number | null;
  redeemBy: Date | null;
  promo: PromoInput | null;
}

export const COUPON_LIMITS = {
  nameMax: 40,
  amountOffMax: 100_000, // US$ 1.000
  monthsMax: 36,
  redemptionsMax: 1_000_000,
  /** Vencimiento máximo de un cupón o un código. */
  futureMaxMs: 5 * 365 * 24 * 3600 * 1000,
};

/** Texto del código: letras y números (Stripe no acepta otros caracteres), de 3 a 40, en mayúsculas. */
export const PROMO_CODE_PATTERN = /^[A-Z0-9]{3,40}$/;
const PRODUCT_PREFIX = 'venus_ai_';

/** Producto de Stripe de un plan (el que crea scripts/stripe-setup.js). */
export function productForPlan(plan: string): string {
  return `${PRODUCT_PREFIX}${plan}`;
}

/** Plan de un producto de Stripe (o null si no es de Venus IA). */
export function planForProduct(product: unknown): string | null {
  if (typeof product !== 'string' || !product.startsWith(PRODUCT_PREFIX)) return null;
  const plan = product.slice(PRODUCT_PREFIX.length);
  return PLAN_ID_PATTERN.test(plan) ? plan : null;
}

function optCount(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  return int(value, 1, COUPON_LIMITS.redemptionsMax, field);
}

/** Código de promoción del panel (sin el cupón). redeemBy: vencimiento del cupón, si tiene. */
export function validatePromo(raw: unknown, nowMs: number, opts: { redeemBy?: Date | null; prefix?: string } = {}): PromoInput {
  const o = obj(raw);
  const f = (name: string) => `${opts.prefix ?? ''}${name}`;
  if (!o) throw badRequest('Faltan los datos del código.', f('code'));
  const code = typeof o.code === 'string' ? o.code.trim().toUpperCase() : '';
  if (!PROMO_CODE_PATTERN.test(code)) throw badRequest('El código va de 3 a 40 letras o números, sin espacios ni símbolos.', f('code'));
  const expiresAt = optIsoDate(o.expiresAt, f('expiresAt'), { future: true, maxMs: COUPON_LIMITS.futureMaxMs, nowMs });
  if (expiresAt && opts.redeemBy && expiresAt.getTime() > opts.redeemBy.getTime()) {
    throw badRequest('El código no puede vencer después que el cupón.', f('expiresAt'));
  }
  if (o.firstTimeOnly !== undefined && typeof o.firstTimeOnly !== 'boolean') throw badRequest('Tiene que ser verdadero o falso.', f('firstTimeOnly'));
  return {
    code,
    expiresAt,
    firstTimeOnly: o.firstTimeOnly === true,
    maxRedemptions: optCount(o.maxRedemptions, f('maxRedemptions')),
  };
}

/** Cupón del panel: exactamente uno de percentOff (0 a 100, hasta 2 decimales) o amountOff (centavos de USD). */
export function validateCoupon(raw: unknown, nowMs: number): CouponInput {
  const o = obj(raw);
  if (!o) throw badRequest('Faltan los datos del cupón.', 'coupon');
  const hasPercent = o.percentOff !== undefined && o.percentOff !== null && o.percentOff !== '';
  const hasAmount = o.amountOff !== undefined && o.amountOff !== null && o.amountOff !== '';
  if (hasPercent === hasAmount) throw badRequest('Elegí un porcentaje o un monto fijo (uno de los dos).', hasPercent ? 'amountOff' : 'percentOff');

  let percentOff: number | null = null;
  let amountOff: number | null = null;
  if (hasPercent) {
    const v = o.percentOff;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100) throw badRequest('El porcentaje va de más de 0 a 100.', 'percentOff');
    if (Math.abs(Math.round(v * 100) - v * 100) > 1e-6) throw badRequest('Como máximo 2 decimales.', 'percentOff');
    percentOff = Math.round(v * 100) / 100;
  } else {
    amountOff = int(o.amountOff, 1, COUPON_LIMITS.amountOffMax, 'amountOff');
  }

  const duration = o.duration;
  if (duration !== 'once' && duration !== 'repeating' && duration !== 'forever') throw badRequest('Duración inválida.', 'duration');
  let durationInMonths: number | null = null;
  if (duration === 'repeating') durationInMonths = int(o.durationInMonths, 1, COUPON_LIMITS.monthsMax, 'durationInMonths');
  else if (o.durationInMonths !== undefined && o.durationInMonths !== null && o.durationInMonths !== '') {
    throw badRequest('Los meses solo van con la duración "por meses".', 'durationInMonths');
  }

  let appliesTo: string[] = [];
  if (o.appliesTo !== undefined && o.appliesTo !== null) {
    if (!Array.isArray(o.appliesTo) || o.appliesTo.length > 20) throw badRequest('Lista de planes inválida.', 'appliesTo');
    const set = new Set<string>();
    for (const p of o.appliesTo) {
      if (typeof p !== 'string' || !PLAN_ID_PATTERN.test(p)) throw badRequest('Plan inválido.', 'appliesTo');
      set.add(p);
    }
    appliesTo = [...set];
  }

  const redeemBy = optIsoDate(o.redeemBy, 'redeemBy', { future: true, maxMs: COUPON_LIMITS.futureMaxMs, nowMs });
  return {
    name: optText(o.name, COUPON_LIMITS.nameMax, 'name'),
    percentOff,
    amountOff,
    duration,
    durationInMonths,
    appliesTo,
    maxRedemptions: optCount(o.maxRedemptions, 'maxRedemptions'),
    redeemBy,
    promo: o.promo === undefined || o.promo === null ? null : validatePromo(o.promo, nowMs, { redeemBy, prefix: 'promo.' }),
  };
}

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** POST /v1/coupons. products: los productos de Stripe de los planes elegidos (vacío = todos). */
export function couponParams(input: CouponInput, products: string[]): FormParams {
  const params: FormParams = {
    duration: input.duration,
    metadata: { app: 'venus-launcher' },
  };
  if (input.percentOff !== null) params.percent_off = input.percentOff;
  else {
    params.amount_off = input.amountOff;
    params.currency = 'usd';
  }
  if (input.duration === 'repeating') params.duration_in_months = input.durationInMonths;
  if (input.name) params.name = input.name;
  if (input.maxRedemptions !== null) params.max_redemptions = input.maxRedemptions;
  if (input.redeemBy) params.redeem_by = unix(input.redeemBy);
  if (products.length) params.applies_to = { products };
  return params;
}

/** POST /v1/promotion_codes (API 2025-03-31.basil: el cupón va en "coupon"). */
export function promoParams(couponId: string, promo: PromoInput): FormParams {
  const params: FormParams = {
    coupon: couponId,
    code: promo.code,
    metadata: { app: 'venus-launcher' },
  };
  if (promo.expiresAt) params.expires_at = unix(promo.expiresAt);
  if (promo.maxRedemptions !== null) params.max_redemptions = promo.maxRedemptions;
  if (promo.firstTimeOnly) params.restrictions = { first_time_transaction: true };
  return params;
}

// ---------- Lo que ve el panel (sin datos de clientes) ----------

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (sec: unknown) => (typeof sec === 'number' && Number.isFinite(sec) ? new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);

function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  const o = obj(value);
  return o && typeof o.id === 'string' && o.id ? o.id : null;
}

export interface PromoView {
  id: string;
  code: string;
  active: boolean;
  couponId: string | null;
  expiresAt: string | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  firstTimeOnly: boolean;
  /** Restringido a un cliente puntual (no se muestra cuál). */
  restricted: boolean;
  createdAt: string | null;
}

export interface CouponView {
  id: string;
  name: string | null;
  percentOff: number | null;
  amountOff: number | null;
  currency: string | null;
  duration: string;
  durationInMonths: number | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  redeemBy: string | null;
  valid: boolean;
  createdAt: string | null;
  appliesTo: { products: string[]; plans: string[] } | null;
  /** Lo creó el panel (metadata.app = venus-launcher). */
  venus: boolean;
  promotionCodes: PromoView[];
}

export function promoView(raw: unknown): PromoView | null {
  const p = obj(raw);
  const id = str(p?.id);
  if (!p || !id) return null;
  const restrictions = obj(p.restrictions) ?? {};
  return {
    id,
    code: str(p.code) ?? '',
    active: p.active === true,
    couponId: idOf(p.coupon) ?? idOf(obj(p.promotion)?.coupon),
    expiresAt: iso(p.expires_at),
    maxRedemptions: num(p.max_redemptions),
    timesRedeemed: num(p.times_redeemed) ?? 0,
    firstTimeOnly: restrictions.first_time_transaction === true,
    restricted: Boolean(p.customer),
    createdAt: iso(p.created),
  };
}

export function couponView(raw: unknown, promos: PromoView[] = []): CouponView | null {
  const c = obj(raw);
  const id = str(c?.id);
  if (!c || !id) return null;
  const products = Array.isArray(obj(c.applies_to)?.products) ? (obj(c.applies_to)!.products as unknown[]).filter((x): x is string => typeof x === 'string') : null;
  return {
    id,
    name: str(c.name),
    percentOff: num(c.percent_off),
    amountOff: num(c.amount_off),
    currency: str(c.currency),
    duration: str(c.duration) ?? 'once',
    durationInMonths: num(c.duration_in_months),
    maxRedemptions: num(c.max_redemptions),
    timesRedeemed: num(c.times_redeemed) ?? 0,
    redeemBy: iso(c.redeem_by),
    valid: c.valid !== false,
    createdAt: iso(c.created),
    appliesTo: products ? { products, plans: products.map(planForProduct).filter((x): x is string => Boolean(x)) } : null,
    venus: obj(c.metadata)?.app === 'venus-launcher',
    promotionCodes: promos.filter((p) => p.couponId === id),
  };
}

/** Resumen corto para el registro: { kind, value, duration, months }. */
export function couponSummary(input: Pick<CouponInput, 'percentOff' | 'amountOff' | 'duration' | 'durationInMonths'>): Obj {
  return input.percentOff !== null
    ? { kind: 'percent', value: input.percentOff, duration: input.duration, months: input.durationInMonths }
    : { kind: 'amount', value: input.amountOff, currency: 'usd', duration: input.duration, months: input.durationInMonths };
}

// ---------- Operaciones ----------

/** Cupones y códigos (los 100 más nuevos de cada uno). */
export async function listCoupons(stripe: AdminStripe): Promise<{ coupons: CouponView[]; hasMore: boolean }> {
  const [coupons, promos] = await Promise.all([
    stripe.get<Obj>('/v1/coupons', { limit: 100, expand: ['data.applies_to'] }),
    stripe.get<Obj>('/v1/promotion_codes', { limit: 100 }),
  ]);
  const promoList = (Array.isArray(promos.data) ? promos.data : []).map(promoView).filter((p): p is PromoView => Boolean(p));
  const list = (Array.isArray(coupons.data) ? coupons.data : []).map((c) => couponView(c, promoList)).filter((c): c is CouponView => Boolean(c));
  list.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return { coupons: list, hasMore: coupons.has_more === true || promos.has_more === true };
}

/** Crea el cupón y su código. Si el código falla (por ejemplo, ya existe), borra el cupón recién creado. */
export async function createCoupon(stripe: AdminStripe, input: CouponInput, products: string[]): Promise<{ coupon: CouponView; promotionCode: PromoView | null; rolledBack?: boolean }> {
  const created = await stripe.post<Obj>('/v1/coupons', couponParams(input, products));
  const couponId = str(created.id);
  if (!couponId) throw new StripeError(502, 'invalid_response', null, null, null);
  let promo: PromoView | null = null;
  if (input.promo) {
    try {
      promo = promoView(await stripe.post<Obj>('/v1/promotion_codes', promoParams(couponId, input.promo)));
    } catch (err) {
      try {
        await stripe.del(idPath('/v1/coupons/', couponId));
      } catch {
        /* queda un cupón sin código: se puede borrar desde el panel */
      }
      throw err;
    }
  }
  return { coupon: couponView(created, promo ? [promo] : []) as CouponView, promotionCode: promo };
}

export async function addPromotionCode(stripe: AdminStripe, couponId: string, promo: PromoInput): Promise<PromoView> {
  return promoView(await stripe.post<Obj>('/v1/promotion_codes', promoParams(couponId, promo))) as PromoView;
}

export async function setPromotionCodeActive(stripe: AdminStripe, promoId: string, active: boolean): Promise<PromoView> {
  return promoView(await stripe.post<Obj>(idPath('/v1/promotion_codes/', promoId), { active })) as PromoView;
}

/** Borra el cupón: sus códigos dejan de funcionar; las suscripciones que ya lo usan conservan el descuento. */
export async function deleteCoupon(stripe: AdminStripe, couponId: string): Promise<void> {
  await stripe.del(idPath('/v1/coupons/', couponId));
}

/** Id de cupón o de código que manda el panel. */
export function stripeObjectId(value: unknown, field: string, prefix?: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value) || (prefix && !value.startsWith(prefix))) throw badRequest('Id inválido.', field);
  return value;
}
