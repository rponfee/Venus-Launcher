// Contrato: POST { method: 'GET' | 'POST', path: '/v1/...', body?: object }.
// Solo metadatos de Minecraft. La cuota y el acceso los decide curseforge_proxy_access.
// No guarda claves ni sesiones, no sigue redirecciones y no registra contenido.
const CF_ORIGIN = 'https://api.curseforge.com';
const BODY_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 10 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const UINT32 = 0xffffffff;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, x-client-info, content-type, x-supabase-api-version',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const JSON_HEADERS = { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export interface CurseforgeDeps {
  fetch: typeof fetch;
  supabaseUrl: string;
  anonKey: string;
  serviceKey: string;
  // Registro de diagnóstico (sin claves, sesiones ni contenido). Por defecto va a los logs de la función.
  log?: (entry: Record<string, string | number>) => void;
}

type ProxyRequest = { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uint = (value: unknown, min = 1, max = UINT32): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const queryInt = (value: string, min = 1, max = UINT32) => /^(0|[1-9][0-9]*)$/.test(value) && uint(Number(value), min, max);
const onlyKeys = (value: Record<string, unknown>, names: string[]) => Object.keys(value).every((name) => names.includes(name));
const fail = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code } }), { status, headers: { ...JSON_HEADERS, ...headers } });

function validQuery(query: URLSearchParams, kind: 'search' | 'categories' | 'files' | 'none'): boolean {
  const seen = new Set<string>();
  for (const [name, value] of query) {
    if (seen.has(name)) return false;
    seen.add(name);
    if (name === 'gameId' && (kind === 'search' || kind === 'categories') && value === '432') continue;
    if (name === 'classId' && (kind === 'search' || kind === 'categories') && queryInt(value)) continue;
    if (name === 'categoryId' && kind === 'search' && queryInt(value)) continue;
    if (name === 'searchFilter' && kind === 'search' && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)) continue;
    if (name === 'sortField' && kind === 'search' && ['1', '2', '3', '4', '5', '6', '7', '8', '11', '12'].includes(value)) continue;
    if (name === 'sortOrder' && kind === 'search' && ['asc', 'desc'].includes(value)) continue;
    if (kind === 'search' || kind === 'files') {
      if (name === 'gameVersion' && /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(value)) continue;
      if (name === 'modLoaderType' && queryInt(value, 1, 6)) continue;
      if (name === 'index' && queryInt(value, 0, 10000)) continue;
      if (name === 'pageSize' && queryInt(value, 1, 50)) continue;
    }
    return false;
  }
  if ((kind === 'search' || kind === 'categories') && query.get('gameId') !== '432') return false;
  return Number(query.get('index') ?? 0) + Number(query.get('pageSize') ?? 50) <= 10000;
}

function validateRequest(value: unknown): ProxyRequest | null {
  if (!record(value) || !onlyKeys(value, ['method', 'path', 'body'])) return null;
  if (value.method !== 'GET' && value.method !== 'POST') return null;
  if (typeof value.path !== 'string' || value.path.length > 4096 || /[#\\\s]/.test(value.path) || /%(?![0-9a-f]{2})/i.test(value.path)) return null;
  const question = value.path.indexOf('?');
  const pathname = question < 0 ? value.path : value.path.slice(0, question);
  const query = new URLSearchParams(question < 0 ? '' : value.path.slice(question + 1));
  if (value.method === 'GET') {
    if ('body' in value) return null;
    let kind: 'search' | 'categories' | 'files' | 'none' = 'none';
    if (pathname === '/v1/mods/search') kind = 'search';
    else if (pathname === '/v1/categories') kind = 'categories';
    else {
      const match = /^\/v1\/mods\/([1-9][0-9]*)(?:\/(description|files)(?:\/([1-9][0-9]*)(?:\/(changelog|download-url))?)?)?$/.exec(pathname);
      if (!match || !queryInt(match[1]) || (match[3] !== undefined && (!queryInt(match[3]) || match[2] !== 'files'))) return null;
      if (match[2] === 'files' && match[3] === undefined) kind = 'files';
    }
    if (!validQuery(query, kind)) return null;
    const encoded = query.toString();
    return { method: 'GET', path: pathname + (encoded ? '?' + encoded : '') };
  }
  if (question >= 0 || !record(value.body)) return null;
  const body = value.body;
  let name: string;
  let limit: number;
  let min = 1;
  if (pathname === '/v1/mods') {
    name = 'modIds'; limit = 500;
    if (!onlyKeys(body, [name, 'filterPcOnly']) || ('filterPcOnly' in body && typeof body.filterPcOnly !== 'boolean')) return null;
  } else if (pathname === '/v1/mods/files') {
    name = 'fileIds'; limit = 500;
    if (!onlyKeys(body, [name])) return null;
  } else if (pathname === '/v1/fingerprints/432') {
    name = 'fingerprints'; limit = 2000; min = 0;
    if (!onlyKeys(body, [name])) return null;
  } else return null;
  const ids = body[name];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > limit || !ids.every((id) => uint(id, min))) return null;
  return { method: 'POST', path: pathname, body };
}

class BodyLimitError extends Error {}

// Cuenta bytes de la transmisión, también cuando no hay Content-Length.
// El mismo plazo incluye fetch y la lectura del cuerpo, sin temporizadores por fragmento.
async function readText(input: Request | Response, limit: number, signal: AbortSignal): Promise<string> {
  const declared = input.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    void input.body?.cancel().catch(() => {});
    throw new BodyLimitError();
  }
  if (!input.body) return '';
  const reader = input.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new BodyLimitError();
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function discard(response: Response) {
  void response.body?.cancel().catch(() => {});
}

// Qué dijo CurseForge cuando rechazó un pedido (401/403). Antes todo se devolvía como "clave rechazada" y se
// tiraba la respuesta: desde afuera era imposible distinguir una clave mala de un corte de CloudFront o de un
// archivo cuyo autor no permite la descarga. Nunca se devuelve ni se registra su texto: solo esta clasificación.
//   badkey  -> la clave llegó y CurseForge dijo que falta o no sirve ("Forbidden: API Key missing or invalid")
//   blocked -> el pedido no llegó a la aplicación de CurseForge (página HTML o 403 vacío de CloudFront)
//   denied  -> CurseForge entendió el pedido pero ese recurso no se puede pedir (autor sin distribución)
type Rejection = 'badkey' | 'blocked' | 'denied';
const KEY_REJECTED = /api[\s_-]*key[^.\n]{0,40}(?:missing|invalid|not valid|wrong|expired)|invalid[\s_-]*api[\s_-]*key/i;
const CLASSIFY_LIMIT = 4096;

const headerNote = (response: Response, name: string): string => {
  const value = (response.headers.get(name) ?? '').trim();
  return /^[A-Za-z0-9 .,;=\/_-]{1,60}$/.test(value) ? value : '';
};

async function classifyRejection(response: Response, path: string, signal: AbortSignal, secrets: string[]): Promise<{ kind: Rejection; note: Record<string, string | number> }> {
  const contentType = headerNote(response, 'content-type').toLowerCase();
  const cache = headerNote(response, 'x-cache').toLowerCase();
  const via = headerNote(response, 'via').toLowerCase();
  let text = '';
  let large = false;
  try {
    text = await readText(response, CLASSIFY_LIMIT, signal);
  } catch (error) {
    large = error instanceof BodyLimitError;
    discard(response);
  }
  const html = contentType.includes('html') || /^\s*<(?:!doctype|html|head|body)/i.test(text);
  const fromEdge = cache.includes('cloudfront') || via.includes('cloudfront');
  const resource = /\/download-url$|\/files\/\d+(?:\/changelog)?$/.test(path.split('?')[0]) ? 'file' : 'other';
  let kind: Rejection;
  if (KEY_REJECTED.test(text)) kind = 'badkey';
  else if (html || (large && !text) || (!text.trim() && fromEdge)) kind = 'blocked';
  else kind = resource === 'file' ? 'denied' : 'badkey';
  const note: Record<string, string | number> = { status: response.status, kind, resource, type: contentType, server: headerNote(response, 'server'), edge: fromEdge ? 1 : 0, bytes: text.length };
  for (const [name, value] of Object.entries(note)) if (typeof value === 'string' && secrets.some((secret) => secret && value.includes(secret))) note[name] = '';
  return { kind, note };
}

// Evita devolver una clave incluso si una respuesta JSON válida la incluyera por error.
// Se revisan valores decodificados: una representación escapada no cambia el resultado.
function includesSecret(value: unknown, secrets: string[]): boolean {
  const pending: unknown[] = [value];
  const contains = (text: string) => secrets.some((secret) => secret && text.includes(secret));
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') { if (contains(item)) return true; }
    else if (Array.isArray(item)) { for (const child of item) pending.push(child); }
    else if (record(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (contains(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

export function createCurseforgeHandler(deps: CurseforgeDeps) {
  let supabase = '';
  try {
    const url = new URL(deps.supabaseUrl);
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) supabase = url.origin;
  } catch { /* Configuración incompleta: respuesta fija, sin exponer valores. */ }

  const report = (entry: Record<string, string | number>) => {
    try { (deps.log ?? ((value) => console.error(JSON.stringify(value))))(entry); } catch { /* el diagnóstico nunca rompe la respuesta */ }
  };

  return async function handle(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== 'POST') return fail(405, 'method_not_allowed', { allow: 'POST, OPTIONS' });
    const token = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return fail(401, 'unauthorized');
    if (!supabase || !deps.anonKey || !deps.serviceKey) return fail(503, 'not_configured');
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail(415, 'unsupported_media_type');
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    let payload: unknown;
    try {
      payload = JSON.parse(await readText(request, BODY_LIMIT, signal));
    } catch (error) {
      return error instanceof BodyLimitError ? fail(413, 'body_too_large') : signal.aborted ? fail(408, 'timeout') : fail(400, 'bad_request');
    }
    const proxy = validateRequest(payload);
    if (!proxy) return fail(400, 'bad_request');

    let user: unknown;
    try {
      const response = await deps.fetch(supabase + '/auth/v1/user', {
        method: 'GET', headers: { apikey: deps.anonKey, authorization: 'Bearer ' + token, accept: 'application/json' },
        redirect: 'error', signal,
      });
      if (!response.ok) {
        discard(response);
        return [401, 403].includes(response.status) ? fail(401, 'unauthorized') : fail(503, 'unavailable');
      }
      user = JSON.parse(await readText(response, BODY_LIMIT, signal));
    } catch {
      return fail(503, 'unavailable');
    }
    if (!record(user) || typeof user.id !== 'string' || !UUID.test(user.id) || user.is_anonymous === true) return fail(401, 'unauthorized');

    let access: unknown;
    try {
      const response = await deps.fetch(supabase + '/rest/v1/rpc/curseforge_proxy_access', {
        method: 'POST',
        headers: { apikey: deps.serviceKey, authorization: 'Bearer ' + deps.serviceKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ p_user: user.id }), redirect: 'error', signal,
      });
      if (!response.ok) { discard(response); return fail(503, 'unavailable'); }
      access = JSON.parse(await readText(response, BODY_LIMIT, signal));
    } catch {
      return fail(503, 'unavailable');
    }
    if (!record(access)) return fail(503, 'unavailable');
    if ('error' in access) {
      if (access.error === 'not_configured') return fail(503, 'not_configured');
      if (access.error === 'forbidden') return fail(403, 'forbidden');
      if (access.error === 'rate_limit') return fail(429, 'rate_limit', { 'retry-after': '60' });
      return fail(503, 'unavailable');
    }
    if (typeof access.key !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(access.key)) return fail(503, 'not_configured');
    const apiKey = access.key;

    let response: Response;
    try {
      response = await deps.fetch(CF_ORIGIN + proxy.path, {
        method: proxy.method,
        headers: { 'x-api-key': apiKey, accept: 'application/json', ...(proxy.body ? { 'content-type': 'application/json' } : {}) },
        ...(proxy.body ? { body: JSON.stringify(proxy.body) } : {}),
        redirect: 'error', signal,
      });
    } catch {
      if (!signal.aborted) report({ evt: 'curseforge.network' });
      return signal.aborted ? fail(504, 'timeout') : fail(502, 'upstream');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const { kind, note } = await classifyRejection(response, proxy.path, signal, [apiKey, deps.serviceKey, token]);
        report({ evt: 'curseforge.rejected', ...note });
        return fail(403, kind);
      }
      discard(response);
      if (response.status === 429) { report({ evt: 'curseforge.limited', status: 429 }); return fail(429, 'rate_limit', { 'retry-after': '60' }); }
      if (response.status === 404) return fail(404, 'not_found');
      report({ evt: 'curseforge.upstream', status: response.status });
      return fail(response.status >= 400 && response.status <= 599 ? response.status : 502, 'upstream');
    }
    if (response.status === 204 || response.status === 205) {
      discard(response);
      return new Response(null, { status: response.status, headers: JSON_HEADERS });
    }
    try {
      const text = await readText(response, RESPONSE_LIMIT, signal);
      const data: unknown = JSON.parse(text);
      if (includesSecret(data, [apiKey, deps.serviceKey, token])) return fail(502, 'bad_response');
      return new Response(text, { status: response.status, headers: JSON_HEADERS });
    } catch (error) {
      return signal.aborted ? fail(504, 'timeout') : fail(502, error instanceof BodyLimitError ? 'response_too_large' : 'bad_response');
    }
  };
}
