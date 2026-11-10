// Pruebas de providers.ts: configuración de proveedores, tabla de decisión del respaldo y orden de los intentos
// (node --test, ver supabase/functions/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FAILOVER_ON, FAILOVER_KINDS, OPENAI_EFFORTS, OPENAI_MODEL_PATTERN, PROVIDERS } from '../config.ts';
import { mapUpstreamError } from '../errors.ts';
import type { UpstreamFailure } from '../errors.ts';
import { ANTHROPIC_ONLY, callTargets, defaultSettings, failoverKind, parseProviderSettings, planAttempts } from '../providers.ts';
import type { CallTargets, OpenAITier, ProviderSettings, TargetSource } from '../providers.ts';

const EFFORTS = { low: 'low', medium: 'medium', high: 'high' } as const;
const LUNA: OpenAITier = { model: 'gpt-6-luna', efforts: { ...EFFORTS, xhigh: null, max: null } };
const SOL: OpenAITier = { model: 'gpt-6.1-sol', efforts: { ...EFFORTS, xhigh: null, max: null } };
const ASTRA: OpenAITier = { model: 'gpt-6-astra', efforts: { ...EFFORTS, xhigh: null, max: null } };
const BOTH = { anthropic: true, openai: true };

function raw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    primary: 'anthropic',
    secondary: 'openai',
    failoverEnabled: true,
    failoverOn: [...DEFAULT_FAILOVER_ON],
    openai: { haiku: { model: 'gpt-6-luna', efforts: EFFORTS }, sonnet: { model: 'gpt-6.1-sol', efforts: EFFORTS }, opus: { model: 'gpt-6-astra', efforts: EFFORTS } },
    ...extra,
  };
}

test('constantes: proveedores, tipos de falla y esfuerzos de OpenAI', () => {
  assert.deepEqual([...PROVIDERS], ['anthropic', 'openai']);
  assert.deepEqual([...DEFAULT_FAILOVER_ON], FAILOVER_KINDS.filter((k) => k !== 'unknown'));
  assert.deepEqual([...OPENAI_EFFORTS], ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  for (const id of ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-5.4-mini', 'o3', 'o4-mini', 'gpt-6.1-sol-2026-09-30']) {
    assert.match(id, OPENAI_MODEL_PATTERN, id);
  }
  for (const id of ['claude-opus-5-5', 'GPT-6', 'gpt-', 'gpt-6 luna', 'gpt-6;drop', 'o', 'davinci']) assert.doesNotMatch(id, OPENAI_MODEL_PATTERN, id);
});

test('parseProviderSettings: la forma de ai_provider_settings()', () => {
  const settings = parseProviderSettings(raw());
  assert.deepEqual(settings, { ...defaultSettings({ haiku: LUNA, sonnet: SOL, opus: ASTRA }) });
  assert.ok(settings?.failoverOn.has('not_configured'));
  assert.ok(!settings?.failoverOn.has('unknown'));
  // Esfuerzos null (no se manda reasoning) y valores desconocidos (se ignoran).
  const partial = parseProviderSettings(raw({ openai: { haiku: { model: 'gpt-4.1', efforts: { low: null, medium: 'turbo', high: 'xhigh' } }, sonnet: { model: 'claude-sonnet-5-5' }, opus: 'x' } }));
  assert.deepEqual(partial?.openai, { haiku: { model: 'gpt-4.1', efforts: { low: null, medium: null, high: 'xhigh', xhigh: null, max: null } } });
  // Tipos de falla desconocidos se ignoran; nunca aparece un tipo que no está en FAILOVER_KINDS.
  assert.deepEqual([...(parseProviderSettings(raw({ failoverOn: ['overloaded', 'refusal', 'invalid_request', 3] }))?.failoverOn ?? [])], ['overloaded']);
  // Sin secundario (o igual al principal) no hay respaldo.
  assert.equal(parseProviderSettings(raw({ secondary: null }))?.failoverEnabled, false);
  assert.equal(parseProviderSettings(raw({ secondary: 'anthropic' }))?.secondary, null);
  assert.equal(parseProviderSettings(raw({ failoverEnabled: 'si' }))?.failoverEnabled, false);
  // OpenAI como principal.
  const swapped = parseProviderSettings(raw({ primary: 'openai', secondary: 'anthropic' }));
  assert.deepEqual([swapped?.primary, swapped?.secondary, swapped?.failoverEnabled], ['openai', 'anthropic', true]);
  // Basura: null (el handler usa solo Anthropic).
  for (const bad of [null, [], 'x', raw({ primary: 'gemini' }), raw({ primary: undefined }), raw({ secondary: 'gemini' })]) {
    assert.equal(parseProviderSettings(bad), null, JSON.stringify(bad));
  }
});

test('tabla de decisión: qué fallas pasan el pedido al otro proveedor', () => {
  const status = (code: number, type: string | null = null, detail: string | null = null): UpstreamFailure => ({ kind: 'status', status: code, type, detail });
  // [falla, código del protocolo, tipo de falla (null = nunca pasa al otro)]
  const table: [UpstreamFailure, string, string | null][] = [
    [status(429, 'rate_limit_error'), 'upstream_rate_limited', 'rate_limited'],
    [status(529, 'overloaded_error'), 'upstream_overloaded', 'overloaded'],
    [status(500, 'api_error'), 'upstream_unavailable', 'unavailable'],
    [status(503), 'upstream_unavailable', 'unavailable'],
    [status(504, 'timeout_error'), 'upstream_timeout', 'timeout'],
    [{ kind: 'timeout' }, 'upstream_timeout', 'timeout'],
    [{ kind: 'connection' }, 'upstream_network', 'network'],
    [status(402, 'billing_error'), 'upstream_billing', 'billing'],
    [status(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'), 'upstream_billing', 'billing'],
    [status(401, 'authentication_error'), 'upstream_auth', 'auth'],
    [status(403, 'permission_error'), 'upstream_permission', 'permission'],
    [status(400, 'invalid_request_error', 'Unexpected value(s) `x` for the `anthropic-beta` header.'), 'upstream_config', 'config'],
    [status(400, 'config_error'), 'upstream_config', 'config'],
    [status(404, 'not_found_error'), 'upstream_model', 'model'],
    [{ kind: 'unknown', name: 'TypeError' }, 'upstream_error', 'unknown'],
    // Nunca: pedido inválido (400, 413, 422) ni cancelación del launcher.
    [status(400, 'invalid_request_error', 'messages.0: bad'), 'upstream_invalid_request', null],
    [status(413, 'request_too_large'), 'upstream_invalid_request', null],
    [status(422), 'upstream_invalid_request', null],
    [{ kind: 'aborted' }, 'aborted', null],
  ];
  for (const [failure, code, kind] of table) {
    const mapped = mapUpstreamError(failure);
    assert.equal(mapped.body.code, code, JSON.stringify(failure));
    assert.equal(failoverKind(mapped.body.code), kind, code);
  }
  assert.equal(failoverKind('not_configured'), 'not_configured');
  assert.equal(failoverKind('turn_model'), null);
  assert.equal(failoverKind('toString'), null);
  // 'unknown' existe pero no está en los valores por defecto.
  assert.ok(!DEFAULT_FAILOVER_ON.includes('unknown'));
});

// Llamada de 0056: proveedor del saldo, ids de los dos motores y el esfuerzo de OpenAI que decide la base.
function source(extra: Partial<TargetSource> = {}): TargetSource {
  return {
    provider: 'anthropic', model: 'sonnet', modelId: 'claude-sonnet-5-5', effort: 'high', openaiEffort: 'high',
    models: { anthropic: 'claude-sonnet-5-5', openai: 'gpt-5.6-sol' }, ...extra,
  };
}
const TARGETS: CallTargets = { anthropic: 'claude-sonnet-5-5', openai: { model: 'gpt-5.6-sol', effort: 'high' } };
const OFF: ProviderSettings = { ...defaultSettings({}), failoverEnabled: false };

test('callTargets: con 0056 los modelos salen de la llamada; sin provider, de ai_tier_fallbacks', () => {
  assert.deepEqual(callTargets(source(), OFF), TARGETS);
  // openaiEffort null: no se manda reasoning (aunque ai_tier_fallbacks diga otra cosa).
  assert.deepEqual(callTargets(source({ openaiEffort: null }), defaultSettings({ sonnet: SOL })).openai, { model: 'gpt-5.6-sol', effort: null });
  // Sin openaiEffort (la base no lo manda): la traducción de ai_tier_fallbacks.
  const noEffort = source();
  delete noEffort.openaiEffort;
  assert.deepEqual(callTargets(noEffort, defaultSettings({ sonnet: SOL })).openai, { model: 'gpt-5.6-sol', effort: 'high' });
  // Un motor que no ofrece la clave: null.
  assert.equal(callTargets(source({ provider: 'openai', models: { anthropic: 'claude-sonnet-5-5', openai: null } }), OFF).openai, null);
  // Base anterior a 0056: modelId es de Anthropic y el de OpenAI sale de ai_tier_fallbacks.
  const legacy = source({ provider: null, models: { anthropic: null, openai: null } });
  delete legacy.openaiEffort;
  assert.deepEqual(callTargets(legacy, defaultSettings({ sonnet: SOL })), { anthropic: 'claude-sonnet-5-5', openai: { model: 'gpt-6.1-sol', effort: 'high' } });
  assert.deepEqual(callTargets(legacy, OFF), { anthropic: 'claude-sonnet-5-5', openai: null });
});

test('planAttempts: el proveedor de la llamada primero; el otro solo con el respaldo activado', () => {
  const both = { anthropic: true, openai: true };
  const on = defaultSettings({});
  const claude = { provider: 'anthropic' as const, model: 'claude-sonnet-5-5' };
  const gpt = { provider: 'openai' as const, model: 'gpt-5.6-sol', effort: 'high' as const };
  // Respaldo apagado (como en producción): solo el del saldo.
  assert.deepEqual(planAttempts('anthropic', OFF, both, TARGETS), { attempts: [claude], primarySkipped: false });
  assert.deepEqual(planAttempts('openai', OFF, both, TARGETS), { attempts: [gpt], primarySkipped: false });
  assert.deepEqual(planAttempts('anthropic', ANTHROPIC_ONLY, both, TARGETS).attempts, [claude]);
  // Respaldo activado: el otro después, sea cual sea el principal de ai_provider_config.
  assert.deepEqual(planAttempts('anthropic', on, both, TARGETS).attempts, [claude, gpt]);
  assert.deepEqual(planAttempts('openai', on, both, TARGETS).attempts, [gpt, claude]);
  // El otro sin clave o sin modelo para la clave: no se suma.
  assert.deepEqual(planAttempts('anthropic', on, { anthropic: true, openai: false }, TARGETS).attempts, [claude]);
  assert.deepEqual(planAttempts('anthropic', on, both, { ...TARGETS, openai: null }).attempts, [claude]);
});

test('planAttempts: el proveedor de la llamada sin clave', () => {
  const on = defaultSettings({});
  const noClaude = { anthropic: false, openai: true };
  // Sin respaldo: ningún intento (el handler responde 503 not_configured y devuelve la pregunta).
  assert.deepEqual(planAttempts('anthropic', OFF, noClaude, TARGETS), { attempts: [], primarySkipped: true });
  // Con respaldo y not_configured en failover_on: directo al otro.
  assert.deepEqual(planAttempts('anthropic', on, noClaude, TARGETS), { attempts: [{ provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' }], primarySkipped: true });
  const withoutKind: ProviderSettings = { ...on, failoverOn: new Set([...on.failoverOn].filter((k) => k !== 'not_configured')) };
  assert.deepEqual(planAttempts('anthropic', withoutKind, noClaude, TARGETS).attempts, []);
  assert.deepEqual(planAttempts('openai', OFF, { anthropic: true, openai: false }, TARGETS).attempts, []);
  assert.deepEqual(planAttempts('openai', on, { anthropic: false, openai: false }, TARGETS).attempts, []);
});
