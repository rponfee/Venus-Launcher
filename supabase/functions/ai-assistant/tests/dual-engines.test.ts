// Venus IA con dos motores (6.1, 0056): planes de Claude y de ChatGPT, un saldo por motor, cambio automático de saldo
// (switched), max_tokens recortado al saldo, el proveedor de cada llamada, not_configured por proveedor y esfuerzo
// max. La base es FakeDb.dual(), la réplica del contrato de docs/implementacion/ia-dos-motores.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../handler.ts';
import type { Deps, ModelCall } from '../handler.ts';
import type { Provider } from '../config.ts';
import type { UpstreamFailure } from '../errors.ts';
import { FakeDb, MIN_GRANT_TOKENS } from './fake-db.ts';

const URL_FN = 'https://proyecto.supabase.co/functions/v1/ai-assistant';
const v2 = { app: 'venus-launcher', protocol: 2 };
const USER = 'user-dual';
const SECRET = 'charla-privada-5521';

type Body = Record<string, any>;

interface Recorder {
  rpc: { name: string; args: Record<string, any> }[];
  claude: ModelCall[];
  openai: Record<string, any>[];
  ready: Provider[];
  logs: string[];
}

interface Setup {
  /** Proveedores con clave (por defecto los dos). */
  keys?: Provider[];
  /** Falla de Anthropic (por ejemplo, saturada). */
  claudeFailure?: UpstreamFailure;
}

function makeDeps(db: FakeDb, setup: Setup = {}): { deps: Deps; rec: Recorder } {
  const rec: Recorder = { rpc: [], claude: [], openai: [], ready: [], logs: [] };
  const keys = new Set<Provider>(setup.keys ?? ['anthropic', 'openai']);
  const deps: Deps = {
    supabaseReady: true,
    modelReady: true,
    openaiReady: true,
    timeoutMs: 60000,
    async verifyUser(token) {
      return token === 'good' ? { status: 'ok', userId: USER } : { status: 'invalid' };
    },
    async rpc(name, args) {
      rec.rpc.push({ name, args });
      return db.rpc(name, args);
    },
    async providerReady(provider) {
      rec.ready.push(provider);
      return keys.has(provider);
    },
    prepareFormat(schema) {
      return { type: 'json_schema', schema };
    },
    async callModel(call) {
      rec.claude.push(call);
      if (setup.claudeFailure) throw Object.assign(new Error('falla'), { failure: setup.claudeFailure });
      return {
        content: [{ type: 'text', text: 'Hola desde Claude.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        model: call.model,
        parsed: null,
      };
    },
    describeError(err) {
      return (err as { failure?: UpstreamFailure }).failure ?? { kind: 'unknown', name: 'Error' };
    },
    async callOpenAI(body) {
      rec.openai.push(body);
      return {
        status: 'completed',
        model: body.model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hola desde ChatGPT.' }] }],
        usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500 },
      };
    },
    describeOpenAIError() {
      return { kind: 'unknown', name: 'Error' };
    },
    logger: { warn: (m) => rec.logs.push(m), error: (m) => rec.logs.push(m) },
  };
  return { deps, rec };
}

function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { task: 'text', messages: [{ role: 'user', content: `Hola ${SECRET}` }], client: v2, ...extra };
}

function post(payload: unknown): Request {
  return new Request(URL_FN, {
    method: 'POST',
    headers: { Authorization: 'Bearer good', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function call(deps: Deps, req: Request): Promise<{ status: number; body: Body }> {
  const res = await createHandler(deps)(req);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const names = (rec: Recorder) => rec.rpc.map((r) => r.name);

test('plan de Claude: la llamada va a Anthropic con el modelo de la base y el costo sale del saldo de Claude', async () => {
  const db = FakeDb.dual();
  db.buy(USER, 'claude_pro');
  const { deps, rec } = makeDeps(db);
  const payload = body({ model: 'sonnet', effort: 'high', max_tokens: 20000 });
  const res = await call(deps, post(payload));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(rec.claude.length, 1);
  assert.equal(rec.openai.length, 0, 'nunca llama a OpenAI');
  assert.equal(rec.claude[0].model, 'claude-sonnet-5-5');
  assert.equal(rec.claude[0].effort, 'high');
  assert.equal(rec.claude[0].maxTokens, 20000);
  assert.equal(rec.claude[0].fallback, false);
  assert.deepEqual(res.body.message.served_by, { provider: 'anthropic', model: 'claude-sonnet-5-5', failover: false });
  assert.ok(!('switched' in res.body), 'sin cambio de saldo, sin switched');
  // Los parámetros nuevos de ai_register_turn: el max_tokens pedido y el tamaño del cuerpo en bytes.
  const register = rec.rpc.find((r) => r.name === 'ai_register_turn')!.args;
  assert.equal(register.p_max_tokens, 20000);
  assert.equal(register.p_input_bytes, new TextEncoder().encode(JSON.stringify(payload)).length);
  // Solo se pregunta por la clave del proveedor de la llamada (el respaldo está apagado: ai_provider_settings, que se
  // guarda un minuto, solo dice eso).
  assert.deepEqual(rec.ready, ['anthropic']);
  assert.deepEqual(names(rec), ['ai_register_turn', 'ai_provider_settings', 'ai_add_usage']);
  // El uso: 1000 de entrada a 2 USD y 500 de salida a 10 USD por millón = 0,007 USD del saldo de Claude.
  assert.deepEqual(rec.rpc.at(-1)!.args.p_usage, [{ model: 'claude-sonnet-5-5', input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }]);
  assert.equal(db.wallet(USER, 'anthropic')!.spentMicros, 7000);
  assert.equal(db.reservations.get(USER)?.length ?? 0, 0, 'la reserva quedó cerrada');
  // La cuota trae los campos de 0056.
  const q = res.body.quota;
  assert.equal(q.plan, 'claude_pro');
  assert.equal(q.provider, 'anthropic');
  assert.equal(q.tier, 'pro');
  assert.equal(q.maxTokensPerRequest, 44000);
  assert.deepEqual(q.wallets, [{ provider: 'anthropic', plan: 'claude_pro', planName: 'Pro', tier: 'pro', usedUsd: 0.007, limitUsd: 12.5, remainingUsd: 12.493, active: true }]);
  assert.deepEqual(q.models.map((m: Body) => [m.id, m.model, m.providerModel, m.label]), [
    ['haiku', 'claude-haiku-5-5', 'claude-haiku-5-5', 'Haiku 5.5'],
    ['sonnet', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'Sonnet 5.5'],
  ]);
});

test('plan de ChatGPT: la llamada va a OpenAI con el modelo de models y el esfuerzo de openaiEffort', async () => {
  const db = FakeDb.dual();
  db.buy(USER, 'max');
  const { deps, rec } = makeDeps(db);
  const res = await call(deps, post(body({ model: 'sonnet', effort: 'medium', max_tokens: 6000 })));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(rec.claude.length, 0, 'nunca llama a Claude');
  assert.equal(rec.openai.length, 1);
  assert.equal(rec.openai[0].model, 'gpt-5.6-sol');
  assert.deepEqual(rec.openai[0].reasoning, { effort: 'medium' });
  assert.equal(rec.openai[0].max_output_tokens, 6000);
  assert.deepEqual(res.body.message.served_by, { provider: 'openai', model: 'gpt-5.6-sol', failover: false });
  assert.deepEqual(res.body.message.content, [{ type: 'text', text: 'Hola desde ChatGPT.' }]);
  assert.deepEqual(rec.ready, ['openai']);
  // La pregunta sigue en la clave (sonnet); el costo con el precio de GPT-5.6 Sol, del saldo de ChatGPT.
  const add = rec.rpc.find((r) => r.name === 'ai_add_usage')!.args;
  assert.equal(add.p_model, 'sonnet');
  assert.deepEqual(add.p_usage, [{ model: 'gpt-5.6-sol', input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }]);
  assert.equal(db.wallet(USER, 'openai')!.spentMicros, 14000);
  // La cuota de un plan de ChatGPT: model sigue siendo el id de Claude de la clave; el real va en providerModel.
  const sonnet = res.body.quota.models.find((m: Body) => m.id === 'sonnet');
  assert.deepEqual([sonnet.model, sonnet.providerModel, sonnet.label], ['claude-sonnet-5-5', 'gpt-5.6-sol', 'GPT-5.6 Sol']);
  assert.equal(res.body.quota.provider, 'openai');
});

test('cambio automático por saldo (budget): Claude sin saldo pasa a ChatGPT y lo avisa una vez', async () => {
  const db = FakeDb.dual();
  db.buy(USER, 'go');
  db.buy(USER, 'claude_go', { spentUsd: 6.75 - 0.0005 });
  const { deps, rec } = makeDeps(db);
  assert.equal(db.activeWallet.get(USER), 'anthropic');
  const res = await call(deps, post(body({ model: 'haiku', effort: 'high' })));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.switched, { from: 'anthropic', to: 'openai', reason: 'budget' });
  assert.equal(rec.claude.length, 0);
  assert.equal(rec.openai[0].model, 'gpt-6-luna');
  assert.deepEqual(rec.openai[0].reasoning, { effort: 'high' });
  assert.equal(res.body.quota.provider, 'openai');
  assert.deepEqual(res.body.quota.wallets.map((w: Body) => [w.provider, w.active]), [['anthropic', false], ['openai', true]]);
  assert.ok(rec.logs.some((l) => l.includes('cambio de saldo: anthropic -> openai (budget)')));
  // La llamada siguiente ya usa ChatGPT sin aviso.
  const next = await call(deps, post(body({ model: 'haiku', turn_id: 'otra' })));
  assert.equal(next.status, 200);
  assert.ok(!('switched' in next.body));
  // Ningún saldo alcanza: 429 budget (con el texto nuevo).
  db.wallet(USER, 'openai')!.spentMicros = db.wallet(USER, 'openai')!.budgetMicros;
  const none = await call(deps, post(body({ model: 'haiku', turn_id: 'sin-saldo' })));
  assert.equal(none.status, 429);
  assert.equal(none.body.reason, 'budget');
  assert.match(none.body.message, /saldo/);
});

test('cambio automático por plan que dejó de valer (noplan): avisa también en un rechazo', async () => {
  const db = FakeDb.dual();
  db.buy(USER, 'basic');
  db.buy(USER, 'claude_basic');
  db.refund(USER, 'anthropic');
  const { deps, rec } = makeDeps(db);
  // basic (ChatGPT) solo permite low: pedir high pasa al otro saldo y se ajusta al esfuerzo permitido.
  const res = await call(deps, post(body({ model: 'haiku', effort: 'high' })));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.switched, { from: 'anthropic', to: 'openai', reason: 'noplan' });
  assert.deepEqual(rec.openai[0].reasoning, { effort: 'low' });
  // Un rechazo con cambio de saldo también lleva switched (la pregunta abierta y otra clave del plan).
  const db2 = FakeDb.dual();
  db2.buy(USER, 'pro');
  db2.buy(USER, 'claude_pro');
  db2.refund(USER, 'anthropic');
  db2.plans.get('pro')!.rpm = 0;
  const denied = await call(makeDeps(db2).deps, post(body({ model: 'haiku' })));
  assert.equal(denied.status, 429);
  assert.equal(denied.body.reason, 'rate');
  assert.deepEqual(denied.body.switched, { from: 'anthropic', to: 'openai', reason: 'noplan' });
});

test('max_tokens: se recorta a LIMITS antes de la base y la base lo baja según el saldo (mínimo 2.048)', async () => {
  const db = FakeDb.dual();
  db.buy(USER, 'claude_ultra');
  const { deps, rec } = makeDeps(db);
  // Pedido de 200.000: a la base va 128.000 (MAX_OUTPUT_TOKENS) y el plan Ultra concede 128.000.
  const big = await call(deps, post(body({ model: 'haiku', max_tokens: 200000 })));
  assert.equal(big.status, 200, JSON.stringify(big.body));
  assert.equal(rec.rpc.find((r) => r.name === 'ai_register_turn')!.args.p_max_tokens, 128000);
  assert.equal(rec.claude[0].maxTokens, 128000);
  // Sin max_tokens del launcher: p_max_tokens null y el tope es el que concede la base.
  await call(deps, post(body({ model: 'haiku', turn_id: 'sin-max' })));
  assert.equal(rec.rpc.filter((r) => r.name === 'ai_register_turn')[1].args.p_max_tokens, null);
  assert.equal(rec.claude[1].maxTokens, 128000);

  // Saldo justo: Haiku cuesta 0,5 USD por millón de salida; con 3.000 millonésimas quedan unos 3.900 tokens.
  const low = FakeDb.dual();
  low.buy(USER, 'claude_basic', { spentUsd: 3.5 - 0.003 });
  const l = makeDeps(low);
  const res = await call(l.deps, post(body({ model: 'haiku', max_tokens: 12000 })));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const granted = l.rec.claude[0].maxTokens;
  assert.ok(granted >= MIN_GRANT_TOKENS && granted < 12000, String(granted));
  // Si no alcanza ni para el mínimo y no hay otro saldo: budget.
  low.wallet(USER, 'anthropic')!.spentMicros = low.wallet(USER, 'anthropic')!.budgetMicros - 1500;
  const denied = await call(l.deps, post(body({ model: 'haiku', max_tokens: 12000, turn_id: 'corto' })));
  assert.equal(denied.status, 429);
  assert.equal(denied.body.reason, 'budget');
});

test('not_configured por proveedor: sin clave de Claude, 503 con provider, la pregunta se devuelve y no se cobra', async () => {
  const db = FakeDb.dual();
  db.buy(USER, 'claude_pro');
  const { deps, rec } = makeDeps(db, { keys: ['openai'] });
  const res = await call(deps, post(body({ model: 'haiku', turn_id: 'sin-clave' })));
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'not_configured');
  assert.equal(res.body.provider, 'anthropic');
  assert.equal(rec.claude.length + rec.openai.length, 0);
  assert.deepEqual(names(rec), ['ai_register_turn', 'ai_provider_settings', 'ai_release_turn', 'ai_end_call']);
  assert.equal(db.reservations.get(USER)?.length ?? 0, 0, 'la llamada quedó cerrada');
  assert.equal(db.wallet(USER, 'anthropic')!.spentMicros, 0);
  assert.equal(res.body.quota.models.find((m: Body) => m.id === 'haiku').daily.used, 0, 'la pregunta se devolvió');
  assert.equal(db.turns.size, 0);
  assert.ok(rec.logs.some((l) => l.includes('anthropic no está configurado')));
  // Con cambio de saldo: el 503 también lo avisa.
  const db2 = FakeDb.dual();
  db2.buy(USER, 'claude_go');
  db2.buy(USER, 'go', { spentUsd: 6.75 - 0.0005, activate: false });
  db2.activeWallet.set(USER, 'openai');
  const res2 = await call(makeDeps(db2, { keys: ['openai'] }).deps, post(body({ model: 'haiku' })));
  assert.equal(res2.status, 503);
  assert.deepEqual(res2.body.switched, { from: 'openai', to: 'anthropic', reason: 'budget' });
  // Sin la clave de OpenAI, un plan de ChatGPT tampoco llama a Claude.
  const db3 = FakeDb.dual();
  db3.buy(USER, 'pro');
  const r3 = makeDeps(db3, { keys: ['anthropic'] });
  const res3 = await call(r3.deps, post(body({ model: 'haiku' })));
  assert.equal(res3.status, 503);
  assert.equal(res3.body.provider, 'openai');
  assert.equal(r3.rec.claude.length, 0);
});

test('esfuerzo max: Claude Ultra lo acepta; ChatGPT Ultra no (403 plan); default medium', async () => {
  const db = FakeDb.dual();
  db.buy(USER, 'claude_ultra');
  const { deps, rec } = makeDeps(db);
  const ok = await call(deps, post(body({ model: 'sonnet', effort: 'max' })));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(rec.claude[0].effort, 'max');
  assert.deepEqual(ok.body.quota.models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  await call(deps, post(body({ model: 'haiku', turn_id: 'default' })));
  assert.equal(rec.claude[1].effort, 'medium');

  const gpt = FakeDb.dual();
  gpt.buy(USER, 'ultra');
  const g = makeDeps(gpt);
  const denied = await call(g.deps, post(body({ model: 'sonnet', effort: 'max' })));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'plan');
  assert.equal(denied.body.reason, 'effort');
  assert.equal(g.rec.openai.length, 0);
});

test('respaldo entre proveedores (si se activa en ai_provider_config): Claude saturada pasa a ChatGPT con models.openai', async () => {
  const db = FakeDb.dual();
  db.buy(USER, 'claude_max');
  db.providerConfig = { primary: 'openai', secondary: 'anthropic', failoverEnabled: true, failoverOn: ['overloaded', 'not_configured'] };
  const { deps, rec } = makeDeps(db, { claudeFailure: { kind: 'status', status: 529, type: 'overloaded_error' } });
  const res = await call(deps, post(body({ model: 'sonnet', effort: 'xhigh' })));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(rec.claude.length, 1, 'primero el proveedor del saldo (Claude), aunque la configuración diga openai');
  assert.equal(rec.openai[0].model, 'gpt-5.6-sol');
  assert.deepEqual(rec.openai[0].reasoning, { effort: 'xhigh' });
  assert.deepEqual(res.body.message.served_by, { provider: 'openai', model: 'gpt-5.6-sol', failover: true });
  assert.deepEqual(rec.ready.sort(), ['anthropic', 'openai']);
  assert.ok(names(rec).includes('ai_provider_settings'));
  // Sin la clave de Claude y con not_configured en failover_on: directo a ChatGPT.
  const db2 = FakeDb.dual();
  db2.buy(USER, 'claude_max');
  db2.providerConfig = db.providerConfig;
  const r2 = makeDeps(db2, { keys: ['openai'] });
  const res2 = await call(r2.deps, post(body({ model: 'haiku' })));
  assert.equal(res2.status, 200, JSON.stringify(res2.body));
  assert.deepEqual(res2.body.message.served_by, { provider: 'openai', model: 'gpt-6-luna', failover: true });
});

test('GET: cuota con saldos y catálogo de los diez planes con familia y nivel', async () => {
  const db = FakeDb.dual();
  db.buy(USER, 'claude_go');
  db.buy(USER, 'pro', { activate: false, spentUsd: 2 });
  const { deps } = makeDeps(db);
  const res = await call(deps, new Request(URL_FN, { headers: { Authorization: 'Bearer good' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.quota.wallets, [
    { provider: 'anthropic', plan: 'claude_go', planName: 'Go', tier: 'go', usedUsd: 0, limitUsd: 6.75, remainingUsd: 6.75, active: true },
    { provider: 'openai', plan: 'pro', planName: 'Pro', tier: 'pro', usedUsd: 2, limitUsd: 12.5, remainingUsd: 10.5, active: false },
  ]);
  assert.equal(res.body.quota.resets.monthly, '', 'un saldo no se renueva por mes');
  const plans = res.body.plans as Body[];
  assert.deepEqual(plans.map((p) => p.id), ['basic', 'go', 'pro', 'max', 'ultra', 'claude_basic', 'claude_go', 'claude_pro', 'claude_max', 'claude_ultra']);
  const claudeUltra = plans.find((p) => p.id === 'claude_ultra')!;
  assert.deepEqual([claudeUltra.provider, claudeUltra.tier, claudeUltra.maxTokensPerRequest, claudeUltra.budgetUsd], ['anthropic', 'ultra', 128000, 32]);
  assert.deepEqual(plans.find((p) => p.id === 'max')!.models.map((m: Body) => m.label), ['GPT-6 Luna', 'GPT-5.6 Sol']);
});

test('los logs nunca incluyen el contenido de la conversación', async () => {
  const db = FakeDb.dual();
  db.buy(USER, 'claude_go', { spentUsd: 6.75 - 0.0005 });
  db.buy(USER, 'go', { activate: false });
  const { deps, rec } = makeDeps(db, { keys: ['anthropic'] });
  await call(deps, post(body()));
  assert.ok(rec.logs.length > 0);
  for (const line of rec.logs) assert.ok(!line.includes(SECRET), line);
});

test('cierre exacto (p_call): el costo va al saldo que reservó ESTA llamada, aunque haya otra en curso con el otro saldo', async () => {
  const db = FakeDb.dual();
  db.buy(USER, 'pro');
  db.buy(USER, 'claude_pro');
  // Una llamada que sigue en curso con el saldo de Claude (por ejemplo, otra ventana del launcher).
  const open = (await db.rpc('ai_register_turn', { p_user: USER, p_turn: 'en-curso', p_model: 'haiku', p_effort: 'low', p_max_tokens: 1000, p_input_bytes: 1000 })) as Body;
  assert.equal(open.provider, 'anthropic');
  // El usuario pasa al saldo de ChatGPT y hace otra pregunta, que termina antes.
  db.activeWallet.set(USER, 'openai');
  const { deps, rec } = makeDeps(db);
  const res = await call(deps, post(body({ model: 'haiku', turn_id: 'otra' })));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const add = rec.rpc.find((r) => r.name === 'ai_add_usage')!.args;
  assert.match(add.p_call, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(add.p_call, open.callId);
  // 1000 de entrada a 0,10 USD y 500 de salida a 0,50 USD por millón = 0,00035 USD, del saldo de ChatGPT.
  assert.equal(db.wallet(USER, 'openai')!.spentMicros, 350);
  assert.equal(db.wallet(USER, 'anthropic')!.spentMicros, 0, 'el saldo de Claude no paga la llamada de ChatGPT');
  assert.deepEqual(db.reservations.get(USER)!.map((r) => r.id), [open.callId], 'la llamada de Claude sigue en curso');
  // Una llamada que no llega a responder (sin clave) también cierra la suya y no la más vieja.
  const noKey = makeDeps(db, { keys: ['anthropic'] });
  const failed = await call(noKey.deps, post(body({ model: 'haiku', turn_id: 'sin-clave' })));
  assert.equal(failed.status, 503);
  const end = noKey.rec.rpc.find((r) => r.name === 'ai_end_call')!.args;
  assert.ok(end.p_call && end.p_call !== open.callId);
  assert.deepEqual(db.reservations.get(USER)!.map((r) => r.id), [open.callId]);
});

test('motor sin clave cargada (ai_provider_ready): no se elige solo al cambiar de saldo y sus planes salen como no disponibles', async () => {
  const db = FakeDb.dual();
  db.buy(USER, 'go');
  db.buy(USER, 'claude_go', { spentUsd: 6.75 - 0.0005 });
  db.ready.openai = false;
  const { deps, rec } = makeDeps(db, { keys: ['anthropic'] });
  const res = await call(deps, post(body({ model: 'haiku' })));
  assert.equal(res.status, 429);
  assert.equal(res.body.reason, 'budget');
  assert.ok(!('switched' in res.body), 'no cambia a un motor que no puede responder');
  assert.equal(db.activeWallet.get(USER), 'anthropic', 'el saldo en uso no cambia');
  assert.equal(rec.claude.length + rec.openai.length, 0);
  // El catálogo marca los planes de ese motor.
  const cat = await call(deps, new Request(URL_FN, { headers: { Authorization: 'Bearer good' } }));
  const off = (cat.body.plans as Body[]).filter((p) => p.available === false);
  assert.deepEqual(off.map((p) => p.id), ['basic', 'go', 'pro', 'max', 'ultra']);
  // Con la clave cargada, pasa al otro saldo y avisa.
  db.ready.openai = true;
  const ok = await call(makeDeps(db).deps, post(body({ model: 'haiku', turn_id: 'con-clave' })));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.switched, { from: 'anthropic', to: 'openai', reason: 'budget' });
});

test('pregunta abierta después de un cambio de saldo: las llamadas siguientes con el modelo y el esfuerzo viejos siguen (200)', async () => {
  // Claude Pro (Sonnet, alto) sin saldo y ChatGPT Go (solo el modelo rápido): el cambio pasa a GPT-6 Luna.
  const db = FakeDb.dual();
  db.buy(USER, 'go');
  db.buy(USER, 'claude_pro', { spentUsd: 12.5 - 0.0005 });
  const { deps, rec } = makeDeps(db);
  const first = await call(deps, post(body({ model: 'sonnet', effort: 'high', turn_id: 'ciclo' })));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.switched, { from: 'anthropic', to: 'openai', reason: 'budget' });
  assert.equal(rec.openai[0].model, 'gpt-6-luna');
  // El launcher manda los resultados de las herramientas con el modelo y el esfuerzo del principio del turno.
  const next = await call(deps, post(body({ model: 'sonnet', effort: 'high', turn_id: 'ciclo' })));
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.ok(!('switched' in next.body));
  assert.equal(rec.claude.length, 0);
  assert.equal(rec.openai[1].model, 'gpt-6-luna');
  assert.deepEqual(rec.openai[1].reasoning, { effort: 'high' });
  assert.equal(db.turns.get(`${USER}|ciclo|${db.today()}`)?.calls, 2);

  // El esfuerzo: Claude Basic (medio) sin saldo hacia ChatGPT Basic (solo bajo).
  const db2 = FakeDb.dual();
  db2.buy(USER, 'basic');
  db2.buy(USER, 'claude_basic', { spentUsd: 3.5 - 0.0002 });
  const r2 = makeDeps(db2);
  const a = await call(r2.deps, post(body({ model: 'haiku', effort: 'medium', turn_id: 'ciclo' })));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual(a.body.switched, { from: 'anthropic', to: 'openai', reason: 'budget' });
  const b = await call(r2.deps, post(body({ model: 'haiku', effort: 'medium', turn_id: 'ciclo' })));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.deepEqual(r2.rec.openai[1].reasoning, { effort: 'low' });
});

test('cancelar con ChatGPT Ultra y el modelo avanzado a los pocos segundos cobra la entrada y la salida de esos segundos, no max_tokens', async () => {
  const db = FakeDb.dual();
  db.buy(USER, 'ultra');
  const { deps, rec } = makeDeps(db);
  const controller = new AbortController();
  let now = 1_000_000;
  deps.now = () => now;
  deps.callOpenAI = (payload, signal) =>
    new Promise((_resolve, reject) => {
      rec.openai.push(payload);
      // El usuario toca Detener a los 3 s.
      now += 3000;
      signal.addEventListener('abort', () => reject(new Error('aborted')));
      setTimeout(() => controller.abort(), 5);
    });
  const payload = body({ model: 'sonnet', effort: 'high', max_tokens: 128000 });
  const res = await call(deps, new Request(URL_FN, {
    method: 'POST',
    headers: { Authorization: 'Bearer good', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }));
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'aborted');
  assert.equal(rec.openai.length, 1);
  assert.equal(rec.openai[0].max_output_tokens, 128000);
  const add = rec.rpc.find((r) => r.name === 'ai_add_usage')!.args;
  const cacheWrite = Math.ceil(JSON.stringify(payload).length / 3);
  // 3 s a 400 tokens por segundo = 1.200 tokens de salida (antes se cobraban los 128.000: US$ 2,56).
  assert.deepEqual(add.p_usage, [{ model: 'gpt-5.6-sol', input: 0, output: 1200, cacheRead: 0, cacheWrite }]);
  // GPT-5.6 Sol: escritura de caché a US$ 5 y salida a US$ 20 por millón.
  assert.equal(db.wallet(USER, 'openai')!.spentMicros, cacheWrite * 5 + 1200 * 20);
  assert.ok(db.wallet(USER, 'openai')!.spentMicros < 30000, 'menos de 3 centavos');
  assert.equal(db.reservations.get(USER)?.length ?? 0, 0, 'la reserva quedó cerrada');

  // Si cancela antes de que el pedido salga hacia OpenAI, no se cobra nada y la pregunta se devuelve.
  const db2 = FakeDb.dual();
  db2.buy(USER, 'ultra');
  const r2 = makeDeps(db2);
  const early = new AbortController();
  const original = r2.deps.rpc;
  let callId: unknown = null;
  r2.deps.rpc = async (name, args) => {
    const out = await original(name, args);
    if (name === 'ai_register_turn') {
      callId = (out as Body).callId;
      early.abort();
    }
    return out;
  };
  const res2 = await call(r2.deps, new Request(URL_FN, {
    method: 'POST',
    headers: { Authorization: 'Bearer good', 'Content-Type': 'application/json' },
    body: JSON.stringify(body({ model: 'sonnet', effort: 'high', max_tokens: 128000, turn_id: 'antes' })),
    signal: early.signal,
  }));
  assert.equal(res2.status, 503);
  assert.equal(res2.body.code, 'aborted');
  assert.equal(r2.rec.openai.length, 0);
  assert.deepEqual(names(r2.rec), ['ai_register_turn', 'ai_provider_settings', 'ai_release_turn', 'ai_end_call']);
  assert.ok(callId);
  assert.equal(r2.rec.rpc.find((r) => r.name === 'ai_end_call')!.args.p_call, callId, 'cierra la llamada con su callId');
  assert.equal(db2.wallet(USER, 'openai')!.spentMicros, 0);
  assert.equal(db2.reservations.get(USER)?.length ?? 0, 0);
  assert.equal(db2.turns.size, 0, 'la pregunta se devolvió');
});
