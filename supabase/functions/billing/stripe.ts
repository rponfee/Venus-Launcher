// Cliente mínimo de la API REST de Stripe (form-encoded, sin SDK). Lo usan "billing" y "stripe-webhook".
// Nunca registra pedidos ni respuestas: los errores llevan solo estado, tipo, código, parámetro y request id
// (los mensajes de Stripe pueden traer datos del cliente y no se muestran ni se guardan).
import { STRIPE_API_BASE, STRIPE_API_VERSION, STRIPE_TIMEOUT_MS } from './config.ts';

export type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };
export type FormParams = Record<string, FormValue>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Error de la API de Stripe (status 0 = no hubo respuesta: red o plazo vencido). */
export class StripeError extends Error {
  status: number;
  type: string;
  code: string | null;
  param: string | null;
  requestId: string | null;

  constructor(status: number, type: string, code: string | null, param: string | null, requestId: string | null) {
    super(`Stripe ${status || 'sin respuesta'}: ${code ?? type}`);
    this.name = 'StripeError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
    this.requestId = requestId;
  }

  /** Vale la pena reintentar (Stripe caído, saturado o sin red). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 409 || this.status === 429 || this.status >= 500;
  }

  /** El recurso no existe (404 o resource_missing). */
  get missing(): boolean {
    return this.status === 404 || this.code === 'resource_missing';
  }

  /** Descripción para los logs: nunca incluye el mensaje de Stripe. */
  describe(): string {
    return [`status=${this.status}`, `type=${this.type}`, this.code ? `code=${this.code}` : '', this.param ? `param=${this.param}` : '', this.requestId ? `request=${this.requestId}` : '']
      .filter(Boolean)
      .join(' ');
  }
}

function encodeKey(key: string): string {
  // Los corchetes quedan legibles (Stripe los acepta así o codificados).
  return encodeURIComponent(key).replace(/%5B/g, '[').replace(/%5D/g, ']');
}

/** Codifica parámetros anidados como los espera Stripe: a[b][0][c]=valor. Omite null y undefined. */
export function encodeForm(params: FormParams | null | undefined): string {
  const pairs: string[] = [];
  const add = (key: string, value: FormValue): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => add(`${key}[${i}]`, item));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
      return;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    pairs.push(`${encodeKey(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [key, value] of Object.entries(params ?? {})) add(key, value);
  return pairs.join('&');
}

/** Arma una ruta con un id de Stripe (lo valida y lo codifica). */
export function stripePath(prefix: string, id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_]{3,255}$/.test(id)) throw new StripeError(400, 'invalid_request_error', 'invalid_id', null, null);
  return `${prefix}${encodeURIComponent(id)}`;
}

export interface StripeRequestOptions {
  idempotencyKey?: string;
}

export interface StripeClient {
  get<T = Record<string, unknown>>(path: string, params?: FormParams): Promise<T>;
  post<T = Record<string, unknown>>(path: string, params?: FormParams, options?: StripeRequestOptions): Promise<T>;
}

export interface StripeClientOptions {
  secretKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
  apiVersion?: string;
  timeoutMs?: number;
}

export function createStripeClient(options: StripeClientOptions): StripeClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = (options.baseUrl ?? STRIPE_API_BASE).replace(/\/+$/, '');
  const apiVersion = options.apiVersion ?? STRIPE_API_VERSION;
  const timeoutMs = options.timeoutMs ?? STRIPE_TIMEOUT_MS;

  async function request<T>(method: 'GET' | 'POST', path: string, params?: FormParams, opts?: StripeRequestOptions): Promise<T> {
    if (!/^\/v1\/[A-Za-z0-9_/]+$/.test(path)) throw new StripeError(400, 'invalid_request_error', 'invalid_path', null, null);
    const form = encodeForm(params);
    const url = method === 'GET' && form ? `${base}${path}?${form}` : `${base}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.secretKey}`,
      'Stripe-Version': apiVersion,
      Accept: 'application/json',
    };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey.slice(0, 255);

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
  };
}
