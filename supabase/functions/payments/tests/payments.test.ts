// Pruebas de "payments" (launcher, panel y avisos) contra una base y proveedores falsos (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentsHandler } from '../handler.ts';
import { createWebhookHandler } from '../webhook.ts';
import { mpOutcome, mpVerifySignature, parsePayment } from '../../_shared/pagos/mercadopago.ts';
import { paypalOutcome } from '../../_shared/pagos/paypal.ts';
import { ADMIN, BASE, FakeDb, FakeProviders, NOW, OTHER, USER, recorder } from './fakes.ts';

function setup() {
  const db = new FakeDb();
  const net = new FakeProviders();
  const log = recorder();
  let now = NOW;
  const handler = createPaymentsHandler({
    supabaseReady: true,
    async verifyUser(token) {
      if (token === 'user') return { status: 'ok', userId: USER, email: 'a@b.c' };
      if (token === 'other') return { status: 'ok', userId: OTHER, email: 'o@b.c' };
      if (token === 'admin') return { status: 'ok', userId: ADMIN, email: 'admin@b.c' };
      if (token === 'anon') return { status: 'forbidden' };
      return { status: 'invalid' };
    },
    rpc: db.rpc,
    fetch: net.fetch,
    functionsBase: BASE,
    nowMs: () => now,
    logger: log.logger,
  });
  const hook = createWebhookHandler({ supabaseReady: true, rpc: db.rpc, fetch: net.fetch, nowMs: () => now, logger: log.logger });
  return { db, net, log, handler, hook, tick: (ms: number) => (now += ms), now: () => now };
}

function call(action: string, payload: unknown = {}, token = 'user') {
  return new Request(`${BASE}/payments`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
}

async function body(res: Response) {
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

test('checkout con Mercado Pago: preferencia en pesos con la orden como referencia', async () => {
  const s = setup();
  const { status, data } = await body(await s.handler(call('checkout', { plan: 'go', provider: 'mercado_pago' })));
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.match(data.result.url, /^https:\/\/www\.mercadopago\.com\.ar\//); // init_point también en pruebas
  const pref = s.net.requests.find((r) => r.url.endsWith('/checkout/preferences'))!;
  const order = data.result.order;
  assert.equal(pref.body.external_reference, order.id);
  assert.equal(pref.body.items[0].currency_id, 'ARS');
  assert.equal(pref.body.items[0].unit_price, 11600); // 8 USD x 1450, redondeado a 100
  assert.equal(pref.body.notification_url, `${BASE}/payments?provider=mercado_pago&source_news=webhooks`);
  assert.equal(pref.body.auto_return, 'approved');
  assert.equal(pref.body.statement_descriptor, 'VENUSLAUNCHER'); // 13 caracteres como máximo
  assert.match(pref.body.expiration_date_to, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}-03:00$/);
  assert.match(pref.headers['x-idempotency-key'], /^venus-/);
  assert.equal(pref.headers.authorization, `Bearer ${s.db.secrets.mpAccessToken}`);
  assert.equal(s.db.calls.find((c) => c.name === 'payments_create_order')!.args.p_user, USER);
  // Doble clic: la misma orden, sin otra preferencia.
  s.tick(5000);
  const again = await body(await s.handler(call('checkout', { plan: 'go', provider: 'mercado_pago' })));
  assert.equal(again.data.result.order.id, order.id);
  assert.equal(again.data.result.reused, true);
  assert.equal(s.net.requests.filter((r) => r.url.endsWith('/checkout/preferences')).length, 1);
});

test('checkout: plan, proveedor, sesión y ritmo', async () => {
  const s = setup();
  assert.equal((await body(await s.handler(call('checkout', { plan: 'ultra', provider: 'paypal' })))).data.error, 'unknown_plan');
  assert.equal((await body(await s.handler(call('checkout', { plan: 'go', provider: 'stripe' })))).data.error, 'provider_disabled');
  s.db.enabled.paypal = false;
  s.tick(5000);
  assert.equal((await body(await s.handler(call('checkout', { plan: 'go', provider: 'paypal' })))).data.error, 'provider_disabled');
  assert.equal((await s.handler(call('checkout', { plan: 'go', provider: 'paypal' }, 'bad'))).status, 401);
  assert.equal((await s.handler(call('checkout', { plan: 'go', provider: 'paypal' }, 'anon'))).status, 403);
  s.db.enabled.paypal = true;
  s.tick(5000);
  await s.handler(call('checkout', { plan: 'go', provider: 'mercado_pago' }));
  const busy = await body(await s.handler(call('checkout', { plan: 'pro', provider: 'mercado_pago' })));
  assert.equal(busy.status, 429);
});

test('checkout: si Mercado Pago rechaza las credenciales, la orden queda fallida', async () => {
  const s = setup();
  s.net.mpAuthFails = true;
  const { status, data } = await body(await s.handler(call('checkout', { plan: 'basic', provider: 'mercado_pago' })));
  assert.equal(status, 502);
  assert.equal(data.error, 'provider_auth');
  const order = [...s.db.orders.values()][0];
  assert.equal(order.status, 'failed');
  assert.ok(!s.log.lines.some((l) => l.includes(String(s.db.secrets.mpAccessToken))), 'la clave no va a los logs');
});

test('status: un pago aprobado de Mercado Pago activa el plan; con otro monto, no', async () => {
  const s = setup();
  const { data } = await body(await s.handler(call('checkout', { plan: 'pro', provider: 'mercado_pago' })));
  const id = data.result.order.id;
  s.net.addMpPayment({ id: 9001, status: 'rejected', status_detail: 'cc_rejected_insufficient_amount', external_reference: id, transaction_amount: 21800 });
  let st = await body(await s.handler(call('status', { orderId: id })));
  assert.equal(st.data.result.order.status, 'pending');
  assert.equal(st.data.result.order.providerStatus, 'rejected:cc_rejected_insufficient_amount');
  s.net.addMpPayment({ id: 9002, status: 'approved', external_reference: id, transaction_amount: 100 });
  s.tick(3000);
  st = await body(await s.handler(call('status', { orderId: id })));
  assert.equal(st.data.result.order.status, 'pending');
  assert.equal(st.data.result.order.providerStatus, 'amount_mismatch');
  s.net.mpPayments.shift();
  s.net.addMpPayment({ id: 9003, status: 'approved', external_reference: id, transaction_amount: 21800 });
  s.tick(3000);
  st = await body(await s.handler(call('status', { orderId: id })));
  assert.equal(st.data.result.order.status, 'paid');
  const paid = s.db.calls.filter((c) => c.name === 'payments_mark_paid').at(-1)!.args;
  assert.deepEqual([paid.p_payment_id, paid.p_amount, paid.p_currency, paid.p_live], ['9003', 21800, 'ARS', false]);
  // Otro usuario no ve la orden.
  assert.equal((await s.handler(call('status', { orderId: id }, 'other'))).status, 404);
});

test('PayPal: orden en dólares, captura del lado del servidor y pago pendiente', async () => {
  const s = setup();
  const { data } = await body(await s.handler(call('checkout', { plan: 'max', provider: 'paypal' })));
  assert.match(data.result.url, /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=PPORDER/);
  const create = s.net.requests.find((r) => r.url.endsWith('/v2/checkout/orders'))!;
  assert.deepEqual(create.body.purchase_units[0].amount, { currency_code: 'USD', value: '35.00' });
  assert.equal(create.body.purchase_units[0].custom_id, data.result.order.id);
  assert.equal(create.body.payment_source.paypal.experience_context.return_url, `${BASE}/payments?return=paypal`);
  assert.equal(create.headers['paypal-request-id'], `venus-${data.result.order.id}`);
  const id = data.result.order.id;
  const ppId = data.result.order.providerOrderId;
  // Sin aprobar: sigue pendiente.
  let st = await body(await s.handler(call('status', { orderId: id })));
  assert.equal(st.data.result.order.status, 'pending');
  // Aprobada pero PayPal deja la captura pendiente.
  s.net.approvePaypal(ppId);
  s.net.captureStatus = 'PENDING';
  s.tick(3000);
  st = await body(await s.handler(call('status', { orderId: id })));
  assert.equal(st.data.result.order.status, 'pending');
  assert.match(st.data.result.order.providerStatus, /^capture_PENDING/);
  // Aprobada y capturada.
  const order = s.net.paypalOrders.get(ppId)!;
  order.status = 'APPROVED';
  delete (order.purchase_units as any)[0].payments;
  s.net.captureStatus = 'COMPLETED';
  s.tick(3000);
  st = await body(await s.handler(call('status', { orderId: id })));
  assert.equal(st.data.result.order.status, 'paid');
  const paid = s.db.calls.filter((c) => c.name === 'payments_mark_paid').at(-1)!.args;
  assert.deepEqual([paid.p_amount, paid.p_currency, paid.p_live], [35, 'USD', false]);
});

test('panel: solo admins; guardar rechaza claves con formato inválido', async () => {
  const s = setup();
  assert.equal((await s.handler(call('payments.get', {}, 'user'))).status, 403);
  const got = await body(await s.handler(call('payments.get', {}, 'admin')));
  assert.equal(got.data.result.urls.paypalWebhook, `${BASE}/payments?provider=paypal`);
  const bad = await body(await s.handler(call('payments.save', { secrets: { mpAccessToken: 'sk_live_x' } }, 'admin')));
  assert.equal(bad.status, 400);
  assert.equal(bad.data.field, 'mpAccessToken');
  const okSave = await body(await s.handler(call('payments.save', { settings: { arsPerUsd: 1500 }, secrets: { mpAccessToken: 'APP_USR-123-abc' } }, 'admin')));
  assert.equal(okSave.status, 200);
  assert.equal((s.db.saved[0] as any).p_user, ADMIN);
  const tested = await body(await s.handler(call('payments.test', { provider: 'mercado_pago' }, 'admin')));
  assert.deepEqual([tested.data.result.ok, tested.data.result.nickname, tested.data.result.mode], [true, 'VENUS', 'test']);
  const pp = await body(await s.handler(call('payments.test', { provider: 'paypal' }, 'admin')));
  assert.equal(pp.data.result.ok, true);
});

test('webhook de Mercado Pago: firma, tipo y acreditación', async () => {
  const s = setup();
  const { data } = await body(await s.handler(call('checkout', { plan: 'basic', provider: 'mercado_pago' })));
  const id = data.result.order.id;
  s.net.addMpPayment({ id: 7001, status: 'approved', external_reference: id, transaction_amount: 5800 });
  const ts = String(Math.floor(s.now() / 1000));
  const secret = String(s.db.secrets.mpWebhookSecret);
  const manifest = `id:7001;request-id:req-1;ts:${ts};`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest))), (b) => b.toString(16).padStart(2, '0')).join('');
  const notify = (signature: string) => new Request(`${BASE}/payments?provider=mercado_pago&source_news=webhooks&data.id=7001&type=payment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': signature, 'x-request-id': 'req-1' },
    body: JSON.stringify({ action: 'payment.created', type: 'payment', data: { id: '7001' } }),
  });
  assert.equal((await s.hook(notify(`ts=${ts},v1=${'0'.repeat(64)}`))).status, 401);
  assert.equal([...s.db.orders.values()][0].status, 'pending');
  assert.equal((await s.hook(notify(`ts=${ts},v1=${sig}`))).status, 200);
  assert.equal(s.db.orders.get(id)!.status, 'paid');
  // Otros tipos de aviso se ignoran sin consultar a nadie.
  const before = s.net.requests.length;
  const other = await s.hook(new Request(`${BASE}/payments?provider=mercado_pago&topic=merchant_order&id=5`, { method: 'POST', body: '{}' }));
  assert.equal(other.status, 200);
  assert.equal(s.net.requests.length, before);
});

test('webhook de PayPal: verificación y captura completada', async () => {
  const s = setup();
  s.db.secrets.paypalWebhookId = 'WH8PT597110X687430';
  const { data } = await body(await s.handler(call('checkout', { plan: 'go', provider: 'paypal' })));
  const ppId = data.result.order.providerOrderId;
  s.net.approvePaypal(ppId);
  const event = { id: 'WH-1', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: ppId } };
  const send = () => new Request(`${BASE}/payments?provider=paypal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'paypal-transmission-id': 't1', 'paypal-transmission-sig': 'sig', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-transmission-time': '2026-10-31T15:00:00Z' },
    body: JSON.stringify(event),
  });
  s.net.paypalVerify = 'FAILURE';
  assert.equal((await s.hook(send())).status, 401);
  s.net.paypalVerify = 'SUCCESS';
  assert.equal((await s.hook(send())).status, 200);
  assert.equal(s.db.orders.get(data.result.order.id)!.status, 'paid');
});

test('páginas de vuelta: acreditan el pago y responden texto', async () => {
  const s = setup();
  const { data } = await body(await s.handler(call('checkout', { plan: 'go', provider: 'mercado_pago' })));
  const id = data.result.order.id;
  s.net.addMpPayment({ id: 8001, status: 'approved', external_reference: id, transaction_amount: 11600 });
  const res = await s.hook(new Request(`${BASE}/payments?return=mp&collection_id=8001&status=approved&external_reference=${id}`));
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(await res.text(), /plan Go de Venus IA ya está activo/);
  assert.equal(s.db.orders.get(id)!.status, 'paid');
  assert.match(await (await s.hook(new Request(`${BASE}/payments?return=paypal-cancel&token=ABCDEF`))).text(), /no se cobró nada/);
  assert.match(await (await s.hook(new Request(`${BASE}/payments?return=paypal&token=NOEXISTE1`))).text(), /No encontramos ese pago/);
});

test('reglas de estado de Mercado Pago y PayPal', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000999';
  const p = (status: string, ref = id) => parsePayment({ id: 1, status, external_reference: ref, transaction_amount: 10, currency_id: 'ARS' })!;
  assert.equal(mpOutcome([p('rejected'), p('approved')], id).kind, 'paid');
  assert.equal(mpOutcome([p('approved', 'otra')], id).kind, 'pending');
  assert.equal(mpOutcome([p('refunded')], id).kind, 'refunded');
  assert.equal(paypalOutcome({ status: 'VOIDED', purchase_units: [{}] }).kind, 'cancelled');
  assert.equal(paypalOutcome({ status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'C1', status: 'REFUNDED', amount: { value: '8.00', currency_code: 'USD' } }] } }] }).kind, 'refunded');
  // Firma vieja (más de 10 minutos) o sin datos: inválida.
  assert.equal(await mpVerifySignature('s', 'ts=1,v1=' + 'a'.repeat(64), 'r', '1', Math.floor(NOW / 1000)), false);
  assert.equal(await mpVerifySignature('s', null, 'r', '1', 0), false);
});
