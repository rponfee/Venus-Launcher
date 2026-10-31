// Pruebas del tope del presupuesto al subir de plan (billing_apply_subscription de 0013, en la réplica de
// tests/fakes.ts) a través de applySubscription, como lo usan el webhook y la sincronización (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySubscription } from '../sync.ts';
import { DAY, FakeDb, NOW, NOW_SEC, USER, recorder, subscription } from './fakes.ts';

const HOUR = 3600;
const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Guarda la foto de una suscripción con un precio y un fin de período (como un evento del webhook). */
async function apply(db: FakeDb, price: string, periodEnd: number, overrides: Record<string, unknown> = {}): Promise<string> {
  return applySubscription(subscription(overrides, { price, current_period_end: periodEnd }), {
    rpc: db.rpc,
    priceMap: async () => Object.fromEntries(db.prices.map((p) => [p.priceId, p.plan])),
    graceDays: 3,
    nowMs: db.nowMs(),
    syncedAt: new Date(db.nowMs()),
    logger: recorder().logger,
    tag: 'test',
  });
}

test('subir de plan a una hora de la renovación: el presupuesto nuevo se prorratea hasta el fin del período', async () => {
  const db = new FakeDb();
  const end = NOW_SEC + HOUR;
  assert.equal(await apply(db, 'price_go1', end), 'applied');
  assert.equal(db.subs.get(USER)?.budget_cap_usd, null, 'el plan pagado entero no tiene tope');
  assert.equal(await apply(db, 'price_supreme1', end), 'applied');
  const row = db.subs.get(USER)!;
  assert.equal(row.plan_id, 'supreme');
  // Período de un mes (31 días hasta el 1/11 13:00): 1,50 + (23 - 1,50) x 1 h / 744 h = 1,5289.
  assert.equal(row.budget_cap_usd, 1.5289);
  assert.equal(row.budget_cap_until, iso(end));
  // El mismo evento otra vez (o la sincronización): no cambia nada.
  assert.equal(await apply(db, 'price_supreme1', end), 'applied');
  assert.equal(db.subs.get(USER)?.budget_cap_usd, 1.5289);
});

test('subir a mitad del período da la mitad de la diferencia; dos subidas seguidas suman lo mismo que una', async () => {
  const half = new FakeDb();
  const end = NOW_SEC + 15 * DAY; // del 16/10 al 16/11: quedan 15 de 31 días
  await apply(half, 'price_go1', end);
  await apply(half, 'price_supreme1', end);
  assert.equal(half.subs.get(USER)?.budget_cap_usd, 11.9032);

  const chained = new FakeDb();
  await apply(chained, 'price_go1', NOW_SEC + HOUR);
  await apply(chained, 'price_pro1', NOW_SEC + HOUR);
  assert.equal(chained.subs.get(USER)?.budget_cap_usd, 1.5047);
  await apply(chained, 'price_supreme1', NOW_SEC + HOUR);
  assert.equal(chained.subs.get(USER)?.budget_cap_usd, 1.5289, 'de Go a Pro y a Supreme, igual que de Go a Supreme');
});

test('bajar de plan resta la diferencia (como el crédito de Stripe); una suscripción nueva y la renovación quitan el tope', async () => {
  const db = new FakeDb();
  const end = NOW_SEC + HOUR;
  await apply(db, 'price_go1', end);
  await apply(db, 'price_max1', end);
  assert.equal(db.subs.get(USER)?.budget_cap_usd, 1.5235);
  // De Max a Pro en la misma hora: queda lo mismo que si hubiera subido de Go a Pro.
  await apply(db, 'price_pro1', end);
  assert.equal(db.subs.get(USER)?.budget_cap_usd, 1.5047);
  // Renovación: un período nuevo pagado entero; el tope del período anterior venció.
  db.nowMs = () => NOW + 2 * HOUR * 1000;
  await apply(db, 'price_pro1', NOW_SEC + 31 * DAY);
  assert.equal(db.subs.get(USER)?.budget_cap_usd, null);
  assert.equal(db.subs.get(USER)?.budget_cap_until, null);
  // Otra suscripción (checkout nuevo): sin tope aunque el plan sea más caro.
  const fresh = new FakeDb();
  await apply(fresh, 'price_go1', end);
  await apply(fresh, 'price_supreme1', NOW_SEC + 30 * DAY, { id: 'sub_B2', created: NOW_SEC });
  assert.equal(fresh.subs.get(USER)?.stripe_subscription_id, 'sub_B2');
  assert.equal(fresh.subs.get(USER)?.budget_cap_usd, null);
});
