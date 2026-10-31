// PayPal (Orders v2): orden de pago único en dólares, captura del lado del servidor y verificación de webhooks.
// Docs: https://developer.paypal.com/docs/api/orders/v2/
import { type FetchLike, ProviderError, money, requestJson, short } from './provider.ts';

export type PaypalEnv = 'sandbox' | 'live';
const TAG = 'paypal';

export function paypalBase(env: PaypalEnv): string {
  return env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

function codeOf(body: Record<string, unknown> | null): string | null {
  const details = Array.isArray(body?.details) ? (body!.details as Record<string, unknown>[]) : [];
  return short(details[0]?.issue) ?? short(body?.name) ?? short(body?.error);
}

type Token = { value: string; until: number };
const tokens = new Map<string, Token>();

async function cacheKey(env: PaypalEnv, clientId: string, secret: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env}:${clientId}:${secret}`)));
  return Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Token OAuth (client_credentials), guardado en memoria hasta un minuto antes de que venza. */
export async function paypalToken(doFetch: FetchLike, env: PaypalEnv, clientId: string, secret: string, nowMs = Date.now()): Promise<string> {
  const key = await cacheKey(env, clientId, secret);
  const cached = tokens.get(key);
  if (cached && cached.until > nowMs) return cached.value;
  const body = await requestJson(TAG, doFetch, `${paypalBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials',
  }, codeOf);
  const value = short(body.access_token, 4000);
  const expires = typeof body.expires_in === 'number' ? body.expires_in : 300;
  if (!value) throw new ProviderError(TAG, 200, 'invalid_response');
  if (tokens.size > 20) tokens.clear();
  tokens.set(key, { value, until: nowMs + Math.max(30, expires - 60) * 1000 });
  return value;
}

export type PaypalCreds = { env: PaypalEnv; clientId: string; secret: string };

async function api(doFetch: FetchLike, creds: PaypalCreds, method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string) {
  const token = await paypalToken(doFetch, creds.env, creds.clientId, creds.secret);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'return=representation' };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  if (requestId) headers['PayPal-Request-Id'] = requestId.slice(0, 108);
  return requestJson(TAG, doFetch, `${paypalBase(creds.env)}${path}`, { method, headers, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined }, codeOf);
}

export type OrderInput = {
  orderId: string;
  planId: string;
  description: string;
  amount: number;
  returnUrl: string;
  cancelUrl: string;
  softDescriptor: string;
};

export function orderBody(input: OrderInput): Record<string, unknown> {
  return {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: input.planId,
      custom_id: input.orderId,
      invoice_id: input.orderId,
      description: input.description.slice(0, 127),
      soft_descriptor: input.softDescriptor.slice(0, 22),
      amount: { currency_code: 'USD', value: input.amount.toFixed(2) },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Venus Launcher',
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        },
      },
    },
  };
}

function approveUrl(order: Record<string, unknown>): string | null {
  const links = Array.isArray(order.links) ? (order.links as Record<string, unknown>[]) : [];
  const link = links.find((l) => l?.rel === 'payer-action') ?? links.find((l) => l?.rel === 'approve');
  const href = short(link?.href, 2000);
  return href && /^https:\/\//.test(href) ? href : null;
}

export async function paypalCreateOrder(doFetch: FetchLike, creds: PaypalCreds, input: OrderInput): Promise<{ id: string; url: string }> {
  const order = await api(doFetch, creds, 'POST', '/v2/checkout/orders', orderBody(input), `venus-${input.orderId}`);
  const id = short(order.id, 64);
  const url = approveUrl(order);
  if (!id || !/^[A-Z0-9]{5,64}$/.test(id) || !url) throw new ProviderError(TAG, 200, 'invalid_response');
  return { id, url };
}

export async function paypalGetOrder(doFetch: FetchLike, creds: PaypalCreds, id: string): Promise<Record<string, unknown> | null> {
  if (!/^[A-Z0-9]{5,64}$/.test(id)) return null;
  try {
    return await api(doFetch, creds, 'GET', `/v2/checkout/orders/${id}`);
  } catch (err) {
    if (err instanceof ProviderError && err.missing) return null;
    throw err;
  }
}

/** Captura una orden aprobada. Si ya estaba capturada, devuelve la orden como está. */
export async function paypalCapture(doFetch: FetchLike, creds: PaypalCreds, id: string): Promise<Record<string, unknown> | null> {
  try {
    return await api(doFetch, creds, 'POST', `/v2/checkout/orders/${id}/capture`, {}, `venus-capture-${id}`);
  } catch (err) {
    if (err instanceof ProviderError && (err.code === 'ORDER_ALREADY_CAPTURED' || err.status === 422)) return paypalGetOrder(doFetch, creds, id);
    throw err;
  }
}

export type PaypalOutcome =
  | { kind: 'paid'; paymentId: string; amount: number | null; currency: string | null; providerStatus: string; customId: string | null }
  | { kind: 'refunded'; providerStatus: string; customId: string | null }
  | { kind: 'cancelled'; providerStatus: string; customId: string | null }
  | { kind: 'approved'; providerStatus: string; customId: string | null }
  | { kind: 'pending'; providerStatus: string | null; customId: string | null };

/** Estado de una orden de PayPal -> qué hacer con la nuestra. */
export function paypalOutcome(order: Record<string, unknown> | null): PaypalOutcome {
  if (!order) return { kind: 'pending', providerStatus: 'not_found', customId: null };
  const status = short(order.status, 40) ?? '';
  const unit = Array.isArray(order.purchase_units) ? (order.purchase_units[0] as Record<string, unknown>) : null;
  const customId = short(unit?.custom_id, 200);
  const payments = unit?.payments && typeof unit.payments === 'object' ? (unit.payments as Record<string, unknown>) : null;
  const captures = Array.isArray(payments?.captures) ? (payments!.captures as Record<string, unknown>[]) : [];
  const cap = captures.find((c) => c?.status === 'COMPLETED') ?? captures[0] ?? null;
  if (cap) {
    const capStatus = short(cap.status, 30) ?? '';
    const amount = cap.amount && typeof cap.amount === 'object' ? (cap.amount as Record<string, unknown>) : {};
    if (capStatus === 'COMPLETED') {
      return { kind: 'paid', paymentId: short(cap.id, 64) ?? '', amount: money(amount.value), currency: short(amount.currency_code, 3), providerStatus: 'COMPLETED', customId };
    }
    if (capStatus === 'REFUNDED' || capStatus === 'PARTIALLY_REFUNDED') return { kind: 'refunded', providerStatus: capStatus, customId };
    const reason = cap.status_details && typeof cap.status_details === 'object' ? short((cap.status_details as Record<string, unknown>).reason, 30) : null;
    return { kind: 'pending', providerStatus: `capture_${capStatus}${reason ? `:${reason}` : ''}`.slice(0, 60), customId };
  }
  if (status === 'APPROVED') return { kind: 'approved', providerStatus: status, customId };
  if (status === 'VOIDED') return { kind: 'cancelled', providerStatus: status, customId };
  return { kind: 'pending', providerStatus: status || null, customId };
}

/** Prueba de credenciales para el panel: pide un token. */
export async function paypalCheck(doFetch: FetchLike, creds: PaypalCreds): Promise<{ ok: true; env: PaypalEnv }> {
  await paypalToken(doFetch, creds.env, creds.clientId, creds.secret);
  return { ok: true, env: creds.env };
}

/** Verifica un webhook con la API de PayPal (verify-webhook-signature). */
export async function paypalVerifyWebhook(doFetch: FetchLike, creds: PaypalCreds, webhookId: string, headers: Headers, event: unknown): Promise<boolean> {
  const h = (name: string) => headers.get(name) ?? '';
  if (!h('paypal-transmission-id') || !h('paypal-transmission-sig')) return false;
  const body = await api(doFetch, creds, 'POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: webhookId,
    webhook_event: event,
  });
  return body.verification_status === 'SUCCESS';
}
