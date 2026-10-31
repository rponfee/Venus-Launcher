// Dobles para las pruebas de pagos: base de datos en memoria (las RPC payments_*), Mercado Pago y PayPal falsos.
import type { Order } from '../../_shared/pagos/sync.ts';

export const USER = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const ADMIN = '33333333-3333-4333-8333-333333333333';
export const NOW = Date.parse('2026-10-31T15:00:00Z');
export const BASE = 'https://proyecto.supabase.co/functions/v1';

let seq = 0;
const uuid = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++seq).padStart(12, '0')}`;

export function recorder() {
  const lines: string[] = [];
  return { lines, logger: { warn: (m: string) => lines.push(`warn ${m}`), error: (m: string) => lines.push(`error ${m}`) } };
}

const PRICES: Record<string, { name: string; usd: number; budget: number }> = {
  basic: { name: 'Basic', usd: 4, budget: 2 },
  go: { name: 'Go', usd: 8, budget: 4.5 },
  pro: { name: 'Pro', usd: 15, budget: 8.5 },
  max: { name: 'Max', usd: 35, budget: 20 },
};

export class FakeDb {
  orders = new Map<string, Order & { userId: string }>();
  calls: { name: string; args: Record<string, unknown> }[] = [];
  secrets: Record<string, unknown> = {
    mpAccessToken: 'TEST-1234567890-abcdef-1234567890abcdef-123456',
    mpWebhookSecret: 'secretodelwebhook1234',
    paypalClientId: 'AbcdefghijAbcdefghij1234',
    paypalSecret: 'AbcdefghijAbcdefghij5678',
    paypalWebhookId: null,
    paypalEnv: 'sandbox',
    statementDescriptor: 'VENUS LAUNCHER',
  };
  enabled: Record<string, boolean> = { mercado_pago: true, paypal: true };
  arsPerUsd = 1450;
  admins = new Set([ADMIN]);
  saved: unknown[] = [];

  quote(plan: string, provider: string) {
    const p = PRICES[plan];
    if (!p) return null;
    const total = provider === 'mercado_pago' ? Math.ceil((p.usd * this.arsPerUsd) / 100) * 100 : p.usd;
    return { currency: provider === 'mercado_pago' ? 'ARS' : 'USD', total, priceUsd: p.usd, budgetUsd: p.budget, planName: p.name };
  }

  rpc = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    this.calls.push({ name, args });
    const fail = (code: string, message: string) => Object.assign(new Error(message), { code, message });
    switch (name) {
      case 'payments_secrets': return { ...this.secrets };
      case 'admin_is_admin_user': return this.admins.has(String(args.p_user));
      case 'payments_admin_get': return { mercadoPago: { enabled: true }, paypal: { enabled: true } };
      case 'payments_admin_orders': return [...this.orders.values()];
      case 'payments_admin_save': {
        const s = (args.p_secrets ?? {}) as Record<string, string>;
        if (s.mpAccessToken && !/^(APP_USR|TEST)-/.test(s.mpAccessToken)) throw fail('22023', 'bad_secret:mpAccessToken');
        this.saved.push(args);
        return {};
      }
      case 'payments_create_order': {
        const provider = String(args.p_provider);
        if (!this.enabled[provider]) throw fail('22023', 'provider_disabled');
        const q = this.quote(String(args.p_plan), provider);
        if (!q) throw fail('22023', 'unknown_plan');
        const reuse = [...this.orders.values()].find((o) => o.userId === args.p_user && o.plan === args.p_plan && o.provider === provider && o.status === 'pending' && o.checkoutUrl);
        if (reuse) return { ...reuse, reused: true };
        const id = uuid();
        const order = {
          id, userId: String(args.p_user), plan: String(args.p_plan), planName: q.planName, provider, currency: q.currency,
          amount: q.total, priceUsd: q.priceUsd, budgetUsd: q.budgetUsd, status: 'pending', providerStatus: null,
          providerOrderId: null, checkoutUrl: null, live: args.p_live === true, createdAt: new Date(NOW).toISOString(),
          paidAt: null, expiresAt: new Date(NOW + 2 * 86400000).toISOString(),
        } as unknown as Order & { userId: string };
        this.orders.set(id, order);
        return { ...order, reused: false };
      }
      case 'payments_attach_checkout': {
        const o = this.orders.get(String(args.p_order));
        if (!o) throw fail('P0002', 'order_not_found');
        o.providerOrderId = String(args.p_provider_order_id);
        o.checkoutUrl = String(args.p_url);
        return { ...o };
      }
      case 'payments_get_order': {
        const o = this.orders.get(String(args.p_order));
        if (!o || (args.p_user && o.userId !== args.p_user)) return null;
        return { ...o };
      }
      case 'payments_find_order': {
        const o = [...this.orders.values()].find((x) => x.provider === args.p_provider && x.providerOrderId === args.p_provider_order_id);
        return o ? { ...o } : null;
      }
      case 'payments_touch': {
        const o = this.orders.get(String(args.p_order));
        if (o && args.p_provider_status) o.providerStatus = String(args.p_provider_status);
        return null;
      }
      case 'payments_mark_paid': {
        const o = this.orders.get(String(args.p_order));
        if (!o) return { applied: false, reason: 'order_not_found' };
        if (o.status === 'paid') return { applied: false, reason: 'already_paid' };
        if (String(args.p_currency).toUpperCase() !== o.currency || Number(args.p_amount) < o.amount - 0.01) {
          o.providerStatus = 'amount_mismatch';
          return { applied: false, reason: 'amount_mismatch' };
        }
        o.status = 'paid';
        o.paidAt = new Date(NOW).toISOString();
        o.providerStatus = String(args.p_provider_status);
        (o as unknown as Record<string, unknown>).paymentId = args.p_payment_id;
        return { applied: true };
      }
      case 'payments_mark_status': {
        const o = this.orders.get(String(args.p_order));
        if (!o) return { applied: false };
        if (args.p_status === 'refunded' && o.status !== 'paid') return { applied: false };
        o.status = args.p_status as Order['status'];
        o.providerStatus = String(args.p_provider_status ?? args.p_status);
        return { applied: true };
      }
      default: throw fail('42883', `rpc desconocida: ${name}`);
    }
  };
}

type Route = (url: URL, init: RequestInit) => { status: number; body: unknown } | null;

/** fetch falso: Mercado Pago y PayPal. Guarda los pedidos para revisarlos. */
export class FakeProviders {
  requests: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  mpPayments: Record<string, unknown>[] = [];
  paypalOrders = new Map<string, Record<string, unknown>>();
  captureStatus = 'COMPLETED';
  paypalVerify = 'SUCCESS';
  mpAuthFails = false;
  extra: Route[] = [];
  private ppSeq = 0;

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    let body: unknown = null;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    this.requests.push({ method: init.method ?? 'GET', url: url.href, body, headers });
    for (const r of this.extra) {
      const out = r(url, init);
      if (out) return Response.json(out.body, { status: out.status });
    }
    const res = this.route(url, init.method ?? 'GET', body as Record<string, unknown>);
    return Response.json(res.body, { status: res.status });
  };

  private route(url: URL, method: string, body: Record<string, unknown>): { status: number; body: unknown } {
    if (url.host === 'api.mercadopago.com') {
      if (this.mpAuthFails) return { status: 401, body: { error: 'unauthorized' } };
      if (url.pathname === '/checkout/preferences' && method === 'POST') {
        return { status: 201, body: { id: `pref-${this.requests.length}`, init_point: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=x', sandbox_init_point: 'https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=x' } };
      }
      if (url.pathname === '/v1/payments/search') {
        const ref = url.searchParams.get('external_reference');
        return { status: 200, body: { results: this.mpPayments.filter((p) => p.external_reference === ref) } };
      }
      const m = /^\/v1\/payments\/(\d+)$/.exec(url.pathname);
      if (m) {
        const p = this.mpPayments.find((x) => String(x.id) === m[1]);
        return p ? { status: 200, body: p } : { status: 404, body: { error: 'not_found' } };
      }
      if (url.pathname === '/users/me') return { status: 200, body: { id: 123, nickname: 'VENUS', site_id: 'MLA' } };
    }
    if (url.host === 'api-m.sandbox.paypal.com' || url.host === 'api-m.paypal.com') {
      if (url.pathname === '/v1/oauth2/token') return { status: 200, body: { access_token: 'pp-token', expires_in: 32000 } };
      if (url.pathname === '/v2/checkout/orders' && method === 'POST') {
        const id = `PPORDER${String(++this.ppSeq).padStart(6, '0')}`;
        const unit = (body.purchase_units as Record<string, unknown>[])[0];
        this.paypalOrders.set(id, { id, status: 'CREATED', purchase_units: [{ custom_id: unit.custom_id, amount: unit.amount }] });
        return { status: 201, body: { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'https://x' }, { rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] } };
      }
      const cap = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname);
      if (cap) {
        const o = this.paypalOrders.get(cap[1]);
        if (!o) return { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } };
        if (o.status === 'COMPLETED') return { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] } };
        if (o.status !== 'APPROVED') return { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] } };
        const unit = (o.purchase_units as Record<string, unknown>[])[0];
        o.status = this.captureStatus === 'COMPLETED' ? 'COMPLETED' : 'APPROVED';
        unit.payments = { captures: [{ id: `CAP${cap[1]}`, status: this.captureStatus, amount: unit.amount, status_details: this.captureStatus === 'PENDING' ? { reason: 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION' } : undefined }] };
        return { status: 201, body: o };
      }
      const get = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname);
      if (get) {
        const o = this.paypalOrders.get(get[1]);
        return o ? { status: 200, body: o } : { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } };
      }
      if (url.pathname === '/v1/notifications/verify-webhook-signature') return { status: 200, body: { verification_status: this.paypalVerify } };
    }
    return { status: 599, body: { error: `ruta no prevista ${method} ${url.href}` } };
  }

  approvePaypal(id: string) {
    const o = this.paypalOrders.get(id);
    if (o) o.status = 'APPROVED';
  }

  addMpPayment(p: Record<string, unknown>) {
    this.mpPayments.unshift({ live_mode: false, currency_id: 'ARS', status_detail: 'accredited', date_created: '2026-10-31T12:00:00.000-03:00', ...p });
  }
}
