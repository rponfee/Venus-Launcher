// Web Push sin contenido: solo el JWT de VAPID (RFC 8292), firmado con WebCrypto. Sin carga, no hay nada que cifrar:
// el aviso llega vacío y el service worker de la app consulta lo nuevo con la sesión de la persona.
// Sin Deno ni Supabase: lo prueba tests/push-notify.test.ts con claves generadas en la prueba.

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text: string): Uint8Array {
  const clean = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Los mismos servicios que acepta private.push_endpoint_ok (0035). Se vuelve a mirar acá: esta función hace el pedido.
const ENDPOINT = /^https:\/\/(fcm\.googleapis\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*notify\.windows\.com)\/[!-~]+$/;

export function endpointOk(endpoint: unknown): endpoint is string {
  return typeof endpoint === 'string' && endpoint.length >= 24 && endpoint.length <= 1024 && ENDPOINT.test(endpoint);
}

export interface VapidKeys {
  publicKey: string; // punto P-256 sin comprimir (65 bytes) en base64url, el que usa el navegador
  privateKey: string; // d (32 bytes) en base64url
  subject: string; // mailto: o https: (lo exige el estándar; Apple lo rechaza si falta)
}

// Lee las claves en el formato de los secretos. null si no sirven.
export async function importVapidKey(keys: VapidKeys): Promise<CryptoKey | null> {
  try {
    const point = fromB64url(keys.publicKey);
    const d = fromB64url(keys.privateKey);
    if (point.length !== 65 || point[0] !== 4 || d.length !== 32) return null;
    return await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64url(point.slice(1, 33)), y: b64url(point.slice(33, 65)), ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
  } catch {
    return null;
  }
}

// Una hora alcanza: se firma en cada envío. Apple y Mozilla rechazan los vencimientos muy largos.
const TTL_JWT_SECONDS = 3600;

export async function vapidJwt(key: CryptoKey, endpoint: string, subject: string, nowMs: number): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + TTL_JWT_SECONDS,
    sub: subject,
  })));
  // WebCrypto ya devuelve la firma como r||s, que es lo que pide JWS (ES256)
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));
  return `${head}.${claims}.${b64url(sig)}`;
}

// Hasta 32 caracteres base64url: el servicio de push reemplaza el aviso viejo si todavía no lo entregó.
export async function pushTopic(scope: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(scope)));
  return b64url(hash).slice(0, 32);
}

// Compara sin cortar en el primer byte distinto.
export async function sameSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
