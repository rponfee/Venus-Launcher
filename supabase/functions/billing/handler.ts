// Flujo HTTP de la Edge Function "billing": pagos de Venus IA con Stripe (ver docs/pagos.md).
//   GET                         -> { state, catalog, mode, synced } (estado del plan y precios a la venta)
//   GET ?sync=1                 -> igual, pero antes vuelve a leer de Stripe las suscripciones del usuario
//   GET ?return=success|cancel|portal -> página de vuelta en texto plano (sin sesión)
//   POST { action: 'checkout', plan, locale? } -> { kind: 'checkout', url, sessionId, expiresAt, reused? }
//                                                 o { kind: 'portal', url, reason: 'already_subscribed' }
//        (un solo checkout abierto por cliente: el del mismo plan se reutiliza y los de otros planes se vencen)
//   POST { action: 'portal', locale? }         -> { kind: 'portal', url }
//        (un pedido a Stripe por usuario cada 3 s: si no, 429 busy)
// Errores: { error, message, code? } con estados 400, 401, 403, 409, 429, 502 y 503.
// No importa nada de npm ni de Deno: index.ts le pasa Supabase y el cliente de Stripe; las pruebas, dobles.
import { CORS_HEADERS, LIMITS, OPEN_SUBSCRIPTION_STATUSES, PLAN_ID_PATTERN, returnPage, stripeLocale } from './config.ts';
import type { ReturnUrls } from './config.ts';
import { bearerToken, decodeUtf8, errorCode, errorName, json, readBodyBytes } from './http.ts';
import { StripeError, stripePath } from './stripe.ts';
import type { FormParams, StripeClient } from './stripe.ts';
import { applySubscription, chooseSubscription, createPriceMapLoader, idOf, isoFromUnix, pickPlanItem } from './sync.ts';
import type { Logger, PriceMap } from './sync.ts';

const TAG = 'billing';

/** Mínimo entre dos pedidos de checkout o portal de un mismo usuario (cada uno hace de 1 a 5 llamadas a Stripe). */
const POST_INTERVAL_MS = 3000;

export type AuthResult =
  | { status: 'ok'; userId: string; email: string | null }
  | { status: 'invalid' }
  | { status: 'forbidden'; reason: 'anonymous' }
  | { status: 'unavailable' };

export interface BillingDeps {
  /** Están SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY. */
  supabaseReady: boolean;
  /** Cliente de Stripe (null si falta STRIPE_SECRET_KEY): sin él, GET responde igual pero no hay checkout. */
  stripe: StripeClient | null;
  /** Modo de la clave de Stripe (true = producción). */
  livemode: boolean;
  /** Adónde vuelve el navegador (config.ts, buildReturnUrls). */
  returnUrls: ReturnUrls | null;
  /** BILLING_AUTOMATIC_TAX=1: impuestos automáticos de Stripe Tax en el checkout. */
  automaticTax: boolean;
  /** BILLING_PORTAL_CONFIGURATION (bpc_...); si falta se busca la que creó scripts/stripe-setup.js. */
  portalConfiguration: string | null;
  graceDays: number;
  verifyUser(token: string): Promise<AuthResult>;
  /** Llama a una función SQL con la service role. Si falla lanza un error con `code`. */
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  priceMap?: (force?: boolean) => Promise<PriceMap>;
  nowMs?: () => number;
  logger?: Logger;
}

export const MESSAGES = {
  unauthorized: 'Tu sesión de Venus venció. Volvé a iniciar sesión.',
  anonymous: 'Iniciá sesión con una cuenta de Venus para elegir un plan.',
  authUnavailable: 'No se pudo verificar tu sesión. Probá de nuevo en un rato.',
  notConfigured: 'Los pagos todavía no están configurados en el servidor de Venus.',
  backendNotReady: 'Al servidor de Venus le falta la migración de pagos (0009_billing.sql).',
  dbUnavailable: 'No se pudo consultar tu plan. Probá de nuevo en un rato.',
  unknownPlan: 'Ese plan no existe o no está a la venta.',
  noCustomer: 'Todavía no tenés una suscripción para administrar: elegí un plan primero.',
  stripe: 'No se pudo hablar con Stripe. Probá de nuevo en un rato.',
  badMethod: 'Método no permitido (usá GET o POST).',
  badJson: 'El pedido tiene que ser JSON (Content-Type: application/json).',
  badBody: 'El cuerpo del pedido no es JSON válido.',
  badAction: 'Acción desconocida: usá "checkout" o "portal".',
  busy: 'Estás haciendo demasiados pedidos seguidos. Esperá unos segundos y probá de nuevo.',
  internal: 'Error interno del servidor de pagos.',
} as const;

const DB_NOT_READY = new Set(['PGRST202', 'PGRST205', '42883', '42P01']);

type Obj = Record<string, unknown>;
type User = { userId: string; email: string | null };

function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

/** Falla de la base con el código ya traducido a una respuesta. */
class DbError extends Error {
  code: string;
  constructor(code: string) {
    super(`falla de la base: ${code}`);
    this.name = 'DbError';
    this.code = code;
  }
}

/** El cuerpo de un checkout: un precio, un cliente y los metadatos que usa el webhook para encontrar al usuario. */
export function checkoutParams(input: {
  customerId: string;
  userId: string;
  planId: string;
  priceId: string;
  urls: ReturnUrls;
  locale: string;
  automaticTax: boolean;
}): FormParams {
  const params: FormParams = {
    mode: 'subscription',
    customer: input.customerId,
    client_reference_id: input.userId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    subscription_data: { metadata: { user_id: input.userId, plan_id: input.planId } },
    metadata: { user_id: input.userId, plan_id: input.planId },
    allow_promotion_codes: true,
    success_url: input.urls.success,
    cancel_url: input.urls.cancel,
    locale: input.locale,
  };
  if (input.automaticTax) {
    params.automatic_tax = { enabled: true };
    // Stripe Tax necesita la dirección: la que se carga en el checkout queda guardada en el cliente.
    params.customer_update = { address: 'auto' };
  }
  return params;
}

/** Portal de facturación; con `change` abre directo la confirmación del cambio a otro plan. */
export function portalParams(input: {
  customerId: string;
  returnUrl: string;
  locale: string;
  configuration: string | null;
  change?: { subscriptionId: string; itemId: string; priceId: string } | null;
}): FormParams {
  const params: FormParams = {
    customer: input.customerId,
    return_url: input.returnUrl,
    locale: input.locale,
    configuration: input.configuration ?? undefined,
  };
  if (input.change) {
    params.flow_data = {
      type: 'subscription_update_confirm',
      subscription_update_confirm: {
        subscription: input.change.subscriptionId,
        items: [{ id: input.change.itemId, price: input.change.priceId, quantity: 1 }],
      },
      after_completion: { type: 'redirect', redirect: { return_url: input.returnUrl } },
    };
  }
  return params;
}

function stripeFailure(err: StripeError, logger: Logger, what: string): Response {
  logger.error(`[${TAG}] Stripe falló (${what}): ${err.describe()}`);
  return json(502, { error: 'stripe', message: MESSAGES.stripe, code: err.code ?? err.type });
}

function dbFailure(err: DbError, logger: Logger): Response {
  logger.error(`[${TAG}] falla de la base de datos: ${err.code}`);
  if (DB_NOT_READY.has(err.code)) return json(503, { error: 'backend_not_ready', message: MESSAGES.backendNotReady });
  return json(503, { error: 'db_unavailable', message: MESSAGES.dbUnavailable });
}

async function shortHash(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let hex = '';
  for (const b of digest.slice(0, 6)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function httpsUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value) && value.length <= 4000 ? value : null;
}

/** Estado sin los ids internos (es lo que ve el launcher). */
function publicState(internal: Obj | null): Obj {
  const s = internal ?? {};
  return {
    plan: typeof s.plan === 'string' ? s.plan : null,
    planName: typeof s.planName === 'string' ? s.planName : null,
    status: typeof s.status === 'string' ? s.status : null,
    active: s.active === true,
    currentPeriodEnd: typeof s.currentPeriodEnd === 'string' ? s.currentPeriodEnd : null,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd === true,
    graceUntil: typeof s.graceUntil === 'string' ? s.graceUntil : null,
    inGrace: s.inGrace === true,
    source: typeof s.source === 'string' ? s.source : null,
    stripeStatus: typeof s.stripeStatus === 'string' ? s.stripeStatus : null,
    managedByStripe: s.managedByStripe === true,
    hasCustomer: s.hasCustomer === true,
    lastSyncedAt: typeof s.lastSyncedAt === 'string' ? s.lastSyncedAt : null,
  };
}

interface PriceEntry {
  plan: string;
  planName: string;
  sort: number;
  priceId: string;
  amount: number;
  currency: string;
  interval: string;
}

function parsePrices(data: unknown): PriceEntry[] {
  if (!Array.isArray(data)) return [];
  const out: PriceEntry[] = [];
  for (const raw of data) {
    const p = obj(raw);
    if (!p || typeof p.plan !== 'string' || typeof p.priceId !== 'string' || typeof p.amount !== 'number') continue;
    out.push({
      plan: p.plan,
      planName: typeof p.planName === 'string' ? p.planName : p.plan,
      sort: typeof p.sort === 'number' ? p.sort : 100,
      priceId: p.priceId,
      amount: p.amount,
      currency: typeof p.currency === 'string' ? p.currency : 'usd',
      interval: typeof p.interval === 'string' ? p.interval : 'month',
    });
  }
  return out;
}

export function createBillingHandler(deps: BillingDeps): (req: Request) => Promise<Response> {
  const logger: Logger = deps.logger ?? console;
  const now = deps.nowMs ?? Date.now;
  const lastSync = new Map<string, number>();
  const lastPost = new Map<string, number>();
  let portalConfigCache: { id: string | null; at: number } | null = null;

  async function db(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await deps.rpc(name, args);
    } catch (err) {
      throw new DbError(errorCode(err));
    }
  }

  const priceMap = deps.priceMap ?? createPriceMapLoader(db, LIMITS.priceMapTtlMs, now);

  async function loadState(userId: string): Promise<Obj | null> {
    return obj(await db('billing_state', { p_user: userId, p_livemode: deps.livemode }));
  }

  async function loadPrices(): Promise<PriceEntry[]> {
    return parsePrices(await db('billing_prices', { p_livemode: deps.livemode }));
  }

  // Configuración del portal: la del secreto, o la que creó scripts/stripe-setup.js (metadata venus = ai),
  // o ninguna (Stripe usa la predeterminada de la cuenta).
  async function portalConfiguration(stripe: StripeClient): Promise<string | null> {
    if (deps.portalConfiguration) return deps.portalConfiguration;
    if (portalConfigCache && now() - portalConfigCache.at < LIMITS.portalConfigTtlMs) return portalConfigCache.id;
    let id: string | null = null;
    try {
      const listed = await stripe.get<Obj>('/v1/billing_portal/configurations', { active: true, limit: 100 });
      const data = Array.isArray(listed.data) ? listed.data : [];
      const found = data.map(obj).find((c) => c && c.active !== false && obj(c.metadata)?.venus === 'ai');
      id = idOf(found?.id) ?? null;
    } catch (err) {
      logger.warn(`[${TAG}] no se pudo buscar la configuración del portal: ${err instanceof StripeError ? err.describe() : errorName(err)}`);
    }
    portalConfigCache = { id, at: now() };
    return id;
  }

  async function ensureCustomer(stripe: StripeClient, user: User, stored: string | null): Promise<string> {
    if (stored) {
      try {
        const customer = await stripe.get<Obj>(stripePath('/v1/customers/', stored));
        if (customer.deleted !== true) return stored;
      } catch (err) {
        if (!(err instanceof StripeError && err.missing)) throw err;
      }
    }
    // Idempotency-Key: dos clics seguidos no crean dos clientes.
    const key = `venus-customer-${user.userId}-${stored ?? 'new'}-${await shortHash(user.email ?? '')}`;
    const created = await stripe.post<Obj>(
      '/v1/customers',
      { email: user.email ?? undefined, metadata: { user_id: user.userId, app: 'venus-launcher' } },
      { idempotencyKey: key },
    );
    const id = idOf(created.id);
    if (!id || !id.startsWith('cus_')) throw new StripeError(502, 'invalid_response', null, null, null);
    const linked = await db('billing_link_customer', { p_user: user.userId, p_customer: id, p_livemode: deps.livemode, p_replace: Boolean(stored) });
    return typeof linked === 'string' && linked.startsWith('cus_') ? linked : id;
  }

  /**
   * Un solo checkout abierto por cliente (así dos pestañas o dos clics no terminan en dos suscripciones):
   * devuelve el abierto del mismo plan para reutilizarlo y vence los de otros planes.
   */
  async function openCheckout(stripe: StripeClient, customerId: string, planId: string): Promise<Obj | null> {
    let reuse: Obj | null = null;
    let listed: Obj;
    try {
      listed = await stripe.get<Obj>('/v1/checkout/sessions', { customer: customerId, status: 'open', limit: 10 });
    } catch (err) {
      if (err instanceof StripeError && !err.retryable) {
        logger.warn(`[${TAG}] no se pudieron listar los checkouts abiertos: ${err.describe()}`);
        return null;
      }
      throw err;
    }
    for (const raw of Array.isArray(listed.data) ? listed.data : []) {
      const session = obj(raw);
      const id = idOf(session?.id);
      if (!session || !id || session.status !== 'open' || session.mode !== 'subscription') continue;
      if (!reuse && obj(session.metadata)?.plan_id === planId && httpsUrl(session.url)) {
        reuse = session;
        continue;
      }
      try {
        await stripe.post(stripePath('/v1/checkout/sessions/', id) + '/expire');
      } catch (err) {
        logger.warn(`[${TAG}] no se pudo vencer el checkout ${id}: ${err instanceof StripeError ? err.describe() : errorName(err)}`);
      }
    }
    return reuse;
  }

  /** Suscripción viva (active, trialing o past_due) de un plan conocido, o null. */
  async function openSubscription(stripe: StripeClient, customerId: string): Promise<Obj | null> {
    const listed = await stripe.get<Obj>('/v1/subscriptions', { customer: customerId, status: 'all', limit: 20 });
    const open = (Array.isArray(listed.data) ? listed.data : []).filter((s) => OPEN_SUBSCRIPTION_STATUSES.has(String(obj(s)?.status)));
    if (!open.length) return null;
    return chooseSubscription(open, await priceMap(false)) ?? chooseSubscription(open, await priceMap(true));
  }

  async function portalUrl(stripe: StripeClient, customerId: string, locale: string, change?: { subscription: Obj; priceId: string }): Promise<string> {
    const urls = deps.returnUrls as ReturnUrls;
    const configuration = await portalConfiguration(stripe);
    if (change) {
      const picked = pickPlanItem(change.subscription, await priceMap(false));
      const subscriptionId = idOf(change.subscription.id);
      const itemId = idOf(picked?.item.id);
      if (picked && subscriptionId && itemId && picked.priceId !== change.priceId) {
        try {
          const session = await stripe.post<Obj>(
            '/v1/billing_portal/sessions',
            portalParams({ customerId, returnUrl: urls.portal, locale, configuration, change: { subscriptionId, itemId, priceId: change.priceId } }),
          );
          const url = httpsUrl(session.url);
          if (url) return url;
        } catch (err) {
          if (!(err instanceof StripeError) || err.retryable) throw err;
          // Por ejemplo, la configuración del portal no permite ese cambio: se abre el portal común.
          logger.warn(`[${TAG}] el portal no aceptó el cambio directo de plan (${err.describe()}); se abre el portal común`);
        }
      }
    }
    const session = await stripe.post<Obj>('/v1/billing_portal/sessions', portalParams({ customerId, returnUrl: urls.portal, locale, configuration }));
    const url = httpsUrl(session.url);
    if (!url) throw new StripeError(502, 'invalid_response', null, null, null);
    return url;
  }

  /**
   * Un pedido a Stripe (checkout o portal) por usuario cada POST_INTERVAL_MS: así una cuenta no agota el límite de
   * la API de Stripe de toda la cuenta (y con él los pagos de los demás) ni la llena de checkouts. En memoria y por
   * instancia, como la sincronización. Devuelve el 429 si es muy pronto; si no, toma el turno.
   */
  function tooSoon(userId: string): Response | null {
    const t = now();
    const last = lastPost.get(userId);
    if (last !== undefined && t - last < POST_INTERVAL_MS) {
      const wait = Math.max(1, Math.ceil((POST_INTERVAL_MS - (t - last)) / 1000));
      return json(429, { error: 'busy', message: MESSAGES.busy }, { 'Retry-After': String(wait) });
    }
    if (lastPost.size > 5000) lastPost.clear();
    lastPost.set(userId, t);
    return null;
  }

  /** Vuelve a leer de Stripe la suscripción del usuario (por si el webhook se atrasó). true si la guardó. */
  async function syncUser(stripe: StripeClient, user: User, internal: Obj | null): Promise<boolean> {
    const customerId = typeof internal?.customerId === 'string' ? internal.customerId : null;
    if (!customerId) return false;
    const t = now();
    if (t - (lastSync.get(user.userId) ?? 0) < LIMITS.syncIntervalMs) return false;
    if (lastSync.size > 5000) lastSync.clear();
    lastSync.set(user.userId, t);
    try {
      const syncedAt = new Date(t);
      const listed = await stripe.get<Obj>('/v1/subscriptions', { customer: customerId, status: 'all', limit: 20, expand: ['data.latest_invoice'] });
      const subs = Array.isArray(listed.data) ? listed.data : [];
      if (!subs.length) return false;
      const sub = chooseSubscription(subs, await priceMap(false)) ?? chooseSubscription(subs, await priceMap(true));
      if (!sub) return false;
      const outcome = await applySubscription(sub, {
        rpc: deps.rpc,
        priceMap,
        graceDays: deps.graceDays,
        nowMs: t,
        syncedAt,
        expectUserId: user.userId,
        logger,
        tag: TAG,
      });
      return outcome === 'applied';
    } catch (err) {
      logger.warn(`[${TAG}] no se pudo sincronizar con Stripe: ${err instanceof StripeError ? err.describe() : errorCode(err)}`);
      return false;
    }
  }

  async function handleGet(req: Request, user: User): Promise<Response> {
    const wantSync = /^(1|true)$/i.test(new URL(req.url).searchParams.get('sync') ?? '');
    let internal = await loadState(user.userId);
    let synced: boolean | null = null;
    if (wantSync && deps.stripe) {
      synced = await syncUser(deps.stripe, user, internal);
      if (synced) internal = await loadState(user.userId);
    }
    const catalog = (await loadPrices()).map((p) => ({
      id: p.plan,
      name: p.planName,
      sort: p.sort,
      price: { amount: p.amount, currency: p.currency, interval: p.interval },
    }));
    return json(200, { state: publicState(internal), catalog, mode: deps.livemode ? 'live' : 'test', synced });
  }

  async function handleCheckout(stripe: StripeClient, user: User, body: Obj): Promise<Response> {
    const planId = typeof body.plan === 'string' ? body.plan.trim() : '';
    if (!PLAN_ID_PATTERN.test(planId)) return json(400, { error: 'unknown_plan', message: MESSAGES.unknownPlan });
    const entry = (await loadPrices()).find((p) => p.plan === planId);
    if (!entry) return json(400, { error: 'unknown_plan', message: MESSAGES.unknownPlan });
    const busy = tooSoon(user.userId);
    if (busy) return busy;
    const locale = stripeLocale(body.locale);
    const urls = deps.returnUrls as ReturnUrls;

    const internal = await loadState(user.userId);
    const stored = typeof internal?.customerId === 'string' ? internal.customerId : null;
    const customerId = await ensureCustomer(stripe, user, stored);

    // Ya paga una suscripción: nada de un segundo cobro, se abre el portal (en el cambio a ese plan).
    const open = await openSubscription(stripe, customerId);
    if (open) {
      const url = await portalUrl(stripe, customerId, locale, { subscription: open, priceId: entry.priceId });
      return json(200, { kind: 'portal', url, reason: 'already_subscribed' });
    }

    const pending = await openCheckout(stripe, customerId, planId);
    if (pending) {
      return json(200, {
        kind: 'checkout',
        url: httpsUrl(pending.url),
        sessionId: idOf(pending.id),
        expiresAt: isoFromUnix(typeof pending.expires_at === 'number' ? pending.expires_at : null),
        reused: true,
      });
    }

    const session = await stripe.post<Obj>(
      '/v1/checkout/sessions',
      checkoutParams({ customerId, userId: user.userId, planId, priceId: entry.priceId, urls, locale, automaticTax: deps.automaticTax }),
    );
    const url = httpsUrl(session.url);
    if (!url) throw new StripeError(502, 'invalid_response', null, null, null);
    return json(200, {
      kind: 'checkout',
      url,
      sessionId: idOf(session.id),
      expiresAt: isoFromUnix(typeof session.expires_at === 'number' ? session.expires_at : null),
    });
  }

  async function handlePortal(stripe: StripeClient, user: User, body: Obj): Promise<Response> {
    const internal = await loadState(user.userId);
    const customerId = typeof internal?.customerId === 'string' ? internal.customerId : null;
    if (!customerId) return json(409, { error: 'no_customer', message: MESSAGES.noCustomer });
    const busy = tooSoon(user.userId);
    if (busy) return busy;
    try {
      const url = await portalUrl(stripe, customerId, stripeLocale(body.locale));
      return json(200, { kind: 'portal', url });
    } catch (err) {
      if (err instanceof StripeError && err.missing) return json(409, { error: 'no_customer', message: MESSAGES.noCustomer });
      throw err;
    }
  }

  async function handlePost(req: Request, user: User): Promise<Response> {
    if (!deps.stripe || !deps.returnUrls) {
      logger.error(`[${TAG}] faltan secretos: STRIPE_SECRET_KEY o la URL de vuelta (SUPABASE_URL / BILLING_RETURN_URL)`);
      return json(503, { error: 'not_configured', message: MESSAGES.notConfigured });
    }
    const contentType = (req.headers.get('content-type') ?? '').trim().toLowerCase();
    if (!contentType.startsWith('application/json')) return json(400, { error: 'bad_request', message: MESSAGES.badJson });
    const read = await readBodyBytes(req, LIMITS.billingBodyBytes);
    const text = read.ok ? decodeUtf8(read.bytes) : null;
    let body: Obj | null = null;
    try {
      body = text === null ? null : obj(JSON.parse(text));
    } catch {
      body = null;
    }
    if (!body) return json(400, { error: 'bad_request', message: MESSAGES.badBody });
    if (body.action === 'checkout') return handleCheckout(deps.stripe, user, body);
    if (body.action === 'portal') return handlePortal(deps.stripe, user, body);
    return json(400, { error: 'bad_request', message: MESSAGES.badAction });
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
    const page = returnPage(req);
    if (page) return page;
    if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'bad_request', message: MESSAGES.badMethod }, { Allow: 'GET, POST, OPTIONS' });
    if (!deps.supabaseReady) return json(503, { error: 'not_configured', message: MESSAGES.notConfigured });

    const token = bearerToken(req.headers.get('authorization'));
    if (!token) return json(401, { error: 'unauthorized', message: MESSAGES.unauthorized });
    let auth: AuthResult;
    try {
      auth = await deps.verifyUser(token);
    } catch {
      auth = { status: 'unavailable' };
    }
    if (auth.status === 'invalid') return json(401, { error: 'unauthorized', message: MESSAGES.unauthorized });
    if (auth.status === 'forbidden') return json(403, { error: 'unauthorized', message: MESSAGES.anonymous });
    if (auth.status !== 'ok') return json(503, { error: 'auth_unavailable', message: MESSAGES.authUnavailable });
    const user: User = { userId: auth.userId, email: auth.email };

    try {
      return req.method === 'GET' ? await handleGet(req, user) : await handlePost(req, user);
    } catch (err) {
      if (err instanceof DbError) return dbFailure(err, logger);
      if (err instanceof StripeError) return stripeFailure(err, logger, req.method === 'GET' ? 'estado' : 'pedido');
      throw err;
    }
  }

  return async (req: Request): Promise<Response> => {
    try {
      return await handle(req);
    } catch (err) {
      logger.error(`[${TAG}] error interno: ${errorName(err)}`);
      return json(500, { error: 'internal', message: MESSAGES.internal });
    }
  };
}
