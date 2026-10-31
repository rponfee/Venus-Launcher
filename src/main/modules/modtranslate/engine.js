'use strict';
// Motor de la traduccion de mods (sin Electron, para poder probarlo con Node):
//   analyze      -> que mods tienen textos, cuantos traduce el propio mod, cuantos ya tradujo Venus y cuantos faltan
//   run          -> completa lo que falta (variantes cercanas del idioma, cache y despues IA) y arma el paquete
//   entries/save -> editor de traducciones (lo que corrige el jugador queda marcado como revisado)
//   buildExport/importFile -> compartir; clear, setEnabled, setGameLanguage
// Las dependencias de Electron (papelera, eventos) y la IA se inyectan con configure().
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../../core/paths');
const settings = require('../../core/settings');
const instances = require('../../core/instances');
const tasks = require('../../core/tasks');
const { t, getLanguage } = require('../../core/i18n');
const { uid, sanitizeFileName } = require('../../core/util');
const scanner = require('./scanner');
const store = require('./store');
const locales = require('./locales');
const packformat = require('./packformat');
const options = require('./options');
const pack = require('./pack');
const lang = require('./lang');
const { ZipReader } = require('./zip');
const { validate } = require('./placeholders');
const translator = require('./translator');

const EXPORT_FORMAT = 'venus-modtranslate';
const EXPORT_VERSION = 1;
const MAX_TEXT = 8000;
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
const PACK_WRITE_EVERY = 15000; // ms: durante la traduccion el paquete se va actualizando
const INDEX_TTL = 20000;
const INDEX_MAX = 4;

let config = { ai: null, trash: null, send: () => {}, appVersion: null };

function configure(c = {}) {
  config = { ...config, ...c };
}

// ---------- Utilidades ----------

const LETTERS2 = /\p{L}{2,}/u;
const TOKENS = /%(\d+\$)?[-#+0,(]*\d*(\.\d+)?[a-zA-Z%]|§.|\{[^}]*\}|<[^>]*>|\$\([^)]*\)/g;

// Un texto merece traduccion si le quedan palabras despues de sacar los marcadores.
function translatable(src) {
  return typeof src === 'string' && Boolean(src.trim()) && LETTERS2.test(src.replace(TOKENS, ' '));
}

// El archivo del mod tiene el texto en ingles copiado tal cual (pasa mucho con exportaciones de Crowdin).
function sameAsSource(text, src) {
  return text === src && /\p{L}{2,}[^\p{L}]+\p{L}{2,}/u.test(src);
}

function setEntry(state, ns, key, data) {
  const byNs = (state.entries[ns] = state.entries[ns] || {});
  const e = { s: data.s, t: data.t, o: data.o, r: data.r ? 1 : 0, at: Math.floor(Date.now() / 1000) };
  if (data.from) e.from = data.from;
  if (data.f) e.f = 1;
  byNs[key] = e;
  return e;
}

function gameRunning(instanceId) {
  try {
    return Boolean(require('../../core/game').status()[instanceId]);
  } catch {
    return false;
  }
}

async function aiAvailable() {
  try {
    return Boolean(config.ai && (await config.ai.available()));
  } catch {
    return false;
  }
}

async function writeAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, content);
  await fsp.rename(tmp, file);
}

async function readOptions(dir) {
  try {
    return await fsp.readFile(path.join(dir, 'options.txt'), 'utf8');
  } catch {
    return null;
  }
}

// ---------- Contexto ----------

async function preferredLocale() {
  const s = await settings.get();
  const pref = s.modtranslate?.locale;
  if (locales.isLocale(pref)) return pref;
  return locales.defaultFor(s.language || getLanguage());
}

const fmtCache = new Map();
async function formatFor(inst) {
  let jar = null;
  try {
    jar = paths.versionJar(inst.mcVersion);
  } catch {
    jar = null;
  }
  const st = jar ? await fsp.stat(jar).catch(() => null) : null;
  const key = `${inst.mcVersion}|${st ? `${st.size}:${Math.round(st.mtimeMs)}` : '-'}`;
  if (fmtCache.has(key)) return fmtCache.get(key);
  const fmt = await packformat.resolveFormat(inst.mcVersion, st ? jar : null);
  fmtCache.set(key, fmt);
  return fmt;
}

async function context(instanceId, locale) {
  const inst = await instances.get(instanceId);
  const dir = instances.dir(instanceId);
  const fmt = await formatFor(inst);
  const code = locales.isLocale(locale) ? locale : await preferredLocale();
  return { inst, dir, fmt, locale: code };
}

const allowEscapes = (ctx) => ctx.fmt?.style !== 'json' && /forge/.test(ctx.inst.loader || '');
const langOption = (ctx, code) => (ctx.fmt.style === 'legacy' ? locales.legacyCode(code) : code);

// Paquetes activos en options.txt -> nombres de archivo/carpeta dentro de resourcepacks/
function enabledPacks(list, style) {
  const own = pack.packId(style);
  const out = [];
  for (const id of list || []) {
    if (id === own) continue;
    if (style === 'json') {
      if (id.startsWith('file/')) out.push(id.slice(5));
    } else if (id && !/^(vanilla|default)$/i.test(id)) out.push(id);
  }
  return out.filter((n) => n && !n.includes('..') && !/[\\/]/.test(n.replace(/\/$/, '')));
}

// ---------- Indice: textos de los mods y cobertura ----------

async function buildIndex(ctx, files, optState, onProgress) {
  const { dir, fmt, locale } = ctx;
  const wanted = [locale, ...locales.siblingsOf(locale)];
  const mods = [];
  const nsMap = new Map();
  const native = new Map(); // clave -> texto que ya trae un mod o un paquete
  const sibMaps = new Map(); // idioma cercano -> [Map]
  const addSib = (code, map) => {
    if (!sibMaps.has(code)) sibMaps.set(code, []);
    sibMaps.get(code).push(map);
  };
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress?.({ done: i, total: files.length, file: f.file });
    const res = await scanner.scanJar(f.path, { style: fmt.style, locales: wanted });
    const row = {
      id: f.file,
      file: f.file,
      enabled: f.enabled,
      name: res.name || f.file.replace(/\.(jar|zip)(\.disabled)?$/i, ''),
      version: res.version || null,
      modId: res.modId || null,
      icon: res.icon || null,
      broken: Boolean(res.broken),
      namespaces: [],
      includes: [],
      units: [{ unit: res, nested: false }, ...res.nested.map((u) => ({ unit: u, nested: true }))],
    };
    mods.push(row);
    for (const { unit } of row.units) {
      for (const rec of unit.namespaces.values()) {
        for (const [code, map] of rec.targets) {
          if (code === locale) {
            for (const [k, v] of map) if (!native.has(k)) native.set(k, v);
          } else addSib(code, map);
        }
      }
    }
  }
  onProgress?.({ done: files.length, total: files.length });
  // Dueño de cada namespace: primero los jars de la carpeta, despues los anidados.
  for (const nestedPass of [false, true]) {
    for (const row of mods) {
      for (const { unit, nested } of row.units) {
        if (nested !== nestedPass) continue;
        for (const [ns, rec] of unit.namespaces) {
          if (!rec.source?.size || nsMap.has(ns)) continue;
          nsMap.set(ns, { ns, row, unitName: unit.name || unit.modId || row.name, source: rec.source, escapes: rec.escapes });
          row.namespaces.push(ns);
          const label = unit.name || unit.modId;
          if (nested && label && label !== row.name && !row.includes.includes(label)) row.includes.push(label);
        }
      }
    }
  }
  for (const row of mods) delete row.units;
  // Paquetes de recursos activos: pisan a los mods (y entre ellos gana el ultimo de la lista).
  const packsCovering = [];
  const rpDir = path.join(dir, 'resourcepacks');
  for (const name of enabledPacks(optState.packs, fmt.style)) {
    let full;
    try {
      full = pack.inside(rpDir, name);
    } catch {
      continue;
    }
    const res = await scanner.scanPack(full, { style: fmt.style, locales: wanted });
    if (!res) continue;
    let keys = 0;
    for (const rec of res.namespaces.values()) {
      for (const [code, map] of rec.targets) {
        if (code === locale) {
          for (const [k, v] of map) native.set(k, v);
          keys += map.size;
        } else addSib(code, map);
      }
    }
    if (keys) packsCovering.push({ name, keys });
  }
  // Traducciones de variantes cercanas (es_es para completar es_ar, por ejemplo), en orden de preferencia.
  const sib = new Map();
  for (const code of locales.siblingsOf(locale)) {
    for (const map of sibMaps.get(code) || []) for (const [k, v] of map) if (!sib.has(k)) sib.set(k, { text: v, from: code });
  }
  return { mods, nsMap, native, sib, packsCovering };
}

const indexCache = new Map();

async function getIndex(ctx, onProgress) {
  const files = await scanner.listModFiles(path.join(ctx.dir, 'mods'));
  const optText = await readOptions(ctx.dir);
  const optState = options.readState(optText, pack.packId(ctx.fmt.style));
  const sig = JSON.stringify([ctx.fmt.style, ctx.locale, files.map((f) => [f.file, f.size, Math.round(f.mtime)]), optState.packs]);
  const key = `${ctx.dir}|${ctx.locale}`;
  const hit = indexCache.get(key);
  if (hit && hit.sig === sig && Date.now() - hit.at < INDEX_TTL) return hit.index;
  const index = await buildIndex(ctx, files, optState, onProgress);
  index.optState = optState;
  indexCache.delete(key);
  indexCache.set(key, { sig, at: Date.now(), index });
  while (indexCache.size > INDEX_MAX) indexCache.delete(indexCache.keys().next().value);
  return index;
}

function invalidate(dir) {
  for (const k of [...indexCache.keys()]) if (k.startsWith(`${dir}|`)) indexCache.delete(k);
}

// Estado de una clave para el idioma de destino.
function keyStatus(index, state, ns, key, src) {
  const nat = index.native.get(key);
  const identical = nat !== undefined && sameAsSource(nat, src);
  if (nat !== undefined && !identical) return { kind: 'native' };
  const e = state.entries[ns]?.[key];
  if (e && typeof e.t === 'string') {
    if (e.s === src) return { kind: e.r ? 'reviewed' : 'auto', entry: e };
    if (e.r) return { kind: 'stale', entry: e };
  }
  const s = index.sib.get(key);
  const copy = s && !sameAsSource(s.text, src) && validate(src, s.text).ok ? s : null;
  return { kind: 'missing', entry: e || null, identical, failed: Boolean(e && e.f && e.s === src), copy };
}

function cachedFor(locale, ns, src) {
  const hit = store.cacheGetSync(locale, ns, src);
  return hit && validate(src, hit.t).ok ? hit : null;
}

function countRow(index, state, row, locale) {
  const c = { total: 0, native: 0, ours: 0, reviewed: 0, stale: 0, missing: 0, identical: 0, failed: 0, copies: 0, cached: 0, pending: 0, tokens: 0 };
  const pending = [];
  for (const ns of row.namespaces) {
    const rec = index.nsMap.get(ns);
    for (const [key, src] of rec.source) {
      if (!translatable(src)) continue;
      c.total++;
      const st = keyStatus(index, state, ns, key, src);
      if (st.kind === 'native') c.native++;
      else if (st.kind === 'auto') c.ours++;
      else if (st.kind === 'reviewed') {
        c.ours++;
        c.reviewed++;
      } else if (st.kind === 'stale') {
        c.ours++;
        c.reviewed++;
        c.stale++;
      } else {
        c.missing++;
        if (st.identical) c.identical++;
        if (st.failed) c.failed++;
        if (st.copy) c.copies++;
        else if (cachedFor(locale, ns, src)) c.cached++;
        else {
          c.pending++;
          pending.push({ key, source: src });
        }
      }
    }
  }
  c.tokens = translator.estimateTokens(pending, locale);
  if (!c.total) c.status = 'empty';
  else if (!c.missing) c.status = c.ours ? 'auto' : 'complete';
  else if (!c.native && !c.ours) c.status = 'none';
  else c.status = 'partial';
  return c;
}

function publicRow(row, counts) {
  return {
    id: row.id,
    file: row.file,
    enabled: row.enabled,
    name: row.name,
    version: row.version,
    modId: row.modId,
    icon: row.icon,
    broken: row.broken,
    includes: row.includes,
    namespaces: row.namespaces,
    ...counts,
  };
}

// ---------- Analisis (pantalla principal) ----------

async function analyze(instanceId, { locale, remember = false } = {}, onProgress) {
  const ctx = await context(instanceId, locale);
  const s = await settings.get();
  if (remember && locales.isLocale(locale) && s.modtranslate?.locale !== locale) {
    await settings.set({ modtranslate: { ...(s.modtranslate || {}), locale } });
  }
  const base = {
    instance: { id: ctx.inst.id, name: ctx.inst.name, mcVersion: ctx.inst.mcVersion, loader: ctx.inst.loader },
    locale: ctx.locale,
    locales: locales.listFor(s.language || getLanguage()),
    supported: Boolean(ctx.fmt),
    format: ctx.fmt ? { style: ctx.fmt.style, major: ctx.fmt.major, minor: ctx.fmt.minor, certain: ctx.fmt.certain, source: ctx.fmt.source } : null,
    gameRunning: gameRunning(instanceId),
    ai: { available: await aiAvailable() },
    job: status(instanceId),
  };
  if (!ctx.fmt) return { ...base, mods: [], totals: null, pack: null, produced: [], packsCovering: [], gameLanguage: null };
  const index = await getIndex(ctx, onProgress);
  const state = await store.acquire(ctx.dir, ctx.locale);
  await store.loadCache();
  const totals = { mods: index.mods.length, withText: 0, total: 0, native: 0, ours: 0, reviewed: 0, stale: 0, missing: 0, identical: 0, failed: 0, copies: 0, cached: 0, pending: 0, tokens: 0 };
  const mods = index.mods.map((row) => {
    const c = countRow(index, state, row, ctx.locale);
    if (c.total) totals.withText++;
    for (const k of Object.keys(totals)) if (k !== 'mods' && k !== 'withText' && typeof c[k] === 'number') totals[k] += c[k];
    return publicRow(row, c);
  });
  // El paquete existente se actualiza si cambio la version del juego (pack.mcmeta distinto).
  const packExists = await pack.exists(ctx.dir);
  if (packExists) {
    const want = pack.mcmetaText(ctx.fmt);
    if ((await pack.readMcmeta(ctx.dir)) !== want) await pack.writeMeta(ctx.dir, ctx.fmt).catch(() => {});
  }
  const produced = await store.listStates(ctx.dir);
  return {
    ...base,
    gameLanguage: index.optState.lang ? index.optState.lang.toLowerCase() : null,
    pack: { exists: packExists, enabled: index.optState.enabled, id: pack.packId(ctx.fmt.style), dir: pack.packDir(ctx.dir), optionsExists: index.optState.exists },
    produced,
    packsCovering: index.packsCovering,
    mods,
    totals,
  };
}

// ---------- Traduccion ----------

const jobs = new Map();

function publicJob(job) {
  if (!job) return null;
  const { task: _task, ...rest } = job;
  return { ...rest };
}

function status(instanceId) {
  return publicJob(jobs.get(instanceId));
}

function cancel(instanceId) {
  const job = jobs.get(instanceId);
  if (!job) return false;
  job.task.cancel();
  return true;
}

async function applyOptions(ctx, { enable = true, lang = null } = {}) {
  const text = await readOptions(ctx.dir);
  const res = options.mergePack(text, { id: pack.packId(ctx.fmt.style), enable, legacy: ctx.fmt.style !== 'json', incompatible: !ctx.fmt.certain, lang });
  if (res.changed) await writeAtomic(path.join(ctx.dir, 'options.txt'), res.text);
  invalidate(ctx.dir);
  return res.changed;
}

/**
 * Traduce lo que falta de los mods elegidos. opts: { locale, mods: [archivo...], setLanguage }
 * Devuelve { status: 'done'|'cancelled'|'error', error?, translated, copied, cached, failed, skipped, ... }
 */
async function run(instanceId, opts = {}) {
  if (jobs.has(instanceId)) throw new Error(t('modtranslate.errBusy'));
  const selected = new Set((Array.isArray(opts.mods) ? opts.mods : []).filter((m) => typeof m === 'string'));
  if (!selected.size) throw new Error(t('modtranslate.errNoMods'));
  // Se reserva el lugar antes de cualquier await para que dos pedidos seguidos no arranquen dos tareas.
  const job = { instanceId, locale: opts.locale || null, state: 'running', phase: 'prepare', done: 0, total: 0, translated: 0, copied: 0, cached: 0, failed: 0, skipped: 0, current: null, error: null, startedAt: Date.now(), task: { cancel() {} } };
  jobs.set(instanceId, job);
  let ctx;
  try {
    ctx = await context(instanceId, opts.locale);
    if (!ctx.fmt) throw new Error(t('modtranslate.errUnsupported'));
  } catch (err) {
    jobs.delete(instanceId);
    throw err;
  }
  job.locale = ctx.locale;
  // Sin meta.instanceId a proposito: la interfaz trata esas tareas como "instalando" y bloquea el boton
  // Jugar; traducir no impide jugar (el paquete se recarga con F3 + T o al reiniciar).
  const task = new tasks.Task(t('modtranslate.taskTitle', { name: ctx.inst.name }), { kind: 'modtranslate', modtranslateInstance: instanceId });
  job.task = task;
  let lastEmit = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 150) return;
    lastEmit = now;
    task.update({ detail: job.total ? t('modtranslate.taskDetail', { done: job.done, total: job.total }) : t('modtranslate.taskPreparing'), progress: job.total ? job.done / job.total : null });
    try {
      config.send('modtranslate:progress', instanceId, publicJob(job));
    } catch {
      /* ventana cerrada */
    }
  };
  emit(true);
  let state;
  try {
    state = await store.acquire(ctx.dir, ctx.locale);
  } catch (err) {
    jobs.delete(instanceId);
    task.fail(err);
    throw err;
  }
  let wrote = false;
  const writePack = async () => {
    if (!store.countEntries(state) && !(await pack.exists(ctx.dir))) return;
    await pack.writeLocale(ctx.dir, state, { fmt: ctx.fmt, allowEscapes: allowEscapes(ctx) });
    wrote = true;
  };
  try {
    const index = await getIndex(ctx);
    await store.loadCache();
    const instant = [];
    const work = [];
    for (const row of index.mods) {
      if (!selected.has(row.id)) continue;
      for (const ns of row.namespaces) {
        const rec = index.nsMap.get(ns);
        for (const [key, src] of rec.source) {
          if (!translatable(src)) continue;
          const st = keyStatus(index, state, ns, key, src);
          if (st.kind !== 'missing') continue;
          if (st.copy) instant.push({ ns, key, src, text: st.copy.text, o: 'copy', from: st.copy.from });
          else {
            const hit = cachedFor(ctx.locale, ns, src);
            if (hit) instant.push({ ns, key, src, text: hit.t, o: 'cache', r: hit.r });
            else work.push({ key, source: src, ns, mod: rec.unitName || row.name });
          }
        }
      }
    }
    const useAi = work.length > 0 && (await aiAvailable());
    job.total = instant.length + (useAi ? work.length : 0);
    job.skipped = useAi ? 0 : work.length;
    job.phase = 'translate';
    emit(true);
    for (const it of instant) {
      setEntry(state, it.ns, it.key, { s: it.src, t: it.text, o: it.o, r: it.r, from: it.from });
      if (it.o === 'copy') job.copied++;
      else job.cached++;
      job.done++;
    }
    if (instant.length) {
      store.touch(ctx.dir, ctx.locale);
      emit(true);
    }
    if (useAi) {
      const loc = locales.info(ctx.locale);
      let lastWrite = Date.now();
      await translator.translateAll(work, {
        ai: config.ai,
        loc,
        signal: task.signal,
        turnId: `modtranslate-${uid(12)}`,
        onBatch: async ({ ok, failed }) => {
          for (const { item, text } of ok) {
            setEntry(state, item.ns, item.key, { s: item.source, t: text, o: 'ai', r: 0 });
            store.cacheSet(ctx.locale, item.ns, item.source, text, false);
            job.translated++;
            job.done++;
            job.current = item.mod;
          }
          for (const item of failed) {
            const cur = state.entries[item.ns]?.[item.key];
            if (!(cur && typeof cur.t === 'string' && cur.s === item.source)) setEntry(state, item.ns, item.key, { s: item.source, t: null, o: 'ai', r: 0, f: 1 });
            job.failed++;
            job.done++;
            job.current = item.mod;
          }
          store.touch(ctx.dir, ctx.locale);
          emit();
          if (Date.now() - lastWrite > PACK_WRITE_EVERY) {
            lastWrite = Date.now();
            await writePack();
          }
        },
      });
    }
    job.state = 'done';
  } catch (err) {
    const cancelled = task.signal.aborted;
    job.state = cancelled ? 'cancelled' : 'error';
    job.error = cancelled ? null : err?.message || String(err);
  }
  // Pase lo que pase se guarda lo que se tradujo hasta aca.
  try {
    job.phase = 'finish';
    await store.touch(ctx.dir, ctx.locale, { now: true });
    await writePack();
    if (wrote) await applyOptions(ctx, { enable: true, lang: opts.setLanguage ? langOption(ctx, ctx.locale) : null });
    else if (opts.setLanguage) await applyLang(ctx, ctx.locale);
    await store.flushCache();
  } catch (err) {
    if (job.state === 'done') {
      job.state = 'error';
      job.error = err?.message || String(err);
    }
  }
  invalidate(ctx.dir);
  jobs.delete(instanceId);
  job.finishedAt = Date.now();
  const result = { ...publicJob(job), status: job.state, packWritten: wrote, gameRunning: gameRunning(instanceId), setLanguage: Boolean(opts.setLanguage) };
  emit(true);
  if (job.state === 'done') task.done(t('modtranslate.taskDone', { count: job.translated + job.copied + job.cached }));
  else if (job.state === 'cancelled') task.fail(new Error(t('modtranslate.taskCancelled')));
  else task.fail(new Error(job.error));
  return result;
}

// ---------- Editor ----------

const FILTERS = ['all', 'auto', 'reviewed', 'untranslated', 'problems'];

function editorRow(row, ns, key, src, st) {
  const e = st.entry;
  const has = st.kind !== 'missing';
  return {
    mod: row.id,
    modName: row.name,
    ns,
    key,
    source: src,
    text: has ? e.t : '',
    kind: st.kind,
    reviewed: st.kind === 'reviewed' || st.kind === 'stale',
    stale: st.kind === 'stale',
    failed: Boolean(st.failed),
    identical: Boolean(st.identical),
    origin: has ? e.o || null : null,
    from: has ? e.from || null : null,
    oldSource: st.kind === 'stale' ? e.s : null,
    _copy: st.copy || null,
  };
}

function inFilter(r, filter) {
  switch (filter) {
    case 'auto':
      return r.kind === 'auto';
    case 'reviewed':
      return r.reviewed;
    case 'untranslated':
      return r.kind === 'missing';
    case 'problems':
      return r.stale || r.failed;
    default:
      return true;
  }
}

async function entries(instanceId, opts = {}) {
  const ctx = await context(instanceId, opts.locale);
  const empty = { locale: ctx.locale, total: 0, offset: 0, limit: 0, rows: [], counts: { all: 0, auto: 0, reviewed: 0, untranslated: 0, problems: 0 }, mods: [] };
  if (!ctx.fmt) return empty;
  const index = await getIndex(ctx);
  const state = await store.acquire(ctx.dir, ctx.locale);
  await store.loadCache();
  const mod = typeof opts.mod === 'string' && opts.mod ? opts.mod : null;
  const filter = FILTERS.includes(opts.filter) ? opts.filter : 'all';
  const q = String(opts.query || '').trim().toLowerCase().slice(0, 200);
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(opts.limit) || 50)));
  const counts = { all: 0, auto: 0, reviewed: 0, untranslated: 0, problems: 0 };
  const matched = [];
  const modList = [];
  for (const row of index.mods) {
    let n = 0;
    for (const ns of row.namespaces) {
      const rec = index.nsMap.get(ns);
      for (const [key, src] of rec.source) {
        if (!translatable(src)) continue;
        const st = keyStatus(index, state, ns, key, src);
        if (st.kind === 'native') continue;
        n++;
        if (mod && row.id !== mod) continue;
        const r = editorRow(row, ns, key, src, st);
        if (q && !`${key}\u0000${src}\u0000${r.text}`.toLowerCase().includes(q)) continue;
        counts.all++;
        for (const f of FILTERS.slice(1)) if (inFilter(r, f)) counts[f]++;
        if (inFilter(r, filter)) matched.push(r);
      }
    }
    if (n) modList.push({ id: row.id, name: row.name, count: n });
  }
  const rows = matched.slice(offset, offset + limit).map((r) => {
    const { _copy, ...out } = r;
    if (out.kind === 'missing') {
      if (_copy) out.suggestion = { text: _copy.text, from: _copy.from };
      else {
        const hit = cachedFor(ctx.locale, out.ns, out.source);
        if (hit) out.suggestion = { text: hit.t, from: 'cache', reviewed: hit.r };
      }
    }
    return out;
  });
  return { locale: ctx.locale, total: matched.length, offset, limit, rows, counts, mods: modList, filter, gameRunning: gameRunning(instanceId) };
}

/**
 * Guarda cambios del editor: changes = [{ ns, key, text?, reviewed? }]
 *   text vacio -> se borra la traduccion (vuelve a verse el original)
 *   si el texto cambia queda marcado como revisado (salvo que reviewed diga lo contrario)
 */
async function save(instanceId, opts = {}) {
  const ctx = await context(instanceId, opts.locale);
  if (!ctx.fmt) throw new Error(t('modtranslate.errUnsupported'));
  const index = await getIndex(ctx);
  const state = await store.acquire(ctx.dir, ctx.locale);
  const list = Array.isArray(opts.changes) ? opts.changes.slice(0, 5000) : [];
  const created = !(await pack.exists(ctx.dir));
  let saved = 0;
  const rejected = [];
  for (const ch of list) {
    const ns = typeof ch?.ns === 'string' ? ch.ns : '';
    const key = typeof ch?.key === 'string' ? ch.key : '';
    const src = index.nsMap.get(ns)?.source.get(key);
    if (src === undefined) {
      rejected.push({ ns, key, reason: 'unknown' });
      continue;
    }
    const cur = state.entries[ns]?.[key] || null;
    if (ch.text === undefined || ch.text === null) {
      // Solo la marca de revisado
      if (cur && typeof cur.t === 'string') {
        cur.r = ch.reviewed ? 1 : 0;
        if (ch.reviewed) {
          cur.s = src; // revisar una traduccion vieja la acepta para el original nuevo
          store.cacheSet(ctx.locale, ns, src, cur.t, true);
        }
        saved++;
      }
      continue;
    }
    const text = String(ch.text).slice(0, MAX_TEXT);
    if (!text.trim()) {
      if (cur) delete state.entries[ns][key];
      saved++;
      continue;
    }
    const v = validate(src, text);
    if (!v.ok) {
      rejected.push({ ns, key, reason: v.reason, missing: v.missing, extra: v.extra });
      continue;
    }
    const changed = !cur || cur.t !== text || cur.s !== src;
    const reviewed = ch.reviewed === undefined ? changed || Boolean(cur?.r) : Boolean(ch.reviewed);
    setEntry(state, ns, key, { s: src, t: text, o: changed ? 'user' : cur.o, r: reviewed, from: changed ? null : cur.from });
    if (reviewed) store.cacheSet(ctx.locale, ns, src, text, true);
    saved++;
  }
  if (saved) {
    await store.touch(ctx.dir, ctx.locale, { now: true });
    await pack.writeLocale(ctx.dir, state, { fmt: ctx.fmt, allowEscapes: allowEscapes(ctx) });
    if (created && store.countEntries(state)) await applyOptions(ctx, { enable: true });
  }
  return { saved, rejected, gameRunning: gameRunning(instanceId) };
}

// ---------- Compartir ----------

function modsFilter(index, mods) {
  if (!Array.isArray(mods) || !mods.length) return null;
  const set = new Set(mods);
  return new Set(index.mods.filter((r) => set.has(r.id)).flatMap((r) => r.namespaces));
}

/**
 * Arma lo que se exporta. format: 'json' (archivo para compartir, con el original y las revisiones)
 * o 'zip' (paquete de recursos listo para cualquier launcher). Devuelve { buffer, fileName, count }.
 */
async function buildExport(instanceId, opts = {}) {
  const ctx = await context(instanceId, opts.locale);
  if (!ctx.fmt) throw new Error(t('modtranslate.errUnsupported'));
  const index = await getIndex(ctx);
  const state = await store.acquire(ctx.dir, ctx.locale);
  const only = modsFilter(index, opts.mods);
  const picked = { v: state.v, locale: state.locale, entries: {} };
  let count = 0;
  let reviewed = 0;
  for (const [ns, keys] of Object.entries(state.entries)) {
    if (only && !only.has(ns)) continue;
    for (const [k, e] of Object.entries(keys)) {
      if (typeof e?.t !== 'string') continue;
      (picked.entries[ns] = picked.entries[ns] || {})[k] = e;
      count++;
      if (e.r) reviewed++;
    }
  }
  if (!count) throw new Error(t('modtranslate.errNothingToExport'));
  const slug = sanitizeFileName(ctx.inst.name).replace(/\s+/g, '-');
  if (opts.format === 'zip') {
    return { buffer: pack.buildZip([picked], { fmt: ctx.fmt, allowEscapes: allowEscapes(ctx) }), fileName: t('modtranslate.exportZipName', { locale: ctx.locale, name: slug }), count, reviewed };
  }
  const usedNs = new Set(Object.keys(picked.entries));
  const data = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    locale: ctx.locale,
    sourceLocale: 'en_us',
    machineTranslated: true,
    notice: t('modtranslate.exportNotice'),
    generator: config.appVersion ? `Venus Launcher ${config.appVersion}` : 'Venus Launcher',
    exportedAt: new Date().toISOString(),
    minecraft: ctx.inst.mcVersion,
    loader: ctx.inst.loader,
    stats: { entries: count, reviewed },
    mods: index.mods
      .filter((r) => r.namespaces.some((ns) => usedNs.has(ns)))
      .map((r) => ({ id: r.modId, name: r.name, version: r.version, file: r.file, namespaces: r.namespaces.filter((ns) => usedNs.has(ns)) })),
    translations: {},
  };
  for (const [ns, keys] of Object.entries(picked.entries)) {
    const out = (data.translations[ns] = {});
    for (const [k, e] of Object.entries(keys).sort((a, b) => a[0].localeCompare(b[0]))) {
      out[k] = { source: e.s, text: e.t, reviewed: Boolean(e.r), origin: e.o || 'ai' };
    }
  }
  return { buffer: Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8'), fileName: t('modtranslate.exportJsonName', { locale: ctx.locale, name: slug }), count, reviewed };
}

// Lee un archivo para importar: exportacion de Venus, archivo de idioma (.json/.lang) o paquete .zip.
async function parseImport(buf, fileName, preferLocale) {
  const base = path.basename(String(fileName || '')).toLowerCase();
  const fromName = /^([a-z]{2,3}_[a-z]{2,4})\.(json|lang)$/.exec(base);
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    const zip = await ZipReader.fromBuffer(buf);
    const byCode = new Map();
    for (const e of zip.entries) {
      const m = /^assets\/([^/]+)\/lang\/([^/]+)\.(json|lang)$/.exec(e.name);
      if (!m || !scanner.NS_OK.test(m[1])) continue;
      const code = m[2].toLowerCase();
      if (!locales.isLocale(code)) continue;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push({ ns: m[1], entry: e, ext: m[3] });
    }
    const code = byCode.has(preferLocale) ? preferLocale : byCode.size === 1 ? [...byCode.keys()][0] : null;
    if (!code) throw new Error(byCode.size ? t('modtranslate.errImportManyLocales') : t('modtranslate.errImportEmpty'));
    const out = [];
    for (const { ns, entry, ext } of byCode.get(code)) {
      try {
        const { map } = lang.parseLang(await zip.read(entry), ext);
        for (const [key, text] of map) out.push({ ns, key, text, reviewed: false });
      } catch {
        /* archivo roto dentro del zip */
      }
    }
    return { locale: code, entries: out, kind: 'pack' };
  }
  if (/\.lang$/.test(base)) {
    const { map } = lang.parseLangFile(buf);
    return { locale: fromName && locales.isLocale(fromName[1]) ? fromName[1] : null, entries: [...map].map(([key, text]) => ({ key, text, reviewed: false })), kind: 'lang' };
  }
  let data;
  try {
    data = lang.parseJsonLenient(buf);
  } catch {
    throw new Error(t('modtranslate.errImportFormat'));
  }
  if (data && data.format === EXPORT_FORMAT && data.translations && typeof data.translations === 'object') {
    if (Number(data.version) > EXPORT_VERSION) throw new Error(t('modtranslate.errImportVersion'));
    const out = [];
    for (const [ns, keys] of Object.entries(data.translations)) {
      if (!scanner.NS_OK.test(ns) || !keys || typeof keys !== 'object') continue;
      for (const [key, e] of Object.entries(keys)) {
        const text = typeof e === 'string' ? e : e?.text;
        if (typeof text === 'string') out.push({ ns, key, text, reviewed: Boolean(e?.reviewed), source: typeof e?.source === 'string' ? e.source : null });
      }
    }
    return { locale: locales.isLocale(data.locale) ? data.locale : null, entries: out, kind: 'venus' };
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const out = Object.entries(data)
      .filter(([k, v]) => typeof v === 'string' && k && !/^_+comment/i.test(k))
      .map(([key, text]) => ({ key, text, reviewed: false }));
    if (!out.length) throw new Error(t('modtranslate.errImportEmpty'));
    return { locale: fromName && locales.isLocale(fromName[1]) ? fromName[1] : null, entries: out, kind: 'lang' };
  }
  throw new Error(t('modtranslate.errImportFormat'));
}

async function importFile(instanceId, { locale, file } = {}) {
  const ctx0 = await context(instanceId, locale);
  if (!ctx0.fmt) throw new Error(t('modtranslate.errUnsupported'));
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new Error(t('modtranslate.errImportRead'));
  if (st.size > MAX_IMPORT_BYTES) throw new Error(t('modtranslate.errImportTooBig'));
  const parsed = await parseImport(await fsp.readFile(file), file, ctx0.locale);
  const ctx = { ...ctx0, locale: parsed.locale || ctx0.locale };
  const index = await getIndex(ctx);
  const state = await store.acquire(ctx.dir, ctx.locale);
  const created = !(await pack.exists(ctx.dir));
  const nsByKey = new Map();
  for (const [ns, rec] of index.nsMap) {
    for (const k of rec.source.keys()) {
      if (!nsByKey.has(k)) nsByKey.set(k, []);
      nsByKey.get(k).push(ns);
    }
  }
  const res = { locale: ctx.locale, kind: parsed.kind, added: 0, updated: 0, unchanged: 0, unknown: 0, invalid: 0, native: 0, kept: 0, total: parsed.entries.length };
  for (const e of parsed.entries) {
    if (typeof e.key !== 'string' || typeof e.text !== 'string' || !e.text.trim()) continue;
    const text = e.text.slice(0, MAX_TEXT);
    const targets = (e.ns && index.nsMap.get(e.ns)?.source.has(e.key) ? [e.ns] : nsByKey.get(e.key) || []).filter((ns) => translatable(index.nsMap.get(ns).source.get(e.key)));
    if (!targets.length) {
      res.unknown++;
      continue;
    }
    for (const ns of targets) {
      const src = index.nsMap.get(ns).source.get(e.key);
      const stt = keyStatus(index, state, ns, e.key, src);
      if (stt.kind === 'native') {
        res.native++;
        continue;
      }
      if (!validate(src, text).ok) {
        res.invalid++;
        continue;
      }
      const cur = state.entries[ns]?.[e.key];
      if (cur && typeof cur.t === 'string' && cur.s === src && cur.t === text) {
        if (e.reviewed && !cur.r) cur.r = 1;
        res.unchanged++;
        continue;
      }
      // Las correcciones propias no se pisan con algo que nadie reviso.
      if (cur && cur.r && typeof cur.t === 'string' && !e.reviewed) {
        res.kept++;
        continue;
      }
      setEntry(state, ns, e.key, { s: src, t: text, o: 'import', r: e.reviewed });
      if (e.reviewed) store.cacheSet(ctx.locale, ns, src, text, true);
      if (cur && typeof cur.t === 'string') res.updated++;
      else res.added++;
    }
  }
  if (res.added || res.updated || res.unchanged) {
    await store.touch(ctx.dir, ctx.locale, { now: true });
    await pack.writeLocale(ctx.dir, state, { fmt: ctx.fmt, allowEscapes: allowEscapes(ctx) });
    if (created && store.countEntries(state)) await applyOptions(ctx, { enable: true });
  }
  invalidate(ctx.dir);
  return { ...res, gameRunning: gameRunning(instanceId) };
}

// ---------- Mantenimiento ----------

async function removePackFolder(ctx) {
  const dir = pack.packDir(ctx.dir);
  pack.inside(ctx.dir, 'resourcepacks', pack.PACK_DIR);
  if (!(await fsp.stat(dir).catch(() => null))) return;
  if (config.trash) {
    try {
      await config.trash(dir);
      return;
    } catch {
      /* sin papelera: se borra (es contenido generado por el launcher) */
    }
  }
  await fsp.rm(dir, { recursive: true, force: true });
}

// Borra traducciones de este idioma (de algunos mods o de todos). La cache global se conserva.
async function clear(instanceId, opts = {}) {
  if (jobs.has(instanceId)) throw new Error(t('modtranslate.errBusy'));
  const ctx = await context(instanceId, opts.locale);
  if (!ctx.fmt) throw new Error(t('modtranslate.errUnsupported'));
  const state = await store.acquire(ctx.dir, ctx.locale);
  let removed = 0;
  const only = Array.isArray(opts.mods) && opts.mods.length ? modsFilter(await getIndex(ctx), opts.mods) : null;
  for (const ns of Object.keys(state.entries)) {
    if (only && !only.has(ns)) continue;
    removed += Object.values(state.entries[ns]).filter((e) => typeof e?.t === 'string').length;
    delete state.entries[ns];
  }
  await store.touch(ctx.dir, ctx.locale, { now: true });
  if (await pack.exists(ctx.dir)) await pack.writeLocale(ctx.dir, state, { fmt: ctx.fmt, allowEscapes: allowEscapes(ctx) });
  if (!Object.keys(state.entries).length) await store.removeState(ctx.dir, ctx.locale);
  let packRemoved = false;
  if (!(await pack.hasLangFiles(ctx.dir))) {
    await removePackFolder(ctx);
    await applyOptions(ctx, { enable: false });
    packRemoved = true;
  }
  invalidate(ctx.dir);
  return { removed, packRemoved };
}

async function setEnabled(instanceId, enabled) {
  const ctx = await context(instanceId);
  if (!ctx.fmt) throw new Error(t('modtranslate.errUnsupported'));
  if (enabled && !(await pack.exists(ctx.dir))) throw new Error(t('modtranslate.errNoPack'));
  await applyOptions(ctx, { enable: Boolean(enabled) });
  return { enabled: Boolean(enabled), gameRunning: gameRunning(instanceId) };
}

// Idioma del juego en options.txt (sin tocar los paquetes).
async function applyLang(ctx, code) {
  const res = options.setLang(await readOptions(ctx.dir), langOption(ctx, code));
  if (res.changed) await writeAtomic(path.join(ctx.dir, 'options.txt'), res.text);
  invalidate(ctx.dir);
  return res.changed;
}

async function setGameLanguage(instanceId, locale) {
  if (!locales.isLocale(locale)) throw new Error(t('modtranslate.errLocale'));
  const ctx = await context(instanceId, locale);
  if (!ctx.fmt) throw new Error(t('modtranslate.errUnsupported'));
  await applyLang(ctx, locale);
  return { lang: locale, gameRunning: gameRunning(instanceId) };
}

async function shutdown() {
  for (const job of jobs.values()) job.task.cancel();
  await store.flushAll().catch(() => {});
  await store.flushCache().catch(() => {});
}

module.exports = {
  configure,
  analyze,
  run,
  cancel,
  status,
  entries,
  save,
  buildExport,
  parseImport,
  importFile,
  clear,
  setEnabled,
  setGameLanguage,
  shutdown,
  translatable,
  sameAsSource,
  invalidate,
};
