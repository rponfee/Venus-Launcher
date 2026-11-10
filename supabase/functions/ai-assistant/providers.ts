// Proveedores de la IA (Anthropic y OpenAI) y respaldo entre ellos.
// Desde la 6.1 (0056) el proveedor de cada llamada es el del saldo que la paga (`provider` de ai_register_turn) y
// el modelo sale de la misma respuesta (modelId y models). public.ai_provider_settings() (0011_ai_providers.sql)
// solo decide si una caída de ese proveedor pasa el pedido al otro (hoy apagado). Con una base anterior a 0056 (sin
// `provider`), el principal y los modelos de OpenAI salen de ai_provider_settings(), como antes.
// Sin dependencias externas: se prueba con Node.
import { DEFAULT_FAILOVER_ON, EFFORTS, FAILOVER_KINDS, MODEL_KEYS, OPENAI_EFFORTS, OPENAI_MODEL_PATTERN, PROVIDERS } from './config.ts';
import type { Effort, FailoverKind, ModelKey, OpenAIEffort, Provider } from './config.ts';

/** Modelo de OpenAI que reemplaza a un modelo de Venus (ai_tier_fallbacks) y su traducción del esfuerzo. */
export interface OpenAITier {
  /** Id de la API de OpenAI (ai_models.model_id), por ejemplo "gpt-6.1-sol". */
  model: string;
  /** Esfuerzo de Venus -> reasoning.effort de OpenAI. null: no se manda reasoning (el modelo usa el suyo). */
  efforts: Record<Effort, OpenAIEffort | null>;
}

export interface ProviderSettings {
  primary: Provider;
  /** Proveedor de respaldo (null: ninguno). Nunca es igual al principal. */
  secondary: Provider | null;
  failoverEnabled: boolean;
  /** Fallas del proveedor que pasan el pedido al otro. */
  failoverOn: ReadonlySet<FailoverKind>;
  /** Modelo de OpenAI para cada modelo de Venus (solo los que tienen uno activo). */
  openai: Partial<Record<ModelKey, OpenAITier>>;
}

/** Sin respaldo entre proveedores (también si no se puede leer ai_provider_settings). */
export const ANTHROPIC_ONLY: ProviderSettings = Object.freeze({
  primary: 'anthropic',
  secondary: null,
  failoverEnabled: false,
  failoverOn: new Set<FailoverKind>(),
  openai: {},
}) as ProviderSettings;

/** Base anterior a 0056 sin clave de Anthropic: todo a OpenAI (GPT-6 Luna), como en la 6.0.0. */
export const OPENAI_ONLY: ProviderSettings = Object.freeze({
  primary: 'openai',
  secondary: null,
  failoverEnabled: false,
  failoverOn: new Set<FailoverKind>(),
  openai: Object.fromEntries(MODEL_KEYS.map((key) => [key, {
    model: 'gpt-6-luna',
    efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' },
  }])) as Record<ModelKey, OpenAITier>,
}) as ProviderSettings;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function provider(value: unknown): Provider | null {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value) ? (value as Provider) : null;
}

function openaiEffort(value: unknown): OpenAIEffort | null {
  return typeof value === 'string' && (OPENAI_EFFORTS as readonly string[]).includes(value) ? (value as OpenAIEffort) : null;
}

function tier(raw: unknown): OpenAITier | null {
  if (!isObject(raw) || typeof raw.model !== 'string' || !OPENAI_MODEL_PATTERN.test(raw.model)) return null;
  const efforts: Record<string, unknown> = isObject(raw.efforts) ? raw.efforts : {};
  const map = {} as Record<Effort, OpenAIEffort | null>;
  for (const effort of EFFORTS) map[effort] = openaiEffort(efforts[effort]);
  return { model: raw.model, efforts: map };
}

/**
 * Normaliza el JSON de ai_provider_settings(). null si no tiene la forma esperada. Los tipos de falla que el
 * código no conoce se ignoran; un modelo de OpenAI con un id inválido se descarta.
 */
export function parseProviderSettings(raw: unknown): ProviderSettings | null {
  if (!isObject(raw)) return null;
  const primary = provider(raw.primary);
  if (!primary) return null;
  const rawSecondary = raw.secondary === null || raw.secondary === undefined ? null : provider(raw.secondary);
  if (raw.secondary !== null && raw.secondary !== undefined && !rawSecondary) return null;
  const secondary = rawSecondary && rawSecondary !== primary ? rawSecondary : null;
  const failoverOn = new Set<FailoverKind>();
  if (Array.isArray(raw.failoverOn)) {
    for (const kind of raw.failoverOn) {
      if (typeof kind === 'string' && (FAILOVER_KINDS as readonly string[]).includes(kind)) failoverOn.add(kind as FailoverKind);
    }
  }
  const openai: Partial<Record<ModelKey, OpenAITier>> = {};
  const tiers: Record<string, unknown> = isObject(raw.openai) ? raw.openai : {};
  for (const key of MODEL_KEYS) {
    const mapped = tier(tiers[key]);
    if (mapped) openai[key] = mapped;
  }
  return { primary, secondary, failoverEnabled: raw.failoverEnabled === true && secondary !== null, failoverOn, openai };
}

/** Configuración por defecto de 0011 (para las pruebas y la documentación). */
export function defaultSettings(openai: Partial<Record<ModelKey, OpenAITier>>): ProviderSettings {
  return { primary: 'anthropic', secondary: 'openai', failoverEnabled: true, failoverOn: new Set(DEFAULT_FAILOVER_ON), openai };
}

/**
 * Tabla de decisión del respaldo: código de error (errors.ts) -> tipo de falla. null = nunca pasa al otro
 * proveedor: un pedido mal armado (400) lo rechazaría igual, y una cancelación del launcher no es una falla.
 * El rechazo de la IA no es un error (llega como stop_reason "refusal") y tampoco pasa al otro proveedor.
 */
const KIND_BY_CODE: Readonly<Record<string, FailoverKind>> = {
  upstream_rate_limited: 'rate_limited',
  upstream_overloaded: 'overloaded',
  upstream_unavailable: 'unavailable',
  upstream_timeout: 'timeout',
  upstream_network: 'network',
  upstream_billing: 'billing',
  upstream_auth: 'auth',
  upstream_permission: 'permission',
  upstream_config: 'config',
  upstream_model: 'model',
  not_configured: 'not_configured',
  upstream_error: 'unknown',
};

export function failoverKind(code: string): FailoverKind | null {
  return Object.prototype.hasOwnProperty.call(KIND_BY_CODE, code) ? KIND_BY_CODE[code] : null;
}

/** Modelo de cada proveedor para una llamada (null: ese proveedor no la puede atender). */
export interface CallTargets {
  /** Id de la API de Anthropic. */
  anthropic: string | null;
  /** Id de la API de OpenAI y su reasoning.effort (null: no se manda). */
  openai: { model: string; effort: OpenAIEffort | null } | null;
}

/** Lo que hace falta de ai_register_turn (quota.ts TurnCheck cumple esta forma). */
export interface TargetSource {
  provider: Provider | null;
  model: ModelKey | null;
  modelId: string | null;
  models: { anthropic: string | null; openai: string | null };
  effort: Effort | null;
  openaiEffort?: OpenAIEffort | null;
}

/**
 * Modelos de la llamada:
 * - Con 0056 (hay `provider`): los de `models` (el del proveedor de la llamada es modelId) y el esfuerzo de OpenAI de
 *   openaiEffort. Si la base no manda openaiEffort, se usa la traducción de ai_tier_fallbacks (si hay).
 * - Sin `provider` (base anterior): modelId es de Anthropic y el de OpenAI sale de ai_tier_fallbacks.
 */
export function callTargets(check: TargetSource, settings: ProviderSettings): CallTargets {
  const tier = check.model ? settings.openai[check.model] : undefined;
  const tierEffort = tier && check.effort ? tier.efforts[check.effort] : null;
  if (!check.provider) {
    return { anthropic: check.modelId, openai: tier ? { model: tier.model, effort: tierEffort } : null };
  }
  const openaiModel = check.models.openai;
  const effort = check.openaiEffort !== undefined ? check.openaiEffort : tierEffort;
  return { anthropic: check.models.anthropic, openai: openaiModel ? { model: openaiModel, effort } : null };
}

/** Un intento con un proveedor, con el modelo (y para OpenAI el esfuerzo) que corre. */
export type Attempt = { provider: 'anthropic'; model: string } | { provider: 'openai'; model: string; effort: OpenAIEffort | null };

export interface AttemptPlan {
  /** En orden: el principal (si puede atender) y después el secundario (si el respaldo lo permite). */
  attempts: Attempt[];
  /** El principal no puede atender (sin clave o sin modelo para esta llamada) y se pasa directo al secundario. */
  primarySkipped: boolean;
}

/** Qué proveedores tienen clave (index.ts: Vault o la variable de entorno). */
export interface Readiness {
  anthropic: boolean;
  openai: boolean;
}

export function otherProvider(p: Provider): Provider {
  return p === 'anthropic' ? 'openai' : 'anthropic';
}

function attemptFor(p: Provider, ready: Readiness, targets: CallTargets): Attempt | null {
  if (!ready[p]) return null;
  if (p === 'anthropic') return targets.anthropic ? { provider: 'anthropic', model: targets.anthropic } : null;
  return targets.openai ? { provider: 'openai', model: targets.openai.model, effort: targets.openai.effort } : null;
}

/**
 * Proveedores que se prueban para una llamada, empezando por `primary` (el del saldo que la paga, o el principal de
 * ai_provider_settings con una base anterior a 0056).
 * - El principal va primero si tiene clave y un modelo para la llamada.
 * - El otro va después solo con el respaldo activado (failoverEnabled); se usa si el principal falla con un tipo
 *   de falla de failoverOn (lo decide el handler).
 * - Si el principal no puede atender, se pasa directo al otro solo si failoverOn incluye 'not_configured'. Si no,
 *   no hay intentos y el handler responde 503 not_configured.
 */
export function planAttempts(primary: Provider, settings: ProviderSettings, ready: Readiness, targets: CallTargets): AttemptPlan {
  const attempts: Attempt[] = [];
  const first = attemptFor(primary, ready, targets);
  if (first) attempts.push(first);
  const second = settings.failoverEnabled ? attemptFor(otherProvider(primary), ready, targets) : null;
  if (second && (first || settings.failoverOn.has('not_configured'))) attempts.push(second);
  return { attempts, primarySkipped: !first };
}
