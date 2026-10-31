'use strict';
// Cliente de Modrinth para compat: pedidos en lote, caché en memoria, como máximo 4 pedidos a la vez
// y espera automática cuando Modrinth avisa que se está por llegar al límite (300 pedidos/min por IP).
const http = require('../../core/http');
const { sleep } = require('../../core/util');
const { t } = require('../../core/i18n');

const API = 'https://api.modrinth.com/v2';
const TTL = 10 * 60 * 1000;
const MAX_PARALLEL = 4;
const MAX_CACHE = 1500;

const cache = new Map(); // clave -> { at, value }
const inflight = new Map();
let active = 0;
const waiting = [];
let pausedUntil = 0;

function acquire() {
  if (active < MAX_PARALLEL) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > MAX_CACHE) {
    const drop = cache.size - MAX_CACHE + 100;
    let n = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++n >= drop) break;
    }
  }
}

function userAgent() {
  try {
    return http.getUserAgent();
  } catch {
    return 'VenusLauncher/1.0.0 (venus-launcher)';
  }
}

async function request(pathname, { method = 'GET', body, signal } = {}) {
  await acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      const wait = pausedUntil - Date.now();
      if (wait > 0) await sleep(Math.min(wait, 20000));
      if (signal?.aborted) throw signal.reason || new Error('Cancelado');
      let res;
      try {
        const timeout = AbortSignal.timeout(25000);
        res = await fetch(API + pathname, {
          method,
          headers: { 'User-Agent': userAgent(), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw signal.reason || err;
        if (attempt >= 2) throw Object.assign(new Error(t('compat.errNetwork')), { cause: err });
        await sleep(700 * 2 ** attempt);
        continue;
      }
      const remaining = Number(res.headers.get('x-ratelimit-remaining'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      if (Number.isFinite(remaining) && remaining <= 5 && Number.isFinite(reset)) pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(reset, 60) * 1000);
      if (res.status === 429) {
        const after = Number(res.headers.get('retry-after')) || (Number.isFinite(reset) ? reset : 5);
        pausedUntil = Date.now() + Math.min(Math.max(after, 1), 60) * 1000;
        if (attempt >= 3) throw new Error(t('compat.errRateLimit'));
        continue;
      }
      if (res.status >= 500) {
        if (attempt >= 2) throw new Error(t('compat.errModrinthDown', { status: res.status }));
        await sleep(800 * 2 ** attempt);
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(t('compat.errModrinth', { status: res.status, detail: text.slice(0, 160) }));
      }
      return await res.json();
    }
  } finally {
    release();
  }
}

function q(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`)
    .join('&');
}

// GET con cache y sin pedidos duplicados en vuelo.
async function get(pathname, opts) {
  const hit = cacheGet(`GET ${pathname}`);
  if (hit !== undefined) return hit;
  if (inflight.has(pathname)) return inflight.get(pathname);
  const p = request(pathname, opts)
    .then((v) => {
      cacheSet(`GET ${pathname}`, v);
      return v;
    })
    .finally(() => inflight.delete(pathname));
  inflight.set(pathname, p);
  return p;
}

function rememberVersion(v) {
  if (v?.id) cacheSet(`v:${v.id}`, v);
}

function rememberProject(p) {
  if (!p?.id) return;
  cacheSet(`p:${p.id}`, p);
  if (p.slug) cacheSet(`p:${p.slug}`, p);
}

// Proyectos por id o slug (en lotes de 100). Devuelve { idOSlug: proyecto }
async function projects(ids, opts) {
  const out = {};
  const missing = [];
  for (const id of new Set((ids || []).filter(Boolean))) {
    const hit = cacheGet(`p:${id}`);
    if (hit) out[id] = hit;
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const list = (await request(`/projects?${q({ ids: chunk })}`, opts)) || [];
    for (const p of list) {
      rememberProject(p);
      for (const id of chunk) if (id === p.id || id === p.slug) out[id] = p;
    }
  }
  return out;
}

async function project(id, opts) {
  return (await projects([id], opts))[id] || null;
}

// Versiones por id (en lotes de 100). Devuelve { id: version }
async function versions(ids, opts) {
  const out = {};
  const missing = [];
  for (const id of new Set((ids || []).filter(Boolean))) {
    const hit = cacheGet(`v:${id}`);
    if (hit) out[id] = hit;
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const list = (await request(`/versions?${q({ ids: missing.slice(i, i + 100) })}`, opts)) || [];
    for (const v of list) {
      rememberVersion(v);
      out[v.id] = v;
    }
  }
  return out;
}

async function version(id, opts) {
  return (await versions([id], opts))[id] || null;
}

// Versiones de un proyecto filtradas por loaders y versiones del juego (las mas nuevas primero).
async function projectVersions(projectId, { loaders, gameVersions, signal } = {}) {
  const list = (await get(`/project/${encodeURIComponent(projectId)}/version?${q({ loaders, game_versions: gameVersions })}`, { signal })) || [];
  list.forEach(rememberVersion);
  return [...list].sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published));
}

// Identifica archivos por sha1. Devuelve { sha1: version | null } (con cache, tambien de los no encontrados)
async function versionsByHash(hashes, opts) {
  const out = {};
  const missing = [];
  for (const h of new Set((hashes || []).filter(Boolean))) {
    const hit = cacheGet(`h:${h}`);
    if (hit !== undefined) out[h] = hit;
    else missing.push(h);
  }
  for (let i = 0; i < missing.length; i += 400) {
    const chunk = missing.slice(i, i + 400);
    const res = (await request('/version_files', { method: 'POST', body: { hashes: chunk, algorithm: 'sha1' }, ...opts })) || {};
    for (const h of chunk) {
      const v = res[h] || null;
      cacheSet(`h:${h}`, v);
      if (v) rememberVersion(v);
      out[h] = v;
    }
  }
  return out;
}

// Ultima version compatible para cada sha1 (sin cache: siempre datos frescos).
async function latestByHash(hashes, { loaders, gameVersions, versionTypes, signal } = {}) {
  const out = {};
  const list = [...new Set((hashes || []).filter(Boolean))];
  for (let i = 0; i < list.length; i += 400) {
    const body = { hashes: list.slice(i, i + 400), algorithm: 'sha1' };
    if (loaders?.length) body.loaders = loaders;
    if (gameVersions?.length) body.game_versions = gameVersions;
    if (versionTypes?.length) body.version_types = versionTypes;
    const res = (await request('/version_files/update', { method: 'POST', body, signal })) || {};
    for (const [h, v] of Object.entries(res)) {
      rememberVersion(v);
      out[h] = v;
    }
  }
  return out;
}

function clearCache() {
  cache.clear();
}

module.exports = { projects, project, versions, version, projectVersions, versionsByHash, latestByHash, userAgent, clearCache };
