// Plan, cuota y uso: lectura de lo que devuelven las funciones SQL de 0008_ai_plans.sql (y 0013), recorte de
// max_tokens, uso por intento (para cobrar cada intento con el precio del modelo que lo corrió), el uso estimado
// de un intento cortado y las respuestas de rechazo del protocolo. Sin dependencias externas.
import { ANTHROPIC_MODEL_PATTERN, EFFORTS, FALLBACK_MODELS, MAX_OUTPUT_TOKENS, MODEL_KEYS } from './config.ts';
import type { Effort, ModelKey } from './config.ts';

export interface Counter {
  used: number;
  limit: number;
}

/** Un modelo del plan del usuario, con su cupo de preguntas. */
export interface ModelQuota {
  id: ModelKey;
  /** Id del modelo en la API de Anthropic (por ejemplo claude-haiku-5-5). */
  model: string;
  label: string;
  efforts: Effort[];
  daily: Counter;
  weekly: Counter;
}

/** Estado del plan que recibe el launcher (QuotaV2, forma fija del protocolo). */
export interface Quota {
  plan: string | null;
  planName: string | null;
  priceUsd: number | null;
  status: 'active' | 'trialing' | 'none';
  models: ModelQuota[];
  budget: { usedUsd: number; limitUsd: number };
  resets: { daily: string; weekly: string; monthly: string };
  timezone: string;
  lastModel?: ModelKey;
}

/** Un plan del catálogo (para mostrar los planes disponibles). */
export interface CatalogPlan {
  id: string;
  name: string;
  priceUsd: number;
  budgetUsd: number;
  models: { id: ModelKey; label: string; efforts: Effort[]; daily: number; weekly: number }[];
}

/** Por qué ai_register_turn rechazó la llamada. */
export type DenyReason = 'noplan' | 'model' | 'effort' | 'turn_model' | 'rate' | 'budget' | 'turn' | 'daily' | 'weekly';
const REASONS: ReadonlySet<string> = new Set(['noplan', 'model', 'effort', 'turn_model', 'rate', 'budget', 'turn', 'daily', 'weekly']);

/** Resultado de ai_register_turn. */
export interface TurnCheck {
  allowed: boolean;
  reason: DenyReason | null;
  /** Modelo de la pregunta (ai_models.id): el pedido, el de la pregunta abierta o el primero del plan. */
  model: ModelKey | null;
  /** Id del modelo en la API de Anthropic (solo si se permite). Sale de ai_models, nunca del cliente. */
  modelId: string | null;
  /** Si se manda fallbacks: "default" (la base lo permite y el modelo está en FALLBACK_MODELS). */
  fallback: boolean;
  /** Esfuerzo final (el pedido o el predeterminado del plan). */
  effort: Effort | null;
  /** true si este pedido abrió una pregunta nueva (se puede devolver si la IA falla). */
  counted: boolean;
  maxTokensPerRequest: number;
  quota: Quota;
}

/** Tokens de UN intento de la API, con el modelo que lo corrió (ai_add_usage lo cobra con ese precio). */
export interface UsageLine {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Resultado de ai_add_usage. */
export interface UsageResult {
  quota: Quota;
  costUsd: number;
  /** Modelos que corrieron sin precio en ai_models (se cobraron con el precio del modelo de la pregunta). */
  unpriced: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Entero >= 0 (los contadores y tokens). */
function count(value: unknown): number {
  return Math.min(Math.floor(toNumber(value)), Number.MAX_SAFE_INTEGER);
}

/** Dólares >= 0 redondeados a `decimals`. */
function usd(value: unknown, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(toNumber(value) * factor) / factor;
}

function text(value: unknown, fallback: string, max = 100): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

function iso(value: unknown): string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : '';
}

function modelKey(value: unknown): ModelKey | null {
  return typeof value === 'string' && (MODEL_KEYS as readonly string[]).includes(value) ? (value as ModelKey) : null;
}

function anthropicModel(value: unknown): string | null {
  return typeof value === 'string' && ANTHROPIC_MODEL_PATTERN.test(value) ? value : null;
}

/** Esfuerzos válidos, sin repetir y en orden fijo (low, medium, high). */
function effortList(value: unknown): Effort[] {
  const list = Array.isArray(value) ? value : [];
  return EFFORTS.filter((effort) => list.includes(effort));
}

function counter(value: unknown): Counter {
  const raw: Record<string, unknown> = isObject(value) ? value : {};
  return { used: count(raw.used), limit: count(raw.limit) };
}

function modelQuota(raw: unknown): ModelQuota | null {
  if (!isObject(raw)) return null;
  const id = modelKey(raw.id);
  const model = anthropicModel(raw.model);
  if (!id || !model) return null;
  return {
    id,
    model,
    label: text(raw.label, id, 40),
    efforts: effortList(raw.efforts),
    daily: counter(raw.daily),
    weekly: counter(raw.weekly),
  };
}

/**
 * Normaliza el JSON de ai_quota_status a QuotaV2 (o null si no tiene esa forma: por ejemplo, la cuota
 * de 0007, que no trae `models` ni `budget`). Los modelos que el protocolo no conoce se omiten.
 */
export function normalizeQuota(raw: unknown): Quota | null {
  if (!isObject(raw)) return null;
  const rawModels = Array.isArray(raw.models) ? raw.models : null;
  const budget = isObject(raw.budget) ? raw.budget : null;
  if (!rawModels || !budget) return null;
  const plan = typeof raw.plan === 'string' && raw.plan.trim() ? raw.plan.trim().slice(0, 32) : null;
  const models = plan ? rawModels.map(modelQuota).filter((m): m is ModelQuota => m !== null) : [];
  const resets: Record<string, unknown> = isObject(raw.resets) ? raw.resets : {};
  const status = !plan ? 'none' : raw.status === 'trialing' ? 'trialing' : 'active';
  const quota: Quota = {
    plan,
    planName: plan ? text(raw.planName, plan, 40) : null,
    priceUsd: plan ? usd(raw.priceUsd, 2) : null,
    status,
    models,
    budget: { usedUsd: usd(budget.usedUsd, 4), limitUsd: plan ? usd(budget.limitUsd, 2) : 0 },
    resets: { daily: iso(resets.daily), weekly: iso(resets.weekly), monthly: iso(resets.monthly) },
    timezone: text(raw.timezone, '', 64),
  };
  const last = modelKey(raw.lastModel);
  if (last && models.some((m) => m.id === last)) quota.lastModel = last;
  return quota;
}

/** Normaliza el JSON de ai_catalog. Una respuesta rara da una lista vacía. */
export function normalizeCatalog(raw: unknown): CatalogPlan[] {
  if (!Array.isArray(raw)) return [];
  const plans: CatalogPlan[] = [];
  for (const item of raw) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id.trim()) continue;
    const id = item.id.trim().slice(0, 32);
    const models: CatalogPlan['models'] = [];
    for (const m of Array.isArray(item.models) ? item.models : []) {
      const key = isObject(m) ? modelKey(m.id) : null;
      if (!isObject(m) || !key) continue;
      models.push({ id: key, label: text(m.label, key, 40), efforts: effortList(m.efforts), daily: count(m.daily), weekly: count(m.weekly) });
    }
    plans.push({ id, name: text(item.name, id, 40), priceUsd: usd(item.priceUsd, 2), budgetUsd: usd(item.budgetUsd, 2), models });
  }
  return plans;
}

/**
 * Lee el JSON de ai_register_turn. null si la respuesta no tiene la forma esperada (también si permite la
 * llamada sin un modelo o un esfuerzo válidos, o si rechaza con un motivo desconocido).
 */
export function parseTurnCheck(raw: unknown): TurnCheck | null {
  if (!isObject(raw) || typeof raw.allowed !== 'boolean') return null;
  const quota = normalizeQuota(raw.quota);
  if (!quota) return null;
  const model = modelKey(raw.model);
  const effort = typeof raw.effort === 'string' && (EFFORTS as readonly string[]).includes(raw.effort) ? (raw.effort as Effort) : null;
  const maxTokensPerRequest = count(raw.maxTokensPerRequest);
  const reason = typeof raw.reason === 'string' && raw.reason ? raw.reason : null;

  if (raw.allowed === true && reason === null) {
    const modelId = anthropicModel(raw.modelId);
    if (!model || !modelId || !effort) return null;
    return {
      allowed: true,
      reason: null,
      model,
      modelId,
      fallback: raw.fallback === true && FALLBACK_MODELS.has(modelId),
      effort,
      counted: raw.counted === true,
      maxTokensPerRequest,
      quota,
    };
  }
  // Rechazo (o respuesta contradictoria: "allowed" con un motivo, que se trata como rechazo).
  if (!reason || !REASONS.has(reason)) return null;
  return {
    allowed: false,
    reason: reason as DenyReason,
    model,
    modelId: null,
    fallback: false,
    effort,
    counted: false,
    maxTokensPerRequest,
    quota,
  };
}

/** Lee el JSON de ai_add_usage (null si no trae una cuota válida). */
export function parseUsageResult(raw: unknown): UsageResult | null {
  if (!isObject(raw)) return null;
  const quota = normalizeQuota(raw.quota);
  if (!quota) return null;
  const unpriced = Array.isArray(raw.unpriced)
    ? raw.unpriced.filter((m): m is string => typeof m === 'string' && m.length > 0).map((m) => m.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64))
    : [];
  return { quota, costUsd: usd(raw.costUsd, 6), unpriced };
}

/** max_tokens final: lo que pidió el launcher, sin pasar el tope del plan ni MAX_OUTPUT_TOKENS. */
export function clampMaxTokens(requested: number | null | undefined, planMax: number | null | undefined): number {
  const plan = typeof planMax === 'number' && Number.isFinite(planMax) && planMax > 0 ? Math.floor(planMax) : MAX_OUTPUT_TOKENS;
  const cap = Math.min(plan, MAX_OUTPUT_TOKENS);
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return cap;
  return Math.max(1, Math.min(Math.floor(requested), cap));
}

function tokensOf(entry: Record<string, unknown>): Omit<UsageLine, 'model'> {
  return {
    input: count(entry.input_tokens),
    output: count(entry.output_tokens),
    cacheRead: count(entry.cache_read_input_tokens),
    cacheWrite: count(entry.cache_creation_input_tokens),
  };
}

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

/**
 * Uso de una respuesta de la API, intento por intento, con el modelo que corrió cada uno.
 * - Sin `usage.iterations`: un solo intento, del modelo que respondió (`servedModel`, o el pedido).
 * - Con `usage.iterations` (reintento en otro modelo): un renglón por intento. Cada intento dice su modelo;
 *   si no lo dice, es del modelo pedido (o del que respondió, si es el intento de respaldo).
 * El `usage` de arriba solo cubre el último intento: si por algún motivo supera la suma de los intentos,
 * la diferencia se suma al modelo que respondió (nunca se cuenta de menos).
 */
export function usageLines(usage: unknown, requestedModel: string, servedModel?: unknown): UsageLine[] {
  if (!isObject(usage)) return [];
  const served = anthropicModel(servedModel) ?? requestedModel;
  const top = tokensOf(usage);
  const iterations = Array.isArray(usage.iterations) ? usage.iterations.filter(isObject) : [];
  if (!iterations.length) return [{ model: served, ...top }];

  const lines: UsageLine[] = iterations.map((entry) => ({
    model: anthropicModel(entry.model) ?? (entry.type === 'fallback_message' ? served : requestedModel),
    ...tokensOf(entry),
  }));
  let target = [...lines].reverse().find((line) => line.model === served);
  for (const field of FIELDS) {
    const sum = lines.reduce((acc, line) => acc + line[field], 0);
    if (top[field] > sum) {
      if (!target) {
        target = { model: served, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        lines.push(target);
      }
      target[field] += top[field] - sum;
    }
  }
  return lines;
}

/**
 * Uso estimado de un intento que se cortó sin respuesta (plazo vencido, cancelación del launcher o conexión caída):
 * el proveedor pudo haberlo procesado y facturado, así que se cobra el peor caso. Todo el pedido como escritura de
 * caché (unos 3 caracteres por token, de más) y la salida entera (max_tokens).
 */
export function estimatedUsageLine(model: string, requestChars: number, maxTokens: number): UsageLine {
  return { model, input: 0, output: count(maxTokens), cacheRead: 0, cacheWrite: Math.ceil(count(requestChars) / 3) };
}

/** Identificador de turno para pedidos que no traen turn_id (cada uno cuenta como pregunta nueva). */
export function newTurnId(): string {
  return `srv-${crypto.randomUUID()}`;
}

/** Textos de los rechazos (el launcher puede traducirlos por `error` / `reason` / `code`). */
export const DENIAL_MESSAGES: Readonly<Record<DenyReason, string>> = {
  noplan: 'Tu cuenta no tiene un plan de IA activo. Elegí un plan para usar la IA.',
  model: 'Tu plan no incluye ese modelo de IA.',
  effort: 'Tu plan no permite ese nivel de esfuerzo con este modelo.',
  turn_model: 'Esta pregunta empezó con otro modelo. Para cambiar de modelo, hacé una pregunta nueva.',
  rate: 'Estás haciendo demasiados pedidos seguidos. Esperá un minuto y probá de nuevo.',
  budget: 'Se terminó el presupuesto de IA de tu plan para este mes.',
  turn: 'Esta pregunta llegó al máximo de pasos permitidos. Hacé una pregunta nueva para seguir.',
  daily: 'Llegaste al límite de preguntas de hoy con este modelo.',
  weekly: 'Llegaste al límite de preguntas de esta semana con este modelo.',
};

/**
 * Respuesta HTTP para una llamada rechazada por ai_register_turn:
 * - noplan: 402 { error: 'noplan', message, quota, plans } (el catálogo lo agrega el handler).
 * - model / effort: 403 { error: 'plan', reason, model, message, quota }.
 * - turn_model: 400 { error: 'bad_request', code: 'turn_model', message, quota }.
 * - daily / weekly / budget / turn / rate: 429 { error: 'quota', reason, model?, message, quota }.
 */
export function denialResponse(check: TurnCheck, plans: CatalogPlan[] = []): { status: number; body: Record<string, unknown> } {
  const reason: DenyReason = check.reason ?? 'noplan';
  const message = DENIAL_MESSAGES[reason];
  switch (reason) {
    case 'noplan':
      return { status: 402, body: { error: 'noplan', message, quota: check.quota, plans } };
    case 'model':
    case 'effort':
      return { status: 403, body: { error: 'plan', reason, model: check.model, message, quota: check.quota } };
    case 'turn_model':
      return { status: 400, body: { error: 'bad_request', code: 'turn_model', message, quota: check.quota } };
    default:
      return {
        status: 429,
        body: { error: 'quota', reason, ...(check.model ? { model: check.model } : {}), message, quota: check.quota },
      };
  }
}
