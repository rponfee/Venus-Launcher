'use strict';
// Panel de administración del launcher (solo para los emails de app_admin_emails, confirmados). La lógica sin
// Electron está en admin/client.js; el servidor es la Edge Function "admin" (supabase/functions/admin) y la
// migración 0012_admin.sql. Guía: docs/admin.md.
//
// Canales:
//   admin:me({ force? })           -> { isAdmin, email, userId, reason, checkedAt, fake? }  (guardado 5 minutos por usuario)
//   admin:call(action, payload?)   -> result de la acción (users.list, users.ban, coupons.create, plans.setPrice...)
// Errores con err.code: noCloud, noSession, forbidden, notFound, unavailable, badRequest, conflict,
// stripeNotConfigured, stripe, server, network, error.
//
// Modo de prueba para capturas (VENUS_DEVSHOT + VENUS_ADMIN_FAKE=1, nunca en la app empaquetada): datos de ejemplo
// locales (admin/fake.js). No habla con ningún servidor, así que no puede dar permisos reales de admin.
const secure = require('../core/secure');
const i18n = require('../core/i18n');
const { createAdminClient, coded } = require('./admin/client');

const { t } = i18n;
const SESSION_KEY = 'ui:sb.venus-auth'; // sesión de Supabase que guarda cloud.js (cifrada)

let sendToUi = () => {};
let client = null;
let refreshing = null;

function fakeMode() {
  if (!process.env.VENUS_DEVSHOT || process.env.VENUS_ADMIN_FAKE !== '1') return false;
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

// Token de acceso vigente. Si está por vencer le pide a la interfaz (cloud.js) que renueve la sesión: el refresh
// token rota, así que lo renueva un solo lado (y una sola vez aunque lleguen varios pedidos juntos).
async function accessToken() {
  const s = await storedSession();
  if (fresh(s)) return s.access_token;
  if (!s) throw coded('noSession', t('admin.errSignIn'));
  if (!refreshing) {
    refreshing = (async () => {
      sendToUi('cloud:refreshSession');
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const next = await storedSession();
        if (fresh(next)) return next.access_token;
      }
      throw coded('noSession', t('admin.errSession'));
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

// Usuario de la sesión guardada (sin el token): { userId, email } o null.
async function session() {
  const s = await storedSession();
  const user = s && s.user && typeof s.user === 'object' ? s.user : null;
  if (!user || typeof user.id !== 'string') return null;
  return { userId: user.id, email: typeof user.email === 'string' ? user.email : null };
}

function getClient() {
  if (!client) {
    client = createAdminClient({
      fetch: (url, init) => fetch(url, init),
      cloudConfig,
      accessToken,
      session,
      t,
      fake: fakeMode() ? require('./admin/fake').createFakeAdmin() : null,
    });
  }
  return client;
}

const me = (opts) => getClient().me(opts && typeof opts === 'object' ? opts : {});
const call = (action, payload) => getClient().call(action, payload);

function register({ handle, send }) {
  sendToUi = send;
  handle('admin:me', (opts) => me(opts));
  handle('admin:call', (action, payload) => call(action, payload));
}

module.exports = { register, me, call };
