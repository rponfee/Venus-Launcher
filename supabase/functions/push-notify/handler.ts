// Manda los avisos de la app del celular.
//   GET  -> { publicKey }: la clave pública de VAPID, para que la app se anote. No es secreta.
//   POST -> lo llama el trigger de 0035 con pg_net: { user, kind, key } y el secreto compartido. Nunca lleva texto.
// Los límites están en la base (push_claim, service role): uno cada 2 minutos por conversación o remitente y 30 por hora.
// Si el servicio de push dice 404 o 410, el celular ya no existe y se borra (push_drop).
// Los registros no llevan endpoints ni usuarios: un endpoint alcanza para mandarle avisos a esa persona.
import { endpointOk, importVapidKey, pushTopic, sameSecret, vapidJwt } from './vapid.ts';

export interface PushDeps {
  secret: string;
  vapidPublic: string;
  vapidPrivate: string;
  subject: string;
  supabaseUrl: string;
  serviceKey: string;
  fetch?: typeof fetch;
  nowMs?: () => number;
  log?: (msg: string) => void;
  timeoutMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = new Set(['message', 'request', 'clip']);
const MAX_BODY = 400;
const TTL_SECONDS = 86400; // un día: si el celular está apagado más que eso, el aviso ya no sirve

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'apikey, authorization, content-type' };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (status: number, code: string) => json(status, { error: { code } });

interface Claim {
  allowed: boolean;
  reason?: string;
  subs?: { id: string; endpoint: string }[];
}

export function createPushHandler(deps: PushDeps) {
  const http = deps.fetch ?? fetch;
  const now = deps.nowMs ?? (() => Date.now());
  const log = deps.log ?? ((msg: string) => console.log(`[push-notify] ${msg}`));
  const timeoutMs = deps.timeoutMs ?? 8000;
  let keyPromise: Promise<CryptoKey | null> | null = null;
  const signingKey = () => {
    if (!keyPromise) keyPromise = importVapidKey({ publicKey: deps.vapidPublic, privateKey: deps.vapidPrivate, subject: deps.subject });
    return keyPromise;
  };

  async function rpc(name: string, args: unknown): Promise<unknown> {
    const res = await http(`${deps.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: deps.serviceKey, authorization: `Bearer ${deps.serviceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`${name}: ${res.status}`);
    return await res.json();
  }

  // 'ok' | 'gone' | 'fail'
  async function sendOne(key: CryptoKey, endpoint: string, topic: string): Promise<'ok' | 'gone' | 'fail'> {
    const host = new URL(endpoint).host;
    const jwt = await vapidJwt(key, endpoint, deps.subject, now());
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await http(endpoint, {
        method: 'POST',
        headers: {
          authorization: `vapid t=${jwt}, k=${deps.vapidPublic}`,
          ttl: String(TTL_SECONDS),
          urgency: 'high',
          topic,
          'content-length': '0',
        },
        signal: abort.signal,
        redirect: 'error',
      });
      if (res.status === 404 || res.status === 410) return 'gone';
      if (res.ok) return 'ok';
      log(`el servicio de push respondió ${res.status} (${host})`);
      return 'fail';
    } catch (err) {
      log(`no se pudo llegar al servicio de push (${host}): ${(err as Error)?.name ?? 'error'}`);
      return 'fail';
    } finally {
      clearTimeout(timer);
    }
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method === 'GET') {
      if (!deps.vapidPublic || !(await signingKey())) return fail(503, 'not_configured');
      return json(200, { publicKey: deps.vapidPublic }, { ...CORS, 'cache-control': 'public, max-age=300' });
    }
    if (req.method !== 'POST') return fail(405, 'bad_request');

    if (!(await sameSecret(req.headers.get('x-venus-push-secret') ?? '', deps.secret))) return fail(401, 'unauthorized');

    const raw = await req.text();
    if (raw.length > MAX_BODY) return fail(413, 'bad_request');
    let body: { user?: unknown; kind?: unknown; key?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, 'bad_request');
    }
    const { user, kind, key } = body ?? {};
    if (typeof user !== 'string' || !UUID.test(user) || typeof kind !== 'string' || !KINDS.has(kind) || typeof key !== 'string' || !UUID.test(key)) {
      return fail(400, 'bad_request');
    }

    const signing = await signingKey();
    if (!signing) {
      log('faltan las claves VAPID o no son válidas');
      return fail(503, 'not_configured');
    }

    let claim: Claim;
    try {
      claim = (await rpc('push_claim', { p_user: user, p_kind: kind, p_key: key })) as Claim;
    } catch (err) {
      log(`no se pudo consultar la base: ${(err as Error)?.message ?? 'error'}`);
      return fail(503, 'db_unavailable');
    }
    if (!claim?.allowed) return json(200, { ok: true, sent: 0, skipped: claim?.reason ?? 'unknown' });

    const subs = (claim.subs ?? []).filter((s) => endpointOk(s?.endpoint));
    const topic = await pushTopic(`${kind}:${key}`);
    const results = await Promise.all(subs.map(async (s) => ({ id: s.id, result: await sendOne(signing, s.endpoint, topic) })));
    const gone = results.filter((r) => r.result === 'gone').map((r) => r.id);
    if (gone.length) {
      try {
        await rpc('push_drop', { p_ids: gone });
      } catch (err) {
        log(`no se pudieron borrar los vencidos: ${(err as Error)?.message ?? 'error'}`);
      }
    }
    const sent = results.filter((r) => r.result === 'ok').length;
    return json(200, { ok: true, sent, dropped: gone.length, failed: results.length - sent - gone.length });
  };
}
