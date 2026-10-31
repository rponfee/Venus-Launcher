// Pruebas del respaldo en OpenAI con el flujo HTTP completo (node --test): dobles de Anthropic y de OpenAI y la
// base en memoria (tests/fake-db.ts, que replica 0008 y 0011). Cubre la tabla de decisión (qué fallas pasan al
// otro proveedor y cuáles no), las claves que faltan, el orden de los proveedores, el costo con el precio del
// modelo que respondió, la pregunta contada en el modelo de Venus y un ciclo de herramientas entre proveedores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_FAILOVER_MS } from '../config.ts';
import type { UpstreamFailure } from '../errors.ts';
import { createHandler } from '../handler.ts';
import type { Deps, ModelCall, ModelResult } from '../handler.ts';
import { openaiStatusFailure } from '../openai.ts';
import { FakeDb } from './fake-db.ts';

const URL_FN = 'https://proyecto.supabase.co/functions/v1/ai-assistant';
const v1 = { app: 'venus-launcher', protocol: 1 };
const v2 = { app: 'venus-launcher', protocol: 2 };
const SECRET = 'texto-privado-del-usuario-9921';
const USER = 'user-1';

type Body = Record<string, any>;

interface Recorder {
  rpc: { name: string; args: Record<string, unknown> }[];
  anthropic: ModelCall[];
  openai: Record<string, any>[];
  logs: { level: 'warn' | 'error'; line: string }[];
}

interface Setup {
  /** Plan del usuario (por defecto 'pro': Haiku y Sonnet). */
  plan?: string;
  db?: FakeDb;
  /** Lo que hace Anthropic: devuelve un resultado o lanza fail(...). */
  anthropic?: (call: ModelCall, n: number) => ModelResult | Promise<ModelResult>;
  /** Lo que hace OpenAI: devuelve la respuesta cruda de la Responses API o lanza fail(...). */
  openai?: (body: Record<string, any>, n: number) => unknown;
}

function fail(failure: UpstreamFailure): Error {
  return Object.assign(new Error('falla simulada'), { failure });
}

const overloaded: UpstreamFailure = { kind: 'status', status: 529, type: 'overloaded_error', requestId: 'req_529' };

function openaiResponse(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    model: 'gpt-6.1-sol',
    output: [
      { id: 'rs_1', type: 'reasoning', summary: [] },
      { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Respuesta del respaldo.', annotations: [] }] },
    ],
    usage: { input_tokens: 3000, input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 500 }, output_tokens: 120, output_tokens_details: { reasoning_tokens: 80 } },
    ...extra,
  };
}

function makeDeps(setup: Setup = {}, overrides: Partial<Deps> = {}): { deps: Deps; rec: Recorder; db: FakeDb } {
  const db = setup.db ?? new FakeDb();
  if (!setup.db) db.subscribe(USER, setup.plan ?? 'pro');
  const rec: Recorder = { rpc: [], anthropic: [], openai: [], logs: [] };
  const deps: Deps = {
    supabaseReady: true,
    modelReady: true,
    openaiReady: true,
    timeoutMs: 140000,
    async verifyUser(token) {
      return token === 'good' ? { status: 'ok', userId: USER } : { status: 'invalid' };
    },
    async rpc(name, args) {
      rec.rpc.push({ name, args });
      return db.rpc(name, args);
    },
    prepareFormat(schema) {
      return { type: 'json_schema', schema };
    },
    async callModel(call) {
      rec.anthropic.push(call);
      if (setup.anthropic) return setup.anthropic(call, rec.anthropic.length);
      return { content: [{ type: 'text', text: 'Listo.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, model: call.model, parsed: null };
    },
    describeError(err, context) {
      if (context.timedOut) return { kind: 'timeout' };
      if (context.clientAborted) return { kind: 'aborted' };
      return (err as { failure?: UpstreamFailure }).failure ?? { kind: 'unknown', name: 'Error' };
    },
    async callOpenAI(body) {
      rec.openai.push(body as Record<string, any>);
      return setup.openai ? setup.openai(body as Record<string, any>, rec.openai.length) : openaiResponse({ model: (body as Body).model });
    },
    describeOpenAIError(err, context) {
      if (context.timedOut) return { kind: 'timeout' };
      if (context.clientAborted) return { kind: 'aborted' };
      return (err as { failure?: UpstreamFailure }).failure ?? { kind: 'unknown', name: 'Error' };
    },
    logger: { warn: (line) => rec.logs.push({ level: 'warn', line }), error: (line) => rec.logs.push({ level: 'error', line }) },
    ...overrides,
  };
  return { deps, rec, db };
}

function post(body: unknown, init: RequestInit = {}): Request {
  return new Request(URL_FN, {
    method: 'POST',
    headers: { Authorization: 'Bearer good', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

function v2Body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { task: 'text', model: 'sonnet', effort: 'low', messages: [{ role: 'user', content: `Hola ${SECRET}` }], client: v2, ...extra };
}

async function call(deps: Deps, req: Request, handler = createHandler(deps)): Promise<{ status: number; body: Body }> {
  const res = await handler(req);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

function modelQuota(body: Body, id: string): Body {
  return (body.quota.models as Body[]).find((m) => m.id === id) as Body;
}

const lines = (rec: Recorder) => rec.logs.map((l) => l.line);

// ---------- Respaldo ----------

test('Anthropic saturada (529): responde OpenAI; la pregunta queda en Sonnet y el costo, en GPT-6.1 Sol con su precio', async () => {
  const { deps, rec, db } = makeDeps({ anthropic: () => { throw fail(overloaded); } });
  const { status, body } = await call(deps, post(v2Body({ system: `Sistema ${SECRET}` })));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(rec.anthropic.length, 1);
  assert.equal(rec.openai.length, 1);
  const sent = rec.openai[0];
  assert.equal(sent.model, 'gpt-6.1-sol');
  assert.deepEqual(sent.reasoning, { effort: 'low' });
  assert.equal(sent.store, false);
  assert.ok(sent.instructions.startsWith('# Política del servidor de Venus Launcher'));
  assert.ok(sent.instructions.endsWith(`Sistema ${SECRET}`));
  assert.deepEqual(sent.input, [{ role: 'user', content: `Hola ${SECRET}` }]);
  assert.deepEqual(body.message, {
    content: [{ type: 'text', text: 'Respuesta del respaldo.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 500, output_tokens: 120, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 },
    model: 'gpt-6.1-sol',
    served_by: { provider: 'openai', model: 'gpt-6.1-sol', failover: true },
  });
  // La pregunta cuenta en Sonnet (como siempre); la fila de Sonnet no suma llamadas ni costo de esta respuesta.
  assert.deepEqual(modelQuota(body, 'sonnet').daily, { used: 1, limit: 5 });
  const sonnet = db.usageRow(USER, db.today(), 'sonnet');
  assert.deepEqual([sonnet?.questions, sonnet?.calls, sonnet?.costMicros], [1, 0, 0]);
  // GPT-6.1 Sol: 500 x 2 + 120 x 10 + 2000 x 0,10 + 500 x 2,50 = 3650 millonésimas de dólar.
  const sol = db.usageRow(USER, db.today(), 'gpt-6-1-sol');
  assert.deepEqual({ ...sol, updatedAt: 0 }, { questions: 0, calls: 1, input: 500, output: 120, cacheRead: 2000, cacheWrite: 500, costMicros: 3650, updatedAt: 0 });
  assert.equal(body.quota.budget.usedUsd, 0.0037, 'el presupuesto suma el costo de OpenAI');
  assert.deepEqual(rec.rpc.find((r) => r.name === 'ai_add_usage')?.args, {
    p_user: USER,
    p_model: 'sonnet',
    p_usage: [{ model: 'gpt-6.1-sol', input: 500, output: 120, cacheRead: 2000, cacheWrite: 500 }],
  });
  assert.ok(!rec.rpc.some((r) => r.name === 'ai_release_turn'));
  assert.ok(lines(rec).some((l) => l.includes('respaldo: anthropic -> openai (upstream_overloaded)')));
  assert.equal(body.quota.lastModel, 'sonnet', 'el último modelo sigue siendo el de Venus');
});

test('tabla de decisión: las fallas del proveedor pasan a OpenAI; el rechazo, los 400 y lo desconocido no', async () => {
  const status = (code: number, type: string | null = null, detail: string | null = null): UpstreamFailure => ({ kind: 'status', status: code, type, detail });
  const switches: [string, UpstreamFailure][] = [
    ['429 límite de la organización', status(429, 'rate_limit_error')],
    ['529 saturada', status(529, 'overloaded_error')],
    ['500', status(500, 'api_error')],
    ['503', status(503)],
    ['504', status(504, 'timeout_error')],
    ['plazo del SDK (con tiempo de sobra)', { kind: 'timeout' }],
    ['red', { kind: 'connection' }],
    ['sin crédito', status(402, 'billing_error')],
    ['sin crédito (400)', status(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.')],
    ['clave inválida', status(401, 'authentication_error')],
    ['sin permiso', status(403, 'permission_error')],
    ['beta no habilitado', status(400, 'invalid_request_error', 'Unexpected value(s) for the `anthropic-beta` header')],
    ['modelo no disponible', status(404, 'not_found_error')],
  ];
  for (const [name, failure] of switches) {
    const { deps, rec } = makeDeps({ anthropic: () => { throw fail(failure); } });
    const res = await call(deps, post(v2Body()));
    assert.equal(res.status, 200, `${name}: ${JSON.stringify(res.body)}`);
    assert.equal(rec.openai.length, 1, name);
    assert.equal(res.body.message.served_by.failover, true, name);
  }
  const stays: [string, UpstreamFailure, number, string][] = [
    ['pedido inválido', status(400, 'invalid_request_error', 'messages.0: bad'), 400, 'upstream_invalid_request'],
    ['demasiado grande', status(413, 'request_too_large'), 400, 'upstream_invalid_request'],
    ['desconocido (no está en failover_on por defecto)', { kind: 'unknown', name: 'TypeError' }, 502, 'upstream_error'],
    ['cancelado', { kind: 'aborted' }, 503, 'aborted'],
  ];
  for (const [name, failure, expected, code] of stays) {
    const { deps, rec } = makeDeps({ anthropic: () => { throw fail(failure); } });
    const res = await call(deps, post(v2Body()));
    assert.equal(res.status, expected, name);
    assert.equal(res.body.code, code, name);
    assert.equal(rec.openai.length, 0, `${name}: no pasa a OpenAI`);
  }
  // Rechazo de la IA (stop_reason "refusal"): 422 y nunca pasa a OpenAI.
  const refused = makeDeps({ anthropic: (c) => ({ content: [], stop_reason: 'refusal', usage: { input_tokens: 40, output_tokens: 0 }, model: c.model, parsed: null }) });
  const refusal = await call(refused.deps, post(v2Body()));
  assert.equal(refusal.status, 422);
  assert.equal(refusal.body.error, 'refusal');
  assert.equal(refused.rec.openai.length, 0);
  assert.ok(refused.rec.rpc.some((r) => r.name === 'ai_add_usage'), 'el rechazo se cobra igual');
});

test('failover_on se edita en la base: sin "overloaded", un 529 no pasa; con "unknown", lo desconocido sí', async () => {
  const db = new FakeDb();
  db.subscribe(USER, 'pro');
  (db.providerConfig as { failoverOn: string[] }).failoverOn = ['rate_limited', 'unknown'];
  const a = makeDeps({ db, anthropic: () => { throw fail(overloaded); } });
  const res = await call(a.deps, post(v2Body()));
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'upstream_overloaded');
  assert.equal(a.rec.openai.length, 0);
  const b = makeDeps({ db, anthropic: () => { throw fail({ kind: 'unknown', name: 'TypeError' }); } });
  assert.equal((await call(b.deps, post(v2Body()))).status, 200);
  assert.equal(b.rec.openai.length, 1);
  // Respaldo apagado: todo como antes (solo Anthropic).
  (db.providerConfig as { failoverEnabled: boolean }).failoverEnabled = false;
  const c = makeDeps({ db, anthropic: () => { throw fail({ kind: 'status', status: 429, type: 'rate_limit_error' }); } });
  const off = await call(c.deps, post(v2Body()));
  assert.equal(off.status, 503);
  assert.equal(off.body.code, 'upstream_rate_limited');
  assert.equal(c.rec.openai.length, 0);
  assert.ok(c.rec.rpc.some((r) => r.name === 'ai_release_turn'), 'la pregunta se devuelve como siempre');
});

// ---------- Claves que faltan ----------

test('sin OPENAI_API_KEY: no lee la configuración y nunca pasa a OpenAI (como antes de 0011)', async () => {
  const { deps, rec } = makeDeps({ anthropic: () => { throw fail(overloaded); } }, { openaiReady: false });
  const res = await call(deps, post(v2Body({ turn_id: 'k-1' })));
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'upstream_overloaded');
  assert.equal(rec.openai.length, 0);
  assert.deepEqual(rec.rpc.map((r) => r.name), ['ai_register_turn', 'ai_release_turn', 'ai_end_call']);
  assert.deepEqual(modelQuota(res.body, 'sonnet').daily, { used: 0, limit: 5 });
});

test('sin ANTHROPIC_API_KEY: responde OpenAI directo (failover true)', async () => {
  const { deps, rec, db } = makeDeps({}, { modelReady: false });
  const res = await call(deps, post(v2Body({ model: 'haiku' })));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(rec.anthropic.length, 0);
  assert.equal(rec.openai[0].model, 'gpt-6-luna');
  assert.deepEqual(res.body.message.served_by, { provider: 'openai', model: 'gpt-6-luna', failover: true });
  assert.equal(db.usageRow(USER, db.today(), 'haiku')?.questions, 1);
  assert.equal(db.usageRow(USER, db.today(), 'gpt-6-luna')?.calls, 1);
  assert.ok(lines(rec).some((l) => l.includes('respaldo: anthropic -> openai (not_configured)')));
});

test('sin ANTHROPIC_API_KEY: un pedido inválido para OpenAI llega como 400 (no como "no configurado")', async () => {
  const { deps, rec } = makeDeps(
    { openai: () => { throw fail(openaiStatusFailure({ status: 400, code: 'context_length_exceeded', param: 'input', message: 'Input too long' })); } },
    { modelReady: false },
  );
  const res = await call(deps, post(v2Body({ turn_id: 'largo' })));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'upstream_invalid_request');
  assert.match(String(res.body.message), /Input too long/);
  assert.ok(!rec.rpc.some((r) => r.name === 'ai_release_turn'), 'como con Anthropic: un pedido inválido no devuelve la pregunta');
});

test('sin ANTHROPIC_API_KEY y con el respaldo apagado (o sin not_configured): 503 not_configured sin gastar una pregunta', async () => {
  for (const change of [
    (db: FakeDb) => ((db.providerConfig as { failoverEnabled: boolean }).failoverEnabled = false),
    (db: FakeDb) => ((db.providerConfig as { failoverOn: string[] }).failoverOn = ['overloaded']),
    (db: FakeDb) => (db.providerConfig = null),
  ]) {
    const db = new FakeDb();
    db.subscribe(USER, 'pro');
    change(db);
    const { deps, rec } = makeDeps({ db }, { modelReady: false });
    const res = await call(deps, post(v2Body()));
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'not_configured');
    assert.deepEqual(rec.rpc.map((r) => r.name), ['ai_provider_settings'], 'no toca la cuota');
    assert.equal(db.turns.size, 0);
  }
  // Sin ninguna de las dos claves: 503 enseguida (ni siquiera lee el cuerpo).
  const none = makeDeps({}, { modelReady: false, openaiReady: false });
  const res = await call(none.deps, post(v2Body()));
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'not_configured');
  assert.equal(none.rec.rpc.length, 0);
});

test('sin ANTHROPIC_API_KEY y sin modelo de OpenAI para esa pregunta: 503 sin gastar la pregunta', async () => {
  // Modelo pedido por el launcher: se sabe antes de tocar la cuota.
  const db = new FakeDb();
  db.subscribe(USER, 'pro');
  db.tierFallbacks.delete('sonnet');
  const a = makeDeps({ db }, { modelReady: false });
  const explicit = await call(a.deps, post(v2Body({ turn_id: 'sin-modelo-1' })));
  assert.equal(explicit.status, 503);
  assert.equal(explicit.body.code, 'not_configured');
  assert.deepEqual(a.rec.rpc.map((r) => r.name), ['ai_provider_settings']);
  // Modelo que elige la base (el primero del plan, Haiku): la pregunta se abre y se devuelve.
  db.tierFallbacks.delete('haiku');
  const b = makeDeps({ db }, { modelReady: false });
  const resolved = await call(b.deps, post(v2Body({ model: null, turn_id: 'sin-modelo-2' })));
  assert.equal(resolved.status, 503);
  assert.equal(resolved.body.code, 'not_configured');
  assert.deepEqual(b.rec.rpc.map((r) => r.name), ['ai_provider_settings', 'ai_register_turn', 'ai_release_turn', 'ai_end_call']);
  assert.equal(db.inflight(USER), 0, 'la llamada quedó cerrada');
  assert.deepEqual(modelQuota(resolved.body, 'haiku').daily, { used: 0, limit: 25 });
  assert.ok(lines(b.rec).some((l) => l.includes('ningún proveedor puede atender el modelo haiku')));
});

// ---------- Si los dos fallan ----------

test('si los dos fallan: se informa la falla del respaldo, salvo un 400 (ahí la de Anthropic); la pregunta se devuelve si nadie la procesó', async () => {
  const oa = (info: Record<string, unknown>) => () => { throw fail(openaiStatusFailure({ ...info, requestId: 'req_oa', message: `eco ${SECRET}` })); };
  const cases: [string, () => never, number, string, boolean][] = [
    ['OpenAI también caído', oa({ status: 503 }), 503, 'upstream_unavailable', true],
    ['OpenAI sin crédito', oa({ status: 429, code: 'insufficient_quota' }), 503, 'upstream_billing', false],
    ['OpenAI rechaza el pedido traducido', oa({ status: 400, code: 'invalid_value', param: 'input' }), 503, 'upstream_overloaded', true],
    ['OpenAI con un parámetro mal configurado', oa({ status: 400, code: 'unsupported_value', param: 'reasoning.effort' }), 502, 'upstream_config', false],
  ];
  for (const [name, openai, expected, code, released] of cases) {
    const { deps, rec } = makeDeps({ anthropic: () => { throw fail(overloaded); }, openai });
    const res = await call(deps, post(v2Body({ turn_id: `dos-${code}` })));
    assert.equal(res.status, expected, `${name}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, code, name);
    assert.equal(rec.rpc.some((r) => r.name === 'ai_release_turn'), released, `${name}: devolver la pregunta`);
    assert.equal(modelQuota(res.body, 'sonnet').daily.used, released ? 0 : 1, name);
    assert.ok(!rec.rpc.some((r) => r.name === 'ai_add_usage'), name);
    assert.ok(lines(rec).some((l) => l.includes('provider=openai') && l.includes('request_id=req_oa')), name);
  }
  // El 400 de OpenAI (problema de la traducción) queda en el log como error.
  const { deps, rec } = makeDeps({ anthropic: () => { throw fail(overloaded); }, openai: oa({ status: 400, code: 'invalid_value', param: 'input' }) });
  await call(deps, post(v2Body()));
  assert.ok(rec.logs.some((l) => l.level === 'error' && l.line.includes('upstream_invalid_request') && l.line.includes('provider=openai')));
});

// ---------- Plazo y cancelación ----------

test('sin tiempo para el respaldo: si quedan menos de MIN_FAILOVER_MS, no se prueba OpenAI', async () => {
  let clock = 1_000_000;
  const { deps, rec } = makeDeps(
    {
      anthropic: () => {
        clock += 140000 - MIN_FAILOVER_MS + 1000; // Anthropic tardó casi todo el plazo y después falló.
        throw fail(overloaded);
      },
    },
    { now: () => clock },
  );
  const res = await call(deps, post(v2Body()));
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'upstream_overloaded');
  assert.equal(rec.openai.length, 0);
  assert.ok(lines(rec).some((l) => l.includes('sin tiempo para el respaldo')));
});

test('plazo vencido o launcher que cancela: nunca pasa a OpenAI', async () => {
  const timed = makeDeps({}, {
    timeoutMs: 30,
    callModel: (_c: ModelCall, signal: AbortSignal) => new Promise<ModelResult>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  const res = await call(timed.deps, post(v2Body()));
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'upstream_timeout');
  assert.equal(timed.rec.openai.length, 0);

  const controller = new AbortController();
  const cancelled = makeDeps({}, {
    callModel: (_c: ModelCall, signal: AbortSignal) =>
      new Promise<ModelResult>((_r, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        setTimeout(() => controller.abort(), 5);
      }),
  });
  const out = await call(cancelled.deps, post(v2Body(), { signal: controller.signal }));
  assert.equal(out.status, 503);
  assert.equal(out.body.code, 'aborted');
  assert.equal(cancelled.rec.openai.length, 0);
});

// ---------- Orden de los proveedores ----------

test('OpenAI como principal (ai_provider_config): primero OpenAI; si falla, Anthropic; un rechazo de OpenAI no pasa', async () => {
  const swap = (db: FakeDb) => {
    db.providerConfig = { primary: 'openai', secondary: 'anthropic', failoverEnabled: true, failoverOn: ['overloaded', 'unavailable', 'rate_limited'] };
  };
  const db = new FakeDb();
  db.subscribe(USER, 'pro');
  swap(db);
  const first = makeDeps({ db });
  const ok = await call(first.deps, post(v2Body()));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.message.served_by, { provider: 'openai', model: 'gpt-6.1-sol', failover: false });
  assert.equal(first.rec.anthropic.length, 0);

  const second = makeDeps({ db, openai: () => { throw fail(openaiStatusFailure({ status: 503 })); } });
  const back = await call(second.deps, post(v2Body()));
  assert.equal(back.status, 200);
  assert.deepEqual(back.body.message.served_by, { provider: 'anthropic', model: 'claude-sonnet-5-5', failover: true });
  assert.ok(lines(second.rec).some((l) => l.includes('respaldo: openai -> anthropic (upstream_unavailable)')));

  const third = makeDeps({ db, openai: () => openaiResponse({ status: 'failed', error: { code: 'bio_policy', message: 'x' } }) });
  const refused = await call(third.deps, post(v2Body()));
  assert.equal(refused.status, 422);
  assert.equal(third.rec.anthropic.length, 0, 'un rechazo de seguridad nunca pasa al otro proveedor');
});

// ---------- Ciclo de herramientas entre proveedores ----------

test('ciclo de herramientas: la llamada 1 la atiende OpenAI y la 2 Anthropic, con los mismos ids y una sola pregunta', async () => {
  const db = new FakeDb();
  db.subscribe(USER, 'pro');
  const tools = [
    { name: 'list_mods', description: 'Lista los mods', input_schema: { type: 'object', properties: { instance_id: { type: 'string' } }, required: ['instance_id'], additionalProperties: false } },
  ];
  // Llamada 1: Anthropic saturada, OpenAI pide una herramienta.
  const one = makeDeps({
    db,
    anthropic: () => { throw fail(overloaded); },
    openai: () =>
      openaiResponse({
        output: [
          { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Busco tus mods.', annotations: [] }] },
          { id: 'fc_1', type: 'function_call', call_id: 'call_Zx9', name: 'list_mods', arguments: '{"instance_id":"i1"}', status: 'completed' },
        ],
      }),
  });
  const userMsg = { role: 'user', content: '¿Qué mods tengo?' };
  const r1 = await call(one.deps, post(v2Body({ task: 'assistant', tools, turn_id: 'ciclo-1', messages: [userMsg] })));
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.message.stop_reason, 'tool_use');
  assert.deepEqual(r1.body.message.content, [
    { type: 'text', text: 'Busco tus mods.' },
    { type: 'tool_use', id: 'call_Zx9', name: 'list_mods', input: { instance_id: 'i1' } },
  ]);

  // Llamada 2 (mismo turn_id): Anthropic ya responde y recibe la conversación intacta, con el tool_use de OpenAI.
  const messages = [
    userMsg,
    { role: 'assistant', content: r1.body.message.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_Zx9', content: '{"mods":["sodium"]}' }] },
  ];
  const two = makeDeps({ db });
  const r2 = await call(two.deps, post(v2Body({ task: 'assistant', tools, turn_id: 'ciclo-1', messages })));
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.deepEqual(two.rec.anthropic[0].messages, messages);
  assert.deepEqual(two.rec.anthropic[0].tools, tools);
  assert.deepEqual(r2.body.message.served_by, { provider: 'anthropic', model: 'claude-sonnet-5-5', failover: false });
  // Una sola pregunta de Sonnet; una llamada en cada proveedor.
  assert.equal(db.usageRow(USER, db.today(), 'sonnet')?.questions, 1);
  assert.equal(db.usageRow(USER, db.today(), 'sonnet')?.calls, 1);
  assert.equal(db.usageRow(USER, db.today(), 'gpt-6-1-sol')?.calls, 1);
  assert.equal(db.turnRow(USER, 'ciclo-1', db.today())?.calls, 2);

  // Llamada 3: de nuevo por OpenAI; el call_id del tool_result vuelve igual.
  const three = makeDeps({ db, anthropic: () => { throw fail(overloaded); } });
  const followUp = [...messages, { role: 'assistant', content: [{ type: 'text', text: 'Tenés sodium.' }] }, { role: 'user', content: 'Gracias' }];
  assert.equal((await call(three.deps, post(v2Body({ task: 'assistant', tools, turn_id: 'ciclo-1', messages: followUp })))).status, 200);
  assert.deepEqual(three.rec.openai[0].input, [
    { role: 'user', content: '¿Qué mods tengo?' },
    { role: 'assistant', content: 'Busco tus mods.', phase: 'commentary' },
    { type: 'function_call', call_id: 'call_Zx9', name: 'list_mods', arguments: '{"instance_id":"i1"}' },
    { type: 'function_call_output', call_id: 'call_Zx9', output: '{"mods":["sodium"]}' },
    { role: 'assistant', content: 'Tenés sodium.', phase: 'final_answer' },
    { role: 'user', content: 'Gracias' },
  ]);
  assert.deepEqual(three.rec.openai[0].tools, [{ type: 'function', name: 'list_mods', description: 'Lista los mods', parameters: tools[0].input_schema, strict: false }]);
  assert.equal(db.usageRow(USER, db.today(), 'sonnet')?.questions, 1);
});

test('json por OpenAI: salida estructurada estricta y parsed', async () => {
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, text: { type: 'string' } }, required: ['key', 'text'], additionalProperties: false } } }, required: ['items'], additionalProperties: false };
  const { deps, rec } = makeDeps({
    anthropic: () => { throw fail({ kind: 'connection' }); },
    openai: () => openaiResponse({ model: 'gpt-6-luna', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"items":[{"key":"a","text":"b"}]}', annotations: [] }] }] }),
  });
  const res = await call(deps, post({ task: 'json', schema, messages: [{ role: 'user', content: 'x' }], effort: 'low', client: v1 }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.parsed, { items: [{ key: 'a', text: 'b' }] });
  assert.deepEqual(rec.openai[0].text, { format: { type: 'json_schema', name: 'venus_respuesta', schema, strict: true } });
  assert.equal(rec.openai[0].model, 'gpt-6-luna', 'protocolo 1: Haiku (el primero del plan) -> GPT-6 Luna');
});

// ---------- Configuración ----------

test('configuración de proveedores: se lee una vez por minuto; si no se puede leer, solo Anthropic', async () => {
  let clock = 5_000_000;
  const { deps, rec } = makeDeps({}, { now: () => clock });
  const handler = createHandler(deps);
  await call(deps, post(v2Body()), handler);
  await call(deps, post(v2Body()), handler);
  assert.equal(rec.rpc.filter((r) => r.name === 'ai_provider_settings').length, 1);
  clock += 61000;
  await call(deps, post(v2Body()), handler);
  assert.equal(rec.rpc.filter((r) => r.name === 'ai_provider_settings').length, 2);

  // Sin la migración 0011 (o la base no responde): solo Anthropic, con un aviso.
  const missing = makeDeps({ anthropic: () => { throw fail(overloaded); } });
  const original = missing.deps.rpc;
  missing.deps.rpc = async (name, args) => {
    if (name === 'ai_provider_settings') throw Object.assign(new Error('x'), { code: 'PGRST202' });
    return original(name, args);
  };
  const res = await call(missing.deps, post(v2Body()));
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'upstream_overloaded');
  assert.equal(missing.rec.openai.length, 0);
  assert.ok(lines(missing.rec).some((l) => l.includes('no se pudo leer la configuración de proveedores (PGRST202)')));
  // Respuesta con otra forma: también solo Anthropic.
  const odd = makeDeps({ anthropic: () => { throw fail(overloaded); } });
  const oddRpc = odd.deps.rpc;
  odd.deps.rpc = async (name, args) => (name === 'ai_provider_settings' ? { primary: 'gemini' } : oddRpc(name, args));
  assert.equal((await call(odd.deps, post(v2Body()))).status, 503);
  assert.equal(odd.rec.openai.length, 0);
});

// ---------- Costo ----------

test('costo de OpenAI: tarifa de más de 272K tokens, varios modelos en una llamada y modelos sin precio', async () => {
  const db = new FakeDb();
  db.subscribe(USER, 'max');
  // 200.000 de entrada + 80.000 en caché = 280.000 > 272.000: todo el pedido con la tarifa larga (4 / 15 / 0,20 / 5).
  const long = (await db.rpc('ai_add_usage', { p_user: USER, p_model: 'sonnet', p_usage: [{ model: 'gpt-6.1-sol', input: 200000, output: 1000, cacheRead: 80000, cacheWrite: 0 }] })) as Body;
  assert.equal(db.usageRow(USER, db.today(), 'gpt-6-1-sol')?.costMicros, 200000 * 4 + 1000 * 15 + 80000 * 0.2);
  assert.equal(long.costUsd, 0.831);
  // GPT-6 Astra: 1000 x 10 + 100 x 50 + 1000 x 1 + 100 x 12,50 = 17250.
  await db.rpc('ai_add_usage', { p_user: USER, p_model: 'opus', p_usage: [{ model: 'gpt-6-astra', input: 1000, output: 100, cacheRead: 1000, cacheWrite: 100 }] });
  assert.equal(db.usageRow(USER, db.today(), 'gpt-6-astra')?.costMicros, 17250);
  assert.equal(db.usageRow(USER, db.today(), 'opus'), undefined, 'el uso de OpenAI no toca la fila de Opus');
  // Anthropic con su reintento y un modelo sin precio: todo en la fila de la pregunta, como en 0008.
  const mixed = (await db.rpc('ai_add_usage', {
    p_user: USER,
    p_model: 'opus',
    p_usage: [
      { model: 'claude-opus-5-5', input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      { model: 'gpt-9-ultra', input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      { model: 'gpt-6-luna', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
    ],
  })) as Body;
  assert.deepEqual(mixed.unpriced, ['gpt-9-ultra']);
  assert.equal(db.usageRow(USER, db.today(), 'opus')?.costMicros, 2 * (100 * 4 + 10 * 20));
  assert.equal(db.usageRow(USER, db.today(), 'opus')?.calls, 1);
  assert.equal(db.usageRow(USER, db.today(), 'gpt-6-luna')?.costMicros, 1000 * 0.1 + 100 * 0.5);
  // El presupuesto del mes suma todas las filas.
  const quota = db.quotaStatus(USER) as Body;
  assert.equal(quota.budget.usedUsd, Math.round((831000 + 17250 + 1200 + 150) / 100) / 10000);
});

test('los logs nunca incluyen el contenido de la conversación (también con el respaldo)', async () => {
  const scenarios: Setup[] = [
    { anthropic: () => { throw fail(overloaded); } },
    { anthropic: () => { throw fail(overloaded); }, openai: () => { throw fail(openaiStatusFailure({ status: 400, code: 'invalid_value', param: 'input', message: `eco ${SECRET}` })); } },
    { anthropic: () => { throw fail(overloaded); }, openai: () => openaiResponse({ status: 'failed', error: { code: 'invalid_image', message: SECRET } }) },
    { anthropic: () => { throw fail(overloaded); }, openai: () => openaiResponse({ output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: SECRET, annotations: [] }] }] }) },
  ];
  for (const setup of scenarios) {
    const { deps, rec } = makeDeps(setup);
    await call(deps, post(v2Body({ system: `Sistema ${SECRET}` })));
    for (const line of lines(rec)) assert.ok(!line.includes(SECRET), line);
  }
});
