'use strict';
// Cliente minimo de Supabase para el proceso principal: Storage (subir/bajar/borrar partes) y PostgREST
// (tabla cloud_saves) con el token de la sesion que pasa la interfaz en cada operacion. Si el token vence
// durante una transferencia larga, se usa la sesion guardada por cloud.js (cifrada) y, si hace falta,
// se le pide a la interfaz que la renueve (igual que modules/ai.js).
const secure = require('../../core/secure');
const { t } = require('../../core/i18n');
const { sleep } = require('../../core/util');

const BUCKET = 'world-saves';
const SESSION_KEY = 'ui:sb.venus-auth';
const TIMEOUT = 60000;

class CloudError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 0;
  }
}

// Siempre el proyecto del launcher (core/cloud-defaults.js): los ajustes viejos (settings.cloud) se ignoran.
async function cloudConfig() {
  return require('../../core/cloud-defaults').config();
}

function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const fresh = (token) => {
  const p = decodeJwt(token);
  return Boolean(p && p.sub && (!p.exp || p.exp * 1000 - Date.now() > 60000));
};

async function storedToken() {
  try {
    const raw = await secure.get(SESSION_KEY);
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return s?.access_token || null;
  } catch {
    return null;
  }
}

function encodePath(p) {
  return String(p)
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

async function readBody(res) {
  const text = await res.text().catch(() => '');
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

// Error legible a partir de una respuesta de Supabase.
function toError(status, body, kind) {
  const msg = String(body?.json?.message || body?.json?.error || body?.json?.msg || body?.text || '').slice(0, 300);
  const code = String(body?.json?.code || body?.json?.statusCode || '');
  if (/PGRST205|42P01|relation .* does not exist|Could not find the table|Bucket not found/i.test(`${code} ${msg}`)) {
    // Falta la migracion 0004_share.sql (tabla cloud_saves o bucket "world-saves"): el detalle queda en el log
    console.warn('[cloudsync] falta el esquema de la nube (0004_share.sql):', code, msg);
    return new CloudError('schema', t('cloudsync.errSchema'), status);
  }
  if (status === 401 || (status === 400 && /jwt|token/i.test(msg))) return new CloudError('auth', t('cloudsync.errSession'), status);
  if (status === 413 || /too large|exceeded the maximum/i.test(msg)) {
    // Limite de archivos de Storage del proyecto menor a 50 MB (ver docs/supabase.md)
    console.warn('[cloudsync] Storage rechazo una parte por tamaño (revisar el limite de archivos del proyecto):', status, msg);
    return new CloudError('too_large', t('cloudsync.errPartTooLarge'), status);
  }
  if (kind === 'upload' && (status === 403 || /row-level security/i.test(msg))) return new CloudError('quota', t('cloudsync.errQuota'), status);
  if (status === 403) return new CloudError('denied', t('cloudsync.errDenied'), status);
  if (status === 404) return new CloudError('not_found', t('cloudsync.errNotFound'), status);
  if (status === 409) return new CloudError('conflict', t('cloudsync.errRace'), status);
  if (status >= 500) return new CloudError('server', t('cloudsync.errServer', { status }), status);
  return new CloudError('api', t('cloudsync.errApi', { status, detail: msg || '-' }), status);
}

class Session {
  constructor(cfg, token, notify) {
    this.cfg = cfg;
    this.token = token;
    this.notify = notify || (() => {});
    this.userId = decodeJwt(token)?.sub || null;
  }

  // auth = { accessToken } (cloud.session.access_token en la interfaz)
  static async open(auth, notify) {
    const cfg = await cloudConfig();
    if (!cfg.configured) throw new CloudError('no_cloud', t('cloudsync.errNoCloud'));
    let token = typeof auth?.accessToken === 'string' ? auth.accessToken : null;
    if (!token || !decodeJwt(token)?.sub) token = await storedToken();
    if (!token || !decodeJwt(token)?.sub) throw new CloudError('auth', t('cloudsync.errSignIn'));
    const s = new Session(cfg, token, notify);
    await s.getToken();
    if (!/^[0-9a-f-]{36}$/i.test(s.userId || '')) throw new CloudError('auth', t('cloudsync.errSignIn'));
    return s;
  }

  async getToken() {
    if (fresh(this.token)) return this.token;
    let stored = await storedToken();
    if (fresh(stored) && decodeJwt(stored)?.sub === this.userId) {
      this.token = stored;
      return stored;
    }
    this.notify('cloud:refreshSession');
    for (let i = 0; i < 25; i++) {
      await sleep(200);
      stored = await storedToken();
      if (fresh(stored) && decodeJwt(stored)?.sub === this.userId) {
        this.token = stored;
        return stored;
      }
    }
    throw new CloudError('auth', t('cloudsync.errSession'));
  }

  async headers(extra = {}) {
    return { apikey: this.cfg.anonKey, Authorization: `Bearer ${await this.getToken()}`, ...extra };
  }

  async _fetch(url, init, { kind, signal, retries = 2 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res;
      try {
        const timeout = AbortSignal.timeout(init.timeout || TIMEOUT);
        res = await fetch(url, { ...init, headers: await this.headers(init.headers), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      } catch (err) {
        if (signal?.aborted) throw signal.reason || err;
        if (err instanceof CloudError) throw err;
        lastErr = new CloudError('network', t('cloudsync.errNetwork'));
        if (attempt < retries) {
          await sleep(800 * 2 ** attempt);
          continue;
        }
        throw lastErr;
      }
      if (res.ok) return res;
      const body = await readBody(res);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep((Number(res.headers.get('retry-after')) || 2 ** (attempt + 1)) * 1000);
        continue;
      }
      throw toError(res.status, body, kind);
    }
    throw lastErr || new CloudError('network', t('cloudsync.errNetwork'));
  }

  // ---------- PostgREST ----------
  async rest(method, pathQuery, { body, prefer, signal } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    const res = await this._fetch(`${this.cfg.url}/rest/v1/${pathQuery}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }, { kind: 'rest', signal, retries: method === 'GET' ? 2 : 0 });
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ---------- Storage ----------
  async upload(objectPath, buffer, { signal } = {}) {
    await this._fetch(
      `${this.cfg.url}/storage/v1/object/${BUCKET}/${encodePath(objectPath)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true', 'cache-control': 'max-age=0' }, body: buffer, timeout: 15 * 60 * 1000 },
      { kind: 'upload', signal, retries: 3 },
    );
  }

  // Descarga un objeto llamando a onChunk(buffer) por cada pedazo (sin guardarlo entero en memoria).
  async download(objectPath, onChunk, { signal } = {}) {
    const res = await this._fetch(`${this.cfg.url}/storage/v1/object/authenticated/${BUCKET}/${encodePath(objectPath)}`, { method: 'GET', timeout: 15 * 60 * 1000 }, { kind: 'download', signal, retries: 3 });
    let total = 0;
    for await (const chunk of res.body) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      const buf = Buffer.from(chunk);
      total += buf.length;
      await onChunk(buf);
    }
    return total;
  }

  async remove(objectPaths) {
    const list = [...new Set(objectPaths.filter(Boolean))];
    for (let i = 0; i < list.length; i += 100) {
      await this._fetch(
        `${this.cfg.url}/storage/v1/object/${BUCKET}`,
        { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: list.slice(i, i + 100) }) },
        { kind: 'remove', retries: 1 },
      );
    }
  }

  async list(prefix) {
    const res = await this._fetch(
      `${this.cfg.url}/storage/v1/object/list/${BUCKET}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }) },
      { kind: 'list', retries: 1 },
    );
    const data = await res.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  }
}

module.exports = { Session, CloudError, cloudConfig, decodeJwt, BUCKET };
