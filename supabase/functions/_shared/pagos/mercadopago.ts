// Mercado Pago (Checkout Pro): preferencia de pago único en pesos, lectura de pagos y firma de las notificaciones.
// Docs: https://www.mercadopago.com.ar/developers/es/reference
import { type FetchLike, ProviderError, money, requestJson, short } from './provider.ts';

export const MP_API = 'https://api.mercadopago.com';
const TAG = 'mercadopago';

export type MpPayment = {
  id: string;
  status: string;
  statusDetail: string | null;
  externalReference: string | null;
  amount: number | null;
  currency: string | null;
  live: boolean;
  createdAt: string | null;
};

/**
 * TEST-… = credenciales de prueba viejas. APP_USR-… = producción, pero también las de la cuenta vendedora de prueba
 * que crea Checkout Pro: lo seguro es el live_mode de cada pago (y "Probar conexión" en el panel).
 */
export function mpTokenMode(token: string | null | undefined): 'test' | 'live' | null {
  const t = String(token ?? '');
  if (/^TEST-/.test(t)) return 'test';
  if (/^APP_USR-/.test(t)) return 'live';
  return null;
}

function codeOf(body: Record<string, unknown> | null): string | null {
  return short(body?.error) ?? short(body?.code) ?? (Array.isArray(body?.cause) ? short((body!.cause as Record<string, unknown>[])[0]?.code) : null);
}

function client(doFetch: FetchLike, token: string) {
  const headers = (extra?: Record<string, string>) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json', ...(extra ?? {}) });
  return {
    get: (path: string) => requestJson(TAG, doFetch, `${MP_API}${path}`, { method: 'GET', headers: headers() }, codeOf),
    post: (path: string, body: unknown, idem?: string) =>
      requestJson(TAG, doFetch, `${MP_API}${path}`, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json', ...(idem ? { 'X-Idempotency-Key': idem.slice(0, 64) } : {}) }),
        body: JSON.stringify(body),
      }, codeOf),
  };
}

export type PreferenceInput = {
  orderId: string;
  planId: string;
  title: string;
  amount: number;
  notificationUrl: string;
  backUrls: { success: string; failure: string; pending: string };
  statementDescriptor: string;
  expiresAt: Date;
};

/** Fecha con zona horaria explícita, como pide Mercado Pago (yyyy-MM-ddTHH:mm:ss.SSS-03:00). */
function mpDate(d: Date): string {
  const ar = new Date(d.getTime() - 3 * 3600 * 1000);
  return `${ar.toISOString().slice(0, 23)}-03:00`;
}

/** En el resumen de la tarjeta entran 13 caracteres. */
export function mpDescriptor(text: string): string {
  const t = String(text || '').trim();
  return (t.length <= 13 ? t : t.replace(/\s+/g, '').slice(0, 13)) || 'VENUSLAUNCHER';
}

export function preferenceBody(input: PreferenceInput): Record<string, unknown> {
  return {
    items: [{ id: input.planId, title: input.title, quantity: 1, unit_price: input.amount, currency_id: 'ARS' }],
    external_reference: input.orderId,
    metadata: { order_id: input.orderId, plan_id: input.planId },
    notification_url: input.notificationUrl,
    back_urls: input.backUrls,
    auto_return: 'approved',
    statement_descriptor: mpDescriptor(input.statementDescriptor),
    expires: true,
    expiration_date_from: mpDate(new Date(input.expiresAt.getTime() - 2 * 86400000 - 60000)),
    expiration_date_to: mpDate(input.expiresAt),
    binary_mode: false,
  };
}

/** Crea la preferencia y devuelve el link de pago. Mercado Pago pide usar init_point también en las pruebas. */
export async function mpCreatePreference(doFetch: FetchLike, token: string, input: PreferenceInput): Promise<{ id: string; url: string }> {
  const body = await client(doFetch, token).post('/checkout/preferences', preferenceBody(input), `venus-${input.orderId}`);
  const id = short(body.id, 200);
  const url = short(body.init_point ?? body.sandbox_init_point, 2000);
  if (!id || !url || !/^https:\/\//.test(url)) throw new ProviderError(TAG, 200, 'invalid_response');
  return { id, url };
}

export function parsePayment(raw: Record<string, unknown> | null): MpPayment | null {
  if (!raw) return null;
  const id = raw.id === undefined || raw.id === null ? null : String(raw.id);
  const status = short(raw.status, 40);
  if (!id || !/^[0-9]{1,30}$/.test(id) || !status) return null;
  return {
    id,
    status,
    statusDetail: short(raw.status_detail, 60),
    externalReference: short(raw.external_reference, 200),
    amount: money(raw.transaction_amount),
    currency: short(raw.currency_id, 3),
    live: raw.live_mode === true,
    createdAt: short(raw.date_created, 40),
  };
}

export async function mpGetPayment(doFetch: FetchLike, token: string, paymentId: string): Promise<MpPayment | null> {
  if (!/^[0-9]{1,30}$/.test(paymentId)) return null;
  try {
    return parsePayment(await client(doFetch, token).get(`/v1/payments/${paymentId}`));
  } catch (err) {
    if (err instanceof ProviderError && err.missing) return null;
    throw err;
  }
}

export async function mpSearchPayments(doFetch: FetchLike, token: string, externalReference: string): Promise<MpPayment[]> {
  const q = new URLSearchParams({ external_reference: externalReference, sort: 'date_created', criteria: 'desc', limit: '30' });
  const body = await client(doFetch, token).get(`/v1/payments/search?${q}`);
  const list = Array.isArray(body.results) ? body.results : [];
  return list.map((r) => parsePayment(r && typeof r === 'object' ? (r as Record<string, unknown>) : null)).filter((p): p is MpPayment => Boolean(p));
}

/** Datos de la cuenta, para "Probar conexión" del panel. */
export async function mpAccount(doFetch: FetchLike, token: string): Promise<{ id: string | null; nickname: string | null; siteId: string | null; testAccount: boolean }> {
  const me = await client(doFetch, token).get('/users/me');
  const tags = Array.isArray(me.tags) ? me.tags : [];
  const nickname = short(me.nickname, 60);
  return {
    id: me.id === undefined ? null : String(me.id).slice(0, 30),
    nickname,
    siteId: short(me.site_id, 8),
    testAccount: tags.includes('test_user') || /^TEST/i.test(nickname ?? '') || mpTokenMode(token) === 'test',
  };
}

export type Outcome =
  | { kind: 'paid'; paymentId: string; amount: number | null; currency: string | null; live: boolean; providerStatus: string }
  | { kind: 'refunded'; providerStatus: string }
  | { kind: 'pending'; providerStatus: string | null };

/** Qué significa la lista de pagos de una orden. Un pago aprobado manda; si después se devolvió, es devolución. */
export function mpOutcome(payments: MpPayment[], orderId: string): Outcome {
  const mine = payments.filter((p) => p.externalReference === orderId);
  const approved = mine.find((p) => p.status === 'approved');
  if (approved) return { kind: 'paid', paymentId: approved.id, amount: approved.amount, currency: approved.currency, live: approved.live, providerStatus: 'approved' };
  const back = mine.find((p) => p.status === 'refunded' || p.status === 'charged_back');
  if (back) return { kind: 'refunded', providerStatus: back.status };
  const last = mine[0];
  return { kind: 'pending', providerStatus: last ? `${last.status}${last.statusDetail ? `:${last.statusDetail}` : ''}`.slice(0, 60) : null };
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Firma x-signature de Mercado Pago: "ts=<segundos>,v1=<hmac>". El manifiesto es
 * id:<data.id>;request-id:<x-request-id>;ts:<ts>; (si falta un dato, esa parte no va) y se firma con HMAC-SHA256.
 */
export async function mpVerifySignature(secret: string, signature: string | null, requestId: string | null, dataId: string | null, nowSec: number, toleranceSec = 600): Promise<boolean> {
  if (!secret || !signature) return false;
  const parts = new Map(signature.split(',').map((p) => p.trim().split('=', 2) as [string, string]).filter((p) => p.length === 2));
  const ts = parts.get('ts');
  const v1 = parts.get('v1');
  if (!ts || !v1 || !/^\d{1,13}$/.test(ts) || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  const tsSec = ts.length > 10 ? Math.floor(Number(ts) / 1000) : Number(ts);
  if (Math.abs(nowSec - tsSec) > toleranceSec) return false;
  const id = dataId && /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  let manifest = '';
  if (id) manifest += `id:${id};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest)));
  return safeEqual(mac, v1.toLowerCase());
}
