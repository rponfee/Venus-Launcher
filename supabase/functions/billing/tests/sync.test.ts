// Pruebas de la traducción suscripción de Stripe -> ai_subscriptions (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyArgs,
  applySubscription,
  chooseSubscription,
  computeAccess,
  createPriceMapLoader,
  failureTime,
  pickPlanItem,
  snapshotFromSubscription,
  subscriptionIdFromEvent,
  userIdFromMetadata,
} from '../sync.ts';
import type { PriceMap } from '../sync.ts';
import { DAY, FakeDb, NOW, NOW_SEC, OTHER_USER, PRICES, USER, recorder, subscription } from './fakes.ts';

const MAP: PriceMap = Object.fromEntries(Object.entries(PRICES).map(([price, p]) => [price, p.plan]));
const OPTS = { graceDays: 3, nowSec: NOW_SEC };
const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const PERIOD_END = NOW_SEC + 28 * DAY;

function snap(sub: Record<string, unknown>, opts = OPTS) {
  const r = snapshotFromSubscription(sub, MAP, opts);
  assert.equal(r.ok, true, `se esperaba una foto válida: ${JSON.stringify(r)}`);
  return (r as unknown as { snapshot: Record<string, unknown> }).snapshot;
}

// ---------- Eventos -> suscripción ----------

test('subscriptionIdFromEvent: checkout, customer.subscription.* y facturas con la forma vieja y la nueva', () => {
  const ev = (type: string, object: Record<string, unknown>) => ({ id: 'evt_1', type, data: { object } });
  assert.equal(subscriptionIdFromEvent(ev('checkout.session.completed', { mode: 'subscription', subscription: 'sub_1' })), 'sub_1');
  assert.equal(subscriptionIdFromEvent(ev('checkout.session.completed', { mode: 'subscription', subscription: { id: 'sub_2' } })), 'sub_2');
  assert.equal(subscriptionIdFromEvent(ev('checkout.session.completed', { mode: 'payment', subscription: null })), null);
  for (const t of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']) {
    assert.equal(subscriptionIdFromEvent(ev(t, { id: 'sub_3', object: 'subscription' })), 'sub_3');
  }
  assert.equal(subscriptionIdFromEvent(ev('invoice.paid', { id: 'in_1', subscription: 'sub_old' })), 'sub_old');
  assert.equal(
    subscriptionIdFromEvent(ev('invoice.payment_failed', { id: 'in_2', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_new' } } })),
    'sub_new',
  );
  assert.equal(
    subscriptionIdFromEvent(ev('invoice.paid', { id: 'in_3', lines: { data: [{ parent: { subscription_item_details: { subscription: 'sub_line' } } }] } })),
    'sub_line',
  );
  assert.equal(subscriptionIdFromEvent(ev('invoice.paid', { id: 'in_4', subscription: null, parent: null })), null);
  assert.equal(subscriptionIdFromEvent(ev('invoice.paid', { id: 'in_5', subscription: 'no-es-un-id' })), null);
  assert.equal(subscriptionIdFromEvent({ type: 'invoice.paid' }), null);
});

// ---------- Precio -> plan ----------

test('pickPlanItem: el ítem con un precio conocido; desconocido = null; acepta item.plan (API vieja)', () => {
  assert.equal(pickPlanItem(subscription(), MAP)?.planId, 'pro');
  assert.equal(pickPlanItem(subscription({}, { price: 'price_supreme1' }), MAP)?.planId, 'supreme');
  assert.equal(pickPlanItem(subscription({}, { price: { id: 'price_desconocido' } }), MAP), null);
  const twoItems = subscription();
  (twoItems.items as { data: unknown[] }).data.unshift({ id: 'si_x', price: { id: 'price_otro_producto' } });
  assert.deepEqual(
    { price: pickPlanItem(twoItems, MAP)?.priceId, plan: pickPlanItem(twoItems, MAP)?.planId },
    { price: 'price_pro1', plan: 'pro' },
  );
  const legacy = { object: 'subscription', items: { data: [{ id: 'si_l', plan: { id: 'price_ultra1' } }] } };
  assert.equal(pickPlanItem(legacy, MAP)?.planId, 'ultra');
});

test('snapshot: precio desconocido -> unknown_price (con los precios para el log)', () => {
  const r = snapshotFromSubscription(subscription({}, { price: { id: 'price_zzz' } }), MAP, OPTS);
  assert.deepEqual(r, { ok: false, reason: 'unknown_price', subscriptionId: 'sub_A1', priceIds: ['price_zzz'] });
  assert.equal(snapshotFromSubscription({ id: 'x' }, MAP, OPTS).ok, false);
  assert.equal(snapshotFromSubscription(null, MAP, OPTS).ok, false);
});

// ---------- Estados ----------

test('active: acceso hasta el fin del período (de los ítems, API 2025-03-31.basil)', () => {
  const s = snap(subscription());
  assert.equal(s.status, 'active');
  assert.equal(s.stripeStatus, 'active');
  assert.equal(s.currentPeriodEnd, iso(PERIOD_END));
  assert.equal(s.graceUntil, null);
  assert.equal(s.cancelAtPeriodEnd, false);
  assert.equal(s.planId, 'pro');
  assert.equal(s.userId, USER);
});

test('API vieja: current_period_end en la suscripción', () => {
  const legacy = subscription({ current_period_end: NOW_SEC + 5 * DAY }, { current_period_end: undefined, current_period_start: undefined });
  assert.equal(snap(legacy).currentPeriodEnd, iso(NOW_SEC + 5 * DAY));
});

test('cancel_at_period_end: sigue activa hasta el fin del período', () => {
  const s = snap(subscription({ cancel_at_period_end: true }));
  assert.equal(s.status, 'active');
  assert.equal(s.cancelAtPeriodEnd, true);
  assert.equal(s.currentPeriodEnd, iso(PERIOD_END));
});

test('cancel_at antes del fin del período: el acceso termina en cancel_at', () => {
  const s = snap(subscription({ cancel_at: NOW_SEC + 3 * DAY }));
  assert.equal(s.status, 'active');
  assert.equal(s.cancelAtPeriodEnd, true);
  assert.equal(s.currentPeriodEnd, iso(NOW_SEC + 3 * DAY));
});

test('trialing: acceso de prueba hasta el fin del período', () => {
  const s = snap(subscription({ status: 'trialing', trial_end: PERIOD_END }));
  assert.equal(s.status, 'trialing');
  assert.equal(s.currentPeriodEnd, iso(PERIOD_END));
});

test('past_due: activo con gracia = falla (factura finalizada) + BILLING_GRACE_DAYS, sin pasar el fin del período', () => {
  const failedAt = NOW_SEC - DAY;
  const sub = subscription({ status: 'past_due', latest_invoice: { id: 'in_1', created: failedAt - 3600, status_transitions: { finalized_at: failedAt } } });
  const s = snap(sub);
  assert.equal(s.status, 'active');
  assert.equal(s.stripeStatus, 'past_due');
  assert.equal(s.graceUntil, iso(failedAt + 3 * DAY));
  assert.equal(s.currentPeriodEnd, iso(failedAt + 3 * DAY));
  assert.equal(s.periodEnd, iso(PERIOD_END));

  // Días de gracia configurables (y 0 = sin gracia).
  assert.equal(snap(sub, { graceDays: 7, nowSec: NOW_SEC }).currentPeriodEnd, iso(failedAt + 7 * DAY));
  assert.equal(snap(sub, { graceDays: 0, nowSec: NOW_SEC }).currentPeriodEnd, iso(failedAt));

  // Si el período termina antes que la gracia, manda el período: least(fin del período, falla + gracia).
  const shortPeriod = subscription(
    { status: 'past_due', latest_invoice: { id: 'in_1', status_transitions: { finalized_at: failedAt } } },
    { current_period_end: NOW_SEC + DAY },
  );
  assert.equal(snap(shortPeriod).currentPeriodEnd, iso(NOW_SEC + DAY));
  assert.equal(snap(shortPeriod).graceUntil, iso(failedAt + 3 * DAY));
});

test('past_due: los reintentos fallidos de Stripe no estiran la gracia', () => {
  const failedAt = NOW_SEC - DAY;
  const sub = subscription({ status: 'past_due', latest_invoice: { id: 'in_1', status_transitions: { finalized_at: failedAt } } });
  const first = snap(sub, { graceDays: 3, nowSec: NOW_SEC });
  const later = snap(sub, { graceDays: 3, nowSec: NOW_SEC + 2 * DAY });
  const afterGrace = snap(sub, { graceDays: 3, nowSec: NOW_SEC + 5 * DAY });
  assert.equal(later.graceUntil, first.graceUntil);
  assert.equal(afterGrace.currentPeriodEnd, first.currentPeriodEnd);
  // Sin la factura expandida, el ancla es el inicio del período (la renovación), no "ahora".
  const noInvoice = subscription({ status: 'past_due', latest_invoice: 'in_1' });
  const periodStart = NOW_SEC - 2 * DAY;
  assert.equal(failureTime(noInvoice, NOW_SEC + 4 * DAY, null), periodStart);
  assert.equal(snap(noInvoice, { graceDays: 3, nowSec: NOW_SEC + 4 * DAY }).graceUntil, iso(periodStart + 3 * DAY));
});

test('unpaid, canceled, incomplete, incomplete_expired, paused y estados desconocidos -> canceled', () => {
  for (const status of ['unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused', 'estado_nuevo']) {
    const s = snap(subscription({ status, ended_at: status === 'canceled' ? NOW_SEC - 60 : null }));
    assert.equal(s.status, 'canceled', status);
    assert.equal(s.stripeStatus, status);
    assert.equal(s.graceUntil, null);
  }
  assert.equal(snap(subscription({ status: 'canceled', ended_at: NOW_SEC - 60 })).currentPeriodEnd, iso(NOW_SEC - 60));
});

test('sin fin de período en una suscripción con acceso: no se guarda (null sería "sin vencimiento")', () => {
  const sub = subscription({}, { current_period_end: undefined });
  const r = snapshotFromSubscription(sub, MAP, OPTS);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'no_period_end');
  // Cancelada sin fecha: se guarda igual (no da acceso).
  assert.equal(snapshotFromSubscription({ ...sub, status: 'canceled' }, MAP, OPTS).ok, true);
});

test('computeAccess directo: past_due sin período usa solo la gracia', () => {
  const access = computeAccess({ status: 'past_due', latest_invoice: { created: NOW_SEC } }, { graceDays: 3, nowSec: NOW_SEC });
  assert.deepEqual(access, { status: 'active', periodEnd: null, currentPeriodEnd: NOW_SEC + 3 * DAY, graceUntil: NOW_SEC + 3 * DAY, cancelAtPeriodEnd: false });
});

// ---------- Usuario y argumentos ----------

test('userIdFromMetadata: solo uuid válidos (en minúsculas)', () => {
  assert.equal(userIdFromMetadata({ metadata: { user_id: USER.toUpperCase() } }), USER);
  assert.equal(userIdFromMetadata({ metadata: { user_id: 'admin' } }), null);
  assert.equal(userIdFromMetadata({ metadata: null }), null);
  assert.equal(userIdFromMetadata(null), null);
});

test('applyArgs: los parámetros exactos de billing_apply_subscription', () => {
  const s = snapshotFromSubscription(subscription({ livemode: true }), MAP, OPTS);
  assert.ok(s.ok);
  const args = applyArgs((s as { snapshot: Parameters<typeof applyArgs>[0] }).snapshot, USER, new Date(NOW));
  assert.deepEqual(args, {
    p_user: USER,
    p_plan: 'pro',
    p_status: 'active',
    p_current_period_end: iso(PERIOD_END),
    p_grace_until: null,
    p_cancel_at_period_end: false,
    p_customer: 'cus_A1',
    p_subscription: 'sub_A1',
    p_price: 'price_pro1',
    p_stripe_status: 'active',
    p_synced_at: new Date(NOW).toISOString(),
    p_livemode: true,
  });
});

test('chooseSubscription: primero las vivas, después la más nueva; ignora precios desconocidos', () => {
  const canceledNew = subscription({ id: 'sub_c', status: 'canceled', created: NOW_SEC });
  const active = subscription({ id: 'sub_a', status: 'active', created: NOW_SEC - 30 * DAY });
  const foreign = subscription({ id: 'sub_f', status: 'active', created: NOW_SEC }, { price: { id: 'price_ajeno' } });
  assert.equal(chooseSubscription([canceledNew, foreign, active], MAP)?.id, 'sub_a');
  assert.equal(chooseSubscription([canceledNew], MAP)?.id, 'sub_c');
  assert.equal(chooseSubscription([foreign], MAP), null);
});

// ---------- applySubscription con la base falsa ----------

function ctx(db: FakeDb, extra: Record<string, unknown> = {}) {
  const log = recorder();
  return {
    log,
    ctx: {
      rpc: db.rpc,
      priceMap: createPriceMapLoader(db.rpc, 60000, () => NOW),
      graceDays: 3,
      nowMs: NOW,
      syncedAt: new Date(NOW),
      logger: log.logger,
      tag: 'test',
      ...extra,
    },
  };
}

test('applySubscription: usa metadata.user_id y guarda la fila', async () => {
  const db = new FakeDb();
  const { ctx: c } = ctx(db);
  assert.equal(await applySubscription(subscription(), c), 'applied');
  const row = db.subs.get(USER)!;
  assert.equal(row.plan_id, 'pro');
  assert.equal(row.status, 'active');
  assert.equal(row.source, 'stripe');
  assert.equal(row.stripe_subscription_id, 'sub_A1');
  assert.equal(db.customers.get(USER)?.customerId, 'cus_A1');
  assert.equal(db.callsTo('billing_user_for_customer').length, 0);
});

test('applySubscription: sin metadata usa stripe_customers; después el usuario de respaldo; si no, no_user', async () => {
  const db = new FakeDb();
  db.customers.set(OTHER_USER, { customerId: 'cus_A1', livemode: false });
  const noMeta = subscription({ metadata: {} });
  assert.equal(await applySubscription(noMeta, ctx(db).ctx), 'applied');
  assert.equal(db.subs.get(OTHER_USER)?.plan_id, 'pro');

  const db2 = new FakeDb();
  assert.equal(await applySubscription(noMeta, ctx(db2, { fallbackUserId: USER }).ctx), 'applied');
  assert.equal(db2.subs.get(USER)?.plan_id, 'pro');

  const db3 = new FakeDb();
  const { ctx: c3, log } = ctx(db3);
  assert.equal(await applySubscription(noMeta, c3), 'no_user');
  assert.equal(db3.subs.size, 0);
  assert.match(log.lines.join('\n'), /sin usuario/);
});

test('applySubscription: precio desconocido -> vuelve a leer el mapa una vez y lo ignora', async () => {
  const db = new FakeDb();
  const { ctx: c, log } = ctx(db);
  assert.equal(await applySubscription(subscription({}, { price: { id: 'price_nuevo' } }), c), 'unknown_price');
  assert.equal(db.callsTo('billing_price_map').length, 2);
  assert.equal(db.subs.size, 0);
  assert.match(log.lines.join('\n'), /price_nuevo/);
  // Si el precio aparece al releer (recién cargado), se aplica.
  db.prices.push({ priceId: 'price_nuevo', plan: 'max', amount: 3650, livemode: false, active: true });
  assert.equal(await applySubscription(subscription({}, { price: { id: 'price_nuevo' } }), c), 'applied');
  assert.equal(db.subs.get(USER)?.plan_id, 'max');
});

test('applySubscription: sincronización de un usuario no toca suscripciones de otro', async () => {
  const db = new FakeDb();
  assert.equal(await applySubscription(subscription(), ctx(db, { expectUserId: OTHER_USER }).ctx), 'other_user');
  assert.equal(db.subs.size, 0);
});

test('createPriceMapLoader: caché corta y recarga forzada', async () => {
  const db = new FakeDb();
  let t = NOW;
  const load = createPriceMapLoader(db.rpc, 60000, () => t);
  assert.equal((await load()).price_go1, 'go');
  await load();
  assert.equal(db.callsTo('billing_price_map').length, 1);
  await load(true);
  assert.equal(db.callsTo('billing_price_map').length, 2);
  t += 61000;
  await load();
  assert.equal(db.callsTo('billing_price_map').length, 3);
});
