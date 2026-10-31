'use strict';
// Planes de Venus IA: estado, catálogo con precios (pesos con Mercado Pago, dólares con PayPal) y pago directo.
// La lógica sin Electron está en billing/client.js; el servidor es la Edge Function "payments" (0017_pagos_directos).
//
// Canales:
//   billing:state()                 -> estado del plan de la cuenta
//   billing:catalog()               -> { source, providers, arsPerUsd, plans: [{ id, name, priceUsd, prices: { mercado_pago, paypal } }] }
//   billing:checkout({ plan, provider }) -> { order, url } (abre el pago en el navegador y lo sigue)
//   billing:order(orderId)          -> orden actualizada (consulta al proveedor si sigue pendiente)
//   billing:orders()                -> últimos pagos de la cuenta
//   billing:reopen(url)             -> vuelve a abrir el link de pago
// Eventos: billing:order (cambió una orden que se está siguiendo) y billing:changed (se activó un plan).
const secure = require('../core/secure');
const i18n = require('../core/i18n');
const { createBillingClient, STATIC_PLANS, coded } = require('./billing/client');

const { t } = i18n;
const SESSION_KEY = 'ui:sb.venus-auth'; // sesión de Supabase que guarda cloud.js (cifrada)

let sendToUi = () => {};
let client = null;
let refreshing = null;

function fakeMode() {
  if (!process.env.VENUS_DEVSHOT || process.env.VENUS_BILLING_FAKE !== '1') return false;
  try {
    return !require('electron').app.isPackaged;
  } catch {
    return false;
  }
}

// Siempre el proyecto del launcher (core/cloud-defaults.js): los ajustes viejos (settings.cloud) se ignoran.
async function cloudConfig() {
  return require('../core/cloud-defaults').config();
}

async function storedSession() {
  const raw = await secure.get(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return s?.access_token ? s : null;
  } catch {
    return null;
  }
}

const fresh = (s) => s && (!s.expires_at || s.expires_at * 1000 - Date.now() > 60000);

// Token de acceso vigente. Si está por vencer le pide a la interfaz (cloud.js) que renueve la sesión: el
// refresh token rota, así que lo renueva un solo lado (y una sola vez aunque lleguen varios pedidos juntos).
async function accessToken() {
  const s = await storedSession();
  if (fresh(s)) return s.access_token;
  if (!s) throw coded('noSession', t('billing.errSignIn'));
  if (!refreshing) {
    refreshing = (async () => {
      sendToUi('cloud:refreshSession');
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const next = await storedSession();
        if (fresh(next)) return next.access_token;
      }
      throw coded('noSession', t('billing.errSession'));
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

function getClient() {
  if (!client && fakeMode()) {
    client = require('./billing/fake').createFakeBilling({ t, send: (channel, payload) => sendToUi(channel, payload) });
    console.warn('[billing] Modo de capturas (VENUS_BILLING_FAKE=1): pagos de ejemplo, sin servidor.');
  }
  if (!client) {
    client = createBillingClient({
      fetch: (url, init) => fetch(url, init),
      cloudConfig,
      accessToken,
      sessionUser: async () => (await storedSession())?.user?.id || null,
      t,
      openExternal: (url) => require('electron').shell.openExternal(url),
      send: (channel, payload) => sendToUi(channel, payload),
      aiStatus: (opts) => require('./ai').status(opts),
    });
  }
  return client;
}

const state = () => getClient().state();
const catalog = () => getClient().catalog();
const checkout = (input) => getClient().checkout(input);
const portal = () => getClient().portal();

function register({ handle, send, onQuit }) {
  sendToUi = send;
  handle('billing:state', () => state());
  handle('billing:catalog', () => catalog());
  handle('billing:checkout', (input) => checkout(input));
  handle('billing:order', (orderId) => getClient().order(orderId));
  handle('billing:orders', () => getClient().orders());
  handle('billing:reopen', (url) => getClient().reopen(url));
  handle('billing:portal', () => portal());
  if (typeof onQuit === 'function') onQuit(() => getClient().stopWatch());
}

module.exports = { register, state, catalog, checkout, portal, PLANS: STATIC_PLANS };
