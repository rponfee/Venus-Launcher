'use strict';
// "No duplicar archivos entre instancias": los mods, resource packs, shaders y plugins identicos se guardan
// una sola vez en <datos>/store/<aa>/<sha1> y cada instancia o servidor los ve con un enlace duro.
// Es seguro porque Minecraft y los launchers nunca editan un .jar/.zip por dentro: para actualizarlo o
// borrarlo lo reemplazan, y eso solo afecta a esa carpeta (las demas siguen viendo su copia intacta).
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const paths = require('../../core/paths');
const { readJson } = require('../../core/util');
const hashcache = require('./hashcache');
const { statExact, walk, readdirSafe, relTo, mapLimit, checkAbort } = require('./fsutil');

const INSTANCE_FOLDERS = ['mods', 'resourcepacks', 'shaderpacks'];
const SERVER_FOLDERS = ['mods', 'plugins'];
// Solo archivos comprimidos que nunca se editan por dentro (tambien los desactivados: "x.jar.disabled").
const ARCHIVE = /\.(jar|zip|mrpack)(\.disabled)?$/i;
const TEMP_LINK = /\.venus-link-[0-9a-f]+$/i;
const MIN_SIZE = 4096; // en archivos chicos el ahorro no vale la pena
const MAX_LINKS = 1000; // NTFS admite hasta 1023 enlaces por archivo
const MAX_GROUPS_UI = 150;

function storeDir() {
  return path.join(paths.root(), 'store');
}

function storePath(sha1) {
  return path.join(storeDir(), sha1.slice(0, 2), sha1);
}

const ownerKey = (o) => `${o.kind}:${o.id}`;

// Instancias y servidores con su nombre (se leen sus archivos de datos directamente).
async function listOwners() {
  const out = [];
  const kinds = [
    { kind: 'instance', base: paths.instances(), meta: 'venus-instance.json', folders: INSTANCE_FOLDERS },
    { kind: 'server', base: paths.servers(), meta: 'venus-server.json', folders: SERVER_FOLDERS },
  ];
  for (const k of kinds) {
    for (const e of await readdirSafe(k.base)) {
      if (!e.isDirectory()) continue;
      const dir = path.join(k.base, e.name);
      const meta = await readJson(path.join(dir, k.meta), null);
      if (!meta || typeof meta !== 'object') continue;
      out.push({ kind: k.kind, id: e.name, name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : e.name, dir, folders: k.folders, meta });
    }
  }
  return out;
}

// Instancias abiertas, servidores encendidos y carpetas con una tarea en curso: no se tocan.
function busyOwners() {
  const busy = new Set();
  try {
    for (const id of Object.keys(require('../../core/game').status())) busy.add(`instance:${id}`);
  } catch {
    /* sin juego */
  }
  try {
    for (const task of require('../../core/tasks').list()) {
      if (task.state !== 'running') continue;
      if (task.meta?.instanceId) busy.add(`instance:${task.meta.instanceId}`);
      if (task.meta?.serverId) busy.add(`server:${task.meta.serverId}`);
    }
  } catch {
    /* sin tareas */
  }
  return busy;
}

function serverBusy(id) {
  try {
    return require('../../core/servers').isRunning(id);
  } catch {
    return false;
  }
}

// Todos los archivos candidatos (con su stat exacto).
async function collect({ signal } = {}) {
  const root = paths.root();
  const owners = await listOwners();
  const files = [];
  let leftovers = 0;
  for (const o of owners) {
    for (const folder of o.folders) {
      await walk(path.join(o.dir, folder), {
        // En servidores, solo los jars del primer nivel: dentro de plugins/ cada plugin guarda sus datos y
        // escribe sus propios .zip, y update/ se pisa con cada /reload.
        maxDepth: o.kind === 'server' ? 0 : 2,
        signal,
        onDir: (full, rel, name) => !name.startsWith('.'),
        onFile: async (full, st, rel, name) => {
          // Restos de una unificacion cortada a la mitad: es solo otro enlace al almacen.
          if (TEMP_LINK.test(name)) {
            await fsp.rm(full, { force: true }).catch(() => {});
            leftovers++;
            return;
          }
          if (!ARCHIVE.test(name) || st.size < MIN_SIZE) return;
          files.push({ path: full, rel: relTo(root, full), name, owner: o, folder, st });
        },
      });
    }
  }
  return { owners, files, leftovers };
}

function sameFile(now, then) {
  return Boolean(now && now.isFile && now.key === then.key && now.size === then.size && now.mtimeNs === then.mtimeNs);
}

function displayName(files) {
  const counts = new Map();
  for (const f of files) {
    const n = f.name.replace(/\.disabled$/i, '');
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || files[0]?.name || '';
}

/**
 * Analiza los duplicados. Devuelve { summary, groups } donde summary es lo que ve la interfaz
 * y groups es la lista interna (con rutas y stats) para unificar.
 */
async function analyze({ signal, onProgress } = {}) {
  const started = Date.now();
  await hashcache.load();
  const { owners, files, leftovers } = await collect({ signal });
  const busy = busyOwners();
  for (const o of owners) if (o.kind === 'server' && serverBusy(o.id)) busy.add(ownerKey(o));
  let rootDev = null;
  try {
    rootDev = (await statExact(paths.root())).dev;
  } catch {
    rootDev = null;
  }

  // Archivos fisicos (varios nombres pueden ser ya el mismo archivo por un enlace)
  const inodes = new Map();
  let logical = 0;
  for (const f of files) {
    logical += f.st.size;
    let n = inodes.get(f.st.key);
    if (!n) {
      n = { key: f.st.key, st: f.st, files: [] };
      inodes.set(f.st.key, n);
    }
    n.files.push(f);
  }

  // Solo se calcula el hash de los tamaños repetidos
  const bySize = new Map();
  for (const n of inodes.values()) {
    const list = bySize.get(n.st.size) || [];
    list.push(n);
    bySize.set(n.st.size, list);
  }
  const toHash = [];
  for (const list of bySize.values()) if (list.length > 1) toHash.push(...list);
  const totalBytes = toHash.reduce((a, n) => a + n.st.size, 0) || 1;
  let doneBytes = 0;
  let hashed = 0;
  let hashedBytes = 0;
  await mapLimit(toHash, 3, async (n) => {
    checkAbort(signal);
    try {
      const r = await hashcache.sha1(n.files[0].path, n.st, signal);
      n.sha1 = r.sha1;
      if (!r.cached) {
        hashed++;
        hashedBytes += n.st.size;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      n.sha1 = null;
    }
    doneBytes += n.st.size;
    onProgress?.(doneBytes / totalBytes);
  });
  await hashcache.save().catch(() => {});

  // Grupos de contenido identico con mas de un archivo fisico
  const byHash = new Map();
  for (const n of toHash) {
    if (!n.sha1) continue;
    const k = `${n.sha1}:${n.st.size}`;
    const list = byHash.get(k) || [];
    list.push(n);
    byHash.set(k, list);
  }
  const groups = [];
  for (const list of byHash.values()) {
    if (list.length < 2) continue;
    const sha1 = list[0].sha1;
    const size = list[0].st.size;
    const store = await statExact(storePath(sha1)).catch(() => null);
    // La copia que se conserva: la del almacen si ya existe, si no la que tiene mas nombres.
    let keep = store ? list.find((n) => n.key === store.key) || null : null;
    if (!keep && !store) keep = [...list].sort((a, b) => b.files.length - a.files.length)[0];
    let savings = 0;
    let replace = 0;
    let busyCount = 0;
    for (const n of list) {
      if (keep && n.key === keep.key) continue;
      const movable = n.files.filter((f) => !busy.has(ownerKey(f.owner)) && (!rootDev || f.st.dev === rootDev));
      busyCount += n.files.length - movable.length;
      replace += movable.length;
      // El espacio se libera solo si todos los nombres de ese archivo pasan a ser enlaces.
      if (movable.length === n.files.length && n.st.nlink <= n.files.length) savings += size;
    }
    const all = list.flatMap((n) => n.files.map((f) => ({ f, n })));
    const keepKey = keep ? keep.key : store?.key || null;
    groups.push({
      sha1,
      size,
      inodes: list,
      keepKey,
      savings,
      replace,
      busy: busyCount,
      name: displayName(all.map((x) => x.f)),
      files: all.map(({ f, n }) => ({
        owner: { kind: f.owner.kind, id: f.owner.id, name: f.owner.name },
        folder: f.folder,
        name: f.name,
        rel: f.rel,
        keep: n.key === keepKey,
        busy: busy.has(ownerKey(f.owner)),
      })),
    });
  }
  groups.sort((a, b) => b.savings - a.savings || b.files.length - a.files.length);

  // Lo que ya se ahorra hoy: archivos que ya son el mismo archivo fisico
  let shared = 0;
  let sharedFiles = 0;
  for (const n of inodes.values()) {
    if (n.files.length > 1) {
      shared += n.st.size * (n.files.length - 1);
      sharedFiles += n.files.length - 1;
    }
  }

  const summary = {
    at: Date.now(),
    ms: Date.now() - started,
    owners: owners.length,
    files: files.length,
    bytes: logical,
    hashed,
    hashedBytes,
    leftovers,
    groupCount: groups.filter((g) => g.replace > 0).length,
    duplicates: groups.reduce((a, g) => a + g.replace, 0),
    savings: groups.reduce((a, g) => a + g.savings, 0),
    busy: groups.reduce((a, g) => a + g.busy, 0),
    shared,
    sharedFiles,
    groups: groups.slice(0, MAX_GROUPS_UI).map(({ sha1, size, savings, replace, busy: b, name, files: fl }) => ({ sha1, size, savings, replace, busy: b, name, count: fl.length, files: fl })),
  };
  return { summary, groups };
}

function linkUnsupported(err) {
  // EXDEV: otro disco. EISDIR/ENOTSUP/EOPNOTSUPP/ENOSYS: el sistema de archivos no tiene enlaces duros (FAT32, exFAT...).
  return ['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EISDIR'].includes(err?.code);
}

function inUse(err) {
  return ['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY'].includes(err?.code);
}

// Copia canonica del grupo en el almacen, verificada (si alguien la edito por dentro se descarta ese nombre).
async function ensureCanonical(g, storeDev, signal, result) {
  const target = storePath(g.sha1);
  let canon = await statExact(target).catch(() => null);
  if (canon) {
    let ok = canon.isFile && canon.size === g.size;
    if (ok) ok = (await hashcache.sha1(target, canon, signal)).sha1 === g.sha1;
    if (ok) return { target, canon };
    // El contenido ya no coincide con su nombre: se quita solo ese nombre (los archivos que lo usan no cambian).
    console.warn(`[storage] El almacén tenía un archivo modificado (${g.sha1}); se descarta ese nombre.`);
    await fsp.rm(target, { force: true }).catch(() => {});
    canon = null;
  }
  const candidates = g.inodes.filter((n) => n.st.dev === storeDev).sort((a, b) => b.files.length - a.files.length);
  for (const n of candidates) {
    const src = n.files[0];
    if (!sameFile(await statExact(src.path).catch(() => null), n.st)) continue;
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.link(src.path, target);
    } catch (err) {
      if (linkUnsupported(err)) {
        result.unsupported = true;
        return null;
      }
      if (err.code !== 'EEXIST') continue;
    }
    canon = await statExact(target).catch(() => null);
    if (canon && canon.size === g.size && (canon.key === n.key || (await hashcache.sha1(target, canon, signal)).sha1 === g.sha1)) {
      hashcache.remember(canon, g.sha1);
      return { target, canon };
    }
  }
  return null;
}

async function dedupeGroup(g, storeDev, busy, result, signal) {
  const base = await ensureCanonical(g, storeDev, signal, result);
  if (!base) {
    if (!result.unsupported) result.skipped.failed += g.replace;
    return;
  }
  const { target, canon } = base;
  let links = canon.nlink;
  let linkedHere = 0;
  for (const n of g.inodes) {
    if (n.key === canon.key) continue;
    let replaced = 0;
    for (const f of n.files) {
      checkAbort(signal);
      if (busy.has(ownerKey(f.owner))) {
        result.skipped.busy++;
        continue;
      }
      if (f.st.dev !== storeDev) {
        result.skipped.otherVolume++;
        continue;
      }
      if (links >= MAX_LINKS) {
        result.skipped.failed++;
        continue;
      }
      if (!sameFile(await statExact(f.path).catch(() => null), n.st)) {
        result.skipped.changed++;
        continue;
      }
      // Enlace temporal + renombrado atomico: el archivo nunca falta, ni siquiera un instante.
      const tmp = `${f.path}.venus-link-${crypto.randomBytes(4).toString('hex')}`;
      try {
        await fsp.link(target, tmp);
        await fsp.rename(tmp, f.path);
        replaced++;
        linkedHere++;
        links++;
        result.linked++;
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        if (linkUnsupported(err)) {
          result.unsupported = true;
          return;
        }
        if (inUse(err)) result.skipped.busy++;
        else {
          result.skipped.failed++;
          if (result.errors.length < 5) result.errors.push(`${f.rel}: ${err.code || err.message}`);
        }
      }
    }
    if (replaced && replaced === n.files.length && n.st.nlink <= n.files.length) result.freed += n.st.size;
  }
  if (linkedHere) {
    result.groups++;
    // Crear enlaces cambia la fecha de cambio (ctime): se actualiza la cache para no volver a leerlo.
    const after = await statExact(target).catch(() => null);
    if (after) hashcache.remember(after, g.sha1);
  }
}

/**
 * Unifica los duplicados. onProgress(0..1). Devuelve
 * { linked, freed, groups, unsupported, skipped: { busy, otherVolume, changed, failed }, errors, summary }
 */
async function run({ signal, onProgress, onPhase } = {}) {
  onPhase?.('scan');
  const { summary, groups } = await analyze({ signal, onProgress: (p) => onProgress?.(p * 0.6) });
  const result = { linked: 0, freed: 0, groups: 0, unsupported: false, skipped: { busy: 0, otherVolume: 0, changed: 0, failed: 0 }, errors: [], before: summary };
  const work = groups.filter((g) => g.replace > 0);
  // Grupos donde todas las copias estan en uso: no hay nada que hacer ahora, pero se informa.
  for (const g of groups) if (!g.replace) result.skipped.busy += g.busy;
  if (!work.length) return result;
  onPhase?.('link');
  const sdir = storeDir();
  await fsp.mkdir(sdir, { recursive: true });
  const storeDev = (await statExact(sdir)).dev;
  const busy = busyOwners();
  for (const g of work) for (const f of g.files) if (f.busy) busy.add(`${f.owner.kind}:${f.owner.id}`);
  for (let i = 0; i < work.length; i++) {
    checkAbort(signal);
    try {
      await dedupeGroup(work[i], storeDev, busy, result, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      result.skipped.failed += work[i].replace;
      if (result.errors.length < 5) result.errors.push(err.message);
    }
    onProgress?.(0.6 + 0.4 * ((i + 1) / work.length));
    if (result.unsupported) break;
  }
  await hashcache.save().catch(() => {});
  return result;
}

// Copias del almacen que ya no usa ninguna instancia ni servidor (un solo enlace: el del almacen).
async function findOrphans({ signal } = {}) {
  const out = [];
  const sdir = storeDir();
  for (const d of await readdirSafe(sdir)) {
    if (!d.isDirectory() || !/^[0-9a-f]{2}$/i.test(d.name)) continue;
    for (const e of await readdirSafe(path.join(sdir, d.name))) {
      checkAbort(signal);
      if (!e.isFile()) continue;
      const full = path.join(sdir, d.name, e.name);
      const st = await statExact(full).catch(() => null);
      if (st && st.nlink <= 1) out.push({ path: full, name: e.name, size: st.size });
    }
  }
  return out;
}

module.exports = { analyze, run, findOrphans, listOwners, busyOwners, storeDir, storePath, ARCHIVE, INSTANCE_FOLDERS, SERVER_FOLDERS };
