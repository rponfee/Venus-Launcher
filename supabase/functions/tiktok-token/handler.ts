// Edge Function "tiktok-token": el intercambio de tokens de TikTok para la subida de clips del launcher. TikTok pide que
// esas llamadas salgan de un servidor con el client_secret, que nunca puede ir en el instalador. Solo pasa la llamada:
// no guarda ni registra ningun token. Pide sesion de Venus para no ser un relevo abierto. Guia: docs/wip/clips-33.md.
//   POST { action: 'exchange', code, codeVerifier, redirectUri } | { action: 'refresh', refreshToken } | { action: 'revoke', token }
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';
const REDIRECT = /^http:\/\/127\.0\.0\.1:\d{2,5}\/callback\/$/;
const TOKEN = /^[\w.~*!-]{1,4096}$/;
const FORM = { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' };
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (status: number, code: string) => json(status, { error: { code } });

export interface TokenDeps {
  fetch: typeof fetch;
  clientKey: string;
  clientSecret: string;
  // 'ok' con sesion valida; 'invalid' o 'forbidden' sin ella (anonimos); 'unavailable' si Auth no contesta
  verifyUser: (token: string) => Promise<'ok' | 'invalid' | 'forbidden' | 'unavailable'>;
}

const bearer = (header: string | null) => /^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/i.exec(header ?? '')?.[1] ?? null;
const str = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null);

export function createTokenHandler(deps: TokenDeps) {
  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (req.method !== 'POST') return fail(405, 'bad_request');
    if (!deps.clientKey || !deps.clientSecret) return fail(503, 'not_configured');
    const token = bearer(req.headers.get('authorization'));
    if (!token) return fail(401, 'unauthorized');
    const auth = await deps.verifyUser(token);
    if (auth === 'unavailable') return fail(503, 'unavailable');
    if (auth !== 'ok') return fail(401, 'unauthorized');

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return fail(400, 'bad_request');
    }
    const base = { client_key: deps.clientKey, client_secret: deps.clientSecret };
    let url = TOKEN_URL;
    let form: Record<string, string>;
    if (body?.action === 'exchange') {
      const code = str(body.code, TOKEN);
      const verifier = str(body.codeVerifier, /^[A-Za-z0-9._~-]{43,128}$/);
      const redirect = str(body.redirectUri, REDIRECT);
      if (!code || !verifier || !redirect) return fail(400, 'bad_request');
      form = { ...base, code, grant_type: 'authorization_code', redirect_uri: redirect, code_verifier: verifier };
    } else if (body?.action === 'refresh') {
      const refresh = str(body.refreshToken, TOKEN);
      if (!refresh) return fail(400, 'bad_request');
      form = { ...base, grant_type: 'refresh_token', refresh_token: refresh };
    } else if (body?.action === 'revoke') {
      const value = str(body.token, TOKEN);
      if (!value) return fail(400, 'bad_request');
      url = REVOKE_URL;
      form = { ...base, token: value };
    } else return fail(400, 'bad_request');

    let res: Response;
    try {
      res = await deps.fetch(url, { method: 'POST', headers: FORM, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(15000) });
    } catch {
      return fail(502, 'upstream');
    }
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (body.action === 'revoke') return res.ok ? json(200, { ok: true }) : fail(502, 'upstream');
    if (!res.ok || !data?.access_token) {
      // TikTok contesta 200 con { error, error_description } si el code o el token de renovacion no sirven
      return data?.error === 'invalid_grant' ? fail(400, 'invalid_grant') : fail(502, 'upstream');
    }
    return json(200, { access_token: data.access_token, refresh_token: data.refresh_token ?? null, open_id: data.open_id ?? null, scope: data.scope ?? null, expires_in: data.expires_in ?? null, refresh_expires_in: data.refresh_expires_in ?? null });
  };
}
