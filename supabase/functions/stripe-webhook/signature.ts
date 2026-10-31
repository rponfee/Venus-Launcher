// Verificación de la cabecera Stripe-Signature con Web Crypto (sin el SDK de Stripe).
// Formato: "t=<unix>,v1=<hex>,v1=<hex>,v0=<hex>". La firma es HMAC-SHA256 con el secreto del endpoint
// (whsec_..., la cadena completa) sobre "<t>.<cuerpo crudo>". Se aceptan todas las v1 (Stripe manda más de
// una mientras se rota el secreto), se comparan en tiempo constante y se rechazan las de más de 300 s.
// Sin dependencias externas: anda igual en Deno (Supabase) y en Node (pruebas).

const encoder = new TextEncoder();

export interface ParsedSignature {
  timestamp: number | null;
  v1: string[];
}

export type VerifyFailure = 'no_secret' | 'missing_header' | 'no_timestamp' | 'no_signature' | 'mismatch' | 'timestamp_out_of_range';
export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: VerifyFailure };

/** Lee la cabecera. Ignora las partes que no entiende (v0, esquemas futuros) y las firmas mal formadas. */
export function parseSignatureHeader(header: string | null | undefined): ParsedSignature {
  const out: ParsedSignature = { timestamp: null, v1: [] };
  if (typeof header !== 'string' || !header || header.length > 8192) return out;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (out.timestamp === null && /^\d{1,12}$/.test(value)) out.timestamp = Number(value);
    } else if (key === 'v1' && /^[0-9a-fA-F]{64}$/.test(value) && out.v1.length < 16) {
      out.v1.push(value.toLowerCase());
    }
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Comparación en tiempo constante (para el mismo largo: recorre todo sin cortar en la primera diferencia). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** "<t>." + cuerpo crudo, en bytes (sin volver a codificar el cuerpo). */
export function signedPayload(timestamp: number, body: Uint8Array): Uint8Array {
  const prefix = encoder.encode(`${timestamp}.`);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

export async function hmacSha256(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data as BufferSource));
}

/**
 * Verifica la firma de un evento. `secrets` puede tener más de un whsec_ (rotación, o los endpoints de prueba y
 * de producción apuntando a la misma función). Primero la firma y después la antigüedad, como el SDK de Stripe.
 */
export async function verifyStripeSignature(
  body: Uint8Array,
  header: string | null | undefined,
  secrets: readonly string[],
  options: { toleranceSec?: number; nowMs?: number } = {},
): Promise<VerifyResult> {
  if (!secrets.length) return { ok: false, reason: 'no_secret' };
  if (!header) return { ok: false, reason: 'missing_header' };
  const parsed = parseSignatureHeader(header);
  if (parsed.timestamp === null) return { ok: false, reason: 'no_timestamp' };
  if (!parsed.v1.length) return { ok: false, reason: 'no_signature' };

  const payload = signedPayload(parsed.timestamp, body);
  const candidates = parsed.v1.map(hexToBytes).filter((b): b is Uint8Array => b !== null);
  let match = false;
  for (const secret of secrets) {
    const expected = await hmacSha256(secret, payload);
    // Sin cortar al primer acierto: el tiempo no depende de cuál firma coincide.
    for (const candidate of candidates) match = timingSafeEqual(expected, candidate) || match;
  }
  if (!match) return { ok: false, reason: 'mismatch' };

  const tolerance = options.toleranceSec ?? 300;
  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - parsed.timestamp) > tolerance) return { ok: false, reason: 'timestamp_out_of_range' };
  return { ok: true, timestamp: parsed.timestamp };
}

/** Cabecera Stripe-Signature para un cuerpo (pruebas y herramientas locales; Stripe la arma igual). */
export async function signatureHeader(secret: string, timestamp: number, body: Uint8Array | string): Promise<string> {
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;
  const mac = await hmacSha256(secret, signedPayload(timestamp, bytes));
  return `t=${timestamp},v1=${bytesToHex(mac)}`;
}
