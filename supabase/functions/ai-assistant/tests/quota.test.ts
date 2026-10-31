// Pruebas de quota.ts y config.ts (node --test, ver supabase/functions/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIMEOUT_MS,
  FALLBACK_MODELS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MODEL_KEYS,
  parseTimeoutMs,
  PROTOCOLS,
  TOOL_LEVELS,
  TOOL_NAMES,
  TURN_ID_PATTERN,
} from '../config.ts';
import {
  clampMaxTokens,
  DENIAL_MESSAGES,
  denialResponse,
  estimatedUsageLine,
  newTurnId,
  normalizeCatalog,
  normalizeQuota,
  parseTurnCheck,
  parseUsageResult,
  usageLines,
} from '../quota.ts';
import type { DenyReason, Quota } from '../quota.ts';

const quota: Quota = {
  plan: 'max',
  planName: 'Max',
  priceUsd: 36.5,
  status: 'active',
  models: [
    { id: 'haiku', model: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: ['low', 'medium', 'high'], daily: { used: 3, limit: 25 }, weekly: { used: 9, limit: 115 } },
    { id: 'sonnet', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: ['low', 'medium', 'high'], daily: { used: 0, limit: 8 }, weekly: { used: 2, limit: 40 } },
    { id: 'opus', model: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium'], daily: { used: 1, limit: 4 }, weekly: { used: 1, limit: 20 } },
  ],
  budget: { usedUsd: 2.1234, limitUsd: 19 },
  resets: { daily: '2026-10-29T03:00:00Z', weekly: '2026-11-02T03:00:00Z', monthly: '2026-11-01T03:00:00Z' },
  timezone: 'America/Argentina/Buenos_Aires',
  lastModel: 'sonnet',
};

const noPlan = {
  plan: null,
  planName: null,
  priceUsd: null,
  status: 'none',
  models: [],
  budget: { usedUsd: 0.5, limitUsd: 0 },
  resets: quota.resets,
  timezone: quota.timezone,
  lastModel: null,
};

test('lista canónica de herramientas y sus niveles', () => {
  const expected = [
    'list_instances', 'get_instance_info', 'list_mods', 'get_system_specs', 'search_mods', 'search_resource_packs',
    'search_shaders', 'get_mod_versions', 'check_compatibility', 'read_crash_summary', 'run_benchmark',
    'create_instance', 'install_mod', 'install_resource_pack', 'install_shader', 'update_mod', 'toggle_mod', 'set_ram',
    'set_option', 'set_java_version', 'set_jvm_args', 'change_instance_version', 'remove_mod',
    'list_servers', 'get_server_info', 'read_server_console', 'get_server_properties', 'list_server_plugins', 'search_server_plugins',
    'list_server_backups', 'recommend_ram', 'list_snapshots', 'list_worlds',
    'create_server', 'start_server', 'stop_server', 'restart_server', 'send_server_command', 'set_server_property', 'set_server_ram',
    'install_server_plugin', 'update_server_plugin', 'replace_server_plugin', 'toggle_server_plugin', 'backup_server_world',
    'duplicate_instance', 'rename_instance', 'create_snapshot', 'backup_world',
    'remove_server_plugin', 'restore_server_backup', 'restore_snapshot', 'whitelist_add', 'whitelist_remove', 'op_player',
  ];
  assert.deepEqual([...TOOL_NAMES].sort(), [...expected].sort());
  const levels = Object.values(TOOL_LEVELS);
  assert.equal(levels.filter((l) => l === 'read').length, 21);
  assert.equal(levels.filter((l) => l === 'reversible').length, 27);
  assert.deepEqual(Object.keys(TOOL_LEVELS).filter((name) => TOOL_LEVELS[name] === 'destructive'), ['remove_mod', 'remove_server_plugin', 'restore_server_backup', 'restore_snapshot', 'whitelist_add', 'whitelist_remove', 'op_player']);
});

test('protocolos, modelos y reintento en otro modelo', () => {
  assert.deepEqual([...PROTOCOLS], [1, 2]);
  assert.deepEqual([...MODEL_KEYS], ['haiku', 'sonnet', 'opus']);
  assert.deepEqual([...FALLBACK_MODELS].sort(), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.ok(!FALLBACK_MODELS.has('claude-haiku-5-5'));
});

test('parseTimeoutMs usa el valor por defecto y respeta el rango', () => {
  assert.equal(parseTimeoutMs(undefined), DEFAULT_TIMEOUT_MS);
  assert.equal(parseTimeoutMs(''), DEFAULT_TIMEOUT_MS);
  assert.equal(parseTimeoutMs('abc'), DEFAULT_TIMEOUT_MS);
  assert.equal(parseTimeoutMs('-5'), DEFAULT_TIMEOUT_MS);
  assert.equal(parseTimeoutMs('60000'), 60000);
  assert.equal(parseTimeoutMs('5000'), MIN_TIMEOUT_MS);
  assert.equal(parseTimeoutMs('9999999'), MAX_TIMEOUT_MS);
});

test('clampMaxTokens nunca pasa el tope del plan ni 16000', () => {
  assert.equal(clampMaxTokens(null, 8000), 8000);
  assert.equal(clampMaxTokens(undefined, undefined), 16000);
  assert.equal(clampMaxTokens(2000, 8000), 2000);
  assert.equal(clampMaxTokens(9000, 8000), 8000);
  assert.equal(clampMaxTokens(20000, 0), 16000);
  assert.equal(clampMaxTokens(64000, 32000), 16000);
  assert.equal(clampMaxTokens(16000, 16000), 16000);
  assert.equal(clampMaxTokens(0, 8000), 1);
  assert.equal(clampMaxTokens(Number.NaN, 8000), 8000);
});

test('usageLines: un intento, con la escritura de caché aparte de la entrada', () => {
  assert.deepEqual(
    usageLines({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, 'claude-haiku-5-5', 'claude-haiku-5-5'),
    [{ model: 'claude-haiku-5-5', input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 }],
  );
  // El modelo es el que respondió (si es un id válido); si no, el pedido.
  assert.equal(usageLines({ input_tokens: 1 }, 'claude-opus-5-5', 'claude-opus-5')[0].model, 'claude-opus-5');
  assert.equal(usageLines({ input_tokens: 1 }, 'claude-opus-5-5', 'cualquier cosa')[0].model, 'claude-opus-5-5');
  assert.deepEqual(usageLines({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null }, 'claude-sonnet-5-5'), [
    { model: 'claude-sonnet-5-5', input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  ]);
});

test('usageLines: con reintento en otro modelo, un renglón por intento con el modelo que lo corrió', () => {
  const usage = {
    // El usage de arriba solo cubre el intento que respondió.
    input_tokens: 400,
    output_tokens: 300,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    iterations: [
      { type: 'message', model: 'claude-opus-5-5', input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
      { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 400, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ],
  };
  assert.deepEqual(usageLines(usage, 'claude-opus-5-5', 'claude-opus-4-8'), [
    { model: 'claude-opus-5-5', input: 500, output: 20, cacheRead: 100, cacheWrite: 50 },
    { model: 'claude-opus-4-8', input: 400, output: 300, cacheRead: 0, cacheWrite: 0 },
  ]);
  // Intentos sin modelo: el intento declinado es del modelo pedido; el de respaldo, del que respondió.
  const anonymous = { iterations: [{ type: 'message', model: null, input_tokens: 5 }, { type: 'fallback_message', input_tokens: 7 }] };
  assert.deepEqual(usageLines(anonymous, 'claude-sonnet-5-5', 'claude-sonnet-5').map((l) => [l.model, l.input]), [
    ['claude-sonnet-5-5', 5],
    ['claude-sonnet-5', 7],
  ]);
});

test('usageLines: nunca cuenta de menos que el usage de arriba', () => {
  const usage = {
    input_tokens: 900,
    output_tokens: 40,
    iterations: [{ type: 'message', model: 'claude-opus-5-5', input_tokens: 500, output_tokens: 40 }],
  };
  // La diferencia (400 de entrada) se suma al modelo que respondió.
  assert.deepEqual(usageLines(usage, 'claude-opus-5-5', 'claude-opus-5-5'), [
    { model: 'claude-opus-5-5', input: 900, output: 40, cacheRead: 0, cacheWrite: 0 },
  ]);
  assert.deepEqual(usageLines(usage, 'claude-opus-5-5', 'claude-opus-5'), [
    { model: 'claude-opus-5-5', input: 500, output: 40, cacheRead: 0, cacheWrite: 0 },
    { model: 'claude-opus-5', input: 400, output: 0, cacheRead: 0, cacheWrite: 0 },
  ]);
});

test('usageLines tolera datos raros', () => {
  assert.deepEqual(usageLines(null, 'claude-haiku-5-5'), []);
  assert.deepEqual(usageLines('x', 'claude-haiku-5-5'), []);
  assert.deepEqual(usageLines({ input_tokens: -5, output_tokens: 'mucho', iterations: 'no' }, 'claude-haiku-5-5'), [
    { model: 'claude-haiku-5-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ]);
  assert.deepEqual(usageLines({ input_tokens: 7, output_tokens: 3, iterations: [] }, 'claude-haiku-5-5'), [
    { model: 'claude-haiku-5-5', input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
  ]);
  assert.deepEqual(usageLines({ iterations: [{ type: 'message', model: 'gpt-5; drop', input_tokens: 2.9 }, 'x', null] }, 'claude-haiku-5-5'), [
    { model: 'claude-haiku-5-5', input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
  ]);
});

test('normalizeQuota deja la forma exacta de QuotaV2', () => {
  assert.deepEqual(normalizeQuota(quota), quota);
  assert.deepEqual(normalizeQuota(JSON.parse(JSON.stringify(quota))), quota);
  // Sin plan.
  const empty = normalizeQuota(noPlan);
  assert.deepEqual(empty, {
    plan: null,
    planName: null,
    priceUsd: null,
    status: 'none',
    models: [],
    budget: { usedUsd: 0.5, limitUsd: 0 },
    resets: quota.resets,
    timezone: quota.timezone,
  });
  assert.ok(!('lastModel' in (empty as object)));
});

test('normalizeQuota corrige o descarta datos raros', () => {
  const odd = normalizeQuota({
    ...quota,
    priceUsd: '36.50',
    status: 'past_due',
    models: [
      { ...quota.models[0], efforts: ['high', 'max', 'low', 'low'], daily: { used: '4', limit: '25' } },
      { id: 'fable', model: 'claude-fable-5-1', label: 'Fable', efforts: ['low'], daily: {}, weekly: {} },
      { id: 'sonnet', model: 'gpt-5', label: 'x', efforts: [], daily: {}, weekly: {} },
      null,
    ],
    budget: { usedUsd: 1.234567, limitUsd: '19' },
    resets: { daily: 'mañana' },
    lastModel: 'opus',
    extra: true,
  });
  assert.deepEqual(odd?.models.map((m) => m.id), ['haiku'], 'modelos desconocidos o con un id de Anthropic inválido se omiten');
  assert.deepEqual(odd?.models[0].efforts, ['low', 'high']);
  assert.deepEqual(odd?.models[0].daily, { used: 4, limit: 25 });
  assert.equal(odd?.priceUsd, 36.5);
  assert.equal(odd?.status, 'active', 'un plan vigente siempre es active o trialing');
  assert.deepEqual(odd?.budget, { usedUsd: 1.2346, limitUsd: 19 });
  assert.deepEqual(odd?.resets, { daily: '', weekly: '', monthly: '' });
  assert.ok(!('lastModel' in (odd as object)), 'lastModel solo si el plan ofrece ese modelo');
  assert.ok(!('extra' in (odd as object)));
  assert.equal(normalizeQuota({ ...quota, status: 'trialing' })?.status, 'trialing');
  // Forma vieja (0007) o basura: null.
  assert.equal(normalizeQuota({ plan: 'free', planName: 'Free', model: 'claude-opus-5-5', daily: { used: 1, limit: 15 }, resetsAt: '' }), null);
  assert.equal(normalizeQuota(null), null);
  assert.equal(normalizeQuota([]), null);
  assert.equal(normalizeQuota({ ...quota, models: 'x' }), null);
});

test('normalizeCatalog deja la forma exacta del catálogo', () => {
  const raw = [
    { id: 'go', name: 'Go', priceUsd: 3.5, budgetUsd: 1.5, models: [{ id: 'haiku', label: 'Haiku 5.5', efforts: ['low', 'medium'], daily: 35, weekly: 170 }] },
    { id: 'max', name: 'Max', priceUsd: '36.50', budgetUsd: 19, models: [{ id: 'opus', label: 'Opus 5.5', efforts: ['medium', 'low'], daily: 4, weekly: 20 }, { id: 'otro' }] },
    { name: 'sin id' },
    'x',
  ];
  assert.deepEqual(normalizeCatalog(raw), [
    { id: 'go', name: 'Go', priceUsd: 3.5, budgetUsd: 1.5, models: [{ id: 'haiku', label: 'Haiku 5.5', efforts: ['low', 'medium'], daily: 35, weekly: 170 }] },
    { id: 'max', name: 'Max', priceUsd: 36.5, budgetUsd: 19, models: [{ id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium'], daily: 4, weekly: 20 }] },
  ]);
  assert.deepEqual(normalizeCatalog(null), []);
  assert.deepEqual(normalizeCatalog({}), []);
});

test('parseTurnCheck: llamada permitida, con el modelo de la base y fallbacks solo en Opus y Sonnet 5.5', () => {
  const allowed = parseTurnCheck({ allowed: true, reason: null, model: 'opus', modelId: 'claude-opus-5-5', fallback: true, effort: 'medium', counted: true, maxTokensPerRequest: 16000, quota });
  assert.deepEqual(allowed, { allowed: true, reason: null, model: 'opus', modelId: 'claude-opus-5-5', fallback: true, effort: 'medium', counted: true, maxTokensPerRequest: 16000, quota });
  // La base dice que Haiku tiene fallback: el código no lo usa igual.
  const haiku = parseTurnCheck({ allowed: true, reason: null, model: 'haiku', modelId: 'claude-haiku-5-5', fallback: true, effort: 'low', counted: false, maxTokensPerRequest: 8000, quota });
  assert.equal(haiku?.fallback, false);
  assert.equal(haiku?.counted, false);
  // Permitido sin modelo, sin id de Anthropic válido o sin esfuerzo: respuesta inválida.
  for (const broken of [
    { model: null },
    { model: 'gpt' },
    { modelId: 'gpt-5' },
    { modelId: null },
    { effort: 'max' },
    { effort: null },
    { quota: { plan: 'free' } },
  ]) {
    const raw = { allowed: true, reason: null, model: 'opus', modelId: 'claude-opus-5-5', fallback: true, effort: 'medium', counted: true, maxTokensPerRequest: 16000, quota, ...broken };
    assert.equal(parseTurnCheck(raw), null, JSON.stringify(broken));
  }
});

test('parseTurnCheck: rechazos', () => {
  for (const reason of ['noplan', 'model', 'effort', 'turn_model', 'rate', 'budget', 'turn', 'daily', 'weekly']) {
    const denied = parseTurnCheck({ allowed: false, reason, model: 'sonnet', modelId: null, effort: 'low', counted: false, maxTokensPerRequest: 16000, quota });
    assert.equal(denied?.allowed, false, reason);
    assert.equal(denied?.reason, reason);
    assert.equal(denied?.model, 'sonnet');
    assert.equal(denied?.modelId, null);
    assert.equal(denied?.fallback, false);
  }
  // Respuesta contradictoria: se rechaza por las dudas, sin contar la pregunta.
  const contradictory = parseTurnCheck({ allowed: true, reason: 'budget', model: 'opus', modelId: 'claude-opus-5-5', effort: 'medium', counted: true, quota });
  assert.equal(contradictory?.allowed, false);
  assert.equal(contradictory?.reason, 'budget');
  assert.equal(contradictory?.counted, false);
  assert.equal(contradictory?.modelId, null);
  // Motivo desconocido, sin motivo o sin cuota válida: respuesta inválida.
  assert.equal(parseTurnCheck({ allowed: false, reason: 'plan', quota }), null);
  assert.equal(parseTurnCheck({ allowed: false, reason: null, quota }), null);
  assert.equal(parseTurnCheck({ allowed: true, quota: null }), null);
  assert.equal(parseTurnCheck({ allowed: 'si', quota }), null);
  assert.equal(parseTurnCheck(null), null);
});

test('parseUsageResult lee la cuota, el costo y los modelos sin precio', () => {
  assert.deepEqual(parseUsageResult({ quota, costUsd: 0.012170, unpriced: ['claude-fable-5-1', 'x y\n', 3, ''] }), {
    quota,
    costUsd: 0.01217,
    unpriced: ['claude-fable-5-1', 'xy'],
  });
  assert.deepEqual(parseUsageResult({ quota: noPlan })?.unpriced, []);
  assert.equal(parseUsageResult({ quota: null }), null);
  assert.equal(parseUsageResult(null), null);
});

test('denialResponse: estado y cuerpo de cada rechazo', () => {
  const base = { allowed: false, model: 'sonnet' as const, modelId: null, fallback: false, effort: 'high' as const, counted: false, maxTokensPerRequest: 16000, quota };
  const plans = [{ id: 'go', name: 'Go', priceUsd: 3.5, budgetUsd: 1.5, models: [] }];
  const expected: Record<DenyReason, [number, Record<string, unknown>]> = {
    noplan: [402, { error: 'noplan', message: DENIAL_MESSAGES.noplan, quota, plans }],
    model: [403, { error: 'plan', reason: 'model', model: 'sonnet', message: DENIAL_MESSAGES.model, quota }],
    effort: [403, { error: 'plan', reason: 'effort', model: 'sonnet', message: DENIAL_MESSAGES.effort, quota }],
    turn_model: [400, { error: 'bad_request', code: 'turn_model', message: DENIAL_MESSAGES.turn_model, quota }],
    daily: [429, { error: 'quota', reason: 'daily', model: 'sonnet', message: DENIAL_MESSAGES.daily, quota }],
    weekly: [429, { error: 'quota', reason: 'weekly', model: 'sonnet', message: DENIAL_MESSAGES.weekly, quota }],
    budget: [429, { error: 'quota', reason: 'budget', model: 'sonnet', message: DENIAL_MESSAGES.budget, quota }],
    turn: [429, { error: 'quota', reason: 'turn', model: 'sonnet', message: DENIAL_MESSAGES.turn, quota }],
    rate: [429, { error: 'quota', reason: 'rate', model: 'sonnet', message: DENIAL_MESSAGES.rate, quota }],
  };
  for (const [reason, [status, body]] of Object.entries(expected) as [DenyReason, [number, Record<string, unknown>]][]) {
    const res = denialResponse({ ...base, reason }, reason === 'noplan' ? plans : []);
    assert.equal(res.status, status, reason);
    assert.deepEqual(res.body, body, reason);
  }
  // Sin modelo resuelto, el 429 no trae "model"; el 403 lo trae en null.
  assert.ok(!('model' in denialResponse({ ...base, model: null, reason: 'rate' }).body));
  assert.equal(denialResponse({ ...base, model: null, reason: 'model' }).body.model, null);
  // Nunca 401 ni 404 (el launcher los usa para "sesión vencida" y "el servidor no tiene el asistente").
  for (const reason of Object.keys(expected) as DenyReason[]) {
    assert.ok(![401, 404].includes(denialResponse({ ...base, reason }).status), reason);
  }
});

test('estimatedUsageLine: el peor caso de un intento cortado (pedido entero como escritura de caché y salida entera)', () => {
  assert.deepEqual(estimatedUsageLine('claude-opus-5-5', 3001, 16000), { model: 'claude-opus-5-5', input: 0, output: 16000, cacheRead: 0, cacheWrite: 1001 });
  assert.deepEqual(estimatedUsageLine('gpt-6-astra', 0, 8000), { model: 'gpt-6-astra', input: 0, output: 8000, cacheRead: 0, cacheWrite: 0 });
  // Valores raros: nunca negativos ni NaN (ai_token_count igual los recorta en la base).
  assert.deepEqual(estimatedUsageLine('claude-haiku-5-5', Number.NaN, -5), { model: 'claude-haiku-5-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  // Las claves son las que lee ai_add_usage (las mismas que arma usageLines).
  assert.deepEqual(Object.keys(estimatedUsageLine('m', 1, 1)).sort(), Object.keys(usageLines({ input_tokens: 1 }, 'm')[0]).sort());
});

test('newTurnId genera ids válidos y distintos', () => {
  const a = newTurnId();
  const b = newTurnId();
  assert.match(a, TURN_ID_PATTERN);
  assert.ok(a.startsWith('srv-'));
  assert.notEqual(a, b);
});
