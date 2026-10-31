'use strict';
// Inventario de lo instalado en una instancia o servidor: archivos, sha1 (con caché), identificación
// en Modrinth (versión con sus dependencias) y metadatos del propio archivo (ids de mod, breaks, rangos).
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../../core/paths');
const { readJson, writeJson, hashFile } = require('../../core/util');
const api = require('./api');
const zip = require('./zip');
const { readMeta } = require('./meta');

const CONTENT_RE = {
  mods: /\.(jar|zip|litemod)(\.disabled)?$/i,
  plugins: /\.jar(\.disabled)?$/i,
  resourcepacks: /\.zip(\.disabled)?$/i,
  shaderpacks: /\.zip(\.disabled)?$/i,
};

let hashCache = null;
let metaCache = null;
let dirty = false;
let saveTimer = null;

const cacheFile = (name) => paths.cache('compat', name);

async function loadCaches() {
  if (hashCache) return;
  hashCache = await readJson(cacheFile('hashes.json'), {});
  metaCache = await readJson(cacheFile('meta.json'), {});
}

function prune(obj, max) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return;
  keys.sort((a, b) => (obj[a]?.at || 0) - (obj[b]?.at || 0));
  for (const k of keys.slice(0, keys.length - max)) delete obj[k];
}

async function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty || !hashCache) return;
  dirty = false;
  prune(hashCache, 8000);
  prune(metaCache, 3000);
  await writeJson(cacheFile('hashes.json'), hashCache).catch(() => {});
  await writeJson(cacheFile('meta.json'), metaCache).catch(() => {});
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => flush().catch(() => {}), 1500);
  saveTimer.unref?.();
}

async function listFolder(baseDir, folder) {
  let entries = [];
  try {
    entries = await fsp.readdir(path.join(baseDir, folder), { withFileTypes: true });
  } catch {
    return [];
  }
  const re = CONTENT_RE[folder] || /\.(jar|zip)(\.disabled)?$/i;
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !re.test(e.name)) continue;
    const full = path.join(baseDir, folder, e.name);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) continue;
    out.push({
      folder,
      file: e.name,
      name: e.name.replace(/\.disabled$/i, ''),
      enabled: !/\.disabled$/i.test(e.name),
      size: st.size,
      mtime: Math.round(st.mtimeMs),
      path: full,
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

async function sha1Of(f) {
  await loadCaches();
  const c = hashCache[f.path];
  if (c && c.size === f.size && c.mtime === f.mtime) return c.sha1;
  const sha1 = await hashFile(f.path, 'sha1');
  hashCache[f.path] = { size: f.size, mtime: f.mtime, sha1, at: Date.now() };
  scheduleSave();
  return sha1;
}

// Solo lo necesario de los metadatos (para que la cache no crezca de mas)
function compact(meta) {
  if (!meta) return null;
  return {
    kind: meta.kind,
    mods: (meta.mods || []).map((m) => ({ id: m.id, version: m.version, name: m.name, env: m.env, provides: m.provides, depends: m.depends, breaks: m.breaks, conflicts: m.conflicts, deps: m.deps })),
    pack: meta.pack || null,
    plugin: meta.plugin || null,
  };
}

async function localMeta(f) {
  await loadCaches();
  const hit = metaCache[f.sha1];
  if (hit) {
    hit.at = Date.now();
    return hit;
  }
  let meta;
  try {
    const src = await zip.fileSource(f.path);
    try {
      meta = compact(await readMeta(src));
    } finally {
      await src.close();
    }
  } catch {
    meta = { kind: 'unknown', mods: [], pack: null, plugin: null, error: true };
  }
  metaCache[f.sha1] = { ...meta, at: Date.now() };
  scheduleSave();
  return metaCache[f.sha1];
}

// Metadatos de un archivo de Modrinth (sin descargarlo entero). file = version.files[n]
async function remoteMeta(file, { signal } = {}) {
  const sha1 = file?.hashes?.sha1;
  if (!sha1 || !file.url || !file.size) return null;
  await loadCaches();
  const hit = metaCache[sha1];
  if (hit && !(hit.failed && Date.now() - hit.at > 3600 * 1000)) {
    if (hit.failed) return null;
    hit.at = Date.now();
    return hit;
  }
  try {
    const src = zip.urlSource(file.url, file.size, { userAgent: api.userAgent(), signal });
    metaCache[sha1] = { ...compact(await readMeta(src)), at: Date.now() };
  } catch {
    if (signal?.aborted) return null;
    metaCache[sha1] = { failed: true, at: Date.now() };
  }
  scheduleSave();
  return metaCache[sha1].failed ? null : metaCache[sha1];
}

// Los ids de mod se comparan sin mayusculas; los ids de proyecto de Modrinth distinguen mayusculas.
function push(map, key, value, lower = true) {
  if (!key) return;
  const k = lower ? String(key).toLowerCase() : String(key);
  if (!map.has(k)) map.set(k, []);
  if (!map.get(k).includes(value)) map.get(k).push(value);
}

// target: { dir, records, folders }. Devuelve { files, byProject, byModId, byPlugin }
async function scan(target, { folders = target.folders, meta = true, identify = true, signal, onProgress } = {}) {
  await loadCaches();
  const files = [];
  for (const folder of folders) files.push(...(await listFolder(target.dir, folder)));
  let n = 0;
  for (const f of files) {
    if (signal?.aborted) throw signal.reason || new Error('Cancelado');
    f.sha1 = await sha1Of(f).catch(() => null);
    onProgress?.(++n, files.length);
  }
  let byHash = {};
  if (identify) {
    try {
      byHash = await api.versionsByHash(files.map((f) => f.sha1), { signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      byHash = {};
    }
  }
  const recByFile = new Map();
  for (const [pid, rec] of Object.entries(target.records || {})) if (rec?.file) recByFile.set(String(rec.file).replace(/\.disabled$/i, ''), { ...rec, projectId: pid });
  for (const f of files) {
    const v = (f.sha1 && byHash[f.sha1]) || null;
    const rec = recByFile.get(f.name) || null;
    f.version = v;
    f.record = rec;
    f.projectId = v?.project_id || rec?.projectId || null;
    f.versionId = v?.id || rec?.versionId || null;
    f.versionNumber = v?.version_number || rec?.versionNumber || null;
    f.title = rec?.title || null;
    f.icon = rec?.icon || null;
    f.meta = null;
  }
  if (meta) {
    for (const f of files) {
      if (signal?.aborted) throw signal.reason || new Error('Cancelado');
      if ((f.folder === 'mods' || f.folder === 'plugins') && f.sha1) f.meta = await localMeta(f);
    }
  }
  const byProject = new Map();
  const byModId = new Map();
  const byPlugin = new Map();
  for (const f of files) {
    if (f.projectId) push(byProject, f.projectId, f, false);
    for (const m of f.meta?.mods || []) {
      push(byModId, m.id, f);
      for (const p of m.provides || []) push(byModId, p, f);
    }
    if (f.meta?.plugin?.name) push(byPlugin, f.meta.plugin.name, f);
  }
  return { files, byProject, byModId, byPlugin };
}

module.exports = { scan, listFolder, remoteMeta, localMeta, sha1Of, flush };
