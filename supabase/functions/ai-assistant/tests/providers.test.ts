// Pruebas de providers.ts: configuración de proveedores, tabla de decisión del respaldo y orden de los intentos
// (node --test, ver supabase/functions/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FAILOVER_ON, FAILOVER_KINDS, OPENAI_EFFORTS, OPENAI_MODEL_PATTERN, PROVIDERS } from '../config.ts';
import { mapUpstreamError } from '../errors.ts';
import type { UpstreamFailure } from '../errors.ts';
import { ANTHROPIC_ONLY, defaultSettings, failoverKind, parseProviderSettings, planAttempts } from '../providers.ts';
import type { OpenAITier, ProviderSettings } from '../providers.ts';

const EFFORTS = { low: 'low', medium: 'medium', high: 'high' } as const;
const LUNA: OpenAITier = { model: 'gpt-6-luna', efforts: { ...EFFORTS } };
const SOL: OpenAITier = { model: 'gpt-6.1-sol', efforts: { ...EFFORTS } };
const ASTRA: OpenAITier = { model: 'gpt-6-astra', efforts: { ...EFFORTS } };
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
  assert.deepEqual(partial?.openai, { haiku: { model: 'gpt-4.1', efforts: { low: null, medium: null, high: 'xhigh' } } });
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

test('planAttempts: Anthropic primero y OpenAI de respaldo con el modelo de cada pregunta', () => {
  const settings = defaultSettings({ haiku: LUNA, sonnet: SOL, opus: ASTRA });
  assert.deepEqual(planAttempts(settings, BOTH, 'sonnet'), { attempts: [{ provider: 'anthropic' }, { provider: 'openai', tier: SOL }], primarySkipped: false });
  assert.deepEqual(planAttempts(settings, BOTH, 'opus').attempts[1], { provider: 'openai', tier: ASTRA });
  // Antes de saber el modelo: alcanza con que OpenAI tenga alguno.
  assert.equal(planAttempts(settings, BOTH, null).attempts.length, 2);
  // Sin OPENAI_API_KEY o sin respaldo: solo Anthropic.
  assert.deepEqual(planAttempts(settings, { anthropic: true, openai: false }, 'sonnet'), { attempts: [{ provider: 'anthropic' }], primarySkipped: false });
  assert.deepEqual(planAttempts({ ...settings, failoverEnabled: false }, BOTH, 'sonnet').attempts, [{ provider: 'anthropic' }]);
  assert.deepEqual(planAttempts(ANTHROPIC_ONLY, BOTH, 'sonnet').attempts, [{ provider: 'anthropic' }]);
  // Sin modelo de OpenAI para esa pregunta: solo Anthropic.
  assert.deepEqual(planAttempts(defaultSettings({ haiku: LUNA }), BOTH, 'opus').attempts, [{ provider: 'anthropic' }]);
});

test('planAttempts: sin ANTHROPIC_API_KEY va directo a OpenAI (si not_configured está en failover_on)', () => {
  const settings = defaultSettings({ haiku: LUNA, sonnet: SOL, opus: ASTRA });
  const noAnthropic = { anthropic: false, openai: true };
  assert.deepEqual(planAttempts(settings, noAnthropic, 'haiku'), { attempts: [{ provider: 'openai', tier: LUNA }], primarySkipped: true });
  const withoutKind: ProviderSettings = { ...settings, failoverOn: new Set([...settings.failoverOn].filter((k) => k !== 'not_configured')) };
  assert.deepEqual(planAttempts(withoutKind, noAnthropic, 'haiku'), { attempts: [], primarySkipped: true });
  assert.deepEqual(planAttempts({ ...settings, failoverEnabled: false }, noAnthropic, 'haiku').attempts, []);
  assert.deepEqual(planAttempts(settings, noAnthropic, 'opus').attempts, [{ provider: 'openai', tier: ASTRA }]);
  assert.deepEqual(planAttempts(defaultSettings({}), noAnthropic, null).attempts, [], 'OpenAI sin modelos configurados');
  assert.deepEqual(planAttempts(settings, { anthropic: false, openai: false }, 'haiku').attempts, []);
});

test('planAttempts: OpenAI como principal y Anthropic de respaldo', () => {
  const settings: ProviderSettings = { ...defaultSettings({ sonnet: SOL }), primary: 'openai', secondary: 'anthropic' };
  assert.deepEqual(planAttempts(settings, BOTH, 'sonnet'), { attempts: [{ provider: 'openai', tier: SOL }, { provider: 'anthropic' }], primarySkipped: false });
  // OpenAI no tiene modelo para Haiku: va directo a Anthropic (como "no configurado").
  assert.deepEqual(planAttempts(settings, BOTH, 'haiku'), { attempts: [{ provider: 'anthropic' }], primarySkipped: true });
  assert.deepEqual(planAttempts(settings, { anthropic: true, openai: false }, 'sonnet'), { attempts: [{ provider: 'anthropic' }], primarySkipped: true });
});
