'use strict';
// Cliente de Modrinth del buscador: cache en memoria, pocas consultas en paralelo y freno
// automatico cuando quedan pocas consultas disponibles (Modrinth permite ~300 por minuto por IP
// y el resto del launcher comparte ese limite).
const http = require('../../core/http');

const API = 'https://api.modrinth.com/v2';
const MAX_PARALLEL = 4;
const MAX_CACHE = 600;

const cache = new Map(); // url -> { at, data }
const inflight = new Map(); // url -> Promise
const waiting = [];
let active = 0;
let pauseUntil = 0;
let requests = 0;

function q(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`)
    .join('&');
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Cancelado');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError(signal));
      },
      { once: true },
    );
  });
}

function acquire(signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (active < MAX_PARALLEL) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject };
    waiting.push(entry);
    signal?.addEventListener(
      'abort',
      () => {
        const i = waiting.indexOf(entry);
        if (i >= 0) {
          waiting.splice(i, 1);
          reject(abortError(signal));
        }
      },
      { once: true },
    );
  });
}

function release() {
  const next = waiting.shift();
  if (next) next.resolve();
  else active--;
}

// Ajusta el ritmo segun los encabezados de limite de Modrinth.
function throttle(res) {
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (!Number.isFinite(remaining) || !Number.isFinite(reset)) return;
  const windowMs = Math.max(1, Math.min(60, reset)) * 1000;
  if (remaining <= 4) pauseUntil = Date.now() + windowMs;
  else if (remaining < 40) pauseUntil = Math.max(pauseUntil, Date.now() + windowMs / remaining);
}

function remember(url, data) {
  cache.set(url, { at: Date.now(), data });
  if (cache.size > MAX_CACHE) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, cache.size - MAX_CACHE);
    for (const [k] of oldest) cache.delete(k);
  }
}

async function get(pathname, { ttl = 10 * 60 * 1000, signal } = {}) {
  const url = `${API}${pathname}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const shared = inflight.get(url);
  if (shared) {
    try {
      return await shared.promise;
    } catch (err) {
      // Si la cancelo otra busqueda (no esta), se vuelve a pedir.
      if (signal?.aborted || !shared.aborted) throw err;
    }
  }
  const entry = { aborted: false };
  entry.promise = (async () => {
    try {
      await acquire(signal);
    } catch (err) {
      entry.aborted = true;
      throw err;
    }
    try {
      const wait = pauseUntil - Date.now();
      if (wait > 0) await sleep(Math.min(wait, 20000), signal);
      requests++;
      const { res } = await http.request(url, { headers: { Accept: 'application/json' } }, { retries: 3, signal });
      throttle(res);
      const data = await res.json();
      remember(url, data);
      return data;
    } catch (err) {
      if (signal?.aborted) entry.aborted = true;
      throw err;
    } finally {
      release();
    }
  })();
  inflight.set(url, entry);
  try {
    return await entry.promise;
  } finally {
    if (inflight.get(url) === entry) inflight.delete(url);
  }
}

// facets: [[...OR], [...OR]] (los grupos se combinan con AND)
function search({ query = '', facets = [], index = 'relevance', limit = 20, offset = 0 }, signal) {
  return get(`/search?${q({ query, facets, index, limit, offset })}`, { signal, ttl: 15 * 60 * 1000 });
}

function versions(projectId, { loaders, gameVersions } = {}, signal) {
  return get(
    `/project/${encodeURIComponent(projectId)}/version?${q({
      loaders: loaders?.length ? loaders : undefined,
      game_versions: gameVersions?.length ? gameVersions : undefined,
      include_changelog: false,
    })}`,
    { signal, ttl: 20 * 60 * 1000 },
  );
}

async function projects(ids, signal) {
  const list = [...new Set(ids.filter(Boolean))];
  const out = [];
  for (let i = 0; i < list.length; i += 100) out.push(...(await get(`/projects?${q({ ids: list.slice(i, i + 100) })}`, { signal, ttl: 30 * 60 * 1000 })));
  return out;
}

module.exports = { search, versions, projects, get, requestCount: () => requests };
