// Pruebas de cupones y códigos de promoción de "admin": validación, pedidos exactos a Stripe, vuelta atrás si el
// código falla y lo que ve el panel (sin datos de clientes) (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { couponParams, couponView, promoParams, promoView, validateCoupon, validatePromo } from '../coupons.ts';
import { encodeForm } from '../../billing/stripe.ts';
import { DAY, NOW, setup } from './fakes.ts';

type Obj = Record<string, unknown>;
const result = (body: Obj) => body.result as Obj;

function rejects(raw: unknown, field: string) {
  assert.throws(
    () => validateCoupon(raw, NOW),
    (err: Error & { extra?: Obj; code?: string }) => err.code === 'bad_request' && err.extra?.field === field,
    `esperaba un error en ${field}`,
  );
}

test('validación del cupón: porcentaje O monto, duración y meses', () => {
  const ok = validateCoupon({ percentOff: 20, duration: 'repeating', durationInMonths: 3, promo: { code: 'venus20' } }, NOW);
  assert.equal(ok.percentOff, 20);
  assert.equal(ok.amountOff, null);
  assert.equal(ok.durationInMonths, 3);
  assert.equal(ok.promo?.code, 'VENUS20'); // en mayúsculas
  assert.equal(validateCoupon({ amountOff: 150, duration: 'once' }, NOW).amountOff, 150);
  assert.equal(validateCoupon({ percentOff: 12.5, duration: 'forever' }, NOW).percentOff, 12.5);

  rejects({ duration: 'once' }, 'percentOff'); // ninguno
  rejects({ percentOff: 10, amountOff: 100, duration: 'once' }, 'amountOff'); // los dos
  rejects({ percentOff: 0, duration: 'once' }, 'percentOff');
  rejects({ percentOff: 101, duration: 'once' }, 'percentOff');
  rejects({ percentOff: 10.555, duration: 'once' }, 'percentOff');
  rejects({ amountOff: 12.5, duration: 'once' }, 'amountOff'); // centavos enteros
  rejects({ amountOff: 0, duration: 'once' }, 'amountOff');
  rejects({ percentOff: 10, duration: 'weekly' }, 'duration');
  rejects({ percentOff: 10, duration: 'repeating' }, 'durationInMonths');
  rejects({ percentOff: 10, duration: 'repeating', durationInMonths: 37 }, 'durationInMonths');
  rejects({ percentOff: 10, duration: 'once', durationInMonths: 3 }, 'durationInMonths');
  rejects({ percentOff: 10, duration: 'once', appliesTo: ['Pro'] }, 'appliesTo');
  rejects({ percentOff: 10, duration: 'once', name: 'x'.repeat(41) }, 'name');
  rejects({ percentOff: 10, duration: 'once', maxRedemptions: 0 }, 'maxRedemptions');
  rejects({ percentOff: 10, duration: 'once', redeemBy: '2026-10-01T00:00:00Z' }, 'redeemBy'); // pasado
  rejects({ percentOff: 10, duration: 'once', redeemBy: '2035-01-01T00:00:00Z' }, 'redeemBy'); // demasiado lejos
  rejects({ percentOff: 10, duration: 'once', promo: { code: 'VENUS-20' } }, 'promo.code'); // símbolos
  rejects({ percentOff: 10, duration: 'once', promo: { code: 'AB' } }, 'promo.code');
  rejects({ percentOff: 10, duration: 'once', promo: { code: 'VENUS 20' } }, 'promo.code');
  rejects(
    { percentOff: 10, duration: 'once', redeemBy: new Date(NOW + 10 * DAY).toISOString(), promo: { code: 'LATE', expiresAt: new Date(NOW + 20 * DAY).toISOString() } },
    'promo.expiresAt',
  );
  rejects({ percentOff: 10, duration: 'once', promo: { code: 'OKCODE', firstTimeOnly: 'si' } }, 'promo.firstTimeOnly');
});

test('pedidos exactos a Stripe del cupón y del código', () => {
  const input = validateCoupon(
    {
      name: 'Lanzamiento',
      percentOff: 20,
      duration: 'repeating',
      durationInMonths: 3,
      appliesTo: ['pro', 'max'],
      maxRedemptions: 100,
      redeemBy: '2026-12-31T23:59:59Z',
      promo: { code: 'VENUS20', expiresAt: '2026-12-15T00:00:00Z', firstTimeOnly: true, maxRedemptions: 50 },
    },
    NOW,
  );
  assert.equal(
    decodeURIComponent(encodeForm(couponParams(input, ['venus_ai_pro', 'venus_ai_max']))),
    'duration=repeating&metadata[app]=venus-launcher&percent_off=20&duration_in_months=3&name=Lanzamiento&max_redemptions=100&redeem_by=1798761599&applies_to[products][0]=venus_ai_pro&applies_to[products][1]=venus_ai_max',
  );
  assert.equal(
    decodeURIComponent(encodeForm(promoParams('cpn_1', input.promo!))),
    'coupon=cpn_1&code=VENUS20&metadata[app]=venus-launcher&expires_at=1797292800&max_redemptions=50&restrictions[first_time_transaction]=true',
  );
  const amount = validateCoupon({ amountOff: 250, duration: 'once' }, NOW);
  assert.equal(decodeURIComponent(encodeForm(couponParams(amount, []))), 'duration=once&metadata[app]=venus-launcher&amount_off=250&currency=usd');
  assert.equal(decodeURIComponent(encodeForm(promoParams('cpn_2', validatePromo({ code: 'hola123' }, NOW)))), 'coupon=cpn_2&code=HOLA123&metadata[app]=venus-launcher');
});

test('lo que ve el panel: sin el cliente de un código restringido ni el mensaje de Stripe', () => {
  const promo = promoView({ id: 'promo_9', code: 'VIP', active: true, coupon: { id: 'cpn_9' }, customer: 'cus_SECRETO', restrictions: { first_time_transaction: false }, created: 1762000000 })!;
  assert.equal(promo.restricted, true);
  assert.ok(!JSON.stringify(promo).includes('cus_SECRETO'));
  assert.equal(promo.couponId, 'cpn_9');
  // Forma nueva de la API (promotion.coupon) también se reconoce.
  assert.equal(promoView({ id: 'promo_8', code: 'X1X', promotion: { type: 'coupon', coupon: 'cpn_8' } })!.couponId, 'cpn_8');
  const coupon = couponView({ id: 'cpn_9', percent_off: 15, duration: 'forever', applies_to: { products: ['venus_ai_pro', 'prod_otro'] }, metadata: { app: 'venus-launcher' }, created: 1762000000 }, [promo])!;
  assert.deepEqual(coupon.appliesTo, { products: ['venus_ai_pro', 'prod_otro'], plans: ['pro'] });
  assert.equal(coupon.venus, true);
  assert.equal(coupon.promotionCodes.length, 1);
  assert.equal(coupon.createdAt, '2025-11-01T12:26:40Z');
});

test('coupons.list: cupones con sus códigos y la aclaración del checkout', async () => {
  const { call, stripe } = setup();
  const res = await call('coupons.list');
  assert.equal(res.status, 200);
  const r = result(res.body);
  assert.equal(r.configured, true);
  assert.equal(r.mode, 'test');
  assert.equal(r.checkoutAcceptsCodes, true);
  const coupons = r.coupons as Obj[];
  assert.equal(coupons[0].id, 'VENUS20');
  assert.equal((coupons[0].promotionCodes as Obj[])[0].code, 'VENUS20');
  assert.ok(!res.text.includes('cus_SECRET'));
  assert.deepEqual(stripe.callsTo('GET', '/v1/coupons')[0].params, { limit: '100', 'expand[0]': 'data.applies_to' });
});

test('sin STRIPE_SECRET_KEY: la lista dice "no configurado" y crear responde 503', async () => {
  const { call } = setup({ noStripe: true });
  const list = await call('coupons.list');
  assert.equal(list.status, 200);
  assert.equal(result(list.body).configured, false);
  assert.match(String(result(list.body).message), /STRIPE_SECRET_KEY/);
  const create = await call('coupons.create', { percentOff: 10, duration: 'once' });
  assert.equal(create.status, 503);
  assert.equal(create.body.error, 'stripe_not_configured');
  assert.equal((await call('coupons.delete', { couponId: 'VENUS20' })).status, 503);
});

test('coupons.create: crea el cupón para los productos de los planes y su código; queda en el registro', async () => {
  const { call, stripe, db } = setup();
  const res = await call('coupons.create', {
    name: 'Lanzamiento',
    percentOff: 20,
    duration: 'repeating',
    durationInMonths: 3,
    appliesTo: ['pro'],
    promo: { code: 'lanza20', firstTimeOnly: true },
  });
  assert.equal(res.status, 200);
  const created = result(res.body);
  assert.equal((created.coupon as Obj).percentOff, 20);
  assert.equal((created.promotionCode as Obj).code, 'LANZA20');
  const couponCall = stripe.callsTo('POST', '/v1/coupons')[0];
  assert.equal(couponCall.params['applies_to[products][0]'], 'venus_ai_pro');
  assert.equal(couponCall.headers.get('authorization'), 'Bearer sk_test_fake12345678');
  assert.equal(couponCall.headers.get('stripe-version'), '2025-03-31.basil');
  const promoCall = stripe.callsTo('POST', '/v1/promotion_codes')[0];
  assert.equal(promoCall.params.coupon, (created.coupon as Obj).id);
  assert.equal(promoCall.params['restrictions[first_time_transaction]'], 'true');
  assert.equal(db.actions[0].action, 'coupons.create');
  assert.deepEqual(db.actions[0].details, {
    couponId: (created.coupon as Obj).id,
    name: 'Lanzamiento',
    kind: 'percent',
    value: 20,
    duration: 'repeating',
    months: 3,
    appliesTo: ['pro'],
    maxRedemptions: null,
    redeemBy: null,
    promoCode: 'LANZA20',
    promoId: (created.promotionCode as Obj).id,
  });
  assert.equal(db.actions[0].target_user, null);
});

test('coupons.create: un plan que no existe se rechaza antes de llamar a Stripe', async () => {
  const { call, stripe } = setup();
  const res = await call('coupons.create', { percentOff: 10, duration: 'once', appliesTo: ['mega'] });
  assert.equal(res.status, 400);
  assert.equal(res.body.field, 'appliesTo');
  assert.equal(stripe.calls.length, 0);
});

test('coupons.create: si el código ya existe, se borra el cupón recién creado y responde 409', async () => {
  const { call, stripe, db } = setup();
  const res = await call('coupons.create', { percentOff: 50, duration: 'once', promo: { code: 'VENUS20' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'promo_code_taken');
  assert.ok(!res.text.includes('jugador@example.com'), 'el mensaje crudo de Stripe no tiene que llegar al panel');
  const created = stripe.callsTo('POST', '/v1/coupons')[0];
  assert.ok(created);
  const deleted = stripe.callsTo('DELETE', /^\/v1\/coupons\//);
  assert.equal(deleted.length, 1);
  assert.equal(stripe.coupons.size, 1); // solo queda el VENUS20 de antes
  assert.equal(db.actions.length, 0);
});

test('agregar, desactivar y reactivar códigos; borrar cupones', async () => {
  const { call, stripe, db } = setup();
  const add = await call('coupons.addPromo', { couponId: 'VENUS20', code: 'amigos', maxRedemptions: 10 });
  assert.equal(add.status, 200);
  const promoId = (result(add.body).promotionCode as Obj).id as string;
  const off = await call('coupons.deactivatePromo', { promoId });
  assert.equal((result(off.body).promotionCode as Obj).active, false);
  assert.equal(stripe.callsTo('POST', `/v1/promotion_codes/${promoId}`)[0].params.active, 'false');
  const on = await call('coupons.activatePromo', { promoId });
  assert.equal((result(on.body).promotionCode as Obj).active, true);
  assert.equal((await call('coupons.deactivatePromo', { promoId: 'VENUS20' })).status, 400); // no es un id de código
  const del = await call('coupons.delete', { couponId: 'VENUS20' });
  assert.equal(del.status, 200);
  assert.equal(stripe.callsTo('DELETE', '/v1/coupons/VENUS20').length, 1);
  assert.deepEqual(db.actions.map((a) => a.action), ['coupons.addPromo', 'coupons.deactivatePromo', 'coupons.activatePromo', 'coupons.delete']);
  const missing = await call('coupons.delete', { couponId: 'NOEXISTE' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.reason, 'stripe_missing');
});

test('coupons.addPromo: el código no puede vencer después que el cupón', async () => {
  const { call, stripe } = setup();
  stripe.coupons.get('VENUS20')!.redeem_by = Math.floor((NOW + 5 * DAY) / 1000);
  const res = await call('coupons.addPromo', { couponId: 'VENUS20', code: 'TARDE', expiresAt: new Date(NOW + 10 * DAY).toISOString() });
  assert.equal(res.status, 400);
  assert.equal(res.body.field, 'expiresAt');
});
