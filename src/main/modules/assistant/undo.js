'use strict';
// Diario de "Deshacer" del asistente.
// Antes de cada cambio reversible se guarda una instantanea de la configuracion de la instancia
// (venus-instance.json, options.txt y la lista de mods/packs con su sha1) y una copia de cada archivo que la
// accion va a reemplazar o quitar, en <instancia>/.venus/assistant-undo/<id>/. La accion registra ademas sus
// operaciones inversas exactas: deshacer revierte SOLO esa accion (no pisa cambios posteriores ajenos).
// El indice vive en data/assistant/undo.json.
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../../core/paths');
const instances = require('../../core/instances');
const settings = require('../../core/settings');
const { readJson, writeJson, uid, hashFile, exists, rmrf } = require('../../core/util');
const { t } = require('../../core/i18n');
const options = require('./options');
const safety = require('../packs/safety');
const { ToolError, insideDir, CONTENT_KINDS, assertBareFileName } = require('./guards');

const MAX_ENTRIES = 300;
const MAX_AGE = 30 * 24 * 3600 * 1000;
const UNDO_DIR = 'assistant-undo';

let journal = null;
let chain = Promise.resolve();
let trashFn = null; // shell.trashItem (se configura al registrar el modulo)
let isRunningFn = () => false; // juego abierto en esa instancia
let beforeRemoveInstance = async () => {}; // cancelar tareas de instalacion antes de borrar
let beforeRemoveServerFn = async () => {}; // cancelar la instalacion de un servidor antes de mandarlo a la papelera
let beforeUndoFn = async () => {}; // por ejemplo, frenar la reinstalacion de un cambio de version

function configure({ trash, isRunning, beforeRemove, beforeRemoveServer, beforeUndo } = {}) {
  if (trash !== undefined) trashFn = trash;
  if (isRunning) isRunningFn = isRunning;
  if (beforeRemove) beforeRemoveInstance = beforeRemove;
  if (beforeRemoveServer) beforeRemoveServerFn = beforeRemoveServer;
  if (beforeUndo) beforeUndoFn = beforeUndo;
}

const journalPath = () => path.join(paths.data('assistant'), 'undo.json');

// Servidores locales: las acciones sobre un servidor (scope 'server' / 'servercreate') guardan sus copias dentro de la
// carpeta de ese servidor, igual que las de una instancia (nunca fuera de la carpeta correspondiente).
const serversCore = () => require('../../core/servers');
const SERVER_FOLDERS = ['plugins', 'mods'];

function entryDir(instanceId, id) {
  return path.join(instances.dir(instanceId), '.venus', UNDO_DIR, id);
}

function entryDirOf(entry) {
  return entry.serverId ? path.join(serversCore().dir(entry.serverId), '.venus', UNDO_DIR, entry.id) : entryDir(entry.instanceId, entry.id);
}

// ¿La accion guarda una carpeta de copias (instantanea + archivos)?
const hasEntryDir = (e) => (e.scope === 'instance' && Boolean(e.instanceId)) || (e.scope === 'server' && Boolean(e.serverId));

async function load() {
  if (!journal) {
    const data = await readJson(journalPath(), null);
    journal = { version: 1, entries: Array.isArray(data?.entries) ? data.entries.filter((e) => e && typeof e.id === 'string') : [] };
  }
  return journal;
}

function persist() {
  chain = chain
    .then(() => writeJson(journalPath(), journal))
    .catch((err) => console.error('[assistant] No se pudo guardar undo.json:', err.message));
  return chain;
}

// ---------- Hashes (con cache por tamaño y fecha) ----------
const hashCache = new Map();
async function sha1Of(full) {
  const st = await fsp.stat(full).catch(() => null);
  if (!st || !st.isFile()) return null;
  const key = `${full}|${st.size}|${st.mtimeMs}`;
  if (hashCache.has(key)) return hashCache.get(key);
  const h = await hashFile(full, 'sha1').catch(() => null);
  if (hashCache.size > 5000) hashCache.clear();
  hashCache.set(key, h);
  return h;
}

// Lista de mods, resource packs y shaders con su sha1 (las carpetas solo con nombre).
async function inventory(instanceDir) {
  const out = {};
  for (const kind of CONTENT_KINDS) {
    const dir = path.join(instanceDir, kind);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    out[kind] = [];
    for (const e of entries) {
      if (e.isDirectory()) out[kind].push({ file: e.name, dir: true });
      else if (e.isFile()) {
        const full = path.join(dir, e.name);
        const st = await fsp.stat(full).catch(() => null);
        out[kind].push({ file: e.name, size: st?.size || 0, sha1: await sha1Of(full) });
      }
    }
  }
  return out;
}

// Plugins y mods de un servidor con su sha1 (solo para la instantanea del Deshacer).
async function serverInventory(serverDir) {
  const out = {};
  for (const kind of SERVER_FOLDERS) {
    const dir = path.join(serverDir, kind);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    out[kind] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = path.join(dir, e.name);
      const st = await fsp.stat(full).catch(() => null);
      out[kind].push({ file: e.name, size: st?.size || 0, sha1: await sha1Of(full) });
    }
  }
  return out;
}

// ---------- Accion en curso ----------
class Action {
  constructor(entry) {
    this.entry = entry;
    this.backups = 0;
  }

  get id() {
    return this.entry.id;
  }

  // Lo que toca la accion (para detectar cambios posteriores sobre lo mismo).
  target(...names) {
    for (const n of names) if (n && !this.entry.targets.includes(n)) this.entry.targets.push(n);
  }

  // Operacion inversa (se aplican en orden inverso al deshacer).
  op(o) {
    this.entry.ops.push(o);
  }

  // Copia un archivo de la instancia al directorio de la accion. Devuelve la ruta relativa de la copia.
  async backup(folder, file) {
    const server = Boolean(this.entry.serverId);
    if (!server && !this.entry.instanceId) throw new Error('backup sin instancia');
    if (!(server ? SERVER_FOLDERS : CONTENT_KINDS).includes(folder)) throw new ToolError(t('assistant.errKind', { kind: folder }));
    assertBareFileName(file);
    const src = insideDir(server ? serversCore().dir(this.entry.serverId) : instances.dir(this.entry.instanceId), folder, file);
    const rel = `files/${++this.backups}-${file}`;
    const dest = path.join(entryDirOf(this.entry), rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
    return rel;
  }
}

// Empieza una accion: guarda la instantanea de la configuracion de la instancia.
// scope: 'instance' (cambio en una instancia existente) | 'create' (instancia nueva) | 'global' (ajustes globales)
async function begin({ conversationId, toolUseId, tool, instanceId = null, serverId = null, scope = 'instance' }) {
  await load();
  const entry = {
    id: `u${uid(12)}`,
    conversationId: conversationId || null,
    toolUseId: toolUseId || null,
    tool,
    instanceId,
    ...(serverId ? { serverId } : {}),
    scope,
    createdAt: Date.now(),
    state: 'pending',
    targets: [],
    ops: [],
    summary: '',
    snapshot: null,
  };
  if (scope === 'instance' && instanceId) {
    const inst = await instances.get(instanceId);
    const dir = entryDir(instanceId, entry.id);
    await fsp.mkdir(dir, { recursive: true });
    const { dir: _d, running: _r, ...meta } = inst;
    const opts = await options.read(inst.dir);
    const snapshot = { createdAt: entry.createdAt, tool, meta, options: opts.text, content: await inventory(inst.dir) };
    await writeJson(path.join(dir, 'snapshot.json'), snapshot);
    entry.snapshot = 'snapshot.json';
  } else if (scope === 'server' && serverId) {
    const server = await serversCore().get(serverId);
    const dir = entryDirOf(entry);
    await fsp.mkdir(dir, { recursive: true });
    const { dir: _d, state: _s, players: _p, playerInfo: _pi, startedAt: _a, pid: _pid, busy: _b, ...meta } = server;
    const properties = await fsp.readFile(path.join(server.dir, 'server.properties'), 'utf8').catch(() => '');
    const snapshot = { createdAt: entry.createdAt, tool, meta, properties, content: await serverInventory(server.dir) };
    await writeJson(path.join(dir, 'snapshot.json'), snapshot);
    entry.snapshot = 'snapshot.json';
  } else if (scope === 'global') {
    const s = await settings.get();
    entry.snapshot = { memoryMode: s.memoryMode, memory: s.memory, manualMax: s.perf?.manualMax ?? null };
  }
  return new Action(entry);
}

// La accion termino bien: queda disponible para deshacer.
async function commit(action, { summary = '' } = {}) {
  await load();
  action.entry.state = 'active';
  action.entry.summary = String(summary).slice(0, 300);
  journal.entries.push(action.entry);
  await prune();
  await persist();
  return action.entry.id;
}

// La accion fallo a mitad de camino: se revierte lo que alcanzo a hacer.
async function abort(action) {
  const warnings = await applyOps(action.entry, { lenient: true });
  action.entry.state = 'failed';
  if (hasEntryDir(action.entry)) await rmrf(entryDirOf(action.entry)).catch(() => {});
  return warnings;
}

async function prune() {
  const now = Date.now();
  const keep = [];
  const drop = [];
  const list = journal.entries.slice();
  list.forEach((e, i) => {
    const old = now - e.createdAt > MAX_AGE;
    const over = list.length - i > MAX_ENTRIES;
    (old || over ? drop : keep).push(e);
  });
  journal.entries = keep;
  for (const e of drop) {
    if (hasEntryDir(e)) await rmrf(entryDirOf(e)).catch(() => {});
  }
}

// ---------- Operaciones inversas ----------
async function trashOrRemove(full) {
  if (trashFn) {
    try {
      await trashFn(full);
      return;
    } catch {
      /* sin papelera: se borra (es un archivo que agrego la propia accion) */
    }
  }
  await fsp.rm(full, { force: true, recursive: true });
}

function setPath(obj, dotted, had, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = cur[keys[i]] && typeof cur[keys[i]] === 'object' ? { ...cur[keys[i]] } : {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = had ? value : undefined;
}

function serverDirOf(entry, folder) {
  if (!entry.serverId) throw new ToolError(t('assistantx.errNoServerEntry'), 'server');
  if (!SERVER_FOLDERS.includes(folder)) throw new ToolError(t('assistant.errKind', { kind: String(folder) }), 'kind');
  return serversCore().dir(entry.serverId);
}

// El servidor ya tiene un mundo? (level.dat en alguna carpeta de primer nivel)
async function serverHasWorld(serverId) {
  const dir = serversCore().dir(serverId);
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isDirectory() && (await exists(path.join(dir, e.name, 'level.dat')))) return true;
  return false;
}

async function applyOp(entry, o, warnings) {
  const instDir = entry.instanceId ? instances.dir(entry.instanceId) : null;
  switch (o.type) {
    case 'restoreFile': {
      const src = insideDir(entryDirOf(entry), o.backup);
      const dest = insideDir(instDir, o.folder, o.file);
      if (!(await exists(src))) {
        warnings.push(t('assistant.undoWarnBackupMissing', { file: o.file }));
        return;
      }
      // Temporal + renombrado: si en ese lugar hay un archivo que es un enlace duro del almacen (storage),
      // se reemplaza solo en esta instancia en vez de cambiarlo en todas las que lo comparten.
      await safety.copyFileAtomic(src, dest);
      return;
    }
    case 'removeFile': {
      const full = insideDir(instDir, o.folder, o.file);
      if (!(await exists(full))) return;
      if (o.sha1) {
        const now = await sha1Of(full);
        if (now && now !== o.sha1) {
          warnings.push(t('assistant.undoWarnChanged', { file: o.file }));
          return;
        }
      }
      await trashOrRemove(full);
      return;
    }
    case 'rename': {
      const from = insideDir(instDir, o.folder, o.from);
      const to = insideDir(instDir, o.folder, o.to);
      if (!(await exists(from))) {
        warnings.push(t('assistant.undoWarnMissing', { file: o.from }));
        return;
      }
      if (await exists(to)) {
        warnings.push(t('assistant.undoWarnExists', { file: o.to }));
        return;
      }
      await fsp.rename(from, to);
      return;
    }
    case 'meta': {
      // Dentro de la cola de la instancia, sobre los datos recien leidos.
      await instances.update(entry.instanceId, (cur) => {
        const patch = {};
        for (const f of o.fields || []) {
          const top = f.path.split('.')[0];
          if (f.path.includes('.') && !patch[top]) patch[top] = { ...(cur[top] || {}) };
          setPath(patch, f.path, f.had, f.value);
        }
        return patch;
      });
      return;
    }
    case 'projects': {
      const src = o.source === 'curseforge' ? 'curseforge' : 'modrinth';
      // Funcion: el parche manda (puede quitar el registro aunque el archivo siga en la carpeta).
      await instances.update(entry.instanceId, (cur) => {
        const projects = { ...(cur[src]?.projects || {}) };
        for (const r of o.records || []) {
          if (r.had) projects[r.id] = r.value;
          else delete projects[r.id];
        }
        return { [src]: { ...(cur[src] || {}), projects } };
      });
      return;
    }
    case 'option': {
      await options.setRaw(instDir, o.fileKey, o.had ? o.raw : null);
      if (!o.fileExisted) await options.removeIfEmpty(instDir);
      return;
    }
    case 'settings': {
      await settings.set(o.patch || {});
      return;
    }
    // ----- Servidores locales (solo plugins/ y mods/ del servidor de la accion) -----
    case 'srvRestoreFile': {
      const srvDir = serverDirOf(entry, o.folder);
      const src = insideDir(entryDirOf(entry), o.backup);
      const dest = insideDir(srvDir, o.folder, o.file);
      if (!(await exists(src))) {
        warnings.push(t('assistant.undoWarnBackupMissing', { file: o.file }));
        return;
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await safety.copyFileAtomic(src, dest);
      return;
    }
    case 'srvRemoveFile': {
      const full = insideDir(serverDirOf(entry, o.folder), o.folder, o.file);
      if (!(await exists(full))) return;
      if (o.sha1) {
        const now = await sha1Of(full);
        if (now && now !== o.sha1) {
          warnings.push(t('assistant.undoWarnChanged', { file: o.file }));
          return;
        }
      }
      await trashOrRemove(full);
      return;
    }
    case 'srvRename': {
      const dir = serverDirOf(entry, o.folder);
      const from = insideDir(dir, o.folder, o.from);
      const to = insideDir(dir, o.folder, o.to);
      if (!(await exists(from))) {
        warnings.push(t('assistant.undoWarnMissing', { file: o.from }));
        return;
      }
      if (await exists(to)) {
        warnings.push(t('assistant.undoWarnExists', { file: o.to }));
        return;
      }
      await fsp.rename(from, to);
      return;
    }
    case 'srvMeta': {
      await serversCore().patchMeta(entry.serverId, (cur) => {
        const next = { ...cur };
        for (const f of o.fields || []) {
          if (!/^[a-zA-Z]+$/.test(f.path)) continue; // solo campos de primer nivel del servidor
          if (f.had) next[f.path] = f.value;
          else delete next[f.path];
        }
        return next;
      });
      return;
    }
    case 'srvProjects': {
      await serversCore().patchMeta(entry.serverId, (cur) => {
        const projects = { ...(cur.modrinth?.projects || {}) };
        for (const r of o.records || []) {
          if (r.had) projects[r.id] = r.value;
          else delete projects[r.id];
        }
        return { ...cur, modrinth: { ...(cur.modrinth || {}), projects } };
      });
      return;
    }
    case 'srvProperty': {
      const sv = serversCore();
      await sv.writePropertiesRaw(entry.serverId, { [o.key]: o.had ? o.value : null });
      if (o.key === 'server-port' && o.had && /^\d+$/.test(String(o.value))) await sv.patchMeta(entry.serverId, { port: Number(o.value) });
      return;
    }
    case 'removeBackupFile': {
      // Copia de un mundo que hizo la propia accion (zip): va a la papelera, nunca se borra del todo.
      assertBareFileName(o.name);
      if (!/\.zip$/i.test(o.name)) return;
      const base = o.server ? path.join(serversCore().dir(entry.serverId), 'backups') : require('../worlds/backups').dirFor(entry.instanceId);
      const full = insideDir(base, o.name);
      if (!(await exists(full))) return;
      if (!trashFn) {
        warnings.push(t('assistantx.undoWarnNoTrash', { file: o.name }));
        return;
      }
      try {
        await trashFn(full);
      } catch {
        warnings.push(t('assistantx.undoWarnNoTrash', { file: o.name }));
      }
      return;
    }
    case 'removeSnapshot': {
      const snaps = require('../snapshots');
      await snaps.remove(entry.instanceId, o.snapshotId).catch((err) => warnings.push(err?.message || String(err)));
      return;
    }
    case 'removeServer': {
      const sv = serversCore();
      if (sv.isRunning(o.serverId)) throw new ToolError(t('assistantx.undoErrServerRunning'), 'running');
      if (await serverHasWorld(o.serverId)) throw new ToolError(t('assistantx.undoErrServerHasWorld'), 'worlds');
      await beforeRemoveServerFn(o.serverId);
      const target = sv.dir(o.serverId);
      if (await exists(target)) await trashOrRemove(target);
      sv.clearLogs(o.serverId);
      return;
    }
    case 'removeInstance': {
      if (isRunningFn(o.instanceId)) throw new ToolError(t('assistant.errGameRunning'), 'running');
      const worlds = await countWorlds(instances.dir(o.instanceId));
      if (worlds > 0) throw new ToolError(t('assistant.undoErrHasWorlds', { count: worlds }), 'worlds');
      await beforeRemoveInstance(o.instanceId);
      await instances.remove(o.instanceId);
      return;
    }
    default:
      warnings.push(`? ${o.type}`);
  }
}

async function applyOps(entry, { lenient = false } = {}) {
  const warnings = [];
  for (const o of entry.ops.slice().reverse()) {
    try {
      await applyOp(entry, o, warnings);
    } catch (err) {
      if (!lenient) throw err;
      warnings.push(err.message);
    }
  }
  return warnings;
}

async function countWorlds(instanceDir) {
  const saves = path.join(instanceDir, 'saves');
  const entries = await fsp.readdir(saves, { withFileTypes: true }).catch(() => []);
  let n = 0;
  for (const e of entries) if (e.isDirectory() && (await exists(path.join(saves, e.name, 'level.dat')))) n++;
  return n;
}

// ---------- Deshacer ----------
function get(id) {
  return journal?.entries.find((e) => e.id === id) || null;
}

async function states(ids) {
  await load();
  const out = {};
  for (const id of ids) {
    const e = get(id);
    out[id] = e ? e.state : 'expired';
  }
  return out;
}

// Revierte exactamente una accion. Devuelve { entry, warnings, cascaded: [entries] }.
async function undo(id) {
  await load();
  const entry = get(id);
  if (!entry) throw new ToolError(t('assistant.undoErrNotFound'), 'notfound');
  if (entry.state === 'undone') throw new ToolError(t('assistant.undoErrAlready'), 'already');
  if (entry.state !== 'active') throw new ToolError(t('assistant.undoErrNotFound'), 'notfound');
  if (entry.instanceId) {
    try {
      await instances.get(entry.instanceId);
    } catch {
      entry.state = 'expired';
      await persist();
      throw new ToolError(t('assistant.undoErrNoInstance'), 'notfound');
    }
    if (isRunningFn(entry.instanceId)) throw new ToolError(t('assistant.errGameRunning'), 'running');
  } else if (entry.serverId && entry.scope !== 'servercreate') {
    try {
      await serversCore().get(entry.serverId);
    } catch {
      entry.state = 'expired';
      await persist();
      throw new ToolError(t('assistantx.undoErrNoServer'), 'notfound');
    }
    // Los jar de un servidor encendido estan abiertos: sus cambios de archivos no se deshacen hasta apagarlo
    if (entry.ops.some((o) => /^(srvRestoreFile|srvRemoveFile|srvRename)$/.test(o.type)) && serversCore().isRunning(entry.serverId)) {
      throw new ToolError(t('assistantx.undoErrServerRunning'), 'running');
    }
  }
  // El diario esta en orden de confirmacion: lo que viene despues es posterior.
  const sameOwner = (e) => (e.instanceId || null) === (entry.instanceId || null) && (e.serverId || null) === (entry.serverId || null);
  const later = journal.entries.slice(journal.entries.indexOf(entry) + 1).filter((e) => e.state === 'active' && sameOwner(e));
  let cascaded = [];
  if (entry.scope === 'create' || entry.scope === 'servercreate') {
    // Deshacer la creacion se lleva puestos los cambios posteriores sobre esa misma instancia.
    cascaded = later;
  } else {
    const blocking = later.filter((e) => e.targets.some((x) => entry.targets.includes(x)));
    if (blocking.length) {
      throw new ToolError(t('assistant.undoErrLater', { action: blocking[blocking.length - 1].summary || blocking[blocking.length - 1].tool }), 'later');
    }
  }
  await beforeUndoFn(entry);
  const warnings = await applyOps(entry);
  entry.state = 'undone';
  entry.undoneAt = Date.now();
  for (const e of cascaded) {
    e.state = 'undone';
    e.undoneAt = entry.undoneAt;
  }
  if (hasEntryDir(entry)) await rmrf(entryDirOf(entry)).catch(() => {});
  await persist();
  return { entry, warnings, cascaded };
}

// Para pruebas: vaciar la cache en memoria
function _reset() {
  journal = null;
  hashCache.clear();
}

module.exports = { configure, begin, commit, abort, undo, states, get: async (id) => (await load(), get(id)), list: async () => (await load()).entries.slice(), sha1Of, inventory, countWorlds, _reset };
