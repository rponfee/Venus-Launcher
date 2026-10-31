'use strict';
// Tickets de consultas con la identidad de la sesión; los permisos se verifican en Supabase.
const secure = require('../core/secure');
const { createSupportClient, coded } = require('./support/client');
const SESSION_KEY = 'ui:sb.venus-auth';
let sendToUi = () => {};
let refreshing = null;
let client = null;
async function storedSession() {
  const raw = await secure.get(SESSION_KEY);
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}
const fresh = (s) => s?.access_token && (!s.expires_at || s.expires_at * 1000 - Date.now() > 60000);
async function accessToken(expectedOwner) {
  const session = await storedSession();
  if (!expectedOwner || session?.user?.id !== expectedOwner) throw coded('noSession', 'La cuenta cambió. Volvé a abrir Soporte para continuar.');
  if (fresh(session)) return session.access_token;
  if (!session?.access_token) throw coded('noSession', 'Iniciá sesión con tu cuenta de Venus para contactar a soporte.');
  if (!refreshing) refreshing = (async () => {
    sendToUi('cloud:refreshSession');
    for (let i = 0; i < 25; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const next = await storedSession();
      if (next?.user?.id !== expectedOwner) throw coded('noSession', 'La cuenta cambió. Volvé a abrir Soporte para continuar.');
      if (fresh(next)) return next.access_token;
    }
    throw coded('noSession', 'Tu sesión venció. Volvé a iniciar sesión.');
  })().finally(() => { refreshing = null; });
  const token = await refreshing;
  if ((await storedSession())?.user?.id !== expectedOwner) throw coded('noSession', 'La cuenta cambió. Volvé a abrir Soporte para continuar.');
  return token;
}
function getClient() {
  return client ||= createSupportClient({ fetch: (...args) => fetch(...args), cloudConfig: () => require('../core/cloud-defaults').config(), accessToken });
}
async function call(action, payload) {
  const owner = (await storedSession())?.user?.id || null;
  const result = await getClient().call(action, payload, owner);
  if ((await storedSession())?.user?.id !== owner) throw coded('noSession', 'La cuenta cambió. Volvé a abrir Soporte para continuar.');
  if (['create', 'reply', 'resolve'].includes(action)) sendToUi('support:changed', { action });
  return result;
}
function register({ handle, send }) {
  sendToUi = send;
  handle('support:call', call);
  for (const action of ['list', 'create', 'reply', 'resolve']) handle(`support:${action}`, (payload) => call(action, payload));
  handle('support:detail', (ticketId) => call('detail', { ticketId }));
}
module.exports = { register, call };
