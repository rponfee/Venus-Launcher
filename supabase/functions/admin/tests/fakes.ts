// Dobles para las pruebas de la Edge Function "admin" (no es un archivo de pruebas: no termina en .test.ts).
// - FakeAdminDb: las funciones SQL de 0012 (y billing_upsert_price de 0009) en memoria, con las mismas reglas.
// - FakeStripe: la API REST de Stripe que usa el panel (cupones, códigos, precios, productos, portal y
//   suscripciones), como fetch: registra cada pedido con sus parámetros y encabezados.
// - fakeAuth / fakeStorage: la API de administración de Supabase Auth y Storage.
import { createAdminHandler } from '../handler.ts';
import type { AdminDeps, AuthResult } from '../handler.ts';
import { createAdminStripe } from '../stripe-admin.ts';
import { AuthAdminError } from '../errors.ts';

type Obj = Record<string, unknown>;

export const ADMIN = '11111111-1111-4111-8111-111111111111';
export const ADMIN2 = '22222222-2222-4222-8222-222222222222';
export const USER = '33333333-3333-4333-8333-333333333333';
export const PAYER = '44444444-4444-4444-8444-444444444444';
export const UNCONFIRMED = '55555555-5555-4555-8555-555555555555';
export const MISSING = '66666666-6666-4666-8666-666666666666';
export const LIVE_PAYER = '77777777-7777-4777-8777-777777777777';

export const NOW = Date.UTC(2026, 10, 1, 12, 0, 0); // 2026-11-01T12:00:00Z
export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

export interface UserRow {
  id: string;
  email: string;
  confirmed: boolean;
  username: string;
  bannedUntil: number | null;
}

export interface SubRow {
  plan_id: string;
  status: string;
  source: string;
  current_period_end: string | null;
  stripe_subscription_id: string | null;
  stripe_status: string | null;
}

export class FakeAdminDb {
  calls: { name: string; args: Obj }[] = [];
  failures = new Map<string, string>();
  adminEmails = new Set(['admin@example.com', 'otro.admin@example.com']);
  admins = new Set([ADMIN, ADMIN2]);
  users = new Map<string, UserRow>([
    [ADMIN, { id: ADMIN, email: 'admin@example.com', confirmed: true, username: 'venusadmin', bannedUntil: null }],
    [ADMIN2, { id: ADMIN2, email: 'otro.admin@example.com', confirmed: true, username: 'otroadmin', bannedUntil: null }],
    [USER, { id: USER, email: 'jugador@example.com', confirmed: true, username: 'jugador', bannedUntil: null }],
    [PAYER, { id: PAYER, email: 'paga@example.com', confirmed: true, username: 'pagador', bannedUntil: null }],
    [UNCONFIRMED, { id: UNCONFIRMED, email: 'otro.admin@example.com', confirmed: false, username: 'sinconfirmar', bannedUntil: null }],
    [LIVE_PAYER, { id: LIVE_PAYER, email: 'live@example.com', confirmed: true, username: 'live', bannedUntil: null }],
  ]);
  subs = new Map<string, SubRow>([
    [PAYER, { plan_id: 'pro', status: 'active', source: 'stripe', current_period_end: '2026-11-27T00:00:00Z', stripe_subscription_id: 'sub_PAY', stripe_status: 'active' }],
    [LIVE_PAYER, { plan_id: 'max', status: 'active', source: 'stripe', current_period_end: '2026-11-27T00:00:00Z', stripe_subscription_id: 'sub_LIVE', stripe_status: 'active' }],
  ]);
  customers = new Map<string, { customerId: string; livemode: boolean }>([
    [PAYER, { customerId: 'cus_PAY', livemode: false }],
    [LIVE_PAYER, { customerId: 'cus_LIVE', livemode: true }],
  ]);
  moderation = new Map<string, Obj>();
  sessions = new Map<string, number>([[USER, 2], [PAYER, 1]]);
  usageResets: { user: string; scope: string }[] = [];
  actions: Obj[] = [];
  files = new Map<string, Record<string, string[]>>([[USER, { 'world-saves': [`${USER}/w/part1`, `${USER}/w/part2`], screenshots: [`${USER}/a.png`], clips: [] }]]);
  models = [
    { id: 'haiku', label: 'Haiku 5.5', active: true },
    { id: 'sonnet', label: 'Sonnet 5.5', active: true },
    { id: 'opus', label: 'Opus 5.5', active: true },
  ];
  plans = new Map<string, Obj>([
    ['go', this.plan('go', 'Go', 3.5, [{ priceId: 'price_go1', amount: 350, livemode: false, active: true }])],
    ['pro', this.plan('pro', 'Pro', 9.25, [{ priceId: 'price_pro1', amount: 925, livemode: false, active: true }])],
    ['old', { ...this.plan('old', 'Old', 1, []), active: false }],
  ]);

  plan(id: string, name: string, priceUsd: number, prices: Obj[]): Obj {
    return {
      id,
      name,
      active: true,
      sort: 10,
      priceUsd,
      currency: 'USD',
      monthlyBudgetUsd: 5,
      maxTokensPerRequest: 16000,
      maxCallsPerTurn: 40,
      requestsPerMinute: 40,
      subscribers: 0,
      models: [{ id: 'haiku', label: 'Haiku 5.5', modelActive: true, efforts: ['low', 'medium'], daily: 25, weekly: 115, sort: 10 }],
      prices: prices.map((p) => ({ currency: 'usd', interval: 'month', lookupKey: `venus_ai_${id}_monthly`, createdAt: '2026-10-01T00:00:00Z', ...p })),
    };
  }

  isAdmin(id: string): boolean {
    const u = this.users.get(id);
    return Boolean(u && this.admins.has(id) && u.confirmed && this.adminEmails.has(u.email.toLowerCase()) && !(u.bannedUntil && u.bannedUntil > NOW));
  }

  rpc = async (name: string, args: Obj): Promise<unknown> => {
    this.calls.push({ name, args: structuredClone(args) });
    const fail = this.failures.get(name);
    if (fail) throw Object.assign(new Error('falla forzada'), { code: fail });
    const user = (k = 'p_user') => args[k] as string;
    switch (name) {
      case 'admin_is_admin_user':
        return this.isAdmin(user());
      case 'admin_targets':
        return (args.p_ids as string[]).map((id) => {
          const u = this.users.get(id);
          const s = this.subs.get(id);
          const c = this.customers.get(id);
          return {
            id,
            exists: Boolean(u),
            email: u?.email ?? null,
            username: u?.username ?? null,
            isAdmin: this.isAdmin(id),
            planId: s?.plan_id ?? null,
            status: s?.status ?? null,
            source: s?.source ?? null,
            hasAccess: Boolean(s && (s.status === 'active' || s.status === 'trialing')),
            stripeSubscriptionId: s?.stripe_subscription_id ?? null,
            stripeStatus: s?.stripe_status ?? null,
            customerId: c?.customerId ?? null,
            customerLivemode: c ? c.livemode : null,
          };
        });
      case 'admin_set_plan': {
        if (!this.users.has(user())) return { applied: false, reason: 'not_found' };
        const plan = this.plans.get(args.p_plan as string);
        if (!plan || plan.active !== true) return { applied: false, reason: 'unknown_plan' };
        const prev = this.subs.get(user());
        this.subs.set(user(), {
          plan_id: args.p_plan as string,
          status: 'active',
          source: 'admin',
          current_period_end: (args.p_until as string | null) ?? null,
          stripe_subscription_id: null,
          stripe_status: null,
        });
        return { applied: true, previous: prev ? { planId: prev.plan_id, status: prev.status, source: prev.source } : null };
      }
      case 'admin_remove_plan': {
        const prev = this.subs.get(user());
        if (!prev) return { applied: false, reason: 'no_plan' };
        this.subs.set(user(), { ...prev, status: 'canceled', source: 'admin', stripe_subscription_id: null, stripe_status: null });
        return { applied: true, previous: { planId: prev.plan_id, status: prev.status, source: prev.source } };
      }
      case 'admin_moderate': {
        if (!this.users.has(user())) return { applied: false, reason: 'not_found' };
        const patch = args.p_patch as Obj;
        const row = { ...(this.moderation.get(user()) ?? {}), ...patch, updated_by: args.p_admin };
        this.moderation.set(user(), row);
        return { applied: true, moderation: row };
      }
      case 'admin_revoke_sessions': {
        const n = this.sessions.get(user()) ?? 0;
        this.sessions.delete(user());
        return n;
      }
      case 'admin_reset_usage':
        this.usageResets.push({ user: user(), scope: args.p_scope as string });
        return 3;
      case 'admin_log':
        this.actions.push({ admin_id: args.p_admin, admin_email: args.p_admin_email, action: args.p_action, target_user: args.p_target, details: args.p_details });
        return this.actions.length;
      case 'admin_plans':
        return { plans: [...this.plans.values()], models: this.models.filter((m) => m.active) };
      case 'admin_plan_json':
        return this.plans.get(args.p_plan as string) ?? null;
      case 'admin_update_plan': {
        const plan = this.plans.get(args.p_plan as string);
        if (!plan) throw Object.assign(new Error('plan'), { code: 'P0002' });
        const patch = args.p_patch as Obj;
        if ('price_usd' in patch) plan.priceUsd = patch.price_usd;
        if ('monthly_budget_usd' in patch) plan.monthlyBudgetUsd = patch.monthly_budget_usd;
        if ('active' in patch) plan.active = patch.active;
        return plan;
      }
      case 'billing_upsert_price': {
        const plan = this.plans.get(args.p_plan as string)!;
        const prices = plan.prices as Obj[];
        for (const p of prices) if (p.livemode === args.p_livemode && p.active && p.priceId !== args.p_price) p.active = false;
        const existing = prices.find((p) => p.priceId === args.p_price);
        if (existing) existing.active = true;
        else prices.unshift({ priceId: args.p_price, amount: args.p_amount, currency: 'usd', interval: 'month', livemode: args.p_livemode, active: true, lookupKey: args.p_lookup_key });
        return { plan: args.p_plan, priceId: args.p_price, active: true };
      }
      case 'admin_user_files': {
        // Como el SQL: en orden y hasta 1000 nombres por bucket.
        const files = this.files.get(user()) ?? { 'world-saves': [], screenshots: [], clips: [] };
        return Object.fromEntries(Object.entries(files).map(([bucket, names]) => [bucket, [...names].sort().slice(0, 1000)]));
      }
      case 'admin_overview':
        return { users: { total: this.users.size }, subscriptions: { active: this.subs.size, byPlan: [] }, revenue: { mrrUsd: 9.25, currency: 'usd' }, ai: { monthUsd: 1.5 } };
      case 'admin_list_users':
        return { total: 1, page: args.p_page, perPage: args.p_per_page, users: [{ id: USER, email: 'jugador@example.com' }] };
      case 'admin_user_detail':
        return this.users.has(user()) ? { account: { id: user(), email: this.users.get(user())!.email }, moderation: this.moderation.get(user()) ?? null } : null;
      case 'admin_list_actions':
        return { total: this.actions.length, page: args.p_page, perPage: args.p_per_page, actions: this.actions };
      default:
        throw Object.assign(new Error(`rpc desconocida ${name}`), { code: 'PGRST202' });
    }
  };

  callsTo(name: string): Obj[] {
    return this.calls.filter((c) => c.name === name).map((c) => c.args);
  }
}

export interface StripeCall {
  method: string;
  path: string;
  params: Record<string, string>;
  headers: Headers;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_fake' } });
}

function stripeError(status: number, type: string, code: string | null, param: string | null = null): Response {
  // El mensaje trae datos del cliente a propósito: no tiene que aparecer en ninguna respuesta del panel.
  return jsonResponse(status, { error: { type, code, param, message: 'Mensaje de Stripe con jugador@example.com' } });
}

export class FakeStripe {
  calls: StripeCall[] = [];
  seq = 0;
  failures = new Map<string, () => Response>();
  idempotent = new Map<string, Obj>();
  subscriptions = new Map<string, Obj>([
    ['sub_PAY', { id: 'sub_PAY', object: 'subscription', customer: 'cus_PAY', status: 'active', cancel_at_period_end: false }],
    ['sub_OLD', { id: 'sub_OLD', object: 'subscription', customer: 'cus_PAY', status: 'canceled', cancel_at_period_end: false }],
  ]);
  coupons = new Map<string, Obj>([
    ['VENUS20', { id: 'VENUS20', object: 'coupon', percent_off: 20, amount_off: null, currency: null, duration: 'repeating', duration_in_months: 3, valid: true, times_redeemed: 4, max_redemptions: 100, redeem_by: null, created: 1761955200, metadata: { app: 'venus-launcher' }, applies_to: { products: ['venus_ai_pro'] } }],
  ]);
  promos = new Map<string, Obj>([
    ['promo_1', { id: 'promo_1', object: 'promotion_code', code: 'VENUS20', active: true, coupon: { id: 'VENUS20' }, customer: 'cus_SECRET', expires_at: null, max_redemptions: null, times_redeemed: 4, restrictions: { first_time_transaction: true }, created: 1761955300 }],
  ]);
  prices = new Map<string, Obj>([
    ['price_go1', { id: 'price_go1', object: 'price', product: 'venus_ai_go', unit_amount: 350, active: true, tax_behavior: 'exclusive' }],
    ['price_pro1', { id: 'price_pro1', object: 'price', product: 'venus_ai_pro', unit_amount: 925, active: true, tax_behavior: 'unspecified' }],
  ]);
  products = new Map<string, Obj>([
    ['venus_ai_go', { id: 'venus_ai_go', object: 'product', default_price: 'price_go1' }],
    ['venus_ai_pro', { id: 'venus_ai_pro', object: 'product', default_price: 'price_pro1' }],
    ['venus_ai_old', { id: 'venus_ai_old', object: 'product', default_price: null }],
  ]);
  portal: Obj = {
    id: 'bpc_venus',
    object: 'billing_portal.configuration',
    active: true,
    metadata: { venus: 'ai' },
    features: {
      subscription_update: {
        enabled: true,
        products: [
          { product: 'venus_ai_go', prices: ['price_go1'] },
          { product: 'venus_ai_pro', prices: ['price_pro1'] },
        ],
      },
    },
  };

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const raw = method === 'POST' ? (typeof init.body === 'string' ? init.body : '') : url.search.replace(/^\?/, '');
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
    const headers = new Headers(init.headers);
    this.calls.push({ method, path: url.pathname, params, headers });
    if (url.origin !== 'https://api.stripe.com') throw new TypeError(`host no esperado: ${url.origin}`);
    const forced = this.failures.get(`${method} ${url.pathname}`);
    if (forced) return forced();
    const key = headers.get('idempotency-key');
    if (key && this.idempotent.has(key)) return jsonResponse(200, this.idempotent.get(key));
    const res = this.route(method, url.pathname, params);
    if (key && res.status === 200) this.idempotent.set(key, await res.clone().json());
    return res;
  };

  route(method: string, path: string, params: Record<string, string>): Response {
    let m: RegExpExecArray | null;
    const list = (data: Obj[]) => jsonResponse(200, { object: 'list', data, has_more: false });
    if (method === 'GET' && path === '/v1/subscriptions') return list([...this.subscriptions.values()].filter((s) => s.customer === params.customer));
    if ((m = /^\/v1\/subscriptions\/(\w+)$/.exec(path))) {
      const s = this.subscriptions.get(m[1]);
      if (!s) return stripeError(404, 'invalid_request_error', 'resource_missing', 'id');
      if (method === 'GET') return jsonResponse(200, s);
      if (method === 'DELETE') {
        s.status = 'canceled';
        return jsonResponse(200, s);
      }
      if (method === 'POST') {
        s.cancel_at_period_end = params.cancel_at_period_end === 'true';
        return jsonResponse(200, s);
      }
    }
    if (path === '/v1/coupons' && method === 'GET') return list([...this.coupons.values()]);
    if (path === '/v1/coupons' && method === 'POST') {
      const id = `cpn_${++this.seq}`;
      const c = {
        id,
        object: 'coupon',
        name: params.name ?? null,
        percent_off: params.percent_off ? Number(params.percent_off) : null,
        amount_off: params.amount_off ? Number(params.amount_off) : null,
        currency: params.currency ?? null,
        duration: params.duration,
        duration_in_months: params.duration_in_months ? Number(params.duration_in_months) : null,
        max_redemptions: params.max_redemptions ? Number(params.max_redemptions) : null,
        redeem_by: params.redeem_by ? Number(params.redeem_by) : null,
        valid: true,
        times_redeemed: 0,
        created: 1762000000,
        metadata: { app: params['metadata[app]'] },
        applies_to: params['applies_to[products][0]'] ? { products: Object.keys(params).filter((k) => k.startsWith('applies_to[products]')).map((k) => params[k]) } : null,
      };
      this.coupons.set(id, c);
      return jsonResponse(200, c);
    }
    if ((m = /^\/v1\/coupons\/([\w-]+)$/.exec(path))) {
      const c = this.coupons.get(m[1]);
      if (!c) return stripeError(404, 'invalid_request_error', 'resource_missing', 'id');
      if (method === 'GET') return jsonResponse(200, c);
      if (method === 'DELETE') {
        this.coupons.delete(m[1]);
        return jsonResponse(200, { id: m[1], object: 'coupon', deleted: true });
      }
    }
    if (path === '/v1/promotion_codes' && method === 'GET') return list([...this.promos.values()]);
    if (path === '/v1/promotion_codes' && method === 'POST') {
      if ([...this.promos.values()].some((p) => p.active && p.code === params.code)) return stripeError(400, 'invalid_request_error', null, 'code');
      if (!this.coupons.has(params.coupon)) return stripeError(400, 'invalid_request_error', 'resource_missing', 'coupon');
      const id = `promo_${++this.seq}`;
      const p = {
        id,
        object: 'promotion_code',
        code: params.code,
        active: true,
        coupon: this.coupons.get(params.coupon),
        customer: null,
        expires_at: params.expires_at ? Number(params.expires_at) : null,
        max_redemptions: params.max_redemptions ? Number(params.max_redemptions) : null,
        times_redeemed: 0,
        restrictions: { first_time_transaction: params['restrictions[first_time_transaction]'] === 'true' },
        created: 1762000001,
      };
      this.promos.set(id, p);
      return jsonResponse(200, p);
    }
    if ((m = /^\/v1\/promotion_codes\/(\w+)$/.exec(path)) && method === 'POST') {
      const p = this.promos.get(m[1]);
      if (!p) return stripeError(404, 'invalid_request_error', 'resource_missing', 'id');
      p.active = params.active === 'true';
      return jsonResponse(200, p);
    }
    if (path === '/v1/prices' && method === 'POST') {
      const id = `price_new${++this.seq}`;
      const p = { id, object: 'price', product: params.product, unit_amount: Number(params.unit_amount), active: true, lookup_key: params.lookup_key, livemode: false };
      this.prices.set(id, p);
      return jsonResponse(200, p);
    }
    if ((m = /^\/v1\/prices\/(\w+)$/.exec(path))) {
      const p = this.prices.get(m[1]);
      if (!p) return stripeError(404, 'invalid_request_error', 'resource_missing', 'id');
      if (method === 'GET') return jsonResponse(200, p);
      if (method === 'POST') {
        if ('active' in params) p.active = params.active === 'true';
        return jsonResponse(200, p);
      }
    }
    if ((m = /^\/v1\/products\/(\w+)$/.exec(path))) {
      const p = this.products.get(m[1]);
      if (!p) return stripeError(404, 'invalid_request_error', 'resource_missing', 'id');
      if (method === 'GET') return jsonResponse(200, p);
      if (method === 'POST') {
        if (params.default_price) p.default_price = params.default_price;
        return jsonResponse(200, p);
      }
    }
    if (path === '/v1/billing_portal/configurations' && method === 'GET') return list([this.portal]);
    if ((m = /^\/v1\/billing_portal\/configurations\/(\w+)$/.exec(path))) {
      if (m[1] !== this.portal.id) return stripeError(404, 'invalid_request_error', 'resource_missing', 'id');
      if (method === 'GET') return jsonResponse(200, this.portal);
      if (method === 'POST') {
        const products: Obj[] = [];
        for (let i = 0; params[`features[subscription_update][products][${i}][product]`]; i++) {
          const prices: string[] = [];
          for (let j = 0; params[`features[subscription_update][products][${i}][prices][${j}]`]; j++) prices.push(params[`features[subscription_update][products][${i}][prices][${j}]`]);
          products.push({ product: params[`features[subscription_update][products][${i}][product]`], prices });
        }
        (this.portal.features as Obj).subscription_update = { ...((this.portal.features as Obj).subscription_update as Obj), products };
        return jsonResponse(200, this.portal);
      }
    }
    return stripeError(404, 'invalid_request_error', 'resource_missing', null);
  }

  callsTo(method: string, path: string | RegExp): StripeCall[] {
    return this.calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)));
  }
}

export function recorder() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (m: string) => lines.push(`info ${m}`),
      warn: (m: string) => lines.push(`warn ${m}`),
      error: (m: string) => lines.push(`error ${m}`),
    },
  };
}

/** Tokens de prueba -> usuario de Auth. */
export async function fakeVerify(token: string): Promise<AuthResult> {
  const users: Record<string, AuthResult> = {
    admin: { status: 'ok', user: { userId: ADMIN, email: 'admin@example.com', emailConfirmed: true, anonymous: false } },
    admin2: { status: 'ok', user: { userId: ADMIN2, email: 'otro.admin@example.com', emailConfirmed: true, anonymous: false } },
    user: { status: 'ok', user: { userId: USER, email: 'jugador@example.com', emailConfirmed: true, anonymous: false } },
    unconfirmed: { status: 'ok', user: { userId: UNCONFIRMED, email: 'otro.admin@example.com', emailConfirmed: false, anonymous: false } },
    anon: { status: 'ok', user: { userId: 'anon-id', email: null, emailConfirmed: false, anonymous: true } },
    down: { status: 'unavailable' },
  };
  return users[token] ?? { status: 'invalid' };
}

export function setup(overrides: Partial<AdminDeps> & { noStripe?: boolean; noStorage?: boolean; livemode?: boolean } = {}) {
  const db = new FakeAdminDb();
  const stripe = new FakeStripe();
  const log = recorder();
  const auth = { bans: [] as { id: string; duration: string }[], deleted: [] as string[], order: [] as string[], fail: new Set<string>() };
  // stuck: Storage responde bien pero no borra nada.
  const storage = { removed: [] as { bucket: string; paths: string[] }[], stuck: false };
  const deps: AdminDeps = {
    supabaseReady: true,
    verifyUser: fakeVerify,
    rpc: db.rpc,
    authAdmin: {
      async setBan(id, duration) {
        if (auth.fail.has(id)) throw new AuthAdminError(500);
        auth.bans.push({ id, duration });
        auth.order.push(`ban:${id}`);
      },
      async deleteUser(id) {
        if (auth.fail.has(id)) throw new AuthAdminError(500);
        auth.deleted.push(id);
        auth.order.push(`delete:${id}`);
        db.users.delete(id);
      },
    },
    storage: overrides.noStorage
      ? null
      : {
          async remove(bucket, paths) {
            storage.removed.push({ bucket, paths });
            auth.order.push(`files:${bucket}`);
            if (storage.stuck) return 0;
            const gone = new Set(paths);
            for (const files of db.files.values()) if (files[bucket]) files[bucket] = files[bucket].filter((p) => !gone.has(p));
            return paths.length;
          },
        },
    stripe: overrides.noStripe ? null : createAdminStripe({ secretKey: 'sk_test_fake12345678', fetch: stripe.fetch }),
    livemode: overrides.livemode ?? false,
    portalConfiguration: null,
    nowMs: () => NOW,
    logger: log.logger,
    ...overrides,
  };
  const handler = createAdminHandler(deps);
  const URL_FN = 'https://proyecto.supabase.co/functions/v1/admin';
  async function call(action: string, payload?: unknown, token = 'admin') {
    const res = await handler(
      new Request(URL_FN, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, apikey: 'anon', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Obj, text };
  }
  return { db, stripe, log, auth, storage, deps, handler, call, URL_FN };
}
