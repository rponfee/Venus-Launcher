// Prueba de index.ts con los SDK reales del launcher (@anthropic-ai/sdk y @supabase/supabase-js de
// node_modules) contra un fetch falso: verifica los pedidos exactos que salen hacia Supabase y Anthropic.
// No hace llamadas de red. Arma una copia temporal de la función con los imports npm: apuntando a
// node_modules (en %TEMP%/venus-assistant-backend-e2e-*) y la borra al terminar. Sin los paquetes, se saltea.
// El SDK de OpenAI no está en el repo del launcher: se usa el de node_modules si alguien lo instala, el de
// VENUS_OPENAI_SDK (ruta al index.mjs de un paquete "openai" 7.x, para verificarlo a mano) o, si no, el doble
// de tests/fake-openai-sdk.ts (mismo pedido HTTP y mismas clases de error). index.ts se importa dos veces:
// sin OPENAI_API_KEY (solo Anthropic, como antes) y con OPENAI_API_KEY (respaldo en OpenAI).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Entry = { url: string; method: string; headers: Headers; body: Record<string, unknown> | null; signal: AbortSignal | null };
type Responder = (entry: Entry) => Response | Promise<Response>;

const SUPABASE = 'https://proyecto-prueba.supabase.co';
const SECRET = 'contenido-privado-4471';
const env: Record<string, string> = {
  SUPABASE_URL: SUPABASE,
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  ANTHROPIC_API_KEY: 'sk-ant-test-0123456789abcdefghijklmnop',
};
const v1 = { app: 'venus-launcher', protocol: 1 };
const v2 = { app: 'venus-launcher', protocol: 2 };

function resolveOrNull(specifier: string): string | null {
  try {
    return import.meta.resolve(specifier);
  } catch {
    return null;
  }
}

const sdkUrl = resolveOrNull('@anthropic-ai/sdk');
const sdkSchemaUrl = resolveOrNull('@anthropic-ai/sdk/helpers/beta/json-schema');
const supabaseUrl = resolveOrNull('@supabase/supabase-js');
const available = Boolean(sdkUrl && sdkSchemaUrl && supabaseUrl);
const OPENAI_KEY = 'sk-openai-test-0123456789abcdefghijklmn';
const openaiOverride = (process.env.VENUS_OPENAI_SDK ?? '').trim();
const openaiSdkUrl = openaiOverride
  ? pathToFileURL(openaiOverride).href
  : resolveOrNull('openai') ?? new URL('./fake-openai-sdk.ts', import.meta.url).href;
const openaiSdkKind = openaiOverride || !openaiSdkUrl.endsWith('fake-openai-sdk.ts') ? 'real' : 'doble';

// Configuración de proveedores que "devuelve la base" (ai_provider_settings de 0011, con sus valores por defecto).
function providerSettings(): Record<string, unknown> {
  const efforts = { low: 'low', medium: 'medium', high: 'high' };
  return {
    primary: 'anthropic',
    secondary: 'openai',
    failoverEnabled: true,
    failoverOn: ['rate_limited', 'overloaded', 'unavailable', 'timeout', 'network', 'billing', 'auth', 'permission', 'config', 'model', 'not_configured'],
    openai: {
      haiku: { model: 'gpt-6-luna', efforts },
      sonnet: { model: 'gpt-6.1-sol', efforts },
      opus: { model: 'gpt-6-astra', efforts },
    },
  };
}

// Lo que "devuelve la base": el modelo de la pregunta y su id de Anthropic (de ai_models).
const state: {
  requests: Entry[];
  modelKey: string;
  modelId: string;
  fallback: boolean;
  anthropic: Responder | null;
  openai: Responder | null;
  settings: Record<string, unknown>;
} = {
  requests: [],
  modelKey: 'opus',
  modelId: 'claude-opus-5-5',
  fallback: true,
  anthropic: null,
  openai: null,
  settings: providerSettings(),
};
const consoleLines: string[] = [];
const handlers: ((req: Request) => Promise<Response>)[] = [];
let handler: ((req: Request) => Promise<Response>) | null = null;
let openaiHandler: ((req: Request) => Promise<Response>) | null = null;
let onlyOpenaiHandler: ((req: Request) => Promise<Response>) | null = null;
let workDir = '';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function quotaV2(): Record<string, unknown> {
  return {
    plan: 'max',
    planName: 'Max',
    priceUsd: 36.5,
    status: 'active',
    models: [
      { id: 'haiku', model: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: ['low', 'medium', 'high'], daily: { used: 2, limit: 25 }, weekly: { used: 2, limit: 115 } },
      { id: 'opus', model: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium'], daily: { used: 1, limit: 4 }, weekly: { used: 3, limit: 20 } },
    ],
    budget: { usedUsd: 0.5, limitUsd: 19 },
    resets: { daily: '2026-10-28T03:00:00Z', weekly: '2026-11-02T03:00:00Z', monthly: '2026-11-01T03:00:00Z' },
    timezone: 'America/Argentina/Buenos_Aires',
  };
}

const CATALOG = [{ id: 'go', name: 'Go', priceUsd: 3.5, budgetUsd: 1.5, models: [{ id: 'haiku', label: 'Haiku 5.5', efforts: ['low', 'medium'], daily: 35, weekly: 170 }] }];

/** Respuesta de la Responses API (con un item de razonamiento, que no tiene que llegar al launcher). */
function openaiResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp_01',
    object: 'response',
    created_at: 1761600000,
    status: 'completed',
    model: 'gpt-6.1-sol',
    output: [
      { id: 'rs_01', type: 'reasoning', summary: [], encrypted_content: 'gAAAA-cifrado' },
      {
        id: 'msg_oa',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Hola desde el respaldo.', annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 3000,
      input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 500 },
      output_tokens: 120,
      output_tokens_details: { reasoning_tokens: 80 },
      total_tokens: 3120,
    },
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: state.modelId,
    content: [{ type: 'text', text: 'Hola, soy la IA.', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 7, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 },
    ...overrides,
  };
}

async function fakeFetch(input: unknown, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  let text = '';
  if (typeof init.body === 'string') text = init.body;
  else if (init.body) text = await new Response(init.body).text();
  const entry: Entry = { url, method: init.method ?? 'GET', headers, body: text ? JSON.parse(text) : null, signal: init.signal ?? null };
  state.requests.push(entry);

  if (url === `${SUPABASE}/auth/v1/user`) {
    const auth = headers.get('authorization');
    if (auth === 'Bearer jwt-good') {
      return jsonResponse(200, { id: 'user-uuid', aud: 'authenticated', role: 'authenticated', email: 'a@b.c', email_confirmed_at: '2026-01-01T00:00:00Z', is_anonymous: false, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
    }
    if (auth === 'Bearer jwt-anon') {
      return jsonResponse(200, { id: 'anon-uuid', aud: 'authenticated', role: 'authenticated', is_anonymous: true, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
    }
    if (auth === 'Bearer jwt-down') return new Response('upstream error', { status: 503 });
    return jsonResponse(403, { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' });
  }
  if (url.startsWith(`${SUPABASE}/rest/v1/rpc/`)) {
    const fn = url.slice(`${SUPABASE}/rest/v1/rpc/`.length);
    const b = (entry.body ?? {}) as Record<string, unknown>;
    if (fn === 'ai_quota_status') return jsonResponse(200, quotaV2());
    if (fn === 'ai_catalog') return jsonResponse(200, CATALOG);
    if (fn === 'ai_register_turn') {
      return jsonResponse(200, {
        allowed: true,
        reason: null,
        model: state.modelKey,
        modelId: state.modelId,
        fallback: state.fallback,
        effort: b.p_effort ?? 'medium',
        counted: true,
        maxTokensPerRequest: 8000,
        quota: quotaV2(),
      });
    }
    if (fn === 'ai_add_usage') return jsonResponse(200, { quota: { ...quotaV2(), budget: { usedUsd: 0.51, limitUsd: 19 } }, costUsd: 0.01, unpriced: [] });
    if (fn === 'ai_release_turn') return jsonResponse(200, quotaV2());
    if (fn === 'ai_end_call') return jsonResponse(200, quotaV2());
    if (fn === 'ai_provider_settings') return jsonResponse(200, state.settings);
    return jsonResponse(404, { code: 'PGRST202', message: 'Could not find the function' });
  }
  // OpenAI (cualquier host: el SDK real respeta OPENAI_BASE_URL si está definido en el entorno).
  if (new URL(url).pathname.endsWith('/responses')) {
    return state.openai ? state.openai(entry) : jsonResponse(200, openaiResponse(), { 'x-request-id': 'req_oa_ok' });
  }
  // Anthropic (cualquier host: el SDK respeta ANTHROPIC_BASE_URL si está definido en el entorno).
  if (new URL(url).pathname === '/v1/messages') {
    return state.anthropic ? state.anthropic(entry) : jsonResponse(200, message(), { 'request-id': 'req_ok' });
  }
  throw new TypeError(`fetch no esperado: ${url}`);
}

if (available) {
  workDir = mkdtempSync(join(tmpdir(), 'venus-assistant-backend-e2e-'));
  const fnDir = dirname(dirname(fileURLToPath(import.meta.url)));
  for (const file of ['config.ts', 'errors.ts', 'handler.ts', 'openai.ts', 'policy.ts', 'providers.ts', 'quota.ts', 'validate.ts']) {
    copyFileSync(join(fnDir, file), join(workDir, file));
  }
  const index = readFileSync(join(fnDir, 'index.ts'), 'utf8')
    .replace("'npm:@anthropic-ai/sdk@^1.3.0/helpers/beta/json-schema'", `'${sdkSchemaUrl}'`)
    .replace("'npm:@anthropic-ai/sdk@^1.3.0'", `'${sdkUrl}'`)
    .replace("'npm:openai@^7.38.0'", `'${openaiSdkUrl}'`)
    .replace("'npm:@supabase/supabase-js@2'", `'${supabaseUrl}'`);
  assert.ok(!index.includes("'npm:"), 'quedaron imports npm: sin reemplazar en index.ts');
  writeFileSync(join(workDir, 'index.ts'), index);
  writeFileSync(join(workDir, 'package.json'), '{"type":"module","private":true}\n');

  (globalThis as Record<string, unknown>).Deno = {
    env: { get: (name: string) => env[name] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handlers.push(h);
      return {};
    },
  };
  (globalThis as Record<string, unknown>).fetch = fakeFetch;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...args: unknown[]) => {
      consoleLines.push(args.map(String).join(' '));
    };
  }
  // 1) Sin OPENAI_API_KEY: solo Anthropic (todas las pruebas de antes).
  await import(pathToFileURL(join(workDir, 'index.ts')).href);
  handler = handlers[0] ?? null;
  // 2) Con OPENAI_API_KEY: otra instancia del módulo (los secretos se leen al cargarlo).
  env.OPENAI_API_KEY = OPENAI_KEY;
  await import(`${pathToFileURL(join(workDir, 'index.ts')).href}?con-openai`);
  openaiHandler = handlers[1] ?? null;
  // 3) Sin ANTHROPIC_API_KEY y con OPENAI_API_KEY: todo va directo al respaldo.
  const anthropicKey = env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  await import(`${pathToFileURL(join(workDir, 'index.ts')).href}?solo-openai`);
  onlyOpenaiHandler = handlers[2] ?? null;
  env.ANTHROPIC_API_KEY = anthropicKey;
  delete env.OPENAI_API_KEY;
}

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const skip = available ? false : 'faltan @anthropic-ai/sdk o @supabase/supabase-js en node_modules';

function reset(modelKey = 'opus', modelId = 'claude-opus-5-5', fallback = true): void {
  state.requests = [];
  state.modelKey = modelKey;
  state.modelId = modelId;
  state.fallback = fallback;
  state.anthropic = null;
  state.openai = null;
  state.settings = providerSettings();
}

function post(body: unknown, token = 'jwt-good', signal?: AbortSignal): Request {
  return new Request(`${SUPABASE}/functions/v1/ai-assistant`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: 'anon-key', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

async function run(req: Request, h = handler): Promise<{ status: number; body: Record<string, any> }> {
  assert.ok(h, 'index.ts tendría que haber llamado a Deno.serve');
  const res = await h(req);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const anthropicCalls = () => state.requests.filter((r) => new URL(r.url).pathname === '/v1/messages');
const openaiCalls = () => state.requests.filter((r) => new URL(r.url).pathname.endsWith('/responses'));
const rpcCalls = () =>
  state.requests.filter((r) => r.url.includes('/rest/v1/rpc/')).map((r) => ({ fn: r.url.split('/').pop(), body: r.body, headers: r.headers }));

test('index.ts: GET verifica la sesión en Auth (anon key) y lee la cuota y el catálogo con la service role', { skip }, async () => {
  reset();
  const res = await run(new Request(`${SUPABASE}/functions/v1/ai-assistant`, { headers: { Authorization: 'Bearer jwt-good' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { quota: quotaV2(), plans: CATALOG });
  const auth = state.requests.find((r) => r.url.endsWith('/auth/v1/user'));
  assert.equal(auth?.headers.get('apikey'), 'anon-key');
  const calls = rpcCalls();
  assert.deepEqual(calls.map((c) => c.fn).sort(), ['ai_catalog', 'ai_quota_status']);
  assert.deepEqual(calls.find((c) => c.fn === 'ai_quota_status')?.body, { p_user: 'user-uuid' });
  for (const c of calls) {
    assert.equal(c.headers.get('apikey'), 'service-key');
    assert.equal(c.headers.get('authorization'), 'Bearer service-key');
  }
  assert.equal(anthropicCalls().length, 0);
});

test('index.ts: sesión inválida 401, anónima 403 con code, Auth caído 503', { skip }, async () => {
  reset();
  const body = { task: 'text', messages: [{ role: 'user', content: 'x' }], client: v1 };
  assert.equal((await run(post(body, 'jwt-bad'))).status, 401);
  const anon = await run(post(body, 'jwt-anon'));
  assert.equal(anon.status, 403);
  assert.equal(anon.body.code, 'anonymous');
  const down = await run(post(body, 'jwt-down'));
  assert.equal(down.status, 503);
  assert.equal(down.body.code, 'auth_unavailable');
  assert.equal(anthropicCalls().length, 0);
});

test('index.ts: pedido exacto a Anthropic con Opus (beta, fallbacks, caché, effort; sin thinking, temperature ni tool_choice)', { skip }, async () => {
  reset();
  const messages = [{ role: 'user', content: `Explicame este crash ${SECRET}` }];
  const res = await run(post({ task: 'text', system: 'Answer in English.', messages, max_tokens: 4000, effort: 'medium', client: v1 }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [register] = rpcCalls();
  assert.equal(register.fn, 'ai_register_turn');
  assert.equal(register.body?.p_model, null, 'protocolo 1: sin modelo');
  assert.equal(register.body?.p_effort, 'medium');
  assert.match(String(register.body?.p_turn), /^srv-/);
  const [call] = anthropicCalls();
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.get('authorization'), `Bearer ${env.ANTHROPIC_API_KEY}`);
  assert.equal(call.headers.get('anthropic-beta'), 'server-side-fallback-2026-07-01');
  const sent = call.body as Record<string, any>;
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.max_tokens, 4000);
  assert.deepEqual(sent.cache_control, { type: 'ephemeral' });
  assert.equal(sent.fallbacks, 'default');
  assert.deepEqual(sent.output_config, { effort: 'medium' });
  assert.deepEqual(sent.messages, messages);
  assert.ok(sent.system[0].text.startsWith('# Política del servidor de Venus Launcher'));
  assert.equal(sent.system[1].text, '## Instrucciones del launcher\n\nAnswer in English.');
  for (const key of ['thinking', 'tool_choice', 'tools', 'betas', 'temperature', 'top_p', 'top_k', 'stream']) assert.ok(!(key in sent), `no manda ${key}`);
  assert.deepEqual(res.body.message, {
    content: [{ type: 'text', text: 'Hola, soy la IA.', citations: null }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 7, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 },
    model: 'claude-opus-5-5',
    served_by: { provider: 'anthropic', model: 'claude-opus-5-5', failover: false },
  });
  assert.ok(!rpcCalls().some((r) => r.fn === 'ai_provider_settings'), 'sin OPENAI_API_KEY no lee la configuración de proveedores');
  const add = rpcCalls().find((r) => r.fn === 'ai_add_usage');
  assert.deepEqual(add?.body, {
    p_user: 'user-uuid',
    p_model: 'opus',
    p_usage: [{ model: 'claude-opus-5-5', input: 12, output: 7, cacheRead: 2000, cacheWrite: 100 }],
  });
  assert.equal(res.body.quota.budget.usedUsd, 0.51);
});

test('index.ts: el id del modelo sale de la base; Sonnet con fallbacks, Haiku nunca', { skip }, async () => {
  reset('sonnet', 'claude-sonnet-5-5', true);
  await run(post({ task: 'text', messages: [{ role: 'user', content: 'Hola' }], model: 'sonnet', max_tokens: 16000, effort: 'low', client: v2 }));
  let [call] = anthropicCalls();
  let sent = call.body as Record<string, any>;
  assert.equal(sent.model, 'claude-sonnet-5-5');
  assert.equal(sent.max_tokens, 8000, 'recortado al tope del plan');
  assert.equal(sent.fallbacks, 'default');
  assert.deepEqual(sent.output_config, { effort: 'low' });
  assert.equal(call.headers.get('anthropic-beta'), 'server-side-fallback-2026-07-01');
  assert.deepEqual(rpcCalls()[0].body, { p_user: 'user-uuid', p_turn: rpcCalls()[0].body?.p_turn, p_model: 'sonnet', p_effort: 'low' });

  // Aunque la base diga que Haiku tiene reintento en otro modelo, no se manda.
  reset('haiku', 'claude-haiku-5-5', true);
  await run(post({ task: 'text', messages: [{ role: 'user', content: 'Hola' }], model: 'haiku', client: v2 }));
  [call] = anthropicCalls();
  sent = call.body as Record<string, any>;
  assert.equal(sent.model, 'claude-haiku-5-5');
  assert.ok(!('fallbacks' in sent));
  assert.ok(!(call.headers.get('anthropic-beta') ?? '').includes('server-side-fallback'));
  assert.deepEqual(sent.output_config, { effort: 'medium' }, 'sin esfuerzo: el que resuelve la base');
});

test('index.ts: un reintento en otro modelo se registra intento por intento', { skip }, async () => {
  reset();
  state.anthropic = () =>
    jsonResponse(200, message({
      model: 'claude-opus-5',
      content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }, { type: 'text', text: 'ok', citations: null }],
      usage: {
        input_tokens: 400,
        output_tokens: 300,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: [
          { type: 'message', model: 'claude-opus-5-5', input_tokens: 500, output_tokens: 20, cache_creation_input_tokens: 50, cache_read_input_tokens: 100 },
          { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 400, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        ],
      },
    }));
  const res = await run(post({ task: 'text', messages: [{ role: 'user', content: 'x' }], model: 'opus', client: v2 }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.message.model, 'claude-opus-5');
  const add = rpcCalls().find((r) => r.fn === 'ai_add_usage');
  assert.deepEqual(add?.body?.p_usage, [
    { model: 'claude-opus-5-5', input: 500, output: 20, cacheRead: 100, cacheWrite: 50 },
    { model: 'claude-opus-5', input: 400, output: 300, cacheRead: 0, cacheWrite: 0 },
  ]);
});

test('index.ts: json con el helper del SDK (parsed; respuesta cortada = parsed null; schema inválido = 400)', { skip }, async () => {
  reset();
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  state.anthropic = () => jsonResponse(200, message({ content: [{ type: 'text', text: '{"ok":true}', citations: null }] }));
  const ok = await run(post({ task: 'json', messages: [{ role: 'user', content: 'x' }], schema, effort: 'low', client: v1 }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.parsed, { ok: true });
  const format = (anthropicCalls()[0].body as Record<string, any>).output_config.format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.schema.additionalProperties, false);
  assert.ok(!('parse' in format));

  reset();
  state.anthropic = () => jsonResponse(200, message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ok":tr', citations: null }] }));
  const cut = await run(post({ task: 'json', messages: [{ role: 'user', content: 'x' }], schema, client: v1 }));
  assert.equal(cut.status, 200);
  assert.equal(cut.body.parsed, null);
  assert.ok(rpcCalls().some((r) => r.fn === 'ai_add_usage'), 'el uso se registra igual');

  reset();
  const bad = await run(post({ task: 'json', messages: [{ role: 'user', content: 'x' }], schema: { type: 'object', properties: { x: {} } }, client: v1 }));
  assert.equal(bad.status, 400);
  assert.equal(rpcCalls().length, 0);
});

test('index.ts: herramientas y bloques de la IA se reenvían intactos', { skip }, async () => {
  reset();
  const tools = [
    { name: 'list_mods', description: 'Lista los mods', input_schema: { type: 'object', properties: { instanceId: { type: 'string' } }, required: ['instanceId'], additionalProperties: false }, strict: true },
  ];
  const messages = [
    { role: 'user', content: '¿Qué mods tengo?' },
    {
      role: 'assistant',
      content: [
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal' } },
        { type: 'thinking', thinking: '', signature: 'EqQBCgIYAhIM' },
        { type: 'tool_use', id: 'toolu_01', name: 'list_mods', input: { instanceId: 'i1' }, caller: { type: 'direct' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: 'sodium' }] }] },
  ];
  const res = await run(post({ task: 'assistant', system: 'Sos el asistente.', messages, tools, model: 'opus', turn_id: 'turno-abc', client: v2 }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const sent = anthropicCalls()[0].body as Record<string, any>;
  assert.deepEqual(sent.tools, tools);
  assert.deepEqual(sent.messages, messages);
  assert.ok(!('tool_choice' in sent));
  assert.deepEqual(rpcCalls()[0].body, { p_user: 'user-uuid', p_turn: 'turno-abc', p_model: 'opus', p_effort: null });
});

test('index.ts: rechazo final 422 y errores tipados del SDK', { skip }, async () => {
  reset();
  state.anthropic = () => jsonResponse(200, message({ stop_reason: 'refusal', content: [] }));
  const refusal = await run(post({ task: 'text', messages: [{ role: 'user', content: 'x' }], client: v1 }));
  assert.equal(refusal.status, 422);
  assert.equal(refusal.body.error, 'refusal');
  assert.ok(rpcCalls().some((r) => r.fn === 'ai_add_usage'), 'el rechazo también se cobra');

  const cases = [
    { status: 429, type: 'rate_limit_error', expect: 503, code: 'upstream_rate_limited', release: true },
    { status: 529, type: 'overloaded_error', expect: 503, code: 'upstream_overloaded', release: true },
    { status: 400, type: 'invalid_request_error', expect: 400, code: '', release: false },
    { status: 401, type: 'authentication_error', expect: 502, code: 'upstream_auth', release: false },
    { status: 404, type: 'not_found_error', expect: 502, code: 'upstream_model', release: false },
    { status: 402, type: 'billing_error', expect: 503, code: 'upstream_billing', release: false },
  ];
  for (const c of cases) {
    reset();
    state.anthropic = () =>
      jsonResponse(c.status, { type: 'error', error: { type: c.type, message: `detalle ${SECRET}` } }, { 'x-should-retry': 'false', 'request-id': 'req_err' });
    const res = await run(post({ task: 'text', messages: [{ role: 'user', content: 'x' }], client: v1 }));
    assert.equal(res.status, c.expect, `${c.status}: ${JSON.stringify(res.body)}`);
    if (c.code) assert.equal(res.body.code, c.code);
    else assert.equal(res.body.error, 'bad_request');
    assert.equal(rpcCalls().some((r) => r.fn === 'ai_release_turn'), c.release, `${c.status}: devolver la pregunta`);
    assert.ok(!rpcCalls().some((r) => r.fn === 'ai_add_usage'), `${c.status}: sin uso que registrar`);
    assert.deepEqual(rpcCalls().find((r) => r.fn === 'ai_end_call')?.body, { p_user: 'user-uuid' }, `${c.status}: cierra la llamada`);
  }
});

test('index.ts: red caída (después de los reintentos del SDK) y cancelación del launcher', { skip }, async () => {
  reset();
  state.anthropic = () => {
    throw new TypeError('fetch failed');
  };
  const networkBody = { task: 'text', messages: [{ role: 'user', content: 'x' }], client: v1 };
  const network = await run(post(networkBody));
  assert.equal(network.status, 502);
  assert.equal(network.body.code, 'upstream_network');
  assert.equal(anthropicCalls().length, 3, '1 intento + 2 reintentos');
  // La IA pudo haber procesado el pedido: se cobra una estimación (el pedido entero y la salida entera).
  assert.deepEqual(rpcCalls().find((r) => r.fn === 'ai_add_usage')?.body, {
    p_user: 'user-uuid',
    p_model: 'opus',
    p_usage: [{ model: 'claude-opus-5-5', input: 0, output: 8000, cacheRead: 0, cacheWrite: Math.ceil(JSON.stringify(networkBody).length / 3) }],
  });

  reset();
  let aborted = false;
  state.anthropic = (entry) =>
    new Promise<Response>((_resolve, reject) => {
      entry.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('This operation was aborted', 'AbortError'));
      });
    });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const cancelled = await run(post({ task: 'text', messages: [{ role: 'user', content: 'x' }], client: v1 }, 'jwt-good', controller.signal));
  assert.equal(cancelled.status, 503);
  assert.equal(cancelled.body.code, 'aborted');
  assert.equal(aborted, true);
  assert.ok(rpcCalls().some((r) => r.fn === 'ai_add_usage'), 'la cancelación se cobra estimada');
  assert.ok(!rpcCalls().some((r) => r.fn === 'ai_end_call'));
});

// ---------- Con OPENAI_API_KEY: OpenAI como respaldo ----------

const TOOLS_SONNET = [
  {
    name: 'install_mod',
    description: 'Instala un mod',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { instance_id: { type: 'string' }, project_id: { type: 'string' }, version_id: { type: 'string' } },
      required: ['instance_id', 'project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_mods',
    description: 'Lista los mods',
    input_schema: { type: 'object', properties: { instance_id: { type: 'string' } }, required: ['instance_id'], additionalProperties: false },
  },
];

const overloaded = () =>
  jsonResponse(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { 'x-should-retry': 'false', 'request-id': 'req_529' });

test(`index.ts con OPENAI_API_KEY (SDK ${openaiSdkKind}): sin fallas responde Anthropic y la configuración se lee una vez por minuto`, { skip }, async () => {
  reset('sonnet', 'claude-sonnet-5-5', true);
  const body = { task: 'text', messages: [{ role: 'user', content: 'Hola' }], model: 'sonnet', client: v2 };
  const first = await run(post(body), openaiHandler);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.message.served_by, { provider: 'anthropic', model: 'claude-sonnet-5-5', failover: false });
  assert.equal(openaiCalls().length, 0);
  const second = await run(post(body), openaiHandler);
  assert.equal(second.status, 200);
  assert.equal(rpcCalls().filter((r) => r.fn === 'ai_provider_settings').length, 1, 'la segunda llamada usa el caché');
  // El pedido a Anthropic es el de siempre (mismo beta, fallbacks y effort).
  const sent = anthropicCalls()[0].body as Record<string, any>;
  assert.equal(sent.model, 'claude-sonnet-5-5');
  assert.equal(sent.fallbacks, 'default');
  assert.deepEqual(sent.output_config, { effort: 'medium' });
});

test(`index.ts con OPENAI_API_KEY (SDK ${openaiSdkKind}): Anthropic saturada (529) -> OpenAI con el pedido traducido`, { skip }, async () => {
  reset('sonnet', 'claude-sonnet-5-5', true);
  state.anthropic = overloaded;
  state.openai = () =>
    jsonResponse(200, openaiResponse({
      output: [
        { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'gAAAA-cifrado' },
        { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Reviso e instalo.', annotations: [] }] },
        { id: 'fc_1', type: 'function_call', call_id: 'call_AbC123', name: 'list_mods', arguments: '{"instance_id":"i1"}', status: 'completed' },
        { id: 'fc_2', type: 'function_call', call_id: 'call_DeF456', name: 'install_mod', arguments: '{"instance_id":"i1","project_id":"sodium","version_id":null}', status: 'completed' },
      ],
    }), { 'x-request-id': 'req_oa_1' });
  const messages = [
    { role: 'user', content: `Instalá sodium ${SECRET}` },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'EqQBCgIYAhIM' }, { type: 'tool_use', id: 'toolu_01', name: 'list_mods', input: { instance_id: 'i1' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"ok":true,"mods":[]}' }] },
  ];
  const res = await run(
    post({ task: 'assistant', system: 'Sos el asistente.', messages, tools: TOOLS_SONNET, model: 'sonnet', effort: 'medium', max_tokens: 6000, turn_id: 'turno-oa', client: v2 }),
    openaiHandler,
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(anthropicCalls().length, 1, 'Anthropic primero (529, sin reintento del SDK)');
  assert.equal(openaiCalls().length, 1);
  const [call] = openaiCalls();
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.get('authorization'), `Bearer ${OPENAI_KEY}`);
  const sent = call.body as Record<string, any>;
  assert.equal(sent.model, 'gpt-6.1-sol', 'el modelo sale de ai_tier_fallbacks');
  assert.equal(sent.store, false);
  assert.deepEqual(sent.reasoning, { effort: 'medium' });
  assert.equal(sent.max_output_tokens, 6000);
  assert.ok(sent.instructions.startsWith('# Política del servidor de Venus Launcher'));
  assert.ok(sent.instructions.endsWith('## Instrucciones del launcher\n\nSos el asistente.'));
  assert.deepEqual(sent.input, [
    { role: 'user', content: `Instalá sodium ${SECRET}` },
    { type: 'function_call', call_id: 'toolu_01', name: 'list_mods', arguments: '{"instance_id":"i1"}' },
    { type: 'function_call_output', call_id: 'toolu_01', output: '{"ok":true,"mods":[]}' },
  ]);
  assert.deepEqual(sent.tools, [
    {
      type: 'function',
      name: 'install_mod',
      description: 'Instala un mod',
      parameters: {
        type: 'object',
        properties: { instance_id: { type: 'string' }, project_id: { type: 'string' }, version_id: { type: ['string', 'null'] } },
        required: ['instance_id', 'project_id', 'version_id'],
        additionalProperties: false,
      },
      strict: true,
    },
    { type: 'function', name: 'list_mods', description: 'Lista los mods', parameters: TOOLS_SONNET[1].input_schema, strict: false },
  ]);
  for (const key of ['temperature', 'top_p', 'tool_choice', 'previous_response_id', 'stream', 'thinking', 'include']) assert.ok(!(key in sent), `no manda ${key}`);
  // Vuelve con la forma de Anthropic, sin el razonamiento y con los mismos call_id.
  assert.deepEqual(res.body.message, {
    content: [
      { type: 'text', text: 'Reviso e instalo.' },
      { type: 'tool_use', id: 'call_AbC123', name: 'list_mods', input: { instance_id: 'i1' } },
      { type: 'tool_use', id: 'call_DeF456', name: 'install_mod', input: { instance_id: 'i1', project_id: 'sodium' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 500, output_tokens: 120, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 },
    model: 'gpt-6.1-sol',
    served_by: { provider: 'openai', model: 'gpt-6.1-sol', failover: true },
  });
  // La pregunta sigue en Sonnet; el costo va con el precio del modelo de OpenAI que respondió.
  const add = rpcCalls().find((r) => r.fn === 'ai_add_usage');
  assert.deepEqual(add?.body, { p_user: 'user-uuid', p_model: 'sonnet', p_usage: [{ model: 'gpt-6.1-sol', input: 500, output: 120, cacheRead: 2000, cacheWrite: 500 }] });
  assert.ok(!rpcCalls().some((r) => r.fn === 'ai_release_turn'));
  assert.ok(consoleLines.some((l) => l.includes('respaldo: anthropic -> openai (upstream_overloaded)')));
});

test(`index.ts con OPENAI_API_KEY (SDK ${openaiSdkKind}): rechazos y pedidos inválidos nunca pasan a OpenAI`, { skip }, async () => {
  reset('sonnet', 'claude-sonnet-5-5', true);
  state.anthropic = () => jsonResponse(200, message({ model: 'claude-sonnet-5-5', stop_reason: 'refusal', content: [] }));
  const refusal = await run(post({ task: 'text', messages: [{ role: 'user', content: 'x' }], model: 'sonnet', client: v2 }), openaiHandler);
  assert.equal(refusal.status, 422);
  assert.equal(refusal.body.error, 'refusal');
  assert.equal(openaiCalls().length, 0);

  reset('sonnet', 'claude-sonnet-5-5', true);
  state.anthropic = () =>
    jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages.0: bad' } }, { 'x-should-retry': 'false' });
  const invalid = await run(post({ task: 'text', messages: [{ role: 'user', content: 'x' }], model: 'sonnet', client: v2 }), openaiHandler);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'upstream_invalid_request');
  assert.equal(openaiCalls().length, 0);
});

test(`index.ts con OPENAI_API_KEY (SDK ${openaiSdkKind}): errores tipados del SDK de OpenAI`, { skip }, async () => {
  const cases = [
    // Sin crédito en OpenAI: la respuesta es la del respaldo; la pregunta no se devuelve.
    { status: 429, error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'quota' }, expect: 503, code: 'upstream_billing', release: false },
    { status: 401, error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'bad key' }, expect: 502, code: 'upstream_auth', release: false },
    { status: 404, error: { type: 'invalid_request_error', code: 'model_not_found', message: 'no model' }, expect: 502, code: 'upstream_model', release: false },
    { status: 500, error: { type: 'server_error', code: null, message: 'boom' }, expect: 503, code: 'upstream_unavailable', release: true },
    // OpenAI rechaza el pedido traducido: se informa la falla de Anthropic (el pedido era válido para él).
    { status: 400, error: { type: 'invalid_request_error', code: 'invalid_value', param: 'input', message: `eco ${SECRET}` }, expect: 503, code: 'upstream_overloaded', release: true },
  ];
  for (const c of cases) {
    reset('sonnet', 'claude-sonnet-5-5', true);
    state.anthropic = overloaded;
    state.openai = () => jsonResponse(c.status, { error: c.error }, { 'x-should-retry': 'false', 'x-request-id': 'req_oa_err' });
    const res = await run(post({ task: 'text', messages: [{ role: 'user', content: 'x' }], model: 'sonnet', client: v2 }), openaiHandler);
    assert.equal(res.status, c.expect, `${c.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, c.code, `${c.status}`);
    assert.equal(openaiCalls().length, 1, `${c.status}: sin reintentos`);
    assert.equal(rpcCalls().some((r) => r.fn === 'ai_release_turn'), c.release, `${c.status}: devolver la pregunta`);
    assert.ok(!rpcCalls().some((r) => r.fn === 'ai_add_usage'), `${c.status}: sin uso que registrar`);
  }
  assert.ok(consoleLines.some((l) => l.includes('provider=openai') && l.includes('request_id=req_oa_err')));
});

test(`index.ts con OPENAI_API_KEY (SDK ${openaiSdkKind}): json con salida estructurada estricta en OpenAI`, { skip }, async () => {
  reset('haiku', 'claude-haiku-5-5', false);
  state.anthropic = () => jsonResponse(500, { type: 'error', error: { type: 'api_error', message: 'Internal' } }, { 'x-should-retry': 'false' });
  state.openai = () =>
    jsonResponse(200, openaiResponse({
      model: 'gpt-6-luna',
      output: [{ id: 'm', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"ok":true,"nota":null}', annotations: [] }] }],
    }));
  const schema = { type: 'object', properties: { ok: { type: 'boolean' }, nota: { type: 'string' } }, required: ['ok'], additionalProperties: false };
  const res = await run(post({ task: 'json', messages: [{ role: 'user', content: 'x' }], schema, effort: 'low', client: v1 }), openaiHandler);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.parsed, { ok: true }, 'el null de una propiedad opcional se quita');
  const sent = openaiCalls()[0].body as Record<string, any>;
  assert.equal(sent.model, 'gpt-6-luna');
  assert.deepEqual(sent.reasoning, { effort: 'low' });
  assert.deepEqual(sent.text, {
    format: {
      type: 'json_schema',
      name: 'venus_respuesta',
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, nota: { type: ['string', 'null'] } }, required: ['ok', 'nota'], additionalProperties: false },
      strict: true,
    },
  });
  assert.deepEqual(res.body.message.served_by, { provider: 'openai', model: 'gpt-6-luna', failover: true });
});

test(`index.ts sin ANTHROPIC_API_KEY y con OPENAI_API_KEY (SDK ${openaiSdkKind}): responde OpenAI directo`, { skip }, async () => {
  reset('opus', 'claude-opus-5-5', true);
  state.openai = () => jsonResponse(200, openaiResponse({ model: 'gpt-6-astra' }));
  const res = await run(post({ task: 'text', messages: [{ role: 'user', content: 'Hola' }], model: 'opus', effort: 'high', client: v2 }), onlyOpenaiHandler);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(anthropicCalls().length, 0);
  const sent = openaiCalls()[0].body as Record<string, any>;
  assert.equal(sent.model, 'gpt-6-astra');
  assert.deepEqual(sent.reasoning, { effort: 'high' });
  assert.deepEqual(res.body.message.content, [{ type: 'text', text: 'Hola desde el respaldo.' }]);
  assert.deepEqual(res.body.message.served_by, { provider: 'openai', model: 'gpt-6-astra', failover: true });
  assert.deepEqual(rpcCalls().find((r) => r.fn === 'ai_add_usage')?.body?.p_usage, [{ model: 'gpt-6-astra', input: 500, output: 120, cacheRead: 2000, cacheWrite: 500 }]);
  assert.ok(consoleLines.some((l) => l.includes('respaldo: anthropic -> openai (not_configured)')));
});

test('index.ts: nada del contenido de la conversación aparece en los logs', { skip }, () => {
  for (const line of consoleLines) assert.ok(!line.includes(SECRET), line);
  assert.ok(consoleLines.some((line) => line.includes('[ai-assistant]')));
});
