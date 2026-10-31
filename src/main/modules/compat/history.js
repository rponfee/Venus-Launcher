'use strict';
// Historial de cambios de mods: cada lote guarda los archivos que se sacaron en
// <instancia o servidor>/.venus/mod-history/<lote>/<carpeta>/<archivo> junto con un index.json,
// y permite volver atrás mod por mod (lo que estaba en su lugar pasa a un lote nuevo, así se puede rehacer).
const fsp = require('fs/promises');
const path = require('path');
const { readJson, writeJson, exists, uid, dirSize } = require('../../core/util');
const { t } = require('../../core/i18n');
const safety = require('../packs/safety');
const targets = require('./target');

const HISTORY = path.join('.venus', 'mod-history');
const FOLDERS = new Set(['mods', 'resourcepacks', 'shaderpacks', 'plugins']);
const TYPE_BY_FOLDER = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader', plugins: 'plugin' };

const historyDir = (baseDir) => path.join(baseDir, HISTORY);
const strip = (name) => String(name || '').replace(/\.disabled$/i, '');

function isSafeName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 260 && path.basename(name) === name && name !== '.' && name !== '..' && !/[\\/:*?"<>|\x00-\x1f]/.test(name);
}

function assertFolder(folder) {
  if (!FOLDERS.has(folder)) throw new Error(t('compat.errBadPath'));
}

function newBatchId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${uid(4)}`;
}

// Error claro para un archivo que Windows no deja mover porque esta abierto. Si tiene enlaces duros (el
// almacen de storage unifica los repetidos), puede estar abierto desde OTRA instancia que lo comparte.
async function lockedError(err, file) {
  if (!safety.isLockError(err)) return err;
  const shared = await safety.isSharedFile(file);
  return Object.assign(new Error(t(shared ? 'compat.errFileShared' : 'compat.errFileLocked', { file: path.basename(file) })), { code: err.code, shared, cause: err });
}

// Mueve un archivo renombrando (en otro disco: copia por temporal y borra el original). Nunca se escribe
// encima de un archivo existente: si fuera un enlace duro, cambiaria en todas las instancias que lo comparten.
async function moveFile(from, to) {
  try {
    await safety.moveFile(from, to);
  } catch (err) {
    throw await lockedError(err, from);
  }
}

function createBatch(baseDir, reason, extra = {}) {
  const id = newBatchId();
  return { id, dir: path.join(historyDir(baseDir), id), baseDir, index: { version: 1, id, createdAt: Date.now(), reason, ...extra, entries: [] } };
}

function nextEntryId(batch) {
  return `${batch.id}:${batch.index.entries.length}`;
}

// Mueve <base>/<carpeta>/<archivo> al lote y devuelve el nombre con el que quedo guardado.
async function stash(batch, folder, file) {
  assertFolder(folder);
  if (!isSafeName(file)) throw new Error(t('compat.errBadPath'));
  let name = file;
  let n = 2;
  while (await exists(path.join(batch.dir, folder, name))) name = `${n++}-${file}`;
  await moveFile(path.join(batch.baseDir, folder, file), path.join(batch.dir, folder, name));
  return name;
}

async function saveBatch(batch) {
  if (!batch.index.entries.length) return false;
  for (const e of batch.index.entries) delete e.placed;
  await writeJson(path.join(batch.dir, 'index.json'), batch.index);
  return true;
}

// Deshace (lo mejor posible) las entradas ya aplicadas de un lote que fallo a mitad de camino.
// Solo se borra el archivo nuevo de las entradas marcadas "placed" (las que llegaron a moverse a su lugar).
async function undoEntries(batch, entries) {
  for (const e of [...entries].reverse()) {
    try {
      if (e.placed && e.new?.file) {
        const cur = path.join(batch.baseDir, e.folder, e.new.file + (e.new.disabled ? '.disabled' : ''));
        await fsp.rm(cur, { force: true });
      }
      if (e.old?.storedAs) {
        await moveFile(path.join(batch.dir, e.folder, e.old.storedAs), path.join(batch.baseDir, e.folder, e.old.file + (e.old.disabled ? '.disabled' : '')));
      }
    } catch (err) {
      console.error('[compat] No se pudo deshacer', e.old?.file || e.new?.file, err?.message || err);
    }
  }
}

async function readBatches(baseDir) {
  const root = historyDir(baseDir);
  let names = [];
  try {
    names = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const index = await readJson(path.join(root, name, 'index.json'), null);
    if (index && Array.isArray(index.entries)) out.push({ id: name, dir: path.join(root, name), baseDir, index });
  }
  return out.sort((a, b) => (b.index.createdAt || 0) - (a.index.createdAt || 0) || b.id.localeCompare(a.id));
}

// Historial para la interfaz: lotes con sus entradas y si se pueden revertir.
async function list(baseDir) {
  const batches = await readBatches(baseDir);
  const out = [];
  for (const b of batches) {
    const entries = [];
    for (const e of b.index.entries) {
      const stored = e.old?.storedAs ? await exists(path.join(b.dir, e.folder, e.old.storedAs)) : false;
      let current = false;
      if (e.new?.file) current = (await exists(path.join(baseDir, e.folder, e.new.file))) || (await exists(path.join(baseDir, e.folder, `${e.new.file}.disabled`)));
      entries.push({ ...e, available: !e.rolledBack && (e.old ? stored : current), stored });
    }
    out.push({ id: b.id, createdAt: b.index.createdAt, reason: b.index.reason, of: b.index.of || null, entries });
  }
  return { batches: out, size: await dirSize(historyDir(baseDir)), dir: historyDir(baseDir) };
}

async function findEntry(baseDir, entryId) {
  const batchId = String(entryId || '').split(':')[0];
  if (!/^[\w-]+$/.test(batchId)) return null;
  const batch = (await readBatches(baseDir)).find((b) => b.id === batchId);
  const entry = batch?.index.entries.find((e) => e.id === entryId);
  return entry ? { batch, entry } : null;
}

function recordFor(entrySide, folder, extra) {
  return {
    title: entrySide.title || extra.title || entrySide.file,
    icon: entrySide.icon ?? extra.icon ?? null,
    type: TYPE_BY_FOLDER[folder] || 'mod',
    versionId: entrySide.versionId || null,
    versionNumber: entrySide.versionNumber || null,
    file: entrySide.file,
    folder,
    installedAt: Date.now(),
  };
}

// Aplica a los registros de Modrinth del destino los cambios de unas entradas (lo sacado se borra, lo puesto se agrega).
async function applyRecords(target, entries) {
  await targets.updateRecords(target, (projects) => {
    for (const e of entries) {
      if (e.old?.projectId && projects[e.old.projectId] && strip(projects[e.old.projectId].file) === e.old.file) delete projects[e.old.projectId];
    }
    for (const e of entries) {
      if (e.new?.projectId) projects[e.new.projectId] = { ...(projects[e.new.projectId] || {}), ...recordFor(e.new, e.folder, e) };
    }
  });
}

// Vuelve atras una entrada: guarda lo que hay ahora en un lote nuevo y restaura lo que se habia sacado.
async function rollback(target, entryId) {
  const found = await findEntry(target.dir, entryId);
  if (!found) throw new Error(t('compat.errEntryNotFound'));
  const { batch, entry } = found;
  if (entry.rolledBack) throw new Error(t('compat.errAlreadyRolledBack'));
  assertFolder(entry.folder);
  const folder = entry.folder;
  const base = target.dir;
  const oldPath = entry.old?.storedAs ? path.join(batch.dir, folder, entry.old.storedAs) : null;
  if (entry.old && (!isSafeName(entry.old.storedAs) || !isSafeName(entry.old.file) || !(await exists(oldPath)))) throw new Error(t('compat.errBackupMissing'));

  // Lo que esta ahora en su lugar
  let current = null;
  if (entry.new?.file && isSafeName(entry.new.file)) {
    const rec = entry.new.projectId ? target.records[entry.new.projectId] : null;
    const names = [entry.new.file, `${entry.new.file}.disabled`];
    if (rec?.file && isSafeName(strip(rec.file))) names.push(strip(rec.file), `${strip(rec.file)}.disabled`);
    for (const n of names) {
      if (await exists(path.join(base, folder, n))) {
        current = n;
        break;
      }
    }
  }
  if (!entry.old && !current) throw new Error(t('compat.errNothingToRollback'));

  const nb = createBatch(base, 'rollback', { of: entry.id, title: entry.title || null });
  const applied = [];
  const ne = {
    id: nextEntryId(nb),
    kind: entry.old && current ? 'rollback' : entry.old ? 'restore' : 'remove',
    title: entry.title,
    icon: entry.icon || null,
    folder,
    of: entry.id,
    old: null,
    new: null,
    rolledBack: null,
  };
  nb.index.entries.push(ne);
  try {
    const disabled = current ? /\.disabled$/i.test(current) : Boolean(entry.old?.disabled);
    if (current) {
      const storedAs = await stash(nb, folder, current);
      ne.old = { projectId: entry.new.projectId || null, file: strip(current), storedAs, versionId: entry.new.versionId || null, versionNumber: entry.new.versionNumber || null, disabled: /\.disabled$/i.test(current), title: entry.new.title || entry.title };
    }
    if (entry.old) {
      const destName = entry.old.file + (disabled ? '.disabled' : '');
      if (await exists(path.join(base, folder, destName))) {
        // Otro archivo ocupa el nombre: tambien va al historial
        const storedAs = await stash(nb, folder, destName);
        const extra = { id: nextEntryId(nb), kind: 'replace', title: strip(destName), icon: null, folder, old: { projectId: null, file: strip(destName), storedAs, disabled: /\.disabled$/i.test(destName) }, new: null, rolledBack: null };
        nb.index.entries.push(extra);
        applied.push(extra);
      }
      await moveFile(oldPath, path.join(base, folder, destName));
      ne.new = { projectId: entry.old.projectId || null, file: entry.old.file, versionId: entry.old.versionId || null, versionNumber: entry.old.versionNumber || null, disabled, title: entry.old.title || entry.title };
      ne.placed = true;
    }
    applied.unshift(ne);
  } catch (err) {
    await undoEntries(nb, nb.index.entries);
    throw err;
  }
  await saveBatch(nb);
  entry.rolledBack = { at: Date.now(), batch: nb.id };
  await writeJson(path.join(batch.dir, 'index.json'), batch.index);
  await applyRecords(target, applied);
  return { entry: ne, batch: nb.id };
}

// Mueve todo el historial a la papelera (o lo borra si no hay papelera).
async function clear(baseDir, trash) {
  const dir = historyDir(baseDir);
  if (!(await exists(dir))) return false;
  if (trash) {
    try {
      await trash(dir);
      return true;
    } catch {
      /* borrar */
    }
  }
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  return true;
}

module.exports = { HISTORY, FOLDERS, historyDir, isSafeName, assertFolder, createBatch, nextEntryId, stash, saveBatch, undoEntries, moveFile, lockedError, list, findEntry, rollback, applyRecords, clear, strip };
