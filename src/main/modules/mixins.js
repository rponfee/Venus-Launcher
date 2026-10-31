'use strict';
// Conflictos de mixins entre los mods de una instancia (módulo "analysis").
//  - mixins:analyze(instanceId) -> informe completo (tarea con progreso; cada jar se cachea por SHA-1)
//  - mixins:results(instanceId) -> último informe guardado (recalculado desde la cache) o null
// Antes de jugar avisa de los choques graves usando solo la cache (nunca demora el arranque).
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const paths = require('../core/paths');
const instances = require('../core/instances');
const tasks = require('../core/tasks');
const { t } = require('../core/i18n');
const { readJson } = require('../core/util');
const { extractMixins, MIXIN_VERSION } = require('./jarscan/mixin-scan');
const { computeConflicts } = require('./jarscan/mixin-conflicts');
const { writeCompactJson } = require('./jarscan/store');

const CACHE_VERSION = 1;
const MAX_JARS = 3000;
const FILE_TTL = 120 * 24 * 3600 * 1000;
const MOD_LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge', 'legacyfabric', 'babric', 'optifine']);

let emit = () => {};
let cache = null;
let cacheLoading = null;
let saveTimer = null;
let saving = Promise.resolve();

const cacheFile = () => paths.data('mixins-cache.json');
const fileKey = (full) => path.resolve(full).toLowerCase();

async function loadCache() {
  if (cache) return cache;
  if (!cacheLoading) {
    cacheLoading = readJson(cacheFile(), null).then((c) => {
      cache = c && c.v === CACHE_VERSION ? c : { v: CACHE_VERSION, jars: {}, files: {}, instances: {} };
      for (const k of ['jars', 'files', 'instances']) if (!cache[k] || typeof cache[k] !== 'object') cache[k] = {};
      return cache;
    });
  }
  return cacheLoading;
}

function prune(c) {
  const now = Date.now();
  for (const [k, f] of Object.entries(c.files)) if (!f || now - (f.seen || 0) > FILE_TTL) delete c.files[k];
  const jars = Object.entries(c.jars);
  if (jars.length > MAX_JARS) {
    jars.sort((a, b) => (a[1].seen || 0) - (b[1].seen || 0));
    for (const [sha1] of jars.slice(0, jars.length - MAX_JARS)) delete c.jars[sha1];
  }
}

// Guarda la cache un rato después del último cambio. Todos los que esperan se liberan con la misma escritura.
let waiters = [];
function saveSoon(delay = 400) {
  clearTimeout(saveTimer);
  return new Promise((resolve) => {
    waiters.push(resolve);
    saveTimer = setTimeout(() => {
      const batch = waiters;
      waiters = [];
      saving = saving
        .then(async () => {
          if (!cache) return;
          prune(cache);
          await writeCompactJson(cacheFile(), cache);
        })
        .catch((err) => console.warn('[mixins] no se pudo guardar la cache', err?.message || err))
        .then(() => batch.forEach((fn) => fn()));
    }, delay);
  });
}

async function listMods(dir) {
  const base = path.join(dir, 'mods');
  const entries = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !/\.jar$/i.test(e.name)) continue; // los .disabled no se cargan
    const full = path.join(base, e.name);
    const st = await fsp.stat(full).catch(() => null);
    if (st) out.push({ file: e.name, full, size: st.size, mtime: Math.round(st.mtimeMs) });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

// Registros de mods de un jar (con el archivo de origen) a partir de la cache.
function modsOf(jarEntry, f) {
  return (jarEntry?.mods || []).map((m) => ({ ...m, key: `${f.file}|${m.path || ''}`, file: f.file }));
}

function shortName(cls) {
  return cls.slice(cls.lastIndexOf('/') + 1);
}

// Informe para la interfaz: mods sin los datos pesados + conflictos + clases más tocadas.
function buildReport(inst, res, extra = {}) {
  const mods = res.mods.map((m) => ({
    name: m.name || m.id || m.file,
    id: m.id || '',
    version: m.version || '',
    file: m.file,
    nested: m.path ? m.path.split('!/').pop() : null,
    mixins: m.mixins?.length || 0,
    injections: (m.mixins || []).reduce((a, x) => a + x.inj.length + x.ow.length, 0),
    configs: (m.configs || []).length,
    plugin: (m.configs || []).some((cfg) => cfg.plugin),
    dynamic: (m.mixins || []).some((x) => x.dyn),
    errors: (m.errors || []).length,
  }));
  const counts = { high: 0, medium: 0, info: 0 };
  for (const c of res.conflicts) counts[c.severity]++;
  return {
    instance: { id: inst.id, name: inst.name, loader: inst.loader, mcVersion: inst.mcVersion },
    analyzedAt: extra.analyzedAt || Date.now(),
    durationMs: extra.durationMs || 0,
    files: extra.files || 0,
    unreadable: extra.unreadable || [],
    mods,
    conflicts: res.conflicts.map((c) => ({ ...c, target: { ...c.target, short: shortName(c.target.cls) } })),
    hot: res.hot,
    stats: { ...res.stats, files: extra.files || 0 },
    counts,
    clean: !counts.high && !counts.medium,
  };
}

const running = new Map();

async function analyze(instanceId, opts = {}) {
  const inst = await instances.get(instanceId);
  if (!MOD_LOADERS.has(inst.loader)) throw new Error(t('analysis.errNoMods'));
  if (running.has(inst.id)) return running.get(inst.id);
  const p = tasks
    .run(t('analysis.taskMixins', { name: inst.name }), (task) => doAnalyze(inst, task, opts), { kind: 'analysis:mixins', analysisTarget: `instance:${inst.id}` })
    .finally(() => running.delete(inst.id));
  running.set(inst.id, p);
  return p;
}

async function doAnalyze(inst, task, { deep = false } = {}) {
  const started = Date.now();
  const c = await loadCache();
  const files = await listMods(inst.dir);
  const all = [];
  const unreadable = [];
  const progress = (data) => {
    try {
      emit('mixins:progress', { instanceId: inst.id, taskId: task?.id || null, ...data });
    } catch {
      /* ventana cerrada */
    }
  };
  let done = 0;
  for (const f of files) {
    if (task?.signal?.aborted) throw task.signal.reason || new Error('aborted');
    task?.update({ detail: t('analysis.detailMixins', { file: f.file, done: done + 1, total: files.length }), progress: files.length ? (done / files.length) * 0.92 : 0 });
    progress({ phase: 'read', done, total: files.length, file: f.file });
    const key = fileKey(f.full);
    const known = c.files[key];
    let sha1 = known && known.size === f.size && known.mtime === f.mtime ? known.sha1 : null;
    let entry = sha1 ? c.jars[sha1] : null;
    if (deep || !entry || entry.v !== MIXIN_VERSION) {
      let buf;
      try {
        buf = await fsp.readFile(f.full);
      } catch {
        unreadable.push(f.file);
        done++;
        continue;
      }
      sha1 = crypto.createHash('sha1').update(buf).digest('hex');
      entry = c.jars[sha1];
      if (deep || !entry || entry.v !== MIXIN_VERSION) {
        const r = await extractMixins(buf, { env: 'client', signal: task?.signal });
        entry = { v: r.v, at: Date.now(), mods: r.mods, error: r.error || null };
        c.jars[sha1] = entry;
      }
    }
    const now = Date.now();
    c.files[key] = { size: f.size, mtime: f.mtime, sha1, seen: now };
    entry.seen = now;
    if (entry.error) unreadable.push(f.file);
    all.push(...modsOf(entry, f));
    done++;
  }
  progress({ phase: 'conflicts', done, total: files.length });
  task?.update({ detail: t('analysis.detailConflicts'), progress: 0.95 });
  await new Promise((r) => setImmediate(r));
  const res = computeConflicts(all);
  c.instances[inst.id] = { at: Date.now(), files: files.map((f) => ({ file: f.file, size: f.size, mtime: f.mtime })) };
  await saveSoon(0);
  progress({ phase: 'done', done, total: files.length });
  return buildReport(inst, res, { analyzedAt: Date.now(), durationMs: Date.now() - started, files: files.length, unreadable });
}

// Reconstruye el informe desde la cache si todos los jars actuales ya se analizaron.
// El cruce se recuerda por firma de la carpeta: lanzar varias veces seguidas no lo recalcula.
const memo = new Map(); // instanceId -> { sig, res }
async function fromCache(inst) {
  const c = await loadCache();
  const files = await listMods(inst.dir);
  const all = [];
  const sigParts = [];
  for (const f of files) {
    const known = c.files[fileKey(f.full)];
    if (!known || known.size !== f.size || known.mtime !== f.mtime) return null;
    const entry = c.jars[known.sha1];
    if (!entry || entry.v !== MIXIN_VERSION) return null;
    sigParts.push(`${f.file}|${known.sha1}`);
    all.push(...modsOf(entry, f));
  }
  const sig = sigParts.join('\n');
  let res = memo.get(inst.id)?.sig === sig ? memo.get(inst.id).res : null;
  if (!res) {
    res = computeConflicts(all);
    memo.set(inst.id, { sig, res });
  }
  return { files, res, at: c.instances[inst.id]?.at || null };
}

async function lastReport(instanceId) {
  const inst = await instances.get(instanceId);
  if (!MOD_LOADERS.has(inst.loader)) return null;
  const c = await loadCache();
  if (!c.instances[inst.id]) return null;
  const hit = await fromCache(inst);
  if (!hit) return { stale: true, analyzedAt: c.instances[inst.id].at };
  return buildReport(inst, hit.res, { analyzedAt: hit.at, files: hit.files.length });
}

// ---------- Antes de jugar ----------

async function beforeLaunch({ instance, settings: s }) {
  try {
    if ((s?.analysis || {}).launchMixins === false) return null;
    if (!MOD_LOADERS.has(instance?.loader)) return null;
    const hit = await fromCache(instance);
    if (!hit) return null;
    // Un aviso por método (un reemplazo doble y un reemplazo + inyección del mismo método se juntan)
    const byTarget = new Map();
    for (const x of hit.res.conflicts) {
      if (x.severity !== 'high') continue;
      const key = `${x.target.cls}#${x.target.method}`;
      const prev = byTarget.get(key);
      if (prev) prev.mods = [...new Set([...prev.mods, ...x.mods])];
      else byTarget.set(key, { ...x, mods: [...x.mods] });
    }
    const high = [...byTarget.values()];
    if (!high.length) return null;
    const names = (cf) => {
      const list = [...new Set(cf.mods.map((i) => hit.res.mods[i]?.name || hit.res.mods[i]?.id || '?'))];
      return list.length <= 1 ? list[0] || '?' : t('analysis.and', { a: list.slice(0, -1).join(', '), b: list[list.length - 1] });
    };
    const target = (cf) => {
      const cls = cf.target.clsName || shortName(cf.target.cls);
      const m = cf.target.methodName || cf.target.method;
      return `${cls}.${m}`;
    };
    const out = high.slice(0, 2).map((cf) => t('analysis.launchMixinWarn', { mods: names(cf), target: target(cf) }));
    if (high.length > 2) out.push(t('analysis.launchMixinMore', { count: high.length - 2 }));
    return { warnings: out };
  } catch (err) {
    console.warn('[mixins] chequeo previo', err?.message || err);
    return null;
  }
}

function register({ handle, send }) {
  emit = (channel, ...args) => {
    try {
      send(channel, ...args);
    } catch {
      /* ventana cerrada */
    }
  };
  handle('mixins:analyze', (instanceId, opts = {}) => analyze(String(instanceId || ''), { deep: Boolean(opts?.deep) }));
  handle('mixins:results', (instanceId) => lastReport(String(instanceId || '')));
  try {
    require('../core/game').addBeforeLaunch(beforeLaunch);
  } catch (err) {
    console.warn('[mixins] sin chequeo previo al lanzamiento', err?.message || err);
  }
}

module.exports = { register, analyze, lastReport, beforeLaunch, _internal: { listMods, loadCache, fromCache, resetCache: () => ((cache = null), (cacheLoading = null)) } };
