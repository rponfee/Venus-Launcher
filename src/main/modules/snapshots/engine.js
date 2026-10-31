'use strict';
// Instantaneas de instancias: crear, comparar con el estado actual, restaurar, borrar y retencion.
// No usa Electron (se puede probar con Node puro). snapshots.js registra los canales.
const fsp = require('fs/promises');
const path = require('path');
const instances = require('../../core/instances');
const game = require('../../core/game');
const settingsCore = require('../../core/settings');
const tasks = require('../../core/tasks');
const { t } = require('../../core/i18n');
const { dirSize } = require('../../core/util');
const store = require('./store');
const { ROOTS, ROOT_KEYS, CONTENT_ROOTS, scan, listWorldFolders, rootOf, safeRel, validSegment } = require('./scan');

const DIR_ROOTS = new Set(ROOTS.filter((r) => r.dir).map((r) => r.rel));

const DEFAULTS = Object.freeze({ autoBeforePlay: true, keepAuto: 10, keepDays: 30, autoIntervalHours: 6 });
const REASON_CODES = new Set(['manual', 'beforePlay', 'beforeRestore', 'packUpdate', 'modUpdate', 'import', 'crash', 'other']);
const LOADERS = new Set(instances.LOADER_KINDS);
const DAY = 24 * 60 * 60 * 1000;
const KEEP_MIN_AUTO = 2; // siempre quedan al menos las 2 automaticas mas nuevas
const MAX_FILES = 400000;

let notify = () => {};
function setNotifier(fn) {
  notify = typeof fn === 'function' ? fn : () => {};
}

const isRunning = (id) => Boolean(game.status()[id]);

// Mientras se busca el mod culpable (modulo crash) los mods estan a medio desactivar: ni se guardan (la
// instantanea los tendria desactivados) ni se restauran.
function notBisecting(id) {
  let crash = null;
  try {
    crash = require('../crash');
  } catch {
    crash = null;
  }
  crash?.assertNotBisecting?.(id);
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const num = (v, min, max, def) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : def);
  return {
    autoBeforePlay: typeof r.autoBeforePlay === 'boolean' ? r.autoBeforePlay : DEFAULTS.autoBeforePlay,
    keepAuto: num(r.keepAuto, 1, 200, DEFAULTS.keepAuto),
    keepDays: num(r.keepDays, 0, 3650, DEFAULTS.keepDays), // 0 = sin limite de dias
    autoIntervalHours: num(r.autoIntervalHours, 0, 168, DEFAULTS.autoIntervalHours),
  };
}

async function getSettings() {
  return normalizeSettings((await settingsCore.get()).snapshots);
}

// Errores con mensaje para el usuario
function friendly(err) {
  if (!err || err.userFacing) return err;
  const code = err.code;
  let msg = null;
  if (code === 'TOO_MANY') msg = t('snapshots.errTooMany', { count: MAX_FILES });
  else if (code === 'ENOSPC') msg = t('snapshots.errNoSpace');
  else if (code === 'DAMAGED') msg = t('snapshots.errDamaged', { file: err.rel || '' });
  else if (code === 'MISSING') msg = t('snapshots.errMissingObjects');
  else if (code === 'NOT_FOUND') msg = t('snapshots.errNotFound');
  else if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') msg = t('snapshots.errLocked', { file: path.basename(err.path || '') || '?' });
  if (!msg) return err;
  return Object.assign(new Error(msg), { code, userFacing: true, cause: err });
}

function userError(key, vars) {
  return Object.assign(new Error(t(key, vars)), { userFacing: true });
}

// Lo que se guarda de la instancia junto con los archivos (version, loader, registros de Modrinth/CurseForge).
function instanceMeta(inst) {
  return {
    name: inst.name,
    mcVersion: inst.mcVersion,
    loader: inst.loader,
    loaderVersion: inst.loaderVersion ?? null,
    preset: inst.preset ?? null,
    versionId: inst.versionId ?? null,
    modrinth: inst.modrinth ?? null,
    curseforge: inst.curseforge ?? null,
  };
}

function metaKey(m) {
  return JSON.stringify([m?.mcVersion, m?.loader, m?.loaderVersion ?? null, m?.preset ?? null, m?.versionId ?? null, m?.modrinth?.pack ?? null, m?.curseforge?.pack ?? null]);
}

async function resolveWorlds(instDir, sel) {
  if (!sel || sel === 'none') return [];
  const all = await listWorldFolders(instDir);
  if (sel === 'all' || sel === true) return all;
  if (Array.isArray(sel)) {
    const set = new Set(all);
    const picked = [...new Set(sel.filter((w) => validSegment(w) && set.has(w)))];
    if (sel.length && !picked.length) throw userError('snapshots.errBadWorld');
    return picked;
  }
  return [];
}

// Tarea con el progreso mapeado a un tramo [from, to] de otra tarea.
function scaled(task, from, to) {
  if (!task) return null;
  return {
    get signal() {
      return task.signal;
    },
    update({ detail, progress, title } = {}) {
      task.update({ detail, title, progress: progress === null || progress === undefined ? progress : from + (to - from) * progress });
    },
  };
}

async function runTask(title, opts, meta, fn) {
  if (opts.task) return fn(opts.task);
  if (opts.quiet) return fn(null);
  return tasks.run(title, fn, meta);
}

function aborted(task) {
  if (task?.signal?.aborted) throw task.signal.reason || new Error('aborted');
}

// Compara una instantanea anterior con la lista nueva: 'same' | 'minor' (solo configuracion u opciones) | 'different'
function verdict(prev, files, meta, worlds) {
  const pw = [...(prev.worlds || [])].sort().join('\n');
  if (pw !== [...worlds].sort().join('\n')) return 'different';
  if (metaKey(prev.instance) !== metaKey(meta)) return 'different';
  const before = new Map(prev.files.map((f) => [f.p, f.h]));
  let minorOnly = true;
  let same = before.size === files.length;
  const touched = (p) => {
    same = false;
    const r = rootOf(p);
    if (!r || CONTENT_ROOTS.includes(r) || r.startsWith('saves/')) minorOnly = false;
  };
  for (const f of files) {
    const h = before.get(f.p);
    if (h !== f.h) touched(f.p);
    before.delete(f.p);
  }
  for (const p of before.keys()) touched(p);
  if (same) return 'same';
  return minorOnly ? 'minor' : 'different';
}

// ---------- Crear ----------

async function createUnlocked(inst, opts, task) {
  const worlds = await resolveWorlds(inst.dir, opts.worlds);
  if (worlds.length && isRunning(inst.id)) throw userError('snapshots.errRunningWorlds');
  const startedAt = Date.now();
  task?.update({ detail: t('snapshots.stepScan'), progress: null });
  const scanned = await scan(inst.dir, { worlds, signal: task?.signal });
  const cache = await store.loadStatCache(inst.id);
  const index = await store.loadIndex(inst.id);
  const total = scanned.files.reduce((a, f) => a + f.size, 0);

  return store.withStore(false, async () => {
    const files = [];
    const skipped = [];
    let done = 0;
    let stored = 0;
    let linked = 0;
    let newFiles = 0;
    let lastTick = 0;
    for (const f of scanned.files) {
      aborted(task);
      let h = cache.lookup(f);
      if (h && !(await store.exists(store.objectPath(h)))) h = null;
      if (!h) {
        try {
          const r = await store.ingest(f.abs, f, { allowLink: f.link });
          h = r.h;
          stored += r.stored;
          linked += r.linked;
          if (r.stored || r.linked) newFiles++;
        } catch (err) {
          if (err.code === 'ENOENT') continue; // se borro mientras se guardaba
          if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
            skipped.push(f.rel); // archivo bloqueado por otro programa: al restaurar no se toca
            continue;
          }
          throw friendly(err);
        }
      }
      files.push({ p: f.rel, h, s: f.size, m: f.mtime });
      done += f.size;
      const now = Date.now();
      if (task && now - lastTick > 150) {
        lastTick = now;
        task.update({ detail: t('snapshots.stepSaving', { done: fmtBytes(done), total: fmtBytes(total) }), progress: total ? done / total : null });
      }
    }

    // Cache de hashes: se reemplazan las entradas de lo recorrido y se conservan las de otros mundos.
    const scannedRoots = new Set([...scanned.roots, ...worlds.map((w) => `saves/${w}`)]);
    const nextCache = {};
    for (const [rel, e] of Object.entries(cache.files)) {
      const r = rootOf(rel);
      if (r && !scannedRoots.has(r) && Array.isArray(e) && e[1] < cache.at - 2000) nextCache[rel] = e;
    }
    for (const f of files) nextCache[f.p] = [f.s, f.m, f.h];
    await store.saveStatCache(inst.id, { at: startedAt, files: nextCache }).catch(() => {});

    const meta = instanceMeta(inst);
    const latest = index.items[0] || null;
    if (latest && (opts.skipIfUnchanged || opts.throttleMs)) {
      const prev = await store.readManifest(inst.id, latest.id).catch(() => null);
      if (prev) {
        const v = verdict(prev, files, meta, worlds);
        if (v === 'same' && opts.skipIfUnchanged) return { ...store.summarize(prev), reused: true };
        if (v === 'minor' && opts.throttleMs && Date.now() - prev.createdAt < opts.throttleMs) return { ...store.summarize(prev), reused: true };
      }
    }

    const createdAt = Date.now();
    const manifest = {
      id: store.newSnapId(new Date(createdAt)),
      instanceId: inst.id,
      createdAt,
      kind: opts.kind === 'manual' ? 'manual' : 'auto',
      reason: typeof opts.reason === 'string' ? opts.reason.trim().slice(0, 120) : '',
      reasonCode: REASON_CODES.has(opts.reasonCode) ? opts.reasonCode : opts.kind === 'manual' ? 'manual' : null,
      label: typeof opts.label === 'string' ? opts.label.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
      pinned: Boolean(opts.pinned),
      worlds,
      roots: scanned.roots,
      instance: meta,
      skipped,
      files,
      stats: { files: files.length, bytes: total, newBytes: stored + linked, storedBytes: stored, linkedBytes: linked, newFiles },
    };
    try {
      await store.writeManifest(inst.id, manifest);
    } catch (err) {
      throw friendly(err);
    }
    const summary = store.summarize(manifest);
    index.items = [summary, ...index.items.filter((s) => s.id !== summary.id)];
    await store.saveIndex(inst.id, index).catch(() => {});
    return summary;
  });
}

/**
 * Crea una instantanea. opts: { reason, reasonCode, label, kind: 'manual'|'auto', worlds: 'none'|'all'|[carpetas],
 *   skipIfUnchanged, throttleMs, quiet (sin tarea visible), task (tarea de quien llama), pinned }
 * Devuelve el resumen ({ id, createdAt, stats... }); con reused: true si se reutilizo la ultima (no cambio nada).
 */
async function create(instanceId, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const inst = await instances.get(instanceId);
  const auto = o.kind !== 'manual';
  const options = { ...o, skipIfUnchanged: o.skipIfUnchanged ?? auto };
  const summary = await store.withInstance(inst.id, () =>
    runTask(t('snapshots.taskCreate', { name: inst.name }), options, { instanceId: inst.id, kind: 'snapshots:create' }, async (task) => {
      try {
        notBisecting(inst.id); // con la tarea ya creada: una busqueda no puede empezar mientras se guarda
        return await createUnlocked(inst, options, task);
      } catch (err) {
        throw friendly(err);
      }
    }),
  );
  if (!summary.reused) {
    notify(inst.id);
    if (auto) schedulePrune(inst.id);
  }
  return summary;
}

// ---------- Listar y detalles ----------

// list(instanceId) -> resumenes de esa instancia (mas nueva primero).
// list() -> [{ instanceId, exists, items }] de todas las instancias con instantaneas.
async function list(instanceId) {
  if (!instanceId) {
    const out = [];
    for (const id of await store.snapshotInstances()) {
      const exists = await instances.get(id).then(() => true, () => false);
      out.push({ instanceId: id, exists, items: (await store.loadIndex(id)).items });
    }
    return out;
  }
  await instances.get(instanceId);
  const index = await store.loadIndex(instanceId);
  return index.items;
}

const GROUPS = [
  { key: 'mods', roots: ['mods'] },
  { key: 'packs', roots: ['resourcepacks', 'shaderpacks'] },
  { key: 'config', roots: ['config', 'defaultconfigs', 'kubejs', 'scripts'] },
  { key: 'options', roots: ['options.txt', 'optionsof.txt', 'optionsshaders.txt'] },
  { key: 'modpack', roots: ['.venus/pack-index.json', '.venus/pack-files.json'] },
];
const GROUP_OF = Object.fromEntries(GROUPS.flatMap((g) => g.roots.map((r) => [r, g.key])));
const LIST_LIMIT = 60;

async function currentHash(f, cache) {
  return cache.lookup(f) || store.hashFile(f.abs, f.size).catch(() => null);
}

// Que cambiaria si se restaura: add = vuelve a aparecer, remove = se quita, change = vuelve a la version guardada.
async function compare(instanceId, snapId) {
  const inst = await instances.get(instanceId);
  let manifest;
  try {
    manifest = await store.readManifest(instanceId, snapId);
  } catch {
    throw userError('snapshots.errNotFound');
  }
  const roots = (manifest.roots || []).filter((r) => ROOT_KEYS.includes(r));
  const current = await scan(inst.dir, { roots });
  const cache = await store.loadStatCache(instanceId);
  const cur = new Map(current.files.map((f) => [f.rel, f]));
  const skipped = new Set(manifest.skipped || []);
  const groups = Object.fromEntries(GROUPS.map((g) => [g.key, { key: g.key, add: [], remove: [], change: [], same: 0 }]));
  const label = (g, p) => (g === 'mods' || g === 'packs' ? p.slice(p.indexOf('/') + 1) : p);
  for (const f of manifest.files) {
    const r = rootOf(f.p);
    const g = GROUP_OF[r];
    if (!g || !roots.includes(r)) continue;
    const c = cur.get(f.p);
    cur.delete(f.p);
    if (!c) groups[g].add.push(label(g, f.p));
    else if (c.size !== f.s || (await currentHash(c, cache)) !== f.h) groups[g].change.push(label(g, f.p));
    else groups[g].same++;
  }
  for (const c of cur.values()) {
    if (skipped.has(c.rel)) continue;
    const g = GROUP_OF[rootOf(c.rel)];
    if (g) groups[g].remove.push(label(g, c.rel));
  }
  const out = GROUPS.map((g) => {
    const x = groups[g.key];
    return {
      key: g.key,
      counts: { add: x.add.length, remove: x.remove.length, change: x.change.length, same: x.same },
      add: x.add.sort().slice(0, LIST_LIMIT),
      remove: x.remove.sort().slice(0, LIST_LIMIT),
      change: x.change.sort().slice(0, LIST_LIMIT),
    };
  });
  const nowWorlds = await listWorldFolders(inst.dir);
  const m = manifest.instance || {};
  return {
    id: manifest.id,
    groups: out,
    worlds: (manifest.worlds || []).map((w) => ({ folder: w, exists: nowWorlds.includes(w), files: manifest.files.filter((f) => f.p.startsWith(`saves/${w}/`)).length })),
    instance: {
      from: { mcVersion: inst.mcVersion, loader: inst.loader, loaderVersion: inst.loaderVersion || null },
      to: { mcVersion: m.mcVersion || inst.mcVersion, loader: m.loader || inst.loader, loaderVersion: m.loaderVersion || null },
      changed: Boolean(m.mcVersion && (m.mcVersion !== inst.mcVersion || m.loader !== inst.loader || (m.loaderVersion || null) !== (inst.loaderVersion || null))),
    },
    total: out.reduce((a, g) => ({ add: a.add + g.counts.add, remove: a.remove + g.counts.remove, change: a.change + g.counts.change }), { add: 0, remove: 0, change: 0 }),
  };
}

// ---------- Restaurar ----------

function pickRestoreWorlds(manifest, sel) {
  const have = manifest.worlds || [];
  if (!sel || sel === 'none') return [];
  if (sel === 'all' || sel === true) return [...have];
  if (Array.isArray(sel)) return have.filter((w) => sel.includes(w));
  return [];
}

async function pruneEmptyDirs(dir, keep = true) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) await pruneEmptyDirs(path.join(dir, e.name), false);
  if (keep) return;
  if (!(await fsp.readdir(dir).catch(() => ['x'])).length) await fsp.rmdir(dir).catch(() => {});
}

async function applyManifest(inst, manifest, worlds, task) {
  const base = path.resolve(inst.dir);
  const roots = (manifest.roots || []).filter((r) => ROOT_KEYS.includes(r));
  const scope = new Set([...roots, ...worlds.map((w) => `saves/${w}`)]);
  const wanted = manifest.files.filter((f) => scope.has(rootOf(f.p)) && safeRel(f.p) && store.isHash(f.h));
  const skipped = new Set(manifest.skipped || []);
  task?.update({ detail: t('snapshots.stepCompare'), progress: 0 });
  const current = await scan(inst.dir, { roots, worlds, signal: task?.signal });
  const cache = await store.loadStatCache(inst.id);
  const cur = new Map(current.files.map((f) => [f.rel, f]));
  const toCopy = [];
  let unchanged = 0;
  for (const f of wanted) {
    aborted(task);
    const c = cur.get(f.p);
    cur.delete(f.p);
    if (c && c.size === f.s && (await currentHash(c, cache)) === f.h) {
      unchanged++;
      continue;
    }
    toCopy.push(f);
  }
  const toDelete = [...cur.values()].filter((f) => !skipped.has(f.rel));

  // Antes de tocar nada: que esten todos los objetos y con el tamanio correcto.
  for (const f of toCopy) {
    const st = await fsp.stat(store.objectPath(f.h)).catch(() => null);
    if (!st || st.size !== f.s) throw userError('snapshots.errMissingObjects');
  }

  for (const f of toDelete) {
    aborted(task);
    try {
      await fsp.rm(f.abs, { force: true, maxRetries: 3, retryDelay: 150 });
    } catch (err) {
      throw friendly(err);
    }
  }
  const total = toCopy.reduce((a, f) => a + f.s, 0);
  let done = 0;
  let lastTick = 0;
  const restoredCache = {};
  for (const f of toCopy) {
    aborted(task);
    const dest = path.resolve(base, ...f.p.split('/'));
    if (!dest.startsWith(base + path.sep)) continue;
    try {
      await store.materialize(f.h, dest, { mtime: f.m, rel: f.p });
    } catch (err) {
      throw friendly(err);
    }
    restoredCache[f.p] = [f.s, f.m, f.h];
    done += f.s;
    const now = Date.now();
    if (task && now - lastTick > 150) {
      lastTick = now;
      task.update({ detail: t('snapshots.stepRestoring', { done: fmtBytes(done), total: fmtBytes(total) }), progress: total ? done / total : 1 });
    }
  }
  // Carpetas vacias que quedaron (sin borrar las carpetas raiz)
  for (const key of scope) {
    if (!DIR_ROOTS.has(key) && !key.startsWith('saves/')) continue; // archivos sueltos
    await pruneEmptyDirs(path.join(base, ...key.split('/')), true);
  }
  // Los archivos restaurados tienen la fecha del manifiesto: la cache los reconoce sin volver a leerlos.
  if (Object.keys(restoredCache).length) {
    const fresh = await store.loadStatCache(inst.id);
    await store.saveStatCache(inst.id, { at: fresh.at, files: { ...fresh.files, ...restoredCache } }).catch(() => {});
  }
  return { restored: toCopy.length, removed: toDelete.length, unchanged };
}

// Vuelve version, loader y registros a los de la instantanea. Se compara y se escribe dentro de la cola de
// la instancia (con funcion: los registros guardados mandan, aunque haya archivos que no los tengan).
async function restoreMeta(inst, manifest) {
  const m = manifest.instance;
  if (!m || typeof m !== 'object') return false;
  let changed = false;
  await instances.update(inst.id, (cur) => {
    const patch = {};
    if (typeof m.mcVersion === 'string' && m.mcVersion && m.mcVersion !== cur.mcVersion) patch.mcVersion = m.mcVersion;
    if (typeof m.loader === 'string' && LOADERS.has(m.loader) && m.loader !== cur.loader) patch.loader = m.loader;
    if ((m.loaderVersion ?? null) !== (cur.loaderVersion ?? null) && (typeof m.loaderVersion === 'string' || m.loaderVersion === null)) patch.loaderVersion = m.loaderVersion || 'latest';
    if ((m.preset ?? null) !== (cur.preset ?? null)) patch.preset = m.preset ?? null;
    if ((m.versionId ?? null) !== (cur.versionId ?? null)) patch.versionId = m.versionId ?? null;
    if (m.modrinth !== undefined && JSON.stringify(m.modrinth) !== JSON.stringify(cur.modrinth ?? null)) patch.modrinth = m.modrinth || { projects: {}, pack: null };
    if (m.curseforge !== undefined && JSON.stringify(m.curseforge) !== JSON.stringify(cur.curseforge ?? null)) patch.curseforge = m.curseforge;
    changed = Object.keys(patch).length > 0;
    return changed ? patch : null;
  });
  return changed;
}

/**
 * Restaura una instantanea: primero guarda el estado actual (para poder deshacer), despues deja las carpetas
 * guardadas igual que en el manifiesto y vuelve la version/loader de la instancia. opts: { worlds: 'none'|'all'|[carpetas] }
 */
async function restore(instanceId, snapId, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const inst = await instances.get(instanceId);
  if (isRunning(inst.id)) throw userError('snapshots.errRunning');
  notBisecting(inst.id);
  const result = await store.withInstance(inst.id, async () => {
    let manifest;
    try {
      manifest = await store.readManifest(inst.id, snapId);
    } catch {
      throw userError('snapshots.errNotFound');
    }
    const worlds = pickRestoreWorlds(manifest, o.worlds);
    return runTask(t('snapshots.taskRestore', { name: inst.name }), o, { instanceId: inst.id, kind: 'snapshots:restore' }, async (task) => {
      try {
        notBisecting(inst.id);
        task?.update({ detail: t('snapshots.stepSafety'), progress: 0 });
        const existing = await listWorldFolders(inst.dir);
        const safety = await createUnlocked(
          inst,
          { kind: 'auto', reasonCode: 'beforeRestore', worlds: worlds.filter((w) => existing.includes(w)), skipIfUnchanged: true },
          scaled(task, 0, 0.4),
        );
        if (isRunning(inst.id)) throw userError('snapshots.errRunning');
        const applied = await store.withStore(false, () => applyManifest(inst, manifest, worlds, scaled(task, 0.4, 1)));
        const fresh = await instances.get(inst.id);
        const metaChanged = await restoreMeta(fresh, manifest);
        return { ...applied, metaChanged, worlds, safetyId: safety?.id || null, safetyReused: Boolean(safety?.reused), snapshotId: manifest.id };
      } catch (err) {
        throw friendly(err);
      }
    });
  });
  notify(inst.id, { instances: true });
  return result;
}

// ---------- Borrar, editar y retencion ----------

let gcTimer = null;
let gcWaiters = [];
function scheduleGc(delay = 1500) {
  clearTimeout(gcTimer);
  return new Promise((resolve) => {
    gcWaiters.push(resolve);
    gcTimer = setTimeout(async () => {
      const waiters = gcWaiters;
      gcWaiters = [];
      let r = { removed: 0, freed: 0 };
      try {
        r = await store.gc();
      } catch (err) {
        console.warn('[snapshots] gc', err?.message || err);
      }
      for (const w of waiters) w(r);
    }, delay);
  });
}

async function removeUnlocked(instanceId, ids) {
  const index = await store.loadIndex(instanceId);
  const drop = new Set(ids.filter(store.isSnapId));
  for (const id of drop) await store.deleteManifest(instanceId, id);
  index.items = index.items.filter((s) => !drop.has(s.id));
  await store.saveIndex(instanceId, index).catch(() => {});
  return drop.size;
}

async function remove(instanceId, snapId) {
  if (!store.isSnapId(snapId)) throw userError('snapshots.errNotFound');
  await instances.get(instanceId);
  await store.withInstance(instanceId, () => removeUnlocked(instanceId, [snapId]));
  notify(instanceId);
  scheduleGc();
  return true;
}

async function update(instanceId, snapId, patch = {}) {
  await instances.get(instanceId);
  const summary = await store.withInstance(instanceId, async () => {
    let m;
    try {
      m = await store.readManifest(instanceId, snapId);
    } catch {
      throw userError('snapshots.errNotFound');
    }
    if (typeof patch.label === 'string') m.label = patch.label.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (typeof patch.pinned === 'boolean') m.pinned = patch.pinned;
    await store.writeManifest(instanceId, m);
    const index = await store.loadIndex(instanceId);
    const s = store.summarize(m);
    index.items = index.items.map((x) => (x.id === s.id ? s : x));
    await store.saveIndex(instanceId, index).catch(() => {});
    return s;
  });
  notify(instanceId);
  return summary;
}

// Que automaticas sobran segun la retencion (las manuales y las fijadas nunca se borran solas).
function pruneCandidates(items, cfg, now = Date.now()) {
  const autos = items.filter((s) => s.kind !== 'manual' && !s.pinned).sort((a, b) => b.createdAt - a.createdAt);
  const floor = Math.min(KEEP_MIN_AUTO, cfg.keepAuto);
  return autos.filter((s, i) => i >= cfg.keepAuto || (cfg.keepDays > 0 && i >= floor && now - s.createdAt > cfg.keepDays * DAY)).map((s) => s.id);
}

async function pruneInstance(instanceId, cfg) {
  return store.withInstance(instanceId, async () => {
    const index = await store.loadIndex(instanceId);
    const ids = pruneCandidates(index.items, cfg);
    if (!ids.length) return 0;
    return removeUnlocked(instanceId, ids);
  });
}

async function prune(instanceId) {
  const cfg = await getSettings();
  const ids = instanceId ? [instanceId] : await store.snapshotInstances();
  let removed = 0;
  for (const id of ids) {
    if (instanceId) await instances.get(id);
    const n = await pruneInstance(id, cfg);
    removed += n;
    if (n) notify(id);
  }
  const gcResult = removed ? await scheduleGc(200) : { removed: 0, freed: 0 };
  return { removed, freed: gcResult.freed || 0 };
}

const pruneTimers = new Map();
function schedulePrune(instanceId) {
  clearTimeout(pruneTimers.get(instanceId));
  pruneTimers.set(
    instanceId,
    setTimeout(() => {
      pruneTimers.delete(instanceId);
      getSettings()
        .then((cfg) => pruneInstance(instanceId, cfg))
        .then((n) => {
          if (n) {
            notify(instanceId);
            scheduleGc();
          }
        })
        .catch((err) => console.warn('[snapshots] prune', err?.message || err));
    }, 1000),
  );
}

// ---------- Espacio usado ----------

let usageCache = null;
async function usage(instanceId) {
  if (!usageCache || Date.now() - usageCache.at > 30000) usageCache = { at: Date.now(), value: await store.storeUsage() };
  const out = { store: usageCache.value, instance: null, orphans: [] };
  for (const id of await store.snapshotInstances()) {
    let exists = true;
    try {
      await instances.get(id);
    } catch {
      exists = false;
    }
    if (!exists) out.orphans.push({ instanceId: id, count: (await store.manifestIds(id)).length });
  }
  if (instanceId) {
    await instances.get(instanceId);
    const index = await store.loadIndex(instanceId);
    out.instance = {
      count: index.items.length,
      manual: index.items.filter((s) => s.kind === 'manual').length,
      auto: index.items.filter((s) => s.kind !== 'manual').length,
      pinned: index.items.filter((s) => s.pinned).length,
      // lo que suma cada instantanea al crearse (sin leer todos los manifiestos)
      addedBytes: index.items.reduce((a, s) => a + (s.stats?.newBytes || 0), 0),
    };
  }
  return out;
}

function invalidateUsage() {
  usageCache = null;
}

// Borra las instantaneas de instancias que ya no existen.
async function cleanOrphans() {
  let removed = 0;
  for (const id of await store.snapshotInstances()) {
    try {
      await instances.get(id);
      continue;
    } catch {
      /* la instancia ya no existe */
    }
    removed += await store.withInstance(id, async () => {
      const ids = await store.manifestIds(id);
      for (const snapId of ids) await store.deleteManifest(id, snapId);
      for (const name of ['index.json', 'statcache.json']) await fsp.rm(path.join(store.instanceDir(id), name), { force: true }).catch(() => {});
      if (id !== 'objects') await fsp.rmdir(store.instanceDir(id)).catch(() => {});
      return ids.length;
    });
  }
  const r = await scheduleGc(100);
  invalidateUsage();
  return { removed, freed: r.freed || 0 };
}

async function gcNow() {
  const r = await scheduleGc(0);
  invalidateUsage();
  return r;
}

// Mundos de la instancia con su tamanio (para elegir cuales guardar).
async function worlds(instanceId) {
  const inst = await instances.get(instanceId);
  const list = await instances.content(inst.id, 'saves').catch(() => []);
  const index = await store.loadIndex(inst.id);
  const saved = new Map();
  for (const s of index.items) for (const w of s.worlds || []) if (!saved.has(w)) saved.set(w, s.createdAt);
  return Promise.all(
    list.map(async (w) => ({
      folder: w.folder,
      name: w.displayName || w.folder,
      lastPlayed: w.lastPlayed || 0,
      icon: w.icon || null,
      iconTime: w.iconTime || 0,
      version: w.version || null,
      size: await dirSize(path.join(inst.dir, 'saves', w.folder)),
      lastSnapshot: saved.get(w.folder) || null,
    })),
  );
}

module.exports = {
  DEFAULTS,
  normalizeSettings,
  getSettings,
  setNotifier,
  create,
  list,
  compare,
  restore,
  remove,
  update,
  prune,
  pruneCandidates,
  usage,
  invalidateUsage,
  cleanOrphans,
  gcNow,
  worlds,
  isRunning,
  fmtBytes,
};
