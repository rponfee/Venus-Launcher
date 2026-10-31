// Piezas comunes de los clientes de Mercado Pago y PayPal (fetch con tope de tiempo y errores sin datos sensibles).

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const PROVIDER_TIMEOUT_MS = 15000;

export class ProviderError extends Error {
  provider: string;
  status: number;
  code: string | null;
  constructor(provider: string, status: number, code: string | null) {
    super(`${provider} ${status || 'sin respuesta'}${code ? `: ${code}` : ''}`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.code = code;
  }
  /** Credenciales rechazadas por el proveedor. */
  get auth(): boolean {
    return this.status === 401 || this.status === 403;
  }
  get missing(): boolean {
    return this.status === 404;
  }
  /** Para los logs: nunca incluye el mensaje ni el cuerpo del proveedor. */
  describe(): string {
    return `${this.provider} status=${this.status}${this.code ? ` code=${this.code}` : ''}`;
  }
}

/** Pedido JSON. Devuelve el cuerpo ya leído; lanza ProviderError si no es 2xx. */
export async function requestJson(
  provider: string,
  doFetch: FetchLike,
  url: string,
  init: RequestInit,
  codeOf: (body: Record<string, unknown> | null) => string | null,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    throw new ProviderError(provider, 0, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = await res.json();
    body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw new ProviderError(provider, res.status, codeOf(body));
  if (!body) throw new ProviderError(provider, res.status, 'invalid_response');
  return body;
}

export const short = (v: unknown, max = 80): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);

export function money(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}
