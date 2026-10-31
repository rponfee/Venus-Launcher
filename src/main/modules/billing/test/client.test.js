'use strict';
// Pruebas del cliente de planes (sin Electron): catálogo con precios, pago con link y seguimiento de la orden.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingClient, normalizeCatalog } = require('../client');

const ORDER = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const t = (key) => key;

function setup({ statuses = ['pending', 'paid'], session = 'user-1' } = {}) {
  const calls = [];
  const sent = [];
  const opened = [];
  const timers = [];
  let user = session;
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetch = async (url, init) => {
    const body = init.body && init.body !== '{}' ? JSON.parse(init.body) : null;
    calls.push({ url, body, auth: init.headers.Authorization });
    if (url.endsWith('/rpc/payments_catalog')) {
      return reply(200, { providers: { mercado_pago: { enabled: true }, paypal: { enabled: false } }, arsPerUsd: 1450, plans: [{ id: 'go', name: 'Go', priceUsd: 8, prices: { mercado_pago: { currency: 'ARS', subtotal: 11600, total: 11600, net: 9586.78, taxes: [{ id: 'iva', label: 'IVA', rate: 21, mode: 'included', amount: 2013.22 }] } } }] });
    }
    if (url.endsWith('/functions/v1/payments') && body.action === 'checkout') {
      if (body.payload.provider === 'paypal') return reply(409, { ok: false, error: 'provider_disabled' });
      return reply(200, { ok: true, result: { order: { id: ORDER, plan: 'go', planName: 'Go', provider: 'mercado_pago', currency: 'ARS', amount: 11600, status: 'pending' }, url: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1' } });
    }
    if (url.endsWith('/functions/v1/payments') && body.action === 'status') {
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      return reply(200, { ok: true, result: { order: { id: ORDER, plan: 'go', planName: 'Go', provider: 'mercado_pago', currency: 'ARS', amount: 11600, status } } });
    }
    return reply(404, {});
  };
  const client = createBillingClient({
    fetch,
    cloudConfig: async () => ({ configured: true, url: 'https://x.supabase.co', anonKey: 'anon' }),
    accessToken: async () => 'token',
    sessionUser: async () => user,
    t,
    openExternal: async (url) => opened.push(url),
    send: (channel, payload) => sent.push({ channel, payload }),
    aiStatus: async () => {},
    timers: { setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} },
  });
  const tick = async () => { const fn = timers.shift(); if (fn) await fn(); };
  return { client, calls, sent, opened, tick, setUser: (u) => { user = u; } };
}

test('catálogo: precios por medio de pago y solo los habilitados', async () => {
  const { client, calls } = setup();
  const c = await client.catalog();
  assert.deepEqual(c.providers, { mercado_pago: true, paypal: false });
  const go = c.plans.find((p) => p.id === 'go');
  assert.equal(go.prices.mercado_pago.total, 11600);
  assert.equal(go.prices.mercado_pago.net, 9586.78);
  assert.equal(go.prices.paypal, null);
  assert.equal(calls[0].auth, 'Bearer anon', 'el catálogo es público');
});

test('pago: abre el link, sigue la orden y avisa cuando se acredita', async () => {
  const { client, sent, opened, tick, calls } = setup();
  const res = await client.checkout({ plan: 'go', provider: 'mercado_pago' });
  assert.equal(res.order.status, 'pending');
  assert.deepEqual(opened, ['https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1']);
  assert.equal(client.watching(), ORDER);
  await tick(); // sigue pendiente: no avisa
  assert.equal(sent.filter((s) => s.channel === 'billing:order').length, 0);
  await tick(); // pagada
  assert.ok(sent.some((s) => s.channel === 'billing:order' && s.payload.status === 'paid'));
  assert.ok(sent.some((s) => s.channel === 'billing:changed' && s.payload.plan === 'go'));
  assert.equal(client.watching(), null);
  assert.ok(calls.every((c) => !c.body || !('user' in (c.body.payload || {}))), 'el usuario nunca va en el cuerpo');
});

test('pago: si cambia la cuenta, deja de seguir la orden', async () => {
  const { client, tick, setUser } = setup({ statuses: ['pending'] });
  await client.checkout({ plan: 'go', provider: 'mercado_pago' });
  setUser('otro');
  await tick();
  assert.equal(client.watching(), null);
});

test('errores del servidor y validaciones', async () => {
  const { client } = setup();
  await assert.rejects(client.checkout({ plan: 'go', provider: 'paypal' }), { code: 'providerDisabled' });
  await assert.rejects(client.checkout({ plan: 'ultra', provider: 'mercado_pago' }), { code: 'unknownPlan' });
  await assert.rejects(client.reopen('https://evil.example.com/pay'), { code: 'badRequest' });
  assert.equal(await client.reopen('https://www.sandbox.paypal.com/checkoutnow?token=AB12'), true);
  assert.equal(normalizeCatalog(null).plans.length, 0);
});
