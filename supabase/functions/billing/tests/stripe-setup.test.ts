// Pruebas de scripts/stripe-setup.js contra un Stripe y un Supabase falsos (node --test). Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const setup = require('../../../../scripts/stripe-setup.js') as {
  run(opts: { argv: string[]; env: Record<string, string>; fetch: unknown; log: (line: string) => void }): Promise<Record<string, unknown>>;
  PLANS: { id: string; name: string; amount: number }[];
};

type Obj = Record<string, unknown>;
const SUPABASE = 'https://proyecto.supabase.co';

class FakeStripeCatalog {
  products = new Map<string, Obj>();
  prices = new Map<string, Obj>();
  portals: Obj[] = [];
  calls: { method: string; path: string; params: Record<string, string> }[] = [];
  upserts: Obj[] = [];
  supabaseError: { status: number; body: Obj } | null = null;
  seq = 0;
  live = false;

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    if (url.origin === SUPABASE) {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('apikey'), 'service-key');
      if (this.supabaseError) return new Response(JSON.stringify(this.supabaseError.body), { status: this.supabaseError.status });
      this.upserts.push({ fn: url.pathname, ...JSON.parse(String(init.body)) });
      return new Response('{"ok":true}', { status: 200 });
    }
    assert.equal(url.origin, 'https://api.stripe.com');
    assert.equal(new Headers(init.headers).get('stripe-version'), '2025-03-31.basil');
    const raw = method === 'GET' ? url.search.slice(1) : String(init.body ?? '');
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
    this.calls.push({ method, path: url.pathname, params });
    return this.route(method, url.pathname, params);
  };

  ok(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200 });
  }

  err(status: number, code: string) {
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code, message: `falla ${code}` } }), { status });
  }

  addPrice(fields: Obj): Obj {
    const id = `price_${++this.seq}`;
    const price = { id, object: 'price', type: 'recurring', active: true, currency: 'usd', livemode: this.live, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, lookup_key: null, ...fields };
    this.prices.set(id, price);
    return price;
  }

  route(method: string, path: string, p: Record<string, string>): Response {
    let m: RegExpExecArray | null;
    if (method === 'GET' && (m = /^\/v1\/products\/(\w+)$/.exec(path))) {
      const prod = this.products.get(m[1]);
      return prod ? this.ok(prod) : this.err(404, 'resource_missing');
    }
    if (method === 'POST' && path === '/v1/products') {
      if (this.products.has(p.id)) return this.err(400, 'resource_already_exists');
      const prod = { id: p.id, object: 'product', name: p.name, description: p.description, active: true, metadata: { venus_plan: p['metadata[venus_plan]'], app: p['metadata[app]'] }, default_price: null, tax_code: p.tax_code ?? null, livemode: this.live };
      this.products.set(p.id, prod);
      return this.ok(prod);
    }
    if (method === 'POST' && (m = /^\/v1\/products\/(\w+)$/.exec(path))) {
      const prod = this.products.get(m[1]);
      if (!prod) return this.err(404, 'resource_missing');
      for (const k of ['name', 'description', 'default_price', 'tax_code']) if (p[k] !== undefined) prod[k] = p[k];
      if (p.active !== undefined) prod.active = p.active === 'true';
      if (p['metadata[venus_plan]']) prod.metadata = { venus_plan: p['metadata[venus_plan]'], app: p['metadata[app]'] };
      return this.ok(prod);
    }
    if (method === 'GET' && path === '/v1/prices') {
      let data = [...this.prices.values()];
      if (p['lookup_keys[0]']) data = data.filter((x) => x.lookup_key === p['lookup_keys[0]']);
      if (p.product) data = data.filter((x) => x.product === p.product);
      if (p.active) data = data.filter((x) => String(x.active) === p.active);
      return this.ok({ object: 'list', data, has_more: false });
    }
    if (method === 'POST' && path === '/v1/prices') {
      const holder = [...this.prices.values()].find((x) => x.lookup_key === p.lookup_key);
      if (holder && p.transfer_lookup_key !== 'true') return this.err(400, 'lookup_key_exists');
      if (holder) holder.lookup_key = null;
      return this.ok(
        this.addPrice({
          product: p.product,
          unit_amount: Number(p.unit_amount),
          currency: p.currency,
          recurring: { interval: p['recurring[interval]'], interval_count: Number(p['recurring[interval_count]'] ?? 1), usage_type: 'licensed' },
          lookup_key: p.lookup_key,
          nickname: p.nickname,
          tax_behavior: p.tax_behavior ?? 'unspecified',
        }),
      );
    }
    if (method === 'POST' && (m = /^\/v1\/prices\/(\w+)$/.exec(path))) {
      const price = this.prices.get(m[1]);
      if (!price) return this.err(404, 'resource_missing');
      if (p.active !== undefined) price.active = p.active === 'true';
      return this.ok(price);
    }
    if (method === 'GET' && path === '/v1/billing_portal/configurations') return this.ok({ object: 'list', data: this.portals, has_more: false });
    if (method === 'POST' && path === '/v1/billing_portal/configurations') {
      const cfg = { id: `bpc_${++this.seq}`, object: 'billing_portal.configuration', active: true, metadata: { venus: p['metadata[venus]'] }, params: p };
      this.portals.push(cfg);
      return this.ok(cfg);
    }
    if (method === 'POST' && (m = /^\/v1\/billing_portal\/configurations\/(\w+)$/.exec(path))) {
      const cfg = this.portals.find((c) => c.id === m![1]);
      if (!cfg) return this.err(404, 'resource_missing');
      cfg.params = p;
      return this.ok(cfg);
    }
    return this.err(404, 'resource_missing');
  }

  posts() {
    return this.calls.filter((c) => c.method === 'POST');
  }
}

async function runSetup(stripe: FakeStripeCatalog, argv: string[] = [], env: Record<string, string> = {}) {
  const lines: string[] = [];
  const result = await setup.run({ argv, env: { STRIPE_SECRET_KEY: 'sk_test_setup123456', ...env }, fetch: stripe.fetch, log: (l) => lines.push(l) });
  return { result, out: lines.join('\n') };
}

test('--dry-run en una cuenta vacía: solo lee, no cambia nada e imprime el plan', async () => {
  const stripe = new FakeStripeCatalog();
  const { result, out } = await runSetup(stripe, ['--dry-run'], { SUPABASE_URL: SUPABASE, SUPABASE_SERVICE_ROLE_KEY: 'service-key' });
  assert.equal(stripe.posts().length, 0);
  assert.equal(stripe.upserts.length, 0);
  assert.equal(result.dryRun, true);
  assert.equal(result.supabase, 'dry-run');
  assert.match(out, /simulación \(--dry-run\)/);
  assert.match(out, /go\s+US\$ 3\.50/);
  assert.match(out, /supreme\s+US\$ 42\.50/);
  assert.match(out, /select public\.billing_upsert_price\('pro', '<precio nuevo>', 'venus_ai_pro_monthly', 'usd', 925, 'month', false\);/);
  assert.match(out, /stripe-webhook/);
});

test('primera corrida: un producto y un precio mensual en USD por plan, portal y filas de ai_plan_prices', async () => {
  const stripe = new FakeStripeCatalog();
  const { result } = await runSetup(stripe, [], { SUPABASE_URL: SUPABASE, SUPABASE_SERVICE_ROLE_KEY: 'service-key' });
  const expected: Record<string, number> = { go: 350, pro: 925, super: 1350, ultra: 2550, max: 3650, supreme: 4250 };
  assert.deepEqual(setup.PLANS.map((p) => [p.id, p.amount]), Object.entries(expected));
  for (const [plan, amount] of Object.entries(expected)) {
    const product = stripe.products.get(`venus_ai_${plan}`);
    assert.ok(product, plan);
    assert.equal((product.metadata as Obj).venus_plan, plan);
    const price = [...stripe.prices.values()].find((p) => p.lookup_key === `venus_ai_${plan}_monthly`)!;
    assert.equal(price.unit_amount, amount);
    assert.equal(price.currency, 'usd');
    assert.equal((price.recurring as Obj).interval, 'month');
    assert.equal(price.product, `venus_ai_${plan}`);
    assert.equal(product.default_price, price.id);
  }
  // Portal: cambio entre estos planes, cancelación al fin del período, tarjeta.
  assert.equal(stripe.portals.length, 1);
  const cfg = stripe.portals[0].params as Record<string, string>;
  assert.equal(cfg['metadata[venus]'], 'ai');
  assert.equal(cfg['features[subscription_cancel][mode]'], 'at_period_end');
  assert.equal(cfg['features[subscription_update][enabled]'], 'true');
  assert.equal(cfg['features[subscription_update][proration_behavior]'], 'always_invoice');
  // Bajar de plan queda para el fin del período (sin crédito por el tiempo que queda).
  assert.equal(cfg['features[subscription_update][schedule_at_period_end][conditions][0][type]'], 'decreasing_item_amount');
  assert.equal(cfg['features[payment_method_update][enabled]'], 'true');
  assert.equal(cfg['features[subscription_update][products][5][product]'], 'venus_ai_supreme');
  assert.match(cfg['features[subscription_update][products][0][prices][0]'], /^price_/);
  assert.equal(cfg.default_return_url, `${SUPABASE}/functions/v1/stripe-webhook?return=portal`);
  // Supabase: una llamada a billing_upsert_price por plan.
  assert.equal(stripe.upserts.length, 6);
  assert.deepEqual(stripe.upserts[0], {
    fn: '/rest/v1/rpc/billing_upsert_price',
    p_plan: 'go',
    p_price: (result.rows as Obj[])[0].priceId,
    p_lookup_key: 'venus_ai_go_monthly',
    p_currency: 'usd',
    p_amount: 350,
    p_interval: 'month',
    p_livemode: false,
  });
  assert.equal(result.supabase, 'upserted');
});

test('segunda corrida: idempotente (no crea productos ni precios; solo actualiza el portal)', async () => {
  const stripe = new FakeStripeCatalog();
  await runSetup(stripe);
  const before = stripe.prices.size;
  stripe.calls = [];
  const { out } = await runSetup(stripe);
  assert.equal(stripe.prices.size, before);
  const posts = stripe.posts().map((c) => c.path);
  assert.deepEqual(posts, [`/v1/billing_portal/configurations/${stripe.portals[0].id}`]);
  assert.equal(stripe.portals.length, 1);
  // Volver a correrlo es lo que actualiza una configuración vieja (sin bajas al fin del período).
  const updated = stripe.portals[0].params as Record<string, string>;
  assert.equal(updated['features[subscription_update][schedule_at_period_end][conditions][0][type]'], 'decreasing_item_amount');
  assert.match(out, /sin cambios/);
  // Sin Supabase: imprime el SQL con los ids reales.
  assert.match(out, /select public\.billing_upsert_price\('go', 'price_\d+', 'venus_ai_go_monthly', 'usd', 350, 'month', false\);/);
});

test('cambió el monto: precio nuevo (se lleva el lookup_key) y el viejo queda inactivo', async () => {
  const stripe = new FakeStripeCatalog();
  stripe.products.set('venus_ai_go', { id: 'venus_ai_go', object: 'product', name: 'Venus IA Go', description: 'Plan Go de Venus IA, el asistente de Venus Launcher. Suscripción mensual.', active: true, metadata: { venus_plan: 'go', app: 'venus-launcher' }, default_price: null });
  const old = stripe.addPrice({ product: 'venus_ai_go', unit_amount: 300, lookup_key: 'venus_ai_go_monthly' });
  const leftover = stripe.addPrice({ product: 'venus_ai_go', unit_amount: 999 });
  const yearly = stripe.addPrice({ product: 'venus_ai_go', unit_amount: 3000, recurring: { interval: 'year', interval_count: 1 } });

  const dry = await runSetup(stripe, ['--dry-run']);
  assert.equal(stripe.posts().length, 0);
  assert.match(dry.out, /nuevo \(antes US\$ 3\.00: price_1\)/);

  const { result, out } = await runSetup(stripe);
  const goRow = (result.rows as Obj[]).find((r) => r.plan === 'go')!;
  assert.notEqual(goRow.priceId, old.id);
  const created = stripe.prices.get(String(goRow.priceId))!;
  assert.equal(created.unit_amount, 350);
  assert.equal(created.lookup_key, 'venus_ai_go_monthly');
  assert.equal(old.active, false);
  assert.equal(old.lookup_key, null);
  assert.equal(leftover.active, false);
  assert.equal(yearly.active, true, 'los precios que no son mensuales en USD no se tocan');
  assert.match(out, /dejo sin tocar el precio price_3/);
  const createCall = stripe.calls.find((c) => c.method === 'POST' && c.path === '/v1/prices' && c.params.lookup_key === 'venus_ai_go_monthly')!;
  assert.equal(createCall.params.transfer_lookup_key, 'true');
});

test('clave de producción: filas con livemode = true; sin clave o con opciones inválidas: error claro', async () => {
  const stripe = new FakeStripeCatalog();
  stripe.live = true;
  const { result, out } = await runSetup(stripe, [], { STRIPE_SECRET_KEY: 'sk_live_setup123456' });
  assert.equal(result.mode, 'live');
  assert.ok((result.rows as Obj[]).every((r) => r.livemode === true));
  assert.match(out, /PRODUCCIÓN/);
  assert.match(out, /'month', true\);/);

  await assert.rejects(runSetup(stripe, [], { STRIPE_SECRET_KEY: '' }), /Falta STRIPE_SECRET_KEY/);
  await assert.rejects(runSetup(stripe, [], { STRIPE_SECRET_KEY: 'pk_test_123456789' }), /Falta STRIPE_SECRET_KEY/);
  await assert.rejects(runSetup(stripe, ['--borrar-todo']), /Opción desconocida/);
  await assert.rejects(runSetup(stripe, [], { STRIPE_TAX_BEHAVIOR: 'raro' }), /STRIPE_TAX_BEHAVIOR/);
});

test('Supabase sin la migración 0009: error con la pista', async () => {
  const stripe = new FakeStripeCatalog();
  stripe.supabaseError = { status: 404, body: { code: 'PGRST202', message: 'Could not find the function' } };
  await assert.rejects(runSetup(stripe, [], { SUPABASE_URL: SUPABASE, SUPABASE_SERVICE_ROLE_KEY: 'service-key' }), /0009_billing\.sql/);
  stripe.supabaseError = { status: 409, body: { code: '23503', message: 'falta el plan' } };
  await assert.rejects(runSetup(stripe, [], { SUPABASE_URL: SUPABASE, SUPABASE_SERVICE_ROLE_KEY: 'service-key' }), /0008_ai_plans\.sql/);
});

test('--help no llama a Stripe', async () => {
  const stripe = new FakeStripeCatalog();
  const { out } = await runSetup(stripe, ['--help'], { STRIPE_SECRET_KEY: '' });
  assert.match(out, /--dry-run/);
  assert.equal(stripe.calls.length, 0);
});
