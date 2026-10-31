// Edge Function "payments": el launcher crea un pago (Mercado Pago o PayPal) y consulta cómo va; el panel de
// admin configura los proveedores. El usuario sale SIEMPRE del JWT, nunca del cuerpo del pedido.
//
// POST { action, payload }:
//   checkout        { plan, provider }   -> { order, url }      abre el link de pago en el navegador
//   status          { orderId }          -> { order }           consulta al proveedor si sigue pendiente
//   payments.get    {}                   -> { config, urls }    (admin)
//   payments.save   { settings, secrets }-> { config, urls }    (admin) los secretos nunca vuelven completos
//   payments.test   { provider }         -> { ok, ... }         (admin) prueba las credenciales
//   payments.orders {}                   -> { orders }          (admin)
//   payments.sync   { orderId }          -> { order }           (admin) vuelve a revisar una orden
// Respuesta: { ok: true, result } o { ok: false, error, message, reason?, field? }.
import { bearerToken, errorCode, errorName, json, obj, readText } from '../_shared/pagos/http.ts';
import { type FetchLike, ProviderError } from '../_shared/pagos/provider.ts';
import { mpAccount, mpCreatePreference, mpTokenMode } from '../_shared/pagos/mercadopago.ts';
import { paypalCheck, paypalCreateOrder } from '../_shared/pagos/paypal.ts';
import { type Logger, type Order, type Rpc, UUID, asOrder, parseSecrets, paypalCreds, syncOrder } from '../_shared/pagos/sync.ts';

const TAG = 'payments';
const BODY_LIMIT = 16 * 1024;
const CHECKOUT_INTERVAL_MS = 3000;
const STATUS_INTERVAL_MS = 2500;
const PLANS = new Set(['basic', 'go', 'pro', 'max']);
const PROVIDERS = new Set(['mercado_pago', 'paypal']);

export type AuthResult =
  | { status: 'ok'; userId: string; email: string | null }
  | { status: 'invalid' | 'forbidden' | 'unavailable' };

export type PaymentsDeps = {
  supabaseReady: boolean;
  verifyUser: (token: string) => Promise<AuthResult>;
  rpc: Rpc;
  fetch: FetchLike;
  /** https://<proyecto>.supabase.co/functions/v1 */
  functionsBase: string;
  nowMs?: () => number;
  logger?: Logger;
};

const MESSAGES = {
  unauthorized: 'Tu sesión de Venus venció. Volvé a iniciar sesión.',
  anonymous: 'Iniciá sesión con una cuenta de Venus para comprar un plan.',
  authUnavailable: 'No se pudo verificar tu sesión. Probá de nuevo en un rato.',
  notConfigured: 'El servidor de pagos no está configurado.',
  badRequest: 'El pedido no es válido.',
  badAction: 'Acción desconocida.',
  forbidden: 'Solo un administrador puede hacer esto.',
  unknownPlan: 'Ese plan no existe o no está a la venta.',
  providerDisabled: 'Ese medio de pago no está habilitado por ahora.',
  tooMany: 'Hiciste muchos intentos de pago seguidos. Esperá un rato y probá de nuevo.',
  busy: 'Esperá unos segundos y probá de nuevo.',
  notFound: 'No se encontró ese pago.',
  provider: 'No se pudo hablar con el medio de pago. Probá de nuevo en un rato.',
  providerAuth: 'El medio de pago rechazó las credenciales de Venus. Avisale al administrador.',
  db: 'No se pudo consultar el servidor de Venus. Probá de nuevo en un rato.',
  backendNotReady: 'Al servidor de Venus le falta la migración de pagos (0017_pagos_directos.sql).',
  internal: 'Error interno del servidor de pagos.',
};

class DbError extends Error {
  code: string;
  detail: string;
  constructor(code: string, detail: string) {
    super(`base: ${code}`);
    this.name = 'DbError';
    this.code = code;
    this.detail = detail;
  }
}

const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => json(status, { ok: false, error, message, ...extra });
const done = (result: unknown) => json(200, { ok: true, result });

export function webhookUrls(base: string) {
  return {
    mercadoPagoNotification: `${base}/payments?provider=mercado_pago&source_news=webhooks`,
    mercadoPagoReturn: `${base}/payments?return=mp`,
    paypalWebhook: `${base}/payments?provider=paypal`,
    paypalReturn: `${base}/payments?return=paypal`,
    paypalCancel: `${base}/payments?return=paypal-cancel`,
  };
}

function planTitle(order: Order): string {
  return `Venus IA · Plan ${order.planName || order.plan}`;
}

export function createPaymentsHandler(deps: PaymentsDeps) {
  const logger = deps.logger ?? console;
  const now = deps.nowMs ?? Date.now;
  const lastCheckout = new Map<string, number>();
  const lastStatus = new Map<string, number>();
  const urls = webhookUrls(deps.functionsBase.replace(/\/+$/, ''));

  async function db(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return await deps.rpc(name, args);
    } catch (err) {
      const o = obj(err) ?? {};
      throw new DbError(errorCode(err), typeof o.message === 'string' ? o.message.slice(0, 120) : '');
    }
  }

  function throttled(map: Map<string, number>, key: string, ms: number): boolean {
    const t = now();
    const last = map.get(key);
    if (last !== undefined && t - last < ms) return true;
    if (map.size > 5000) map.clear();
    map.set(key, t);
    return false;
  }

  async function secrets() {
    return parseSecrets(await db('payments_secrets'));
  }

  const syncCtx = async (includePaid = false) => ({ rpc: db as Rpc, fetch: deps.fetch, secrets: await secrets(), logger, tag: TAG, includePaid });

  // ---------- Comprar ----------
  async function checkout(userId: string, payload: Record<string, unknown>): Promise<Response> {
    const plan = typeof payload.plan === 'string' ? payload.plan : '';
    const provider = typeof payload.provider === 'string' ? payload.provider : '';
    if (!PLANS.has(plan)) return fail(400, 'unknown_plan', MESSAGES.unknownPlan);
    if (!PROVIDERS.has(provider)) return fail(400, 'provider_disabled', MESSAGES.providerDisabled);
    if (throttled(lastCheckout, userId, CHECKOUT_INTERVAL_MS)) return fail(429, 'busy', MESSAGES.busy, { reason: 'busy' });
    const keys = await secrets();
    // Con Mercado Pago es provisorio: al acreditar manda el live_mode del pago.
    const live = provider === 'mercado_pago' ? mpTokenMode(keys.mpAccessToken) !== 'test' : keys.paypalEnv === 'live';
    let order: Order | null;
    try {
      order = asOrder(await db('payments_create_order', { p_user: userId, p_plan: plan, p_provider: provider, p_live: live }));
    } catch (err) {
      if (err instanceof DbError && err.detail === 'provider_disabled') return fail(409, 'provider_disabled', MESSAGES.providerDisabled);
      if (err instanceof DbError && err.detail === 'unknown_plan') return fail(400, 'unknown_plan', MESSAGES.unknownPlan);
      if (err instanceof DbError && err.code === '54000') return fail(429, 'too_many', MESSAGES.tooMany, { reason: 'too_many' });
      throw err;
    }
    if (!order) throw new DbError('invalid', 'orden inválida');
    if ((order as unknown as Record<string, unknown>).reused === true && order.checkoutUrl) return done({ order, url: order.checkoutUrl, reused: true });
    try {
      let created: { id: string; url: string };
      if (provider === 'mercado_pago') {
        created = await mpCreatePreference(deps.fetch, keys.mpAccessToken ?? '', {
          orderId: order.id,
          planId: order.plan,
          title: planTitle(order),
          amount: Number(order.amount),
          notificationUrl: urls.mercadoPagoNotification,
          backUrls: { success: urls.mercadoPagoReturn, failure: urls.mercadoPagoReturn, pending: urls.mercadoPagoReturn },
          statementDescriptor: keys.statementDescriptor,
          expiresAt: new Date(order.expiresAt ? Date.parse(order.expiresAt) : now() + 2 * 86400000),
        });
      } else {
        const creds = paypalCreds(keys);
        if (!creds) return fail(409, 'provider_disabled', MESSAGES.providerDisabled);
        created = await paypalCreateOrder(deps.fetch, creds, {
          orderId: order.id,
          planId: order.plan,
          description: planTitle(order),
          amount: Number(order.amount),
          returnUrl: urls.paypalReturn,
          cancelUrl: urls.paypalCancel,
          softDescriptor: keys.statementDescriptor,
        });
      }
      const attached = asOrder(await db('payments_attach_checkout', { p_order: order.id, p_provider_order_id: created.id, p_url: created.url })) ?? order;
      return done({ order: attached, url: created.url });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      logger.error(`[${TAG}] no se pudo crear el pago ${order.id}: ${err.describe()}`);
      await db('payments_mark_status', { p_order: order.id, p_status: 'failed', p_provider_status: `checkout_error:${err.code ?? err.status}` }).catch(() => {});
      return err.auth ? fail(502, 'provider_auth', MESSAGES.providerAuth) : fail(502, 'provider', MESSAGES.provider);
    }
  }

  async function status(userId: string | null, payload: Record<string, unknown>, force = false): Promise<Response> {
    const id = typeof payload.orderId === 'string' ? payload.orderId : '';
    if (!UUID.test(id)) return fail(400, 'bad_request', MESSAGES.badRequest);
    let order = asOrder(await db('payments_get_order', { p_order: id, p_user: userId }));
    if (!order) return fail(404, 'not_found', MESSAGES.notFound);
    if (force || !throttled(lastStatus, id, STATUS_INTERVAL_MS)) {
      try {
        order = await syncOrder(order, await syncCtx(force));
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        logger.warn(`[${TAG}] no se pudo revisar la orden ${id}: ${err.describe()}`);
      }
    }
    return done({ order });
  }

  // ---------- Panel de admin ----------
  async function adminConfig() {
    return { config: await db('payments_admin_get'), urls };
  }

  async function adminSave(userId: string, payload: Record<string, unknown>): Promise<Response> {
    const settings = obj(payload.settings) ?? {};
    const secretsIn = obj(payload.secrets) ?? {};
    for (const v of Object.values(secretsIn)) if (v !== null && typeof v !== 'string') return fail(400, 'bad_request', MESSAGES.badRequest);
    try {
      await db('payments_admin_save', { p_user: userId, p_settings: settings, p_secrets: secretsIn });
    } catch (err) {
      if (err instanceof DbError && /^bad_secret:/.test(err.detail)) {
        return fail(400, 'bad_request', 'Esa clave no tiene el formato esperado. Copiala de nuevo desde el panel del proveedor.', { field: err.detail.slice(11, 40) });
      }
      if (err instanceof DbError && ['22023', '22P02', '23514', '22003'].includes(err.code)) return fail(400, 'bad_request', 'Revisá los valores: alguno está fuera de rango.');
      throw err;
    }
    return done(await adminConfig());
  }

  async function adminTest(payload: Record<string, unknown>): Promise<Response> {
    const keys = await secrets();
    try {
      if (payload.provider === 'mercado_pago') {
        if (!keys.mpAccessToken) return done({ ok: false, reason: 'missing' });
        const account = await mpAccount(deps.fetch, keys.mpAccessToken);
        return done({ ok: true, mode: account.testAccount ? 'test' : 'live', ...account });
      }
      if (payload.provider === 'paypal') {
        const creds = paypalCreds(keys);
        if (!creds) return done({ ok: false, reason: 'missing' });
        return done(await paypalCheck(deps.fetch, creds));
      }
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      return done({ ok: false, reason: err.auth ? 'auth' : 'unreachable', status: err.status });
    }
    return fail(400, 'bad_request', MESSAGES.badRequest);
  }

  async function handleAction(user: { userId: string }, action: string, payload: Record<string, unknown>): Promise<Response> {
    if (action === 'checkout') return checkout(user.userId, payload);
    if (action === 'status') return status(user.userId, payload);
    if (!action.startsWith('payments.')) return fail(400, 'bad_request', MESSAGES.badAction);
    if ((await db('admin_is_admin_user', { p_user: user.userId })) !== true) return fail(403, 'forbidden', MESSAGES.forbidden);
    switch (action) {
      case 'payments.get': return done(await adminConfig());
      case 'payments.save': return adminSave(user.userId, payload);
      case 'payments.test': return adminTest(payload);
      case 'payments.orders': return done({ orders: await db('payments_admin_orders', { p_limit: 60 }) });
      case 'payments.sync': return status(null, payload, true);
      default: return fail(400, 'bad_request', MESSAGES.badAction);
    }
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (req.method !== 'POST') return fail(405, 'bad_request', MESSAGES.badRequest);
    if (!deps.supabaseReady) return fail(503, 'not_configured', MESSAGES.notConfigured);
    const token = bearerToken(req.headers.get('authorization'));
    if (!token) return fail(401, 'unauthorized', MESSAGES.unauthorized);
    let auth: AuthResult;
    try {
      auth = await deps.verifyUser(token);
    } catch {
      auth = { status: 'unavailable' };
    }
    if (auth.status === 'invalid') return fail(401, 'unauthorized', MESSAGES.unauthorized);
    if (auth.status === 'forbidden') return fail(403, 'unauthorized', MESSAGES.anonymous);
    if (auth.status !== 'ok') return fail(503, 'auth_unavailable', MESSAGES.authUnavailable);
    const text = await readText(req, BODY_LIMIT);
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? obj(JSON.parse(text)) : null;
    } catch {
      body = null;
    }
    if (!body || typeof body.action !== 'string' || body.action.length > 40) return fail(400, 'bad_request', MESSAGES.badRequest);
    try {
      return await handleAction(auth, body.action, obj(body.payload) ?? {});
    } catch (err) {
      if (err instanceof DbError) {
        logger.error(`[${TAG}] falla de la base: ${err.code}`);
        if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(err.code)) return fail(503, 'backend_not_ready', MESSAGES.backendNotReady);
        return fail(503, 'db_unavailable', MESSAGES.db);
      }
      if (err instanceof ProviderError) {
        logger.error(`[${TAG}] proveedor: ${err.describe()}`);
        return fail(502, 'provider', MESSAGES.provider);
      }
      throw err;
    }
  }

  return async (req: Request): Promise<Response> => {
    try {
      return await handle(req);
    } catch (err) {
      logger.error(`[${TAG}] error interno: ${errorName(err)}`);
      return fail(500, 'internal', MESSAGES.internal);
    }
  };
}
