'use strict';
// Espacio en disco por categoria. Los enlaces duros se cuentan una sola vez (primero el almacen compartido),
// asi que la suma es lo que de verdad ocupa la carpeta de datos. El resultado queda en cache (memoria + disco).
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../../core/paths');
const { readJson, writeJson } = require('../../core/util');
const { walk, readdirSafe, statExact } = require('./fsutil');

const CATEGORIES = ['instances', 'servers', 'versions', 'libraries', 'assets', 'runtime', 'cache', 'store', 'snapshots', 'backups', 'other'];
const TOP_DIRS = { versions: 'versions', libraries: 'libraries', assets: 'assets', runtime: 'runtime', cache: 'cache', snapshots: 'snapshots', backups: 'backups' };
const CACHE_FILE = () => paths.data('storage-usage.json');
const STALE_MS = 10 * 60 * 1000;
const PART_AGE = 24 * 3600 * 1000; // una descarga incompleta mas vieja que esto ya no se va a retomar

let memo = null; // { data, partials, at, root }
let inflight = null;

// Dentro de una instancia o servidor: instantaneas y copias de seguridad van a su propia categoria.
function specialOf(rel) {
  if (rel.startsWith('.venus/snapshots/')) return 'snapshots';
  if (rel.startsWith('backups/') || rel.startsWith('world-backups/')) return 'backups';
  return null;
}

async function compute({ signal, activeParts = new Set() } = {}) {
  const started = Date.now();
  const root = paths.root();
  const seen = new Set();
  const cats = Object.fromEntries(CATEGORIES.map((k) => [k, { key: k, size: 0, logical: 0, files: 0 }]));
  const owners = { instance: [], server: [] };
  const partials = [];
  const now = Date.now();

  const add = (cat, st, owner) => {
    const c = cats[cat];
    c.logical += st.size;
    c.files++;
    let physical = st.size;
    if (st.nlink > 1) {
      if (seen.has(st.key)) physical = 0;
      else seen.add(st.key);
    }
    c.size += physical;
    if (owner) {
      owner.size += physical;
      owner.logical += st.size;
    }
  };
  const notePart = (full, st, name) => {
    if (name.endsWith('.part') && !activeParts.has(full) && now - st.mtimeMs > PART_AGE) partials.push({ path: full, size: st.size });
  };
  const walkInto = (dir, cat, owner) =>
    walk(dir, {
      signal,
      onFile: (full, st, rel, name) => {
        notePart(full, st, name);
        const special = owner ? specialOf(rel) : null;
        add(special || cat, st, special ? null : owner);
      },
    });

  // 1) El almacen compartido primero: lo compartido se cuenta ahi.
  await walkInto(path.join(root, 'store'), 'store', null);

  // 2) El resto de la carpeta de datos
  for (const e of await readdirSafe(root)) {
    if (e.isSymbolicLink() || e.name === 'store') continue;
    const full = path.join(root, e.name);
    if (e.isFile()) {
      const st = await statExact(full).catch(() => null);
      if (st) add('other', st, null);
      continue;
    }
    if (!e.isDirectory()) continue;
    if (e.name === 'instances' || e.name === 'servers') {
      const kind = e.name === 'instances' ? 'instance' : 'server';
      const metaName = kind === 'instance' ? 'venus-instance.json' : 'venus-server.json';
      for (const o of await readdirSafe(full)) {
        if (o.isSymbolicLink()) continue;
        const ofull = path.join(full, o.name);
        if (o.isFile()) {
          const st = await statExact(ofull).catch(() => null);
          if (st) add(e.name, st, null);
          continue;
        }
        if (!o.isDirectory()) continue;
        const meta = await readJson(path.join(ofull, metaName), null);
        const owner = { id: o.name, name: (meta && typeof meta.name === 'string' && meta.name.trim()) || o.name, size: 0, logical: 0, known: Boolean(meta) };
        owners[kind].push(owner);
        await walkInto(ofull, e.name, owner);
      }
      continue;
    }
    await walkInto(full, TOP_DIRS[e.name] || 'other', null);
  }

  let disk = null;
  try {
    const sf = await fsp.statfs(root);
    disk = { free: Number(sf.bavail) * Number(sf.bsize), total: Number(sf.blocks) * Number(sf.bsize) };
  } catch {
    disk = null;
  }

  const categories = CATEGORIES.map((k) => cats[k]);
  const data = {
    at: Date.now(),
    ms: Date.now() - started,
    root,
    total: categories.reduce((a, c) => a + c.size, 0),
    logical: categories.reduce((a, c) => a + c.logical, 0),
    categories,
    instances: owners.instance.sort((a, b) => b.size - a.size),
    servers: owners.server.sort((a, b) => b.size - a.size),
    partials: { count: partials.length, size: partials.reduce((a, p) => a + p.size, 0) },
    disk,
  };
  memo = { data, partials, at: data.at, root };
  writeJson(CACHE_FILE(), data).catch(() => {});
  return { data, partials };
}

// Calcula de nuevo (si ya hay un calculo en curso, se comparte).
function refresh(opts = {}) {
  if (!inflight) {
    inflight = compute(opts).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * Uso del disco. Sin force devuelve lo ultimo calculado al instante (con stale: true si es viejo o si
 * hubo cambios); la interfaz lo muestra y pide force: true para actualizar.
 */
async function get({ force = false, signal, activeParts } = {}) {
  const root = paths.root();
  if (!force) {
    if (memo && memo.root === root) return { ...memo.data, stale: Date.now() - memo.at > STALE_MS };
    const saved = await readJson(CACHE_FILE(), null);
    if (saved && saved.root === root && Array.isArray(saved.categories)) return { ...saved, stale: true, fromDisk: true };
  }
  return { ...(await refresh({ signal, activeParts })).data, stale: false };
}

// Descargas incompletas viejas (para la limpieza). Usa el ultimo calculo si es reciente.
async function stalePartials({ activeParts } = {}) {
  const root = paths.root();
  if (!memo || memo.root !== root || Date.now() - memo.at > STALE_MS) await refresh({ activeParts });
  const active = activeParts || new Set();
  return (memo?.partials || []).filter((p) => !active.has(p.path));
}

// Algo cambio (unificacion, limpieza): la proxima lectura se marca como vieja.
function invalidate() {
  if (memo) memo.at = 0;
}

module.exports = { get, refresh, stalePartials, invalidate, CATEGORIES };
