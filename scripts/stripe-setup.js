'use strict';
// Configura Stripe para los planes de Venus IA (suscripciones mensuales en USD). Lo corre el dueño del proyecto.
//   1. Crea o actualiza un producto por plan (id fijo venus_ai_<plan>) y su precio mensual en USD
//      (lookup_key venus_ai_<plan>_monthly). Los precios de Stripe no se pueden editar: si cambia el monto
//      crea uno nuevo (se lleva el lookup_key) y desactiva el anterior. Las suscripciones viejas siguen.
//   2. Configura el portal de facturación (subir de plan en el momento, bajar y cancelar al fin del período, tarjeta).
//   3. Carga las filas de ai_plan_prices en Supabase (con SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY) o imprime
//      el SQL para pegarlo en el SQL Editor.
// Idempotente: se puede correr las veces que haga falta. Anda con claves de prueba y de producción.
//
// Uso (ver docs/pagos.md):
//   PowerShell:  $env:STRIPE_SECRET_KEY="sk_test_..."; node scripts/stripe-setup.js --dry-run
//   bash:        STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.js
// Opciones: --dry-run (solo muestra qué haría; no cambia nada), --help.
// Variables opcionales: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BILLING_RETURN_URL (vuelta del portal),
//   STRIPE_TAX_CODE (código de impuesto de los productos, txcd_...), STRIPE_TAX_BEHAVIOR (exclusive o inclusive),
//   BILLING_PRIVACY_URL y BILLING_TERMS_URL (links en el portal).

const PLANS = [
  { id: 'go', name: 'Go', amount: 350 },
  { id: 'pro', name: 'Pro', amount: 925 },
  { id: 'super', name: 'Super', amount: 1350 },
  { id: 'ultra', name: 'Ultra', amount: 2550 },
  { id: 'max', name: 'Max', amount: 3650 },
  { id: 'supreme', name: 'Supreme', amount: 4250 },
];
const CURRENCY = 'usd';
const INTERVAL = 'month';
const API = 'https://api.stripe.com';
const STRIPE_VERSION = '2025-03-31.basil';
const PORTAL_TAG = 'ai'; // metadata.venus de la configuración del portal (la busca la función billing)

const productId = (plan) => `venus_ai_${plan}`;
const lookupKey = (plan) => `venus_ai_${plan}_monthly`;
const usd = (cents) => `US$ ${(cents / 100).toFixed(2)}`;

const HELP = `Configura los productos, precios y el portal de Stripe de Venus IA.

Uso:
  node scripts/stripe-setup.js [--dry-run]

Con la clave en STRIPE_SECRET_KEY (sk_test_... para probar, sk_live_... para producción).
  --dry-run   Muestra lo que haría sin cambiar nada (ni en Stripe ni en Supabase).
  --help      Esta ayuda.

Opcionales: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (carga ai_plan_prices), BILLING_RETURN_URL,
STRIPE_TAX_CODE, STRIPE_TAX_BEHAVIOR (exclusive | inclusive), BILLING_PRIVACY_URL, BILLING_TERMS_URL.
Paso a paso: docs/pagos.md`;

// ---------- Stripe ----------

class StripeSetupError extends Error {
  constructor(status, type, code, message) {
    super(`Stripe respondió ${status || 'sin conexión'} (${code || type}): ${message || 'sin detalle'}`);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

function encodeForm(params) {
  const pairs = [];
  const add = (key, value) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) return value.forEach((v, i) => add(`${key}[${i}]`, v));
    if (typeof value === 'object') return Object.entries(value).forEach(([k, v]) => add(`${key}[${k}]`, v));
    pairs.push(`${encodeURIComponent(key).replace(/%5B/g, '[').replace(/%5D/g, ']')}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(params || {})) add(k, v);
  return pairs.join('&');
}

function keyMode(key) {
  if (/^(sk|rk)_live_[A-Za-z0-9]{8,}$/.test(key || '')) return 'live';
  if (/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(key || '')) return 'test';
  return null;
}

function createStripe(key, fetchImpl) {
  async function request(method, path, params) {
    const form = encodeForm(params);
    const url = method === 'GET' && form ? `${API}${path}?${form}` : `${API}${path}`;
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          'Stripe-Version': STRIPE_VERSION,
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: method === 'POST' ? form : undefined,
      });
    } catch (err) {
      throw new StripeSetupError(0, 'network_error', null, err && err.message);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const e = (data && data.error) || {};
      throw new StripeSetupError(res.status, e.type || 'api_error', e.code || null, e.message || null);
    }
    return data;
  }
  return { get: (p, q) => request('GET', p, q), post: (p, b) => request('POST', p, b) };
}

const idOf = (v) => (typeof v === 'string' ? v : v && typeof v.id === 'string' ? v.id : null);

/** ¿El precio de Stripe es exactamente el que queremos para el plan? */
function priceMatches(price, plan, opts = {}) {
  if (!price || price.type !== 'recurring') return false;
  const r = price.recurring || {};
  return (
    price.unit_amount === plan.amount &&
    price.currency === CURRENCY &&
    r.interval === INTERVAL &&
    (r.interval_count || 1) === 1 &&
    (r.usage_type || 'licensed') === 'licensed' &&
    idOf(price.product) === productId(plan.id) &&
    (!opts.taxBehavior || price.tax_behavior === opts.taxBehavior)
  );
}

/** Precio mensual en USD que maneja este script (los demás precios del producto no se tocan). */
function isManagedKind(price) {
  return price && price.type === 'recurring' && price.currency === CURRENCY && (price.recurring || {}).interval === INTERVAL;
}

function productParams(plan, opts) {
  return {
    name: `Venus IA ${plan.name}`,
    description: `Plan ${plan.name} de Venus IA, el asistente de Venus Launcher. Suscripción mensual.`,
    metadata: { venus_plan: plan.id, app: 'venus-launcher' },
    tax_code: opts.taxCode || undefined,
  };
}

/** Parámetros de la configuración del portal de facturación (cambio de plan, cancelación y tarjeta). */
function buildPortalParams(prices, opts = {}) {
  const businessProfile = { headline: 'Venus Launcher · Venus IA' };
  if (opts.privacyUrl) businessProfile.privacy_policy_url = opts.privacyUrl;
  if (opts.termsUrl) businessProfile.terms_of_service_url = opts.termsUrl;
  return {
    business_profile: businessProfile,
    default_return_url: opts.returnUrl || undefined,
    features: {
      customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        proration_behavior: 'none',
        cancellation_reason: { enabled: true, options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'] },
      },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        // Subir de plan se aplica en el momento y Stripe cobra la diferencia prorrateada.
        proration_behavior: 'always_invoice',
        // Bajar de plan queda para el fin del período, sin crédito: si no, subir, gastar el presupuesto del plan caro
        // y volver enseguida devolvía lo pagado (docs/pagos.md, sección 11).
        schedule_at_period_end: { conditions: [{ type: 'decreasing_item_amount' }] },
        products: prices.map((p) => ({ product: productId(p.plan), prices: [p.priceId] })),
      },
    },
    metadata: { venus: PORTAL_TAG },
  };
}

// ---------- Pasos ----------

async function ensureProduct(stripe, plan, ctx) {
  const id = productId(plan.id);
  const wanted = productParams(plan, ctx);
  let product = null;
  try {
    product = await stripe.get(`/v1/products/${id}`);
  } catch (err) {
    if (!(err instanceof StripeSetupError && err.status === 404)) throw err;
  }
  if (!product) {
    if (!ctx.dryRun) await stripe.post('/v1/products', { id, ...wanted });
    return { id, existed: false, action: ctx.dryRun ? 'se crearía' : 'creado' };
  }
  const changes = {};
  if (product.name !== wanted.name) changes.name = wanted.name;
  if ((product.description || '') !== wanted.description) changes.description = wanted.description;
  if (product.active === false) changes.active = true;
  const meta = product.metadata || {};
  if (meta.venus_plan !== plan.id || meta.app !== 'venus-launcher') changes.metadata = wanted.metadata;
  if (wanted.tax_code && idOf(product.tax_code) !== wanted.tax_code) changes.tax_code = wanted.tax_code;
  if (!Object.keys(changes).length) return { id, existed: true, action: 'sin cambios' };
  if (!ctx.dryRun) await stripe.post(`/v1/products/${id}`, changes);
  return { id, existed: true, action: `${ctx.dryRun ? 'se actualizaría' : 'actualizado'} (${Object.keys(changes).join(', ')})` };
}

async function ensurePrice(stripe, plan, ctx) {
  const product = productId(plan.id);
  const key = lookupKey(plan.id);
  const found = await stripe.get('/v1/prices', { lookup_keys: [key], limit: 10 });
  const current = (found.data || []).find((p) => p.lookup_key === key) || null;
  const out = { plan: plan.id, lookupKey: key, amount: plan.amount, priceId: null, livemode: ctx.livemode, action: '', deactivated: [] };

  if (current && priceMatches(current, plan, ctx)) {
    out.priceId = current.id;
    out.livemode = current.livemode === true;
    if (current.active === false) {
      if (!ctx.dryRun) await stripe.post(`/v1/prices/${current.id}`, { active: true });
      out.action = ctx.dryRun ? 'se reactivaría' : 'reactivado';
    } else {
      out.action = 'sin cambios';
    }
  } else {
    const params = {
      product,
      currency: CURRENCY,
      unit_amount: plan.amount,
      recurring: { interval: INTERVAL, interval_count: 1 },
      lookup_key: key,
      transfer_lookup_key: current ? true : undefined,
      nickname: `Venus IA ${plan.name} mensual`,
      metadata: { venus_plan: plan.id, app: 'venus-launcher' },
      tax_behavior: ctx.taxBehavior || undefined,
    };
    if (ctx.dryRun) {
      out.priceId = null;
      out.action = current ? `se crearía uno nuevo (antes ${usd(current.unit_amount || 0)}: ${current.id})` : 'se crearía';
    } else {
      const created = await stripe.post('/v1/prices', params);
      out.priceId = created.id;
      out.livemode = created.livemode === true;
      out.action = current ? `nuevo (reemplaza a ${current.id})` : 'nuevo';
    }
    // El precio anterior deja de venderse (sus suscripciones siguen igual en Stripe y en ai_plan_prices).
    if (current && current.active !== false) {
      if (!ctx.dryRun) await stripe.post(`/v1/prices/${current.id}`, { active: false });
      out.deactivated.push(current.id);
    }
  }

  // Simulación con un producto que todavía no existe: no hay más precios que revisar.
  if (ctx.dryRun && !ctx.productExists) return out;

  // Otros precios mensuales en USD activos del mismo producto (restos de pruebas o de una corrida cortada).
  const active = await stripe.get('/v1/prices', { product, active: true, limit: 100 });
  for (const p of active.data || []) {
    if (p.id === out.priceId || out.deactivated.includes(p.id)) continue;
    if (!isManagedKind(p)) {
      ctx.log(`  ! ${product}: dejo sin tocar el precio ${p.id} (no es mensual en USD)`);
      continue;
    }
    if (!ctx.dryRun) await stripe.post(`/v1/prices/${p.id}`, { active: false });
    out.deactivated.push(p.id);
  }

  // Precio por defecto del producto (el que muestra el panel de Stripe).
  if (out.priceId && !ctx.dryRun) {
    const productNow = await stripe.get(`/v1/products/${product}`);
    if (idOf(productNow.default_price) !== out.priceId) await stripe.post(`/v1/products/${product}`, { default_price: out.priceId });
  }
  return out;
}

async function ensurePortal(stripe, prices, ctx) {
  const listed = await stripe.get('/v1/billing_portal/configurations', { active: true, limit: 100 });
  const existing = (listed.data || []).find((c) => c && c.metadata && c.metadata.venus === PORTAL_TAG) || null;
  if (ctx.dryRun) return { id: existing ? existing.id : null, action: existing ? 'se actualizaría' : 'se crearía' };
  if (prices.some((p) => !p.priceId)) throw new Error('faltan precios para configurar el portal');
  const params = buildPortalParams(prices, ctx);
  const saved = existing
    ? await stripe.post(`/v1/billing_portal/configurations/${existing.id}`, params)
    : await stripe.post('/v1/billing_portal/configurations', params);
  return { id: saved.id, action: existing ? 'actualizada' : 'creada' };
}

// ---------- ai_plan_prices ----------

function sqlString(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function rowsSql(rows) {
  return rows
    .map(
      (r) =>
        `select public.billing_upsert_price(${sqlString(r.plan)}, ${r.priceId ? sqlString(r.priceId) : "'<precio nuevo>'"}, ${sqlString(r.lookupKey)}, 'usd', ${r.amount}, 'month', ${r.livemode ? 'true' : 'false'});`,
    )
    .join('\n');
}

const isJwt = (key) => /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(key || '');

async function upsertSupabase(rows, ctx) {
  const base = ctx.supabaseUrl.replace(/\/+$/, '');
  for (const r of rows) {
    const headers = { apikey: ctx.serviceKey, 'Content-Type': 'application/json' };
    // Las claves nuevas (sb_secret_...) van solo en apikey; las viejas (JWT) también en Authorization.
    if (isJwt(ctx.serviceKey)) headers.Authorization = `Bearer ${ctx.serviceKey}`;
    let res;
    try {
      res = await ctx.fetch(`${base}/rest/v1/rpc/billing_upsert_price`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_plan: r.plan,
          p_price: r.priceId,
          p_lookup_key: r.lookupKey,
          p_currency: CURRENCY,
          p_amount: r.amount,
          p_interval: INTERVAL,
          p_livemode: r.livemode,
        }),
      });
    } catch (err) {
      throw new Error(`No se pudo conectar con Supabase (${err && err.message}).`);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const code = data.code || res.status;
      const hint =
        code === 'PGRST202' || code === '42883'
          ? ' Aplicá supabase/migrations/0009_billing.sql.'
          : code === '23503'
            ? ` Falta el plan "${r.plan}" en ai_plans: aplicá 0008_ai_plans.sql.`
            : res.status === 401 || res.status === 403
              ? ' Revisá SUPABASE_SERVICE_ROLE_KEY (tiene que ser la service role o una secret key).'
              : '';
      throw new Error(`Supabase rechazó el precio de ${r.plan} (${code}): ${data.message || 'sin detalle'}.${hint}`);
    }
  }
}

// ---------- Principal ----------

async function run({ argv = process.argv.slice(2), env = process.env, fetch: fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const args = new Set(argv);
  if (args.has('--help') || args.has('-h')) {
    log(HELP);
    return { ok: true, help: true };
  }
  const unknown = argv.filter((a) => !['--dry-run', '--help', '-h'].includes(a));
  if (unknown.length) throw new Error(`Opción desconocida: ${unknown.join(' ')} (usá --help)`);

  const key = String(env.STRIPE_SECRET_KEY || '').trim();
  const mode = keyMode(key);
  if (!mode) throw new Error('Falta STRIPE_SECRET_KEY (sk_test_... o sk_live_...; también sirve una clave restringida rk_...). Ver docs/pagos.md.');
  const taxBehavior = String(env.STRIPE_TAX_BEHAVIOR || '').trim();
  if (taxBehavior && !['exclusive', 'inclusive'].includes(taxBehavior)) throw new Error('STRIPE_TAX_BEHAVIOR tiene que ser exclusive o inclusive.');
  const taxCode = String(env.STRIPE_TAX_CODE || '').trim();
  if (taxCode && !/^txcd_\d{8}$/.test(taxCode)) throw new Error('STRIPE_TAX_CODE tiene que tener la forma txcd_12345678.');

  const supabaseUrl = String(env.SUPABASE_URL || '').trim();
  const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const returnBase = String(env.BILLING_RETURN_URL || '').trim();
  let returnUrl = null;
  if (/^https:\/\//.test(returnBase)) {
    const u = new URL(returnBase);
    u.searchParams.set('return', 'portal');
    returnUrl = u.href;
  } else if (/^https:\/\//.test(supabaseUrl)) {
    returnUrl = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/stripe-webhook?return=portal`;
  }

  const ctx = {
    dryRun: args.has('--dry-run'),
    livemode: mode === 'live',
    taxBehavior: taxBehavior || null,
    taxCode: taxCode || null,
    returnUrl,
    privacyUrl: /^https:\/\//.test(env.BILLING_PRIVACY_URL || '') ? env.BILLING_PRIVACY_URL : null,
    termsUrl: /^https:\/\//.test(env.BILLING_TERMS_URL || '') ? env.BILLING_TERMS_URL : null,
    supabaseUrl,
    serviceKey,
    fetch: fetchImpl,
    log,
  };
  const stripe = createStripe(key, fetchImpl);

  log(`Stripe en modo ${mode === 'live' ? 'PRODUCCIÓN (live): los cambios afectan cobros reales' : 'de prueba (test)'}${ctx.dryRun ? ' · simulación (--dry-run): no se cambia nada' : ''}`);
  log('');

  const prices = [];
  for (const plan of PLANS) {
    const product = await ensureProduct(stripe, plan, ctx);
    const price = await ensurePrice(stripe, plan, { ...ctx, productExists: product.existed });
    prices.push(price);
    const off = price.deactivated.length ? ` · ${ctx.dryRun ? 'se desactivarían' : 'desactivados'}: ${price.deactivated.join(', ')}` : '';
    log(`- ${plan.id.padEnd(8)} ${usd(plan.amount).padEnd(11)} producto ${product.id} (${product.action}) · precio ${price.priceId || '<nuevo>'} (${price.action})${off}`);
  }

  const portal = await ensurePortal(stripe, prices, ctx);
  log('');
  log(`Portal de facturación: ${portal.id || '<nueva configuración>'} (${portal.action}). Subir de plan en el momento con prorrateo, bajar al fin del período, cancelación al fin del período y cambio de tarjeta.`);

  const rows = prices.map((p) => ({ plan: p.plan, priceId: p.priceId, lookupKey: p.lookupKey, amount: p.amount, livemode: p.livemode }));
  let supabase = 'printed';
  log('');
  if (supabaseUrl && serviceKey && !ctx.dryRun) {
    await upsertSupabase(rows, ctx);
    supabase = 'upserted';
    log(`Precios cargados en ai_plan_prices de ${supabaseUrl} (${rows.length} planes, ${mode}).`);
  } else {
    supabase = ctx.dryRun ? 'dry-run' : 'printed';
    log(
      ctx.dryRun
        ? 'Simulación: ai_plan_prices quedaría así (SQL equivalente; los precios nuevos tienen id recién al crearlos):'
        : 'Pegá esto en el SQL Editor de Supabase (o definí SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY para cargarlo solo):',
    );
    log('');
    log(rowsSql(rows));
  }
  log('');
  if (/^https:\/\//.test(supabaseUrl)) {
    log(`Webhook de Stripe: ${supabaseUrl.replace(/\/+$/, '')}/functions/v1/stripe-webhook`);
    log('  eventos: checkout.session.completed, customer.subscription.created, customer.subscription.updated,');
    log('           customer.subscription.deleted, invoice.paid, invoice.payment_failed');
  }
  log(ctx.dryRun ? 'Simulación terminada: no se cambió nada.' : 'Listo. Siguiente paso: el webhook y los secretos de las funciones (docs/pagos.md).');
  return { ok: true, mode, dryRun: ctx.dryRun, prices, portal, rows, supabase };
}

if (require.main === module) {
  run().catch((err) => {
    console.error(`\nError: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}

module.exports = { run, PLANS, encodeForm, buildPortalParams, priceMatches, productId, lookupKey, rowsSql, keyMode };
