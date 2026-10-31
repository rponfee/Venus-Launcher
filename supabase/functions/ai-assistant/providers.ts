// Proveedores de la IA y respaldo: Anthropic (principal) y OpenAI (secundario).
// Lee la configuración que devuelve public.ai_provider_settings() (0011_ai_providers.sql), decide en qué orden
// se prueban los proveedores para una pregunta y si una falla pasa el pedido al otro proveedor.
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

/** Sin la migración 0011 o sin OPENAI_API_KEY: solo Anthropic, como antes. */
export const ANTHROPIC_ONLY: ProviderSettings = Object.freeze({
  primary: 'anthropic',
  secondary: null,
  failoverEnabled: false,
  failoverOn: new Set<FailoverKind>(),
  openai: {},
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

/** Un intento con un proveedor: Anthropic usa el modelo de la pregunta; OpenAI, el modelo que lo reemplaza. */
export type Attempt = { provider: 'anthropic' } | { provider: 'openai'; tier: OpenAITier };

export interface AttemptPlan {
  /** En orden: el principal (si puede atender) y después el secundario (si el respaldo lo permite). */
  attempts: Attempt[];
  /** El principal no puede atender (sin clave o sin modelo para esta pregunta) y se pasa directo al secundario. */
  primarySkipped: boolean;
}

export interface Readiness {
  anthropic: boolean;
  openai: boolean;
}

function attemptFor(p: Provider, settings: ProviderSettings, ready: Readiness, model: ModelKey | null): Attempt | null {
  if (p === 'anthropic') return ready.anthropic ? { provider: 'anthropic' } : null;
  if (!ready.openai) return null;
  if (model === null) {
    // Antes de saber el modelo de la pregunta: alcanza con que OpenAI tenga algún modelo configurado.
    const any = MODEL_KEYS.map((key) => settings.openai[key]).find((t): t is OpenAITier => Boolean(t));
    return any ? { provider: 'openai', tier: any } : null;
  }
  const mapped = settings.openai[model];
  return mapped ? { provider: 'openai', tier: mapped } : null;
}

/**
 * Proveedores que se prueban para una pregunta del modelo `model` (null: todavía no se sabe cuál).
 * - El principal va primero si tiene clave (y, si es OpenAI, un modelo para esa pregunta).
 * - El secundario va después solo con el respaldo activado; se usa si el principal falla con un tipo de
 *   falla de failoverOn (lo decide el handler).
 * - Si el principal no puede atender, se pasa directo al secundario solo si failoverOn incluye
 *   'not_configured' (por ejemplo, falta ANTHROPIC_API_KEY).
 */
export function planAttempts(settings: ProviderSettings, ready: Readiness, model: ModelKey | null): AttemptPlan {
  const attempts: Attempt[] = [];
  const first = attemptFor(settings.primary, settings, ready, model);
  if (first) attempts.push(first);
  const second =
    settings.failoverEnabled && settings.secondary && settings.secondary !== settings.primary
      ? attemptFor(settings.secondary, settings, ready, model)
      : null;
  if (second && (first || settings.failoverOn.has('not_configured'))) attempts.push(second);
  return { attempts, primarySkipped: !first };
}
