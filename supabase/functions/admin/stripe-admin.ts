// Cliente de la API de Stripe para el panel: el de "billing" (misma versión fija de la API, mismos errores sin
// datos del cliente) más DELETE (borrar cupones y cancelar suscripciones) e ids con guiones (cupones con id propio).
// Nunca registra pedidos ni respuestas.
import { STRIPE_API_BASE, STRIPE_API_VERSION, STRIPE_TIMEOUT_MS } from '../billing/config.ts';
import { StripeError, encodeForm } from '../billing/stripe.ts';
import type { FetchLike, FormParams } from '../billing/stripe.ts';

export { StripeError };
export type { FormParams };

export interface StripeRequestOptions {
  idempotencyKey?: string;
}

export interface AdminStripe {
  get<T = Record<string, unknown>>(path: string, params?: FormParams): Promise<T>;
  post<T = Record<string, unknown>>(path: string, params?: FormParams, options?: StripeRequestOptions): Promise<T>;
  del<T = Record<string, unknown>>(path: string, params?: FormParams, options?: StripeRequestOptions): Promise<T>;
}

export interface AdminStripeOptions {
  secretKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const PATH_PATTERN = /^\/v1\/[A-Za-z0-9_/-]+$/;

/** Ruta con un id de Stripe validado y codificado: idPath('/v1/coupons/', id). */
export function idPath(prefix: string, id: unknown, suffix = ''): string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new StripeError(400, 'invalid_request_error', 'invalid_id', null, null);
  return `${prefix}${encodeURIComponent(id)}${suffix}`;
}

export function createAdminStripe(options: AdminStripeOptions): AdminStripe {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = (options.baseUrl ?? STRIPE_API_BASE).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? STRIPE_TIMEOUT_MS;

  async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params?: FormParams, opts?: StripeRequestOptions): Promise<T> {
    if (!PATH_PATTERN.test(path)) throw new StripeError(400, 'invalid_request_error', 'invalid_path', null, null);
    const form = encodeForm(params);
    // GET y DELETE llevan los parámetros en la URL (como las librerías oficiales).
    const inQuery = method !== 'POST';
    const url = inQuery && form ? `${base}${path}?${form}` : `${base}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
      Accept: 'application/json',
    };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (opts?.idempotencyKey && method !== 'GET') headers['Idempotency-Key'] = opts.idempotencyKey.slice(0, 255);

    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers,
        body: method === 'POST' ? form : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      throw new StripeError(0, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error', null, null, null);
    }
    const requestId = res.headers.get('request-id');
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const error = (data as { error?: Record<string, unknown> } | null)?.error ?? {};
      const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 80) : null);
      throw new StripeError(res.status, str(error.type) ?? 'api_error', str(error.code), str(error.param), requestId);
    }
    if (!data || typeof data !== 'object') throw new StripeError(res.status, 'invalid_response', null, null, requestId);
    return data as T;
  }

  return {
    get: (path, params) => request('GET', path, params),
    post: (path, params, opts) => request('POST', path, params, opts),
    del: (path, params, opts) => request('DELETE', path, params, opts),
  };
}

/** Hash corto (hex) para armar claves de idempotencia sin datos legibles. */
export async function shortHash(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let hex = '';
  for (const b of digest.slice(0, 8)) hex += b.toString(16).padStart(2, '0');
  return hex;
}
