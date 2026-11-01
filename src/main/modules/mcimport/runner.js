'use strict';
// Ejecuta un plan de importacion, sin Electron (las instancias se crean con funciones que recibe):
//  1) copia todo a una carpeta temporal propia (<datos>/mcimport/staging-<id>/<n>/), con los ayudantes atomicos
//     de packs/safety, salteando enlaces simbolicos y uniones y todo lo que salga de la carpeta de origen;
//  2) recien al final crea cada instancia y mueve adentro lo copiado (renombrar en el mismo disco).
// Asi ninguna instancia a medias aparece en Versiones ni se puede jugar mientras se copia. Si algo falla o se
// cancela, se borra la carpeta temporal y las instancias que se hayan creado. La carpeta de origen solo se lee.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const safety = require('../packs/safety');
const { isLocked, insideOrSame } = require('./scan');

const SKIP_IN_WORLD = new Set(['session.lock']);

function codeError(code, extra = {}) {
  return Object.assign(new Error(code), { code, ...extra });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : codeError('cancelled');
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {});
}

async function lstatSafe(p) {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}

/**
 * Copia una entrada (archivo o carpeta) del origen a destRoot/destRel.
 * ctx: { srcRoot (carpeta de juego real), venusRoot, signal, onFile(bytes, rel), stats, inWorld }
 */
async function copyEntry(src, destRoot, destRel, ctx, depth = 0) {
  throwIfAborted(ctx.signal);
  const st = await lstatSafe(src);
  if (!st) return;
  if (st.isSymbolicLink()) {
    ctx.stats.links++;
    return;
  }
  // Nada que resuelva fuera de la carpeta de juego de origen (ni dentro de la carpeta de datos de Venus). Los
  // archivos de adentro de una carpeta ya revisada que no son enlaces no pueden salir de ella: no hace falta
  // resolver cada uno (es caro en Windows con miles de archivos de regiones).
  let real = src;
  if (depth === 0 || st.isDirectory()) {
    try {
      real = await fsp.realpath(src);
    } catch {
      ctx.stats.skipped++;
      return;
    }
    if (!insideOrSame(ctx.srcRoot, real) || (ctx.venusRoot && insideOrSame(ctx.venusRoot, real))) {
      ctx.stats.outside++;
      return;
    }
  }
  if (st.isFile()) {
    const dest = safety.resolveInside(destRoot, destRel);
    if (!dest) {
      ctx.stats.skipped++;
      return;
    }
    await safety.copyFileAtomic(real, dest);
    ctx.stats.files++;
    ctx.stats.bytes += st.size;
    ctx.onFile?.(st.size, destRel);
    return;
  }
  if (!st.isDirectory()) return; // sockets, dispositivos: nada
  const destDir = safety.resolveInside(destRoot, destRel);
  if (!destDir) {
    ctx.stats.skipped++;
    return;
  }
  await fsp.mkdir(destDir, { recursive: true });
  let entries;
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch {
    ctx.stats.skipped++;
    return;
  }
  for (const e of entries) {
    if (ctx.inWorld && SKIP_IN_WORLD.has(e.name)) continue;
    if (!safety.validSegment(e.name)) {
      ctx.stats.skipped++;
      continue;
    }
    await copyEntry(path.join(src, e.name), destRoot, `${destRel}/${e.name}`, ctx, depth + 1);
  }
}

const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

// En Windows un antivirus puede tener tomados un instante los archivos recien copiados: se reintenta el renombrado.
async function renameRetry(from, to, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      if (!LOCK_CODES.has(err.code) || i >= tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 60 * 2 ** i));
    }
  }
}

// Mueve lo copiado a la instancia: mismo disco -> renombrar; otro disco (o un bloqueo que no se suelta) ->
// copiar y borrar el temporal.
async function moveInto(stagedDir, instDir) {
  const entries = await fsp.readdir(stagedDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const from = path.join(stagedDir, e.name);
    const to = path.join(instDir, e.name);
    if (safety.isReservedTop(e.name) || (await lstatSafe(to))) throw codeError('destExists', { file: e.name });
    try {
      await renameRetry(from, to);
    } catch (err) {
      if (err.code !== 'EXDEV' && !LOCK_CODES.has(err.code)) throw err;
      await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      await rmrf(from);
    }
  }
}

/**
 * plan: resultado de buildPlan. opts:
 *   stagingRoot   carpeta propia del modulo para los temporales (dentro de la carpeta de datos de Venus)
 *   venusRoot     carpeta de datos de Venus (nunca se copia nada que este adentro)
 *   signal        AbortSignal (cancelar)
 *   onProgress    ({ phase: 'copy' | 'create', category, instance, label, done, total }) => void
 *   createInstance({ name, mcVersion, loader, loaderVersion }) -> { id, dir }
 *   markInstance(id, meta)    guarda la marca mcimport en la instancia
 *   removeInstance(id)        borra una instancia creada (limpieza al fallar o cancelar)
 *   checkLock(file)           por defecto scan.isLocked (session.lock de un mundo abierto)
 *   meta                      { dir } para la marca de cada instancia
 * Devuelve { instances: [{ id, name, profileId, mcVersion, loader }], stats }.
 */
async function runPlan(plan, opts) {
  const { stagingRoot, venusRoot = null, signal, onProgress, createInstance, markInstance, removeInstance, checkLock = isLocked, meta = {}, now = Date.now } = opts;
  const total = Math.max(1, plan.bytes || 0);
  const stats = { files: 0, bytes: 0, links: 0, outside: 0, skipped: 0 };
  const runDir = path.join(stagingRoot, `staging-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`);
  const created = [];
  await fsp.mkdir(runDir, { recursive: true });
  try {
    // 1) Copiar a la carpeta temporal
    for (const [i, inst] of plan.instances.entries()) {
      const destRoot = path.join(runDir, String(i));
      await fsp.mkdir(destRoot, { recursive: true });
      for (const c of inst.copies) {
        throwIfAborted(signal);
        const srcRoot = await fsp.realpath(c.groupDir).catch(() => null);
        if (!srcRoot) continue;
        if (c.kind === 'world' && (await checkLock(path.join(c.src, 'session.lock')))) throw codeError('worldOpen', { world: c.label });
        onProgress?.({ phase: 'copy', category: c.category, instance: inst.name, label: c.label, done: stats.bytes, total });
        await copyEntry(c.src, destRoot, c.dest, {
          srcRoot,
          venusRoot,
          signal,
          stats,
          inWorld: c.kind === 'world',
          onFile: () => onProgress?.({ phase: 'copy', category: c.category, instance: inst.name, label: c.label, done: stats.bytes, total }),
        });
      }
    }
    throwIfAborted(signal);
    // 2) Crear las instancias y mover el contenido. Se crean del perfil usado hace mas tiempo al mas reciente:
    //    Versiones ordena por creacion las que nunca se jugaron, asi el perfil que mas se usa queda primero.
    const out = new Array(plan.instances.length);
    for (let i = plan.instances.length - 1; i >= 0; i--) {
      const inst = plan.instances[i];
      throwIfAborted(signal);
      onProgress?.({ phase: 'create', instance: inst.name, done: stats.bytes, total });
      const made = await createInstance({ name: inst.name, mcVersion: inst.mcVersion, loader: inst.loader, loaderVersion: inst.loaderVersion || 'latest' });
      created.push(made.id);
      await moveInto(path.join(runDir, String(i)), made.dir);
      await markInstance(made.id, { from: 'official', dir: meta.dir || null, profile: inst.profileKey, profileName: inst.profileName, at: now() });
      out[i] = { id: made.id, name: made.name || inst.name, profileId: inst.profileId, mcVersion: inst.mcVersion, loader: inst.loader };
    }
    return { instances: out, stats };
  } catch (err) {
    // Cada instancia por separado: si borrar una falla (aunque sea de golpe, sin promesa), se siguen borrando las
    // demas y llega el error original.
    for (const id of created) {
      try {
        await removeInstance(id);
      } catch {
        /* se intenta con la siguiente */
      }
    }
    throw err;
  } finally {
    await rmrf(runDir);
  }
}

// Temporales de importaciones que quedaron a medias (el launcher se cerro de golpe).
async function cleanStaging(stagingRoot) {
  const entries = await fsp.readdir(stagingRoot, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isDirectory() && e.name.startsWith('staging-')) await rmrf(path.join(stagingRoot, e.name));
}

// Espacio libre (bytes) en el disco de una carpeta, o null si no se puede saber.
async function freeSpace(dir) {
  try {
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

module.exports = { runPlan, copyEntry, cleanStaging, freeSpace, codeError, SKIP_IN_WORLD };
