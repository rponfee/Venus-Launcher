'use strict';
// Datos del modulo:
//   <instancia>/.venus/modtranslate/<idioma>.json  -> traducciones de esa instancia (con el original y si
//                                                    el jugador las reviso). De aca se arma el paquete.
//   data/modtranslate-cache.json                    -> cache global (mod, texto original, idioma) -> traduccion,
//                                                    para no volver a pedirle a la IA lo que ya se tradujo.
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../../core/paths');
const { readJson, writeJson } = require('../../core/util');

const STATE_VERSION = 1;
const CACHE_VERSION = 1;
const CACHE_MAX_ENTRIES = 400000;
const CACHE_FLUSH_MS = 2500;

// ---------- Estado por instancia ----------

function stateDir(instanceDir) {
  return path.join(instanceDir, '.venus', 'modtranslate');
}

function statePath(instanceDir, locale) {
  return path.join(stateDir(instanceDir), `${locale}.json`);
}

function emptyState(locale) {
  return { v: STATE_VERSION, locale, updatedAt: 0, entries: {} };
}

async function loadState(instanceDir, locale) {
  const data = await readJson(statePath(instanceDir, locale), null);
  if (!data || data.v !== STATE_VERSION || typeof data.entries !== 'object' || !data.entries) return emptyState(locale);
  return { ...data, locale };
}

// Escrituras en serie por archivo (la tarea de traduccion y el editor pueden guardar a la vez).
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

// Estados "vivos": la tarea de traduccion y el editor modifican el MISMO objeto en memoria y se
// guarda en disco con una pequenia demora (asi nadie pisa los cambios del otro).
const LIVE_MAX = 6;
const SAVE_DELAY = 1200;
const live = new Map(); // archivo -> { state, timer, dirty }

async function acquire(instanceDir, locale) {
  const file = statePath(instanceDir, locale);
  let rec = live.get(file);
  if (!rec) {
    rec = { state: await loadState(instanceDir, locale), timer: null, dirty: false, dir: instanceDir };
    // Otro pedido pudo cargarlo mientras se leia el disco
    if (live.has(file)) rec = live.get(file);
    else live.set(file, rec);
  } else {
    live.delete(file);
    live.set(file, rec);
  }
  while (live.size > LIVE_MAX) {
    const [oldFile, old] = live.entries().next().value;
    live.delete(oldFile);
    if (old.dirty) writeLive(oldFile, old).catch((err) => console.warn('[modtranslate] estado:', err.message));
  }
  return rec.state;
}

function writeLive(file, rec) {
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = null;
  rec.dirty = false;
  rec.state.updatedAt = Date.now();
  const snapshot = JSON.parse(JSON.stringify(rec.state));
  return withLock(file, () => writeJson(file, snapshot));
}

// Marca cambios en un estado vivo; se escribe enseguida o con demora.
function touch(instanceDir, locale, { now = false } = {}) {
  const file = statePath(instanceDir, locale);
  const rec = live.get(file);
  if (!rec) return Promise.resolve();
  rec.dirty = true;
  if (now) return writeLive(file, rec);
  if (!rec.timer) {
    rec.timer = setTimeout(() => {
      writeLive(file, rec).catch((err) => console.warn('[modtranslate] estado:', err.message));
    }, SAVE_DELAY);
    rec.timer.unref?.();
  }
  return Promise.resolve();
}

async function flushAll() {
  await Promise.all([...live.entries()].filter(([, rec]) => rec.dirty).map(([file, rec]) => writeLive(file, rec)));
}

async function removeState(instanceDir, locale) {
  const file = statePath(instanceDir, locale);
  const rec = live.get(file);
  if (rec?.timer) clearTimeout(rec.timer);
  live.delete(file);
  return withLock(file, () => fsp.rm(file, { force: true }));
}

// Resumen de los idiomas que ya tienen traducciones en la instancia.
async function listStates(instanceDir) {
  const files = await fsp.readdir(stateDir(instanceDir)).catch(() => []);
  const out = [];
  for (const f of files) {
    const m = /^([a-z]{2,3}_[a-z]{2,4})\.json$/.exec(f);
    if (!m) continue;
    const rec = live.get(statePath(instanceDir, m[1]));
    const st = rec ? rec.state : await loadState(instanceDir, m[1]);
    let entries = 0;
    let reviewed = 0;
    for (const keys of Object.values(st.entries)) {
      for (const e of Object.values(keys)) {
        if (typeof e?.t !== 'string') continue;
        entries++;
        if (e.r) reviewed++;
      }
    }
    if (entries) out.push({ locale: m[1], entries, reviewed, updatedAt: st.updatedAt || 0 });
  }
  return out;
}

function countEntries(state) {
  let n = 0;
  for (const keys of Object.values(state.entries || {})) for (const e of Object.values(keys)) if (typeof e?.t === 'string') n++;
  return n;
}

// ---------- Cache global ----------

const hash = (text) => crypto.createHash('sha1').update(String(text)).digest('base64url').slice(0, 16);

let cache = null;
let cacheLoading = null;
let cacheDirty = false;
let cacheTimer = null;
let cacheFile = null;
let cacheCount = 0;

function cachePath() {
  return paths.data('modtranslate-cache.json');
}

async function loadCache() {
  const file = cachePath();
  if (cache && cacheFile === file) return cache;
  if (cacheLoading && cacheFile === file) return cacheLoading;
  cacheFile = file;
  cacheLoading = readJson(file, null).then((data) => {
    cache = data && data.v === CACHE_VERSION && data.locales && typeof data.locales === 'object' ? data : { v: CACHE_VERSION, locales: {} };
    cacheCount = 0;
    for (const scopes of Object.values(cache.locales)) for (const items of Object.values(scopes || {})) cacheCount += Object.keys(items || {}).length;
    cacheLoading = null;
    return cache;
  });
  return cacheLoading;
}

// Devuelve { t, r } o null. scope = namespace del mod (identifica al mod dentro de los archivos de idioma).
async function cacheGet(locale, scope, source) {
  const c = await loadCache();
  const hit = c.locales[locale]?.[scope]?.[hash(source)];
  return Array.isArray(hit) && typeof hit[0] === 'string' ? { t: hit[0], r: Boolean(hit[1]) } : null;
}

// Version sincronica para recorridos grandes (llamar antes a loadCache()).
function cacheGetSync(locale, scope, source) {
  const hit = cache?.locales[locale]?.[scope]?.[hash(source)];
  return Array.isArray(hit) && typeof hit[0] === 'string' ? { t: hit[0], r: Boolean(hit[1]) } : null;
}

async function cacheSet(locale, scope, source, text, reviewed = false) {
  const c = await loadCache();
  const byLocale = (c.locales[locale] = c.locales[locale] || {});
  const byScope = (byLocale[scope] = byLocale[scope] || {});
  const k = hash(source);
  const prev = byScope[k];
  // Una traduccion revisada por una persona no se pisa con una automatica.
  if (Array.isArray(prev) && prev[1] && !reviewed && prev[0] !== text) return;
  if (!prev) cacheCount++;
  byScope[k] = [text, reviewed ? 1 : 0, Math.floor(Date.now() / 1000)];
  cacheDirty = true;
  scheduleFlush();
}

function scheduleFlush() {
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = null;
    flushCache().catch((err) => console.warn('[modtranslate] cache:', err.message));
  }, CACHE_FLUSH_MS);
  cacheTimer.unref?.();
}

function prune(c) {
  if (cacheCount <= CACHE_MAX_ENTRIES) return;
  const all = [];
  for (const [loc, scopes] of Object.entries(c.locales)) {
    for (const [scope, items] of Object.entries(scopes)) for (const [k, v] of Object.entries(items)) all.push([loc, scope, k, v?.[2] || 0, v?.[1] ? 1 : 0]);
  }
  if (all.length <= CACHE_MAX_ENTRIES) return;
  // Se van primero las automaticas mas viejas.
  all.sort((a, b) => a[4] - b[4] || a[3] - b[3]);
  // Margen del 10% para no podar en cada guardado
  const drop = all.length - Math.floor(CACHE_MAX_ENTRIES * 0.9);
  for (const [loc, scope, k] of all.slice(0, drop)) {
    delete c.locales[loc][scope][k];
    if (!Object.keys(c.locales[loc][scope]).length) delete c.locales[loc][scope];
  }
  cacheCount = all.length - Math.max(0, drop);
}

// La cache puede tener cientos de miles de textos: se guarda compacta (sin sangria) y de forma atomica.
async function writeCompact(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

async function flushCache() {
  if (cacheTimer) {
    clearTimeout(cacheTimer);
    cacheTimer = null;
  }
  if (!cache || !cacheDirty) return;
  cacheDirty = false;
  prune(cache);
  const file = cacheFile || cachePath();
  await withLock(file, () => writeCompact(file, cache));
}

function resetCacheForTests() {
  cache = null;
  cacheLoading = null;
  cacheDirty = false;
  cacheFile = null;
  cacheCount = 0;
  if (cacheTimer) clearTimeout(cacheTimer);
  cacheTimer = null;
}

function resetLiveForTests() {
  for (const rec of live.values()) if (rec.timer) clearTimeout(rec.timer);
  live.clear();
}

module.exports = {
  stateDir,
  statePath,
  loadState,
  acquire,
  touch,
  flushAll,
  resetLiveForTests,
  removeState,
  listStates,
  countEntries,
  emptyState,
  loadCache,
  cacheGet,
  cacheGetSync,
  cacheSet,
  flushCache,
  resetCacheForTests,
};
