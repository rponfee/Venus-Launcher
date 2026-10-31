'use strict';
// Limpieza de disco con vista previa: cache, versiones y Java que no usa ninguna instancia ni servidor,
// copias del almacen compartido que ya nadie usa y descargas incompletas viejas.
// Todo lo que se borra se puede volver a descargar; nunca se tocan mundos, instancias ni servidores.
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../../core/paths');
const { readJson } = require('../../core/util');
const dedupe = require('./dedupe');
const usage = require('./usage');
const { walk, readdirSafe, statExact, removeTree, inside, checkAbort } = require('./fsutil');

const KINDS = ['cache', 'unusedVersions', 'unusedRuntimes', 'orphanStore', 'partials'];
const PARTIAL_RUNTIME_AGE = 60 * 60 * 1000;

// Espacio que se libera de verdad (un archivo con otros enlaces duros no libera nada al borrar uno).
async function treeSize(p, signal) {
  const st = await statExact(p).catch(() => null);
  if (!st) return { size: 0, logical: 0 };
  if (st.isFile) return { size: st.nlink > 1 ? 0 : st.size, logical: st.size };
  let size = 0;
  let logical = 0;
  await walk(p, {
    signal,
    onFile: (full, s) => {
      logical += s.size;
      if (s.nlink <= 1) size += s.size;
    },
  });
  return { size, logical };
}

function withinAny(p, set) {
  for (const a of set) if (a === p || a.startsWith(p + path.sep)) return true;
  return false;
}

// ---------- Cache ----------
async function planCache(activeParts, signal) {
  const dir = paths.cache();
  const items = [];
  for (const e of await readdirSafe(dir)) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (withinAny(full, activeParts)) continue; // descarga en curso
    const { size } = await treeSize(full, signal);
    items.push({ id: e.name, path: full, size, dir: e.isDirectory() });
  }
  items.sort((a, b) => b.size - a.size);
  return items;
}

// ---------- Versiones sin usar ----------
async function versionIndex() {
  const out = new Map();
  for (const e of await readdirSafe(paths.versions())) {
    if (!e.isDirectory()) continue;
    const json = await readJson(path.join(paths.versions(), e.name, `${e.name}.json`), null);
    out.set(e.name, { id: e.name, inheritsFrom: json && typeof json.inheritsFrom === 'string' ? json.inheritsFrom : null, valid: Boolean(json) });
  }
  return out;
}

async function usedVersions(owners, index) {
  const used = new Set();
  const addChain = (id) => {
    let cur = id;
    for (let i = 0; cur && i < 12 && !used.has(cur); i++) {
      used.add(cur);
      cur = index.get(cur)?.inheritsFrom || null;
    }
  };
  const rootOf = (id) => {
    let cur = id;
    for (let i = 0; i < 12; i++) {
      const parent = index.get(cur)?.inheritsFrom;
      if (!parent) return cur;
      cur = parent;
    }
    return cur;
  };
  for (const o of owners) {
    const m = o.meta || {};
    if (typeof m.mcVersion === 'string' && m.mcVersion) addChain(m.mcVersion);
    if (o.kind !== 'instance') continue;
    if (typeof m.versionId === 'string' && m.versionId) addChain(m.versionId);
    // Instalacion pendiente o a medias: se conservan todas las versiones de su Minecraft.
    if (!m.versionId || !m.installed) {
      for (const v of index.values()) if (rootOf(v.id) === m.mcVersion) addChain(v.id);
    }
  }
  return used;
}

async function planVersions(owners, signal) {
  const index = await versionIndex();
  const used = await usedVersions(owners, index);
  const items = [];
  for (const v of index.values()) {
    checkAbort(signal);
    if (used.has(v.id)) continue;
    const dir = path.join(paths.versions(), v.id);
    const natives = path.join(paths.root(), 'natives', v.id);
    const a = await treeSize(dir, signal);
    const b = await treeSize(natives, signal);
    items.push({ id: v.id, path: dir, extra: [natives], size: a.size + b.size, broken: !v.valid });
  }
  items.sort((a, b) => b.size - a.size);
  return items;
}

// ---------- Java sin usar ----------
function serverComponent(major) {
  const java = require('../../core/java');
  const table = Object.entries(java.MAJOR_COMPONENT)
    .map(([m, c]) => [Number(m), c])
    .sort((a, b) => a[0] - b[0]);
  const hit = table.find(([m]) => m >= major);
  return hit ? hit[1] : `adoptium-${major}`;
}

async function usedRuntimes(owners) {
  const minecraft = require('../../core/minecraft');
  const java = require('../../core/java');
  const runtimeDir = path.resolve(paths.runtime());
  const used = new Set();
  const localJava = async (id) => {
    if (!id) return null;
    try {
      return (await minecraft.resolveVersionLocal(id))?.resolved?.javaVersion || null;
    } catch {
      return null;
    }
  };
  for (const o of owners) {
    const m = o.meta || {};
    // Java elegido a mano que esta dentro de runtime/: se conserva esa carpeta.
    const custom = typeof m.java?.path === 'string' ? path.resolve(m.java.path) : '';
    if (custom && custom.startsWith(runtimeDir + path.sep)) used.add(custom.slice(runtimeDir.length + 1).split(path.sep)[0]);
    if (o.kind === 'instance') {
      const jv = (await localJava(m.versionId)) || (await localJava(m.mcVersion));
      used.add(jv?.component || java.MAJOR_COMPONENT[java.majorForMinecraft(m.mcVersion)] || 'jre-legacy');
    } else {
      let major = Number(m.javaMajor) || 0;
      if (!major) {
        try {
          if (require('../../core/servers').isProxy(m)) major = 21;
        } catch {
          /* sin servidores */
        }
      }
      if (!major) major = (await localJava(m.mcVersion))?.majorVersion || java.majorForMinecraft(m.mcVersion);
      used.add(serverComponent(major));
    }
  }
  return used;
}

async function planRuntimes(owners, signal) {
  const used = await usedRuntimes(owners);
  const items = [];
  const now = Date.now();
  for (const e of await readdirSafe(paths.runtime())) {
    checkAbort(signal);
    if (!e.isDirectory()) continue;
    const dir = path.join(paths.runtime(), e.name);
    const leftover = /\.old-\d+$/.test(e.name);
    const partial = /\.partial$/.test(e.name);
    if (partial) {
      // Una instalacion en curso usa esta carpeta: solo se borra si quedo abandonada.
      const st = await statExact(dir).catch(() => null);
      if (!st || now - st.mtimeMs < PARTIAL_RUNTIME_AGE) continue;
    } else if (!leftover && used.has(e.name)) continue;
    const marker = await readJson(path.join(dir, '.venus-runtime.json'), {});
    const { size } = await treeSize(dir, signal);
    items.push({ id: e.name, path: dir, size, major: marker.major || null, leftover: leftover || partial });
  }
  items.sort((a, b) => b.size - a.size);
  return items;
}

/**
 * Vista previa: que se borraria en cada categoria y cuanto se libera.
 * Devuelve { [categoria]: { size, count, items } , total } (items sin rutas absolutas para la interfaz).
 */
async function plan({ signal, activeParts = new Set() } = {}) {
  const owners = await dedupe.listOwners();
  const [cache, versions, runtimes, orphans, partials] = [
    await planCache(activeParts, signal),
    await planVersions(owners, signal),
    await planRuntimes(owners, signal),
    await dedupe.findOrphans({ signal }),
    await usage.stalePartials({ activeParts }),
  ];
  const pack = (items) => ({ size: items.reduce((a, i) => a + (i.size || 0), 0), count: items.length, items });
  const full = {
    cache: pack(cache),
    unusedVersions: pack(versions),
    unusedRuntimes: pack(runtimes),
    orphanStore: pack(orphans),
    partials: pack(partials),
  };
  return full;
}

// Lo que ve la interfaz (sin rutas absolutas).
function publicPlan(full) {
  const out = { total: 0 };
  for (const k of KINDS) {
    const c = full[k];
    out[k] = {
      size: c.size,
      count: c.count,
      items: k === 'orphanStore' || k === 'partials' ? [] : c.items.slice(0, 60).map((i) => ({ id: i.id, size: i.size, major: i.major || null, leftover: Boolean(i.leftover), broken: Boolean(i.broken), dir: i.dir })),
    };
    out.total += c.size;
  }
  return out;
}

// Mover a un nombre temporal y despues borrar: si algo esta en uso (Windows) no se mueve y queda intacto.
async function removeAtomic(p) {
  const tmp = `${p}.venus-trash-${Date.now()}`;
  await fsp.rename(p, tmp);
  await removeTree(tmp).catch(() => {});
}

/**
 * Borra las categorias elegidas: opts = { cache, unusedVersions, unusedRuntimes, orphanStore, partials }.
 * Devuelve { freed, removed, failed, byCategory }.
 */
async function run(opts = {}, { signal, activeParts = new Set() } = {}) {
  const root = paths.root();
  const chosen = KINDS.filter((k) => opts[k] === true);
  const full = await plan({ signal, activeParts });
  const result = { freed: 0, removed: 0, failed: 0, byCategory: {} };
  for (const k of chosen) {
    const r = { freed: 0, removed: 0, failed: 0 };
    for (const item of full[k].items) {
      checkAbort(signal);
      if (!inside(root, item.path)) continue;
      try {
        if (k === 'cache') {
          if (withinAny(item.path, activeParts)) continue;
          await fsp.rm(item.path, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
        } else if (k === 'unusedVersions') {
          await removeAtomic(item.path);
          for (const extra of item.extra || []) if (inside(root, extra)) await removeTree(extra).catch(() => {});
        } else if (k === 'unusedRuntimes') {
          await removeAtomic(item.path);
        } else if (k === 'orphanStore') {
          // Se vuelve a mirar justo antes: si algo lo empezo a usar, no se borra.
          const st = await statExact(item.path).catch(() => null);
          if (!st || st.nlink > 1) continue;
          await fsp.rm(item.path, { force: true });
        } else if (k === 'partials') {
          if (activeParts.has(item.path)) continue;
          await fsp.rm(item.path, { force: true });
        }
        r.freed += item.size || 0;
        r.removed++;
      } catch {
        r.failed++;
      }
    }
    result.byCategory[k] = r;
    result.freed += r.freed;
    result.removed += r.removed;
    result.failed += r.failed;
  }
  await fsp.mkdir(paths.cache(), { recursive: true }).catch(() => {});
  return result;
}

module.exports = { plan, publicPlan, run, KINDS };
