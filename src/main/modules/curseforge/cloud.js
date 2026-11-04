'use strict';
// Transporte al catálogo de Venus. La clave de CurseForge nunca se descarga: solo viaja la sesión de Venus.
// La interfaz sigue siendo la única que renueva el refresh token; este módulo espera el access token nuevo.
function createCloudClient({ fetch, cloudConfig, readSession, refreshSession, t, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  let refreshing = null;
  let status = null;
  const error = (key, code) => Object.assign(new Error(t(key)), { code });
  const parse = (raw) => {
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  };
  const fresh = (s) => s?.access_token && (!s.expires_at || s.expires_at * 1000 - now() > 60000);

  async function token() {
    const s = parse(await readSession());
    if (!s?.access_token) throw error('curseforge.errSignIn', 'noSession');
    if (fresh(s)) return s.access_token;
    if (!refreshing) {
      refreshing = (async () => {
        refreshSession();
        for (let i = 0; i < 25; i++) {
          await sleep(200);
          const next = parse(await readSession());
          if (!next?.access_token || next.user?.id !== s.user?.id) break;
          if (fresh(next)) return next.access_token;
        }
        throw error('cloudsync.errSession', 'noSession');
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function configured({ force = false } = {}) {
    const cfg = cloudConfig();
    if (!force && status && status.url === cfg?.url && status.until > now()) return status.configured;
    if (!cfg?.configured) return false;
    try {
      const res = await fetch(cfg.url + '/rest/v1/rpc/curseforge_status', {
        method: 'POST', headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      if (!res.ok) { await res.body?.cancel().catch(() => {}); return false; }
      const value = (await res.json())?.configured === true;
      status = { url: cfg.url, configured: value, until: now() + (value ? 30000 : 5000) };
      return value;
    } catch { return false; }
  }

  async function request(path, { method = 'GET', body, signal } = {}) {
    const cfg = cloudConfig();
    if (!cfg?.configured) throw error('curseforge.errNoKey', 'nokey');
    const access = await token();
    return fetch(cfg.url + '/functions/v1/curseforge', {
      method: 'POST',
      headers: { apikey: cfg.anonKey, Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, path, ...(body === undefined ? {} : { body }) }),
      signal: signal || AbortSignal.timeout(30000), redirect: 'error',
    });
  }

  return { configured, request };
}
module.exports = { createCloudClient };
