'use strict';
// Copias de seguridad de mundos: <datos>/backups/worlds/<instancia>/<mundo>-<fecha>.zip
// Crear (ZIP por streaming), listar, restaurar (reemplazando el mundo o como mundo nuevo) y borrar.
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../../core/paths');
const { exists, sanitizeFileName, uid, rmrf } = require('../../core/util');
const { t } = require('../../core/i18n');
const zip = require('./zip');

const root = () => path.join(paths.root(), 'backups', 'worlds');
const dirFor = (instanceId) => path.join(root(), instanceId);

const pad = (n) => String(n).padStart(2, '0');
function stamp(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// "<carpeta>-2026-10-27_18-03-11.zip" -> { folder, time }
function parseName(name) {
  const m = /^(.*)-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-\d+)?\.zip$/i.exec(name);
  if (!m) return null;
  const time = new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])).getTime();
  return { folder: m[1], time };
}

const mb = (n) => (n / 1048576).toFixed(n >= 1048576 * 100 ? 0 : 1);

/**
 * Comprime saves/<folder> de la instancia. No incluye session.lock (el juego lo tiene bloqueado).
 */
async function create(inst, folder, { task } = {}) {
  const src = path.join(inst.dir, 'saves', folder);
  if (!(await exists(path.join(src, 'level.dat')))) throw new Error(t('worlds.errNotFound'));
  const dir = dirFor(inst.id);
  await fsp.mkdir(dir, { recursive: true });
  const base = sanitizeFileName(folder).replace(/\s+/g, ' ');
  let file = path.join(dir, `${base}-${stamp()}.zip`);
  let n = 2;
  while (await exists(file)) file = path.join(dir, `${base}-${stamp()}-${n++}.zip`);
  task?.update({ detail: t('worlds.detailScanning'), progress: null });
  const res = await zip.zipDirectory(src, file, {
    root: folder,
    exclude: (rel) => /(^|\/)session\.lock$/i.test(rel),
    signal: task?.signal,
    onProgress: ({ bytes, totalBytes }) => {
      if (totalBytes) task?.update({ detail: t('worlds.detailZipping', { done: mb(bytes), total: mb(totalBytes) }), progress: bytes / totalBytes });
    },
  });
  const st = await fsp.stat(file);
  return { name: path.basename(file), path: file, size: st.size, time: st.mtimeMs, folder, files: res.files, skipped: res.skipped };
}

// Copias de una instancia (opcionalmente de un mundo), de la mas nueva a la mas vieja.
async function list(instanceId, folder = null) {
  const dir = dirFor(instanceId);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/\.zip$/i.test(name)) continue;
    const meta = parseName(name);
    if (folder && (!meta || meta.folder !== sanitizeFileName(folder).replace(/\s+/g, ' '))) continue;
    const st = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (!st?.isFile()) continue;
    out.push({ name, path: path.join(dir, name), size: st.size, time: meta?.time || st.mtimeMs, folder: meta?.folder || null, instanceId });
  }
  return out.sort((a, b) => b.time - a.time);
}

// Valida que la ruta sea una copia de este modulo y devuelve { instanceId, file }
function checkBackupPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !/\.zip$/i.test(p)) return null;
  const full = path.resolve(p);
  const base = path.resolve(root());
  if (!full.startsWith(base + path.sep)) return null;
  const rel = full.slice(base.length + 1).split(path.sep);
  if (rel.length !== 2) return null;
  return { instanceId: rel[0], file: full };
}

/**
 * Restaura una copia.
 *  mode 'replace': el mundo actual va a la papelera (o se renombra si no hay papelera) y la copia ocupa su lugar.
 *  mode 'copy': se crea un mundo nuevo con el nombre "<nombre> (restaurado)".
 * Devuelve { folder } del mundo restaurado.
 */
async function restore(inst, folder, file, { mode = 'copy', task, trash, renameLevel } = {}) {
  const entries = await zip.readEntries(file).catch(() => {
    throw new Error(t('worlds.errBackupBad'));
  });
  const prefix = zip.worldPrefix(entries);
  if (prefix === null) throw new Error(t('worlds.errBackupBad'));
  const saves = path.join(inst.dir, 'saves');
  await fsp.mkdir(saves, { recursive: true });
  // Se extrae primero en una carpeta temporal del mismo disco y despues se mueve.
  const tmpRoot = path.join(root(), '.restoring');
  await fsp.mkdir(tmpRoot, { recursive: true });
  const tmp = path.join(tmpRoot, uid(10));
  try {
    await zip.extract(file, tmp, {
      prefix,
      entries,
      signal: task?.signal,
      onProgress: ({ bytes, totalBytes }) => {
        if (totalBytes) task?.update({ detail: t('worlds.detailExtracting', { done: mb(bytes), total: mb(totalBytes) }), progress: bytes / totalBytes });
      },
    });
    if (!(await exists(path.join(tmp, 'level.dat')))) throw new Error(t('worlds.errBackupBad'));
    let target;
    let original = false;
    if (mode === 'replace') {
      target = path.join(saves, folder);
      if (await exists(target)) {
        let moved = false;
        if (trash) {
          try {
            await trash(target);
            moved = true;
          } catch {
            moved = false;
          }
        }
        if (!moved) {
          // Sin papelera: el mundo actual queda al lado con otro nombre (nunca se borra)
          let aside = path.join(saves, t('worlds.beforeRestoreFolder', { folder, date: stamp() }));
          let n = 2;
          while (await exists(aside)) aside = path.join(saves, `${t('worlds.beforeRestoreFolder', { folder, date: stamp() })} (${n++})`);
          await fsp.rename(target, aside);
        }
      }
    } else {
      // Si el mundo ya no existe (se borro) vuelve con su carpeta de siempre
      original = !(await exists(path.join(saves, folder)));
      const base = sanitizeFileName(original ? folder : t('worlds.restoredFolder', { folder }));
      target = path.join(saves, base);
      let n = 2;
      while (await exists(target)) target = path.join(saves, `${base} (${n++})`);
    }
    await fsp.rename(tmp, target);
    if (mode !== 'replace' && !original && renameLevel) await renameLevel(target).catch(() => {});
    return { folder: path.basename(target), original };
  } finally {
    await rmrf(tmp).catch(() => {});
  }
}

// Todas las copias de todas las instancias
async function listAll() {
  let dirs = [];
  try {
    dirs = (await fsp.readdir(root(), { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) out.push(...(await list(d.name)));
  return out.sort((a, b) => b.time - a.time);
}

async function remove(file, { trash } = {}) {
  if (trash) {
    try {
      await trash(file);
      return true;
    } catch {
      /* sin papelera: se borra (es una copia, el mundo sigue intacto) */
    }
  }
  await fsp.rm(file, { force: true });
  return true;
}

module.exports = { root, dirFor, stamp, parseName, create, list, listAll, restore, remove, checkBackupPath };
