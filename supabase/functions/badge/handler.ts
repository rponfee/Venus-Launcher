// Anotar una cuenta de Minecraft en la insignia de Venus (migración 0019_insignia.sql, guía docs/insignia.md).
// El launcher pide un desafío (rpc badge_challenge), el juego entra al servidor de sesiones de Mojang con ese desafío
// como serverId (POST /session/minecraft/join, igual que al entrar a un servidor premium) y después llama acá.
// Esta función le pregunta a Mojang si esa cuenta entró con ese desafío (hasJoined): si sí, la cuenta de Minecraft
// es de quien llama y se anota. El token de Minecraft nunca llega a este servidor.
// Sin Deno ni Supabase: index.ts le pasa las dependencias reales y las pruebas, dobles (tests/badge.test.ts).

export type AuthResult =
  | { status: 'ok'; userId: string }
  | { status: 'invalid' | 'forbidden' | 'unavailable' };

export interface MojangProfile { id: string; name: string }

export interface BadgeDeps {
  verifyUser: (token: string) => Promise<AuthResult>;
  // true si el desafío era de ese usuario y no había vencido (lo gasta igual).
  takeChallenge: (userId: string, serverId: string) => Promise<boolean>;
  // El perfil si la cuenta entró con ese serverId; null si no. Lanza si Mojang no responde.
  hasJoined: (name: string, serverId: string) => Promise<MojangProfile | null>;
  // 'ok' | 'too_many_accounts' | 'user_banned'
  enroll: (userId: string, uuid: string) => Promise<string>;
}

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?4[0-9a-f]{3}-?[89ab][0-9a-f]{3}-?[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9_]{1,16}$/;
const SERVER_ID = /^[0-9a-f]{40}$/;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (status: number, code: string) => json(status, { error: { code } });

// "0123...cdef" o con guiones -> "01234567-89ab-4def-8123-456789abcdef" (minúsculas); null si no es un UUID v4.
export function normalizeUuid(raw: unknown): string | null {
  if (typeof raw !== 'string' || !UUID.test(raw)) return null;
  const h = raw.replace(/-/g, '').toLowerCase();
  if (h.length !== 32) return null;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function bearerToken(header: string | null): string | null {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/i.exec(header ?? '');
  return m ? m[1] : null;
}

export async function mojangHasJoined(fetchFn: typeof fetch, name: string, serverId: string): Promise<MojangProfile | null> {
  const url = `https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${encodeURIComponent(name)}&serverId=${encodeURIComponent(serverId)}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`mojang ${res.status}`);
  const body = await res.json();
  return typeof body?.id === 'string' ? { id: body.id, name: String(body.name ?? '') } : null;
}

export function createBadgeHandler(deps: BadgeDeps) {
  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (req.method !== 'POST') return fail(405, 'bad_request');
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

    let body: Record<string, unknown>;
    try {
      const text = await req.text();
      if (text.length > 1024) return fail(400, 'bad_request');
      body = JSON.parse(text);
    } catch {
      return fail(400, 'bad_request');
    }
    const uuid = normalizeUuid(body?.uuid);
    const name = typeof body?.name === 'string' && NAME.test(body.name) ? body.name : null;
    const serverId = typeof body?.serverId === 'string' && SERVER_ID.test(body.serverId) ? body.serverId : null;
    if (!uuid || !name || !serverId) return fail(400, 'bad_request');

    let taken: boolean;
    try {
      taken = await deps.takeChallenge(auth.userId, serverId);
    } catch {
      return fail(500, 'server_error');
    }
    if (!taken) return fail(409, 'challenge_invalid');
    let profile: MojangProfile | null;
    try {
      profile = await deps.hasJoined(name, serverId);
    } catch {
      return fail(503, 'mojang_unavailable');
    }
    if (!profile || normalizeUuid(profile.id) !== uuid) return fail(403, 'not_verified');

    let result: string;
    try {
      result = await deps.enroll(auth.userId, uuid);
    } catch {
      return fail(500, 'server_error');
    }
    if (result === 'too_many_accounts') return fail(409, 'too_many_accounts');
    if (result === 'user_banned') return fail(403, 'user_banned');
    if (result !== 'ok') return fail(500, 'server_error');
    return json(200, { uuid, name: profile.name || name });
  };
}
