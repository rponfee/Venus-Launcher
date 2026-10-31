// Doble en memoria de las funciones SQL de 0008_ai_plans.sql, 0011_ai_providers.sql y 0013_ai_budget.sql que usa
// la Edge Function: ai_quota_status, ai_catalog, ai_register_turn (las dos versiones), ai_release_turn,
// ai_add_usage (el uso de OpenAI va a la fila de su modelo y cierra la llamada), ai_end_call y
// ai_provider_settings. Sigue el SQL paso a paso para probar el protocolo de punta a punta sin Postgres (planes,
// modelos, esfuerzos, cupos por día y por semana, presupuesto con su tope, llamadas en curso, preguntas atadas a su
// modelo, costos y proveedores). NO prueba el SQL: si cambiás una función SQL, cambiá esta réplica también (y al revés).
import { DEFAULT_FAILOVER_ON } from '../config.ts';
import { MODEL_PRICES, OPENAI_PRICES, OWNER_PLANS, TIER_FALLBACKS } from './owner-plans.ts';
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
        if (keys === 'p_effort,p_model,p_turn,p_user') {
          return this.registerTurn(args.p_user, args.p_turn, args.p_model ?? null, args.p_effort ?? null);
        }
        if (keys === 'p_turn,p_user') return this.legacyRegister(String(args.p_user));
        throw sqlError('PGRST202');
      case 'ai_release_turn':
        return this.releaseTurn(args.p_user, args.p_turn);
      case 'ai_add_usage':
        return this.addUsage(args.p_user, args.p_model, args.p_usage);
      case 'ai_end_call':
        return this.endCall(args.p_user);
      case 'ai_provider_settings':
        return this.providerSettings();
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
  endCall(userArg: unknown): Json {
    if (typeof userArg !== 'string' || !userArg) throw sqlError('22023');
    this.closeCall(userArg);
    return this.quotaStatus(userArg);
  }

  /**
   * ai_add_usage (versión de 0013, la de 0011 que además cierra la llamada). Cada renglón se cobra con el precio
   * del modelo que lo corrió; los de Anthropic (y los sin precio) quedan en la fila del modelo de la pregunta y los
   * de OpenAI en la de su modelo.
   */
  addUsage(userArg: unknown, modelArg: unknown, usageArg: unknown): Json {
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
    return { quota: this.quotaStatus(userArg), costUsd: roundUnits(units, 10000) / 1e6, unpriced };
  }
}
