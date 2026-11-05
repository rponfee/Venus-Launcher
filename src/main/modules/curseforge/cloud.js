'use strict';
// Transporte al catálogo de Venus. La clave de CurseForge nunca se descarga: solo viaja la sesión de Venus.
// La interfaz sigue siendo la única que renueva el refresh token; este módulo espera el access token nuevo.
function createCloudClient({ fetch, cloudConfig, readSession, refreshSession, t, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  let refreshing = null;
  let known = null; // último estado leído del servidor: { url, state, until, seen }
  let probing = null;
  const STALE_MS = 10 * 60 * 1000; // cuánto se sigue creyendo "configurado" si el servidor no contesta
  const error = (key, code) => Object.assign(new Error(t(key)), { code });
  const parse = (raw) => {
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  };
  const fresh = (s) => s?.access_token && (!s.expires_at || s.expires_at * 1000 - now() > 60000);

  // Espera a que la interfaz guarde un access token distinto al que se usó (o falla si cambia la cuenta).
  async function waitForNewToken(previous, tries = 25) {
    refreshSession();
    for (let i = 0; i < tries; i++) {
      await sleep(200);
      const next = parse(await readSession());
      if (!next?.access_token || next.user?.id !== previous.user?.id) break;
      if (fresh(next) && next.access_token !== previous.access_token) return next.access_token;
    }
    return null;
  }

  async function token() {
    const s = parse(await readSession());
    if (!s?.access_token) throw error('curseforge.errSignIn', 'noSession');
    if (fresh(s)) return s.access_token;
    if (!refreshing) {
      refreshing = (async () => {
        const next = await waitForNewToken(s);
        if (next) return next;
        throw error('cloudsync.errSession', 'noSession');
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  // ¿Hay una cuenta de Venus con sesión guardada? No dice si el token sigue vigente: la interfaz lo renueva sola.
  async function signedIn() {
    return Boolean(parse(await readSession())?.access_token);
  }

  // Estado del catálogo central: 'on' (el servidor tiene la clave), 'off' (no la tiene) o 'unknown' (no se pudo
  // preguntar). Un fallo de red NO equivale a "no configurado": si hace poco se supo que estaba 'on' se sigue con
  // eso, y si no se sabe nada se devuelve 'unknown' para que el llamador decida (el servidor contesta con precisión).
  async function state({ force = false } = {}) {
    const cfg = cloudConfig();
    if (!cfg?.configured) return 'off';
    if (!force && known && known.url === cfg.url && known.until > now()) return known.state;
    if (probing) return probing;
    probing = (async () => {
      try {
        const res = await fetch(cfg.url + '/rest/v1/rpc/curseforge_status', {
          method: 'POST', headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
          body: '{}', signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error('status ' + res.status); }
        const value = (await res.json())?.configured === true;
        known = { url: cfg.url, state: value ? 'on' : 'off', until: now() + (value ? 30000 : 5000), seen: now() };
        return known.state;
      } catch {
        if (known && known.url === cfg.url && known.state === 'on' && now() - known.seen < STALE_MS) return 'on';
        return 'unknown';
      } finally {
        probing = null;
      }
    })();
    return probing;
  }

  async function configured(opts) {
    return (await state(opts)) === 'on';
  }

  async function send(cfg, access, path, method, body, signal) {
    return fetch(cfg.url + '/functions/v1/curseforge', {
      method: 'POST',
      headers: { apikey: cfg.anonKey, Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, path, ...(body === undefined ? {} : { body }) }),
      signal: signal || AbortSignal.timeout(30000), redirect: 'error',
    });
  }

  async function request(path, { method = 'GET', body, signal } = {}) {
    const cfg = cloudConfig();
    if (!cfg?.configured) throw error('curseforge.errNoKey', 'nokey');
    const access = await token();
    const res = await send(cfg, access, path, method, body, signal);
    if (res.status !== 401) return res;
    // Un 401 con un token que parecía vigente: reloj atrasado de la PC o sesión revocada. Se pide un token nuevo
    // una sola vez antes de decirle a la persona que inicie sesión.
    await res.body?.cancel().catch(() => {});
    const current = parse(await readSession());
    const renewed = current?.access_token ? await waitForNewToken({ ...current, access_token: access }, 15) : null;
    if (!renewed) throw error('curseforge.errSignIn', 'noSession');
    return send(cfg, renewed, path, method, body, signal);
  }

  return { configured, state, signedIn, request };
}
module.exports = { createCloudClient };
