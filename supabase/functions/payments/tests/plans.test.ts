// Planes de Venus IA de la 6.1 (0056) en "payments": cinco de ChatGPT y cinco de Claude. Los planes de clan se
// retiraron con las Comunidades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentsHandler } from '../handler.ts';
import { createWebhookHandler } from '../webhook.ts';
import { planLabel } from '../../_shared/pagos/sync.ts';
import { BASE, FakeDb, FakeProviders, NOW, USER, recorder } from './fakes.ts';

function setup() {
  const db = new FakeDb();
  const net = new FakeProviders();
  const log = recorder();
  let now = NOW;
  const handler = createPaymentsHandler({
    supabaseReady: true,
    async verifyUser(token) {
      return token === 'user' ? { status: 'ok', userId: USER, email: 'a@b.c' } : { status: 'invalid' };
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

function call(action: string, payload: unknown = {}) {
  return new Request(`${BASE}/payments`, { method: 'POST', headers: { Authorization: 'Bearer user', 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
}

async function body(res: Response) {
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

const PLANS = ['basic', 'go', 'pro', 'max', 'ultra', 'claude_basic', 'claude_go', 'claude_pro', 'claude_max', 'claude_ultra'];

test('checkout acepta los diez planes de la 6.1 y manda el id a la base', async () => {
  const s = setup();
  for (const plan of PLANS) {
    const r = await body(await s.handler(call('checkout', { plan, provider: 'paypal' })));
    assert.equal(r.status, 200, `${plan}: ${JSON.stringify(r.data)}`);
    const args = s.db.calls.filter((c) => c.name === 'payments_create_order').at(-1)!.args;
    assert.deepEqual(Object.keys(args).sort(), ['p_live', 'p_plan', 'p_provider', 'p_user'], 'sin comunidad');
    assert.equal(args.p_plan, plan);
    s.tick(5000);
  }
});

test('los planes de clan, el Venus Pass y los planes viejos ya no se venden (ni llegan a la base)', async () => {
  const s = setup();
  for (const plan of ['clan_go', 'clan_pro', 'clan_max', 'clan_ultra', 'pass_go', 'super', 'supreme', 'claude_super', 'Claude_pro', '']) {
    const r = await body(await s.handler(call('checkout', { plan, provider: 'paypal', community: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })));
    assert.equal(r.status, 400, plan);
    assert.equal(r.data.error, 'unknown_plan', plan);
    s.tick(5000);
  }
  assert.equal(s.db.calls.filter((c) => c.name === 'payments_create_order').length, 0);
});

test('el título del pago y la página de vuelta nombran la familia del plan', async () => {
  const s = setup();
  const { data } = await body(await s.handler(call('checkout', { plan: 'claude_pro', provider: 'mercado_pago' })));
  const pref = s.net.requests.find((r) => r.url.endsWith('/checkout/preferences'))!;
  assert.equal(pref.body.items[0].title, 'Venus IA · Plan Claude Pro');
  assert.equal(pref.body.items[0].id, 'claude_pro');
  assert.equal(pref.body.items[0].unit_price, 26100); // 18 USD x 1450
  const id = data.result.order.id;
  s.net.addMpPayment({ id: 9101, status: 'approved', external_reference: id, transaction_amount: 26100 });
  const text = await (await s.hook(new Request(`${BASE}/payments?return=mp&collection_id=9101&status=approved&external_reference=${id}`))).text();
  assert.match(text, /Tu plan Claude Pro de Venus IA ya está activo/);
  assert.match(text, /Your Venus AI Claude Pro plan is active/);

  s.tick(5000);
  await s.handler(call('checkout', { plan: 'ultra', provider: 'paypal' }));
  const create = s.net.requests.find((r) => r.url.endsWith('/v2/checkout/orders'))!;
  assert.match(JSON.stringify(create.body), /Venus IA · Plan ChatGPT Ultra/);
  assert.equal(create.body.purchase_units[0].amount.value, '40.00');
});

test('planLabel: la familia sale del nombre si ya la trae, si no del id del plan', () => {
  assert.equal(planLabel({ plan: 'claude_max', planName: 'Claude Max' }), 'Claude Max');
  assert.equal(planLabel({ plan: 'claude_max', planName: 'Max' }), 'Claude Max');
  assert.equal(planLabel({ plan: 'pro', planName: 'ChatGPT Pro' }), 'ChatGPT Pro');
  assert.equal(planLabel({ plan: 'pro', planName: 'Pro' }), 'ChatGPT Pro');
  assert.equal(planLabel({ plan: 'basic', planName: '' }), 'ChatGPT basic');
  assert.equal(planLabel({ plan: 'otro', planName: 'Otro' }), 'Otro');
});
