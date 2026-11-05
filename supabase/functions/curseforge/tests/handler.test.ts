// Regresiones locales con datos sintéticos y fetch doble: no se contacta ningún servicio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { createCurseforgeHandler } from '../handler.ts';
import type { CurseforgeDeps } from '../handler.ts';

const SB = 'https://venus-fixture.invalid';
const CF = 'https://api.curseforge.com';
const USER = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'fixture-user-token-'.repeat(3);
const ANON = 'fixture-anon-key';
const SERVICE = 'fixture-service-key';
const KEY = 'fixture-curseforge-key';
const OK = { data: [{ id: 42, name: 'Example mod' }], pagination: { index: 0, pageSize: 1, totalCount: 1 } };
type Call = { url: string; init: RequestInit; headers: Headers };
type Reply = (call: Call) => Response | Promise<Response>;
type Options = { auth?: Reply; rpc?: Reply; upstream?: Reply; deps?: Partial<CurseforgeDeps> };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function setup(options: Options = {}) {
  const calls: Call[] = [];
  const handler = createCurseforgeHandler({
    supabaseUrl: SB, anonKey: ANON, serviceKey: SERVICE,
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const call = { url: String(input), init, headers: new Headers(init.headers) };
      calls.push(call);
      if (call.url === SB + '/auth/v1/user') return options.auth ? options.auth(call) : json({ id: USER, is_anonymous: false });
      if (call.url === SB + '/rest/v1/rpc/curseforge_proxy_access') return options.rpc ? options.rpc(call) : json({ key: KEY });
      assert.equal(new URL(call.url).origin, CF);
      return options.upstream ? options.upstream(call) : json(OK);
    }) as typeof fetch,
    ...options.deps,
  });
  return { handler, calls };
}

function request(payload: unknown = { method: 'GET', path: '/v1/mods/42' }, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request('https://edge-fixture.invalid/curseforge', {
    method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload), signal,
  });
}

function assertCors(response: Response) {
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(response.headers.get('access-control-allow-methods')?.split(',').map((value) => value.trim()), ['POST', 'OPTIONS']);
  assert.deepEqual(response.headers.get('access-control-allow-headers')?.split(',').map((value) => value.trim()),
    ['authorization', 'apikey', 'x-client-info', 'content-type', 'x-supabase-api-version']);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
}

async function errorIs(response: Response, status: number, code: string) {
  assertCors(response);
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error: { code } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
}

const getPaths = [
  '/v1/mods/search?gameId=432&classId=6&searchFilter=mapa%20de%20aldeas&categoryId=1&gameVersion=1.21.1&modLoaderType=4&sortField=6&sortOrder=desc&index=0&pageSize=50',
  '/v1/categories?gameId=432&classId=4471',
  '/v1/mods/42',
  '/v1/mods/42/description',
  '/v1/mods/42/files?gameVersion=24w14a&modLoaderType=6&index=9950&pageSize=50',
  '/v1/mods/42/files/99',
  '/v1/mods/42/files/99/changelog',
  '/v1/mods/42/files/99/download-url',
];
for (const path of getPaths) {
  test('GET permitido: ' + path.split('?')[0], async () => {
    const { handler, calls } = setup();
    const res = await handler(request({ method: 'GET', path }));
    assert.equal(res.status, 200);
    assertCors(res);
    assert.deepEqual(await res.json(), OK);
    assert.equal(calls.length, 3);
    assert.equal(new URL(calls[2].url).pathname, path.split('?')[0]);
    assert.deepEqual([...new URL(calls[2].url).searchParams], [...new URL(path, CF).searchParams]);
    assert.equal(calls[2].init.method, 'GET');
    assert.equal(calls[2].init.body, undefined);
  });
}

for (const [path, body] of [
  ['/v1/mods', { modIds: [42, 99], filterPcOnly: true }],
  ['/v1/mods/files', { fileIds: [123, 456] }],
  ['/v1/fingerprints/432', { fingerprints: [0, 12345, 0xffffffff] }],
] as const) {
  test('POST permitido: ' + path, async () => {
    const { handler, calls } = setup();
    const res = await handler(request({ method: 'POST', path, body }));
    assert.equal(res.status, 200);
    assert.equal(calls[2].url, CF + path);
    assert.equal(calls[2].init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[2].init.body)), body);
  });
}

test('verifica identidad con Auth; la RPC recibe solo el UUID confirmado y cada servicio su credencial', async () => {
  const { handler, calls } = setup();
  await handler(request(undefined, { apikey: 'fixture-client-key', 'x-client-info': 'fixture-desktop' }));
  assert.equal(calls[0].headers.get('authorization'), 'Bearer ' + TOKEN);
  assert.equal(calls[0].headers.get('apikey'), ANON);
  assert.equal(calls[1].headers.get('authorization'), 'Bearer ' + SERVICE);
  assert.equal(calls[1].headers.get('apikey'), SERVICE);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { p_user: USER });
  assert.equal(calls[2].headers.get('x-api-key'), KEY);
  assert.equal(calls[2].headers.get('authorization'), null);
  assert.equal(calls[2].headers.get('apikey'), null);
  assert.equal(calls[2].headers.get('x-client-info'), null);
  for (const call of calls) {
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.signal, calls[0].init.signal);
  }
});

test('la clave se vuelve a consultar en cada pedido y no usa un endpoint de estado', async () => {
  let count = 0;
  const { handler, calls } = setup({ rpc: () => json({ key: 'fixture-key-' + ++count }) });
  await handler(request()); await handler(request());
  assert.equal(calls.length, 6);
  assert.equal(calls[2].headers.get('x-api-key'), 'fixture-key-1');
  assert.equal(calls[5].headers.get('x-api-key'), 'fixture-key-2');
});

test('sin bearer no consulta Auth ni la RPC', async () => {
  const { handler, calls } = setup();
  await errorIs(await handler(request(undefined, { authorization: '' })), 401, 'unauthorized');
  assert.equal(calls.length, 0);
});

for (const [label, reply] of [
  ['sesión vencida', () => json({ message: 'Session expired' }, 401)],
  ['sesión rechazada', () => json({}, 403)],
  ['cuenta anónima', () => json({ id: USER, is_anonymous: true })],
  ['usuario ausente', () => json({})],
] as const) {
  test(label + ': no consulta la clave', async () => {
    const { handler, calls } = setup({ auth: reply });
    await errorIs(await handler(request()), 401, 'unauthorized');
    assert.equal(calls.length, 1);
  });
}

for (const [label, reply] of [
  ['Auth no disponible', () => json({ message: 'Temporary outage' }, 503)],
  ['Auth sin JSON', () => new Response('Temporarily unavailable')],
  ['fallo de red de Auth', () => { throw new Error('fixture-auth-unavailable'); }],
] as const) {
  test(label, async () => {
    const { handler, calls } = setup({ auth: reply });
    await errorIs(await handler(request()), 503, 'unavailable');
    assert.equal(calls.length, 1);
  });
}

for (const [code, status] of [['not_configured', 503], ['forbidden', 403], ['rate_limit', 429]] as const) {
  test('RPC: ' + code, async () => {
    const { handler, calls } = setup({ rpc: () => json({ error: code }) });
    const res = await handler(request());
    if (status === 429) assert.equal(res.headers.get('retry-after'), '60');
    await errorIs(res, status, code);
    assert.equal(calls.length, 2);
  });
}

for (const [label, reply, code] of [
  ['RPC no disponible', () => json({ detail: SERVICE }, 500), 'unavailable'],
  ['RPC sin JSON', () => new Response('Temporary outage'), 'unavailable'],
  ['RPC sin resultado', () => json(null), 'unavailable'],
  ['RPC con error desconocido', () => json({ error: 'temporary_failure', detail: SERVICE }), 'unavailable'],
  ['RPC sin clave', () => json({ key: '' }), 'not_configured'],
  ['RPC con fallo de red', () => { throw new Error(SERVICE); }, 'unavailable'],
] as const) {
  test(label, async () => {
    const { handler, calls } = setup({ rpc: reply });
    await errorIs(await handler(request()), 503, code);
    assert.equal(calls.length, 2);
  });
}

test('configuración incompleta da 503 sin consultas', async () => {
  for (const deps of [{ anonKey: '' }, { serviceKey: '' }, { supabaseUrl: '' }]) {
    const { handler, calls } = setup({ deps });
    await errorIs(await handler(request()), 503, 'not_configured');
    assert.equal(calls.length, 0);
  }
});

test('errores normales del contrato se rechazan antes de gastar cuota', async () => {
  const cases = [
    null,
    { method: 'GET', path: '/v1/games' },
    { method: 'GET', path: '/v1/mods/42', body: {} },
    { method: 'POST', path: '/v1/mods/42', body: {} },
    { method: 'GET', path: '/v1/mods/search?gameId=432&pageSize=51' },
    { method: 'GET', path: '/v1/mods/search?gameId=432&index=9951&pageSize=50' },
    { method: 'GET', path: '/v1/mods/42/files?index=10000' },
    { method: 'GET', path: '/v1/mods/42/files?pageSize=1.5' },
    { method: 'GET', path: '/v1/mods/search?gameId=432&sortOrder=descending' },
    { method: 'GET', path: '/v1/mods/search?gameId=432&sortField=99' },
    { method: 'GET', path: '/v1/categories?gameId=432&classId=mods' },
    { method: 'GET', path: '/v1/categories?gameId=1' },
    { method: 'GET', path: '/v1/mods/42/files?modLoaderType=99' },
    { method: 'GET', path: '/v1/mods/42/files?pageSize=24&pageSize=50' },
    { method: 'GET', path: '/v1/mods/42?locale=es' },
    { method: 'GET', path: '/v1/mods/0' },
    { method: 'POST', path: '/v1/mods', body: { modIds: [42], filterPcOnly: 'true' } },
    { method: 'POST', path: '/v1/mods/files', body: { fileIds: ['123'] } },
    { method: 'POST', path: '/v1/mods/files', body: { fileIds: [] } },
    { method: 'POST', path: '/v1/fingerprints/432', body: { fingerprints: [-1] } },
    { method: 'POST', path: '/v1/fingerprints/432', body: { fingerprints: [0x100000000] } },
  ];
  const { handler, calls } = setup();
  for (const body of cases) await errorIs(await handler(request(body)), 400, 'bad_request');
  assert.equal(calls.length, 0);
});

test('acepta el último resultado de la ventana y búsquedas con caracteres Unicode', async () => {
  const { handler } = setup();
  const res = await handler(request({ method: 'GET', path: '/v1/mods/search?gameId=432&index=9999&pageSize=1&searchFilter=' + encodeURIComponent('árbol 雪') }));
  assert.equal(res.status, 200);
});

test('lotes en su tamaño máximo; rechaza un elemento de más', async () => {
  for (const [path, field, limit] of [['/v1/mods', 'modIds', 500], ['/v1/mods/files', 'fileIds', 500], ['/v1/fingerprints/432', 'fingerprints', 2000]] as const) {
    const { handler, calls } = setup();
    const ids = Array.from({ length: limit }, (_, i) => i + 1);
    assert.equal((await handler(request({ method: 'POST', path, body: { [field]: ids } }))).status, 200);
    await errorIs(await handler(request({ method: 'POST', path, body: { [field]: [...ids, limit + 1] } })), 400, 'bad_request');
    assert.equal(calls.length, 3);
  }
});

test('solo acepta POST JSON en el endpoint', async () => {
  const { handler, calls } = setup();
  const res = await handler(new Request('https://edge-fixture.invalid/curseforge'));
  assert.equal(res.headers.get('allow'), 'POST, OPTIONS');
  await errorIs(res, 405, 'method_not_allowed');
  await errorIs(await handler(request(undefined, { 'content-type': 'text/plain' })), 415, 'unsupported_media_type');
  const invalid = new Request('https://edge-fixture.invalid/curseforge', {
    method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: '{',
  });
  await errorIs(await handler(invalid), 400, 'bad_request');
  assert.equal(calls.length, 0);
});

test('cuerpo máximo de 64 KiB; cuenta bytes UTF-8 sin Content-Length', async () => {
  const { handler, calls } = setup();
  const body = JSON.stringify({ method: 'GET', path: '/v1/mods/42' });
  const boundary = new Request('https://edge-fixture.invalid/curseforge', {
    method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: body.padEnd(64 * 1024, ' '),
  });
  assert.equal((await handler(boundary)).status, 200);
  await errorIs(await handler(request({ method: 'GET', path: '/v1/mods/42', note: '雪'.repeat(22000) })), 413, 'body_too_large');
  assert.equal(calls.length, 3);
});

test('conserva HTTP y JSON exitosos sin envoltorio ni headers ajenos', async () => {
  const raw = '{ "data": "<p>Descripción del mod</p>" }';
  const { handler } = setup({ upstream: () => new Response(raw, { status: 201, headers: { 'x-provider-note': 'fixture', 'set-cookie': 'fixture=yes' } }) });
  const res = await handler(request({ method: 'GET', path: '/v1/mods/42/description' }));
  assert.equal(res.status, 201);
  assert.equal(await res.text(), raw);
  assert.equal(res.headers.get('x-provider-note'), null);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('una respuesta de descarga devuelve la URL como JSON sin descargar el archivo', async () => {
  const body = { data: 'https://cdn-fixture.invalid/example.jar' };
  const { handler, calls } = setup({ upstream: () => json(body) });
  const res = await handler(request({ method: 'GET', path: '/v1/mods/42/files/99/download-url' }));
  assert.deepEqual(await res.json(), body);
  assert.equal(calls.length, 3);
});

for (const [status, expected, code] of [
  [401, 403, 'badkey'], [403, 403, 'badkey'], [404, 404, 'not_found'],
  [429, 429, 'rate_limit'], [500, 500, 'upstream'], [503, 503, 'upstream'],
] as const) {
  test('error CF ' + status + ' saneado, sin texto ni headers del proveedor', async () => {
    const { handler } = setup({ upstream: () => json({ message: 'Fixture diagnostic: ' + KEY }, status, { 'retry-after': '120', 'x-debug': KEY }) });
    const res = await handler(request());
    if (status === 429) assert.equal(res.headers.get('retry-after'), '60');
    assert.equal(res.headers.get('x-debug'), null);
    await errorIs(res, expected, code);
  });
}

// Qué respondió CurseForge cuando rechazó el pedido: se clasifica sin devolver ni registrar su texto.
const plain = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });
const logged = () => {
  const entries: Record<string, string | number>[] = [];
  return { entries, deps: { log: (entry: Record<string, string | number>) => { entries.push(entry); } } };
};
const SEARCH = { method: 'GET', path: '/v1/mods/search?gameId=432&classId=6&pageSize=1' };
const DOWNLOAD = { method: 'GET', path: '/v1/mods/42/files/99/download-url' };

for (const [label, status, reply, payload, code] of [
  ['texto de clave inválida', 403, () => plain('Forbidden: API Key missing or invalid', 403, { server: 'Kestrel' }), SEARCH, 'badkey'],
  ['mismo texto con 401', 401, () => plain('Forbidden: API Key missing or invalid', 401), SEARCH, 'badkey'],
  ['403 vacío de CloudFront', 403, () => new Response(null, { status: 403, headers: { 'x-cache': 'Error from cloudfront', via: '1.1 fixture.cloudfront.net (CloudFront)' } }), SEARCH, 'blocked'],
  ['página HTML del borde', 403, () => new Response('<!DOCTYPE html><html><body>Blocked</body></html>', { status: 403, headers: { 'content-type': 'text/html' } }), SEARCH, 'blocked'],
  ['HTML enorme', 403, () => new Response('<html>' + 'x'.repeat(9000) + '</html>', { status: 403, headers: { 'content-type': 'text/html' } }), SEARCH, 'blocked'],
  ['JSON desconocido en una búsqueda', 403, () => json({ message: 'Fixture' }, 403), SEARCH, 'badkey'],
  ['descarga que el autor no permite', 403, () => json({ message: 'Fixture' }, 403), DOWNLOAD, 'denied'],
  ['descarga con clave inválida', 403, () => plain('Forbidden: API Key missing or invalid', 403), DOWNLOAD, 'badkey'],
] as const) {
  test('rechazo de CurseForge: ' + label + ' -> ' + code, async () => {
    const { entries, deps } = logged();
    const { handler } = setup({ upstream: reply, deps });
    const res = await handler(request(payload));
    await errorIs(res, 403, code);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].evt, 'curseforge.rejected');
    assert.equal(entries[0].kind, code);
    assert.equal(entries[0].status, status);
  });
}

test('el registro de diagnóstico no contiene la clave, la sesión ni el texto del proveedor', async () => {
  const { entries, deps } = logged();
  const { handler } = setup({ deps, upstream: () => plain('Forbidden: ' + KEY + ' ' + TOKEN, 403, { server: KEY, 'x-cache': 'Error from cloudfront ' + TOKEN }) });
  const res = await handler(request(SEARCH));
  const raw = await res.text();
  for (const secret of [KEY, TOKEN, SERVICE]) {
    assert.ok(!raw.includes(secret));
    assert.ok(!JSON.stringify(entries).includes(secret));
  }
  assert.equal(entries.length, 1);
});

test('si el registro falla, la respuesta sale igual', async () => {
  const { handler } = setup({ deps: { log: () => { throw new Error('fixture-log'); } }, upstream: () => plain('Forbidden: API Key missing or invalid', 403) });
  await errorIs(await handler(request(SEARCH)), 403, 'badkey');
});

test('429, 5xx y caída de red también dejan una línea sin datos del proveedor', async () => {
  for (const [reply, evt] of [
    [() => plain('slow down', 429), 'curseforge.limited'],
    [() => plain('boom', 503), 'curseforge.upstream'],
    [() => { throw new Error(KEY); }, 'curseforge.network'],
  ] as const) {
    const { entries, deps } = logged();
    const { handler } = setup({ upstream: reply, deps });
    await handler(request(SEARCH));
    assert.deepEqual(entries.map((entry) => entry.evt), [evt]);
    assert.ok(!JSON.stringify(entries).includes(KEY));
  }
});

test('fallo de fetch no devuelve detalles internos', async () => {
  const { handler } = setup({ upstream: () => { throw new Error(KEY); } });
  await errorIs(await handler(request()), 502, 'upstream');
});

test('JSON inválido del proveedor devuelve un error fijo', async () => {
  const { handler } = setup({ upstream: () => new Response('<html>Temporary outage</html>') });
  await errorIs(await handler(request()), 502, 'bad_response');
});

test('no entrega JSON de éxito que contenga por error una credencial', async () => {
  for (const body of [{ data: KEY }, { data: { message: SERVICE } }, { data: [TOKEN] }]) {
    const { handler } = setup({ upstream: () => json(body) });
    await errorIs(await handler(request()), 502, 'bad_response');
  }
});

test('respuesta exactamente de 10 MiB permitida, una mayor se cancela', async () => {
  const limit = 10 * 1024 * 1024;
  const raw = JSON.stringify({ data: '' });
  const { handler } = setup({ upstream: () => new Response(JSON.stringify({ data: 'a'.repeat(limit - raw.length) })) });
  const res = await handler(request());
  assert.equal(res.status, 200);
  assert.equal((await res.text()).length, limit);

  let cancelled = false;
  let fragments = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { fragments++; controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); },
    cancel() { cancelled = true; },
  });
  const large = setup({ upstream: () => new Response(stream) });
  await errorIs(await large.handler(request()), 502, 'response_too_large');
  assert.equal(cancelled, true);
  assert.ok(fragments <= 12);
});

test('Content-Length excesivo se corta sin leer el cuerpo', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const { handler } = setup({ upstream: () => new Response(stream, { headers: { 'content-length': String(10 * 1024 * 1024 + 1) } }) });
  await errorIs(await handler(request()), 502, 'response_too_large');
  assert.equal(cancelled, true);
});

test('la cancelación del pedido detiene también la lectura del proveedor', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const { handler } = setup({ upstream: () => new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode('{"data":')); },
    pull() { controller.abort(); },
    cancel() { cancelled = true; },
  })) });
  await errorIs(await handler(request(undefined, {}, controller.signal)), 504, 'timeout');
  assert.equal(cancelled, true);
});

test('entrypoint conecta solo variables Supabase; config exige JWT y plazo total de 30 s', async () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source, { mode: 'strip' }).replace(/^import .*;\r?$/gm, '');
  let deps: CurseforgeDeps | undefined;
  let served = false;
  const variables: Record<string, string> = { SUPABASE_URL: ' ' + SB + ' ', SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE };
  const fixedFetch = () => { throw new Error('Network disabled'); };
  new vm.Script(code).runInNewContext({
    Deno: { env: { get: (name: string) => variables[name] }, serve: (handler: unknown) => { served = typeof handler === 'function'; } },
    fetch: fixedFetch,
    createCurseforgeHandler: (value: CurseforgeDeps) => { deps = value; return () => {}; },
  });
  assert.equal(served, true);
  assert.equal(deps?.supabaseUrl, SB);
  assert.equal(deps?.anonKey, ANON);
  assert.equal(deps?.serviceKey, SERVICE);
  assert.equal(deps?.fetch, fixedFetch);
  const config = readFileSync(new URL('../../../config.toml', import.meta.url), 'utf8');
  assert.match(config, /\[functions\.curseforge\]\s+verify_jwt\s*=\s*true/);

  const timeout = AbortSignal.timeout;
  let requestedMs = 0;
  try {
    AbortSignal.timeout = (ms: number) => { requestedMs = ms; return timeout(ms); };
    assert.equal((await setup().handler(request())).status, 200);
  } finally { AbortSignal.timeout = timeout; }
  assert.equal(requestedMs, 30_000);
});

test('preflight del renderer file:// y POST de Probar conexión con los headers de Supabase', async () => {
  const { handler, calls } = setup();
  const preflight = await handler(new Request('https://edge-fixture.invalid/curseforge', {
    method: 'OPTIONS',
    headers: {
      origin: 'null',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,apikey,x-client-info,content-type,x-supabase-api-version',
    },
  }));
  assert.equal(preflight.status, 204);
  assert.equal(await preflight.text(), '');
  assertCors(preflight);
  assert.equal(calls.length, 0);
  const response = await handler(request({ method: 'GET', path: '/v1/categories?gameId=432' }, {
    origin: 'null', apikey: ANON, 'x-client-info': 'supabase-js-fixture', 'x-supabase-api-version': '2024-01-01',
  }));
  assert.equal(response.status, 200);
  assertCors(response);
  assert.deepEqual(await response.json(), OK);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].headers.get('origin'), null);
  assert.equal(calls[2].headers.get('x-supabase-api-version'), null);
});

test('preflight funciona sin configuración y las respuestas sin contenido también incluyen CORS', async () => {
  const unconfigured = setup({ deps: { supabaseUrl: '', anonKey: '', serviceKey: '' } });
  const preflight = await unconfigured.handler(new Request('https://edge-fixture.invalid/curseforge', { method: 'OPTIONS', headers: { origin: 'null' } }));
  assert.equal(preflight.status, 204);
  assertCors(preflight);
  assert.equal(unconfigured.calls.length, 0);
  for (const status of [204, 205]) {
    const { handler } = setup({ upstream: () => new Response(null, { status }) });
    const response = await handler(request());
    assert.equal(response.status, status);
    assert.equal(await response.text(), '');
    assertCors(response);
  }
});

test('searchFilter acepta test sodium con espacio codificado como %20 o +', async () => {
  for (const filter of ['test%20sodium', 'test+sodium']) {
    const { handler, calls } = setup();
    const response = await handler(request({ method: 'GET', path: '/v1/mods/search?gameId=432&searchFilter=' + filter }));
    assert.equal(response.status, 200);
    assertCors(response);
    assert.equal(new URL(calls[2].url).searchParams.get('searchFilter'), 'test sodium');
  }
});

test('searchFilter rechaza controles ASCII decodificados sin consultar servicios', async () => {
  const { handler, calls } = setup();
  const controls = [...Array.from({ length: 32 }, (_, code) => code), 127];
  for (const code of controls) {
    const filter = encodeURIComponent('test' + String.fromCharCode(code) + 'sodium');
    await errorIs(await handler(request({ method: 'GET', path: '/v1/mods/search?gameId=432&searchFilter=' + filter })), 400, 'bad_request');
  }
  assert.equal(calls.length, 0);
});
