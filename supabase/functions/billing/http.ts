// Ayudantes HTTP de las funciones de pagos ("billing" y "stripe-webhook"). Sin dependencias externas.
import { CORS_HEADERS } from './config.ts';

export function json(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(extraHeaders ?? {}),
    },
  });
}

/** Token de "Authorization: Bearer <jwt>" (o null). */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
  if (!match || match[1].length > 8192) return null;
  return match[1];
}

export type BytesRead = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'too_large' | 'unreadable' };

/** Lee el cuerpo crudo sin pasar `limit` bytes (corta apenas se pasa). El webhook firma estos bytes exactos. */
export async function readBodyBytes(req: Request, limit: number): Promise<BytesRead> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: 'too_large' };
  if (!req.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        reader.cancel().catch(() => {});
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** UTF-8 estricto (null si los bytes no son texto válido). */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Código de error de una falla de la base (para los logs), sin datos. */
export function errorCode(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code ? code.slice(0, 40) : 'sin-codigo';
}

export function errorName(err: unknown): string {
  if (err instanceof Error) return err.name.slice(0, 60);
  return typeof err;
}
