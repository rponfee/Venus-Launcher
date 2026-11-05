'use strict';
// Cliente de la API de Openverse (https://api.openverse.org/v1/audio/) para la musica de perfil. Sin Electron: recibe
// fetch, reloj y almacenamiento, asi se prueba con respuestas guardadas.
//
// Reglas de Openverse para pedidos anonimos (sin clave): 20 por minuto y 200 por dia por IP, page_size hasta 20.
// Este cliente se queda por debajo (12 por minuto, 160 por dia), guarda los resultados en disco, y si la API contesta
// 429 respeta Retry-After y no vuelve a pedir hasta entonces. Si hay una copia vieja de la misma busqueda y no se
// puede pedir (limite, sin internet), devuelve esa copia marcada como vieja.
//
// Errores (err.code): bad_query, offline, rate_limited (err.retryAfter en segundos), daily_limit (idem), network,
// timeout, server, bad_response.
const { buildSearch } = require('./query');
const { trackFromResult, normalizeTrack, LIMITS } = require('./policy');

const BASE = 'https://api.openverse.org/v1/audio/';
const TIMEOUT_MS = 15_000;
const MAX_BODY = 1_500_000; // una pagina de 20 resultados pesa ~60 KB
const FRESH_MS = 12 * 3_600_000; // las busquedas repetidas no gastan cupo durante 12 horas
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 3_600_000;
const MINUTE_MAX = 12; // Openverse: 20 por minuto
const DAY_MAX = 160; // Openverse: 200 por dia
const MAX_ENTRIES = 80;
const RETRY_PAUSE_MS = 1200;
const LONG_WAIT_S = 3600; // una espera mayor a una hora es el cupo del dia, no el del minuto

function fail(code, extra = {}) {
  return Object.assign(new Error(code), { code }, extra);
}

const emptyState = () => ({ v: 1, hits: [], blockedUntil: 0, quota: null, entries: {} });

function cleanState(raw) {
  const s = emptyState();
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return s;
  s.hits = (Array.isArray(raw.hits) ? raw.hits : []).filter((n) => Number.isFinite(n)).slice(-400);
  s.blockedUntil = Number.isFinite(raw.blockedUntil) ? raw.blockedUntil : 0;
  s.quota = raw.quota && typeof raw.quota === 'object' ? { burst: Number(raw.quota.burst) || 0, sustained: Number(raw.quota.sustained) || 0, at: Number(raw.quota.at) || 0 } : null;
  if (raw.entries && typeof raw.entries === 'object') {
    for (const [k, e] of Object.entries(raw.entries).slice(0, MAX_ENTRIES * 2)) {
      if (!e || typeof e !== 'object' || !Number.isFinite(e.at) || !e.data || typeof e.data !== 'object' || !Array.isArray(e.data.items)) continue;
      // El archivo en disco tampoco es de fiar: cada pista se vuelve a validar
      const items = e.data.items.slice(0, 40).map(normalizeTrack).filter(Boolean);
      const d = e.data;
      s.entries[k] = { at: e.at, data: { items, page: Number(d.page) || 1, pageCount: Number(d.pageCount) || 1, total: Number(d.total) || items.length } };
    }
  }
  return s;
}

// "Request was throttled. Expected available in 25 seconds." -> 25
function secondsFromDetail(text) {
  const m = /available in (\d+) second/i.exec(String(text || ''));
  return m ? Number(m[1]) : 0;
}

function retryAfterSeconds(headers, bodyText) {
  const h = headers?.get?.('retry-after');
  if (h) {
    const n = Number(h);
    if (Number.isFinite(n)) return Math.max(1, Math.ceil(n));
    const d = Date.parse(h);
    if (Number.isFinite(d)) return Math.max(1, Math.ceil((d - Date.now()) / 1000));
  }
  return Math.max(1, secondsFromDetail(bodyText) || 30);
}

async function readCapped(res, max) {
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > max) throw fail('bad_response');
  if (!res.body?.getReader) {
    const text = await res.text();
    if (text.length > max) throw fail('bad_response');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      throw fail('bad_response');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * opts:
 *   fetch       (url, init) => Promise<Response>
 *   userAgent   texto del encabezado User-Agent
 *   store       { read() -> Promise<estado|null>, write(estado) -> Promise }
 *   now         () => ms (reloj)
 *   sleep       (ms) => Promise
 *   isOffline   () => boolean
 *   timeoutMs   espera maxima por pedido (15 s)
 */
function createClient({ fetch: doFetch, userAgent, store, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), isOffline = () => false, timeoutMs = TIMEOUT_MS } = {}) {
  let state = null;
  let loading = null;
  let saving = Promise.resolve();

  async function load() {
    if (state) return state;
    if (!loading) {
      loading = Promise.resolve(store?.read?.())
        .catch(() => null)
        .then((raw) => {
          state = cleanState(raw);
          return state;
        });
    }
    return loading;
  }

  function save() {
    const snapshot = JSON.stringify(state);
    saving = saving.then(() => store?.write?.(JSON.parse(snapshot))).catch(() => {});
    return saving;
  }

  function prune(s) {
    const t = now();
    s.hits = s.hits.filter((h) => t - h < DAY_MS);
    const keys = Object.keys(s.entries);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => s.entries[a].at - s.entries[b].at);
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete s.entries[k];
    }
  }

  // Cuanto falta para poder pedir: null si se puede ahora; { code, retryAfter } si no
  function waitInfo(s) {
    const t = now();
    if (s.blockedUntil > t) {
      const retryAfter = Math.ceil((s.blockedUntil - t) / 1000);
      return { code: retryAfter > LONG_WAIT_S ? 'daily_limit' : 'rate_limited', retryAfter };
    }
    const recent = s.hits.filter((h) => t - h < MINUTE_MS);
    if (recent.length >= MINUTE_MAX) return { code: 'rate_limited', retryAfter: Math.max(1, Math.ceil((recent[0] + MINUTE_MS - t) / 1000)) };
    if (s.hits.length >= DAY_MAX) return { code: 'daily_limit', retryAfter: Math.max(1, Math.ceil((Math.min(...s.hits) + DAY_MS - t) / 1000)) };
    return null;
  }

  function fromEntry(entry, extra = {}) {
    return { ...entry.data, ...extra };
  }

  async function requestOnce(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { method: 'GET', redirect: 'error', headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: ctl.signal });
      const body = await readCapped(res, MAX_BODY);
      return { res, body };
    } catch (err) {
      if (err?.code === 'bad_response') throw err;
      if (ctl.signal.aborted) throw fail('timeout');
      throw fail('network');
    } finally {
      clearTimeout(timer);
    }
  }

  function parsePage(body, page) {
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw fail('bad_response');
    }
    if (!json || typeof json !== 'object' || !Array.isArray(json.results)) throw fail('bad_response');
    const items = [];
    const seen = new Set();
    for (const raw of json.results.slice(0, 40)) {
      const track = trackFromResult(raw);
      if (track && !seen.has(track.id)) {
        seen.add(track.id);
        items.push(track);
      }
    }
    const total = Number.isFinite(json.result_count) ? Math.max(0, Math.floor(json.result_count)) : items.length;
    const pageCount = Number.isFinite(json.page_count) ? Math.max(0, Math.min(12, Math.floor(json.page_count))) : 1;
    return { items, page, pageCount, total, rawCount: json.results.length };
  }

  /** search({ text, genre, length, source, page }) -> { items, page, pageCount, total, fromCache, stale } */
  async function search(input) {
    const q = buildSearch(input); // puede tirar bad_query
    const s = await load();
    prune(s);
    const cached = s.entries[q.key];
    if (cached && now() - cached.at < FRESH_MS) return fromEntry(cached, { fromCache: true, stale: false });
    if (isOffline()) {
      if (cached) return fromEntry(cached, { fromCache: true, stale: true });
      throw fail('offline');
    }
    const wait = waitInfo(s);
    if (wait) {
      if (cached) return fromEntry(cached, { fromCache: true, stale: true });
      throw fail(wait.code, { retryAfter: wait.retryAfter });
    }
    const url = `${BASE}?${new URLSearchParams(q.params).toString()}`;
    let attempt = 0;
    for (;;) {
      attempt++;
      s.hits.push(now());
      await save();
      let out;
      try {
        out = await requestOnce(url);
      } catch (err) {
        if (attempt < 2 && (err.code === 'network' || err.code === 'timeout')) {
          await sleep(RETRY_PAUSE_MS);
          continue;
        }
        if (cached) return fromEntry(cached, { fromCache: true, stale: true });
        throw err;
      }
      const { res, body } = out;
      // Lo que queda de cupo segun la API (informativo; si dice que no queda, se espera un poco)
      const burst = Number(res.headers?.get?.('x-ratelimit-available-anon_burst'));
      const sustained = Number(res.headers?.get?.('x-ratelimit-available-anon_sustained'));
      if (Number.isFinite(burst) || Number.isFinite(sustained)) {
        s.quota = { burst: Number.isFinite(burst) ? burst : 0, sustained: Number.isFinite(sustained) ? sustained : 0, at: now() };
        if (Number.isFinite(burst) && burst <= 0) s.blockedUntil = Math.max(s.blockedUntil, now() + 20_000);
      }
      if (res.status === 429) {
        const retryAfter = retryAfterSeconds(res.headers, body);
        s.blockedUntil = now() + retryAfter * 1000;
        await save();
        if (cached) return fromEntry(cached, { fromCache: true, stale: true });
        throw fail(retryAfter > LONG_WAIT_S ? 'daily_limit' : 'rate_limited', { retryAfter });
      }
      if (res.status >= 500) {
        if (attempt < 2) {
          await sleep(RETRY_PAUSE_MS);
          continue;
        }
        if (cached) return fromEntry(cached, { fromCache: true, stale: true });
        throw fail('server');
      }
      if (res.status !== 200) {
        await save();
        throw fail('bad_response', { status: res.status });
      }
      const type = String(res.headers?.get?.('content-type') || '');
      if (type && !/json/i.test(type)) throw fail('bad_response');
      const data = parsePage(body, q.page);
      const entry = { at: now(), data: { items: data.items, page: data.page, pageCount: data.pageCount, total: data.total } };
      s.entries[q.key] = entry;
      prune(s);
      await save();
      return fromEntry(entry, { fromCache: false, stale: false });
    }
  }

  async function status() {
    const s = await load();
    prune(s);
    const t = now();
    return {
      blockedUntil: s.blockedUntil > t ? s.blockedUntil : 0,
      usedLastMinute: s.hits.filter((h) => t - h < MINUTE_MS).length,
      usedToday: s.hits.length,
      limits: { perMinute: MINUTE_MAX, perDay: DAY_MAX },
      quota: s.quota,
      cached: Object.keys(s.entries).length,
    };
  }

  async function clearCache() {
    const s = await load();
    const removed = Object.keys(s.entries).length;
    s.entries = {};
    await save();
    return { removed };
  }

  return { search, status, clearCache, BASE, LIMITS };
}

module.exports = { createClient, cleanState, retryAfterSeconds, secondsFromDetail, BASE, FRESH_MS, MINUTE_MAX, DAY_MAX, MAX_ENTRIES, TIMEOUT_MS };
