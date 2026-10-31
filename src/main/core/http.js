'use strict';
// Descargas pensadas para internet malo (las usan casi todos los modulos; la API de siempre se mantiene):
//  - Reanudables: se escribe en <archivo>.part y, si la conexion se corta, se retoma con Range cuando el
//    servidor lo permite (206 / Accept-Ranges); si no, se empieza de nuevo. Al final se verifican hash y
//    tamaño y se renombra de forma atomica (nunca queda un archivo a medias con el nombre final).
//  - Limite de ancho de banda global (balde de fichas compartido por todas las descargas), concurrencia
//    configurable, pausa global y modo sin conexion: settings.downloads { maxKBps, concurrency, offline }.
//  - Reintentos con espera exponencial + azar, corte por falta de datos y estadisticas en vivo.
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter, once } = require('events');
const { finished } = require('stream/promises');
const { readJson, writeJson, fileSize, hashFile } = require('./util');
const { t } = require('./i18n');

let USER_AGENT = 'VenusLauncher/1.0.0';
const IDLE_TIMEOUT = 30000; // sin recibir datos durante 30 s se corta la conexion (y se reintenta)
const DEFAULT_CONCURRENCY = 16;
const DOWNLOAD_RETRIES = 5; // intentos seguidos sin progreso por cada URL
const MAX_ATTEMPTS = 40; // tope total por URL aunque cada intento avance algo
const PROGRESS_RESET = 256 * 1024; // un intento que bajo al menos esto no gasta reintentos
const HISTORY = 60; // segundos de historial de velocidad
const SPEED_WINDOW = 4; // la velocidad mostrada es el promedio de los ultimos segundos
const SLICE = 16 * 1024; // porcion para contar bytes y aplicar el limite
const MAX_KBPS = 1024 * 1024;
const MAX_CONCURRENCY = 64;

const events = new EventEmitter();
events.setMaxListeners(50);

function setUserAgent(ua) {
  USER_AGENT = ua;
}

// ---------- Ajustes (settings.downloads) ----------
const cfg = { maxKBps: 0, concurrency: 0, offline: false };
let cfgReady = false;
let cfgLoading = null;
let cfgRetryAt = 0;

function normalizeConfig(d) {
  const out = {};
  if (!d || typeof d !== 'object') return out;
  if ('maxKBps' in d) {
    const v = Math.round(Number(d.maxKBps));
    out.maxKBps = Number.isFinite(v) && v > 0 ? Math.min(v, MAX_KBPS) : 0;
  }
  if ('concurrency' in d) {
    const v = Math.round(Number(d.concurrency));
    out.concurrency = Number.isFinite(v) && v > 0 ? Math.min(v, MAX_CONCURRENCY) : 0;
  }
  if ('offline' in d) out.offline = d.offline === true;
  return out;
}

function getConfig() {
  return { ...cfg };
}

// Aplica cambios al momento (las descargas en curso toman el nuevo limite en el proximo bloque).
function configure(patch) {
  const next = normalizeConfig(patch);
  let changed = false;
  for (const [k, v] of Object.entries(next)) {
    if (cfg[k] !== v) {
      cfg[k] = v;
      changed = true;
    }
  }
  if (changed) {
    if ('maxKBps' in next) resetBucket();
    wake(throttleWaiters);
    wake(slotWaiters);
    emitStats();
  }
  return getConfig();
}

async function readSettings() {
  try {
    // Perezoso y sin ciclos: settings no depende de este modulo.
    const settings = require('./settings');
    const s = await settings.get();
    configure(s.downloads);
    settings.onChange((all) => configure(all?.downloads));
    cfgReady = true;
  } catch {
    // Todavia no hay carpeta de datos (por ejemplo, scripts de Node): valores por defecto.
    cfgRetryAt = Date.now() + 5000;
  }
}

// Lee settings.downloads la primera vez que hace falta.
async function loadSettings() {
  if (cfgReady) return getConfig();
  if (!cfgLoading && Date.now() >= cfgRetryAt) {
    cfgLoading = readSettings().finally(() => {
      cfgLoading = null;
    });
  }
  if (cfgLoading) await cfgLoading;
  return getConfig();
}

// ---------- Esperas que se pueden despertar o cancelar ----------
const pauseWaiters = new Set();
const slotWaiters = new Set();
const throttleWaiters = new Set();
const sleepers = new Set();

function wake(set) {
  for (const fn of [...set]) fn();
}

function cancelled(signal) {
  return signal?.reason || new Error(t('storage.errCancelled'));
}

// Espera ms (Infinity = hasta que despierten al grupo) o hasta que se cancele la señal.
function nap(ms, set, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled(signal));
      return;
    }
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      set.delete(onWake);
      signal?.removeEventListener('abort', onAbort);
    };
    const onWake = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(cancelled(signal));
    };
    set.add(onWake);
    if (Number.isFinite(ms)) timer = setTimeout(onWake, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function pauseMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Pausa global ----------
const state = { paused: false, pausedAt: 0 };

function pause() {
  if (state.paused) return false;
  state.paused = true;
  state.pausedAt = Date.now();
  emitStats();
  return true;
}

function resume() {
  if (!state.paused) return false;
  state.paused = false;
  state.pausedAt = 0;
  resetBucket();
  wake(pauseWaiters);
  emitStats();
  return true;
}

async function waitIfPaused(signal) {
  while (state.paused) await nap(Infinity, pauseWaiters, signal);
}

// ---------- Descargas simultaneas (cupo global) ----------
let activeSlots = 0;
let queuedSlots = 0;

function slotLimit() {
  return cfg.concurrency > 0 ? cfg.concurrency : Infinity;
}

async function acquireSlot(signal) {
  queuedSlots++;
  try {
    for (;;) {
      await waitIfPaused(signal);
      if (activeSlots < slotLimit()) break;
      await nap(Infinity, slotWaiters, signal);
    }
  } finally {
    queuedSlots--;
  }
  activeSlots++;
}

function releaseSlot() {
  activeSlots = Math.max(0, activeSlots - 1);
  wake(slotWaiters);
}

// ---------- Limite de ancho de banda (balde de fichas compartido) ----------
// Cada bloque recibido "gasta" sus bytes; si el balde queda en deuda, esa descarga espera lo justo
// para devolverla. Como todas comparten el balde, la suma de todas respeta el limite.
const bucket = { tokens: 0, last: 0 };

function resetBucket() {
  bucket.tokens = 0;
  bucket.last = 0;
}

function rateBps() {
  return cfg.maxKBps > 0 ? cfg.maxKBps * 1024 : 0;
}

async function throttle(n, signal) {
  for (;;) {
    await waitIfPaused(signal);
    const rate = rateBps();
    if (!rate) return;
    const now = performance.now();
    const burst = Math.max(16 * 1024, rate / 4);
    if (!bucket.last) bucket.last = now;
    bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.last) / 1000) * rate);
    bucket.last = now;
    if (bucket.tokens > 0) {
      bucket.tokens -= n;
      if (bucket.tokens < 0) await nap((-bucket.tokens / rate) * 1000, throttleWaiters, signal);
      return;
    }
    await nap((-bucket.tokens / rate) * 1000 + 2, throttleWaiters, signal);
  }
}

// ---------- Modo sin conexion ----------
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url).slice(0, 80);
  }
}

// Direcciones de la propia PC o de la red local (siguen funcionando en modo sin conexion).
function isLocalUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || /\.(localhost|local|lan|home\.arpa)$/.test(host)) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(host)) {
    if (host === '::1' || host === '::') return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isLocalUrl(`http://${mapped[1]}/`);
    return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  }
  return false;
}

function offlineError(url) {
  return Object.assign(new Error(t('storage.errOffline', { host: hostOf(url) })), { code: 'offline', offline: true, retryable: false });
}

function isOffline() {
  return cfg.offline;
}

// ---------- Estadisticas en vivo ----------
const counters = { sessionBytes: 0, sessionFiles: 0, resumed: 0, retries: 0, failed: 0, peak: 0 };
const jobs = new Map(); // id -> { name, part, received, total, resumedFrom }
let jobSeq = 0;
const history = [];
let tickBytes = 0;
let tickTimer = null;
let idleTicks = 0;
let lastTickAt = 0;

function startJob(target, item) {
  const job = { id: ++jobSeq, name: path.basename(target), part: `${target}.part`, received: 0, total: item.size || 0, resumedFrom: 0 };
  jobs.set(job.id, job);
  ensureTicker();
  return job;
}

function endJob(job) {
  jobs.delete(job.id);
}

function countBytes(n) {
  tickBytes += n;
  counters.sessionBytes += n;
}

function ensureTicker() {
  idleTicks = 0;
  if (tickTimer) return;
  // Si estuvo quieto, el historial registra esos segundos sin descargas.
  if (lastTickAt) {
    const gap = Math.min(HISTORY, Math.floor((Date.now() - lastTickAt) / 1000) - 1);
    for (let i = 0; i < gap; i++) history.push(0);
    while (history.length > HISTORY) history.shift();
  }
  tickTimer = setInterval(tick, 1000);
  tickTimer.unref?.();
}

function tick() {
  history.push(tickBytes);
  while (history.length > HISTORY) history.shift();
  if (tickBytes > counters.peak) counters.peak = tickBytes;
  tickBytes = 0;
  lastTickAt = Date.now();
  if (!jobs.size && !queuedSlots) {
    idleTicks++;
    if (idleTicks >= 3) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  } else idleTicks = 0;
  emitStats();
}

function currentSpeed() {
  const last = history.slice(-SPEED_WINDOW);
  // En pausa no entra nada: se muestra 0 aunque el promedio todavia arrastre los segundos anteriores.
  if (!last.length || state.paused || (!jobs.size && idleTicks >= 3)) return 0;
  return last.reduce((a, b) => a + b, 0) / last.length;
}

function snapshot() {
  const hist = history.slice(-HISTORY);
  while (hist.length < HISTORY) hist.unshift(0);
  return {
    active: jobs.size,
    queued: queuedSlots,
    paused: state.paused,
    pausedAt: state.pausedAt || null,
    offline: cfg.offline,
    maxKBps: cfg.maxKBps,
    concurrency: cfg.concurrency,
    defaultConcurrency: DEFAULT_CONCURRENCY,
    speed: Math.round(currentSpeed()),
    peak: counters.peak,
    sessionBytes: counters.sessionBytes,
    sessionFiles: counters.sessionFiles,
    resumed: counters.resumed,
    retries: counters.retries,
    failed: counters.failed,
    history: hist,
    current: [...jobs.values()].slice(-8).map((j) => ({ name: j.name, received: j.received, total: j.total, resumed: j.resumedFrom > 0 })),
    at: Date.now(),
  };
}

let emitQueued = false;
function emitStats() {
  if (emitQueued) return;
  emitQueued = true;
  setImmediate(() => {
    emitQueued = false;
    try {
      events.emit('stats', snapshot());
    } catch (err) {
      console.error('[storage] stats', err);
    }
  });
}

// Rutas .part que se estan escribiendo ahora (la limpieza no las toca).
function activeParts() {
  return new Set([...jobs.values()].map((j) => j.part));
}

// ---------- Pedidos ----------
function idleTimer(signal, ms = IDLE_TIMEOUT, url = '') {
  const ctrl = new AbortController();
  const combined = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  let timer = null;
  const fire = () => ctrl.abort(Object.assign(new Error(t('storage.errTimeout', { host: hostOf(url) })), { code: 'timeout', retryable: true }));
  const reset = () => {
    clearTimeout(timer);
    if (!ctrl.signal.aborted) timer = setTimeout(fire, ms);
  };
  const clear = () => clearTimeout(timer);
  reset();
  return { signal: combined, reset, clear };
}

function retryAfterMs(res) {
  const h = res.headers.get('retry-after');
  if (!h) return 0;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : 0;
}

// Espera exponencial con azar (entre 0,5x y 1,5x) para no reintentar todos a la vez.
function backoffDelay(attempt, retryAfter) {
  if (retryAfter > 0) return Math.min(retryAfter, 60000) + Math.random() * 500;
  const base = Math.min(15000, 500 * 2 ** Math.max(0, attempt));
  return base / 2 + Math.random() * base;
}

function netError(err, url, idle) {
  const reason = idle?.signal?.aborted ? idle.signal.reason : null;
  if (reason?.code === 'timeout') return reason;
  if (err?.code === 'timeout' || err?.code === 'offline') return err;
  const cause = err?.cause;
  const code = cause?.code || err?.code || '';
  const detail = code || cause?.message || err?.message || String(err);
  return Object.assign(new Error(t('storage.errNetwork', { host: hostOf(url), error: detail })), { code: code || 'network', retryable: true, cause: err });
}

async function httpError(res, url) {
  const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
  let body = '';
  if (retryable) res.body?.cancel().catch(() => {});
  else body = await res.text().catch(() => '');
  const message = body ? t('storage.errHttpBody', { status: res.status, url, body: body.slice(0, 200) }) : t('storage.errHttp', { status: res.status, url });
  const err = Object.assign(new Error(message), { status: res.status, retryable, retryAfter: retryAfterMs(res) });
  if (!retryable) err.body = body;
  return err;
}

async function fetchOnce(url, init, signal) {
  const idle = idleTimer(signal, IDLE_TIMEOUT, url);
  try {
    const res = await fetch(url, {
      ...init,
      redirect: 'follow',
      signal: idle.signal,
      headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) },
    });
    return { res, idle };
  } catch (err) {
    idle.clear();
    if (signal?.aborted) throw cancelled(signal);
    throw netError(err, url, idle);
  }
}

// Devuelve { res, idle } con la respuesta ya verificada (2xx). Igual que siempre: los errores traen .status.
async function request(url, init = {}, { retries = 3, signal } = {}) {
  await loadSettings();
  if (cfg.offline && !isLocalUrl(url)) throw offlineError(url);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let idle = null;
    try {
      const r = await fetchOnce(url, init, signal);
      idle = r.idle;
      if (!r.res.ok) throw await httpError(r.res, url);
      idle.clear();
      return { res: r.res, idle };
    } catch (err) {
      idle?.clear();
      if (signal?.aborted) throw cancelled(signal);
      lastErr = err;
      const retryable = err.retryable || (!err.status && err.code !== 'offline');
      if (!retryable || attempt === retries) break;
      await nap(backoffDelay(attempt, err.retryAfter), sleepers, signal);
    }
  }
  throw lastErr;
}

// Lee todo el cuerpo cortando si pasan 30 s sin datos.
async function readBody(res, idle, url, signal) {
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  idle.reset();
  try {
    for await (const chunk of res.body) {
      idle.reset();
      chunks.push(chunk);
      size += chunk.length;
    }
  } catch (err) {
    if (signal?.aborted) throw cancelled(signal);
    throw netError(err, url, idle);
  } finally {
    idle.clear();
  }
  return Buffer.concat(chunks, size);
}

// Pedido + lectura del cuerpo con reintentos (tambien si la conexion se corta a mitad del cuerpo).
async function fetchBody(url, init, { retries = 3, signal } = {}, parse) {
  await loadSettings();
  if (cfg.offline && !isLocalUrl(url)) throw offlineError(url);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let idle = null;
    try {
      const r = await fetchOnce(url, init, signal);
      idle = r.idle;
      if (!r.res.ok) throw await httpError(r.res, url);
      const buf = await readBody(r.res, idle, url, signal);
      try {
        return parse(buf, r.res);
      } catch (err) {
        err.retryable = false;
        throw err;
      }
    } catch (err) {
      idle?.clear();
      if (signal?.aborted) throw cancelled(signal);
      lastErr = err;
      const retryable = err.retryable !== false && (err.retryable || (!err.status && err.code !== 'offline'));
      if (!retryable || attempt === retries) break;
      await nap(backoffDelay(attempt, err.retryAfter), sleepers, signal);
    }
  }
  throw lastErr;
}

const utf8 = new TextDecoder('utf-8');

// JSON de una respuesta. Si el servidor manda otra cosa (una pagina de error, un portal cautivo), el error
// sale traducido en lugar del "Unexpected token <" de JSON.parse.
function parseJson(buf, url) {
  try {
    return JSON.parse(utf8.decode(buf));
  } catch (err) {
    throw Object.assign(new Error(t('storage.errBadJson', { host: hostOf(url) })), { code: 'badjson', cause: err });
  }
}

// cacheFile + cacheMaxAge: usa la copia guardada si es reciente. Sin internet (o en modo sin conexion)
// devuelve la ultima copia guardada aunque sea vieja.
async function getJson(url, { headers, cacheFile, cacheMaxAge = 0, retries = 3, method, body, signal } = {}) {
  await loadSettings();
  if (cacheFile && cacheMaxAge > 0) {
    try {
      const st = await fsp.stat(cacheFile);
      if (Date.now() - st.mtimeMs < cacheMaxAge) return await readJson(cacheFile);
    } catch {
      /* sin cache */
    }
  }
  if (cfg.offline && !isLocalUrl(url)) {
    if (cacheFile) {
      const cached = await readJson(cacheFile, null);
      if (cached !== null) return cached;
    }
    throw offlineError(url);
  }
  try {
    const init = { headers: { Accept: 'application/json', ...(headers || {}) } };
    if (method) init.method = method;
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (typeof body !== 'string') init.headers['Content-Type'] = 'application/json';
    }
    const data = await fetchBody(url, init, { retries, signal }, (buf) => parseJson(buf, url));
    if (cacheFile) await writeJson(cacheFile, data).catch(() => {});
    return data;
  } catch (err) {
    // Sin internet: usar la ultima copia guardada si existe.
    if (cacheFile && !signal?.aborted) {
      const cached = await readJson(cacheFile, null);
      if (cached !== null) return cached;
    }
    throw err;
  }
}

async function getText(url, { headers, retries = 3, signal } = {}) {
  return fetchBody(url, { headers }, { retries, signal }, (buf) => utf8.decode(buf));
}

async function getBuffer(url, { headers, retries = 3, signal } = {}) {
  return fetchBody(url, { headers }, { retries, signal }, (buf) => buf);
}

// ---------- Archivos ----------
// Verifica si el archivo existente es valido. mode: 'size' (rapido) | 'hash' (completo)
async function isValid(file, { sha1, size, sha256, sha512 }, mode = 'size') {
  const s = await fileSize(file);
  if (s < 0) return false;
  if (size && s !== size) return false;
  if (mode === 'hash') {
    if (sha1) return (await hashFile(file, 'sha1')) === sha1.toLowerCase();
    if (sha512) return (await hashFile(file, 'sha512')) === sha512.toLowerCase();
    if (sha256) return (await hashFile(file, 'sha256')) === sha256.toLowerCase();
  }
  return s > 0 || size === 0;
}

const HASH_ALGOS = ['sha1', 'sha256', 'sha512'];

function makeHashers(item) {
  return HASH_ALGOS.filter((a) => item[a]).map((algo) => ({ algo, hash: crypto.createHash(algo), want: String(item[algo]).toLowerCase() }));
}

function hasHash(item) {
  return HASH_ALGOS.some((a) => item[a]);
}

// Validadores del servidor por cada .part de esta sesion (para retomar con If-Range sin archivos extra).
const partMeta = new Map(); // ruta .part -> { url, etag, lastModified, ranges }

function strongValidator(meta) {
  if (!meta) return null;
  if (meta.etag && !/^W\//i.test(meta.etag)) return meta.etag;
  return meta.lastModified || null;
}

function parseContentRange(h) {
  const m = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/i.exec(String(h || '').trim());
  if (!m) return null;
  return {
    start: m[1] === undefined ? null : Number(m[1]),
    end: m[2] === undefined ? null : Number(m[2]),
    total: m[3] === '*' ? null : Number(m[3]),
  };
}

async function removeQuiet(p) {
  await fsp.rm(p, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}

async function closeStream(out) {
  if (!out || out.closed) return;
  out.destroy();
  if (!out.closed) await once(out, 'close').catch(() => {});
}

// Cuanto de la parte ya bajada se puede reutilizar (0 = empezar de cero).
async function resumeOffset(url, item, part) {
  let st;
  try {
    st = await fsp.stat(part);
  } catch {
    partMeta.delete(part);
    return 0;
  }
  const known = partMeta.get(part);
  const usable =
    st.isFile() &&
    st.size > 0 &&
    !(item.size && st.size > item.size) &&
    !(known && known.url === url && known.ranges === false) &&
    // Con hash el resultado se verifica al final; sin hash solo dentro de esta sesion y con validador del servidor.
    (hasHash(item) || (known && known.url === url && strongValidator(known)));
  if (usable) return st.size;
  await removeQuiet(part);
  partMeta.delete(part);
  return 0;
}

async function verifyFile(file, item, total) {
  const s = await fileSize(file);
  if (s < 0) return false;
  if (item.size && s !== item.size) return false;
  if (total && s !== total) return false;
  for (const algo of HASH_ALGOS) {
    if (item[algo] && (await hashFile(file, algo)) !== String(item[algo]).toLowerCase()) return false;
  }
  return true;
}

async function hashPrefix(file, length, hashers) {
  if (!hashers.length || length <= 0) return;
  const stream = fs.createReadStream(file, { start: 0, end: length - 1, highWaterMark: 1 << 20 });
  for await (const chunk of stream) for (const h of hashers) h.hash.update(chunk);
}

// Renombrado atomico. En Windows un antivirus puede tener el archivo abierto un instante: se reintenta.
async function finalize(part, target) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(part, target);
      return;
    } catch (err) {
      const transient = ['EPERM', 'EACCES', 'EBUSY'].includes(err.code);
      if (!transient) throw err;
      if (i >= 5) {
        // Ultimo recurso (como antes): borrar el destino y renombrar.
        await fsp.rm(target, { force: true }).catch(() => {});
        await fsp.rename(part, target);
        return;
      }
      await pauseMs(80 * 2 ** i);
    }
  }
}

function integrityError(key, name, vars = {}) {
  return Object.assign(new Error(t(key, { name, ...vars })), { integrity: true, retryable: true });
}

// Errores del disco al guardar una descarga (sin espacio, sin permiso, archivo en uso...): Node los da en
// ingles ("ENOSPC: no space left on device, write"). Se traducen conservando code, syscall y path.
function diskError(err, name) {
  if (!err || !err.syscall || err.localized) return err;
  const key = err.code === 'ENOSPC' ? 'storage.errNoSpace' : ['EPERM', 'EACCES', 'EBUSY', 'EROFS'].includes(err.code) ? 'storage.errDiskAccess' : 'storage.errDisk';
  return Object.assign(new Error(t(key, { name, error: err.code || err.message })), {
    code: err.code,
    syscall: err.syscall,
    path: err.path,
    retryable: false,
    localized: true,
    cause: err,
  });
}

// Un intento contra una URL: retoma la parte si se puede, escribe, verifica y renombra.
async function attemptOnce(url, item, target, part, ctx) {
  await acquireSlot(ctx.signal);
  const job = startJob(target, item);
  const name = path.basename(target);
  let idle = null;
  let out = null;
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    let start = await resumeOffset(url, item, part);

    // La parte ya estaba completa (por ejemplo, se corto justo antes de renombrar).
    if (start > 0 && item.size && start === item.size) {
      if (await verifyFile(part, item)) {
        await finalize(part, target);
        partMeta.delete(part);
        ctx.report(start);
        counters.sessionFiles++;
        return { resumed: true, bytes: 0 };
      }
      await removeQuiet(part);
      start = 0;
    }

    const headers = { 'Accept-Encoding': 'identity' };
    if (start > 0) {
      headers.Range = `bytes=${start}-`;
      const known = partMeta.get(part);
      const validator = known && known.url === url ? strongValidator(known) : null;
      if (validator) headers['If-Range'] = validator;
    }
    const r = await fetchOnce(url, { headers }, ctx.signal);
    idle = r.idle;
    const res = r.res;

    // 416: lo pedido no existe. Si la parte ya tiene todo el archivo, alcanza con verificarla.
    if (res.status === 416 && start > 0) {
      const cr = parseContentRange(res.headers.get('content-range'));
      res.body?.cancel().catch(() => {});
      if (cr?.total === start && (await verifyFile(part, item, start))) {
        await finalize(part, target);
        partMeta.delete(part);
        ctx.report(start);
        counters.sessionFiles++;
        return { resumed: true, bytes: 0 };
      }
      await removeQuiet(part);
      partMeta.delete(part);
      ctx.report(0);
      throw Object.assign(new Error(t('storage.errRange', { name })), { retryable: true, progress: true });
    }
    if (!res.ok) throw await httpError(res, url);

    const encoding = (res.headers.get('content-encoding') || 'identity').toLowerCase();
    const encoded = encoding !== 'identity';
    let total = null;
    if (res.status === 206 && start > 0) {
      const cr = parseContentRange(res.headers.get('content-range'));
      if (!cr || cr.start !== start || encoded) {
        // Respuesta parcial que no sirve para continuar: se descarta lo bajado y se empieza de nuevo.
        res.body?.cancel().catch(() => {});
        await removeQuiet(part);
        partMeta.delete(part);
        ctx.report(0);
        throw Object.assign(new Error(t('storage.errRange', { name })), { retryable: true, progress: true });
      }
      total = cr.total;
      job.resumedFrom = start;
      counters.resumed++;
    } else {
      // 200: el servidor manda el archivo completo (no acepta Range o el archivo cambio).
      start = 0;
      const len = res.headers.get('content-length');
      if (!encoded && len !== null && /^\d+$/.test(len)) total = Number(len);
      const acceptRanges = (res.headers.get('accept-ranges') || '').toLowerCase();
      partMeta.set(part, { url, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), ranges: acceptRanges !== 'none' && !encoded });
    }
    if (item.size && total !== null && total !== item.size) {
      res.body?.cancel().catch(() => {});
      await removeQuiet(part);
      partMeta.delete(part);
      throw Object.assign(new Error(t('storage.errSize', { name })), { retryable: false });
    }

    job.total = total || item.size || 0;
    const hashers = makeHashers(item);
    if (start > 0) await hashPrefix(part, start, hashers);
    out = fs.createWriteStream(part, start > 0 ? { flags: 'r+', start } : { flags: 'w' });
    let writeErr = null;
    out.on('error', (e) => {
      writeErr = writeErr || e;
    });
    await once(out, 'open');
    // Se puede retomar despues si el resultado se verifica con hash o el servidor dio un validador.
    const resumable = !encoded && (hashers.length > 0 || Boolean(strongValidator(partMeta.get(part))));

    let received = start;
    job.received = received;
    ctx.report(received);
    try {
      if (res.body) {
        idle.reset();
        for await (const chunk of res.body) {
          idle.clear();
          if (writeErr) throw writeErr;
          for (const h of hashers) h.hash.update(chunk);
          if (!out.write(chunk)) await once(out, 'drain');
          // Cuenta y limita en porciones chicas: la velocidad queda pareja aunque lleguen bloques grandes.
          for (let off = 0; off < chunk.length; off += SLICE) {
            const n = Math.min(SLICE, chunk.length - off);
            received += n;
            job.received = received;
            ctx.report(received);
            countBytes(n);
            await throttle(n, ctx.signal); // tambien espera mientras las descargas estan en pausa
          }
          idle.reset();
        }
      }
      idle.clear();
      if (writeErr) throw writeErr;
      out.end();
      await finished(out);
      if (!out.closed) await once(out, 'close');
    } catch (err) {
      idle.clear();
      await closeStream(out);
      if (!resumable) {
        await removeQuiet(part);
        partMeta.delete(part);
        ctx.report(0);
      }
      if (ctx.signal?.aborted) throw cancelled(ctx.signal);
      // Error del disco (sin espacio, sin permiso): no tiene sentido reintentar.
      if (err === writeErr || (err?.syscall && !err?.cause)) throw Object.assign(err, { retryable: false });
      const e = netError(err, url, idle);
      e.progress = received - start >= PROGRESS_RESET;
      throw e;
    }

    // Verificacion final antes de darle el nombre definitivo.
    if ((total !== null && received !== total) || (item.size && received !== item.size)) {
      await removeQuiet(part);
      partMeta.delete(part);
      ctx.report(0);
      throw integrityError('storage.errSize', name);
    }
    for (const h of hashers) {
      if (h.hash.digest('hex') !== h.want) {
        await removeQuiet(part);
        partMeta.delete(part);
        ctx.report(0);
        throw integrityError('storage.errHash', name, { algo: h.algo });
      }
    }
    await finalize(part, target);
    partMeta.delete(part);
    counters.sessionFiles++;
    return { resumed: start > 0, bytes: received - start };
  } finally {
    idle?.clear();
    await closeStream(out);
    endJob(job);
    releaseSlot();
  }
}

// Reintentos contra una URL: cada corte retoma desde donde quedo; los intentos que avanzan no se gastan.
async function downloadFrom(url, item, target, ctx) {
  const part = `${target}.part`;
  let streak = 0;
  let integrity = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptOnce(url, item, target, part, ctx);
    } catch (err) {
      if (ctx.signal?.aborted) throw cancelled(ctx.signal);
      if (err.integrity && ++integrity > 1) throw err; // hash o tamaño: se prueba una sola vez mas desde cero
      if (err.syscall && err.retryable === undefined) throw err; // error del disco
      streak = err.progress ? 0 : streak + 1;
      const retryable = err.retryable !== false && (err.retryable || !err.status) && err.code !== 'offline';
      if (!retryable || streak >= DOWNLOAD_RETRIES || attempt >= MAX_ATTEMPTS) throw err;
      if (cfg.offline && !isLocalUrl(url)) throw offlineError(url);
      counters.retries++;
      await nap(err.progress ? 300 + Math.random() * 700 : backoffDelay(streak - 1, err.retryAfter), sleepers, ctx.signal);
    }
  }
}

// Evita que dos descargas escriban el mismo archivo a la vez (la segunda espera y despues lo reutiliza).
const pathLocks = new Map();
async function withPathLock(target, fn) {
  const key = process.platform === 'win32' ? target.toLowerCase() : target;
  while (pathLocks.has(key)) await pathLocks.get(key);
  let release;
  pathLocks.set(key, new Promise((r) => (release = r)));
  try {
    return await fn();
  } finally {
    pathLocks.delete(key);
    release();
  }
}

// item: { url | urls, path, sha1?, sha256?, sha512?, size?, force? }
// Devuelve { skipped } (como siempre) y ademas { resumed, bytes }.
async function download(item, { onBytes, verify = 'size', signal } = {}) {
  await loadSettings();
  const target = path.resolve(item.path);
  const name = path.basename(target);
  return withPathLock(target, async () => {
    try {
      if (!item.force && (await isValid(target, item, verify))) return { skipped: true };
    } catch (err) {
      throw diskError(err, name);
    }
    const urls = (item.urls || [item.url]).filter(Boolean);
    if (!urls.length) throw new Error(t('storage.errNoUrl', { name }));
    let reported = 0;
    const report = (n) => {
      if (n === reported) return;
      const delta = n - reported;
      reported = n;
      if (onBytes) onBytes(delta);
    };
    let lastErr = null;
    for (const url of urls) {
      if (cfg.offline && !isLocalUrl(url)) {
        lastErr = lastErr || offlineError(url);
        continue;
      }
      try {
        const r = await downloadFrom(url, item, target, { report, signal });
        return { skipped: false, resumed: r.resumed, bytes: r.bytes };
      } catch (err) {
        if (signal?.aborted) {
          report(0);
          throw cancelled(signal);
        }
        lastErr = err;
      }
    }
    report(0);
    counters.failed++;
    emitStats();
    throw diskError(lastErr, name);
  });
}

// Descarga muchos archivos en paralelo. onProgress({done,total,bytes,totalBytes})
// concurrency: la que pida quien llama (o la de los ajustes); el cupo global de los ajustes manda siempre.
async function downloadAll(items, { concurrency, onProgress, verify = 'size', signal } = {}) {
  await loadSettings();
  const total = items.length;
  const totalBytes = items.reduce((a, i) => a + (i.size || 0), 0);
  let done = 0;
  let bytes = 0;
  let index = 0;
  let lastReport = 0;
  const errors = [];
  const report = (force) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReport < 250) return;
    lastReport = now;
    onProgress({ done, total, bytes: Math.max(0, bytes), totalBytes });
  };
  const wanted = Number(concurrency) > 0 ? Math.round(Number(concurrency)) : cfg.concurrency > 0 ? cfg.concurrency : DEFAULT_CONCURRENCY;
  const workers = Math.max(1, Math.min(wanted, cfg.concurrency > 0 ? cfg.concurrency : wanted, items.length || 1));
  async function worker() {
    while (index < items.length) {
      if (signal?.aborted) return;
      const item = items[index++];
      try {
        const r = await download(item, {
          verify,
          signal,
          onBytes: (n) => {
            bytes += n;
            report(false);
          },
        });
        if (r.skipped) bytes += item.size || 0;
      } catch (err) {
        errors.push({ item, err });
      }
      done++;
      report(true);
    }
  }
  report(true);
  await Promise.all(Array.from({ length: workers }, worker));
  if (signal?.aborted) throw cancelled(signal);
  if (errors.length) {
    const first = errors[0];
    const err = new Error(t('storage.errSomeFailed', { count: errors.length, name: path.basename(first.item.path), error: first.err.message }));
    err.failures = errors;
    throw err;
  }
}

module.exports = {
  setUserAgent,
  getUserAgent: () => USER_AGENT,
  request,
  getJson,
  getText,
  getBuffer,
  download,
  downloadAll,
  isValid,
  // Nuevo: control y estado de las descargas
  loadSettings,
  configure,
  getConfig,
  pause,
  resume,
  isPaused: () => state.paused,
  isOffline,
  isLocalUrl,
  stats: snapshot,
  activeParts,
  events,
};
