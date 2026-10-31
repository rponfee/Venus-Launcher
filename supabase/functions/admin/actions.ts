// Acciones del panel de administración. Cada una recibe el contexto (admin ya verificado, base, Stripe, Auth) y
// el payload del launcher, valida todo y devuelve el resultado. Lo que cambia algo queda en admin_actions (una
// fila por usuario afectado). Formas exactas: docs/admin.md.
import { AdminError, AuthAdminError, DbError, MESSAGES, badRequest, notFound, stripeNotConfigured } from './errors.ts';
import {
  DURATIONS,
  LIMITS,
  duration as parseDuration,
  listActionsArgs,
  listUsersArgs,
  maskEmail,
  obj,
  optIsoDate,
  optText,
  planId as parsePlanId,
  planPatch,
  reqEnum,
  reqText,
  untilFor,
  uuid,
  uuidList,
} from './validate.ts';
import {
  addPromotionCode,
  couponSummary,
  createCoupon,
  deleteCoupon,
  listCoupons,
  productForPlan,
  setPromotionCodeActive,
  stripeObjectId,
  validateCoupon,
  validatePromo,
} from './coupons.ts';
import { changePlanPrice, planInfo } from './prices.ts';
import type { Logger } from './prices.ts';
import { idPath, StripeError } from './stripe-admin.ts';
import type { AdminStripe } from './stripe-admin.ts';

type Obj = Record<string, unknown>;

export interface AuthAdmin {
  /** ban_duration de Supabase Auth ('none' levanta el baneo). */
  setBan(userId: string, banDuration: string): Promise<void>;
  /** Borra la cuenta (y en cascada todo lo que cuelga de auth.users). */
  deleteUser(userId: string): Promise<void>;
}

export interface StorageAdmin {
  /** Borra archivos de un bucket; devuelve cuántos borró. */
  remove(bucket: string, paths: string[]): Promise<number>;
}

export interface ActionDeps {
  authAdmin: AuthAdmin;
  storage?: StorageAdmin | null;
  /** null si falta STRIPE_SECRET_KEY: cupones, precios y cancelaciones responden "no configurado". */
  stripe: AdminStripe | null;
  /** Modo de la clave de Stripe (true = producción). */
  livemode: boolean;
  portalConfiguration: string | null;
}

export interface Ctx {
  admin: { id: string; email: string | null };
  deps: ActionDeps;
  now(): number;
  /** Función SQL con la service role; si falla lanza DbError. */
  db(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Agrega una fila a admin_actions; false si no se pudo (la acción ya se hizo igual). */
  log(action: string, target: string | null, details: Obj): Promise<boolean>;
  logger: Logger;
}

export type Action = (ctx: Ctx, payload: Obj) => Promise<unknown>;

/** Versión del protocolo del panel (la devuelve "me"). */
export const ADMIN_PROTOCOL = 1;

/** Estados de Stripe de una suscripción que todavía cobra o puede cobrar. */
export const OPEN_STRIPE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);

/** Error de un usuario dentro de una acción en lote (no corta a los demás). */
export class ItemError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ItemError';
    this.code = code;
  }
}

export interface Target {
  id: string;
  exists: boolean;
  email: string | null;
  username: string | null;
  isAdmin: boolean;
  planId: string | null;
  status: string | null;
  source: string | null;
  hasAccess: boolean;
  stripeSubscriptionId: string | null;
  stripeStatus: string | null;
  customerId: string | null;
  customerLivemode: boolean | null;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  const o = obj(value);
  return o && typeof o.id === 'string' && o.id ? o.id : null;
}

function stripeInfo(ctx: Ctx): Obj {
  return { configured: Boolean(ctx.deps.stripe), mode: ctx.deps.stripe ? (ctx.deps.livemode ? 'live' : 'test') : null };
}

function requireStripe(ctx: Ctx): AdminStripe {
  if (!ctx.deps.stripe) throw stripeNotConfigured();
  return ctx.deps.stripe;
}

function requireConfirm(payload: Obj): void {
  if (payload.confirm !== true) throw badRequest(MESSAGES.confirmRequired, 'confirm');
}

// ---------- Usuarios en lote ----------

async function loadTargets(ctx: Ctx, ids: string[]): Promise<Map<string, Target>> {
  const rows = await ctx.db('admin_targets', { p_ids: ids });
  const map = new Map<string, Target>();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const r = obj(raw);
    const id = str(r?.id)?.toLowerCase();
    if (!r || !id) continue;
    map.set(id, {
      id,
      exists: r.exists === true,
      email: str(r.email),
      username: str(r.username),
      isAdmin: r.isAdmin === true,
      planId: str(r.planId),
      status: str(r.status),
      source: str(r.source),
      hasAccess: r.hasAccess === true,
      stripeSubscriptionId: str(r.stripeSubscriptionId),
      stripeStatus: str(r.stripeStatus),
      customerId: str(r.customerId),
      customerLivemode: typeof r.customerLivemode === 'boolean' ? r.customerLivemode : null,
    });
  }
  return map;
}

/** Corre tareas con un máximo de `size` a la vez (conserva el orden de los resultados). */
async function pool(tasks: (() => Promise<void>)[], size: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
}

function itemErrorCode(err: unknown): Obj {
  if (err instanceof ItemError) return { error: err.code };
  if (err instanceof AdminError) return { error: err.code };
  if (err instanceof StripeError) return { error: 'stripe', stripeCode: err.code ?? err.type };
  if (err instanceof AuthAdminError) return { error: 'auth', status: err.status };
  if (err instanceof DbError) return { error: 'db' };
  return { error: 'error' };
}

interface StepResult {
  result?: Obj;
  log?: Obj;
  warning?: Obj;
}

interface BulkOptions {
  action: string;
  /** Moderación: nunca sobre uno mismo ni sobre otros admins. */
  protect: boolean;
  details?: Obj;
  /** progress: lo que ya se hizo de verdad (Auth, Stripe, archivos); si después algo falla, queda en el registro. */
  run(target: Target, progress: Obj): Promise<StepResult | void>;
}

export interface BulkResult {
  results: Obj[];
  summary: { ok: number; failed: number };
  warnings: Obj[];
}

async function bulk(ctx: Ctx, ids: string[], opts: BulkOptions): Promise<BulkResult> {
  const targets = await loadTargets(ctx, ids);
  const results: Obj[] = new Array(ids.length);
  const warnings: Obj[] = [];
  let auditFailed = 0;
  await pool(
    ids.map((id, i) => async () => {
      const t = targets.get(id);
      if (!t || !t.exists) {
        results[i] = { id, ok: false, error: 'not_found' };
        return;
      }
      if (opts.protect && id === ctx.admin.id) {
        results[i] = { id, ok: false, error: 'self' };
        return;
      }
      if (opts.protect && t.isAdmin) {
        results[i] = { id, ok: false, error: 'target_admin' };
        return;
      }
      const progress: Obj = {};
      try {
        const out = (await opts.run(t, progress)) || {};
        results[i] = { id, ok: true, ...(out.result ?? {}) };
        if (out.warning) warnings.push({ id, email: t.email, ...out.warning });
        if (!(await ctx.log(opts.action, id, { ...(opts.details ?? {}), ...(out.log ?? {}) }))) auditFailed++;
      } catch (err) {
        if (!(err instanceof ItemError)) ctx.logger.warn(`[admin] ${opts.action} falló para ${id}: ${err instanceof StripeError ? err.describe() : err instanceof Error ? err.name : 'error'}`);
        const failure = itemErrorCode(err);
        results[i] = { id, ok: false, ...failure };
        // Falló a mitad de camino: lo que ya se hizo (un baneo en Auth, cancelaciones en Stripe, archivos borrados)
        // también queda en el registro, marcado como fallido.
        if (Object.keys(progress).length) {
          if (!(await ctx.log(opts.action, id, { ...(opts.details ?? {}), ...progress, failed: true, error: failure.error }))) auditFailed++;
        }
      }
    }),
    LIMITS.bulkConcurrency,
  );
  if (auditFailed) warnings.push({ code: 'audit_failed', count: auditFailed });
  const ok = results.filter((r) => r.ok === true).length;
  return { results, summary: { ok, failed: results.length - ok }, warnings };
}

// ---------- Stripe de un usuario ----------

/** La base ya sabe que tiene una suscripción de Stripe que cobra (la guarda el webhook). */
function dbStripeOpen(t: Target): boolean {
  return Boolean(t.source === 'stripe' && t.stripeSubscriptionId && t.stripeStatus && OPEN_STRIPE_STATUSES.has(t.stripeStatus));
}

interface OpenSubs {
  checked: boolean;
  reason?: string;
  subscriptions: Obj[];
}

/** Suscripciones de Stripe del usuario que siguen cobrando (por su cliente y por la que guardó la base). */
async function openSubscriptions(ctx: Ctx, t: Target): Promise<OpenSubs> {
  const stripe = ctx.deps.stripe;
  if (!stripe) return { checked: false, reason: 'stripe_not_configured', subscriptions: [] };
  // Un cliente de producción no existe con la clave de prueba (y al revés): no se puede revisar.
  if (t.customerId && t.customerLivemode !== null && t.customerLivemode !== ctx.deps.livemode) {
    return { checked: false, reason: 'stripe_mode', subscriptions: [] };
  }
  const found = new Map<string, Obj>();
  if (t.customerId) {
    try {
      const listed = await stripe.get<Obj>('/v1/subscriptions', { customer: t.customerId, status: 'all', limit: 100 });
      for (const raw of Array.isArray(listed.data) ? listed.data : []) {
        const s = obj(raw);
        const id = idOf(s?.id);
        if (s && id && OPEN_STRIPE_STATUSES.has(String(s.status))) found.set(id, s);
      }
    } catch (err) {
      if (!(err instanceof StripeError && err.missing)) throw err;
    }
  }
  if (t.stripeSubscriptionId && !found.has(t.stripeSubscriptionId)) {
    try {
      const s = await stripe.get<Obj>(idPath('/v1/subscriptions/', t.stripeSubscriptionId));
      if (OPEN_STRIPE_STATUSES.has(String(s.status))) found.set(t.stripeSubscriptionId, s);
    } catch (err) {
      if (!(err instanceof StripeError && err.missing)) throw err;
    }
  }
  return { checked: true, subscriptions: [...found.values()] };
}

/** ¿Tiene una suscripción de Stripe activa? (la sincronización de Stripe puede pisar un plan puesto a mano). */
async function stripeActiveFor(ctx: Ctx, t: Target): Promise<{ active: boolean; subscriptionId: string | null; unchecked?: boolean }> {
  if (dbStripeOpen(t)) return { active: true, subscriptionId: t.stripeSubscriptionId };
  if (!t.customerId || !ctx.deps.stripe) return { active: false, subscriptionId: null };
  try {
    const open = await openSubscriptions(ctx, t);
    if (!open.checked) return { active: false, subscriptionId: null, unchecked: true };
    const first = open.subscriptions[0];
    return { active: Boolean(first), subscriptionId: first ? idOf(first.id) : null };
  } catch {
    return { active: false, subscriptionId: null, unchecked: true };
  }
}

async function cancelSubscription(stripe: AdminStripe, subscriptionId: string, when: 'now' | 'period_end', nowMs: number): Promise<Obj> {
  // La clave cambia cada minuto: frena el doble clic, pero un reintento después no recibe durante 24 h la respuesta
  // que Stripe guardó la primera vez (un error 500, o una cancelación que el usuario ya deshizo en el portal).
  const minute = Math.floor(nowMs / 60000);
  if (when === 'period_end') {
    return stripe.post<Obj>(idPath('/v1/subscriptions/', subscriptionId), { cancel_at_period_end: true }, { idempotencyKey: `venus-admin-cancel-end-${subscriptionId}-${minute}` });
  }
  return stripe.del<Obj>(
    idPath('/v1/subscriptions/', subscriptionId),
    { invoice_now: false, prorate: false, cancellation_details: { comment: 'Cancelada desde el panel de administración de Venus Launcher' } },
    { idempotencyKey: `venus-admin-cancel-${subscriptionId}-${minute}` },
  );
}

/** Borra los archivos del usuario en Storage (mundos en la nube, capturas y clips) y suma en progress.filesRemoved
 *  los que va borrando. admin_user_files devuelve hasta LIMITS.filesPage por bucket: se repite mientras alguno venga
 *  lleno. false si quedaron archivos sin borrar. */
async function purgeFiles(ctx: Ctx, userId: string, progress: Obj): Promise<boolean> {
  const storage = ctx.deps.storage;
  if (!storage) return true;
  let removed = 0;
  for (let round = 0; round < LIMITS.purgeRounds; round++) {
    const files = obj(await ctx.db('admin_user_files', { p_user: userId })) ?? {};
    const before = removed;
    let full = false;
    for (const [bucket, names] of Object.entries(files)) {
      const page = Array.isArray(names) ? names : [];
      if (page.length >= LIMITS.filesPage) full = true;
      const list = page.filter((n): n is string => typeof n === 'string' && n.startsWith(`${userId}/`));
      for (let i = 0; i < list.length; i += 100) {
        removed += await storage.remove(bucket, list.slice(i, i + 100));
        if (removed) progress.filesRemoved = removed;
      }
    }
    if (!full) return true;
    // Una vuelta que no borró nada no va a borrar más.
    if (removed === before) return false;
  }
  return false;
}

// ---------- Acciones ----------

const me: Action = async (ctx) => ({
  userId: ctx.admin.id,
  email: ctx.admin.email,
  isAdmin: true,
  protocol: ADMIN_PROTOCOL,
  stripe: stripeInfo(ctx),
  storage: Boolean(ctx.deps.storage),
});

const overview: Action = async (ctx) => {
  const data = obj(await ctx.db('admin_overview', {})) ?? {};
  return { ...data, stripe: stripeInfo(ctx) };
};

const usersList: Action = async (ctx, payload) => ctx.db('admin_list_users', listUsersArgs(payload));

const usersGet: Action = async (ctx, payload) => {
  const data = await ctx.db('admin_user_detail', { p_user: uuid(payload.id) });
  if (!obj(data)) throw notFound('Ese usuario no existe (o ya se borró).');
  return { ...(data as Obj), stripe: stripeInfo(ctx) };
};

async function activePlan(ctx: Ctx, id: string): Promise<Obj> {
  const plan = obj(await ctx.db('admin_plan_json', { p_plan: id }));
  if (!plan) throw badRequest('Ese plan no existe.', 'planId');
  return plan;
}

const usersSetPlan: Action = async (ctx, payload) => {
  const ids = uuidList(payload.ids);
  const plan = parsePlanId(payload.planId);
  const until = optIsoDate(payload.until, 'until', { future: true, maxMs: LIMITS.untilMaxYears * 365 * 24 * 3600 * 1000, nowMs: ctx.now() });
  const note = optText(payload.note, LIMITS.noteMax, 'note');
  const info = await activePlan(ctx, plan);
  if (info.active !== true) throw badRequest('Ese plan está desactivado: activalo antes de asignarlo.', 'planId');
  const untilIso = until ? until.toISOString() : null;
  const out = await bulk(ctx, ids, {
    action: 'users.setPlan',
    protect: false,
    details: { planId: plan, until: untilIso, note },
    async run(t) {
      const stripe = await stripeActiveFor(ctx, t);
      const res = obj(await ctx.db('admin_set_plan', { p_user: t.id, p_plan: plan, p_until: untilIso })) ?? {};
      if (res.applied !== true) throw new ItemError(str(res.reason) ?? 'not_applied');
      const previous = obj(res.previous);
      return {
        result: { previousPlan: str(previous?.planId), stripeActive: stripe.active, subscriptionId: stripe.subscriptionId },
        log: { previousPlan: str(previous?.planId), previousSource: str(previous?.source), stripeActive: stripe.active },
        warning: stripe.active
          ? { code: 'stripe_active', subscriptionId: stripe.subscriptionId }
          : stripe.unchecked
            ? { code: 'stripe_unchecked' }
            : undefined,
      };
    },
  });
  return { ...out, planId: plan, until: untilIso, stripe: stripeInfo(ctx) };
};

const usersRemovePlan: Action = async (ctx, payload) => {
  const ids = uuidList(payload.ids);
  const note = optText(payload.note, LIMITS.noteMax, 'note');
  const out = await bulk(ctx, ids, {
    action: 'users.removePlan',
    protect: false,
    details: { note },
    async run(t) {
      const stripe = await stripeActiveFor(ctx, t);
      const res = obj(await ctx.db('admin_remove_plan', { p_user: t.id })) ?? {};
      const changed = res.applied === true;
      const previous = obj(res.previous);
      return {
        result: { changed, previousPlan: str(previous?.planId), stripeActive: stripe.active, subscriptionId: stripe.subscriptionId },
        log: { changed, previousPlan: str(previous?.planId), stripeActive: stripe.active },
        warning: stripe.active ? { code: 'stripe_active', subscriptionId: stripe.subscriptionId } : undefined,
      };
    },
  });
  return { ...out, stripe: stripeInfo(ctx) };
};

const usersBan: Action = async (ctx, payload) => {
  const ids = uuidList(payload.ids);
  const d = parseDuration(payload.duration);
  const reason = reqText(payload.reason, LIMITS.reasonMax, 'reason', { multiline: true });
  return bulk(ctx, ids, {
    action: 'users.ban',
    protect: true,
    details: { duration: d, reason },
    async run(t, progress) {
      // Primero Supabase Auth (no puede iniciar sesión ni renovar la sesión), después la base (social) y al final
      // se cierran sus sesiones abiertas.
      await ctx.deps.authAdmin.setBan(t.id, DURATIONS[d].auth);
      progress.authBan = DURATIONS[d].auth;
      const until = untilFor(d, ctx.now());
      await ctx.db('admin_moderate', { p_user: t.id, p_patch: { banned_until: until, ban_reason: reason }, p_admin: ctx.admin.id });
      let sessions: number | null = null;
      try {
        sessions = Number(await ctx.db('admin_revoke_sessions', { p_user: t.id })) || 0;
      } catch {
        sessions = null;
      }
      return {
        result: { bannedUntil: until, sessionsRevoked: sessions },
        log: { until, sessionsRevoked: sessions },
        warning: sessions === null ? { code: 'signout_failed' } : undefined,
      };
    },
  });
};

const usersUnban: Action = async (ctx, payload) => {
  const ids = uuidList(payload.ids);
  return bulk(ctx, ids, {
    action: 'users.unban',
    protect: false,
    async run(t, progress) {
      await ctx.deps.authAdmin.setBan(t.id, 'none');
      progress.authBan = 'none';
      await ctx.db('admin_moderate', { p_user: t.id, p_patch: { banned_until: null, ban_reason: null }, p_admin: ctx.admin.id });
    },
  });
};

const usersMute: Action = async (ctx, payload) => {
  const ids = uuidList(payload.ids);
  const d = parseDuration(payload.duration);
  const reason = optText(payload.reason, LIMITS.reasonMax, 'reason', { multiline: true });
  return bulk(ctx, ids, {
    action: 'users.mute',
    protect: true,
    details: { duration: d, reason },
    async run(t) {
      const until = untilFor(d, ctx.now());
      await ctx.db('admin_moderate', { p_user: t.id, p_patch: { muted_until: until, mute_reason: reason }, p_admin: ctx.admin.id });
      return { result: { mutedUntil: until }, log: { until } };
    },
  });
};

const usersUnmute: Action = async (ctx, payload) => {
  const ids = uuidList(payload.ids);
  return bulk(ctx, ids, {
    action: 'users.unmute',
    protect: false,
    async run(t) {
      await ctx.db('admin_moderate', { p_user: t.id, p_patch: { muted_until: null, mute_reason: null }, p_admin: ctx.admin.id });
    },
  });
};

const usersSignOut: Action = async (ctx, payload) => {
  const ids = uuidList(payload.ids);
  return bulk(ctx, ids, {
    action: 'users.signOut',
    protect: true,
    async run(t) {
      const sessions = Number(await ctx.db('admin_revoke_sessions', { p_user: t.id })) || 0;
      return { result: { sessionsRevoked: sessions }, log: { sessionsRevoked: sessions } };
    },
  });
};

const usersResetUsage: Action = async (ctx, payload) => {
  const ids = uuidList(payload.ids);
  const scope = reqEnum(payload.scope, ['today', 'week'] as const, 'scope');
  return bulk(ctx, ids, {
    action: 'users.resetUsage',
    protect: false,
    details: { scope },
    async run(t) {
      const rows = Number(await ctx.db('admin_reset_usage', { p_user: t.id, p_scope: scope })) || 0;
      return { result: { rows }, log: { rows } };
    },
  });
};

const usersDelete: Action = async (ctx, payload) => {
  requireConfirm(payload);
  const ids = uuidList(payload.ids);
  const cancelStripe = payload.cancelStripe !== false;
  const purge = payload.purgeFiles !== false;
  return bulk(ctx, ids, {
    action: 'users.delete',
    protect: true,
    details: { cancelStripe, purgeFiles: purge },
    async run(t, progress) {
      // 1) Que nadie siga pagando: se cancelan YA sus suscripciones de Stripe (sin factura final ni prorrateo).
      const canceled: string[] = [];
      let stripeSkipped = false;
      if (cancelStripe && (t.customerId || t.stripeSubscriptionId)) {
        const stripe = ctx.deps.stripe;
        if (!stripe) throw new ItemError('stripe_not_configured');
        const open = await openSubscriptions(ctx, t);
        if (!open.checked) throw new ItemError(open.reason ?? 'stripe');
        for (const sub of open.subscriptions) {
          const id = idOf(sub.id);
          if (!id) continue;
          await cancelSubscription(stripe, id, 'now', ctx.now());
          canceled.push(id);
          progress.canceledSubscriptions = canceled;
        }
      } else if (!cancelStripe && dbStripeOpen(t)) {
        stripeSkipped = true;
      }
      // 2) Sus archivos en Storage (no se borran solos con la cuenta).
      let filesFailed = false;
      if (purge) {
        try {
          filesFailed = !(await purgeFiles(ctx, t.id, progress));
        } catch {
          filesFailed = true;
        }
      }
      const filesRemoved = Number(progress.filesRemoved) || 0;
      // 3) La cuenta: Supabase Auth borra auth.users y la base borra en cascada perfil, amigos, mensajes, plan, uso...
      await ctx.deps.authAdmin.deleteUser(t.id);
      return {
        result: { canceledSubscriptions: canceled, filesRemoved },
        log: { email: maskEmail(t.email), username: t.username, canceledSubscriptions: canceled, filesRemoved },
        warning: filesFailed ? { code: 'files_not_removed' } : stripeSkipped ? { code: 'stripe_not_canceled', subscriptionId: t.stripeSubscriptionId } : undefined,
      };
    },
  });
};

const usersSetNotes: Action = async (ctx, payload) => {
  const id = uuid(payload.id);
  const notes = optText(payload.notes, LIMITS.notesMax, 'notes', { multiline: true });
  const res = obj(await ctx.db('admin_moderate', { p_user: id, p_patch: { notes }, p_admin: ctx.admin.id })) ?? {};
  if (res.applied !== true) throw notFound('Ese usuario no existe (o ya se borró).');
  const logged = await ctx.log('users.setNotes', id, { length: notes ? notes.length : 0 });
  return { moderation: res.moderation ?? null, warnings: logged ? [] : [{ code: 'audit_failed', count: 1 }] };
};

const stripeCancel: Action = async (ctx, payload) => {
  const stripe = requireStripe(ctx);
  const id = uuid(payload.userId, 'userId');
  const when = payload.when === undefined ? 'now' : reqEnum(payload.when, ['now', 'period_end'] as const, 'when');
  const t = (await loadTargets(ctx, [id])).get(id);
  if (!t || !t.exists) throw notFound('Ese usuario no existe (o ya se borró).');
  const open = await openSubscriptions(ctx, t);
  if (!open.checked) {
    throw new AdminError('conflict', 409, 'El cliente de Stripe de este usuario es de otro modo (prueba o producción): cancelalo desde el panel de Stripe.', {
      reason: open.reason,
    });
  }
  const canceled: Obj[] = [];
  const logCanceled = (extra: Obj = {}) =>
    canceled.length ? ctx.log('stripe.cancelSubscription', id, { when, subscriptions: canceled.map((c) => c.id), ...extra }) : Promise.resolve(true);
  for (const sub of open.subscriptions) {
    const subId = idOf(sub.id);
    if (!subId) continue;
    let res: Obj;
    try {
      res = await cancelSubscription(stripe, subId, when, ctx.now());
    } catch (err) {
      // Las que ya se cancelaron quedan en el registro aunque esta falle.
      await logCanceled({ failed: true, error: itemErrorCode(err).error });
      throw err;
    }
    canceled.push({ id: subId, status: str(res.status), cancelAtPeriodEnd: res.cancel_at_period_end === true });
  }
  const logged = await logCanceled();
  return { userId: id, when, canceled, warnings: logged ? [] : [{ code: 'audit_failed', count: 1 }] };
};

// ---------- Cupones ----------

async function knownPlans(ctx: Ctx): Promise<Obj[]> {
  const data = obj(await ctx.db('admin_plans', {}));
  return (Array.isArray(data?.plans) ? data!.plans : []).map(obj).filter((p): p is Obj => Boolean(p));
}

const couponsList: Action = async (ctx) => {
  if (!ctx.deps.stripe) return { configured: false, mode: null, coupons: [], hasMore: false, checkoutAcceptsCodes: true, message: MESSAGES.stripeNotConfigured };
  const { coupons, hasMore } = await listCoupons(ctx.deps.stripe);
  return { configured: true, mode: ctx.deps.livemode ? 'live' : 'test', coupons, hasMore, checkoutAcceptsCodes: true };
};

const couponsCreate: Action = async (ctx, payload) => {
  const stripe = requireStripe(ctx);
  const input = validateCoupon(payload, ctx.now());
  if (input.appliesTo.length) {
    const ids = new Set((await knownPlans(ctx)).map((p) => p.id));
    const unknown = input.appliesTo.find((p) => !ids.has(p));
    if (unknown) throw badRequest(`El plan ${unknown} no existe.`, 'appliesTo');
  }
  const created = await createCoupon(stripe, input, input.appliesTo.map(productForPlan));
  const logged = await ctx.log('coupons.create', null, {
    couponId: created.coupon.id,
    name: input.name,
    ...couponSummary(input),
    appliesTo: input.appliesTo,
    maxRedemptions: input.maxRedemptions,
    redeemBy: input.redeemBy ? input.redeemBy.toISOString() : null,
    promoCode: created.promotionCode?.code ?? null,
    promoId: created.promotionCode?.id ?? null,
  });
  return { ...created, warnings: logged ? [] : [{ code: 'audit_failed', count: 1 }] };
};

const couponsAddPromo: Action = async (ctx, payload) => {
  const stripe = requireStripe(ctx);
  const couponId = stripeObjectId(payload.couponId, 'couponId');
  const coupon = await stripe.get<Obj>(idPath('/v1/coupons/', couponId));
  if (coupon.valid === false) throw new AdminError('conflict', 409, 'Ese cupón ya no es válido (venció o llegó a sus usos máximos).', { reason: 'coupon_invalid' });
  const redeemBy = typeof coupon.redeem_by === 'number' ? new Date(coupon.redeem_by * 1000) : null;
  const promo = validatePromo(payload, ctx.now(), { redeemBy });
  const created = await addPromotionCode(stripe, couponId, promo);
  const logged = await ctx.log('coupons.addPromo', null, { couponId, promoId: created.id, code: created.code, firstTimeOnly: promo.firstTimeOnly, maxRedemptions: promo.maxRedemptions });
  return { promotionCode: created, warnings: logged ? [] : [{ code: 'audit_failed', count: 1 }] };
};

function promoToggle(active: boolean): Action {
  return async (ctx, payload) => {
    const stripe = requireStripe(ctx);
    const promoId = stripeObjectId(payload.promoId, 'promoId', 'promo_');
    const updated = await setPromotionCodeActive(stripe, promoId, active);
    const logged = await ctx.log(active ? 'coupons.activatePromo' : 'coupons.deactivatePromo', null, { promoId, code: updated.code });
    return { promotionCode: updated, warnings: logged ? [] : [{ code: 'audit_failed', count: 1 }] };
  };
}

const couponsDelete: Action = async (ctx, payload) => {
  const stripe = requireStripe(ctx);
  const couponId = stripeObjectId(payload.couponId, 'couponId');
  await deleteCoupon(stripe, couponId);
  const logged = await ctx.log('coupons.delete', null, { couponId });
  return { deleted: true, couponId, warnings: logged ? [] : [{ code: 'audit_failed', count: 1 }] };
};

// ---------- Planes ----------

const plansList: Action = async (ctx) => {
  const data = obj(await ctx.db('admin_plans', {})) ?? {};
  return { ...data, stripe: stripeInfo(ctx) };
};

const plansUpdate: Action = async (ctx, payload) => {
  const id = parsePlanId(payload.planId);
  const patch = planPatch(payload.patch);
  const data = obj(await ctx.db('admin_plans', {})) ?? {};
  const plans = (Array.isArray(data.plans) ? data.plans : []).map(obj);
  if (!plans.some((p) => p?.id === id)) throw badRequest('Ese plan no existe.', 'planId');
  if (Array.isArray(patch.models)) {
    const models = new Set((Array.isArray(data.models) ? data.models : []).map((m) => obj(m)?.id));
    for (const m of patch.models as Obj[]) {
      if (m.remove !== true && !models.has(m.model_id)) throw badRequest(`El modelo ${String(m.model_id)} no existe o no está activo.`, 'models');
    }
  }
  const plan = await ctx.db('admin_update_plan', { p_plan: id, p_patch: patch });
  const logged = await ctx.log('plans.update', null, { planId: id, changes: patch });
  return { plan, warnings: logged ? [] : [{ code: 'audit_failed', count: 1 }] };
};

const plansSetPrice: Action = async (ctx, payload) => {
  const stripe = requireStripe(ctx);
  const id = parsePlanId(payload.planId);
  requireConfirm(payload);
  const info = planInfo(await ctx.db('admin_plan_json', { p_plan: id }));
  if (!info) throw badRequest('Ese plan no existe.', 'planId');
  const result = await changePlanPrice(
    { stripe, livemode: ctx.deps.livemode, portalConfiguration: ctx.deps.portalConfiguration, db: (n, a) => ctx.db(n, a), logger: ctx.logger, nowMs: ctx.now() },
    info,
    payload.amount as number,
  );
  const logged = await ctx.log('plans.setPrice', null, {
    planId: id,
    amount: result.amount,
    previousAmount: result.previousAmount,
    priceId: result.priceId,
    previousPriceId: result.previousPriceId,
    livemode: result.livemode,
    portal: result.portal,
  });
  const plan = await ctx.db('admin_plan_json', { p_plan: id }).catch(() => null);
  const warnings: Obj[] = result.warnings.map((code) => ({ code }));
  if (!logged) warnings.push({ code: 'audit_failed', count: 1 });
  return { ...result, plan, warnings };
};

// ---------- Registro ----------

const auditList: Action = async (ctx, payload) => ctx.db('admin_list_actions', listActionsArgs(payload, ctx.now()));

export const ACTIONS: Readonly<Record<string, Action>> = {
  me,
  overview,
  'users.list': usersList,
  'users.get': usersGet,
  'users.setPlan': usersSetPlan,
  'users.removePlan': usersRemovePlan,
  'users.ban': usersBan,
  'users.unban': usersUnban,
  'users.mute': usersMute,
  'users.unmute': usersUnmute,
  'users.signOut': usersSignOut,
  'users.resetUsage': usersResetUsage,
  'users.delete': usersDelete,
  'users.setNotes': usersSetNotes,
  'stripe.cancelSubscription': stripeCancel,
  'coupons.list': couponsList,
  'coupons.create': couponsCreate,
  'coupons.addPromo': couponsAddPromo,
  'coupons.deactivatePromo': promoToggle(false),
  'coupons.activatePromo': promoToggle(true),
  'coupons.delete': couponsDelete,
  'plans.list': plansList,
  'plans.update': plansUpdate,
  'plans.setPrice': plansSetPrice,
  'audit.list': auditList,
};
