// Planes de clan (0044) en "payments": los paga el dueño de una comunidad, con la misma tubería que los planes de IA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentsHandler } from '../handler.ts';
import { createWebhookHandler } from '../webhook.ts';
import { BASE, COMMUNITY, ELSE_COMMUNITY, FakeDb, FakeProviders, NOW, OTHER, USER, recorder } from './fakes.ts';

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
      return { status: 'invalid' };
    },
    rpc: db.rpc,
    fetch: net.fetch,
    functionsBase: BASE,
    nowMs: () => now,
    logger: log.logger,
  });
  const hook = createWebhookHandler({ supabaseReady: true, rpc: db.rpc, fetch: net.fetch, nowMs: () => now, logger: log.logger });
  return { db, net, handler, hook, tick: (ms: number) => (now += ms) };
}

function call(action: string, payload: unknown = {}, token = 'user') {
  return new Request(`${BASE}/payments`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
}

async function body(res: Response) {
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

test('plan de clan con Mercado Pago: la orden lleva la comunidad y el título dice 30 días', async () => {
  const s = setup();
  const { status, data } = await body(await s.handler(call('checkout', { plan: 'clan_pro', provider: 'mercado_pago', community: COMMUNITY })));
  assert.equal(status, 200);
  const args = s.db.calls.find((c) => c.name === 'payments_create_order')!.args;
  assert.equal(args.p_plan, 'clan_pro');
  assert.equal(args.p_community, COMMUNITY);
  assert.equal(args.p_user, USER, 'el usuario sale del JWT');
  assert.equal(data.result.order.communityId, COMMUNITY);
  assert.equal(data.result.order.product, 'clan_plan');
  const pref = s.net.requests.find((r) => r.url.endsWith('/checkout/preferences'))!;
  assert.equal(pref.body.items[0].unit_price, 5800); // 4 USD x 1450
  assert.match(pref.body.items[0].title, /Clanes Pro.*30 días/);
});

test('plan de clan con PayPal en dólares; un plan de IA no manda comunidad', async () => {
  const s = setup();
  const { data } = await body(await s.handler(call('checkout', { plan: 'clan_ultra', provider: 'paypal', community: COMMUNITY })));
  const create = s.net.requests.find((r) => r.url.endsWith('/v2/checkout/orders'))!;
  assert.equal(create.body.purchase_units[0].amount.value, '10.00');
  assert.match(JSON.stringify(create.body), /Clanes Ultra/);
  assert.equal(data.result.order.currency, 'USD');
  s.tick(5000);
  await s.handler(call('checkout', { plan: 'go', provider: 'paypal', community: COMMUNITY }));
  assert.equal('p_community' in s.db.calls.filter((c) => c.name === 'payments_create_order').at(-1)!.args, false);
});

test('plan de clan: sin comunidad, con algo que no es un id, ajena o inexistente', async () => {
  const s = setup();
  for (const community of [undefined, '', 'no-es-un-id', 42]) {
    const r = await body(await s.handler(call('checkout', { plan: 'clan_go', provider: 'paypal', community })));
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'unknown_community');
    s.tick(5000);
  }
  assert.equal(s.db.calls.filter((c) => c.name === 'payments_create_order').length, 0, 'ni siquiera llega a la base');
  const foreign = await body(await s.handler(call('checkout', { plan: 'clan_go', provider: 'paypal', community: ELSE_COMMUNITY })));
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.error, 'not_owner');
  s.tick(5000);
  const missing = await body(await s.handler(call('checkout', { plan: 'clan_go', provider: 'paypal', community: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })));
  assert.equal(missing.data.error, 'unknown_community');
  assert.equal(s.net.requests.length, 0, 'sin orden no se habla con el proveedor');
});

test('plan de clan: la orden de una comunidad no se reusa para otra, y el Pass ya no se vende', async () => {
  const s = setup();
  s.db.communityOwners.set(ELSE_COMMUNITY, USER);
  const a = await body(await s.handler(call('checkout', { plan: 'clan_go', provider: 'paypal', community: COMMUNITY })));
  s.tick(5000);
  const b = await body(await s.handler(call('checkout', { plan: 'clan_go', provider: 'paypal', community: ELSE_COMMUNITY })));
  assert.notEqual(a.data.result.order.id, b.data.result.order.id);
  assert.equal(b.data.result.order.communityId, ELSE_COMMUNITY);
  s.tick(5000);
  const pass = await body(await s.handler(call('checkout', { plan: 'pass_go', provider: 'paypal', community: COMMUNITY })));
  assert.equal(pass.data.error, 'unknown_plan');
});

test('plan de clan: el pago aprobado acredita la orden y la página de vuelta aclara que se renueva a mano', async () => {
  const s = setup();
  const { data } = await body(await s.handler(call('checkout', { plan: 'clan_go', provider: 'mercado_pago', community: COMMUNITY })));
  const id = data.result.order.id;
  s.net.addMpPayment({ id: 9001, status: 'approved', external_reference: id, transaction_amount: 2900 });
  const res = await s.hook(new Request(`${BASE}/payments?return=mp&collection_id=9001&status=approved&external_reference=${id}`));
  const text = await res.text();
  assert.match(text, /Clanes Go ya está activo en tu comunidad por 30 días/);
  assert.match(text, /no hay débito automático/);
  assert.match(text, /renews manually/);
  assert.equal(s.db.orders.get(id)!.status, 'paid');
  assert.equal((s.db.orders.get(id) as unknown as Record<string, unknown>).communityId, COMMUNITY);
});

test('plan de clan: con otro monto no se acredita', async () => {
  const s = setup();
  const { data } = await body(await s.handler(call('checkout', { plan: 'clan_max', provider: 'mercado_pago', community: COMMUNITY })));
  const id = data.result.order.id;
  s.net.addMpPayment({ id: 9002, status: 'approved', external_reference: id, transaction_amount: 100 });
  const { data: status } = await body(await s.handler(call('status', { orderId: id })));
  assert.notEqual(status.result.order.status, 'paid');
  assert.equal(s.db.orders.get(id)!.providerStatus, 'amount_mismatch');
});
