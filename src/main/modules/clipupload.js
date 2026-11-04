'use strict';
// Subir clips a YouTube o TikTok, directo desde el launcher. Solo con los identificadores de las aplicaciones cargados al
// compilar (clipupload/config.js) y solo cuando el usuario aprieta "Subir". El camino sin credenciales (abrir la pagina de
// subida, mostrar el archivo y copiar el texto) no pasa por aca: lo hace features/clipstudio/upload.js.
// Los tokens van cifrados (core/secure -> safeStorage) y no vuelven nunca a la interfaz. Guia: docs/implementacion/clips.md.
//
// Canales:
//   clipupload:status() -> { youtube: { configured, connected }, tiktok: { configured, connected } }
//   clipupload:connect(proveedor) -> { connected } (abre el navegador y espera la vuelta) · clipupload:cancelConnect()
//   clipupload:revoke(proveedor) -> { connected: false }
//   clipupload:upload({ jobId, provider, path, title, description, privacy }) -> { provider, url?, studio?, status? }
//   clipupload:cancel(jobId)
// Evento: clipupload:progress { jobId, sent, total }
const fsp = require('fs/promises');
const secure = require('../core/secure');
const { t } = require('../core/i18n');
const media = require('./worlds/media');
const oauth = require('./clipupload/oauth');
const config = require('./clipupload/config');
const { createYoutube } = require('./clipupload/youtube');
const { createTiktok } = require('./clipupload/tiktok');

const SESSION_KEY = 'ui:sb.venus-auth';
const BROKER_FUNCTION = 'tiktok-token';
const EXPIRY_MARGIN_MS = 60000;
const MAX_SIZE = 256 * 1024 * 1024 * 1024; // el tope de YouTube; lo que TikTok no acepta lo rechaza su plan de pedazos

let sendToUi = () => {};
let connecting = null; // { provider, close }
const jobs = new Map(); // jobId -> AbortController

const tokenKey = (provider) => `clipupload.${provider}`;

function coded(key, code) {
  return Object.assign(new Error(t(`clipstudio.${key}`)), { code });
}

// El error de youtube.js o tiktok.js, ya con un mensaje para el usuario
function friendly(err) {
  const map = { clip: 'errClip', session: 'errUploadSession', quota: 'errUploadQuota', noChannel: 'errUploadNoChannel', forbidden: 'errUploadForbidden', badRequest: 'errUploadBad', network: 'errUploadNetwork', rejected: 'errUploadRejected', tooBig: 'errUploadTooBig', denied: 'errConnectDenied', timeout: 'errConnectTimeout', noSession: 'errBrokerSession', broker: 'errBroker', oauth: 'errConnectFailed', notConfigured: 'errNotConfigured', cancelled: 'uploadCancelled' };
  const key = map[err?.code] || 'errUploadFailed';
  if (!map[err?.code]) console.warn('[clipupload]', err?.code || '', err?.message || err);
  return Object.assign(new Error(t(`clipstudio.${key}`)), { code: err?.code || 'failed' });
}

// ---------- Sesion de Venus (solo para el intercambio de tokens de TikTok) ----------

async function venusToken() {
  const raw = await secure.get(SESSION_KEY);
  let s = null;
  try {
    s = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    s = null;
  }
  if (!s?.access_token) throw Object.assign(new Error('no session'), { code: 'noSession' });
  if (s.expires_at && s.expires_at * 1000 - Date.now() < EXPIRY_MARGIN_MS) {
    // El refresh token rota: lo renueva solo la interfaz (cloud.js)
    sendToUi('cloud:refreshSession');
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const next = await secure.get(SESSION_KEY).catch(() => null);
      const parsed = typeof next === 'string' ? JSON.parse(next) : next;
      if (parsed?.access_token && (!parsed.expires_at || parsed.expires_at * 1000 - Date.now() > EXPIRY_MARGIN_MS)) return parsed.access_token;
    }
    throw Object.assign(new Error('no session'), { code: 'noSession' });
  }
  return s.access_token;
}

async function broker(action, params) {
  const cfg = require('../core/cloud-defaults').config();
  if (!cfg?.configured) throw Object.assign(new Error('no cloud'), { code: 'broker' });
  const token = await venusToken();
  let res;
  try {
    res = await fetch(`${cfg.url}/functions/v1/${BROKER_FUNCTION}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...params }), signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw Object.assign(new Error(err?.message), { code: 'network' });
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401) throw Object.assign(new Error('unauthorized'), { code: 'noSession' });
  if (!res.ok || !data) throw Object.assign(new Error(data?.error?.code || String(res.status)), { code: data?.error?.code === 'invalid_grant' ? 'session' : 'broker' });
  return data;
}

// ---------- Proveedores ----------

function provider(name) {
  const cfg = config.get();
  if (name === 'youtube' && cfg.youtubeClientId) return createYoutube({ fetch: (u, i) => fetch(u, i), clientId: cfg.youtubeClientId, clientSecret: cfg.youtubeClientSecret });
  if (name === 'tiktok' && cfg.tiktokClientKey) return createTiktok({ fetch: (u, i) => fetch(u, i), clientKey: cfg.tiktokClientKey, broker });
  throw Object.assign(new Error('not configured'), { code: 'notConfigured' });
}

async function status() {
  const cfg = config.get();
  const one = async (name, id) => ({ configured: Boolean(id), connected: Boolean(id) && (await secure.has(tokenKey(name)).catch(() => false)) });
  return { youtube: await one('youtube', cfg.youtubeClientId), tiktok: await one('tiktok', cfg.tiktokClientKey) };
}

function closingPage(ok) {
  const text = t(ok ? 'clipstudio.connectPageOk' : 'clipstudio.connectPageDenied');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Venus Launcher</title><style>body{font:16px system-ui,sans-serif;background:#0d0a18;color:#eee;display:grid;place-items:center;height:100vh;margin:0}</style></head><body><p>${text}</p></body></html>`;
}

async function connect(name) {
  const { shell } = require('electron');
  if (connecting) connecting.close();
  let loop = null;
  const current = { cancelled: false, close() { this.cancelled = true; loop?.close(); } };
  connecting = current;
  const check = () => {
    if (current.cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
  };
  try {
    const api = provider(name);
    const verifier = oauth.randomVerifier();
    const state = oauth.randomState();
    loop = await oauth.startLoopback({ path: api.loopbackPath || '/', state, page: closingPage });
    try {
      check();
      const challenge = name === 'tiktok' ? oauth.challengeHex(verifier) : oauth.challengeS256(verifier);
      await shell.openExternal(api.authorizeUrl({ redirectUri: loop.redirectUri, challenge, state }));
      const code = await loop.result;
      check();
      const tokens = await api.exchange({ code, verifier, redirectUri: loop.redirectUri });
      check();
      await secure.set(tokenKey(name), tokens);
      return { connected: true };
    } finally {
      loop.close();
    }
  } catch (err) {
    throw friendly(err);
  } finally {
    if (connecting === current) connecting = null;
  }
}

async function revoke(name) {
  const tokens = await secure.get(tokenKey(name)).catch(() => null);
  try {
    if (tokens) await provider(name).revoke(tokens);
  } catch (err) {
    // Sin conexion igual se borra de esta PC; el usuario puede sacarle el permiso desde su cuenta
    console.warn('[clipupload] revocar:', err?.code || '', err?.message || err);
  }
  await secure.remove(tokenKey(name));
  return { connected: false };
}

// Token vigente; si esta por vencer, lo renueva y guarda el nuevo
function tokenSource(name, api) {
  let tokens = null;
  const renew = async () => {
    tokens = await api.refresh(tokens);
    await secure.set(tokenKey(name), tokens);
    return tokens.access_token;
  };
  return {
    getToken: async () => {
      tokens = tokens || (await secure.get(tokenKey(name)));
      if (!tokens?.access_token) throw Object.assign(new Error('not connected'), { code: 'session' });
      return tokens.expires_at && tokens.expires_at - Date.now() < EXPIRY_MARGIN_MS ? renew() : tokens.access_token;
    },
    renewToken: renew,
  };
}

async function upload(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const jobId = String(o.jobId || '').slice(0, 64);
  const name = o.provider === 'tiktok' ? 'tiktok' : 'youtube';
  const m = media.checkMediaPath(o.path);
  if (!jobId || !m || m.kind !== 'clip') throw coded('errClip', 'clip');
  if (jobs.has(jobId)) throw coded('errUploadFailed', 'failed');
  const controller = new AbortController();
  jobs.set(jobId, controller);
  let fh = null;
  let last = 0;
  try {
    const st = await fsp.stat(m.full).catch(() => null);
    controller.signal.throwIfAborted();
    if (!st?.isFile() || !st.size) throw coded('errClip', 'clip');
    if (st.size > MAX_SIZE) throw coded('errUploadTooBig', 'tooBig');
    const api = provider(name);
    fh = await fsp.open(m.full, 'r');
    controller.signal.throwIfAborted();
    const read = async (pos, len) => {
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return bytesRead === len ? buf : buf.subarray(0, bytesRead);
    };
    const res = await api.upload({
      ...tokenSource(name, api),
      meta: { title: o.title, description: o.description, privacy: o.privacy },
      size: st.size,
      mime: media.mimeOf(m.full),
      read,
      signal: controller.signal,
      onProgress: ({ sent, total }) => {
        const now = Date.now();
        if (now - last < 200 && sent < total) return;
        last = now;
        sendToUi('clipupload:progress', { jobId, sent, total });
      },
    });
    return { provider: name, ...res };
  } catch (err) {
    if (controller.signal.aborted) throw Object.assign(new Error(t('clipstudio.uploadCancelled')), { code: 'cancelled' });
    throw friendly(err);
  } finally {
    jobs.delete(jobId);
    await fh?.close().catch(() => {});
  }
}

function register({ handle, send, onQuit }) {
  sendToUi = send;
  handle('clipupload:status', () => status());
  handle('clipupload:connect', (name) => connect(name === 'tiktok' ? 'tiktok' : 'youtube'));
  handle('clipupload:cancelConnect', () => {
    connecting?.close();
    return true;
  });
  handle('clipupload:revoke', (name) => revoke(name === 'tiktok' ? 'tiktok' : 'youtube'));
  handle('clipupload:upload', (o) => upload(o));
  handle('clipupload:cancel', (jobId) => {
    jobs.get(String(jobId))?.abort();
    return true;
  });
  onQuit(() => {
    connecting?.close();
    for (const c of jobs.values()) c.abort();
  });
}

module.exports = { register };
