// Cambio del precio mensual de un plan. Los precios de Stripe no se pueden editar, así que:
//   1. se crea un precio nuevo en el mismo producto (se lleva el lookup_key venus_ai_<plan>_monthly);
//   2. se carga en ai_plan_prices con billing_upsert_price (0009), que deja inactivo el anterior en la base;
//   3. el precio anterior queda inactivo en Stripe (ya no se vende) y el nuevo pasa a ser el del producto;
//   4. el portal de facturación ofrece el precio nuevo para cambiar de plan;
//   5. ai_plans.price_usd (informativo) se actualiza.
// Los suscriptores actuales SIGUEN pagando el precio anterior hasta que se los cambie desde Stripe (las filas
// inactivas de ai_plan_prices siguen reconociendo sus suscripciones). Ver docs/admin.md.
import { AdminError, badRequest } from './errors.ts';
import { obj } from './validate.ts';
import { idPath, StripeError } from './stripe-admin.ts';
import type { AdminStripe, FormParams } from './stripe-admin.ts';
import { productForPlan } from './coupons.ts';

type Obj = Record<string, unknown>;

export interface Logger {
  info?(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PlanPrice {
  priceId: string;
  amount: number;
  currency: string;
  livemode: boolean;
  active: boolean;
}

export interface PlanInfo {
  id: string;
  name: string;
  priceUsd: number | null;
  prices: PlanPrice[];
}

export interface PriceChangeDeps {
  stripe: AdminStripe;
  livemode: boolean;
  /** BILLING_PORTAL_CONFIGURATION (bpc_...) o null: se busca la que creó scripts/stripe-setup.js (metadata venus = ai). */
  portalConfiguration: string | null;
  db(name: string, args: Record<string, unknown>): Promise<unknown>;
  logger: Logger;
  nowMs: number;
}

export type PortalOutcome = 'updated' | 'not_found' | 'failed';

export interface PriceChangeResult {
  planId: string;
  priceId: string;
  previousPriceId: string | null;
  amount: number;
  previousAmount: number | null;
  livemode: boolean;
  product: string;
  portal: PortalOutcome;
  warnings: string[];
}

/** Monto nuevo en centavos: de US$ 0,50 a US$ 1.000. */
export const PRICE_LIMITS = { min: 50, max: 100_000 };

export const lookupKeyFor = (plan: string) => `venus_ai_${plan}_monthly`;

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  const o = obj(value);
  return o && typeof o.id === 'string' && o.id ? o.id : null;
}

/** Plan de admin_plan_json -> lo que usa el cambio de precio. */
export function planInfo(raw: unknown): PlanInfo | null {
  const p = obj(raw);
  if (!p || typeof p.id !== 'string') return null;
  const prices: PlanPrice[] = [];
  for (const item of Array.isArray(p.prices) ? p.prices : []) {
    const x = obj(item);
    if (!x || typeof x.priceId !== 'string' || typeof x.amount !== 'number') continue;
    prices.push({ priceId: x.priceId, amount: x.amount, currency: str(x.currency) ?? 'usd', livemode: x.livemode === true, active: x.active === true });
  }
  return { id: p.id, name: str(p.name) ?? p.id, priceUsd: typeof p.priceUsd === 'number' ? p.priceUsd : null, prices };
}

/** POST /v1/prices del precio nuevo (como scripts/stripe-setup.js). */
export function priceParams(input: {
  product: string;
  planId: string;
  planName: string;
  amount: number;
  transferLookupKey: boolean;
  taxBehavior: string | null;
}): FormParams {
  return {
    product: input.product,
    currency: 'usd',
    unit_amount: input.amount,
    recurring: { interval: 'month', interval_count: 1 },
    lookup_key: lookupKeyFor(input.planId),
    transfer_lookup_key: input.transferLookupKey ? true : undefined,
    nickname: `Venus IA ${input.planName} mensual`,
    metadata: { venus_plan: input.planId, app: 'venus-launcher' },
    tax_behavior: input.taxBehavior ?? undefined,
  };
}

/**
 * Productos y precios del portal con el precio nuevo para `product` (reemplaza los anteriores de ese producto,
 * que quedan inactivos; los demás planes no cambian). Si el producto no estaba, se agrega.
 */
export function portalProducts(config: Obj, product: string, newPrice: string): { product: string; prices: string[] }[] {
  const features = obj(config.features);
  const update = obj(features?.subscription_update);
  const list = Array.isArray(update?.products) ? update!.products as unknown[] : [];
  const out: { product: string; prices: string[] }[] = [];
  let found = false;
  for (const raw of list) {
    const p = obj(raw);
    const id = idOf(p?.product);
    if (!p || !id) continue;
    if (id === product) {
      found = true;
      out.push({ product: id, prices: [newPrice] });
      continue;
    }
    const prices = (Array.isArray(p.prices) ? p.prices : []).map(idOf).filter((x): x is string => Boolean(x));
    if (prices.length) out.push({ product: id, prices });
  }
  if (!found) out.push({ product, prices: [newPrice] });
  return out;
}

async function findPortal(deps: PriceChangeDeps): Promise<Obj | null> {
  if (deps.portalConfiguration) {
    try {
      return await deps.stripe.get<Obj>(idPath('/v1/billing_portal/configurations/', deps.portalConfiguration));
    } catch (err) {
      if (err instanceof StripeError && err.missing) return null;
      throw err;
    }
  }
  const listed = await deps.stripe.get<Obj>('/v1/billing_portal/configurations', { active: true, limit: 100 });
  const data = Array.isArray(listed.data) ? listed.data : [];
  return (data.map(obj).find((c) => c && c.active !== false && obj(c.metadata)?.venus === 'ai') as Obj | undefined) ?? null;
}

async function updatePortal(deps: PriceChangeDeps, product: string, newPrice: string): Promise<PortalOutcome> {
  try {
    const config = await findPortal(deps);
    const id = idOf(config?.id);
    if (!config || !id) return 'not_found';
    await deps.stripe.post(idPath('/v1/billing_portal/configurations/', id), {
      features: { subscription_update: { products: portalProducts(config, product, newPrice) } },
    });
    return 'updated';
  } catch (err) {
    deps.logger.warn(`[admin] no se pudo actualizar el portal: ${err instanceof StripeError ? err.describe() : 'error'}`);
    return 'failed';
  }
}

/** Cambia el precio de un plan (ver el comentario del archivo). amount en centavos de USD. */
export async function changePlanPrice(deps: PriceChangeDeps, plan: PlanInfo, amount: number): Promise<PriceChangeResult> {
  if (!Number.isInteger(amount) || amount < PRICE_LIMITS.min || amount > PRICE_LIMITS.max) {
    throw badRequest(`El precio va de ${PRICE_LIMITS.min} a ${PRICE_LIMITS.max} centavos de dólar.`, 'amount');
  }
  const current = plan.prices.find((p) => p.active && p.livemode === deps.livemode) ?? null;
  if (current && current.amount === amount) throw new AdminError('conflict', 409, 'El plan ya tiene ese precio.', { reason: 'same_price' });

  // Producto: el del precio vigente; sin precio en este modo, el que crea scripts/stripe-setup.js.
  let product: string | null = null;
  let taxBehavior: string | null = null;
  if (current) {
    const old = await deps.stripe.get<Obj>(idPath('/v1/prices/', current.priceId));
    product = idOf(old.product);
    const tb = str(old.tax_behavior);
    taxBehavior = tb && tb !== 'unspecified' ? tb : null;
  }
  if (!product) {
    product = productForPlan(plan.id);
    try {
      await deps.stripe.get<Obj>(idPath('/v1/products/', product));
    } catch (err) {
      if (err instanceof StripeError && err.missing) {
        throw new AdminError('not_found', 404, `No existe el producto ${product} en Stripe: corré scripts/stripe-setup.js primero.`, { reason: 'no_product' });
      }
      throw err;
    }
  }

  const created = await deps.stripe.post<Obj>(
    '/v1/prices',
    priceParams({ product, planId: plan.id, planName: plan.name, amount, transferLookupKey: Boolean(current), taxBehavior }),
    // Dos clics (o un reintento en la misma hora) no crean dos precios: Stripe devuelve el mismo.
    { idempotencyKey: `venus-admin-price-${plan.id}-${amount}-${current?.priceId ?? 'none'}-${Math.floor(deps.nowMs / 3600000)}` },
  );
  const priceId = idOf(created.id);
  if (!priceId || !priceId.startsWith('price_')) throw new StripeError(502, 'invalid_response', null, null, null);
  // Si Stripe devolvió un precio que ya se había dejado de vender (ida y vuelta en la misma hora), se reactiva.
  if (plan.prices.some((p) => p.priceId === priceId && !p.active)) {
    await deps.stripe.post(idPath('/v1/prices/', priceId), { active: true });
  }

  try {
    await deps.db('billing_upsert_price', {
      p_plan: plan.id,
      p_price: priceId,
      p_lookup_key: lookupKeyFor(plan.id),
      p_currency: 'usd',
      p_amount: amount,
      p_interval: 'month',
      p_livemode: deps.livemode,
    });
  } catch (err) {
    deps.logger.error(`[admin] el precio ${priceId} se creó en Stripe pero no se guardó en la base`);
    throw new AdminError('db_unavailable', 503, 'Se creó el precio en Stripe pero no se pudo guardar en la base. Volvé a intentarlo (no se duplica).', {
      reason: 'price_not_saved',
      priceId,
    });
  }

  const warnings: string[] = [];
  if (current) {
    try {
      await deps.stripe.post(idPath('/v1/prices/', current.priceId), { active: false });
    } catch {
      warnings.push('old_price_still_active');
    }
  }
  try {
    await deps.stripe.post(idPath('/v1/products/', product), { default_price: priceId });
  } catch {
    warnings.push('default_price_not_set');
  }
  const portal = await updatePortal(deps, product, priceId);
  if (portal !== 'updated') warnings.push(portal === 'not_found' ? 'portal_not_found' : 'portal_not_updated');
  try {
    await deps.db('admin_update_plan', { p_plan: plan.id, p_patch: { price_usd: amount / 100 } });
  } catch {
    warnings.push('price_usd_not_updated');
  }

  return {
    planId: plan.id,
    priceId,
    previousPriceId: current?.priceId ?? null,
    amount,
    previousAmount: current?.amount ?? null,
    livemode: deps.livemode,
    product,
    portal,
    warnings,
  };
}
