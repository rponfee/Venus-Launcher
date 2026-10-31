// Pruebas del flujo HTTP de "billing" (checkout, portal y estado) contra un Stripe falso (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutParams, createBillingHandler, portalParams } from '../handler.ts';
import type { BillingDeps } from '../handler.ts';
import { buildReturnUrls } from '../config.ts';
import { createStripeClient } from '../stripe.ts';
import { DAY, EMAIL, FakeDb, FakeStripe, NOW, NOW_SEC, OTHER_USER, USER, recorder, subscription } from './fakes.ts';

const URL_FN = 'https://proyecto.supabase.co/functions/v1/billing';
const URLS = buildReturnUrls('', 'https://proyecto.supabase.co')!;

function setup(overrides: Partial<BillingDeps> = {}) {
  const stripe = new FakeStripe();
  const db = new FakeDb();
  const log = recorder();
  let now = NOW;
  const deps: BillingDeps = {
    supabaseReady: true,
    stripe: createStripeClient({ secretKey: 'sk_test_fake12345678', fetch: stripe.fetch }),
    livemode: false,
    returnUrls: URLS,
    automaticTax: false,
    portalConfiguration: null,
    graceDays: 3,
    async verifyUser(token) {
      if (token === 'good') return { status: 'ok', userId: USER, email: EMAIL };
      if (token === 'anon') return { status: 'forbidden', reason: 'anonymous' };
      if (token === 'down') return { status: 'unavailable' };
      return { status: 'invalid' };
    },
    rpc: db.rpc,
    nowMs: () => now,
    logger: log.logger,
    ...overrides,
  };
  return { stripe, db, log, deps, handler: createBillingHandler(deps), tick: (ms: number) => (now += ms) };
}

function post(body: unknown, token = 'good'): Request {
  return new Request(URL_FN, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: 'anon', 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function get(query = '', token: string | null = 'good'): Request {
  return new Request(`${URL_FN}${query}`, { headers: token ? { Authorization: `Bearer ${token}`, apikey: 'anon' } : {} });
}

async function call(handler: (req: Request) => Promise<Response>, req: Request) {
  const res = await handler(req);
  const text = await res.text();
  return { status: res.status, body: (text.startsWith('{') ? JSON.parse(text) : { text }) as Record<string, unknown>, res };
}

test('OPTIONS responde CORS y la página de vuelta no pide sesión', async () => {
  const { handler } = setup();
  const res = await handler(new Request(URL_FN, { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/);
  const page = await handler(get('?return=success', null));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /^text\/plain/);
  assert.match(await page.text(), /Listo, volvé a Venus Launcher/);
  assert.match(await (await handler(get('?return=cancel', null))).text(), /No se hizo ningún cobro/);
});

test('sesión: sin token o inválido 401, anónimo 403, Auth caído 503', async () => {
  const { handler } = setup();
  assert.equal((await call(handler, get('', null))).status, 401);
  assert.equal((await call(handler, get('', 'bad'))).body.error, 'unauthorized');
  const anon = await call(handler, get('', 'anon'));
  assert.equal(anon.status, 403);
  assert.match(String(anon.body.message), /Iniciá sesión/);
  assert.equal((await call(handler, get('', 'down'))).status, 503);
  assert.equal((await call(handler, new Request(URL_FN, { method: 'PUT', headers: { Authorization: 'Bearer good' } }))).status, 405);
});

test('GET: estado sin plan y catálogo de precios del modo de la clave, sin llamar a Stripe', async () => {
  const { handler, stripe } = setup();
  const { status, body } = await call(handler, get());
  assert.equal(status, 200);
  assert.equal(body.mode, 'test');
  assert.equal(body.synced, null);
  const state = body.state as Record<string, unknown>;
  assert.equal(state.plan, null);
  assert.equal(state.active, false);
  assert.equal(state.hasCustomer, false);
  assert.equal('customerId' in state, false);
  const catalog = body.catalog as { id: string; name: string; price: { amount: number; currency: string; interval: string } }[];
  assert.deepEqual(
    catalog.map((p) => [p.id, p.name, p.price.amount]),
    [
      ['go', 'Go', 350],
      ['pro', 'Pro', 925],
      ['super', 'Super', 1350],
      ['ultra', 'Ultra', 2550],
      ['max', 'Max', 3650],
      ['supreme', 'Supreme', 4250],
    ],
  );
  assert.deepEqual(catalog[0].price, { amount: 350, currency: 'usd', interval: 'month' });
  assert.equal(stripe.calls.length, 0);
});

test('POST checkout: crea el cliente (email + metadata.user_id) y la sesión con los parámetros exactos', async () => {
  const { handler, stripe, db } = setup();
  const { status, body } = await call(handler, post({ action: 'checkout', plan: 'pro', locale: 'es' }));
  assert.equal(status, 200);
  assert.equal(body.kind, 'checkout');
  assert.match(String(body.url), /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(body.expiresAt, new Date((NOW_SEC + DAY) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));

  const created = stripe.callsTo('POST', '/v1/customers')[0];
  assert.equal(created.params.email, EMAIL);
  assert.equal(created.params['metadata[user_id]'], USER);
  assert.match(created.headers.get('idempotency-key') ?? '', new RegExp(`^venus-customer-${USER}-new-[0-9a-f]{12}$`));
  assert.deepEqual(db.callsTo('billing_link_customer')[0], { p_user: USER, p_customer: 'cus_new1', p_livemode: false, p_replace: false });

  const session = stripe.callsTo('POST', '/v1/checkout/sessions')[0].params;
  assert.deepEqual(session, {
    mode: 'subscription',
    customer: 'cus_new1',
    client_reference_id: USER,
    'line_items[0][price]': 'price_pro1',
    'line_items[0][quantity]': '1',
    'subscription_data[metadata][user_id]': USER,
    'subscription_data[metadata][plan_id]': 'pro',
    'metadata[user_id]': USER,
    'metadata[plan_id]': 'pro',
    allow_promotion_codes: 'true',
    success_url: 'https://proyecto.supabase.co/functions/v1/stripe-webhook?return=success',
    cancel_url: 'https://proyecto.supabase.co/functions/v1/stripe-webhook?return=cancel',
    locale: 'es-419',
  });
});

test('POST checkout dos veces: reutiliza el checkout abierto del mismo plan y vence el de otro plan', async () => {
  const { handler, stripe, tick } = setup();
  const first = await call(handler, post({ action: 'checkout', plan: 'pro' }));
  tick(3000);
  const again = await call(handler, post({ action: 'checkout', plan: 'pro' }));
  assert.equal(again.body.url, first.body.url);
  assert.equal(again.body.reused, true);
  assert.equal(stripe.callsTo('POST', '/v1/checkout/sessions').length, 1);
  assert.equal(stripe.callsTo('GET', '/v1/checkout/sessions')[0].params.status, 'open');

  // Otro plan: el checkout anterior se vence (no se pueden pagar los dos) y se crea uno nuevo.
  tick(3000);
  const other = await call(handler, post({ action: 'checkout', plan: 'ultra' }));
  assert.notEqual(other.body.url, first.body.url);
  assert.equal(stripe.callsTo('POST', `/v1/checkout/sessions/${first.body.sessionId}/expire`).length, 1);
  assert.equal(stripe.sessions.get(String(first.body.sessionId))?.status, 'expired');
  assert.equal(stripe.callsTo('POST', '/v1/checkout/sessions').length, 2);
});

test('POST checkout: si no se pueden listar los checkouts abiertos (permiso), sigue igual', async () => {
  const { handler, stripe, log } = setup();
  stripe.failures.set('GET /v1/checkout/sessions', () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'secret_key_required' } }), { status: 403 }));
  const { status, body } = await call(handler, post({ action: 'checkout', plan: 'go' }));
  assert.equal(status, 200);
  assert.equal(body.kind, 'checkout');
  assert.match(log.lines.join('\n'), /checkouts abiertos/);
});

test('POST checkout con BILLING_AUTOMATIC_TAX=1: impuestos automáticos y dirección guardada en el cliente', async () => {
  const { handler, stripe } = setup({ automaticTax: true });
  await call(handler, post({ action: 'checkout', plan: 'go' }));
  const session = stripe.callsTo('POST', '/v1/checkout/sessions')[0].params;
  assert.equal(session['automatic_tax[enabled]'], 'true');
  assert.equal(session['customer_update[address]'], 'auto');
  assert.equal(session['line_items[0][price]'], 'price_go1');
  assert.equal(session.locale, 'auto');
});

test('POST checkout: reutiliza el cliente guardado; si se borró en Stripe crea otro y lo reemplaza', async () => {
  const { handler, stripe, db, tick } = setup();
  db.customers.set(USER, { customerId: 'cus_A1', livemode: false });
  stripe.customers.set('cus_A1', { id: 'cus_A1', object: 'customer' });
  await call(handler, post({ action: 'checkout', plan: 'ultra' }));
  assert.equal(stripe.callsTo('POST', '/v1/customers').length, 0);
  assert.equal(stripe.callsTo('POST', '/v1/checkout/sessions')[0].params.customer, 'cus_A1');

  stripe.customers.set('cus_A1', { id: 'cus_A1', object: 'customer', deleted: true });
  tick(3000);
  await call(handler, post({ action: 'checkout', plan: 'ultra' }));
  const created = stripe.callsTo('POST', '/v1/customers');
  assert.equal(created.length, 1);
  assert.match(created[0].headers.get('idempotency-key') ?? '', /-cus_A1-/);
  const link = db.callsTo('billing_link_customer').at(-1);
  assert.equal(link?.p_replace, true);
  assert.match(String(link?.p_customer), /^cus_new\d+$/);
  assert.equal(db.customers.get(USER)?.customerId, link?.p_customer);
  assert.equal(stripe.callsTo('POST', '/v1/checkout/sessions').at(-1)?.params.customer, link?.p_customer);
});

test('POST checkout con una suscripción activa: portal con la confirmación del cambio de plan (no cobra dos veces)', async () => {
  const { handler, stripe, db } = setup();
  db.customers.set(USER, { customerId: 'cus_A1', livemode: false });
  stripe.customers.set('cus_A1', { id: 'cus_A1', object: 'customer' });
  stripe.subscriptions.set('sub_A1', subscription());
  const { status, body } = await call(handler, post({ action: 'checkout', plan: 'ultra', locale: 'en' }));
  assert.equal(status, 200);
  assert.equal(body.kind, 'portal');
  assert.equal(body.reason, 'already_subscribed');
  assert.match(String(body.url), /^https:\/\/billing\.stripe\.com\//);
  assert.equal(stripe.callsTo('POST', '/v1/checkout/sessions').length, 0);
  const portal = stripe.callsTo('POST', '/v1/billing_portal/sessions')[0].params;
  assert.deepEqual(portal, {
    customer: 'cus_A1',
    return_url: 'https://proyecto.supabase.co/functions/v1/stripe-webhook?return=portal',
    locale: 'en',
    configuration: 'bpc_venus',
    'flow_data[type]': 'subscription_update_confirm',
    'flow_data[subscription_update_confirm][subscription]': 'sub_A1',
    'flow_data[subscription_update_confirm][items][0][id]': 'si_A1',
    'flow_data[subscription_update_confirm][items][0][price]': 'price_ultra1',
    'flow_data[subscription_update_confirm][items][0][quantity]': '1',
    'flow_data[after_completion][type]': 'redirect',
    'flow_data[after_completion][redirect][return_url]': 'https://proyecto.supabase.co/functions/v1/stripe-webhook?return=portal',
  });
});

test('POST checkout del mismo plan que ya paga, o con past_due: portal común', async () => {
  const { handler, stripe, db } = setup();
  db.customers.set(USER, { customerId: 'cus_A1', livemode: false });
  stripe.customers.set('cus_A1', { id: 'cus_A1', object: 'customer' });
  stripe.subscriptions.set('sub_A1', subscription({ status: 'past_due' }));
  const { body } = await call(handler, post({ action: 'checkout', plan: 'pro' }));
  assert.equal(body.kind, 'portal');
  const portal = stripe.callsTo('POST', '/v1/billing_portal/sessions')[0].params;
  assert.equal(portal['flow_data[type]'], undefined);
});

test('POST checkout: si el portal no acepta el cambio directo, abre el portal común', async () => {
  const { handler, stripe, db, log } = setup();
  db.customers.set(USER, { customerId: 'cus_A1', livemode: false });
  stripe.customers.set('cus_A1', { id: 'cus_A1', object: 'customer' });
  stripe.subscriptions.set('sub_A1', subscription());
  stripe.rejectFlow = true;
  const { status, body } = await call(handler, post({ action: 'checkout', plan: 'max' }));
  assert.equal(status, 200);
  assert.equal(body.kind, 'portal');
  const calls = stripe.callsTo('POST', '/v1/billing_portal/sessions');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params['flow_data[type]'], undefined);
  assert.match(log.lines.join('\n'), /portal común/);
});

test('POST checkout con una suscripción vieja cancelada: checkout nuevo', async () => {
  const { handler, stripe, db } = setup();
  db.customers.set(USER, { customerId: 'cus_A1', livemode: false });
  stripe.customers.set('cus_A1', { id: 'cus_A1', object: 'customer' });
  stripe.subscriptions.set('sub_OLD', subscription({ id: 'sub_OLD', status: 'canceled' }));
  assert.equal((await call(handler, post({ action: 'checkout', plan: 'pro' }))).body.kind, 'checkout');
});

test('POST checkout: plan desconocido o que no está a la venta -> 400 unknown_plan', async () => {
  const { handler, stripe, db } = setup();
  db.prices = db.prices.filter((p) => p.plan !== 'max');
  for (const plan of ['free', 'max', '', 'PRO', '../go', 42]) {
    const { status, body } = await call(handler, post({ action: 'checkout', plan }));
    assert.equal(status, 400, String(plan));
    assert.equal(body.error, 'unknown_plan');
  }
  assert.equal(stripe.calls.length, 0);
});

test('POST portal: sesión del portal con la configuración de Venus; sin cliente 409', async () => {
  const { handler, stripe, db, tick } = setup();
  const none = await call(handler, post({ action: 'portal' }));
  assert.equal(none.status, 409);
  assert.equal(none.body.error, 'no_customer');

  db.customers.set(USER, { customerId: 'cus_A1', livemode: false });
  stripe.customers.set('cus_A1', { id: 'cus_A1', object: 'customer' });
  const { status, body } = await call(handler, post({ action: 'portal', locale: 'pt' }));
  assert.equal(status, 200);
  assert.equal(body.kind, 'portal');
  const params = stripe.callsTo('POST', '/v1/billing_portal/sessions')[0].params;
  assert.deepEqual(params, {
    customer: 'cus_A1',
    return_url: 'https://proyecto.supabase.co/functions/v1/stripe-webhook?return=portal',
    locale: 'pt-BR',
    configuration: 'bpc_venus',
  });
  // La configuración se busca una vez y queda en memoria.
  tick(3000);
  assert.equal((await call(handler, post({ action: 'portal' }))).status, 200);
  assert.equal(stripe.callsTo('GET', '/v1/billing_portal/configurations').length, 1);

  // Cliente borrado en Stripe: 409.
  stripe.customers.delete('cus_A1');
  tick(3000);
  assert.equal((await call(handler, post({ action: 'portal' }))).status, 409);
});

test('POST: un pedido a Stripe por usuario cada 3 s (429 busy), sin gastar el turno en los pedidos inválidos', async () => {
  const { handler, stripe, tick } = setup({
    async verifyUser(token) {
      if (token === 'good') return { status: 'ok', userId: USER, email: EMAIL };
      return token === 'other' ? { status: 'ok', userId: OTHER_USER, email: null } : { status: 'invalid' };
    },
  });
  // Pedidos que no llegan a Stripe (plan desconocido, sin cliente) no toman el turno.
  assert.equal((await call(handler, post({ action: 'checkout', plan: 'mega' }))).status, 400);
  assert.equal((await call(handler, post({ action: 'portal' }))).status, 409);
  assert.equal((await call(handler, post({ action: 'checkout', plan: 'pro' }))).status, 200);
  const before = stripe.calls.length;
  // Alternar planes enseguida (lo que agotaba el límite de la API de Stripe) ya no llega a Stripe.
  for (const plan of ['ultra', 'pro', 'max']) {
    const { status, body, res } = await call(handler, post({ action: 'checkout', plan }));
    assert.equal(status, 429, plan);
    assert.equal(body.error, 'busy');
    assert.match(String(body.message), /Esperá unos segundos/);
    assert.equal(res.headers.get('retry-after'), '3');
  }
  tick(1000);
  const portal = await call(handler, post({ action: 'portal' }));
  assert.equal(portal.status, 429, 'el portal comparte el turno con el checkout');
  assert.equal(portal.res.headers.get('retry-after'), '2');
  assert.equal(stripe.calls.length, before);
  // Otro usuario no espera por este; pasados los 3 s, vuelve a andar.
  assert.equal((await call(handler, post({ action: 'checkout', plan: 'pro' }, 'other'))).status, 200);
  tick(2000);
  assert.equal((await call(handler, post({ action: 'checkout', plan: 'ultra' }))).status, 200);
});

test('POST portal con BILLING_PORTAL_CONFIGURATION: la usa sin buscar', async () => {
  const { handler, stripe, db } = setup({ portalConfiguration: 'bpc_secreto' });
  db.customers.set(USER, { customerId: 'cus_A1', livemode: false });
  stripe.customers.set('cus_A1', { id: 'cus_A1', object: 'customer' });
  await call(handler, post({ action: 'portal' }));
  assert.equal(stripe.callsTo('POST', '/v1/billing_portal/sessions')[0].params.configuration, 'bpc_secreto');
  assert.equal(stripe.callsTo('GET', '/v1/billing_portal/configurations').length, 0);
});

test('GET ?sync=1: lee de Stripe la suscripción del usuario y la guarda (si el webhook se atrasó); con un límite de frecuencia', async () => {
  const { handler, stripe, db, tick } = setup();
  db.customers.set(USER, { customerId: 'cus_A1', livemode: false });
  stripe.subscriptions.set('sub_A1', subscription({}, { price: 'price_super1' }));
  const { body } = await call(handler, get('?sync=1'));
  assert.equal(body.synced, true);
  const state = body.state as Record<string, unknown>;
  assert.equal(state.plan, 'super');
  assert.equal(state.active, true);
  assert.equal(state.managedByStripe, true);
  assert.equal(state.currentPeriodEnd, new Date((NOW_SEC + 28 * DAY) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const listed = stripe.callsTo('GET', '/v1/subscriptions')[0].params;
  assert.equal(listed.customer, 'cus_A1');
  assert.equal(listed['expand[0]'], 'data.latest_invoice');

  // Dentro de los 10 s siguientes no vuelve a llamar a Stripe.
  await call(handler, get('?sync=1'));
  assert.equal(stripe.callsTo('GET', '/v1/subscriptions').length, 1);
  tick(11000);
  await call(handler, get('?sync=1'));
  assert.equal(stripe.callsTo('GET', '/v1/subscriptions').length, 2);
});

test('GET ?sync=1 sin cliente o con Stripe caído: devuelve el estado igual', async () => {
  const { handler, stripe, db, log } = setup();
  assert.equal((await call(handler, get('?sync=1'))).body.synced, false);
  db.customers.set(USER, { customerId: 'cus_A1', livemode: false });
  stripe.failures.set('GET /v1/subscriptions', () => new Response('{}', { status: 500 }));
  const { status, body } = await call(handler, get('?sync=1'));
  assert.equal(status, 200);
  assert.equal(body.synced, false);
  assert.match(log.lines.join('\n'), /no se pudo sincronizar/);
});

test('Stripe falla en el checkout: 502 { error: "stripe" } sin datos del usuario en los logs', async () => {
  const { handler, stripe, log } = setup();
  stripe.failures.set('POST /v1/checkout/sessions', () => new Response(JSON.stringify({ error: { type: 'api_error', message: `falló para ${EMAIL}` } }), { status: 500 }));
  const { status, body } = await call(handler, post({ action: 'checkout', plan: 'pro' }));
  assert.equal(status, 502);
  assert.equal(body.error, 'stripe');
  assert.equal(body.code, 'api_error');
  assert.doesNotMatch(log.lines.join('\n'), /jugador\.secreto/);
});

test('base sin la migración 0009: 503 backend_not_ready; otra falla: db_unavailable', async () => {
  const { handler, db } = setup();
  db.failures.set('billing_state', 'PGRST202');
  const missing = await call(handler, get());
  assert.equal(missing.status, 503);
  assert.equal(missing.body.error, 'backend_not_ready');
  db.failures.set('billing_state', '08006');
  assert.equal((await call(handler, get())).body.error, 'db_unavailable');
});

test('sin STRIPE_SECRET_KEY: GET funciona y POST responde 503 not_configured', async () => {
  const { handler } = setup({ stripe: null });
  assert.equal((await call(handler, get())).status, 200);
  const { status, body } = await call(handler, post({ action: 'checkout', plan: 'pro' }));
  assert.equal(status, 503);
  assert.equal(body.error, 'not_configured');
});

test('pedidos inválidos: sin JSON, JSON roto o acción desconocida -> 400', async () => {
  const { handler } = setup();
  const noJson = new Request(URL_FN, { method: 'POST', headers: { Authorization: 'Bearer good', 'Content-Type': 'text/plain' }, body: 'hola' });
  assert.equal((await call(handler, noJson)).status, 400);
  assert.equal((await call(handler, post('{roto'))).status, 400);
  const bad = await call(handler, post({ action: 'refund' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'bad_request');
});

test('builders: checkoutParams y portalParams sin opcionales', () => {
  const params = checkoutParams({ customerId: 'cus_1', userId: USER, planId: 'go', priceId: 'price_go1', urls: URLS, locale: 'auto', automaticTax: false });
  assert.equal(params.automatic_tax, undefined);
  assert.equal(params.allow_promotion_codes, true);
  const portal = portalParams({ customerId: 'cus_1', returnUrl: URLS.portal, locale: 'auto', configuration: null });
  assert.deepEqual(portal, { customer: 'cus_1', return_url: URLS.portal, locale: 'auto', configuration: undefined });
});
