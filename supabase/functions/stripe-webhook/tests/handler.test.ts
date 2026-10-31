// Pruebas del flujo HTTP del webhook con dobles de Stripe y de la base (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookHandler } from '../handler.ts';
import type { WebhookDeps } from '../handler.ts';
import { signatureHeader } from '../signature.ts';
import { createStripeClient } from '../../billing/stripe.ts';
import { DAY, EMAIL, FakeDb, FakeStripe, NOW, NOW_SEC, OTHER_USER, USER, recorder, subscription } from '../../billing/tests/fakes.ts';

const URL_FN = 'https://proyecto.supabase.co/functions/v1/stripe-webhook';
const SECRET = 'whsec_test_webhook_0123456789abcdef';
const CARD = '4242'; // nunca tiene que aparecer en los logs

function setup(overrides: Partial<WebhookDeps> = {}) {
  const stripe = new FakeStripe();
  const db = new FakeDb();
  const log = recorder();
  stripe.customers.set('cus_A1', { id: 'cus_A1', object: 'customer', email: EMAIL });
  stripe.subscriptions.set('sub_A1', subscription());
  let now = NOW;
  const deps: WebhookDeps = {
    secrets: [SECRET],
    stripe: createStripeClient({ secretKey: 'sk_test_fake12345678', fetch: stripe.fetch }),
    livemode: false,
    dbReady: true,
    graceDays: 3,
    rpc: db.rpc,
    nowMs: () => now,
    logger: log.logger,
    ...overrides,
  };
  return { stripe, db, log, deps, handler: createWebhookHandler(deps), tick: (ms: number) => (now += ms) };
}

function event(type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id: `evt_${type.replace(/\W/g, '')}_1`, object: 'event', type, livemode: false, created: NOW_SEC, data: { object }, ...extra };
}

async function signed(body: unknown, opts: { secret?: string; t?: number; header?: string | null } = {}): Promise<Request> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const header = opts.header !== undefined ? opts.header : await signatureHeader(opts.secret ?? SECRET, opts.t ?? NOW_SEC, raw);
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  if (header) headers['stripe-signature'] = header;
  return new Request(URL_FN, { method: 'POST', headers, body: raw });
}

async function send(handler: (req: Request) => Promise<Response>, req: Request) {
  const res = await handler(req);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { text };
  }
  return { status: res.status, body, res };
}

const subEvent = (type = 'customer.subscription.updated', id = 'sub_A1') => event(type, { id, object: 'subscription', status: 'active', customer: 'cus_A1' });

test('sin firma, firma inválida, otro secreto o vieja: 400 y no toca ni la base ni Stripe', async () => {
  const { handler, db, stripe, log } = setup();
  const ev = subEvent();
  const cases = [
    await signed(ev, { header: null }),
    await signed(ev, { header: `t=${NOW_SEC},v1=${'0'.repeat(64)}` }),
    await signed(ev, { secret: 'whsec_otro_secreto_123456789' }),
    await signed(ev, { t: NOW_SEC - 301 }),
  ];
  for (const req of cases) {
    const { status, body } = await send(handler, req);
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_signature');
  }
  // Cuerpo cambiado después de firmar.
  const raw = JSON.stringify(ev);
  const header = await signatureHeader(SECRET, NOW_SEC, raw);
  const tampered = new Request(URL_FN, { method: 'POST', headers: { 'stripe-signature': header }, body: raw.replace('"active"', '"canceled"') });
  assert.equal((await send(handler, tampered)).status, 400);
  assert.equal(db.calls.length, 0);
  assert.equal(stripe.calls.length, 0);
  assert.ok(log.lines.every((l) => /firma rechazada: (missing_header|mismatch|timestamp_out_of_range)/.test(l)));
});

test('GET ?return=success: página de vuelta pública; otros GET: 405', async () => {
  const { handler } = setup();
  const page = await handler(new Request(`${URL_FN}?return=success`));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/plain/);
  assert.match(await page.text(), /Listo, volvé a Venus Launcher/);
  assert.equal((await handler(new Request(URL_FN))).status, 405);
});

test('sin secretos configurados: 500 (Stripe reintenta) y log claro', async () => {
  const { handler, log } = setup({ secrets: [] });
  const { status, body } = await send(handler, await signed(subEvent()));
  assert.equal(status, 500);
  assert.equal(body.error, 'not_configured');
  assert.match(log.lines.join('\n'), /STRIPE_WEBHOOK_SECRET/);
});

test('evento de otro tipo: 200 sin tocar la base', async () => {
  const { handler, db } = setup();
  const { status, body } = await send(handler, await signed(event('customer.created', { id: 'cus_A1' })));
  assert.equal(status, 200);
  assert.equal(body.ignored, 'event_type');
  assert.equal(db.calls.length, 0);
});

test('customer.subscription.updated: lee la suscripción de Stripe y la guarda', async () => {
  const { handler, db, stripe } = setup();
  const { status, body } = await send(handler, await signed(subEvent()));
  assert.equal(status, 200);
  assert.equal(body.outcome, 'applied');
  const get = stripe.callsTo('GET', '/v1/subscriptions/sub_A1');
  assert.equal(get.length, 1);
  assert.equal(get[0].params['expand[0]'], 'latest_invoice');
  const args = db.callsTo('billing_apply_subscription')[0];
  assert.equal(args.p_user, USER);
  assert.equal(args.p_plan, 'pro');
  assert.equal(args.p_status, 'active');
  assert.equal(args.p_subscription, 'sub_A1');
  assert.equal(args.p_synced_at, new Date(NOW).toISOString());
  assert.equal(db.events.get('evt_customersubscriptionupdated_1')?.outcome, 'applied');
  assert.equal(db.subs.get(USER)?.status, 'active');
});

test('idempotencia: el mismo evento dos veces se procesa una sola', async () => {
  const { handler, db, stripe } = setup();
  const ev = subEvent();
  assert.equal((await send(handler, await signed(ev))).body.outcome, 'applied');
  const second = await send(handler, await signed(ev));
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(stripe.callsTo('GET', /^\/v1\/subscriptions\//).length, 1);
  assert.equal(db.callsTo('billing_apply_subscription').length, 1);
});

test('falla temporal de Stripe: 500, el evento queda sin procesar y el reintento lo procesa', async () => {
  const { handler, db, stripe, log } = setup();
  stripe.failures.set('GET /v1/subscriptions/sub_A1', () => new Response(JSON.stringify({ error: { type: 'api_error' } }), { status: 500 }));
  const ev = subEvent();
  const first = await send(handler, await signed(ev));
  assert.equal(first.status, 500);
  assert.equal(db.events.get(ev.id)?.processedAt, null);
  assert.match(log.lines.join('\n'), /se reintentará \(Stripe: status=500/);
  stripe.failures.clear();
  const retry = await send(handler, await signed(ev));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.outcome, 'applied');
  assert.equal(db.events.get(ev.id)?.attempts, 2);
});

test('falla de la base al registrar el evento: 500', async () => {
  const { handler, db } = setup();
  db.failures.set('billing_begin_event', '08006');
  assert.equal((await send(handler, await signed(subEvent()))).status, 500);
});

test('checkout.session.completed: asocia el cliente al usuario (client_reference_id) y activa el plan', async () => {
  const { handler, db, stripe } = setup();
  stripe.subscriptions.set('sub_A1', subscription({ metadata: {} })); // sin metadata: usa el cliente recién asociado
  const ev = event('checkout.session.completed', {
    id: 'cs_test_1',
    object: 'checkout.session',
    mode: 'subscription',
    client_reference_id: USER,
    customer: 'cus_A1',
    subscription: 'sub_A1',
    customer_details: { email: EMAIL, name: 'Jugador Secreto' },
  });
  const { body } = await send(handler, await signed(ev));
  assert.equal(body.outcome, 'applied');
  assert.deepEqual(db.callsTo('billing_link_customer')[0], { p_user: USER, p_customer: 'cus_A1', p_livemode: false, p_replace: false });
  assert.equal(db.subs.get(USER)?.plan_id, 'pro');
});

test('checkout.session.completed de un pago único: se ignora', async () => {
  const { handler, stripe } = setup();
  const ev = event('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'payment', customer: 'cus_A1' });
  assert.equal((await send(handler, await signed(ev))).body.outcome, 'ignored_mode');
  assert.equal(stripe.calls.length, 0);
});

test('invoice.payment_failed (forma 2025-03-31.basil): acceso con gracia de 3 días', async () => {
  const { handler, db, stripe } = setup();
  const failedAt = NOW_SEC - 3600;
  stripe.subscriptions.set('sub_A1', subscription({ status: 'past_due', latest_invoice: { id: 'in_9', object: 'invoice', status_transitions: { finalized_at: failedAt } } }));
  const ev = event('invoice.payment_failed', {
    id: 'in_9',
    object: 'invoice',
    customer: 'cus_A1',
    customer_email: EMAIL,
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_A1' } },
    payment_settings: { card: { last4: CARD } },
  });
  const { body } = await send(handler, await signed(ev));
  assert.equal(body.outcome, 'applied');
  const row = db.subs.get(USER)!;
  assert.equal(row.status, 'active');
  assert.equal(row.stripe_status, 'past_due');
  assert.equal(row.grace_until, new Date((failedAt + 3 * DAY) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  assert.equal(row.current_period_end, row.grace_until);
});

test('invoice.paid (forma vieja) después del pago: vuelve a activo sin gracia', async () => {
  const { handler, db, stripe, tick } = setup();
  stripe.subscriptions.set('sub_A1', subscription({ status: 'past_due', latest_invoice: { id: 'in_9', created: NOW_SEC - 3600 } }));
  await send(handler, await signed(event('invoice.payment_failed', { id: 'in_9', object: 'invoice', subscription: 'sub_A1' })));
  assert.ok(db.subs.get(USER)?.grace_until);
  tick(60000);
  stripe.subscriptions.set('sub_A1', subscription());
  const paid = event('invoice.paid', { id: 'in_9', object: 'invoice', subscription: 'sub_A1' }, { id: 'evt_paid_2' });
  assert.equal((await send(handler, await signed(paid, { t: NOW_SEC + 60 }))).body.outcome, 'applied');
  const row = db.subs.get(USER)!;
  assert.equal(row.grace_until, null);
  assert.equal(row.stripe_status, 'active');
});

test('customer.subscription.deleted: el plan queda cancelado (sin acceso)', async () => {
  const { handler, db, stripe } = setup();
  stripe.subscriptions.set('sub_A1', subscription({ status: 'canceled', ended_at: NOW_SEC - 10 }));
  const { body } = await send(handler, await signed(subEvent('customer.subscription.deleted')));
  assert.equal(body.outcome, 'applied');
  assert.equal(db.subs.get(USER)?.status, 'canceled');
  assert.equal(db.state(USER, null)?.active, false);
});

test('el orden de los eventos no importa: un "created" viejo que llega tarde guarda el estado actual', async () => {
  const { handler, db, stripe, tick } = setup();
  // Estado actual en Stripe: cambió a ultra.
  stripe.subscriptions.set('sub_A1', subscription({}, { price: 'price_ultra1', id: 'si_A1' }));
  await send(handler, await signed(subEvent('customer.subscription.updated')));
  tick(1000);
  // Llega tarde el created (cuando era pro): igual se vuelve a leer Stripe, que dice ultra.
  const late = event('customer.subscription.created', { id: 'sub_A1', object: 'subscription', status: 'incomplete', items: { data: [{ price: { id: 'price_pro1' } }] } });
  await send(handler, await signed(late, { t: NOW_SEC + 1 }));
  assert.equal(db.subs.get(USER)?.plan_id, 'ultra');
  assert.equal(stripe.callsTo('GET', '/v1/subscriptions/sub_A1').length, 2);
});

test('precio desconocido: 200, se registra como unknown_price y no se toca la suscripción', async () => {
  const { handler, db, stripe, log } = setup();
  stripe.subscriptions.set('sub_A1', subscription({}, { price: { id: 'price_de_otro_producto' } }));
  const { status, body } = await send(handler, await signed(subEvent()));
  assert.equal(status, 200);
  assert.equal(body.outcome, 'unknown_price');
  assert.equal(db.subs.size, 0);
  assert.equal(db.events.get('evt_customersubscriptionupdated_1')?.outcome, 'unknown_price');
  assert.match(log.lines.join('\n'), /price_de_otro_producto/);
});

test('suscripción inexistente para esta clave (modo equivocado): 200 subscription_missing', async () => {
  const { handler } = setup();
  const { status, body } = await send(handler, await signed(subEvent('customer.subscription.updated', 'sub_NOEXISTE')));
  assert.equal(status, 200);
  assert.equal(body.outcome, 'subscription_missing');
});

test('evento de producción con una clave de prueba: se ignora', async () => {
  const { handler, db } = setup();
  const { body } = await send(handler, await signed({ ...subEvent(), livemode: true }));
  assert.equal(body.ignored, 'livemode');
  assert.equal(db.calls.length, 0);
});

test('suscripción sin usuario (sin metadata ni cliente guardado): no_user', async () => {
  const { handler, db, stripe } = setup();
  stripe.subscriptions.set('sub_A1', subscription({ metadata: {} }));
  assert.equal((await send(handler, await signed(subEvent()))).body.outcome, 'no_user');
  assert.equal(db.subs.size, 0);
});

test('otra suscripción cancelada no le quita el plan activo al usuario', async () => {
  const { handler, db, stripe } = setup();
  await send(handler, await signed(subEvent()));
  stripe.subscriptions.set('sub_OLD', subscription({ id: 'sub_OLD', status: 'canceled', ended_at: NOW_SEC - 100 }));
  const { body } = await send(handler, await signed(subEvent('customer.subscription.deleted', 'sub_OLD')));
  assert.equal(body.outcome, 'other_active');
  assert.equal(db.subs.get(USER)?.stripe_subscription_id, 'sub_A1');
  assert.equal(db.state(USER, null)?.active, true);
});

test('cuerpo que no es un evento: 400; demasiado grande: 413', async () => {
  const { handler } = setup();
  assert.equal((await send(handler, await signed('{"hola":1}'))).status, 400);
  assert.equal((await send(handler, await signed('no es json'))).status, 400);
  const big = new Request(URL_FN, { method: 'POST', headers: { 'content-length': String(2 * 1024 * 1024), 'stripe-signature': 't=1,v1=00' }, body: 'x' });
  assert.equal((await send(handler, big)).status, 413);
});

test('los logs nunca tienen el cuerpo del evento, emails ni datos de tarjeta', async () => {
  const { handler, stripe, log } = setup();
  stripe.subscriptions.set('sub_A1', subscription({ metadata: { user_id: OTHER_USER } }));
  const ev = event('invoice.payment_failed', {
    id: 'in_1',
    object: 'invoice',
    customer_email: EMAIL,
    customer_name: 'Jugador Secreto',
    subscription: 'sub_A1',
    charge: { payment_method_details: { card: { last4: CARD, exp_month: 12 } } },
  });
  await send(handler, await signed(ev));
  stripe.failures.set('GET /v1/subscriptions/sub_A1', () => new Response('{}', { status: 502 }));
  await send(handler, await signed({ ...ev, id: 'evt_otro_2' }));
  const all = log.lines.join('\n');
  assert.ok(log.lines.length >= 2);
  assert.doesNotMatch(all, new RegExp(EMAIL.replace('.', '\\.')));
  assert.doesNotMatch(all, /Jugador Secreto/);
  assert.doesNotMatch(all, new RegExp(CARD));
  assert.doesNotMatch(all, /payment_method_details|customer_email/);
});
