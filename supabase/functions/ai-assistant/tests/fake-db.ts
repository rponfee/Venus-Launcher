// Doble en memoria de las funciones SQL de 0008_ai_plans.sql, 0011_ai_providers.sql y 0013_ai_budget.sql que usa
// la Edge Function: ai_quota_status, ai_catalog, ai_register_turn (las dos versiones), ai_release_turn,
// ai_add_usage (el uso de OpenAI va a la fila de su modelo y cierra la llamada), ai_end_call y
// ai_provider_settings. Sigue el SQL paso a paso para probar el protocolo de punta a punta sin Postgres (planes,
// modelos, esfuerzos, cupos por día y por semana, presupuesto con su tope, llamadas en curso, preguntas atadas a su
// modelo, costos y proveedores). FakeDb.dual() replica además el contrato de 0056_ia_dos_motores.sql (diez planes de
// dos motores, un saldo por motor, cambio automático de saldo con `switched`, max_tokens recortado al saldo y el
// proveedor de cada llamada). NO prueba el SQL: si cambiás una función SQL, cambiá esta réplica también (y al revés).
import { DEFAULT_FAILOVER_ON } from '../config.ts';
import { DUAL_MODELS, DUAL_PLANS, DUAL_TIERS, MODEL_PRICES, OPENAI_PRICES, OWNER_PLANS, TIER_FALLBACKS } from './owner-plans.ts';
import type { Effort, ModelPrice, OwnerPlan, OwnerPlanModel, Tier, TierFallback } from './owner-plans.ts';

export const TIMEZONE = 'America/Argentina/Buenos_Aires';
/** Buenos Aires está en UTC-3 y no tiene horario de verano. */
const OFFSET_MS = -3 * 3600 * 1000;
const DAY_MS = 86400000;
const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high'];
/** 0013: llamadas en curso a la vez por usuario y cuándo vencen (ms desde la última). */
export const MAX_INFLIGHT = 3;
const INFLIGHT_TTL_MS = 150000;
/** 0013 (ai_call_reserve): tokens de entrada de la llamada más grande (400 KB a unos 3 caracteres por token). */
export const RESERVE_INPUT_TOKENS = 136534;

type Json = Record<string, unknown>;

export interface PlanRow extends OwnerPlan {
  active: boolean;
}

export interface SubscriptionRow {
  plan: string;
  status: string;
  periodEnd: Date | null;
  /** 0013: el tope del presupuesto solo vale con source 'stripe'. */
  source?: string;
  budgetCapUsd?: number | null;
  budgetCapUntil?: Date | null;
}

/** Fila de ai_rate: la ventana de la ráfaga y (0013) las llamadas en curso. */
export interface RateRow {
  windowStart: number;
  calls: number;
  inflight?: number;
  inflightAt?: number | null;
}

export interface UsageRow {
  questions: number;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** cost_usd numeric(12,6), guardado en millonésimas de dólar para no acumular errores de redondeo. */
  costMicros: number;
  updatedAt: number;
}

export interface TurnRow {
  model: string | null;
  calls: number;
}

function sqlError(code: string): Error {
  return Object.assign(new Error(`error de la base (${code})`), { code });
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function dayMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(day: string, n: number): string {
  return dayOf(dayMs(day) + n * DAY_MS);
}

/** Lunes de la semana de `day` (date_trunc('week', ...)). */
export function weekStart(day: string): string {
  const dow = new Date(dayMs(day)).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

function monthStart(day: string): string {
  return `${day.slice(0, 8)}01`;
}

function nextMonth(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}

/** Medianoche local de `day` en ISO UTC, como ai_iso(). */
function localMidnightIso(day: string): string {
  return new Date(dayMs(day) - OFFSET_MS).toISOString().replace('.000Z', 'Z');
}

/** Redondeo de numeric de Postgres (la mitad se aleja del cero) para enteros positivos en unidades `unit`. */
function roundUnits(value: number, unit: number): number {
  return Math.floor((value + unit / 2) / unit);
}

/** Precio por millón de tokens en diezmilésimas (los precios tienen hasta 4 decimales). */
function rate(value: number): number {
  return Math.round(value * 10000);
}

/**
 * ai_price_line: costo de UN pedido en 1e-10 USD (tokens x USD por millón = millonésimas de dólar;
 * por 1e4 para que sea entero). Con la tarifa de contexto largo si la entrada total pasa el umbral.
 */
export function priceUnits(price: ModelPrice, line: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const total = line.input + line.cacheRead + line.cacheWrite;
  const tier: Tier = price.long && total > price.long.threshold ? price.long : price;
  return (
    line.input * rate(tier.input) +
    line.output * rate(tier.output) +
    line.cacheRead * rate(tier.cacheRead) +
    line.cacheWrite * rate(tier.cacheWrite)
  );
}

function effortList(efforts: Effort[]): Effort[] {
  return EFFORT_ORDER.filter((e) => efforts.includes(e));
}

function defaultEffort(efforts: Effort[]): Effort | null {
  if (efforts.includes('medium')) return 'medium';
  if (efforts.includes('low')) return 'low';
  if (efforts.includes('high')) return 'high';
  return null;
}

/** ai_token_count: número entero entre 0 y 100 millones; cualquier otra cosa es 0. */
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 0), 100000000) : 0;
}

/** Fila de ai_provider_config (0011). */
export interface ProviderConfigRow {
  primary: string;
  secondary: string | null;
  failoverEnabled: boolean;
  failoverOn: string[];
}

export class FakeDb {
  /** Miércoles 28 de octubre de 2026, 12:00 en Buenos Aires. */
  now = new Date('2026-10-28T15:00:00Z');
  models = new Map<string, ModelPrice>(
    [...MODEL_PRICES, ...OPENAI_PRICES].map((m) => [m.id, { ...m, long: m.long ? { ...m.long } : null }]),
  );
  /** ai_provider_config con los valores por defecto de 0011 (null = sin la fila). */
  providerConfig: ProviderConfigRow | null = { primary: 'anthropic', secondary: 'openai', failoverEnabled: true, failoverOn: [...DEFAULT_FAILOVER_ON] };
  /** ai_tier_fallbacks de 0011. */
  tierFallbacks = new Map<string, TierFallback & { active: boolean }>(
    TIER_FALLBACKS.map((f) => [f.tier, { ...f, efforts: { ...f.efforts }, active: true }]),
  );
  plans = new Map<string, PlanRow>(
    OWNER_PLANS.map((p) => [p.id, { ...p, active: true, models: p.models.map((m) => ({ ...m, efforts: [...m.efforts] })) }]),
  );
  subs = new Map<string, SubscriptionRow>();
  usage = new Map<string, UsageRow>();
  turns = new Map<string, TurnRow>();
  rate = new Map<string, RateRow>();
  private tick = 0;

  subscribe(user: string, plan: string, status = 'active', periodEnd: Date | null = null): void {
    this.subs.set(user, { plan, status, periodEnd });
  }

  /** Para preparar escenarios: el tope que deja billing_apply_subscription al subir de plan (0013). */
  capBudget(user: string, usd: number, until: Date): void {
    const sub = this.subs.get(user);
    if (sub) Object.assign(sub, { source: 'stripe', budgetCapUsd: usd, budgetCapUntil: until });
  }

  /** Llamadas en curso que no vencieron. */
  inflight(user: string): number {
    const r = this.rate.get(user);
    return r && r.inflightAt != null && r.inflightAt > this.now.getTime() - INFLIGHT_TTL_MS ? r.inflight ?? 0 : 0;
  }

  /** Día local de ai_today(). */
  today(): string {
    return dayOf(this.now.getTime() + OFFSET_MS);
  }

  usageRow(user: string, day: string, model: string): UsageRow | undefined {
    return this.usage.get(`${user}|${day}|${model}`);
  }

  turnRow(user: string, turn: string, day: string): TurnRow | undefined {
    return this.turns.get(`${user}|${turn}|${day}`);
  }

  private ensureUsage(user: string, day: string, model: string): UsageRow {
    const key = `${user}|${day}|${model}`;
    let row = this.usage.get(key);
    if (!row) {
      row = { questions: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costMicros: 0, updatedAt: 0 };
      this.usage.set(key, row);
    }
    return row;
  }

  /** Para preparar escenarios: preguntas ya hechas en un día. */
  addQuestions(user: string, day: string, model: string, n: number): void {
    const row = this.ensureUsage(user, day, model);
    row.questions += n;
    row.updatedAt = ++this.tick;
  }

  /** Para preparar escenarios: gasto ya hecho en un día. */
  addCost(user: string, day: string, model: string, usd: number): void {
    const row = this.ensureUsage(user, day, model);
    row.costMicros += Math.round(usd * 1e6);
    row.updatedAt = ++this.tick;
  }

  /** Llamada como la hace PostgREST: argumentos y resultado pasan por JSON. */
  async rpc(name: string, args: Json): Promise<unknown> {
    const input = JSON.parse(JSON.stringify(args ?? {})) as Json;
    return JSON.parse(JSON.stringify(this.call(name, input)));
  }

  private call(name: string, args: Json): unknown {
    const keys = Object.keys(args).sort().join(',');
    switch (name) {
      case 'ai_quota_status':
        return this.quotaStatus(String(args.p_user));
      case 'ai_catalog':
        return this.catalog();
      case 'ai_register_turn':
        // Dos versiones (PostgREST elige por los nombres de los argumentos).
        // 0056: dos parámetros opcionales al final (la firma de cuatro sigue sirviendo).
        if (keys === 'p_effort,p_model,p_turn,p_user' || keys === 'p_effort,p_input_bytes,p_max_tokens,p_model,p_turn,p_user') {
          if (this.dual) return this.registerDual(args);
          return this.registerTurn(args.p_user, args.p_turn, args.p_model ?? null, args.p_effort ?? null);
        }
        if (keys === 'p_turn,p_user') return this.legacyRegister(String(args.p_user));
        throw sqlError('PGRST202');
      case 'ai_release_turn':
        return this.releaseTurn(args.p_user, args.p_turn);
      case 'ai_add_usage':
        return this.addUsage(args.p_user, args.p_model, args.p_usage, args.p_call ?? null);
      case 'ai_end_call':
        return this.endCall(args.p_user, args.p_call ?? null);
      case 'ai_provider_settings':
        return this.providerSettings();
      case 'ai_anthropic_key':
        return this.vault.anthropic;
      case 'ai_openai_key':
        return this.vault.openai;
      default:
        throw sqlError('PGRST202');
    }
  }

  /** ai_provider_settings (0011). */
  providerSettings(): Json {
    const c = this.providerConfig;
    const openai: Json = {};
    for (const [tier, f] of this.tierFallbacks) {
      const m = this.models.get(f.model);
      if (!f.active || !m || m.provider !== 'openai') continue;
      openai[tier] = { model: m.modelId, efforts: { low: f.efforts.low, medium: f.efforts.medium, high: f.efforts.high } };
    }
    return {
      primary: c?.primary ?? 'anthropic',
      secondary: c ? c.secondary : null,
      failoverEnabled: c?.failoverEnabled ?? false,
      failoverOn: c ? [...c.failoverOn] : [],
      openai,
    };
  }

  /** ai_effective_plan. */
  effectivePlan(user: string): string | null {
    const sub = this.subs.get(user);
    if (!sub) return null;
    const plan = this.plans.get(sub.plan);
    if (!plan || !plan.active) return null;
    if (sub.status !== 'active' && sub.status !== 'trialing') return null;
    if (sub.periodEnd && sub.periodEnd.getTime() <= this.now.getTime()) return null;
    return plan.id;
  }

  /** Modelos activos del plan, en orden (pm.sort, m.sort, m.id). */
  private planModels(planId: string): OwnerPlanModel[] {
    const plan = this.plans.get(planId);
    if (!plan) return [];
    return plan.models
      .filter((pm) => this.models.get(pm.model)?.active)
      .sort((a, b) => a.sort - b.sort || (this.models.get(a.model)?.sort ?? 0) - (this.models.get(b.model)?.sort ?? 0) || (a.model < b.model ? -1 : 1));
  }

  private monthMicros(user: string): number {
    const month = monthStart(this.today());
    let total = 0;
    for (const [key, row] of this.usage) {
      const [u, day] = key.split('|');
      if (u === user && day >= month) total += row.costMicros;
    }
    return total;
  }

  /** ai_budget_limit (0013): el presupuesto del plan o, con un tope vigente de Stripe, el menor de los dos. */
  budgetLimit(user: string, plan: PlanRow): number {
    const sub = this.subs.get(user);
    const cap = sub?.budgetCapUsd;
    const capped = sub?.source === 'stripe' && cap != null && sub.budgetCapUntil != null && sub.budgetCapUntil.getTime() > this.now.getTime();
    return capped ? Math.min(plan.budgetUsd, cap) : plan.budgetUsd;
  }

  /**
   * ai_call_reserve (0013), en millonésimas de dólar: RESERVE_INPUT_TOKENS de escritura de caché y `maxTokens` de
   * salida, con el precio del modelo o el de su respaldo activo en OpenAI (el más caro).
   */
  callReserveMicros(model: string, maxTokens: number): number {
    const fallback = this.tierFallbacks.get(model);
    const ids = fallback?.active ? [model, fallback.model] : [model];
    let units = 0;
    for (const id of ids) {
      const price = this.models.get(id);
      if (price) units = Math.max(units, priceUnits(price, { input: 0, output: maxTokens, cacheRead: 0, cacheWrite: RESERVE_INPUT_TOKENS }));
    }
    return units / 10000;
  }

  /** Cierre de una llamada (ai_end_call y ai_add_usage de 0013): deja de estar en curso. */
  private closeCall(user: string): void {
    const r = this.rate.get(user);
    if (!r || !r.inflight) return;
    r.inflight = this.inflight(user) > 0 ? r.inflight - 1 : 0;
  }

  /** ai_quota_status. */
  quotaStatus(user: string): Json {
    if (this.dual) return this.quotaDual(user);
    const today = this.today();
    const week = weekStart(today);
    const month = monthStart(today);
    const planId = this.effectivePlan(user);
    const plan = planId ? this.plans.get(planId) ?? null : null;
    let status = 'none';
    let models: Json[] = [];
    let lastModel: string | null = null;
    if (planId && plan) {
      status = this.subs.get(user)?.status === 'trialing' ? 'trialing' : 'active';
      const offered = this.planModels(planId);
      models = offered.map((pm) => {
        const m = this.models.get(pm.model) as ModelPrice;
        let usedToday = 0;
        let usedWeek = 0;
        for (const [key, row] of this.usage) {
          const [u, day, model] = key.split('|');
          if (u !== user || model !== pm.model || day < week) continue;
          usedWeek += row.questions;
          if (day === today) usedToday += row.questions;
        }
        return {
          id: m.id,
          model: m.modelId,
          label: m.label,
          efforts: effortList(pm.efforts),
          daily: { used: usedToday, limit: pm.daily },
          weekly: { used: usedWeek, limit: pm.weekly },
        };
      });
      const ids = new Set(offered.map((pm) => pm.model));
      let best: { day: string; updatedAt: number; model: string } | null = null;
      for (const [key, row] of this.usage) {
        const [u, day, model] = key.split('|');
        if (u !== user || !ids.has(model)) continue;
        if (!best || day > best.day || (day === best.day && row.updatedAt > best.updatedAt)) best = { day, updatedAt: row.updatedAt, model };
      }
      lastModel = best?.model ?? null;
    }
    return {
      plan: planId,
      planName: plan?.name ?? null,
      priceUsd: plan ? plan.priceUsd : null,
      status,
      models,
      budget: { usedUsd: roundUnits(this.monthMicros(user), 100) / 10000, limitUsd: plan ? this.budgetLimit(user, plan) : 0 },
      resets: {
        daily: localMidnightIso(addDays(today, 1)),
        weekly: localMidnightIso(addDays(week, 7)),
        monthly: localMidnightIso(nextMonth(month)),
      },
      timezone: TIMEZONE,
      lastModel,
    };
  }

  /** ai_catalog. */
  catalog(): Json[] {
    if (this.dual) return this.catalogDual();
    return [...this.plans.values()]
      .filter((p) => p.active)
      .sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1))
      .map((p) => ({
        id: p.id,
        name: p.name,
        priceUsd: p.priceUsd,
        budgetUsd: p.budgetUsd,
        models: this.planModels(p.id).map((pm) => {
          const m = this.models.get(pm.model) as ModelPrice;
          return { id: m.id, label: m.label, efforts: effortList(pm.efforts), daily: pm.daily, weekly: pm.weekly };
        }),
      }));
  }

  /** ai_register_turn(p_user, p_turn, p_model, p_effort), paso por paso como en el SQL. */
  registerTurn(userArg: unknown, turnArg: unknown, modelArg: unknown, effortArg: unknown): Json {
    if (typeof userArg !== 'string' || !userArg || typeof turnArg !== 'string' || turnArg.length < 1 || turnArg.length > 100) {
      throw sqlError('22023');
    }
    if (modelArg !== null && (typeof modelArg !== 'string' || modelArg.length < 1 || modelArg.length > 32)) throw sqlError('22023');
    if (effortArg !== null && !EFFORT_ORDER.includes(effortArg as Effort)) throw sqlError('22023');
    const user = userArg;
    const turn = turnArg;
    const today = this.today();
    const week = weekStart(today);
    let model = modelArg as string | null;
    let effort = effortArg as Effort | null;
    let reason: string | null = null;
    let counted = false;
    let pm: OwnerPlanModel | null = null;
    let info: ModelPrice | null = null;
    let turnDay: string | null = null;
    let turnRow: TurnRow | null = null;

    // 1) Plan vigente.
    const planId = this.effectivePlan(user);
    const plan = planId ? (this.plans.get(planId) as PlanRow) : null;
    if (!planId || !plan) reason = 'noplan';

    if (!reason && planId && plan) {
      // Pregunta abierta (hoy o ayer, la más reciente).
      for (const day of [today, addDays(today, -1)]) {
        const row = this.turnRow(user, turn, day);
        if (row) {
          turnDay = day;
          turnRow = row;
          break;
        }
      }
      // 2) Modelo.
      if (model === null) model = turnRow?.model ?? null;
      if (model === null) model = this.planModels(planId)[0]?.model ?? null;
      pm = model === null ? null : this.planModels(planId).find((x) => x.model === model) ?? null;
      if (!pm) reason = 'model';
      else info = this.models.get(pm.model) ?? null;
    }

    // 3) Esfuerzo.
    if (!reason && pm) {
      if (effort === null) effort = defaultEffort(pm.efforts);
      if (effort === null || !pm.efforts.includes(effort)) reason = 'effort';
    }

    // 4) La pregunta abierta sigue con su modelo.
    if (!reason && turnRow && turnRow.model !== null && turnRow.model !== model) reason = 'turn_model';

    // 5) Ráfaga y llamadas en curso (0013).
    let inflight = 0;
    if (!reason && plan) {
      const nowMs = this.now.getTime();
      const r = this.rate.get(user);
      let calls: number;
      if (!r) {
        this.rate.set(user, { windowStart: nowMs, calls: 1 });
        calls = 1;
      } else if (r.windowStart > nowMs - 60000) {
        r.calls += 1;
        calls = r.calls;
      } else {
        r.windowStart = nowMs;
        r.calls = 1;
        calls = 1;
      }
      inflight = this.inflight(user);
      if (calls > plan.rpm || inflight >= MAX_INFLIGHT) reason = 'rate';
    }

    // 6) Presupuesto del mes: el que rige (0013: con el tope si subió de plan) y la reserva de las llamadas en curso.
    if (!reason && plan && model) {
      const spent = this.monthMicros(user);
      const budget = Math.round(this.budgetLimit(user, plan) * 1e6);
      if (spent >= budget) reason = 'budget';
      else if (inflight > 0 && spent + inflight * this.callReserveMicros(model, plan.maxTokens) >= budget) reason = 'rate';
    }

    // 7) Pregunta ya abierta.
    if (!reason && plan && turnRow && turnDay) {
      if (turnRow.calls >= plan.maxCallsPerTurn) reason = 'turn';
      else {
        turnRow.calls += 1;
        if (turnRow.model === null) turnRow.model = model;
      }
    }

    // 8) Pregunta nueva.
    if (!reason && plan && pm && model && !turnRow) {
      for (const key of [...this.turns.keys()]) {
        const [u, , day] = key.split('|');
        if (u === user && day < addDays(today, -2)) this.turns.delete(key);
      }
      this.turns.set(`${user}|${turn}|${today}`, { model, calls: 1 });
      let weekBefore = 0;
      for (const [key, row] of this.usage) {
        const [u, day, m] = key.split('|');
        if (u === user && m === model && day >= week && day < today) weekBefore += row.questions;
      }
      if (pm.daily <= 0) reason = 'daily';
      else if (weekBefore >= pm.weekly) reason = 'weekly';
      else {
        const existing = this.usageRow(user, today, model);
        if (!existing || (existing.questions < pm.daily && existing.questions + weekBefore < pm.weekly)) {
          const row = this.ensureUsage(user, today, model);
          row.questions += 1;
          row.updatedAt = ++this.tick;
          counted = true;
        } else {
          reason = existing.questions >= pm.daily ? 'daily' : 'weekly';
        }
      }
      if (reason) {
        const row = this.turnRow(user, turn, today);
        if (row && row.calls <= 1) this.turns.delete(`${user}|${turn}|${today}`);
      }
    }

    // 0013: la llamada permitida queda en curso hasta que la cierran ai_add_usage o ai_end_call.
    if (reason === null) {
      const r = this.rate.get(user) as RateRow;
      r.inflight = inflight + 1;
      r.inflightAt = this.now.getTime();
    }

    return {
      allowed: reason === null,
      reason,
      model,
      modelId: reason === null && info ? info.modelId : null,
      fallback: reason === null && Boolean(info?.fallback),
      effort,
      counted,
      maxTokensPerRequest: plan ? plan.maxTokens : 0,
      quota: this.quotaStatus(user),
    };
  }

  /** ai_register_turn(p_user, p_turn) de 0007: siempre rechaza desde 0008. */
  legacyRegister(user: string): Json {
    return { allowed: false, reason: 'plan', counted: false, maxTokensPerRequest: 0, quota: this.quotaStatus(user) };
  }

  /** ai_release_turn. */
  releaseTurn(userArg: unknown, turnArg: unknown): Json {
    if (typeof userArg !== 'string' || typeof turnArg !== 'string') throw sqlError('22023');
    const today = this.today();
    for (const day of [today, addDays(today, -1)]) {
      const row = this.turnRow(userArg, turnArg, day);
      if (!row || row.calls > 1) continue;
      this.turns.delete(`${userArg}|${turnArg}|${day}`);
      const usage = row.model ? this.usageRow(userArg, day, row.model) : undefined;
      if (usage) {
        usage.questions = Math.max(usage.questions - 1, 0);
        usage.updatedAt = ++this.tick;
      }
      break;
    }
    return this.quotaStatus(userArg);
  }

  /** ai_end_call (0013): cierra una llamada sin respuesta. */
  endCall(userArg: unknown, callArg: unknown = null): Json {
    if (typeof userArg !== 'string' || !userArg) throw sqlError('22023');
    this.closeCall(userArg);
    if (this.dual) this.settleReservation(userArg, 0, callArg);
    return this.quotaStatus(userArg);
  }

  /**
   * ai_add_usage (versión de 0013, la de 0011 que además cierra la llamada). Cada renglón se cobra con el precio
   * del modelo que lo corrió; los de Anthropic (y los sin precio) quedan en la fila del modelo de la pregunta y los
   * de OpenAI en la de su modelo.
   */
  addUsage(userArg: unknown, modelArg: unknown, usageArg: unknown, callArg: unknown = null): Json {
    if (typeof userArg !== 'string' || typeof modelArg !== 'string') throw sqlError('22023');
    if (!Array.isArray(usageArg) || usageArg.length > 50) throw sqlError('22023');
    const base = this.models.get(modelArg);
    if (!base) throw sqlError('22023');
    this.closeCall(userArg);
    let units = 0;
    const buckets = new Map<string, { units: number; input: number; output: number; cacheRead: number; cacheWrite: number }>();
    const unpriced: string[] = [];
    for (const line of usageArg) {
      if (!isObject(line)) continue;
      const tokens = {
        input: tokenCount(line.input),
        output: tokenCount(line.output),
        cacheRead: tokenCount(line.cacheRead),
        cacheWrite: tokenCount(line.cacheWrite),
      };
      const lineModel = line.model === undefined || line.model === null ? null : (typeof line.model === 'string' ? line.model : JSON.stringify(line.model)).slice(0, 64);
      const price = [...this.models.values()].find((m) => m.modelId === lineModel) ?? null;
      if (!price && lineModel !== null && !unpriced.includes(lineModel)) unpriced.push(lineModel);
      const effective = price ?? base;
      const lineUnits = priceUnits(effective, tokens);
      units += lineUnits;
      const target = effective.provider === 'openai' ? effective.id : modelArg;
      let bucket = buckets.get(target);
      if (!bucket) {
        bucket = { units: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        buckets.set(target, bucket);
      }
      bucket.units += lineUnits;
      bucket.input += tokens.input;
      bucket.output += tokens.output;
      bucket.cacheRead += tokens.cacheRead;
      bucket.cacheWrite += tokens.cacheWrite;
    }
    if (!buckets.size) buckets.set(modelArg, { units: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    for (const [target, bucket] of buckets) {
      const row = this.ensureUsage(userArg, this.today(), target);
      row.calls += 1;
      row.input += bucket.input;
      row.output += bucket.output;
      row.cacheRead += bucket.cacheRead;
      row.cacheWrite += bucket.cacheWrite;
      // cost_usd numeric(12,6): cada fila redondea su parte.
      row.costMicros += roundUnits(bucket.units, 10000);
      row.updatedAt = ++this.tick;
    }
    // 0056: el costo va al saldo que reservó la llamada (el del proveedor que la atendió).
    if (this.dual) this.settleReservation(userArg, roundUnits(units, 10000), callArg);
    return { quota: this.quotaStatus(userArg), costUsd: roundUnits(units, 10000) / 1e6, unpriced };
  }

  // ---------- 0056 (6.1): dos motores, un saldo por motor ----------
  // Réplica de ai_register_turn, ai_quota_status, ai_catalog y ai_wallets de 0056_ia_dos_motores.sql, simplificada:
  // un saldo es un plan pagado de un motor con su presupuesto y lo gastado (ai_paid_periods). Sin planes dados a mano.

  /** true: FakeDb.dual() (contrato de 0056). false: las funciones de 0008/0011/0013 de siempre. */
  dual = false;
  /** Saldos por usuario y motor (ai_wallets + ai_paid_periods). */
  wallets = new Map<string, Map<Provider, WalletRow>>();
  /** Saldo en uso de cada usuario (ai_subscriptions). */
  activeWallet = new Map<string, Provider>();
  /** Reservas de las llamadas en curso (ai_call_reservations), en orden: las cierra ai_add_usage o ai_end_call. */
  reservations = new Map<string, { id: string; provider: Provider; micros: number }[]>();
  /** Claves en Vault (ai_anthropic_key / ai_openai_key). */
  vault: Record<Provider, string | null> = { anthropic: null, openai: null };
  /** private.ai_provider_ready: motores con la clave cargada. Uno sin clave no se vende ni se elige solo al cambiar de saldo. */
  ready: Record<Provider, boolean> = { anthropic: true, openai: true };
  /** Pedidos a ai_register_turn tal como llegaron (para revisar p_max_tokens y p_input_bytes). */
  registerArgs: Json[] = [];

  /** Base con el contrato de 0056: los diez planes, los modelos de los dos motores y el respaldo apagado. */
  static dual(): FakeDb {
    const db = new FakeDb();
    db.dual = true;
    db.models = new Map(DUAL_MODELS.map((m) => [m.id, { ...m, long: m.long ? { ...m.long } : null }]));
    db.tierFallbacks = new Map(DUAL_TIERS.map((f) => [f.tier, { ...f, efforts: { ...f.efforts }, active: true }]));
    db.plans = new Map(DUAL_PLANS.map((p) => [p.id, { ...p, active: true, models: p.models.map((m) => ({ ...m, efforts: [...m.efforts] })) }]));
    db.providerConfig = { primary: 'openai', secondary: null, failoverEnabled: false, failoverOn: [] };
    return db;
  }

  /** Para preparar escenarios: una compra (pagada) de `plan`; si ya había saldo de ese motor, suma lo que quedaba. */
  buy(user: string, plan: string, opts: { spentUsd?: number; activate?: boolean } = {}): void {
    const row = this.plans.get(plan) as (PlanRow & { provider: Provider }) | undefined;
    if (!row) throw new Error(`plan desconocido: ${plan}`);
    let list = this.wallets.get(user);
    if (!list) {
      list = new Map();
      this.wallets.set(user, list);
    }
    const before = list.get(row.provider);
    const carry = before && before.valid ? Math.max(before.budgetMicros - before.spentMicros, 0) : 0;
    list.set(row.provider, {
      plan,
      budgetMicros: Math.round(row.budgetUsd * 1e6) + carry,
      spentMicros: Math.round((opts.spentUsd ?? 0) * 1e6),
      valid: true,
    });
    if (opts.activate !== false || !this.activeWallet.has(user)) this.activeWallet.set(user, row.provider);
  }

  /** Para preparar escenarios: el saldo de un motor deja de valer (por ejemplo, una devolución). */
  refund(user: string, provider: Provider): void {
    const w = this.wallets.get(user)?.get(provider);
    if (w) w.valid = false;
  }

  wallet(user: string, provider: Provider): WalletRow | undefined {
    return this.wallets.get(user)?.get(provider);
  }

  private planRow(id: string | null | undefined): (PlanRow & { provider: Provider; tier: string }) | null {
    const p = id ? this.plans.get(id) : undefined;
    return p && p.active ? (p as PlanRow & { provider: Provider; tier: string }) : null;
  }

  /** private.ai_wallet_plan: el plan del saldo si vale. */
  private walletPlan(user: string, provider: Provider): string | null {
    const w = this.wallet(user, provider);
    return w && w.valid && this.planRow(w.plan) ? w.plan : null;
  }

  private reservedMicros(user: string, provider: Provider): number {
    return (this.reservations.get(user) ?? []).filter((r) => r.provider === provider).reduce((a, r) => a + r.micros, 0);
  }

  /** private.ai_wallet_left, en millonésimas. */
  private walletLeft(user: string, provider: Provider): number {
    const w = this.wallet(user, provider);
    if (!w || !this.walletPlan(user, provider)) return 0;
    return Math.max(0, w.budgetMicros - w.spentMicros - this.reservedMicros(user, provider));
  }

  /** ai_effective_plan con saldos: el plan del saldo en uso, si vale. */
  private dualPlan(user: string): string | null {
    const active = this.activeWallet.get(user);
    return active ? this.walletPlan(user, active) : null;
  }

  /** private.ai_model_for: la fila (precio e id de la API) del modelo real de una clave en un motor. */
  modelFor(provider: Provider, key: string): ModelPrice | null {
    if (provider === 'anthropic') {
      const m = this.models.get(key);
      return m && m.active && m.provider === 'anthropic' ? m : null;
    }
    const f = this.tierFallbacks.get(key);
    const m = f?.active ? this.models.get(f.model) : undefined;
    return m && m.provider === 'openai' ? m : null;
  }

  /** private.ai_reserve_usd, en millonésimas (redondeo hacia arriba como el ceil del SQL). */
  reserveMicros(provider: Provider, key: string, maxTokens: number, inputTokens: number): number | null {
    const m = this.modelFor(provider, key);
    if (!m) return null;
    const long = m.long && inputTokens > m.long.threshold ? m.long : null;
    const inRate = long ? Math.max(long.input, long.cacheWrite) : Math.max(m.input, m.cacheWrite);
    const outRate = long ? long.output : m.output;
    return Math.ceil((inputTokens * rate(inRate) + Math.max(maxTokens, 0) * rate(outRate)) / 10000);
  }

  /** private.ai_afford_tokens: la salida que se puede conceder con lo que queda (0 si no llega al mínimo de 2.048). */
  affordTokens(provider: Provider, key: string, want: number, inputTokens: number, leftMicros: number): number {
    const fixed = this.reserveMicros(provider, key, 0, inputTokens);
    if (fixed === null) return 0;
    const one = ((this.reserveMicros(provider, key, 1000000, inputTokens) as number) - fixed) / 1000000;
    const min = Math.min(Math.max(want, 1), MIN_GRANT_TOKENS);
    if (leftMicros - fixed - 2 <= 0) return 0;
    const afford = one <= 0 ? want : Math.floor((leftMicros - fixed - 2) / one);
    if (afford < min) return 0;
    return Math.min(Math.max(want, 1), afford);
  }

  /** private.ai_plan_key: la clave pedida si el plan la tiene (y su motor la ofrece); si no, la primera del plan. */
  private planKey(planId: string, key: string | null): string | null {
    const plan = this.planRow(planId);
    if (!plan) return null;
    const offered = this.planModels(planId).filter((pm) => this.modelFor(plan.provider, pm.model));
    return (offered.find((pm) => pm.model === key) ?? offered[0])?.model ?? null;
  }

  /** ai_register_turn de 0056, paso por paso. */
  registerDual(args: Json): Json {
    this.registerArgs.push(args);
    const userArg = args.p_user;
    const turnArg = args.p_turn;
    const maxArg = args.p_max_tokens ?? null;
    const bytesArg = args.p_input_bytes ?? null;
    if (typeof userArg !== 'string' || !userArg || typeof turnArg !== 'string' || turnArg.length < 1 || turnArg.length > 100) throw sqlError('22023');
    const modelArg = args.p_model ?? null;
    const effortArg = args.p_effort ?? null;
    if (modelArg !== null && (typeof modelArg !== 'string' || modelArg.length < 1 || modelArg.length > 32)) throw sqlError('22023');
    if (effortArg !== null && !DUAL_EFFORTS.includes(effortArg as Effort)) throw sqlError('22023');
    if (maxArg !== null && (!Number.isInteger(maxArg) || (maxArg as number) < 1 || (maxArg as number) > 1000000)) throw sqlError('22023');
    if (bytesArg !== null && (!Number.isInteger(bytesArg) || (bytesArg as number) < 0 || (bytesArg as number) > 100000000)) throw sqlError('22023');
    const user = userArg;
    const turn = turnArg;
    const inputTokens = Math.min(bytesArg === null ? 500000 : (bytesArg as number) + 8000, 500000);
    const today = this.today();
    const week = weekStart(today);

    let turnDay: string | null = null;
    let turnRow: TurnRow | null = null;
    for (const day of [today, addDays(today, -1)]) {
      const row = this.turnRow(user, turn, day);
      if (row) {
        turnDay = day;
        turnRow = row;
        break;
      }
    }
    let model = (modelArg as string | null) ?? turnRow?.model ?? null;
    let effort = effortArg as Effort | null;
    let reason: string | null = null;
    let switched: Json | null = null;
    let moved = false;
    let refit = false;
    let counted = false;
    let grant = 0;
    let reserved = 0;
    let inflight = 0;
    let pm: OwnerPlanModel | null = null;
    let info: ModelPrice | null = null;

    // 1) Plan vigente; si el saldo en uso dejó de valer y hay otro con fondos, pasa a ese (noplan).
    let planId = this.dualPlan(user);
    if (!planId) {
      const candidates = PROVIDER_LIST.filter((p) => this.ready[p] && this.walletLeft(user, p) > 0).sort((a, b) => this.walletLeft(user, b) - this.walletLeft(user, a));
      const to = candidates[0];
      if (to) {
        const from = this.activeWallet.get(user) ?? null;
        this.activeWallet.set(user, to);
        planId = this.dualPlan(user);
        moved = planId !== null;
        if (moved && from && from !== to) switched = { from, to, reason: 'noplan' };
      }
    }
    if (!planId) reason = 'noplan';

    let plan = this.planRow(planId);
    for (let pass = 1; reason === null && plan && planId; pass++) {
      // 2) Modelo. Una pregunta abierta cuyo modelo pedido no está en el plan en uso (otra llamada pasó al otro saldo)
      //    se ajusta a ese plan en vez de rechazarse.
      if (turnRow && !moved && model !== null && this.planKey(planId, model) !== model) {
        refit = true;
        model = this.planKey(planId, turnRow.model ?? model);
      } else if (model === null || moved) model = this.planKey(planId, model);
      pm = model === null ? null : this.planModels(planId).find((x) => x.model === model) ?? null;
      const real = pm && model ? this.modelFor(plan.provider, model) : null;
      if (!pm || !real) {
        reason = 'model';
        break;
      }
      info = this.models.get(pm.model) ?? null;
      // 3) Esfuerzo.
      if (effort === null) effort = dualDefaultEffort(pm.efforts);
      else if (moved || turnRow) effort = fitEffort(pm.efforts, effort);
      if (effort === null || !pm.efforts.includes(effort)) {
        reason = 'effort';
        break;
      }
      if (pass === 1) {
        // 4) La pregunta abierta sigue con su modelo.
        if (turnRow && turnRow.model !== null && turnRow.model !== model && !moved && !refit) {
          reason = 'turn_model';
          break;
        }
        // 5) Ráfaga y llamadas en curso.
        const nowMs = this.now.getTime();
        const r = this.rate.get(user);
        let calls: number;
        if (!r) {
          this.rate.set(user, { windowStart: nowMs, calls: 1 });
          calls = 1;
        } else if (r.windowStart > nowMs - 60000) {
          calls = ++r.calls;
        } else {
          r.windowStart = nowMs;
          r.calls = 1;
          calls = 1;
        }
        inflight = (this.reservations.get(user) ?? []).length;
        if (calls > plan.rpm || inflight >= MAX_INFLIGHT) {
          reason = 'rate';
          break;
        }
      }
      // 6) Saldo: la reserva es el costo máximo de ESTA llamada; si no alcanza, se concede menos salida o se
      //    prueba el otro saldo.
      const want = Math.min(plan.maxTokens, (maxArg as number | null) ?? plan.maxTokens);
      const w = this.wallet(user, plan.provider) as WalletRow;
      reserved = this.reservedMicros(user, plan.provider);
      grant = this.affordTokens(plan.provider, model as string, want, inputTokens, w.budgetMicros - w.spentMicros - reserved);
      if (grant > 0) break;
      if (pass === 1 && !moved) {
        const to = otherOf(plan.provider);
        const toPlan = this.walletPlan(user, to);
        const toKey = toPlan ? this.planKey(toPlan, model) : null;
        const toRow = this.planRow(toPlan);
        if (toPlan && toKey && toRow && this.ready[to]
          && this.affordTokens(to, toKey, Math.min(toRow.maxTokens, (maxArg as number | null) ?? 2147483647), inputTokens, this.walletLeft(user, to)) > 0) {
          switched = { from: plan.provider, to, reason: 'budget' };
          this.activeWallet.set(user, to);
          moved = true;
          planId = toPlan;
          plan = toRow;
          continue;
        }
      }
      reason = reserved > 0 ? 'rate' : 'budget';
    }

    // 7) y 8) La pregunta: abierta (una llamada más) o nueva (con su cupo).
    if (reason === null && plan && pm && model) {
      if (turnRow && turnDay) {
        if (turnRow.calls >= plan.maxCallsPerTurn) reason = 'turn';
        else {
          turnRow.calls += 1;
          turnRow.model = moved || refit ? model : turnRow.model ?? model;
        }
      } else {
        this.turns.set(`${user}|${turn}|${today}`, { model, calls: 1 });
        let weekBefore = 0;
        for (const [key, row] of this.usage) {
          const [u, day, m] = key.split('|');
          if (u === user && m === model && day >= week && day < today) weekBefore += row.questions;
        }
        const existing = this.usageRow(user, today, model);
        if (pm.daily <= 0) reason = 'daily';
        else if (weekBefore >= pm.weekly) reason = 'weekly';
        else if (!existing || (existing.questions < pm.daily && existing.questions + weekBefore < pm.weekly)) {
          const row = this.ensureUsage(user, today, model);
          row.questions += 1;
          row.updatedAt = ++this.tick;
          counted = true;
        } else reason = existing.questions >= pm.daily ? 'daily' : 'weekly';
        if (reason) this.turns.delete(`${user}|${turn}|${today}`);
      }
    }

    const fb = reason === null && model ? this.tierFallbacks.get(model) : undefined;
    let callId: string | null = null;
    if (reason === null && plan && model) {
      const micros = Math.max(this.reserveMicros(plan.provider, model, grant, inputTokens) ?? 0, 1);
      const list = this.reservations.get(user) ?? [];
      // El id de la reserva es un uuid, como en la base (ai_call_reservations.id).
      callId = `00000000-0000-4000-8000-${String(++this.tick).padStart(12, '0')}`;
      list.push({ id: callId, provider: plan.provider, micros });
      this.reservations.set(user, list);
    }
    return {
      allowed: reason === null,
      callId,
      reason,
      model,
      provider: plan?.provider ?? null,
      modelId: reason === null && info ? info.modelId : null,
      models: reason === null && model
        ? { anthropic: info?.provider === 'anthropic' ? info.modelId : null, openai: this.modelFor('openai', model)?.modelId ?? null }
        : null,
      openaiEffort: reason === null && effort ? (fb?.active ? (fb.efforts as Record<string, string | null | undefined>)[effort] ?? null : null) : null,
      fallback: false,
      effort,
      counted,
      maxTokensPerRequest: reason === null ? grant : plan?.maxTokens ?? 0,
      switched,
      quota: this.quotaDual(user),
    };
  }

  /** ai_quota_status de 0056. */
  quotaDual(user: string): Json {
    const today = this.today();
    const week = weekStart(today);
    const planId = this.dualPlan(user);
    const plan = this.planRow(planId);
    let models: Json[] = [];
    let lastModel: string | null = null;
    if (plan && planId) {
      const offered = this.planModels(planId).filter((pm) => this.modelFor(plan.provider, pm.model));
      models = offered.map((pm) => {
        const key = this.models.get(pm.model) as ModelPrice;
        const real = this.modelFor(plan.provider, pm.model) as ModelPrice;
        let usedToday = 0;
        let usedWeek = 0;
        for (const [k, row] of this.usage) {
          const [u, day, m] = k.split('|');
          if (u !== user || m !== pm.model || day < week) continue;
          usedWeek += row.questions;
          if (day === today) usedToday += row.questions;
        }
        return {
          id: pm.model, model: key.modelId, providerModel: real.modelId, label: real.label, efforts: dualEffortList(pm.efforts),
          daily: { used: usedToday, limit: pm.daily }, weekly: { used: usedWeek, limit: pm.weekly },
        };
      });
      const ids = new Set(offered.map((pm) => pm.model));
      let best: { day: string; updatedAt: number; model: string } | null = null;
      for (const [k, row] of this.usage) {
        const [u, day, m] = k.split('|');
        if (u !== user || !ids.has(m) || !row.questions) continue;
        if (!best || day > best.day || (day === best.day && row.updatedAt > best.updatedAt)) best = { day, updatedAt: row.updatedAt, model: m };
      }
      lastModel = best?.model ?? null;
    }
    const active = plan ? this.wallet(user, plan.provider) : undefined;
    const wallets = PROVIDER_LIST.filter((p) => this.walletPlan(user, p)).map((p) => {
      const w = this.wallet(user, p) as WalletRow;
      const wp = this.planRow(w.plan) as PlanRow & { tier: string };
      return {
        provider: p, plan: w.plan, planName: wp.name, tier: wp.tier, usedUsd: w.spentMicros / 1e6, limitUsd: w.budgetMicros / 1e6,
        remainingUsd: Math.max(0, w.budgetMicros - w.spentMicros) / 1e6, active: this.activeWallet.get(user) === p,
      };
    });
    return {
      plan: planId,
      planName: plan?.name ?? null,
      priceUsd: plan ? plan.priceUsd : null,
      provider: plan?.provider ?? null,
      tier: plan?.tier ?? null,
      maxTokensPerRequest: plan?.maxTokens ?? null,
      status: plan ? 'active' : 'none',
      models,
      budget: { usedUsd: active ? active.spentMicros / 1e6 : 0, limitUsd: active ? active.budgetMicros / 1e6 : 0 },
      wallets,
      resets: { daily: localMidnightIso(addDays(today, 1)), weekly: localMidnightIso(addDays(week, 7)), monthly: null },
      timezone: TIMEZONE,
      lastModel,
    };
  }

  /** ai_catalog de 0056: solo los planes con nivel, con su motor y las etiquetas de sus modelos reales. */
  catalogDual(): Json[] {
    return [...this.plans.values()]
      .filter((p) => p.active && (p as PlanRow & { tier?: string }).tier)
      .sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1))
      .map((p) => {
        const plan = p as PlanRow & { provider: Provider; tier: string };
        return {
          id: plan.id, name: plan.name, provider: plan.provider, tier: plan.tier, available: this.ready[plan.provider], priceUsd: plan.priceUsd,
          budgetUsd: plan.budgetUsd, maxTokensPerRequest: plan.maxTokens,
          models: this.planModels(plan.id).filter((pm) => this.modelFor(plan.provider, pm.model)).map((pm) => ({
            id: pm.model, label: (this.modelFor(plan.provider, pm.model) as ModelPrice).label, efforts: dualEffortList(pm.efforts), daily: pm.daily, weekly: pm.weekly,
          })),
        };
      });
  }

  /**
   * Cierra una reserva del usuario y cobra `micros` al saldo que la reservó (ai_add_usage / ai_end_call): la
   * indicada (p_call) o, sin ella, la más vieja.
   */
  private settleReservation(user: string, micros: number, callArg: unknown = null): void {
    const list = this.reservations.get(user);
    if (!list?.length) return;
    const at = typeof callArg === 'string' && callArg ? list.findIndex((c) => c.id === callArg) : 0;
    if (at < 0) return;
    const [call] = list.splice(at, 1);
    if (!call) return;
    const w = this.wallet(user, call.provider);
    if (w) w.spentMicros += micros;
  }
}

/** Fila de un saldo (ai_wallets + su ai_paid_periods), en millonésimas de dólar. */
export interface WalletRow {
  plan: string;
  budgetMicros: number;
  spentMicros: number;
  valid: boolean;
}

type Provider = 'anthropic' | 'openai';
const PROVIDER_LIST: Provider[] = ['anthropic', 'openai'];
const DUAL_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** 0056 (ai_afford_tokens): mínimo de tokens de salida que se concede cuando el saldo no alcanza para todo el pedido. */
export const MIN_GRANT_TOKENS = 2048;

function otherOf(p: Provider): Provider {
  return p === 'anthropic' ? 'openai' : 'anthropic';
}

function dualEffortList(efforts: Effort[]): Effort[] {
  return DUAL_EFFORTS.filter((e) => efforts.includes(e));
}

/** ai_default_effort de 0056: medium, low, high, xhigh, max (el primero que el plan permita). */
function dualDefaultEffort(efforts: Effort[]): Effort | null {
  return (['medium', 'low', 'high', 'xhigh', 'max'] as Effort[]).find((e) => efforts.includes(e)) ?? null;
}

/** private.ai_fit_effort: el pedido o el permitido más alto por debajo; si no hay, el más bajo permitido. */
function fitEffort(efforts: Effort[], effort: Effort): Effort | null {
  const want = DUAL_EFFORTS.indexOf(effort);
  const allowed = dualEffortList(efforts);
  return [...allowed].reverse().find((e) => DUAL_EFFORTS.indexOf(e) <= want) ?? allowed[0] ?? null;
}
