// Pruebas del flujo HTTP completo con dobles de Supabase y de Anthropic (node --test).
// La base es FakeDb: una réplica en memoria de las funciones SQL de 0008 (ver tests/fake-db.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, readBody } from '../handler.ts';
import type { Deps, ModelCall, ModelResult } from '../handler.ts';
import type { UpstreamFailure } from '../errors.ts';
import { FakeDb, TIMEZONE } from './fake-db.ts';

const URL_FN = 'https://proyecto.supabase.co/functions/v1/ai-assistant';
const v1 = { app: 'venus-launcher', protocol: 1 };
const v2 = { app: 'venus-launcher', protocol: 2 };
const SECRET = 'texto-privado-del-usuario-7781';
const USER = 'user-1';

interface Recorder {
  rpc: { name: string; args: Record<string, unknown> }[];
  model: ModelCall[];
  logs: string[];
  formats: Record<string, unknown>[];
}

type Setup = {
  /** Plan del usuario de prueba (null = sin suscripción). Por defecto 'pro' (Haiku y Sonnet). */
  plan?: string | null;
  db?: FakeDb;
  /** Reemplaza la respuesta de ai_register_turn (para probar respuestas raras de la base). */
  register?: unknown;
  result?: ModelResult | ((call: ModelCall) => ModelResult);
  failure?: UpstreamFailure;
};

function fail(failure: UpstreamFailure): Error {
  return Object.assign(new Error('falla simulada'), { failure });
}

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 };

function makeDeps(setup: Setup = {}, overrides: Partial<Deps> = {}): { deps: Deps; rec: Recorder; db: FakeDb } {
  const db = setup.db ?? new FakeDb();
  if (!setup.db && setup.plan !== null) db.subscribe(USER, setup.plan ?? 'pro');
  const rec: Recorder = { rpc: [], model: [], logs: [], formats: [] };
  const deps: Deps = {
    supabaseReady: true,
    modelReady: true,
    timeoutMs: 5000,
    async verifyUser(token) {
      if (token === 'good') return { status: 'ok', userId: USER };
      if (token === 'down') return { status: 'unavailable' };
      if (token === 'anon') return { status: 'forbidden', reason: 'anonymous' };
      if (token === 'unconfirmed') return { status: 'forbidden', reason: 'unconfirmed' };
      return { status: 'invalid' };
    },
    async rpc(name, args) {
      rec.rpc.push({ name, args });
      if (name === 'ai_register_turn' && setup.register !== undefined) return setup.register;
      return db.rpc(name, args);
    },
    prepareFormat(schema) {
      rec.formats.push(schema);
      return { type: 'json_schema', schema };
    },
    async callModel(call) {
      rec.model.push(call);
      if (setup.failure) throw fail(setup.failure);
      const result = typeof setup.result === 'function' ? setup.result(call) : setup.result;
      return result ?? { content: [{ type: 'text', text: 'Listo.' }], stop_reason: 'end_turn', usage: USAGE, model: call.model, parsed: null };
    },
    describeError(err, context) {
      if (context.timedOut) return { kind: 'timeout' };
      if (context.clientAborted) return { kind: 'aborted' };
      return (err as { failure?: UpstreamFailure }).failure ?? { kind: 'unknown', name: 'Error' };
    },
    logger: { warn: (m) => rec.logs.push(m), error: (m) => rec.logs.push(m) },
    ...overrides,
  };
  return { deps, rec, db };
}

function post(body: unknown, headers: Record<string, string> = {}, init: RequestInit = {}): Request {
  return new Request(URL_FN, {
    method: 'POST',
    headers: { Authorization: 'Bearer good', 'Content-Type': 'application/json', apikey: 'anon', ...headers },
    body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
    ...init,
  });
}

function get(token = 'good'): Request {
  return new Request(URL_FN, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
}

/** Pedido del protocolo 1 (como el launcher de antes: sin modelo). */
function textBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: 'text',
    system: 'Respondé en una línea.',
    messages: [{ role: 'user', content: `Hola ${SECRET}` }],
    max_tokens: 2000,
    effort: 'low',
    client: v1,
    ...extra,
  };
}

/** Pedido del protocolo 2. */
function v2Body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { task: 'text', messages: [{ role: 'user', content: 'Hola' }], client: v2, ...extra };
}

type Body = Record<string, any>;

async function call(deps: Deps, req: Request): Promise<{ status: number; body: Body; res: Response }> {
  const res = await createHandler(deps)(req);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, res };
}

function modelQuota(body: Body, id: string): Body {
  return (body.quota.models as Body[]).find((m) => m.id === id) as Body;
}

// ---------- CORS, sesión y configuración ----------

test('OPTIONS responde CORS sin autenticación', async () => {
  const { deps } = makeDeps();
  const res = await createHandler(deps)(new Request(URL_FN, { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/);
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /apikey/);
});

test('otros métodos: 405', async () => {
  const { deps } = makeDeps();
  const { status, body, res } = await call(deps, new Request(URL_FN, { method: 'PUT', headers: { Authorization: 'Bearer good' } }));
  assert.equal(status, 405);
  assert.equal(body.error, 'bad_request');
  assert.equal(body.code, 'method_not_allowed');
  assert.equal(res.headers.get('allow'), 'GET, POST, OPTIONS');
});

test('sesión: sin token o con token inválido responde 401 { error: "unauthorized" }', async () => {
  const { deps, rec } = makeDeps();
  for (const auth of [undefined, 'Bearer bad', 'Basic dXNlcjpwYXNz', 'Bearer ', 'Bearer a b']) {
    const headers: Record<string, string> = auth ? { Authorization: auth } : {};
    const res = await createHandler(deps)(new Request(URL_FN, { method: 'GET', headers }));
    assert.equal(res.status, 401, String(auth));
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  }
  assert.equal(rec.rpc.length, 0);
});

test('sesión: si Auth no responde es 503 (no 401, que cerraría la sesión en el launcher)', async () => {
  const { deps } = makeDeps();
  const down = await call(deps, get('down'));
  assert.equal(down.status, 503);
  assert.equal(down.body.code, 'auth_unavailable');
  const throwing = makeDeps({}, { verifyUser: async () => { throw new Error('red'); } });
  const res = await call(throwing.deps, get());
  assert.equal(res.status, 503);
});

test('usuarios anónimos o sin confirmar: 403 { error: "unauthorized", code, message }', async () => {
  const { deps, rec } = makeDeps();
  const anon = await call(deps, get('anon'));
  assert.equal(anon.status, 403);
  assert.deepEqual(Object.keys(anon.body).sort(), ['code', 'error', 'message']);
  assert.equal(anon.body.error, 'unauthorized');
  assert.equal(anon.body.code, 'anonymous');
  assert.match(String(anon.body.message), /cuenta de Venus/);
  const unconfirmed = await call(deps, post(textBody(), { Authorization: 'Bearer unconfirmed' }));
  assert.equal(unconfirmed.status, 403);
  assert.equal(unconfirmed.body.code, 'unconfirmed');
  assert.match(String(unconfirmed.body.message), /Confirmá el email/);
  assert.equal(rec.rpc.length, 0);
});

test('servidor sin configurar: 503 not_configured', async () => {
  const noSupabase = makeDeps({}, { supabaseReady: false });
  const a = await call(noSupabase.deps, post(textBody()));
  assert.equal(a.status, 503);
  assert.equal(a.body.code, 'not_configured');
  const noKey = makeDeps({}, { modelReady: false });
  const b = await call(noKey.deps, post(textBody()));
  assert.equal(b.status, 503);
  assert.equal(b.body.code, 'not_configured');
});

test('migración sin aplicar o base caída: 503 con código claro', async () => {
  const missing = makeDeps({}, { rpc: async () => { throw Object.assign(new Error('x'), { code: 'PGRST202' }); } });
  const a = await call(missing.deps, get());
  assert.equal(a.status, 503);
  assert.equal(a.body.code, 'backend_not_ready');
  assert.match(String(a.body.message), /0008_ai_plans\.sql/);
  const down = makeDeps({}, { rpc: async () => { throw Object.assign(new Error('x'), { code: '' }); } });
  const b = await call(down.deps, post(textBody()));
  assert.equal(b.status, 503);
  assert.equal(b.body.code, 'quota_unavailable');
  assert.equal(down.rec.model.length, 0);
  // Respuestas que no tienen la forma esperada: nunca se llama a la IA.
  const oldQuota = { plan: 'free', planName: 'Free', model: 'claude-opus-5-5', daily: { used: 0, limit: 15 }, monthlyTokens: { used: 0, limit: 1 }, resetsAt: '' };
  for (const register of [
    { ok: true },
    // Solo 0007 aplicada (cuota vieja, sin models ni budget).
    { allowed: true, reason: null, counted: true, maxTokensPerRequest: 8000, quota: oldQuota },
    // Permitido sin un modelo de Anthropic válido.
    { allowed: true, reason: null, model: 'haiku', modelId: 'gpt-5', effort: 'medium', counted: true, maxTokensPerRequest: 8000, quota: new FakeDb().quotaStatus(USER) },
    // Motivo de rechazo desconocido.
    { allowed: false, reason: 'otra-cosa', quota: new FakeDb().quotaStatus(USER) },
  ]) {
    const garbage = makeDeps({ register });
    const c = await call(garbage.deps, post(textBody()));
    assert.equal(c.status, 503, JSON.stringify(register));
    assert.equal(c.body.code, 'quota_unavailable');
    assert.equal(garbage.rec.model.length, 0);
  }
});

// ---------- Cuerpo del pedido ----------

test('cuerpo: Content-Type, tamaño, UTF-8 y JSON', async () => {
  const { deps, rec } = makeDeps();
  const wrongType = await call(deps, post(textBody(), { 'Content-Type': 'text/plain' }));
  assert.equal(wrongType.status, 400);
  assert.match(String(wrongType.body.message), /Content-Type/);
  const big = await call(deps, post(textBody({ system: 'x'.repeat(10), messages: [{ role: 'user', content: 'y'.repeat(401 * 1024) }] })));
  assert.equal(big.status, 400);
  assert.match(String(big.body.message), /demasiado grande/);
  const badUtf8 = await call(deps, post(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])));
  assert.equal(badUtf8.status, 400);
  assert.match(String(badUtf8.body.message), /UTF-8/);
  const notJson = await call(deps, post('{"task": '));
  assert.equal(notJson.status, 400);
  assert.match(String(notJson.body.message), /JSON válido/);
  // El protocolo 1 no elige el modelo; el 2 solo acepta los ids del protocolo (nunca un id de Anthropic).
  for (const body of [textBody({ model: 'claude-fable-5-1' }), v2Body({ model: 'claude-opus-5-5' }), v2Body({ effort: 'max' })]) {
    const invalid = await call(deps, post(body));
    assert.equal(invalid.status, 400);
    assert.deepEqual(Object.keys(invalid.body).sort(), ['code', 'error', 'message']);
    assert.equal(invalid.body.error, 'bad_request');
    assert.equal(invalid.body.code, 'invalid_request');
  }
  for (const res of [wrongType, big, badUtf8, notJson]) assert.equal(res.body.code, 'invalid_request');
  assert.equal(rec.rpc.length, 0, 'un pedido inválido no toca la cuota');
  assert.equal(rec.model.length, 0);
});

test('readBody corta apenas se pasa del límite', async () => {
  const declared = new Request(URL_FN, { method: 'POST', body: 'abc', headers: { 'content-length': '999999' } });
  assert.deepEqual(await readBody(declared, 100), { ok: false, reason: 'too_large' });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(60));
      controller.close();
    },
  });
  const streamed = new Request(URL_FN, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  assert.deepEqual(await readBody(streamed, 100), { ok: false, reason: 'too_large' });
  assert.deepEqual(await readBody(new Request(URL_FN, { method: 'POST', body: 'ñ' }), 100), { ok: true, text: 'ñ' });
});

// ---------- Estado del plan y catálogo ----------

test('GET devuelve { quota, plans } (QuotaV2 y catálogo) sin llamar a la IA', async () => {
  const { deps, rec } = makeDeps({}, { modelReady: false });
  const { status, body } = await call(deps, get());
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['plans', 'quota']);
  assert.deepEqual(body.quota, {
    plan: 'pro',
    planName: 'Pro',
    priceUsd: 9.25,
    status: 'active',
    models: [
      { id: 'haiku', model: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: ['low', 'medium', 'high'], daily: { used: 0, limit: 25 }, weekly: { used: 0, limit: 115 } },
      { id: 'sonnet', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: ['low', 'medium'], daily: { used: 0, limit: 5 }, weekly: { used: 0, limit: 20 } },
    ],
    budget: { usedUsd: 0, limitUsd: 5 },
    // Miércoles 28/10/2026: el día se renueva a la medianoche de Buenos Aires (03:00 UTC), la semana el
    // lunes 2/11 y el mes el 1/11.
    resets: { daily: '2026-10-29T03:00:00Z', weekly: '2026-11-02T03:00:00Z', monthly: '2026-11-01T03:00:00Z' },
    timezone: TIMEZONE,
  });
  assert.deepEqual(
    (body.plans as Body[]).map((p) => [p.id, p.name, p.priceUsd, p.budgetUsd, (p.models as Body[]).map((m) => m.id).join('+')]),
    [
      ['go', 'Go', 3.5, 1.5, 'haiku'],
      ['pro', 'Pro', 9.25, 5, 'haiku+sonnet'],
      ['super', 'Super', 13.5, 7, 'haiku+sonnet'],
      ['ultra', 'Ultra', 25.5, 12, 'haiku+sonnet'],
      ['max', 'Max', 36.5, 19, 'haiku+sonnet+opus'],
      ['supreme', 'Supreme', 42.5, 23, 'haiku+sonnet+opus'],
    ],
  );
  assert.deepEqual(body.plans[4].models[2], { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium'], daily: 4, weekly: 20 });
  assert.deepEqual(rec.rpc.map((r) => r.name).sort(), ['ai_catalog', 'ai_quota_status']);
  assert.equal(rec.model.length, 0);
});

test('plan vigente: suscripción active o trialing, sin vencer y con el plan activo', async () => {
  const cases: [string, (db: FakeDb) => void, string | null, string][] = [
    ['activa', (db) => db.subscribe(USER, 'max'), 'max', 'active'],
    ['de prueba', (db) => db.subscribe(USER, 'ultra', 'trialing'), 'ultra', 'trialing'],
    ['vencida', (db) => db.subscribe(USER, 'max', 'active', new Date('2026-10-01T00:00:00Z')), null, 'none'],
    ['con vencimiento futuro', (db) => db.subscribe(USER, 'go', 'active', new Date('2026-11-27T00:00:00Z')), 'go', 'active'],
    ['cancelada', (db) => db.subscribe(USER, 'max', 'canceled'), null, 'none'],
    ['pago atrasado', (db) => db.subscribe(USER, 'max', 'past_due'), null, 'none'],
    ['plan desactivado', (db) => { db.subscribe(USER, 'max'); (db.plans.get('max') as { active: boolean }).active = false; }, null, 'none'],
    ['sin suscripción', () => {}, null, 'none'],
  ];
  for (const [name, prepare, plan, status] of cases) {
    const db = new FakeDb();
    prepare(db);
    const { deps } = makeDeps({ db });
    const { body } = await call(deps, get());
    assert.equal(body.quota.plan, plan, name);
    assert.equal(body.quota.status, status, name);
    if (!plan) {
      assert.equal(body.quota.planName, null, name);
      assert.equal(body.quota.priceUsd, null, name);
      assert.deepEqual(body.quota.models, [], name);
      assert.equal(body.quota.budget.limitUsd, 0, name);
    }
  }
});

test('sin plan: 402 { error: "noplan", quota, plans } sin llamar a la IA ni tocar la cuota', async () => {
  const { deps, rec, db } = makeDeps({ plan: null });
  const { status, body } = await call(deps, post(textBody()));
  assert.equal(status, 402);
  assert.equal(body.error, 'noplan');
  assert.match(String(body.message), /plan de IA activo/);
  assert.equal(body.quota.plan, null);
  assert.equal(body.quota.status, 'none');
  assert.equal(body.plans.length, 6);
  assert.equal(rec.model.length, 0);
  assert.equal(db.rate.size, 0, 'sin plan no cuenta la ráfaga');
  assert.equal(db.turns.size, 0);
  // Si el catálogo no se puede leer, el 402 igual llega (con la lista vacía).
  const broken = makeDeps({ plan: null });
  const original = broken.deps.rpc;
  broken.deps.rpc = async (name, args) => {
    if (name === 'ai_catalog') throw Object.assign(new Error('x'), { code: '57014' });
    return original(name, args);
  };
  const res = await call(broken.deps, post(textBody()));
  assert.equal(res.status, 402);
  assert.deepEqual(res.body.plans, []);
});

// ---------- Modelo y esfuerzo ----------

test('protocolo 1: usa el primer modelo del plan (Haiku) y el id de Anthropic sale de ai_models', async () => {
  const { deps, rec } = makeDeps({ plan: 'max' });
  const { status, body } = await call(deps, post(textBody({ effort: undefined })));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(rec.model[0].model, 'claude-haiku-5-5');
  assert.equal(rec.model[0].effort, 'medium', 'sin esfuerzo: medium');
  assert.equal(rec.model[0].fallback, false, 'Haiku nunca usa fallbacks');
  assert.deepEqual(rec.rpc[0], { name: 'ai_register_turn', args: { p_user: USER, p_turn: rec.rpc[0].args.p_turn, p_model: null, p_effort: null } });
  assert.equal(body.message.model, 'claude-haiku-5-5');
  assert.equal(modelQuota(body, 'haiku').daily.used, 1);
  assert.equal(body.quota.lastModel, 'haiku');
  // Con esfuerzo explícito (como manda el launcher de antes).
  await call(deps, post(textBody({ effort: 'low' })));
  assert.equal(rec.model[1].effort, 'low');
});

test('protocolo 2: modelo y esfuerzo dentro del plan; 403 { error: "plan" } si no los incluye', async () => {
  const go = makeDeps({ plan: 'go' });
  const sonnetOnGo = await call(go.deps, post(v2Body({ model: 'sonnet' })));
  assert.equal(sonnetOnGo.status, 403);
  assert.equal(sonnetOnGo.body.error, 'plan');
  assert.equal(sonnetOnGo.body.reason, 'model');
  assert.equal(sonnetOnGo.body.model, 'sonnet');
  assert.equal(sonnetOnGo.body.quota.plan, 'go');
  assert.match(String(sonnetOnGo.body.message), /no incluye ese modelo/);
  const highOnGo = await call(go.deps, post(v2Body({ model: 'haiku', effort: 'high' })));
  assert.equal(highOnGo.status, 403);
  assert.equal(highOnGo.body.reason, 'effort');
  assert.equal(highOnGo.body.model, 'haiku');
  assert.equal(go.rec.model.length, 0);
  assert.equal(go.db.rate.size, 0, 'un rechazo por plan no cuenta la ráfaga');

  const pro = makeDeps({ plan: 'pro' });
  assert.equal((await call(pro.deps, post(v2Body({ model: 'sonnet', effort: 'high' })))).body.reason, 'effort');
  assert.equal((await call(pro.deps, post(v2Body({ model: 'opus' })))).body.reason, 'model');
  const sonnet = await call(pro.deps, post(v2Body({ model: 'sonnet', effort: 'low' })));
  assert.equal(sonnet.status, 200);
  assert.equal(pro.rec.model[0].model, 'claude-sonnet-5-5');
  assert.equal(pro.rec.model[0].effort, 'low');
  assert.equal(pro.rec.model[0].fallback, true);

  const max = makeDeps({ plan: 'max' });
  assert.equal((await call(max.deps, post(v2Body({ model: 'opus', effort: 'high' })))).body.reason, 'effort');
  assert.equal((await call(max.deps, post(v2Body({ model: 'opus' })))).status, 200);
  assert.equal(max.rec.model[0].model, 'claude-opus-5-5');
  assert.equal(max.rec.model[0].effort, 'medium');
  assert.equal(max.rec.model[0].fallback, true);
  const supreme = makeDeps({ plan: 'supreme' });
  assert.equal((await call(supreme.deps, post(v2Body({ model: 'opus', effort: 'high' })))).status, 200);
  assert.equal(supreme.rec.model[0].effort, 'high');
});

test('esfuerzo por defecto: medium; si el plan no lo permite, el más alto por debajo', async () => {
  const { deps, rec, db } = makeDeps({ plan: 'pro' });
  const pro = db.plans.get('pro') as { models: { model: string; efforts: string[] }[] };
  (pro.models.find((m) => m.model === 'sonnet') as { efforts: string[] }).efforts = ['low', 'high'];
  (pro.models.find((m) => m.model === 'haiku') as { efforts: string[] }).efforts = ['high'];
  await call(deps, post(v2Body({ model: 'sonnet' })));
  assert.equal(rec.model[0].effort, 'low');
  await call(deps, post(v2Body({ model: 'haiku' })));
  assert.equal(rec.model[1].effort, 'high');
});

test('el pedido a la IA usa el modelo de la base, la política del servidor, el tope del plan y los mensajes intactos', async () => {
  const { deps, rec } = makeDeps({ plan: 'go' });
  const body = textBody({ max_tokens: 16000 });
  await call(deps, post(body));
  const sent = rec.model[0];
  assert.equal(sent.model, 'claude-haiku-5-5');
  assert.equal(sent.maxTokens, 8000, 'recortado al tope del plan Go');
  assert.equal(sent.effort, 'low');
  assert.equal(sent.task, 'text');
  assert.equal(sent.tools, null);
  assert.equal(sent.format, null);
  assert.equal(sent.system.length, 2);
  assert.ok(sent.system[0].text.startsWith('# Política del servidor de Venus Launcher'));
  assert.ok(sent.system[1].text.endsWith('Respondé en una línea.'));
  assert.deepEqual(sent.messages, body.messages);
});

// ---------- Preguntas, cupos y presupuesto ----------

test('cupo diario por modelo: el de Sonnet no toca el de Haiku', async () => {
  const { deps, rec, db } = makeDeps({ plan: 'pro' });
  for (let i = 1; i <= 5; i++) {
    const ok = await call(deps, post(v2Body({ model: 'sonnet', turn_id: `s-${i}` })));
    assert.equal(ok.status, 200);
    assert.deepEqual(modelQuota(ok.body, 'sonnet').daily, { used: i, limit: 5 });
  }
  const denied = await call(deps, post(v2Body({ model: 'sonnet', turn_id: 's-6' })));
  assert.equal(denied.status, 429);
  assert.equal(denied.body.error, 'quota');
  assert.equal(denied.body.reason, 'daily');
  assert.equal(denied.body.model, 'sonnet');
  assert.match(String(denied.body.message), /de hoy/);
  assert.deepEqual(modelQuota(denied.body, 'sonnet').daily, { used: 5, limit: 5 });
  assert.equal(rec.model.length, 5);
  const haiku = await call(deps, post(v2Body({ model: 'haiku', turn_id: 'h-1' })));
  assert.equal(haiku.status, 200);
  assert.deepEqual(modelQuota(haiku.body, 'haiku').daily, { used: 1, limit: 25 });
  assert.deepEqual(modelQuota(haiku.body, 'sonnet').weekly, { used: 5, limit: 20 });
  // Al día siguiente el cupo diario vuelve; el semanal sigue sumando.
  db.now = new Date('2026-10-29T12:00:00Z');
  const tomorrow = await call(deps, post(v2Body({ model: 'sonnet', turn_id: 's-7' })));
  assert.equal(tomorrow.status, 200);
  assert.deepEqual(modelQuota(tomorrow.body, 'sonnet').daily, { used: 1, limit: 5 });
  assert.deepEqual(modelQuota(tomorrow.body, 'sonnet').weekly, { used: 6, limit: 20 });
});

test('cupo semanal por modelo: cuenta desde el lunes y se renueva el lunes siguiente', async () => {
  const { deps, db } = makeDeps({ plan: 'pro' });
  const today = db.today();
  assert.equal(today, '2026-10-28');
  db.addQuestions(USER, '2026-10-25', 'sonnet', 20); // domingo: semana anterior, no cuenta
  db.addQuestions(USER, '2026-10-26', 'sonnet', 5); // lunes
  db.addQuestions(USER, '2026-10-27', 'sonnet', 5); // martes
  const first = await call(deps, post(v2Body({ model: 'sonnet', turn_id: 'w-1' })));
  assert.equal(first.status, 200);
  assert.deepEqual(modelQuota(first.body, 'sonnet').weekly, { used: 11, limit: 20 });
  db.addQuestions(USER, '2026-10-27', 'sonnet', 9); // la semana queda en 20
  const denied = await call(deps, post(v2Body({ model: 'sonnet', turn_id: 'w-2' })));
  assert.equal(denied.status, 429);
  assert.equal(denied.body.reason, 'weekly');
  assert.equal(denied.body.model, 'sonnet');
  assert.equal(db.turnRow(USER, 'w-2', today), undefined, 'la pregunta rechazada no queda registrada');
  // El lunes 2/11 a las 00:00 de Buenos Aires (03:00 UTC) empieza otra semana.
  db.now = new Date('2026-11-02T03:00:00Z');
  db.rate.clear();
  const nextWeek = await call(deps, post(v2Body({ model: 'sonnet', turn_id: 'w-3' })));
  assert.equal(nextWeek.status, 200);
  assert.deepEqual(modelQuota(nextWeek.body, 'sonnet').weekly, { used: 1, limit: 20 });
  assert.equal(nextWeek.body.quota.resets.weekly, '2026-11-09T03:00:00Z');
});

test('el día se cuenta en la hora de Buenos Aires', async () => {
  const { deps, db } = makeDeps({ plan: 'go' });
  db.now = new Date('2026-10-29T02:59:00Z'); // 23:59 del 28 en Buenos Aires
  const late = await call(deps, post(textBody({ turn_id: 'n-1' })));
  assert.equal(db.usageRow(USER, '2026-10-28', 'haiku')?.questions, 1);
  assert.equal(late.body.quota.resets.daily, '2026-10-29T03:00:00Z');
  db.now = new Date('2026-10-29T03:00:00Z'); // 00:00 del 29
  const early = await call(deps, post(textBody({ turn_id: 'n-2' })));
  assert.equal(db.usageRow(USER, '2026-10-29', 'haiku')?.questions, 1);
  assert.deepEqual(modelQuota(early.body, 'haiku').daily, { used: 1, limit: 35 });
  assert.deepEqual(modelQuota(early.body, 'haiku').weekly, { used: 2, limit: 170 });
});

test('una pregunta con varias llamadas cuenta una sola vez y tiene un tope de llamadas', async () => {
  const { deps, db, rec } = makeDeps({ plan: 'go' });
  for (let i = 0; i < 3; i++) assert.equal((await call(deps, post(textBody({ turn_id: 'q-1' })))).status, 200);
  assert.equal(db.usageRow(USER, db.today(), 'haiku')?.questions, 1);
  assert.equal(db.usageRow(USER, db.today(), 'haiku')?.calls, 3);
  assert.equal(db.turnRow(USER, 'q-1', db.today())?.calls, 3);
  assert.deepEqual(rec.rpc.filter((r) => r.name === 'ai_register_turn').map((r) => r.args.p_turn), ['q-1', 'q-1', 'q-1']);
  (db.turnRow(USER, 'q-1', db.today()) as { calls: number }).calls = 30; // tope del plan Go
  const denied = await call(deps, post(textBody({ turn_id: 'q-1' })));
  assert.equal(denied.status, 429);
  assert.equal(denied.body.reason, 'turn');
  assert.equal(rec.model.length, 3);
  // Sin turn_id, cada pedido es una pregunta nueva.
  await call(deps, post(textBody()));
  await call(deps, post(textBody()));
  assert.equal(db.usageRow(USER, db.today(), 'haiku')?.questions, 3);
  assert.match(String(rec.rpc.at(-2)?.args.p_turn), /^srv-[0-9a-f-]{36}$/);
});

test('la pregunta queda atada a su modelo', async () => {
  const { deps, rec, db } = makeDeps({ plan: 'pro' });
  assert.equal((await call(deps, post(v2Body({ model: 'sonnet', turn_id: 't-1' })))).status, 200);
  // Las llamadas siguientes sin modelo (protocolo 1 o 2) siguen con Sonnet y no gastan otra pregunta.
  assert.equal((await call(deps, post(textBody({ turn_id: 't-1' })))).status, 200);
  assert.equal((await call(deps, post(v2Body({ turn_id: 't-1' })))).status, 200);
  assert.deepEqual(rec.model.map((c) => c.model), ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']);
  assert.equal(db.usageRow(USER, db.today(), 'sonnet')?.questions, 1);
  assert.equal(db.usageRow(USER, db.today(), 'haiku'), undefined);
  // Cambiar de modelo en medio de la pregunta: 400 turn_model.
  const switched = await call(deps, post(v2Body({ model: 'haiku', turn_id: 't-1' })));
  assert.equal(switched.status, 400);
  assert.equal(switched.body.error, 'bad_request');
  assert.equal(switched.body.code, 'turn_model');
  assert.match(String(switched.body.message), /pregunta nueva/);
  assert.ok(switched.body.quota);
  assert.equal(rec.model.length, 3);
  // Una pregunta de ayer (cruzó la medianoche) sigue siendo la misma.
  db.now = new Date('2026-10-29T12:00:00Z');
  db.rate.clear();
  assert.equal((await call(deps, post(v2Body({ turn_id: 't-1' })))).status, 200);
  assert.equal(rec.model.at(-1)?.model, 'claude-sonnet-5-5');
  assert.equal(db.usageRow(USER, '2026-10-29', 'sonnet')?.questions ?? 0, 0);
});

test('ráfaga: 429 rate al pasar las llamadas por minuto del plan', async () => {
  const { deps, db } = makeDeps({ plan: 'go' });
  db.rate.set(USER, { windowStart: db.now.getTime() - 10000, calls: 30 });
  const denied = await call(deps, post(textBody()));
  assert.equal(denied.status, 429);
  assert.equal(denied.body.reason, 'rate');
  assert.match(String(denied.body.message), /un minuto/);
  db.now = new Date(db.now.getTime() + 60000);
  assert.equal((await call(deps, post(textBody()))).status, 200);
});

test('presupuesto del mes: con el gasto en el tope, 429 budget (también dentro de una pregunta abierta)', async () => {
  const { deps, db, rec } = makeDeps({ plan: 'go' });
  db.addCost(USER, '2026-09-30', 'haiku', 5); // el mes pasado no cuenta
  assert.equal((await call(deps, post(textBody({ turn_id: 'b-1' })))).status, 200);
  db.addCost(USER, '2026-10-02', 'haiku', 1.5);
  const denied = await call(deps, post(textBody({ turn_id: 'b-1' })));
  assert.equal(denied.status, 429);
  assert.equal(denied.body.error, 'quota');
  assert.equal(denied.body.reason, 'budget');
  assert.match(String(denied.body.message), /presupuesto/);
  assert.equal(denied.body.quota.budget.limitUsd, 1.5);
  assert.ok(denied.body.quota.budget.usedUsd >= 1.5);
  const newQuestion = await call(deps, post(textBody({ turn_id: 'b-2' })));
  assert.equal(newQuestion.body.reason, 'budget');
  assert.equal(db.usageRow(USER, db.today(), 'haiku')?.questions, 1, 'el rechazo no gasta preguntas');
  assert.equal(rec.model.length, 1);
  // El mes siguiente empieza de cero.
  db.now = new Date('2026-11-01T03:00:00Z');
  const november = await call(deps, post(textBody({ turn_id: 'b-3' })));
  assert.equal(november.status, 200);
  assert.ok(november.body.quota.budget.usedUsd < 0.01);
});

test('tope del presupuesto al subir de plan (0013): rige el menor hasta el fin de ese período, y solo con Stripe', async () => {
  const { deps, db } = makeDeps({ plan: 'supreme' });
  // Subió de Go a Supreme a una hora de la renovación: 1,50 + 21,50 x (1 h / el mes) ≈ 1,53.
  db.capBudget(USER, 1.5289, new Date('2026-10-28T16:00:00Z'));
  db.addCost(USER, '2026-10-02', 'haiku', 1.5);
  const capped = await call(deps, get());
  assert.equal(capped.body.quota.budget.limitUsd, 1.53);
  assert.equal((await call(deps, post(v2Body({ model: 'opus', turn_id: 'c-1' })))).status, 200);
  db.addCost(USER, '2026-10-02', 'haiku', 0.05);
  const denied = await call(deps, post(v2Body({ model: 'opus', turn_id: 'c-1' })));
  assert.equal(denied.status, 429);
  assert.equal(denied.body.reason, 'budget');
  // Renovado (fin del período en que subió): el presupuesto entero del plan.
  db.now = new Date('2026-10-28T16:00:01Z');
  const renewed = await call(deps, post(v2Body({ model: 'opus', turn_id: 'c-2' })));
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.quota.budget.limitUsd, 23);
  // Un plan manual o de un admin no usa el tope que quedó de Stripe.
  db.capBudget(USER, 1, new Date('2026-12-01T00:00:00Z'));
  assert.equal((await call(deps, get())).body.quota.budget.limitUsd, 1);
  (db.subs.get(USER) as { source?: string }).source = 'admin';
  assert.equal((await call(deps, get())).body.quota.budget.limitUsd, 23);
});

/** Espera a que se cumpla una condición (los pedidos simultáneos avanzan entre awaits). */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(check(), 'no se cumplió a tiempo');
}

const DONE: ModelResult = { content: [{ type: 'text', text: 'Listo.' }], stop_reason: 'end_turn', usage: USAGE, model: 'claude-haiku-5-5', parsed: null };

test('llamadas en curso (0013): hasta 3 a la vez por usuario (429 rate) y cada una se cierra al terminar', async () => {
  const pending: ((result: ModelResult) => void)[] = [];
  const { deps, db } = makeDeps({ plan: 'pro' }, { callModel: () => new Promise<ModelResult>((resolve) => pending.push(resolve)) });
  const handler = createHandler(deps);
  const running = [1, 2, 3].map((i) => handler(post(v2Body({ model: 'haiku', turn_id: `en-curso-${i}` }))));
  await until(() => pending.length === 3);
  assert.equal(db.inflight(USER), 3);
  const fourth = await call(deps, post(v2Body({ model: 'haiku', turn_id: 'en-curso-4' })));
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.reason, 'rate');
  assert.equal(db.turnRow(USER, 'en-curso-4', db.today()), undefined, 'el rechazo no gasta una pregunta');
  pending[0](DONE);
  assert.equal((await running[0]).status, 200);
  assert.equal(db.inflight(USER), 2);
  const fifth = handler(post(v2Body({ model: 'haiku', turn_id: 'en-curso-5' })));
  await until(() => pending.length === 4);
  for (const resolve of pending.slice(1)) resolve(DONE);
  for (const res of [...running.slice(1), fifth]) assert.equal((await res).status, 200);
  assert.equal(db.inflight(USER), 0);
});

test('llamadas en curso (0013): reservan su costo máximo cerca del tope; una sola llamada nunca espera', async () => {
  const pending: ((result: ModelResult) => void)[] = [];
  const { deps, db } = makeDeps({ plan: 'supreme' }, { callModel: () => new Promise<ModelResult>((resolve) => pending.push(resolve)) });
  // Una llamada de Opus puede costar hasta ~US$ 2,51 (con su respaldo, GPT-6 Astra).
  assert.equal(Math.round(db.callReserveMicros('opus', 16000)), 2506675);
  db.addCost(USER, '2026-10-02', 'opus', 20);
  const handler = createHandler(deps);
  const first = handler(post(v2Body({ model: 'opus', turn_id: 'r-1' })));
  await until(() => pending.length === 1);
  const second = handler(post(v2Body({ model: 'opus', turn_id: 'r-2' })));
  await until(() => pending.length === 2);
  // 20 + 2 llamadas en curso x 2,51 >= 23: la tercera espera (rate, que el launcher reintenta), no "sin presupuesto".
  const third = await call(deps, post(v2Body({ model: 'opus', turn_id: 'r-3' })));
  assert.equal(third.status, 429);
  assert.equal(third.body.reason, 'rate');
  for (const resolve of pending) resolve({ ...DONE, model: 'claude-opus-5-5' });
  await Promise.all([first, second]);
  // Sin llamadas en curso, la última del mes pasa aunque su costo máximo supere lo que queda.
  db.addCost(USER, '2026-10-02', 'opus', 2.9);
  const last = handler(post(v2Body({ model: 'opus', turn_id: 'r-4' })));
  await until(() => pending.length === 3);
  pending[2]({ ...DONE, model: 'claude-opus-5-5' });
  assert.equal((await last).status, 200);
});

test('llamadas en curso (0013): vencen a los 150 s (una función cortada no bloquea al usuario)', async () => {
  const { deps, db } = makeDeps({ plan: 'pro' });
  db.rate.set(USER, { windowStart: db.now.getTime() - 120000, calls: 0, inflight: 3, inflightAt: db.now.getTime() - 151000 });
  assert.equal((await call(deps, post(v2Body({ turn_id: 'v-1' })))).status, 200);
  assert.equal(db.inflight(USER), 0);
  db.rate.set(USER, { windowStart: db.now.getTime(), calls: 1, inflight: 3, inflightAt: db.now.getTime() - 149000 });
  assert.equal((await call(deps, post(v2Body({ turn_id: 'v-2' })))).body.reason, 'rate');
});

// ---------- Uso y costo ----------

test('costo de Haiku: tarifa normal y tarifa de más de 100K tokens de entrada', async () => {
  const usages = [
    { usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 }, cost: 0.000383 },
    // 90.000 + 10.000 de lectura de caché = 100.000: todavía la tarifa normal.
    { usage: { input_tokens: 90000, output_tokens: 1000, cache_read_input_tokens: 10000 }, cost: 0.0096 },
    // 90.000 + 20.000 = 110.000: todo el pedido con la tarifa larga (0,50 / 2,50 / 0,05).
    { usage: { input_tokens: 90000, output_tokens: 1000, cache_read_input_tokens: 20000 }, cost: 0.0485 },
  ];
  for (const { usage, cost } of usages) {
    const { deps, rec, db } = makeDeps({ plan: 'go', result: (c) => ({ content: [], stop_reason: 'end_turn', usage, model: c.model, parsed: null }) });
    const { status, body } = await call(deps, post(textBody()));
    assert.equal(status, 200);
    const add = rec.rpc.find((r) => r.name === 'ai_add_usage');
    assert.equal(add?.args.p_model, 'haiku');
    assert.equal((add?.args.p_usage as Body[])[0].model, 'claude-haiku-5-5');
    assert.equal((db.usageRow(USER, db.today(), 'haiku')?.costMicros ?? 0) / 1e6, cost, JSON.stringify(usage));
    assert.equal(body.quota.budget.usedUsd, Math.round(cost * 1e4) / 1e4);
  }
});

test('costo por modelo: Sonnet y Opus con sus precios; la escritura de caché va aparte de la entrada', async () => {
  const { deps, rec, db } = makeDeps({ plan: 'max' });
  await call(deps, post(v2Body({ model: 'sonnet', turn_id: 'c-1' })));
  await call(deps, post(v2Body({ model: 'opus', turn_id: 'c-2' })));
  const adds = rec.rpc.filter((r) => r.name === 'ai_add_usage').map((r) => r.args);
  assert.deepEqual(adds[0], { p_user: USER, p_model: 'sonnet', p_usage: [{ model: 'claude-sonnet-5-5', input: 10, output: 5, cacheRead: 1000, cacheWrite: 20 }] });
  assert.deepEqual(adds[1].p_usage, [{ model: 'claude-opus-5-5', input: 10, output: 5, cacheRead: 1000, cacheWrite: 20 }]);
  // Sonnet: 10 x 2 + 5 x 10 + 1000 x 0,20 + 20 x 2,50 = 320 millonésimas. Opus: 40 + 100 + 200 + 100 = 440.
  assert.equal(db.usageRow(USER, db.today(), 'sonnet')?.costMicros, 320);
  assert.equal(db.usageRow(USER, db.today(), 'opus')?.costMicros, 440);
});

test('reintento en otro modelo: cada intento se cobra con el precio del modelo que lo corrió', async () => {
  const usage = {
    input_tokens: 400,
    output_tokens: 300,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    iterations: [
      { type: 'message', model: 'claude-opus-5-5', input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
      { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 400, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ],
  };
  const { deps, rec, db } = makeDeps({
    plan: 'max',
    result: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage, model: 'claude-opus-5', parsed: null },
  });
  const { status, body } = await call(deps, post(v2Body({ model: 'opus' })));
  assert.equal(status, 200);
  const add = rec.rpc.find((r) => r.name === 'ai_add_usage');
  assert.equal(add?.args.p_model, 'opus', 'el uso queda en el modelo de la pregunta');
  assert.deepEqual(add?.args.p_usage, [
    { model: 'claude-opus-5-5', input: 500, output: 20, cacheRead: 100, cacheWrite: 50 },
    { model: 'claude-opus-5', input: 400, output: 300, cacheRead: 0, cacheWrite: 0 },
  ]);
  // Opus 5.5: 500 x 4 + 20 x 20 + 100 x 0,20 + 50 x 5 = 2670; Opus 5: 400 x 5 + 300 x 25 = 9500 (millonésimas).
  assert.equal(db.usageRow(USER, db.today(), 'opus')?.costMicros, 12170);
  assert.equal(body.quota.budget.usedUsd, 0.0122);
  assert.equal(body.message.model, 'claude-opus-5');
});

test('modelo sin precio en ai_models: se cobra como el modelo de la pregunta y se avisa en el log', async () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 10,
    iterations: [
      { type: 'message', model: 'claude-sonnet-5-5', input_tokens: 100, output_tokens: 0 },
      { type: 'fallback_message', model: 'claude-sonnet-9', input_tokens: 100, output_tokens: 10 },
    ],
  };
  const { deps, rec, db } = makeDeps({ plan: 'pro', result: { content: [], stop_reason: 'end_turn', usage, model: 'claude-sonnet-9', parsed: null } });
  assert.equal((await call(deps, post(v2Body({ model: 'sonnet' })))).status, 200);
  assert.equal(db.usageRow(USER, db.today(), 'sonnet')?.costMicros, 200 + 200 + 100);
  assert.ok(rec.logs.some((l) => l.includes('modelo sin precio') && l.includes('claude-sonnet-9')));
});

test('pedido de texto: 200 con { message, quota } y el uso registrado', async () => {
  const { deps, rec, db } = makeDeps({ plan: 'go' });
  const { status, body } = await call(deps, post(textBody()));
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['message', 'quota']);
  assert.deepEqual(body.message, {
    content: [{ type: 'text', text: 'Listo.' }],
    stop_reason: 'end_turn',
    usage: USAGE,
    model: 'claude-haiku-5-5',
    served_by: { provider: 'anthropic', model: 'claude-haiku-5-5', failover: false },
  });
  assert.deepEqual(rec.rpc.map((r) => r.name), ['ai_register_turn', 'ai_add_usage']);
  const row = db.usageRow(USER, db.today(), 'haiku');
  assert.deepEqual({ ...row, updatedAt: 0 }, { questions: 1, calls: 1, input: 10, output: 5, cacheRead: 1000, cacheWrite: 20, costMicros: 16, updatedAt: 0 });
});

test('asistente: las herramientas llegan tal cual a la IA', async () => {
  const tools = [
    { name: 'list_mods', description: 'Lista los mods', input_schema: { type: 'object', properties: {} } },
    { name: 'remove_mod', description: 'Quita un mod', input_schema: { type: 'object', properties: { id: { type: 'string' } } }, strict: true },
  ];
  const result: ModelResult = {
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name: 'list_mods', input: {} },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 50, output_tokens: 40 },
    model: 'claude-sonnet-5-5',
    parsed: null,
  };
  const { deps, rec } = makeDeps({ result });
  const { status, body } = await call(deps, post(v2Body({ task: 'assistant', model: 'sonnet', tools, turn_id: 't-1' })));
  assert.equal(status, 200);
  assert.deepEqual(rec.model[0].tools, tools);
  assert.match(rec.model[0].system[0].text, /Herramientas y permisos/);
  assert.equal(body.message.stop_reason, 'tool_use');
  assert.deepEqual(body.message.content, result.content);
});

test('json: prepara el formato antes de la cuota y devuelve parsed', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const result: ModelResult = {
    content: [{ type: 'text', text: '{"ok":true}' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 5 },
    model: 'claude-haiku-5-5',
    parsed: { ok: true },
  };
  const { deps, rec } = makeDeps({ result });
  const { status, body } = await call(deps, post(textBody({ task: 'json', schema })));
  assert.equal(status, 200);
  assert.deepEqual(body.parsed, { ok: true });
  assert.deepEqual(rec.formats, [schema]);
  assert.deepEqual(rec.model[0].format, { type: 'json_schema', schema });

  const broken = makeDeps({}, { prepareFormat: () => { throw new Error('JSON schema must have a type'); } });
  const bad = await call(broken.deps, post(textBody({ task: 'json', schema: { type: 'object', properties: { x: {} } } })));
  assert.equal(bad.status, 400);
  assert.equal(broken.rec.rpc.length, 0, 'un schema inválido no gasta una pregunta');
});

test('json sin parsed (respuesta cortada): 200 con parsed null y el uso registrado', async () => {
  const result: ModelResult = {
    content: [{ type: 'text', text: '{"ok":' }],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 5, output_tokens: 5 },
    model: 'claude-haiku-5-5',
    parsed: null,
  };
  const { deps, rec } = makeDeps({ result });
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const { status, body } = await call(deps, post(textBody({ task: 'json', schema })));
  assert.equal(status, 200);
  assert.equal(body.parsed, null);
  assert.equal(body.message.stop_reason, 'max_tokens');
  assert.ok(rec.rpc.some((r) => r.name === 'ai_add_usage'));
});

test('rechazo de la IA: 422 { error: "refusal" } y el uso igual se cuenta', async () => {
  const result: ModelResult = { content: [], stop_reason: 'refusal', usage: { input_tokens: 300, output_tokens: 0 }, model: 'claude-haiku-5-5', parsed: null };
  const { deps, rec, db } = makeDeps({ result });
  const { status, body } = await call(deps, post(textBody()));
  assert.equal(status, 422);
  assert.equal(body.error, 'refusal');
  assert.equal(body.quota.plan, 'pro');
  const add = rec.rpc.find((r) => r.name === 'ai_add_usage');
  assert.deepEqual(add?.args.p_usage, [{ model: 'claude-haiku-5-5', input: 300, output: 0, cacheRead: 0, cacheWrite: 0 }]);
  assert.equal(db.usageRow(USER, db.today(), 'haiku')?.costMicros, 30);
});

// ---------- Fallas de Anthropic ----------

test('Anthropic saturada: 503 y la pregunta nueva se devuelve', async () => {
  const { deps, rec, db } = makeDeps({ failure: { kind: 'status', status: 429, type: 'rate_limit_error', requestId: 'req_9' } });
  const { status, body } = await call(deps, post(v2Body({ model: 'sonnet', turn_id: 'r-1' })));
  assert.equal(status, 503);
  assert.equal(body.error, 'upstream');
  assert.equal(body.code, 'upstream_rate_limited');
  assert.deepEqual(modelQuota(body, 'sonnet').daily, { used: 0, limit: 5 });
  assert.equal(db.turnRow(USER, 'r-1', db.today()), undefined);
  assert.ok(rec.rpc.some((r) => r.name === 'ai_release_turn'));
  assert.ok(!rec.rpc.some((r) => r.name === 'ai_add_usage'));
  assert.ok(rec.logs.some((l) => l.includes('upstream_rate_limited') && l.includes('req_9')));
});

test('si la pregunta ya estaba contada (otra llamada de la misma pregunta) no se devuelve', async () => {
  const { deps, rec, db } = makeDeps();
  assert.equal((await call(deps, post(textBody({ turn_id: 'turno-1' })))).status, 200);
  const failing = makeDeps({ db, failure: { kind: 'status', status: 529, type: 'overloaded_error' } });
  const { status } = await call(failing.deps, post(textBody({ turn_id: 'turno-1' })));
  assert.equal(status, 503);
  assert.ok(!failing.rec.rpc.some((r) => r.name === 'ai_release_turn'));
  assert.equal(db.usageRow(USER, db.today(), 'haiku')?.questions, 1);
  assert.equal(rec.model.length, 1);
});

test('pedido inválido para la API: 400 bad_request con detalle y sin devolver la pregunta', async () => {
  const { deps, rec } = makeDeps({
    failure: { kind: 'status', status: 400, type: 'invalid_request_error', detail: 'messages.0: unexpected tool_result' },
  });
  const { status, body } = await call(deps, post(textBody()));
  assert.equal(status, 400);
  assert.equal(body.error, 'bad_request');
  assert.match(String(body.message), /unexpected tool_result/);
  assert.ok(!rec.rpc.some((r) => r.name === 'ai_release_turn'));
});

test('plazo vencido: 503 upstream_timeout y se aborta la llamada', async () => {
  let aborted = false;
  const { deps, rec } = makeDeps(
    {},
    {
      timeoutMs: 30,
      callModel: (_call: ModelCall, signal: AbortSignal) =>
        new Promise<ModelResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    },
  );
  const { status, body } = await call(deps, post(textBody()));
  assert.equal(status, 503);
  assert.equal(body.code, 'upstream_timeout');
  assert.equal(aborted, true);
  assert.ok(!rec.rpc.some((r) => r.name === 'ai_release_turn'), 'la IA pudo haber cobrado el pedido');
  // Se cobra una estimación del peor caso: todo el pedido como escritura de caché y la salida entera.
  const add = rec.rpc.find((r) => r.name === 'ai_add_usage');
  const cacheWrite = Math.ceil(JSON.stringify(textBody()).length / 3);
  assert.deepEqual(add?.args, { p_user: USER, p_model: 'haiku', p_usage: [{ model: 'claude-haiku-5-5', input: 0, output: 2000, cacheRead: 0, cacheWrite }] });
  assert.equal(body.quota.budget.usedUsd, Math.round((cacheWrite * 0.125 + 2000 * 0.5) / 100) / 10000);
});

test('plazo vencido repetido con la misma pregunta: el costo estimado llega al presupuesto y la corta', async () => {
  const { deps, rec, db } = makeDeps(
    { plan: 'supreme' },
    {
      timeoutMs: 20,
      callModel: (call: ModelCall, signal: AbortSignal) =>
        new Promise<ModelResult>((_resolve, reject) => {
          rec.model.push(call);
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    },
  );
  db.addCost(USER, db.today(), 'opus', 22.5);
  const body = v2Body({ model: 'opus', turn_id: 'largo', max_tokens: 16000, messages: [{ role: 'user', content: 'x'.repeat(300000) }] });
  const first = await call(deps, post(body));
  assert.equal(first.status, 503);
  assert.equal(first.body.code, 'upstream_timeout');
  const cacheWrite = Math.ceil(JSON.stringify(body).length / 3);
  assert.deepEqual(rec.rpc.find((r) => r.name === 'ai_add_usage')?.args.p_usage, [{ model: 'claude-opus-5-5', input: 0, output: 16000, cacheRead: 0, cacheWrite }]);
  // Opus 5.5: escritura de caché a US$ 5 y salida a US$ 20 por millón (unos US$ 0,82).
  assert.equal(db.usageRow(USER, db.today(), 'opus')?.costMicros, 22.5e6 + cacheWrite * 5 + 16000 * 20);
  assert.equal(db.inflight(USER), 0, 'ai_add_usage cerró la llamada');
  assert.ok(!rec.rpc.some((r) => r.name === 'ai_end_call'));
  const again = await call(deps, post(body));
  assert.equal(again.status, 429);
  assert.equal(again.body.reason, 'budget');
  assert.equal(rec.model.length, 1);
});

test('conexión cortada: también se cobra estimada; una falla sin proceso (saturada) cierra la llamada sin cobrar', async () => {
  const network = makeDeps({ failure: { kind: 'connection' } });
  const cut = await call(network.deps, post(textBody({ turn_id: 'red-1' })));
  assert.equal(cut.status, 502);
  assert.equal(cut.body.code, 'upstream_network');
  assert.equal((network.rec.rpc.find((r) => r.name === 'ai_add_usage')?.args.p_usage as Body[])[0].output, 2000);
  assert.equal(network.db.inflight(USER), 0);

  const busy = makeDeps({ failure: { kind: 'status', status: 529, type: 'overloaded_error' } });
  const res = await call(busy.deps, post(textBody({ turn_id: 'sat-1' })));
  assert.equal(res.status, 503);
  assert.deepEqual(busy.rec.rpc.map((r) => r.name), ['ai_register_turn', 'ai_release_turn', 'ai_end_call']);
  assert.equal(busy.db.inflight(USER), 0);
  assert.equal(res.body.quota.budget.usedUsd, 0);
  // Sin 0013 (ai_end_call no existe), la respuesta llega igual y queda un aviso.
  const old = makeDeps({ failure: { kind: 'status', status: 529, type: 'overloaded_error' } });
  const original = old.deps.rpc;
  old.deps.rpc = async (name, args) => {
    if (name === 'ai_end_call') throw Object.assign(new Error('x'), { code: 'PGRST202' });
    return original(name, args);
  };
  assert.equal((await call(old.deps, post(textBody()))).status, 503);
  assert.ok(old.rec.logs.some((l) => l.includes('no se pudo cerrar la llamada: PGRST202')));
});

test('si el launcher cancela, se corta la llamada a la IA', async () => {
  const controller = new AbortController();
  let sawAbort = false;
  const { deps, rec } = makeDeps(
    {},
    {
      callModel: (_call: ModelCall, signal: AbortSignal) =>
        new Promise<ModelResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('aborted'));
          });
          setTimeout(() => controller.abort(), 10);
        }),
    },
  );
  const res = await createHandler(deps)(post(textBody(), {}, { signal: controller.signal }));
  assert.equal(sawAbort, true);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'aborted');
  // La IA pudo haber procesado el pedido: se cobra estimado (si no, cancelar sería gratis).
  assert.ok(rec.rpc.some((r) => r.name === 'ai_add_usage'));
});

test('si no se puede registrar el uso, la respuesta igual llega', async () => {
  const { deps, rec } = makeDeps();
  const original = deps.rpc;
  deps.rpc = async (name, args) => {
    if (name === 'ai_add_usage') throw Object.assign(new Error('x'), { code: '57014' });
    return original(name, args);
  };
  const { status, body } = await call(deps, post(textBody()));
  assert.equal(status, 200);
  assert.equal(body.quota.plan, 'pro');
  assert.ok(rec.logs.some((l) => l.includes('no se pudo registrar el uso') && l.includes('57014')));
});

test('los logs nunca incluyen el contenido de la conversación', async () => {
  const scenarios: Setup[] = [
    { failure: { kind: 'status', status: 400, type: 'invalid_request_error', detail: `eco ${SECRET}` } },
    { failure: { kind: 'status', status: 500, type: 'api_error', detail: SECRET } },
    { failure: { kind: 'unknown', name: 'TypeError' } },
    { result: { content: [{ type: 'text', text: SECRET }], stop_reason: 'end_turn', usage: { iterations: [{ type: 'fallback_message', model: 'claude-x-1', input_tokens: 1 }] }, model: 'claude-x-1', parsed: null } },
  ];
  for (const setup of scenarios) {
    const { deps, rec } = makeDeps(setup);
    await call(deps, post(textBody({ system: `Sistema ${SECRET}` })));
    for (const line of rec.logs) assert.ok(!line.includes(SECRET), line);
  }
});

test('error inesperado: 500 con JSON y CORS', async () => {
  const { deps } = makeDeps({}, {
    describeError: () => {
      throw new Error('falla interna');
    },
    callModel: async () => {
      throw new Error('x');
    },
  });
  const { status, body, res } = await call(deps, post(textBody()));
  assert.equal(status, 500);
  assert.equal(body.error, 'upstream');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('una Edge Function vieja (protocolo de 0007) queda bloqueada después de 0008', async () => {
  const db = new FakeDb();
  db.subscribe(USER, 'supreme');
  const legacy = (await db.rpc('ai_register_turn', { p_user: USER, p_turn: 'x' })) as Body;
  assert.equal(legacy.allowed, false);
  assert.equal(legacy.reason, 'plan');
});
