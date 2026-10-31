// Validación estricta de lo que manda el panel (ids, duraciones, fechas, textos, filtros y cambios de planes).
// Todo lo inválido corta con un 400 { error: 'bad_request', field, message }. Sin dependencias externas.
import { badRequest } from './errors.ts';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** El mismo check que public.ai_plans.id y public.ai_models.id. */
export const PLAN_ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
export const MODEL_ID_PATTERN = PLAN_ID_PATTERN;

export const LIMITS = {
  /** Cuerpo de un pedido del panel. */
  bodyBytes: 64 * 1024,
  /** Usuarios por acción en lote. */
  bulkMax: 100,
  /** Acciones en lote que corren a la vez. */
  bulkConcurrency: 4,
  /** Archivos por bucket que devuelve admin_user_files en cada vuelta (el limit del SQL). */
  filesPage: 1000,
  /** Vueltas de admin_user_files al borrar una cuenta (hasta 20.000 archivos por bucket). */
  purgeRounds: 20,
  reasonMax: 500,
  noteMax: 300,
  notesMax: 2000,
  searchMax: 100,
  perPageMax: 100,
  auditPerPageMax: 200,
  /** Hasta cuándo se puede regalar un plan. */
  untilMaxYears: 10,
};

export type Duration = '1h' | '24h' | '7d' | '30d' | 'permanent';

/** Duraciones de baneo y silencio: la de Supabase Auth (ban_duration) y la de la base. Permanente = 100 años. */
export const DURATIONS: Readonly<Record<Duration, { auth: string; ms: number }>> = {
  '1h': { auth: '1h', ms: 3600 * 1000 },
  '24h': { auth: '24h', ms: 24 * 3600 * 1000 },
  '7d': { auth: '168h', ms: 7 * 24 * 3600 * 1000 },
  '30d': { auth: '720h', ms: 30 * 24 * 3600 * 1000 },
  permanent: { auth: '876000h', ms: 876000 * 3600 * 1000 },
};

export const EFFORTS = ['low', 'medium', 'high'] as const;
export const USER_STATUSES = ['active', 'inactive', 'none', 'past_due', 'canceling', 'stripe', 'manual'] as const;
export const USER_SORTS = ['created', 'lastSignIn', 'spend', 'email'] as const;

type Obj = Record<string, unknown>;

export function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CONTROL_LINE = /[\u0000-\u001F\u007F]/g;

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Texto opcional: sin caracteres de control (salto de línea solo con multiline), recortado, hasta `max`. */
export function optText(value: unknown, max: number, field: string, opts: { multiline?: boolean } = {}): string | null {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') throw badRequest('Texto inválido.', field);
  const clean = value.replace(opts.multiline ? CONTROL : CONTROL_LINE, '').trim();
  if (!clean) return null;
  if (clean.length > max) throw badRequest(`Como máximo ${max} caracteres.`, field);
  return clean;
}

export function reqText(value: unknown, max: number, field: string, opts: { multiline?: boolean } = {}): string {
  const text = optText(value, max, field, opts);
  if (!text) throw badRequest('Este campo es obligatorio.', field);
  return text;
}

export function optBool(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'boolean') throw badRequest('Tiene que ser verdadero o falso.', field);
  return value;
}

export function int(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`Tiene que ser un número entero entre ${min} y ${max}.`, field);
  }
  return value;
}

export function optInt(value: unknown, min: number, max: number, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  return int(value, min, max, field);
}

/** Dólares con hasta 2 decimales. */
export function money(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw badRequest(`Tiene que ser un monto entre ${min} y ${max}.`, field);
  }
  const cents = value * 100;
  if (Math.abs(Math.round(cents) - cents) > 1e-6) throw badRequest('Como máximo 2 decimales.', field);
  return Math.round(cents) / 100;
}

export function optEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw badRequest('Valor inválido.', field);
  return value as T;
}

export function reqEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const v = optEnum(value, allowed, field);
  if (v === null) throw badRequest('Este campo es obligatorio.', field);
  return v;
}

export function uuid(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) throw badRequest('Id de usuario inválido.', field);
  return value.trim().toLowerCase();
}

export function optUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return uuid(value, field);
}

/** Lista de ids de usuario (sin repetidos, en el orden pedido), de 1 a LIMITS.bulkMax. */
export function uuidList(value: unknown, field = 'ids', max = LIMITS.bulkMax): string[] {
  if (!Array.isArray(value) || value.length === 0) throw badRequest('Elegí al menos un usuario.', field);
  if (value.length > max) throw badRequest(`Como máximo ${max} usuarios por vez.`, field);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = uuid(item, field);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function planId(value: unknown, field = 'planId'): string {
  if (typeof value !== 'string' || !PLAN_ID_PATTERN.test(value.trim())) throw badRequest('Plan inválido.', field);
  return value.trim();
}

export function duration(value: unknown, field = 'duration'): Duration {
  return reqEnum(value, Object.keys(DURATIONS) as Duration[], field);
}

/** Momento en que termina una duración (para la base). */
export function untilFor(d: Duration, nowMs: number): string {
  return new Date(nowMs + DURATIONS[d].ms).toISOString();
}

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** Fecha ISO 8601 (o null). Con future: tiene que ser posterior a ahora y anterior a ahora + maxMs. */
export function optIsoDate(value: unknown, field: string, opts: { future?: boolean; maxMs?: number; nowMs: number }): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !ISO_PATTERN.test(value.trim())) throw badRequest('Fecha inválida (ISO 8601).', field);
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) throw badRequest('Fecha inválida (ISO 8601).', field);
  if (opts.future && ms <= opts.nowMs + 60 * 1000) throw badRequest('La fecha tiene que ser futura.', field);
  if (opts.maxMs !== undefined && ms > opts.nowMs + opts.maxMs) throw badRequest('La fecha está demasiado lejos.', field);
  return new Date(ms);
}

/** Esfuerzos: 1 a 3 de low, medium y high, sin repetidos y en ese orden. */
export function efforts(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw badRequest('Elegí al menos un esfuerzo.', field);
  const set = new Set<string>();
  for (const e of value) {
    if (typeof e !== 'string' || !(EFFORTS as readonly string[]).includes(e)) throw badRequest('Esfuerzo inválido.', field);
    set.add(e);
  }
  return EFFORTS.filter((e) => set.has(e));
}

/** Filtros de users.list -> argumentos de public.admin_list_users. */
export function listUsersArgs(raw: unknown): Record<string, unknown> {
  const o = obj(raw) ?? {};
  let plan: string | null = null;
  if (!isBlank(o.plan)) plan = o.plan === 'none' ? 'none' : planId(o.plan, 'plan');
  return {
    p_search: optText(o.search, LIMITS.searchMax, 'search'),
    p_plan: plan,
    p_status: optEnum(o.status, USER_STATUSES, 'status'),
    p_banned: optBool(o.banned, 'banned'),
    p_muted: optBool(o.muted, 'muted'),
    p_sort: optEnum(o.sort, USER_SORTS, 'sort') ?? 'created',
    p_page: optInt(o.page, 1, 1_000_000, 'page') ?? 1,
    p_per_page: optInt(o.perPage, 1, LIMITS.perPageMax, 'perPage') ?? 25,
  };
}

const AUDIT_ACTION = /^[a-z][A-Za-z]{1,30}(\.([A-Za-z]{1,30})?)?$/;

/** Filtros de audit.list -> argumentos de public.admin_list_actions. */
export function listActionsArgs(raw: unknown, nowMs: number): Record<string, unknown> {
  const o = obj(raw) ?? {};
  let action: string | null = null;
  if (!isBlank(o.action)) {
    if (typeof o.action !== 'string' || !AUDIT_ACTION.test(o.action.trim())) throw badRequest('Acción inválida.', 'action');
    action = o.action.trim();
  }
  const since = optIsoDate(o.since, 'since', { nowMs });
  const until = optIsoDate(o.until, 'until', { nowMs });
  return {
    p_action: action,
    p_admin: optUuid(o.adminId, 'adminId'),
    p_target: optUuid(o.targetUser, 'targetUser'),
    p_since: since ? since.toISOString() : null,
    p_until: until ? until.toISOString() : null,
    p_page: optInt(o.page, 1, 1_000_000, 'page') ?? 1,
    p_per_page: optInt(o.perPage, 1, LIMITS.auditPerPageMax, 'perPage') ?? 50,
  };
}

const PLAN_KEYS = new Set(['monthlyBudgetUsd', 'maxTokensPerRequest', 'maxCallsPerTurn', 'requestsPerMinute', 'active', 'models']);
const MODEL_KEYS = new Set(['id', 'efforts', 'daily', 'weekly', 'sort', 'remove']);

/**
 * Cambios de un plan (solo la base) -> p_patch de public.admin_update_plan. Las claves desconocidas se rechazan
 * (el precio se cambia con plans.setPrice, que crea un precio nuevo en Stripe).
 */
export function planPatch(raw: unknown): Record<string, unknown> {
  const o = obj(raw);
  if (!o) throw badRequest('Faltan los cambios del plan.', 'patch');
  for (const key of Object.keys(o)) {
    if (!PLAN_KEYS.has(key)) throw badRequest(key === 'priceUsd' || key === 'price' ? 'El precio se cambia con "Cambiar precio".' : `Campo desconocido: ${key}.`, key);
  }
  const out: Record<string, unknown> = {};
  if ('monthlyBudgetUsd' in o) out.monthly_budget_usd = money(o.monthlyBudgetUsd, 0, 1000, 'monthlyBudgetUsd');
  if ('maxTokensPerRequest' in o) out.max_tokens_per_request = int(o.maxTokensPerRequest, 1000, 16000, 'maxTokensPerRequest');
  if ('maxCallsPerTurn' in o) out.max_calls_per_turn = int(o.maxCallsPerTurn, 1, 200, 'maxCallsPerTurn');
  if ('requestsPerMinute' in o) out.requests_per_minute = int(o.requestsPerMinute, 1, 600, 'requestsPerMinute');
  if ('active' in o) {
    if (typeof o.active !== 'boolean') throw badRequest('Tiene que ser verdadero o falso.', 'active');
    out.active = o.active;
  }
  if ('models' in o) {
    if (!Array.isArray(o.models) || o.models.length > 10) throw badRequest('Lista de modelos inválida.', 'models');
    const seen = new Set<string>();
    out.models = o.models.map((raw, i) => {
      const m = obj(raw);
      if (!m) throw badRequest('Modelo inválido.', `models.${i}`);
      for (const key of Object.keys(m)) if (!MODEL_KEYS.has(key)) throw badRequest(`Campo desconocido: ${key}.`, `models.${i}.${key}`);
      if (typeof m.id !== 'string' || !MODEL_ID_PATTERN.test(m.id)) throw badRequest('Modelo inválido.', `models.${i}.id`);
      if (seen.has(m.id)) throw badRequest('Modelo repetido.', `models.${i}.id`);
      seen.add(m.id);
      if (m.remove === true) return { model_id: m.id, remove: true };
      if (m.remove !== undefined && m.remove !== false) throw badRequest('Tiene que ser verdadero o falso.', `models.${i}.remove`);
      const item: Record<string, unknown> = {
        model_id: m.id,
        efforts: efforts(m.efforts, `models.${i}.efforts`),
        daily_questions: int(m.daily, 0, 100000, `models.${i}.daily`),
        weekly_questions: int(m.weekly, 0, 1000000, `models.${i}.weekly`),
      };
      if (m.sort !== undefined) item.sort = int(m.sort, 0, 10000, `models.${i}.sort`);
      return item;
    });
  }
  if (!Object.keys(out).length) throw badRequest('No hay cambios para guardar.', 'patch');
  return out;
}

/** "admin@example.com" -> "r*****e@gmail.com" (para el registro de cuentas borradas). */
export function maskEmail(email: unknown): string | null {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = [email.slice(0, email.lastIndexOf('@')), email.slice(email.lastIndexOf('@') + 1)];
  if (!local) return `*@${domain}`;
  if (local.length <= 2) return `${local[0]}*@${domain}`;
  return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 8))}${local[local.length - 1]}@${domain}`;
}
