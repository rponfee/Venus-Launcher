// La tabla de planes del dueño del proyecto y los precios de lista de los modelos (octubre de 2026).
// Es la fuente de verdad de las pruebas: migration.test.ts revisa que la carga de 0008_ai_plans.sql sea
// exactamente esto y fake-db.ts arranca con estos mismos datos.

export type Effort = 'low' | 'medium' | 'high';

export interface OwnerPlanModel {
  model: string;
  efforts: Effort[];
  daily: number;
  weekly: number;
  sort: number;
}

export interface OwnerPlan {
  id: string;
  name: string;
  /** Modelo de la columna vieja ai_plans.model (sin uso; solo para que la carga sea legible). */
  legacyModel: string;
  priceUsd: number;
  budgetUsd: number;
  maxTokens: number;
  maxCallsPerTurn: number;
  rpm: number;
  sort: number;
  models: OwnerPlanModel[];
}

export interface Tier {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelPrice extends Tier {
  id: string;
  modelId: string;
  label: string;
  /** Tarifa de contexto largo: se aplica si entrada + lectura + escritura de caché de un pedido pasa el umbral. */
  long: (Tier & { threshold: number }) | null;
  fallback: boolean;
  sort: number;
  active: boolean;
  /** ai_models.provider (0011). Sin el campo: 'anthropic' (las filas de 0008). */
  provider?: 'anthropic' | 'openai';
}

const ALL: Effort[] = ['low', 'medium', 'high'];
const LOW_MEDIUM: Effort[] = ['low', 'medium'];

export const OWNER_PLANS: OwnerPlan[] = [
  {
    id: 'go', name: 'Go', legacyModel: 'claude-haiku-5-5', priceUsd: 3.5, budgetUsd: 1.5, maxTokens: 8000, maxCallsPerTurn: 30, rpm: 30, sort: 10,
    models: [{ model: 'haiku', efforts: LOW_MEDIUM, daily: 35, weekly: 170, sort: 10 }],
  },
  {
    id: 'pro', name: 'Pro', legacyModel: 'claude-sonnet-5-5', priceUsd: 9.25, budgetUsd: 5, maxTokens: 16000, maxCallsPerTurn: 40, rpm: 40, sort: 20,
    models: [
      { model: 'haiku', efforts: ALL, daily: 25, weekly: 115, sort: 10 },
      { model: 'sonnet', efforts: LOW_MEDIUM, daily: 5, weekly: 20, sort: 20 },
    ],
  },
  {
    id: 'super', name: 'Super', legacyModel: 'claude-sonnet-5-5', priceUsd: 13.5, budgetUsd: 7, maxTokens: 16000, maxCallsPerTurn: 40, rpm: 40, sort: 30,
    models: [
      { model: 'haiku', efforts: ALL, daily: 25, weekly: 115, sort: 10 },
      { model: 'sonnet', efforts: LOW_MEDIUM, daily: 6, weekly: 30, sort: 20 },
    ],
  },
  {
    id: 'ultra', name: 'Ultra', legacyModel: 'claude-sonnet-5-5', priceUsd: 25.5, budgetUsd: 12, maxTokens: 16000, maxCallsPerTurn: 60, rpm: 60, sort: 40,
    models: [
      { model: 'haiku', efforts: ALL, daily: 25, weekly: 115, sort: 10 },
      { model: 'sonnet', efforts: ALL, daily: 8, weekly: 40, sort: 20 },
    ],
  },
  {
    id: 'max', name: 'Max', legacyModel: 'claude-opus-5-5', priceUsd: 36.5, budgetUsd: 19, maxTokens: 16000, maxCallsPerTurn: 60, rpm: 60, sort: 50,
    models: [
      { model: 'haiku', efforts: ALL, daily: 25, weekly: 115, sort: 10 },
      { model: 'sonnet', efforts: ALL, daily: 8, weekly: 40, sort: 20 },
      { model: 'opus', efforts: LOW_MEDIUM, daily: 4, weekly: 20, sort: 30 },
    ],
  },
  {
    id: 'supreme', name: 'Supreme', legacyModel: 'claude-opus-5-5', priceUsd: 42.5, budgetUsd: 23, maxTokens: 16000, maxCallsPerTurn: 60, rpm: 60, sort: 60,
    models: [
      { model: 'haiku', efforts: ALL, daily: 25, weekly: 115, sort: 10 },
      { model: 'sonnet', efforts: ALL, daily: 10, weekly: 50, sort: 20 },
      { model: 'opus', efforts: ALL, daily: 4, weekly: 20, sort: 30 },
    ],
  },
];

export const MODEL_PRICES: ModelPrice[] = [
  // Haiku 5.5: la caché no está publicada en nuestras referencias (0,01 y 0,125 son estimados, igual que
  // la caché de la tarifa de más de 100K tokens).
  {
    id: 'haiku', modelId: 'claude-haiku-5-5', label: 'Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    long: { threshold: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }, fallback: false, sort: 10, active: true,
  },
  { id: 'sonnet', modelId: 'claude-sonnet-5-5', label: 'Sonnet 5.5', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, long: null, fallback: true, sort: 20, active: true },
  { id: 'opus', modelId: 'claude-opus-5-5', label: 'Opus 5.5', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, long: null, fallback: true, sort: 30, active: true },
  // Solo precio: modelos en los que la API reintenta un pedido rechazado (fallbacks: "default").
  { id: 'opus-5', modelId: 'claude-opus-5', label: 'Opus 5 (respaldo)', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, long: null, fallback: false, sort: 90, active: false },
  { id: 'opus-4-8', modelId: 'claude-opus-4-8', label: 'Opus 4.8 (respaldo)', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, long: null, fallback: false, sort: 91, active: false },
  { id: 'sonnet-5', modelId: 'claude-sonnet-5', label: 'Sonnet 5 (respaldo)', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, long: null, fallback: false, sort: 92, active: false },
];

// ---------- 0011: OpenAI como proveedor secundario ----------

/**
 * Precios de lista de OpenAI (nivel Standard, octubre de 2026, USD por millón de tokens) que carga
 * 0011_ai_providers.sql: entrada, salida, entrada en caché, escritura de caché de 30 minutos y la tarifa de más
 * de 272.000 tokens de entrada (el doble la entrada y la caché, 1,5 veces la salida).
 * Fuentes: https://developers.openai.com/api/docs/pricing y https://developers.openai.com/api/docs/models/<modelo>.
 */
export const OPENAI_PRICES: ModelPrice[] = [
  {
    id: 'gpt-6-luna', modelId: 'gpt-6-luna', label: 'GPT-6 Luna (respaldo)', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    long: { threshold: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }, fallback: false, sort: 110, active: false, provider: 'openai',
  },
  {
    id: 'gpt-6-1-terra', modelId: 'gpt-6.1-terra', label: 'GPT-6.1 Terra (respaldo)', input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25,
    long: { threshold: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }, fallback: false, sort: 120, active: false, provider: 'openai',
  },
  {
    id: 'gpt-6-1-sol', modelId: 'gpt-6.1-sol', label: 'GPT-6.1 Sol (respaldo)', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
    long: { threshold: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }, fallback: false, sort: 130, active: false, provider: 'openai',
  },
  {
    id: 'gpt-6-astra', modelId: 'gpt-6-astra', label: 'GPT-6 Astra (respaldo)', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5,
    long: { threshold: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }, fallback: false, sort: 140, active: false, provider: 'openai',
  },
];

export interface TierFallback {
  tier: string;
  /** ai_models.id del modelo de OpenAI. */
  model: string;
  efforts: { low: string | null; medium: string | null; high: string | null };
}

/** Modelo de OpenAI de cada modelo de Venus (ai_tier_fallbacks de 0011). */
export const TIER_FALLBACKS: TierFallback[] = [
  { tier: 'haiku', model: 'gpt-6-luna', efforts: { low: 'low', medium: 'medium', high: 'high' } },
  { tier: 'sonnet', model: 'gpt-6-1-sol', efforts: { low: 'low', medium: 'medium', high: 'high' } },
  { tier: 'opus', model: 'gpt-6-astra', efforts: { low: 'low', medium: 'medium', high: 'high' } },
];
