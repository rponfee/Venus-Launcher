// Pruebas del cambio de precio de un plan (Stripe + ai_plan_prices + portal) y de la edición de planes (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portalProducts, priceParams } from '../prices.ts';
import { encodeForm } from '../../billing/stripe.ts';
import { setup } from './fakes.ts';

type Obj = Record<string, unknown>;
const result = (body: Obj) => body.result as Obj;

test('portalProducts: reemplaza solo el precio del producto del plan (y lo agrega si faltaba)', () => {
  const config = {
    features: {
      subscription_update: {
        products: [
          { product: 'venus_ai_go', prices: ['price_go1'] },
          { product: 'venus_ai_pro', prices: ['price_pro1', 'price_pro0'] },
        ],
      },
    },
  };
  assert.deepEqual(portalProducts(config, 'venus_ai_pro', 'price_pro2'), [
    { product: 'venus_ai_go', prices: ['price_go1'] },
    { product: 'venus_ai_pro', prices: ['price_pro2'] },
  ]);
  assert.deepEqual(portalProducts(config, 'venus_ai_max', 'price_max1').at(-1), { product: 'venus_ai_max', prices: ['price_max1'] });
  assert.deepEqual(portalProducts({}, 'venus_ai_go', 'price_go2'), [{ product: 'venus_ai_go', prices: ['price_go2'] }]);
});

test('priceParams: como scripts/stripe-setup.js (lookup_key que se transfiere, mensual en USD)', () => {
  assert.equal(
    decodeURIComponent(encodeForm(priceParams({ product: 'venus_ai_pro', planId: 'pro', planName: 'Pro', amount: 999, transferLookupKey: true, taxBehavior: 'exclusive' }))),
    'product=venus_ai_pro&currency=usd&unit_amount=999&recurring[interval]=month&recurring[interval_count]=1&lookup_key=venus_ai_pro_monthly&transfer_lookup_key=true&nickname=Venus IA Pro mensual&metadata[venus_plan]=pro&metadata[app]=venus-launcher&tax_behavior=exclusive',
  );
  assert.ok(!encodeForm(priceParams({ product: 'p', planId: 'go', planName: 'Go', amount: 350, transferLookupKey: false, taxBehavior: null })).includes('transfer_lookup_key'));
});

test('plans.setPrice: precio nuevo en Stripe, ai_plan_prices, el viejo inactivo, producto, portal y price_usd', async () => {
  const { call, stripe, db } = setup();
  const res = await call('plans.setPrice', { planId: 'go', amount: 399, confirm: true });
  assert.equal(res.status, 200, res.text);
  const r = result(res.body);
  const newPrice = r.priceId as string;
  assert.match(newPrice, /^price_new/);
  assert.equal(r.previousPriceId, 'price_go1');
  assert.equal(r.previousAmount, 350);
  assert.equal(r.portal, 'updated');
  assert.deepEqual(r.warnings, []);

  // 1) Lee el precio vigente (producto y tax_behavior) y crea el nuevo con idempotencia.
  assert.equal(stripe.callsTo('GET', '/v1/prices/price_go1').length, 1);
  const created = stripe.callsTo('POST', '/v1/prices')[0];
  assert.equal(created.params.product, 'venus_ai_go');
  assert.equal(created.params.unit_amount, '399');
  assert.equal(created.params.currency, 'usd');
  assert.equal(created.params['recurring[interval]'], 'month');
  assert.equal(created.params.lookup_key, 'venus_ai_go_monthly');
  assert.equal(created.params.transfer_lookup_key, 'true');
  assert.equal(created.params.tax_behavior, 'exclusive');
  assert.match(created.headers.get('idempotency-key') ?? '', /^venus-admin-price-go-399-price_go1-\d+$/);
  // 2) La base: billing_upsert_price con el modo de la clave.
  assert.deepEqual(db.callsTo('billing_upsert_price')[0], {
    p_plan: 'go',
    p_price: newPrice,
    p_lookup_key: 'venus_ai_go_monthly',
    p_currency: 'usd',
    p_amount: 399,
    p_interval: 'month',
    p_livemode: false,
  });
  // 3) El anterior deja de venderse y el nuevo es el del producto.
  assert.equal(stripe.callsTo('POST', '/v1/prices/price_go1')[0].params.active, 'false');
  assert.equal(stripe.products.get('venus_ai_go')?.default_price, newPrice);
  // 4) El portal ofrece el precio nuevo (Pro no cambia).
  const portal = stripe.callsTo('POST', '/v1/billing_portal/configurations/bpc_venus')[0];
  assert.equal(portal.params['features[subscription_update][products][0][product]'], 'venus_ai_go');
  assert.equal(portal.params['features[subscription_update][products][0][prices][0]'], newPrice);
  assert.equal(portal.params['features[subscription_update][products][1][prices][0]'], 'price_pro1');
  // 5) price_usd informativo y registro.
  assert.deepEqual(db.callsTo('admin_update_plan')[0], { p_plan: 'go', p_patch: { price_usd: 3.99 } });
  assert.equal(db.actions[0].action, 'plans.setPrice');
  assert.deepEqual(db.actions[0].details, { planId: 'go', amount: 399, previousAmount: 350, priceId: newPrice, previousPriceId: 'price_go1', livemode: false, portal: 'updated' });
  assert.equal(((r.plan as Obj).prices as Obj[]).find((p) => p.active)?.priceId, newPrice);
});

test('plans.setPrice: dos clics seguidos no crean dos precios', async () => {
  const { call, stripe } = setup();
  await call('plans.setPrice', { planId: 'pro', amount: 999, confirm: true });
  // El segundo pedido ya ve el precio nuevo como vigente: mismo precio -> 409, sin crear otro.
  const again = await call('plans.setPrice', { planId: 'pro', amount: 999, confirm: true });
  assert.equal(again.status, 409);
  assert.equal(again.body.reason, 'same_price');
  assert.equal(stripe.callsTo('POST', '/v1/prices').length, 1);
});

test('plans.setPrice: confirmación, montos, plan inexistente y sin Stripe', async () => {
  const { call, stripe } = setup();
  const noConfirm = await call('plans.setPrice', { planId: 'go', amount: 399 });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.field, 'confirm');
  assert.equal((await call('plans.setPrice', { planId: 'go', amount: 49, confirm: true })).status, 400);
  assert.equal((await call('plans.setPrice', { planId: 'go', amount: 3.99, confirm: true })).status, 400);
  assert.equal((await call('plans.setPrice', { planId: 'mega', amount: 399, confirm: true })).status, 400);
  assert.equal(stripe.callsTo('POST', '/v1/prices').length, 0);
  const off = setup({ noStripe: true });
  assert.equal((await off.call('plans.setPrice', { planId: 'go', amount: 399, confirm: true })).status, 503);
});

test('plans.setPrice: sin precio en este modo usa el producto venus_ai_<plan> (y avisa si no existe)', async () => {
  const live = setup({ livemode: true }); // los precios de prueba no cuentan en producción
  const res = await live.call('plans.setPrice', { planId: 'go', amount: 399, confirm: true });
  assert.equal(res.status, 200, res.text);
  assert.equal(live.stripe.callsTo('GET', '/v1/products/venus_ai_go').length, 1);
  assert.equal(live.stripe.callsTo('POST', '/v1/prices')[0].params.transfer_lookup_key, undefined);
  assert.equal(result(res.body).previousPriceId, null);
  assert.equal(live.db.callsTo('billing_upsert_price')[0].p_livemode, true);

  const missing = setup();
  missing.stripe.products.delete('venus_ai_old');
  missing.db.plans.get('old')!.active = true;
  const none = await missing.call('plans.setPrice', { planId: 'old', amount: 500, confirm: true });
  assert.equal(none.status, 404);
  assert.equal(none.body.reason, 'no_product');
  assert.match(String(none.body.message), /stripe-setup/);
});

test('plans.setPrice: si Stripe falla al crear el precio no se toca la base', async () => {
  const { call, stripe, db } = setup();
  stripe.failures.set('POST /v1/prices', () => new Response(JSON.stringify({ error: { type: 'api_error', message: 'datos' } }), { status: 500 }));
  const res = await call('plans.setPrice', { planId: 'go', amount: 399, confirm: true });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'stripe');
  assert.equal(db.callsTo('billing_upsert_price').length, 0);
  assert.equal(db.actions.length, 0);
});

test('plans.setPrice: si la base falla después de crear el precio, avisa que se puede reintentar sin duplicar', async () => {
  const { call, db, stripe } = setup();
  db.failures.set('billing_upsert_price', '57014');
  const res = await call('plans.setPrice', { planId: 'go', amount: 399, confirm: true });
  assert.equal(res.status, 503);
  assert.equal(res.body.reason, 'price_not_saved');
  db.failures.delete('billing_upsert_price');
  const retry = await call('plans.setPrice', { planId: 'go', amount: 399, confirm: true });
  assert.equal(retry.status, 200);
  // La misma clave de idempotencia: Stripe devolvió el mismo precio.
  assert.equal(result(retry.body).priceId, (res.body as Obj).priceId);
  assert.equal(stripe.prices.size, 3);
});

test('plans.setPrice: portal no encontrado = aviso (el precio se cambia igual)', async () => {
  const { call, stripe } = setup();
  stripe.portal.metadata = {};
  const res = await call('plans.setPrice', { planId: 'go', amount: 450, confirm: true });
  assert.equal(res.status, 200);
  assert.deepEqual(result(res.body).warnings, [{ code: 'portal_not_found' }]);
});

test('plans.update: valida y pasa solo los cambios; el precio no se puede cambiar por acá', async () => {
  const { call, db } = setup();
  const res = await call('plans.update', {
    planId: 'pro',
    patch: {
      monthlyBudgetUsd: 5.5,
      maxCallsPerTurn: 50,
      active: true,
      models: [
        { id: 'haiku', efforts: ['high', 'low', 'low'], daily: 30, weekly: 150 },
        { id: 'opus', remove: true },
      ],
    },
  });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(db.callsTo('admin_update_plan')[0], {
    p_plan: 'pro',
    p_patch: {
      monthly_budget_usd: 5.5,
      max_calls_per_turn: 50,
      active: true,
      models: [
        { model_id: 'haiku', efforts: ['low', 'high'], daily_questions: 30, weekly_questions: 150 },
        { model_id: 'opus', remove: true },
      ],
    },
  });
  assert.equal(db.actions[0].action, 'plans.update');
  const price = await call('plans.update', { planId: 'pro', patch: { priceUsd: 1 } });
  assert.equal(price.status, 400);
  assert.match(String(price.body.message), /Cambiar precio/);
  assert.equal((await call('plans.update', { planId: 'pro', patch: {} })).status, 400);
  assert.equal((await call('plans.update', { planId: 'pro', patch: { maxTokensPerRequest: 50000 } })).status, 400);
  assert.equal((await call('plans.update', { planId: 'pro', patch: { monthlyBudgetUsd: 1.234 } })).status, 400);
  assert.equal((await call('plans.update', { planId: 'pro', patch: { models: [{ id: 'gpt', efforts: ['low'], daily: 1, weekly: 1 }] } })).status, 400);
  assert.equal((await call('plans.update', { planId: 'pro', patch: { models: [{ id: 'haiku', efforts: [], daily: 1, weekly: 1 }] } })).status, 400);
  assert.equal((await call('plans.update', { planId: 'nada', patch: { active: false } })).status, 400);
});

test('plans.list: planes, modelos y el estado de Stripe', async () => {
  const { call } = setup();
  const res = await call('plans.list');
  const r = result(res.body);
  assert.equal((r.plans as Obj[]).length, 3);
  assert.deepEqual(r.stripe, { configured: true, mode: 'test' });
});
