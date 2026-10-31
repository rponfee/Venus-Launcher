'use strict';
// Planes de Venus IA: estado (RPC billing_my_state), catálogo con precios en pesos y dólares (RPC payments_catalog)
// y pago directo con Mercado Pago o PayPal (Edge Function "payments"). El pago se hace en el navegador; el launcher
// pregunta cada tanto cómo va la orden y, cuando el proveedor la confirma, avisa con billing:changed.
// Sin Electron: ../billing.js le pasa las dependencias reales y las pruebas, dobles.

const PLAN_ID = /^[a-z][a-z0-9_-]{1,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set(['mercado_pago', 'paypal']);
const TERMINAL = new Set(['paid', 'failed', 'cancelled', 'expired', 'refunded']);

// Lista fija para cuando no se puede leer el catálogo del servidor (sin nube o sin red). Precios de lista en centavos.
const STATIC_PLANS = Object.freeze([
  { id: 'basic', name: 'Basic', sort: 10, amount: 400 },
  { id: 'go', name: 'Go', sort: 20, amount: 800 },
  { id: 'pro', name: 'Pro', sort: 30, amount: 1500 },
  { id: 'max', name: 'Max', sort: 40, amount: 3500 },
]);

const REQUEST_TIMEOUT_MS = 30000;
const WATCH_EVERY_MS = 5000;
const WATCH_FOR_MS = 20 * 60 * 1000;

function coded(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra && typeof extra === 'object') Object.assign(err, extra);
  return err;
}

const str = (v) => (typeof v === 'string' && v ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

// Estado del plan con la forma que recibe la interfaz (billing:state).
function normalizeState(s, extra = {}) {
  const o = s && typeof s === 'object' ? s : {};
  const stripeStatus = str(o.stripeStatus);
  return {
    plan: str(o.plan),
    planName: str(o.planName),
    status: str(o.status),
    active: o.active === true,
    currentPeriodEnd: str(o.currentPeriodEnd),
    cancelAtPeriodEnd: o.cancelAtPeriodEnd === true,
    graceUntil: str(o.graceUntil),
    inGrace: o.inGrace === true,
    paymentFailed: stripeStatus === 'past_due' || stripeStatus === 'unpaid',
    stripeStatus,
    source: str(o.source),
    managedByStripe: o.managedByStripe === true,
    canManage: false,
    mode: null,
    synced: typeof extra.synced === 'boolean' ? extra.synced : null,
    checkedAt: new Date(extra.now ?? Date.now()).toISOString(),
  };
}

// Precio de un plan con un proveedor (lo arma el servidor: private.payments_quote).
function normalizeQuote(q) {
  if (!q || typeof q !== 'object') return null;
  const currency = q.currency === 'ARS' || q.currency === 'USD' ? q.currency : null;
  const total = num(q.total);
  if (!currency || total === null || total <= 0) return null;
  const taxes = (Array.isArray(q.taxes) ? q.taxes : [])
    .filter((x) => x && typeof x === 'object' && ['included', 'added', 'estimate'].includes(x.mode))
    .map((x) => ({ id: String(x.id || ''), label: String(x.label || '').slice(0, 40), rate: num(x.rate) ?? 0, mode: x.mode, amount: num(x.amount) ?? 0 }));
  return {
    currency,
    subtotal: num(q.subtotal) ?? total,
    net: num(q.net) ?? total,
    total,
    estimatedTotal: num(q.estimatedTotal),
    taxes,
    arsPerUsd: num(q.arsPerUsd),
  };
}

function normalizeCatalog(data) {
  const d = data && typeof data === 'object' ? data : {};
  const prov = d.providers && typeof d.providers === 'object' ? d.providers : {};
  const plans = [];
  for (const p of Array.isArray(d.plans) ? d.plans : []) {
    if (!p || typeof p !== 'object' || !PLAN_ID.test(String(p.id))) continue;
    const prices = p.prices && typeof p.prices === 'object' ? p.prices : {};
    plans.push({
      id: p.id,
      name: str(p.name) || p.id,
      priceUsd: num(p.priceUsd),
      budgetUsd: num(p.budgetUsd),
      maxTokensPerRequest: num(p.maxTokensPerRequest),
      models: Array.isArray(p.models) ? p.models.filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id, label: str(m.label) || m.id, efforts: Array.isArray(m.efforts) ? m.efforts.filter((e) => typeof e === 'string') : [] })) : [],
      prices: { mercado_pago: normalizeQuote(prices.mercado_pago), paypal: normalizeQuote(prices.paypal) },
    });
  }
  return {
    source: 'backend',
    providers: {
      mercado_pago: prov.mercado_pago?.enabled === true,
      paypal: prov.paypal?.enabled === true,
    },
    arsPerUsd: num(d.arsPerUsd),
    rateUpdatedAt: str(d.rateUpdatedAt),
    plans,
  };
}

function staticCatalog() {
  return {
    source: 'static',
    providers: { mercado_pago: false, paypal: false },
    arsPerUsd: null,
    rateUpdatedAt: null,
    plans: STATIC_PLANS.map((p) => ({ id: p.id, name: p.name, priceUsd: p.amount / 100, budgetUsd: null, maxTokensPerRequest: null, models: [], prices: { mercado_pago: null, paypal: null } })),
  };
}

// Orden de pago (lo que devuelve "payments"), sin datos de más para la interfaz.
function normalizeOrder(o) {
  if (!o || typeof o !== 'object' || !UUID.test(String(o.id))) return null;
  return {
    id: o.id,
    plan: str(o.plan),
    planName: str(o.planName),
    provider: PROVIDERS.has(o.provider) ? o.provider : null,
    currency: o.currency === 'ARS' || o.currency === 'USD' ? o.currency : null,
    amount: num(o.amount),
    status: str(o.status) || 'pending',
    providerStatus: str(o.providerStatus),
    live: o.live === true,
    checkoutUrl: typeof o.checkoutUrl === 'string' && /^https:\/\//.test(o.checkoutUrl) ? o.checkoutUrl : null,
    carriedUsd: num(o.carriedUsd) ?? 0,
    createdAt: str(o.createdAt),
    paidAt: str(o.paidAt),
    expiresAt: str(o.expiresAt),
  };
}

function createBillingClient(deps) {
  const t = deps.t;
  const now = deps.now || Date.now;
  const timers = deps.timers || { setTimeout, clearTimeout };
  let watch = null; // { orderId, owner, timer, until, last }

  async function config() {
    const cfg = await deps.cloudConfig();
    if (!cfg?.configured) throw coded('noCloud', t('billing.errNoCloud'));
    return cfg;
  }

  async function request(url, init) {
    try {
      return await deps.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw coded('network', t('billing.errNetwork'));
    }
  }

  async function rpc(name, { auth = true } = {}) {
    const cfg = await config();
    const token = auth ? await deps.accessToken() : cfg.anonKey;
    const res = await request(`${cfg.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey, Authorization: `Bearer ${token}` },
      body: '{}',
    });
    const data = await res.json().catch(() => null);
    if (res.ok) return data;
    if (res.status === 401) throw coded('noSession', t('billing.errSession'));
    if (res.status === 403) throw coded('noSession', t('billing.errSignIn'));
    if (res.status === 404 || data?.code === 'PGRST202') throw coded('unavailable', t('billing.errUnavailable'));
    throw coded('server', t('billing.errServer'));
  }

  // Edge Function "payments": { ok, result } o { ok: false, error, message }.
  async function payments(action, payload) {
    const cfg = await config();
    const token = await deps.accessToken();
    const res = await request(`${cfg.url}/functions/v1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, payload }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok === true) return data.result;
    const error = str(data?.error);
    if (res.status === 401 || error === 'unauthorized') throw coded('noSession', res.status === 403 ? t('billing.errSignIn') : t('billing.errSession'));
    const known = {
      unknown_plan: ['unknownPlan', 'billing.errUnknownPlan'],
      provider_disabled: ['providerDisabled', 'billing.errProviderDisabled'],
      too_many: ['busy', 'billing.errTooMany'],
      busy: ['busy', 'billing.errBusy'],
      not_found: ['notFound', 'billing.errOrderNotFound'],
      provider_auth: ['provider', 'billing.errProviderAuth'],
      provider: ['provider', 'billing.errProvider'],
      backend_not_ready: ['unavailable', 'billing.errUnavailable'],
      not_configured: ['unavailable', 'billing.errUnavailable'],
    };
    if (known[error]) throw coded(known[error][0], t(known[error][1]));
    if (res.status === 404) throw coded('unavailable', t('billing.errUnavailable'));
    throw coded('server', t('billing.errServer'));
  }

  async function state() {
    return normalizeState(await rpc('billing_my_state'), { now: now() });
  }

  async function catalog() {
    try {
      return normalizeCatalog(await rpc('payments_catalog', { auth: false }));
    } catch (err) {
      if (err.code === 'noCloud') throw err;
      return staticCatalog();
    }
  }

  async function orders() {
    const list = await rpc('payments_my_orders');
    return (Array.isArray(list) ? list : []).map(normalizeOrder).filter(Boolean);
  }

  function stopWatch() {
    if (watch?.timer) timers.clearTimeout(watch.timer);
    watch = null;
  }

  function emitOrder(order) {
    deps.send?.('billing:order', order);
    if (order.status === 'paid') {
      deps.send?.('billing:changed', { reason: 'paid', kind: 'order', plan: order.plan });
      deps.aiStatus?.({ refresh: true })?.catch?.(() => {});
    }
  }

  async function order(orderId) {
    if (typeof orderId !== 'string' || !UUID.test(orderId)) throw coded('badRequest', t('billing.errOrderNotFound'));
    const result = await payments('status', { orderId });
    const o = normalizeOrder(result?.order);
    if (!o) throw coded('server', t('billing.errServer'));
    return o;
  }

  // Mira la orden cada 5 s durante 20 minutos (o hasta que termine). Se corta si cambia la cuenta.
  function startWatch(o, owner) {
    stopWatch();
    const w = { orderId: o.id, owner, timer: null, until: now() + WATCH_FOR_MS, last: `${o.status}|${o.providerStatus || ''}` };
    watch = w;
    const tick = async () => {
      if (watch !== w) return;
      if (deps.sessionUser && (await deps.sessionUser().catch(() => null)) !== owner) return stopWatch();
      try {
        const next = await order(w.orderId);
        if (watch !== w) return;
        const key = `${next.status}|${next.providerStatus || ''}`;
        if (key !== w.last) emitOrder(next);
        w.last = key;
        if (TERMINAL.has(next.status)) return stopWatch();
      } catch (err) {
        if (err.code === 'noSession') return stopWatch();
      }
      if (watch === w && now() < w.until) w.timer = timers.setTimeout(tick, WATCH_EVERY_MS);
      else if (watch === w) {
        deps.send?.('billing:order', { id: w.orderId, status: 'timeout' });
        stopWatch();
      }
    };
    w.timer = timers.setTimeout(tick, WATCH_EVERY_MS);
  }

  // { plan, provider } -> abre el pago en el navegador y devuelve { order, url }.
  async function checkout(input) {
    const plan = typeof input?.plan === 'string' ? input.plan.trim().toLowerCase() : '';
    const provider = typeof input?.provider === 'string' ? input.provider : '';
    if (!STATIC_PLANS.some((p) => p.id === plan)) throw coded('unknownPlan', t('billing.errUnknownPlan'));
    if (!PROVIDERS.has(provider)) throw coded('providerDisabled', t('billing.errProviderDisabled'));
    const owner = deps.sessionUser ? await deps.sessionUser() : null;
    const result = await payments('checkout', { plan, provider });
    const o = normalizeOrder(result?.order);
    const url = typeof result?.url === 'string' && /^https:\/\/[^\s]+$/.test(result.url) ? result.url : null;
    if (!o || !url) throw coded('server', t('billing.errBadUrl'));
    await deps.openExternal(url);
    startWatch(o, owner);
    return { order: o, url };
  }

  // Volver a abrir el link de una orden pendiente (solo https de Mercado Pago o PayPal).
  async function reopen(url) {
    if (typeof url !== 'string' || !/^https:\/\/([a-z0-9-]+\.)*(mercadopago\.com(\.[a-z]{2})?|mercadolibre\.com|paypal\.com)\//i.test(url)) {
      throw coded('badRequest', t('billing.errBadUrl'));
    }
    await deps.openExternal(url);
    return true;
  }

  async function portal() {
    throw coded('unsupported', t('billing.errNoPortal'));
  }

  return { state, catalog, checkout, order, orders, reopen, portal, stopWatch, watching: () => watch?.orderId || null };
}

module.exports = { createBillingClient, normalizeState, normalizeCatalog, normalizeOrder, normalizeQuote, STATIC_PLANS, coded };
