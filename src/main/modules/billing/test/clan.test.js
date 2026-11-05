'use strict';
// Planes de clan en el cliente de pagos: catálogo, compra para una comunidad y fuera el Venus Pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingClient, normalizeCatalog, normalizeOrder } = require('../client');
const { createFakeBilling } = require('../fake');

const ORDER = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const COMMUNITY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const t = (key) => key;
const quote = (total) => ({ currency: 'ARS', subtotal: total, total, net: total, taxes: [] });

function setup({ checkoutError = null, status = 'paid' } = {}) {
  const calls = [];
  const sent = [];
  const timers = [];
  const reply = (code, body) => ({ ok: code < 400, status: code, json: async () => body });
  const fetch = async (url, init) => {
    const body = init.body && init.body !== '{}' ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.endsWith('/rpc/payments_catalog')) {
      return reply(200, {
        providers: { mercado_pago: { enabled: true }, paypal: { enabled: true } }, arsPerUsd: 1500, plans: [],
        pass: { season: { id: 's1' }, tiers: [{ id: 'pass_go' }] },
        clans: [
          { id: 'clan_go', name: 'Clanes Go', priceUsd: 2, periodDays: 30, limits: { media: 50, backdrops: 2, stages: 1, animated: false, members: 500, channels: 50, roles: 15, priority: false }, prices: { mercado_pago: quote(3000), paypal: { currency: 'USD', total: 2, subtotal: 2, net: 2, taxes: [] } } },
          { id: 'clan_ultra', name: 'Clanes Ultra', priceUsd: 10, limits: { media: 1000, priority: true, animated: true }, prices: {} },
          { id: 'pass_go', name: 'No es un plan de clan' },
          { id: 'clan_free', name: 'Tampoco' },
        ],
      });
    }
    if (url.endsWith('/functions/v1/payments') && body.action === 'checkout') {
      if (checkoutError) return reply(checkoutError === 'not_owner' ? 403 : 400, { ok: false, error: checkoutError });
      return reply(200, { ok: true, result: { order: { id: ORDER, plan: body.payload.plan, planName: 'Clanes Go', communityId: body.payload.community, provider: 'paypal', currency: 'USD', amount: 2, status: 'pending' }, url: 'https://www.paypal.com/checkoutnow?token=XYZ' } });
    }
    if (url.endsWith('/functions/v1/payments') && body.action === 'status') {
      return reply(200, { ok: true, result: { order: { id: ORDER, plan: 'clan_go', planName: 'Clanes Go', communityId: COMMUNITY, provider: 'paypal', currency: 'USD', amount: 2, status } } });
    }
    return reply(404, {});
  };
  const client = createBillingClient({
    fetch,
    cloudConfig: async () => ({ configured: true, url: 'https://x.supabase.co', anonKey: 'anon' }),
    accessToken: async () => 'token',
    sessionUser: async () => 'user-1',
    t,
    openExternal: async () => {},
    send: (channel, payload) => sent.push({ channel, payload }),
    aiStatus: async () => { sent.push({ channel: 'ai', payload: null }); },
    timers: { setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} },
  });
  return { client, calls, sent, tick: async () => { const fn = timers.shift(); if (fn) await fn(); } };
}

test('catálogo: los planes de clan con precios y límites, y sin Venus Pass', async () => {
  const { client } = setup();
  const c = await client.catalog();
  assert.equal(c.pass, undefined, 'la clave pass ya no existe');
  assert.deepEqual(c.clans.map((p) => p.id), ['clan_go', 'clan_ultra'], 'solo clan_go|pro|max|ultra');
  assert.equal(c.clans[0].tier, 'go');
  assert.equal(c.clans[0].prices.mercado_pago.total, 3000);
  assert.equal(c.clans[0].prices.paypal.total, 2);
  assert.equal(c.clans[0].limits.media, 50);
  assert.equal(c.clans[1].prices.paypal, null);
  assert.equal(c.clans[1].limits.priority, true);
  assert.equal(c.clans[1].periodDays, 30);
  assert.deepEqual(normalizeCatalog({ pass: { season: { id: 'x' } } }).clans, []);
});

test('compra: manda la comunidad, la orden la conserva y al pagar avisa de la comunidad sin tocar la IA', async () => {
  const { client, calls, sent, tick } = setup();
  const res = await client.checkout({ plan: 'clan_go', provider: 'paypal', community: COMMUNITY });
  assert.equal(res.order.communityId, COMMUNITY);
  const sentBody = calls.find((c) => c.body?.action === 'checkout').body.payload;
  assert.deepEqual(sentBody, { plan: 'clan_go', provider: 'paypal', community: COMMUNITY }, 'el usuario nunca viaja en el cuerpo');
  await tick();
  const changed = sent.find((s) => s.channel === 'billing:changed');
  assert.deepEqual(changed.payload, { reason: 'paid', kind: 'clan', plan: 'clan_go', community: COMMUNITY });
  assert.equal(sent.some((s) => s.channel === 'ai'), false, 'un plan de clan no refresca el saldo de IA');
});

test('compra: validaciones y errores del servidor', async () => {
  const a = setup();
  await assert.rejects(a.client.checkout({ plan: 'clan_go', provider: 'paypal' }), { code: 'unknownCommunity' });
  await assert.rejects(a.client.checkout({ plan: 'clan_go', provider: 'paypal', community: 'no-es-un-id' }), { code: 'unknownCommunity' });
  await assert.rejects(a.client.checkout({ plan: 'clan_free', provider: 'paypal', community: COMMUNITY }), { code: 'unknownPlan' });
  await assert.rejects(a.client.checkout({ plan: 'pass_go', provider: 'paypal', community: COMMUNITY }), { code: 'unknownPlan' }, 'el Pass ya no se compra');
  assert.equal(a.calls.filter((c) => c.body?.action === 'checkout').length, 0, 'ni siquiera se le pregunta al servidor');
  const b = setup({ checkoutError: 'not_owner' });
  await assert.rejects(b.client.checkout({ plan: 'clan_pro', provider: 'paypal', community: COMMUNITY }), { code: 'notOwner' });
  const c = setup({ checkoutError: 'unknown_community' });
  await assert.rejects(c.client.checkout({ plan: 'clan_pro', provider: 'paypal', community: COMMUNITY }), { code: 'unknownCommunity' });
});

test('la orden normalizada solo trae una comunidad con forma de id', () => {
  assert.equal(normalizeOrder({ id: ORDER, communityId: COMMUNITY }).communityId, COMMUNITY);
  assert.equal(normalizeOrder({ id: ORDER, communityId: '<script>' }).communityId, null);
  assert.equal(normalizeOrder({ id: ORDER }).communityId, null);
});

test('modo de ejemplo: catálogo con clanes y orden que se acredita sola', async () => {
  const sent = [];
  const fake = createFakeBilling({ t, send: (channel, payload) => sent.push({ channel, payload }), state: 'none' });
  const c = await fake.catalog();
  assert.deepEqual(c.clans.map((p) => p.id), ['clan_go', 'clan_pro', 'clan_max', 'clan_ultra']);
  assert.equal(c.clans[3].limits.members, 5000);
  await assert.rejects(fake.checkout({ plan: 'clan_go', provider: 'paypal' }), { code: 'unknownCommunity' });
  const res = await fake.checkout({ plan: 'clan_pro', provider: 'mercado_pago', community: COMMUNITY });
  assert.equal(res.order.communityId, COMMUNITY);
  assert.equal(res.order.amount, 5800);
});
