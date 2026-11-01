// Claves temporales para el servidor TURN del Voice Chat (coturn con use-auth-secret + static-auth-secret, la "TURN REST
// API"): usuario = "<vence en segundos Unix>:<id del usuario>", clave = base64(HMAC-SHA1(secreto, usuario)). coturn
// rechaza la clave cuando pasa la hora del usuario, así que el secreto nunca sale del servidor ni va en el launcher.
// Sin Deno ni Supabase: index.ts le pasa las dependencias reales y las pruebas, dobles (tests/voice-turn.test.ts).

export type AuthResult =
  | { status: 'ok'; userId: string }
  | { status: 'invalid' | 'forbidden' | 'unavailable' };

export interface TurnDeps {
  secret: string;
  urls: string[];
  ttlSeconds: number;
  verifyUser: (token: string) => Promise<AuthResult>;
  nowMs?: () => number;
}

const ICE_URL = /^(turns?|stun):[^\s,]{1,290}$/i;
export const DEFAULT_TTL = 24 * 60 * 60; // una sesión de voz larga entra entera: coturn revalida al renovar la reserva
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (status: number, code: string) => json(status, { error: { code } });

// "turn:a:3478?transport=udp, turn:a:3478?transport=tcp" -> lista válida (máximo 8, como el launcher)
export function parseUrls(raw: string): string[] {
  return raw.split(',').map((u) => u.trim()).filter((u) => ICE_URL.test(u)).slice(0, 8);
}

export function parseTtl(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 600 && n <= 172800 ? Math.floor(n) : DEFAULT_TTL;
}

export async function turnCredential(secret: string, username: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(username)));
  let bin = '';
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin);
}

function bearerToken(header: string | null): string | null {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/i.exec(header ?? '');
  return m ? m[1] : null;
}

export function createTurnHandler(deps: TurnDeps) {
  const now = deps.nowMs ?? (() => Date.now());
  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (req.method !== 'POST' && req.method !== 'GET') return fail(405, 'bad_request');
    const token = bearerToken(req.headers.get('authorization'));
    if (!token) return fail(401, 'unauthorized');
    let auth: AuthResult;
    try {
      auth = await deps.verifyUser(token);
    } catch {
      auth = { status: 'unavailable' };
    }
    if (auth.status === 'invalid') return fail(401, 'unauthorized');
    if (auth.status === 'forbidden') return fail(403, 'unauthorized');
    if (auth.status !== 'ok') return fail(503, 'auth_unavailable');
    // Sin servidor configurado: lista vacía (el Voice Chat sigue solo con STUN, que alcanza en casi todas las redes).
    if (!deps.secret || !deps.urls.length) return json(200, { iceServers: [], expiresAt: null });
    const expires = Math.floor(now() / 1000) + deps.ttlSeconds;
    const username = `${expires}:${auth.userId}`;
    const credential = await turnCredential(deps.secret, username);
    return json(200, {
      iceServers: [{ urls: deps.urls, username, credential }],
      expiresAt: new Date(expires * 1000).toISOString(),
    });
  };
}
