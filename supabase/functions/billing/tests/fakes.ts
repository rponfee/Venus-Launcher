// Dobles para las pruebas de "billing" y "stripe-webhook" (no es un archivo de pruebas: no termina en .test.ts).
// - FakeStripe: la API REST de Stripe en memoria, como fetch (registra cada pedido con sus parámetros).
// - FakeDb: las funciones SQL de 0009_billing.sql en memoria, con las mismas reglas (para probar los flujos;
//   el SQL real se revisa aparte). billing_apply_subscription es la de 0013 (con el tope del presupuesto).

export type Params = Record<string, string>;

export interface StripeCall {
  method: string;
  path: string;
  params: Params;
  headers: Headers;
}

type Obj = Record<string, unknown>;

export const USER = '11111111-2222-4333-8444-555555555555';
export const OTHER_USER = '99999999-8888-4777-8666-555555555555';
export const EMAIL = 'jugador.secreto@example.com';

export const PRICES: Record<string, { plan: string; amount: number }> = {
  price_go1: { plan: 'go', amount: 350 },
  price_pro1: { plan: 'pro', amount: 925 },
  price_super1: { plan: 'super', amount: 1350 },
  price_ultra1: { plan: 'ultra', amount: 2550 },
  price_max1: { plan: 'max', amount: 3650 },
  price_supreme1: { plan: 'supreme', amount: 4250 },
};

export const NOW = Date.UTC(2026, 10, 1, 12, 0, 0); // 2026-11-01T12:00:00Z
export const NOW_SEC = Math.floor(NOW / 1000);
export const DAY = 86400;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_fake', ...headers } });
}

function stripeError(status: number, type: string, code: string | null, param: string | null = null, message = 'Mensaje de Stripe con datos'): Response {
  return jsonResponse(status, { error: { type, code, param, message } });
}

/** Suscripción con la forma de la API 2025-03-31.basil (el período en los ítems). */
export function subscription(overrides: Obj = {}, item: Obj = {}): Obj {
  const price = (item.price as string) ?? 'price_pro1';
  const base: Obj = {
    id: 'sub_A1',
    object: 'subscription',
    customer: 'cus_A1',
    status: 'active',
    livemode: false,
    created: NOW_SEC - 10 * DAY,
    cancel_at_period_end: false,
    cancel_at: null,
    ended_at: null,
    trial_end: null,
    metadata: { user_id: USER, plan_id: PRICES[price]?.plan ?? 'pro' },
    latest_invoice: 'in_A1',
    items: {
      object: 'list',
      data: [
        {
          id: 'si_A1',
          object: 'subscription_item',
          price: { id: price, object: 'price', unit_amount: PRICES[price]?.amount ?? 999, currency: 'usd' },
          quantity: 1,
          current_period_start: NOW_SEC - 2 * DAY,
          current_period_end: NOW_SEC + 28 * DAY,
          ...item,
        },
      ],
    },
  };
  return { ...base, ...overrides };
}

export class FakeStripe {
  calls: StripeCall[] = [];
  customers = new Map<string, Obj>();
  subscriptions = new Map<string, Obj>();
  sessions = new Map<string, Obj>();
  portalConfigurations: Obj[] = [{ id: 'bpc_venus', object: 'billing_portal.configuration', active: true, is_default: false, metadata: { venus: 'ai' } }];
  /** Respuestas forzadas por "MÉTODO /ruta" (por ejemplo 'GET /v1/subscriptions/sub_A1'). */
  failures = new Map<string, () => Response>();
  /** Rechaza los portales con flow_data (configuración que no permite el cambio). */
  rejectFlow = false;
  seq = 0;

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const raw = method === 'GET' ? url.search.replace(/^\?/, '') : typeof init.body === 'string' ? init.body : '';
    const params: Params = {};
    for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
    const headers = new Headers(init.headers);
    const path = url.pathname;
    this.calls.push({ method, path, params, headers });
    if (url.origin !== 'https://api.stripe.com') throw new TypeError(`host no esperado: ${url.origin}`);
    const forced = this.failures.get(`${method} ${path}`);
    if (forced) return forced();
    return this.route(method, path, params);
  };

  route(method: string, path: string, params: Params): Response {
    let m: RegExpExecArray | null;
    if (method === 'GET' && (m = /^\/v1\/customers\/([\w]+)$/.exec(path))) {
      const c = this.customers.get(m[1]);
      return c ? jsonResponse(200, c) : stripeError(404, 'invalid_request_error', 'resource_missing', 'id');
    }
    if (method === 'POST' && path === '/v1/customers') {
      const id = `cus_new${++this.seq}`;
      const c = { id, object: 'customer', email: params.email ?? null, metadata: { user_id: params['metadata[user_id]'] } };
      this.customers.set(id, c);
      return jsonResponse(200, c);
    }
    if (method === 'GET' && path === '/v1/subscriptions') {
      const data = [...this.subscriptions.values()].filter((s) => s.customer === params.customer);
      return jsonResponse(200, { object: 'list', data, has_more: false });
    }
    if (method === 'GET' && (m = /^\/v1\/subscriptions\/([\w]+)$/.exec(path))) {
      const s = this.subscriptions.get(m[1]);
      return s ? jsonResponse(200, s) : stripeError(404, 'invalid_request_error', 'resource_missing', 'id');
    }
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      if (!this.customers.has(params.customer)) return stripeError(400, 'invalid_request_error', 'resource_missing', 'customer');
      const id = `cs_test_${++this.seq}`;
      const session = {
        id,
        object: 'checkout.session',
        mode: params.mode,
        status: 'open',
        customer: params.customer,
        metadata: { user_id: params['metadata[user_id]'], plan_id: params['metadata[plan_id]'] },
        url: `https://checkout.stripe.com/c/pay/${id}`,
        expires_at: NOW_SEC + DAY,
      };
      this.sessions.set(id, session);
      return jsonResponse(200, session);
    }
    if (method === 'GET' && path === '/v1/checkout/sessions') {
      const data = [...this.sessions.values()].filter((s) => s.customer === params.customer && (!params.status || s.status === params.status));
      return jsonResponse(200, { object: 'list', data, has_more: false });
    }
    if (method === 'POST' && (m = /^\/v1\/checkout\/sessions\/(\w+)\/expire$/.exec(path))) {
      const s = this.sessions.get(m[1]);
      if (!s) return stripeError(404, 'invalid_request_error', 'resource_missing', 'session');
      s.status = 'expired';
      s.url = null;
      return jsonResponse(200, s);
    }
    if (method === 'POST' && path === '/v1/billing_portal/sessions') {
      if (!this.customers.has(params.customer)) return stripeError(400, 'invalid_request_error', 'resource_missing', 'customer');
      if (this.rejectFlow && params['flow_data[type]']) return stripeError(400, 'invalid_request_error', 'parameter_invalid', 'flow_data');
      const id = `bps_${++this.seq}`;
      return jsonResponse(200, { id, object: 'billing_portal.session', url: `https://billing.stripe.com/p/session/test_${id}` });
    }
    if (method === 'GET' && path === '/v1/billing_portal/configurations') {
      return jsonResponse(200, { object: 'list', data: this.portalConfigurations, has_more: false });
    }
    return stripeError(404, 'invalid_request_error', 'resource_missing', null);
  }

  /** Pedidos a una ruta (sin contar la búsqueda de la configuración del portal si no se pide). */
  callsTo(method: string, path: string | RegExp): StripeCall[] {
    return this.calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)));
  }
}

export interface SubRow {
  user_id: string;
  plan_id: string;
  status: string;
  current_period_end: string | null;
  source: string;
  external_ref: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  cancel_at_period_end: boolean;
  grace_until: string | null;
  stripe_status: string | null;
  last_synced_at: string | null;
  /** 0013: tope del presupuesto después de subir de plan en medio del período (y hasta cuándo vale). */
  budget_cap_usd?: number | null;
  budget_cap_until?: string | null;
}

/** timestamptz - interval '1 month' de Postgres (en UTC): si el día no existe en el mes anterior, el último. */
function monthBefore(ms: number): number {
  const d = new Date(ms);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).getUTCDate();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

export class FakeDb {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  users = new Set<string>([USER, OTHER_USER]);
  plans = new Map<string, { name: string; sort: number; active: boolean; budget: number }>([
    ['go', { name: 'Go', sort: 10, active: true, budget: 1.5 }],
    ['pro', { name: 'Pro', sort: 20, active: true, budget: 5 }],
    ['super', { name: 'Super', sort: 30, active: true, budget: 7 }],
    ['ultra', { name: 'Ultra', sort: 40, active: true, budget: 12 }],
    ['max', { name: 'Max', sort: 50, active: true, budget: 19 }],
    ['supreme', { name: 'Supreme', sort: 60, active: true, budget: 23 }],
  ]);
  prices = Object.entries(PRICES).map(([priceId, p]) => ({ priceId, plan: p.plan, amount: p.amount, livemode: false, active: true }));
  customers = new Map<string, { customerId: string; livemode: boolean }>();
  subs = new Map<string, SubRow>();
  events = new Map<string, { type: string; processedAt: string | null; outcome: string | null; attempts: number }>();
  /** Fallas forzadas por nombre de función (código de error de PostgREST / Postgres). */
  failures = new Map<string, string>();
  nowMs: () => number = () => NOW;

  rpc = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    this.calls.push({ name, args });
    const code = this.failures.get(name);
    if (code) throw Object.assign(new Error('falla simulada'), { code });
    switch (name) {
      case 'billing_state':
        return this.state(String(args.p_user), args.p_livemode as boolean | null);
      case 'billing_prices':
        return this.prices
          .filter((p) => p.active && p.livemode === Boolean(args.p_livemode) && this.plans.get(p.plan)?.active)
          .map((p) => ({ plan: p.plan, planName: this.plans.get(p.plan)!.name, sort: this.plans.get(p.plan)!.sort, priceId: p.priceId, amount: p.amount, currency: 'usd', interval: 'month' }))
          .sort((a, b) => a.sort - b.sort);
      case 'billing_price_map':
        return Object.fromEntries(this.prices.map((p) => [p.priceId, p.plan]));
      case 'billing_user_for_customer':
        for (const [user, c] of this.customers) if (c.customerId === args.p_customer) return user;
        return null;
      case 'billing_link_customer':
        return this.link(String(args.p_user), String(args.p_customer), Boolean(args.p_livemode), Boolean(args.p_replace));
      case 'billing_begin_event': {
        const id = String(args.p_id);
        const ev = this.events.get(id);
        if (!ev) {
          this.events.set(id, { type: String(args.p_type), processedAt: null, outcome: null, attempts: 1 });
          return 'process';
        }
        if (ev.processedAt) return 'duplicate';
        ev.attempts++;
        return 'process';
      }
      case 'billing_finish_event': {
        const ev = this.events.get(String(args.p_id));
        if (!ev) return false;
        ev.processedAt = new Date(this.nowMs()).toISOString();
        ev.outcome = String(args.p_outcome);
        return true;
      }
      case 'billing_apply_subscription':
        return this.apply(args);
      default:
        throw Object.assign(new Error('desconocida'), { code: 'PGRST202' });
    }
  };

  grants(row: { status: string; current_period_end: string | null; plan_id: string }): boolean {
    return ['active', 'trialing'].includes(row.status) && (row.current_period_end === null || Date.parse(row.current_period_end) > this.nowMs()) && Boolean(this.plans.get(row.plan_id)?.active);
  }

  state(user: string, livemode: boolean | null): Record<string, unknown> | null {
    if (!user) return null;
    const s = this.subs.get(user);
    const c = this.customers.get(user);
    const customer = c && (livemode === null || livemode === undefined || c.livemode === livemode) ? c.customerId : null;
    const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);
    return {
      plan: s?.plan_id ?? null,
      planName: s ? (this.plans.get(s.plan_id)?.name ?? null) : null,
      status: s?.status ?? null,
      active: s ? this.grants(s) : false,
      currentPeriodEnd: iso(s?.current_period_end),
      cancelAtPeriodEnd: s?.cancel_at_period_end ?? false,
      graceUntil: iso(s?.grace_until),
      inGrace: Boolean(s && s.stripe_status === 'past_due' && s.grace_until && Date.parse(s.grace_until) > this.nowMs()),
      source: s?.source ?? null,
      stripeStatus: s?.stripe_status ?? null,
      managedByStripe: Boolean(s && s.source === 'stripe' && s.stripe_subscription_id),
      hasCustomer: Boolean(customer),
      lastSyncedAt: iso(s?.last_synced_at),
      customerId: customer,
      stripeSubscriptionId: s?.stripe_subscription_id ?? null,
    };
  }

  link(user: string, customer: string, livemode: boolean, replace: boolean): string | null {
    if (!this.users.has(user)) return null;
    const current = this.customers.get(user);
    if (current) {
      if (current.customerId === customer) return customer;
      if (current.livemode === livemode && !replace) return current.customerId;
    }
    for (const [u, c] of this.customers) if (c.customerId === customer && u !== user) throw Object.assign(new Error('dup'), { code: '23505' });
    this.customers.set(user, { customerId: customer, livemode });
    return customer;
  }

  apply(a: Record<string, unknown>): Record<string, unknown> {
    const user = String(a.p_user);
    const status = String(a.p_status);
    if (!['active', 'trialing', 'canceled'].includes(status)) throw Object.assign(new Error('22023'), { code: '22023' });
    if (status !== 'canceled' && !a.p_current_period_end) throw Object.assign(new Error('22023'), { code: '22023' });
    if (!this.users.has(user)) return { applied: false, reason: 'unknown_user' };
    if (!this.plans.has(String(a.p_plan))) return { applied: false, reason: 'unknown_plan' };
    const end = (a.p_current_period_end as string | null) ?? null;
    const synced = String(a.p_synced_at);
    const newGrants = ['active', 'trialing'].includes(status) && end !== null && Date.parse(end) > this.nowMs();
    const row = this.subs.get(user);
    let switched = false;
    if (row) {
      if (row.stripe_subscription_id === a.p_subscription) {
        if (row.last_synced_at && Date.parse(synced) < Date.parse(row.last_synced_at)) return { applied: false, reason: 'stale' };
      } else {
        const oldGrants = this.grants(row);
        if (oldGrants && !newGrants) return { applied: false, reason: 'other_active' };
        switched = oldGrants && Boolean(row.stripe_subscription_id);
      }
    }
    // 0013: la misma suscripción conserva su tope vigente; al cambiar de plan con acceso, lo pagado más la
    // diferencia de presupuesto prorrateada por lo que queda del período (al bajar, resta).
    let cap: number | null = null;
    let capUntil: string | null = null;
    if (row && row.stripe_subscription_id === a.p_subscription) {
      if (row.budget_cap_until && Date.parse(row.budget_cap_until) > this.nowMs()) {
        cap = row.budget_cap_usd ?? null;
        capUntil = row.budget_cap_until;
      }
      if (row.plan_id !== a.p_plan && newGrants) {
        const oldBudget = this.plans.get(row.plan_id)?.budget ?? 0;
        const newBudget = this.plans.get(String(a.p_plan))!.budget;
        const endMs = Date.parse(end as string);
        const fraction = Math.min((endMs - this.nowMs()) / (endMs - monthBefore(endMs)), 1);
        cap = Math.max(Math.round(((cap ?? oldBudget) + (newBudget - oldBudget) * fraction) * 1e4) / 1e4, 0);
        capUntil = end;
      }
    }
    for (const [u, r] of this.subs) {
      if (u !== user && r.stripe_subscription_id === a.p_subscription) {
        r.status = 'canceled';
        r.stripe_subscription_id = null;
        r.last_synced_at = synced;
      }
    }
    this.subs.set(user, {
      user_id: user,
      plan_id: String(a.p_plan),
      status,
      current_period_end: end,
      source: 'stripe',
      external_ref: String(a.p_subscription),
      stripe_customer_id: String(a.p_customer),
      stripe_subscription_id: String(a.p_subscription),
      stripe_price_id: (a.p_price as string) ?? null,
      cancel_at_period_end: a.p_cancel_at_period_end === true,
      grace_until: (a.p_grace_until as string | null) ?? null,
      stripe_status: (a.p_stripe_status as string) ?? null,
      last_synced_at: synced,
      budget_cap_usd: cap,
      budget_cap_until: capUntil,
    });
    if (!this.customers.has(user) && ![...this.customers.values()].some((c) => c.customerId === a.p_customer)) {
      this.customers.set(user, { customerId: String(a.p_customer), livemode: a.p_livemode === true });
    }
    return { applied: true, reason: null, granted: newGrants, switched, plan: a.p_plan, status, currentPeriodEnd: end };
  }

  callsTo(name: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.name === name).map((c) => c.args);
  }
}

export interface LogRecorder {
  lines: string[];
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export function recorder(): LogRecorder {
  const lines: string[] = [];
  return { lines, logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) } };
}
