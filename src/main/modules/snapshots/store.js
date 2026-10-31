'use strict';
// Almacen de las instantaneas, como "git" para la partida:
//   <datos>/snapshots/objects/<aa>/<sha1>      contenido de cada archivo, guardado una sola vez
//   <datos>/snapshots/<instancia>/<id>.json    manifiesto: lista de archivos (ruta, sha1, tamanio, fecha)
//   <datos>/snapshots/<instancia>/index.json   resumen para listar rapido (se reconstruye solo)
//   <datos>/snapshots/<instancia>/statcache.json  tamanio+fecha -> sha1 para no volver a leer lo que no cambio
// Al guardar se COPIA. Solo los archivos inmutables (.jar/.zip de mods y packs) se enlazan con un hardlink
// si estan en el mismo disco: esos archivos se reemplazan, nunca se editan en el lugar, asi que no ocupan
// lugar extra. Al restaurar SIEMPRE se copia (nunca hardlink): el juego escribe los mundos en el lugar
// y pisaria el objeto guardado.
// Una instancia llamada "objects" convive con el almacen: sus manifiestos son <id>.json sueltos y los
// objetos viven en subcarpetas de dos letras hexadecimales.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const paths = require('../../core/paths');

const INDEX_VERSION = 1;
const MANIFEST_VERSION = 1;
const IN_MEMORY = 32 * 1024 * 1024; // hasta este tamanio se lee de una vez
const HASH_RE = /^[0-9a-f]{40}$/;
const SNAP_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/;
const RACY_MS = 2000;

const rootDir = () => path.join(paths.root(), 'snapshots');
const objectsDir = () => path.join(rootDir(), 'objects');
const objectPath = (h) => path.join(objectsDir(), h.slice(0, 2), h);
const instanceDir = (id) => path.join(rootDir(), id);
const manifestPath = (id, snapId) => path.join(instanceDir(id), `${snapId}.json`);

const isHash = (h) => typeof h === 'string' && HASH_RE.test(h);
const isSnapId = (s) => typeof s === 'string' && SNAP_RE.test(s);

function newSnapId(date = new Date()) {
  const iso = date.toISOString(); // 2026-10-27T15:30:12.345Z
  const rand = crypto.randomBytes(3).toString('hex').slice(0, 4);
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${rand}`;
}

function tmpName(dest) {
  return `${dest}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// JSON compacto con escritura atomica (los manifiestos de mundos pueden tener miles de archivos).
async function writeJsonAtomic(file, data, pretty = false) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  await fsp.writeFile(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

// ---------- Cerrojos ----------
// Lectura/escritura del almacen: guardar y restaurar comparten; la limpieza (gc) va sola, asi nunca
// borra objetos que una instantanea en curso todavia no anoto en su manifiesto.
const rw = { readers: 0, writer: false, waiting: [] };

function pump() {
  while (rw.waiting.length) {
    const next = rw.waiting[0];
    if (next.exclusive) {
      if (!rw.writer && rw.readers === 0) {
        rw.waiting.shift();
        rw.writer = true;
        next.resolve();
      }
      return;
    }
    if (rw.writer) return;
    rw.waiting.shift();
    rw.readers++;
    next.resolve();
  }
}

async function withStore(exclusive, fn) {
  await new Promise((resolve) => {
    rw.waiting.push({ exclusive, resolve });
    pump();
  });
  try {
    return await fn();
  } finally {
    if (exclusive) rw.writer = false;
    else rw.readers--;
    pump();
  }
}

// Operaciones de una misma instancia, en fila (crear, restaurar y borrar no se pisan).
const instLocks = new Map();
function withInstance(id, fn) {
  const prev = instLocks.get(id) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  instLocks.set(id, tail);
  tail.then(() => {
    if (instLocks.get(id) === tail) instLocks.delete(id);
  });
  return run;
}

// ---------- Hash y objetos ----------

function hashStream(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}

async function hashFile(file, size) {
  if (size !== undefined && size <= IN_MEMORY) return crypto.createHash('sha1').update(await fsp.readFile(file)).digest('hex');
  return hashStream(file);
}

// Copia un archivo a un temporal calculando el sha1 de lo que realmente se copio.
async function copyHashing(src, tmp) {
  const h = crypto.createHash('sha1');
  let size = 0;
  await pipeline(
    fs.createReadStream(src),
    new Transform({
      transform(chunk, enc, cb) {
        h.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    }),
    fs.createWriteStream(tmp),
  );
  return { h: h.digest('hex'), size };
}

async function placeObject(tmp, h) {
  const dest = objectPath(h);
  if (await exists(dest)) {
    await fsp.rm(tmp, { force: true });
    return false;
  }
  try {
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    if (!(await exists(dest))) throw err; // si otro proceso lo guardo justo antes, alcanza
    return false;
  }
  return true;
}

/**
 * Guarda un archivo en el almacen (si no estaba). info: { size }. opts.allowLink: puede enlazarse.
 * Devuelve { h, stored (bytes nuevos copiados), linked (bytes nuevos enlazados) }.
 */
async function ingest(abs, info, { allowLink = false } = {}) {
  const size = info.size;
  if (size <= IN_MEMORY && !allowLink) {
    const buf = await fsp.readFile(abs);
    const h = crypto.createHash('sha1').update(buf).digest('hex');
    const dest = objectPath(h);
    if (await exists(dest)) return { h, stored: 0, linked: 0 };
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = tmpName(dest);
    await fsp.writeFile(tmp, buf);
    return { h, stored: (await placeObject(tmp, h)) ? buf.length : 0, linked: 0 };
  }
  if (allowLink) {
    const h = await hashFile(abs, size);
    const dest = objectPath(h);
    if (await exists(dest)) return { h, stored: 0, linked: 0 };
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.link(abs, dest);
      return { h, stored: 0, linked: size };
    } catch (err) {
      if (err.code === 'EEXIST') return { h, stored: 0, linked: 0 };
      // Otro disco (EXDEV) o sin permisos: se copia.
    }
  }
  // Archivos grandes: una sola lectura que copia y calcula el hash a la vez.
  await fsp.mkdir(objectsDir(), { recursive: true });
  const tmp = tmpName(path.join(objectsDir(), 'incoming'));
  let copied;
  try {
    copied = await copyHashing(abs, tmp);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  await fsp.mkdir(path.dirname(objectPath(copied.h)), { recursive: true });
  return { h: copied.h, stored: (await placeObject(tmp, copied.h)) ? copied.size : 0, linked: 0 };
}

function damaged(rel) {
  return Object.assign(new Error(`damaged object for ${rel}`), { code: 'DAMAGED', rel });
}

async function replaceWith(tmp, dest) {
  try {
    await fsp.rename(tmp, dest);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EISDIR' || err.code === 'ENOTEMPTY') {
      // Archivo de solo lectura o una carpeta con el mismo nombre: se saca y se reintenta.
      await fsp.chmod(dest, 0o666).catch(() => {});
      await fsp.rm(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      await fsp.rename(tmp, dest);
    } else throw err;
  }
}

// Copia un objeto a su lugar en la instancia verificando su sha1. Nunca enlaza.
async function materialize(h, dest, { mtime, rel } = {}) {
  const src = objectPath(h);
  const st = await fsp.stat(src).catch(() => null);
  if (!st) throw Object.assign(new Error(`missing object for ${rel || dest}`), { code: 'MISSING', rel });
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = tmpName(dest);
  try {
    if (st.size <= IN_MEMORY) {
      const buf = await fsp.readFile(src);
      if (crypto.createHash('sha1').update(buf).digest('hex') !== h) throw damaged(rel || dest);
      await fsp.writeFile(tmp, buf);
    } else {
      const copied = await copyHashing(src, tmp);
      if (copied.h !== h) throw damaged(rel || dest);
    }
    await replaceWith(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  if (mtime) await fsp.utimes(dest, new Date(), new Date(mtime)).catch(() => {});
  return st.size;
}

// ---------- Manifiestos e indice ----------

function summarize(m) {
  return {
    id: m.id,
    createdAt: m.createdAt,
    kind: m.kind,
    reason: m.reason || '',
    reasonCode: m.reasonCode || null,
    label: m.label || '',
    pinned: Boolean(m.pinned),
    worlds: m.worlds || [],
    roots: m.roots || [],
    instance: m.instance ? { mcVersion: m.instance.mcVersion, loader: m.instance.loader, loaderVersion: m.instance.loaderVersion || null, preset: m.instance.preset || null, pack: m.instance.modrinth?.pack || null } : null,
    stats: m.stats || { files: m.files?.length || 0, bytes: 0, newBytes: 0, newFiles: 0, linkedBytes: 0 },
  };
}

async function readManifest(id, snapId) {
  if (!isSnapId(snapId)) throw Object.assign(new Error('bad snapshot id'), { code: 'NOT_FOUND' });
  const m = await readJson(manifestPath(id, snapId), null);
  if (!m || m.id !== snapId || !Array.isArray(m.files)) throw Object.assign(new Error('snapshot not found'), { code: 'NOT_FOUND' });
  return m;
}

async function writeManifest(id, m) {
  await writeJsonAtomic(manifestPath(id, m.id), { v: MANIFEST_VERSION, ...m });
}

async function manifestIds(id) {
  const names = await fsp.readdir(instanceDir(id)).catch(() => []);
  return names.filter((n) => n.endsWith('.json') && isSnapId(n.slice(0, -5))).map((n) => n.slice(0, -5));
}

// Indice con los resumenes. Si falta o no coincide con los manifiestos en disco, se rehace.
async function loadIndex(id) {
  const file = path.join(instanceDir(id), 'index.json');
  const idx = await readJson(file, null);
  const ids = await manifestIds(id);
  const items = idx && idx.v === INDEX_VERSION && Array.isArray(idx.items) ? idx.items.filter((s) => s && isSnapId(s.id)) : [];
  const known = new Set(items.map((s) => s.id));
  const onDisk = new Set(ids);
  let dirty = !idx;
  const fixed = items.filter((s) => {
    if (onDisk.has(s.id)) return true;
    dirty = true;
    return false;
  });
  for (const snapId of ids) {
    if (known.has(snapId)) continue;
    try {
      fixed.push(summarize(await readManifest(id, snapId)));
      dirty = true;
    } catch {
      /* manifiesto ilegible: se ignora */
    }
  }
  fixed.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const index = { v: INDEX_VERSION, items: fixed };
  if (dirty && (fixed.length || idx)) await saveIndex(id, index).catch(() => {});
  return index;
}

async function saveIndex(id, index) {
  index.items.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  await writeJsonAtomic(path.join(instanceDir(id), 'index.json'), { v: INDEX_VERSION, items: index.items }, true);
}

async function deleteManifest(id, snapId) {
  if (!isSnapId(snapId)) return false;
  await fsp.rm(manifestPath(id, snapId), { force: true });
  return true;
}

// Instancias con instantaneas guardadas (carpetas del almacen con manifiestos).
async function snapshotInstances() {
  const entries = await fsp.readdir(rootDir(), { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if ((await manifestIds(e.name)).length) out.push(e.name);
  }
  return out;
}

// ---------- Cache de hashes por tamanio + fecha ----------

async function loadStatCache(id) {
  const c = await readJson(path.join(instanceDir(id), 'statcache.json'), null);
  const files = c && typeof c.files === 'object' && c.files ? c.files : {};
  const at = Number(c?.at) || 0;
  return {
    at,
    files,
    // sha1 conocido si el archivo no cambio y no se modifico justo antes de la ultima lectura
    lookup(f) {
      const e = files[f.rel];
      if (!Array.isArray(e) || e[0] !== f.size || e[1] !== f.mtime || !isHash(e[2])) return null;
      return f.mtime < at - RACY_MS ? e[2] : null;
    },
  };
}

async function saveStatCache(id, cache) {
  await writeJsonAtomic(path.join(instanceDir(id), 'statcache.json'), { v: 1, at: cache.at, files: cache.files });
}

// ---------- Limpieza de objetos sin usar ----------

async function referencedHashes() {
  const refs = new Set();
  const entries = await fsp.readdir(rootDir(), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    for (const snapId of await manifestIds(e.name)) {
      // Un manifiesto ilegible corta la limpieza: mejor no borrar nada que borrar de mas.
      const m = await readJson(manifestPath(e.name, snapId));
      for (const f of m.files || []) if (isHash(f.h)) refs.add(f.h);
    }
  }
  return refs;
}

async function gc() {
  return withStore(true, async () => {
    let refs;
    try {
      refs = await referencedHashes();
    } catch (err) {
      console.warn('[snapshots] Limpieza cancelada: hay un manifiesto ilegible.', err?.message || err);
      return { removed: 0, freed: 0, skipped: true };
    }
    let removed = 0;
    let freed = 0;
    const buckets = await fsp.readdir(objectsDir(), { withFileTypes: true }).catch(() => []);
    for (const b of buckets) {
      if (!b.isDirectory() || !/^[0-9a-f]{2}$/.test(b.name)) continue;
      const dir = path.join(objectsDir(), b.name);
      for (const name of await fsp.readdir(dir).catch(() => [])) {
        const full = path.join(dir, name);
        if (isHash(name)) {
          if (refs.has(name)) continue;
          const st = await fsp.stat(full).catch(() => null);
          await fsp.rm(full, { force: true }).catch(() => {});
          removed++;
          // Si estaba enlazado con un archivo de una instancia, borrar el objeto no libera ese lugar.
          if (st && st.nlink <= 1) freed += st.size;
        } else if (name.endsWith('.tmp')) {
          const st = await fsp.stat(full).catch(() => null);
          if (st && Date.now() - st.mtimeMs > 60 * 60 * 1000) await fsp.rm(full, { force: true }).catch(() => {});
        }
      }
      await fsp.rmdir(dir).catch(() => {}); // solo si quedo vacia
    }
    // Temporales de copias grandes interrumpidas
    for (const name of await fsp.readdir(objectsDir()).catch(() => [])) {
      if (!name.endsWith('.tmp')) continue;
      const full = path.join(objectsDir(), name);
      const st = await fsp.stat(full).catch(() => null);
      if (st && st.isFile() && Date.now() - st.mtimeMs > 60 * 60 * 1000) await fsp.rm(full, { force: true }).catch(() => {});
    }
    return { removed, freed };
  });
}

// Tamanio del almacen: total, cantidad de objetos y cuanto esta compartido (hardlink) con las instancias.
async function storeUsage() {
  let bytes = 0;
  let objects = 0;
  let shared = 0;
  const buckets = await fsp.readdir(objectsDir(), { withFileTypes: true }).catch(() => []);
  for (const b of buckets) {
    if (!b.isDirectory() || !/^[0-9a-f]{2}$/.test(b.name)) continue;
    const dir = path.join(objectsDir(), b.name);
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (!isHash(name)) continue;
      const st = await fsp.stat(path.join(dir, name)).catch(() => null);
      if (!st) continue;
      objects++;
      bytes += st.size;
      if (st.nlink > 1) shared += st.size;
    }
  }
  return { bytes, objects, shared };
}

async function objectSizes(hashes) {
  let total = 0;
  for (const h of hashes) {
    const st = await fsp.stat(objectPath(h)).catch(() => null);
    if (st) total += st.size;
  }
  return total;
}

module.exports = {
  rootDir,
  objectsDir,
  objectPath,
  instanceDir,
  isHash,
  isSnapId,
  newSnapId,
  exists,
  withStore,
  withInstance,
  hashFile,
  ingest,
  materialize,
  summarize,
  readManifest,
  writeManifest,
  deleteManifest,
  manifestIds,
  loadIndex,
  saveIndex,
  snapshotInstances,
  loadStatCache,
  saveStatCache,
  gc,
  storeUsage,
  objectSizes,
  writeJsonAtomic,
  readJson,
};
