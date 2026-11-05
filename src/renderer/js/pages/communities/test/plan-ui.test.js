// Tarjeta Plan de una comunidad con datos y una orden de ejemplo: ofertas, dueño y miembro, compra y "no disponible".
import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness } from './ui-harness.js';
import * as planLogic from '../../../features/communities/plan.js';
import { createFakeGroups } from '../../../features/communities/fake.js';

// El modo de ejemplo responde con una pequeña demora (como la red): hay que esperarla.
const settle = () => new Promise((resolve) => setTimeout(resolve, 260));
const base = { signedIn: () => true, userId: () => 'fake-me', onAuth: () => () => {} };
const quote = (total, currency) => ({ currency, total, subtotal: total, net: total, taxes: [] });
const CATALOG = { source: 'backend', providers: { mercado_pago: true, paypal: true }, clans: [
  { id: 'clan_go', tier: 'go', name: 'Clanes Go', priceUsd: 2, periodDays: 30, limits: { media: 50, backdrops: 2, stages: 1, animated: false }, prices: { mercado_pago: quote(3000, 'ARS'), paypal: quote(2, 'USD') } },
  { id: 'clan_pro', tier: 'pro', name: 'Clanes Pro', priceUsd: 4, periodDays: 30, limits: { media: 150, backdrops: 6, stages: 4, animated: true }, prices: { mercado_pago: quote(6000, 'ARS'), paypal: quote(4, 'USD') } },
  { id: 'clan_max', tier: 'max', name: 'Clanes Max', priceUsd: 6, periodDays: 30, limits: { media: 400, backdrops: 15, stages: 10, animated: true }, prices: { mercado_pago: quote(9000, 'ARS'), paypal: quote(6, 'USD') } },
  { id: 'clan_ultra', tier: 'ultra', name: 'Clanes Ultra', priceUsd: 10, periodDays: 30, limits: { media: 1000, backdrops: 40, stages: 25, animated: true, members: 5000, channels: 150, roles: 50, priority: true }, prices: { mercado_pago: quote(15000, 'ARS'), paypal: quote(10, 'USD') } },
] };

function open(scenario = 'demo', communityId = 'm-1', catalog = CATALOG) {
  const ui = uiHarness();
  const opened = [];
  const b = createFakeGroups(scenario, base);
  const { openPlanDialog } = ui.load('plan.js', {
    ...planLogic, ensureCss() {}, api: { on: () => () => {}, invoke: async (channel) => (channel === 'billing:catalog' ? catalog : null) },
    preparePlans: async () => {}, openCheckout: (plan, cat) => opened.push({ plan, cat }), fmtUsd: (v) => `US$ ${v}`, fmtMoney: (v, c) => `${c} ${v}`, notifyLooksChanged() {},
  }, ['openPlanDialog']);
  const community = { id: communityId, name: 'Mina Central' };
  return { ui, opened, b, community, start: (extra = {}) => openPlanDialog(b, community, extra) };
}
const labelled = (ui, text) => ui.nodes.filter((n) => n.tag === 'button' && n.children.includes(text) && n.isConnected);
const has = (ui, text) => ui.nodes.some((n) => n.isConnected && n.children.includes(text));

test('el dueño de una comunidad gratis ve los cuatro planes y compra con el flujo de pago', async () => {
  const t = open();
  await t.start();
  await settle();
  assert.ok(has(t.ui, 'communityplans.statusFree'), 'dice que no tiene plan pago');
  assert.ok(has(t.ui, 'communityplans.freeName'));
  const buy = labelled(t.ui, 'communityplans.cta_buy');
  assert.equal(buy.length, 4, 'Go, Pro, Max y Ultra');
  assert.ok(buy.every((btn) => btn.disabled === false));
  assert.ok(t.ui.nodes.some((n) => n.isConnected && n.hasClass?.('cp-manual')), 'avisa que se renueva a mano');
  assert.ok(has(t.ui, 'communityplans.manualNote') || t.ui.nodes.some((n) => n.isConnected && n.children.includes('communityplans.manualNote')));
  // Elige Pro: el diálogo de pago recibe un plan de clan de esa comunidad.
  await buy[1].fire('click');
  assert.equal(t.opened.length, 1);
  const { plan, cat } = t.opened[0];
  assert.deepEqual([plan.id, plan.clan, plan.communityId, plan.periodDays], ['clan_pro', true, 'm-1', 30]);
  assert.equal(plan.prices.mercado_pago.total, 6000);
  assert.equal(plan.prices.paypal.total, 4);
  assert.equal(cat, CATALOG);
  // El pago se acredita: la tarjeta se recarga y muestra el plan activo y "Renovar".
  t.b.fakeApplyBilling({ kind: 'clan', plan: 'clan_pro', community: 'm-1' });
  await plan.onPaid({ status: 'paid' });
  await settle();
  assert.ok(has(t.ui, 'communityplans.statusActive'));
  assert.equal(labelled(t.ui, 'communityplans.cta_renew').length, 1, 'renovar el que tiene');
  assert.equal(labelled(t.ui, 'communityplans.cta_queue').length, 1, 'uno menor se suma detrás');
  assert.equal(labelled(t.ui, 'communityplans.cta_buy').length, 2, 'y dos mayores');
});

test('un miembro común ve el plan pero no puede comprar ni renovar', async () => {
  const t = open('demo', 'm-2');
  await t.start();
  await settle();
  const buttons = labelled(t.ui, 'communityplans.cta_buy');
  assert.equal(buttons.length, 4);
  assert.ok(buttons.every((btn) => btn.disabled === true), 'todos apagados');
  assert.ok(has(t.ui, 'communityplans.ownerOnly'));
});

test('sin medios de pago activados los botones quedan apagados y se ve el precio de lista', async () => {
  const t = open('demo', 'm-1', { source: 'backend', providers: {}, clans: CATALOG.clans.map((c) => ({ ...c, prices: { mercado_pago: null, paypal: null } })) });
  await t.start();
  await settle();
  const buttons = labelled(t.ui, 'communityplans.cta_buy');
  assert.equal(buttons.length, 4);
  assert.ok(buttons.every((btn) => btn.disabled === true));
  assert.ok(has(t.ui, 'communityplans.listPrice'));
});

test('si el servidor no tiene los planes se ve "no disponible" y nada se rompe', async () => {
  const t = open('unavailable');
  await t.start();
  await settle();
  assert.ok(t.ui.nodes.some((n) => n.tag === 'empty' && n.isConnected && n.children.includes('communityplans.unavailable')));
  assert.equal(labelled(t.ui, 'communityplans.cta_buy').length, 0);
  assert.equal(t.ui.errors.length, 0);
});

test('sin catálogo de pagos igual se ve el plan y no hay ofertas', async () => {
  const t = open('demo', 'm-1', null);
  await t.start();
  await settle();
  assert.ok(has(t.ui, 'communityplans.noOffers'));
  assert.ok(has(t.ui, 'communityplans.statusFree'));
});
