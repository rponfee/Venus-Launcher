'use strict';
// Datos en memoria para capturas de desarrollo (VENUS_DEVSHOT + VENUS_BILLING_FAKE=1). Sin red ni cobros: el
// "pago" se aprueba solo a los pocos segundos. VENUS_BILLING_FAKE_STATE: basic, go, pro, max, none o signedOut.
const { normalizeState, normalizeCatalog, normalizeOrder, coded } = require('./client');
const PLANS = require('../assistant/plans.json').plans;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ARS_PER_USD = 1450;

function quote(plan, provider) {
  if (provider === 'mercado_pago') {
    const total = Math.ceil((plan.priceUsd * ARS_PER_USD) / 100) * 100;
    const iva = Math.round((total - total / 1.21) * 100) / 100;
    return { currency: 'ARS', subtotal: total, net: Math.round((total - iva) * 100) / 100, total, taxes: [{ id: 'iva', label: 'IVA', rate: 21, mode: 'included', amount: iva }], arsPerUsd: ARS_PER_USD };
  }
  const extra = Math.round(plan.priceUsd * 30) / 100;
  return { currency: 'USD', subtotal: plan.priceUsd, net: plan.priceUsd, total: plan.priceUsd, estimatedTotal: plan.priceUsd + extra, taxes: [{ id: 'percepcion', label: 'Percepción RG 5617', rate: 30, mode: 'estimate', amount: extra }] };
}

function createFakeBilling({ t, send = () => {}, state: initial = process.env.VENUS_BILLING_FAKE_STATE } = {}) {
  const name = String(initial || 'none');
  const signedOut = name === 'signedOut';
  let plan = name === 'none' || signedOut ? null : PLANS.find((p) => p.id === name) || null;
  const orders = [];
  const session = () => { if (signedOut) throw coded('noSession', t('billing.errSignIn')); };
  const raw = () => ({ plan: plan?.id || null, planName: plan?.name || null, status: plan ? 'active' : 'none', active: Boolean(plan), source: plan ? 'support' : null });
  return {
    async state() { await wait(200); session(); return normalizeState(raw()); },
    async catalog() {
      await wait(200);
      return normalizeCatalog({
        providers: { mercado_pago: { enabled: true }, paypal: { enabled: true } },
        arsPerUsd: ARS_PER_USD,
        plans: PLANS.map((p) => ({ id: p.id, name: p.name, priceUsd: p.priceUsd, budgetUsd: p.budgetUsd, maxTokensPerRequest: p.maxTokensPerRequest, models: p.models, prices: { mercado_pago: quote(p, 'mercado_pago'), paypal: quote(p, 'paypal') } })),
      });
    },
    async checkout({ plan: id, provider } = {}) {
      await wait(400);
      session();
      const p = PLANS.find((x) => x.id === id);
      if (!p) throw coded('unknownPlan', t('billing.errUnknownPlan'));
      const q = quote(p, provider);
      const order = normalizeOrder({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(orders.length + 1).padStart(12, '0')}`, plan: p.id, planName: p.name, provider, currency: q.currency, amount: q.total, status: 'pending', createdAt: new Date().toISOString() });
      orders.unshift(order);
      setTimeout(() => {
        order.status = 'paid';
        order.paidAt = new Date().toISOString();
        plan = p;
        send('billing:order', { ...order });
        send('billing:changed', { reason: 'paid', kind: 'order', plan: p.id });
      }, 4000);
      return { order: { ...order }, url: provider === 'paypal' ? 'https://www.sandbox.paypal.com/checkoutnow?token=FAKE' : 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=fake' };
    },
    async order(id) { await wait(150); const o = orders.find((x) => x.id === id); if (!o) throw coded('notFound', t('billing.errOrderNotFound')); return { ...o }; },
    async orders() { await wait(150); session(); return orders.map((o) => ({ ...o })); },
    async reopen() { return true; },
    async portal() { throw coded('unsupported', t('billing.errNoPortal')); },
    stopWatch() {},
    watching: () => null,
  };
}

module.exports = { createFakeBilling };
