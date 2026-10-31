'use strict';
// Mundo del servidor: informacion (semilla, tamaño, version), importar un mundo de una instancia,
// copias de seguridad en ZIP (con save-off / save-all mientras corre), restaurar, regenerar y data packs.
const fsp = require('fs/promises');
const path = require('path');
const nbt = require('../../core/nbt');
const servers = require('../../core/servers');
const { t } = require('../../core/i18n');
const { exists, dirSize, rmrf } = require('../../core/util');
const zip = require('./zip');

let trashFn = null;
function setTrash(fn) {
  trashFn = fn;
}

// Manda a la papelera. Si la papelera falla y `hard` es true se borra del todo (copias automaticas viejas,
// icono); si no, se frena con un error y no se borra (mundos, copias, data packs, el servidor entero).
async function trash(p, { hard = false, name } = {}) {
  if (!(await exists(p))) return;
  if (trashFn) {
    try {
      await trashFn(p);
      return;
    } catch {
      if (!hard) throw new Error(t('servers.errTrash', { name: name || path.basename(p) }));
    }
  }
  await rmrf(p);
}

const inside = (root, p) => {
  const r = path.resolve(root);
  const full = path.resolve(p);
  return full === r || full.startsWith(r + path.sep);
};

async function levelName(id) {
  const p = await servers.readProperties(id);
  const name = String(p['level-name'] || 'world').trim() || 'world';
  if (!inside(servers.dir(id), path.join(servers.dir(id), name)) || path.resolve(servers.dir(id), name) === path.resolve(servers.dir(id))) {
    throw new Error(t('servers.errLevelName'));
  }
  return name;
}

// Carpetas del mundo: la principal y las de Bukkit/Paper (<mundo>_nether, <mundo>_the_end).
async function worldFolders(id) {
  const level = await levelName(id);
  const sdir = servers.dir(id);
  const out = [];
  for (const name of [level, `${level}_nether`, `${level}_the_end`]) {
    const full = path.join(sdir, name);
    if (await exists(full)) out.push({ dir: full, prefix: name.split(/[\\/]/).join('/') });
  }
  return { level, dir: path.join(sdir, level), folders: out };
}

function findSeed(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(value)) {
    if (/^(seed|RandomSeed)$/i.test(k) && (typeof v === 'bigint' || typeof v === 'number')) return String(v);
  }
  for (const v of Object.values(value)) {
    if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && !Array.isArray(v)) {
      const s = findSeed(v, depth + 1);
      if (s) return s;
    }
  }
  return null;
}

async function info(id) {
  const { level, dir, folders } = await worldFolders(id);
  const out = { levelName: level, path: dir, exists: folders.length > 0, size: 0, seed: null, version: null, lastPlayed: null, hardcore: null, dims: [], datapacks: 0 };
  if (!out.exists) return out;
  for (const f of folders) out.size += await dirSize(f.dir);
  try {
    const { value } = await nbt.readFile(path.join(dir, 'level.dat'));
    const data = value.Data || {};
    out.version = data.Version?.Name || null;
    out.lastPlayed = data.LastPlayed !== undefined ? Number(data.LastPlayed) : null;
    out.hardcore = data.hardcore !== undefined ? Boolean(data.hardcore) : null;
    out.seed = findSeed(data.WorldGenSettings) || (data.RandomSeed !== undefined ? String(data.RandomSeed) : null);
    out.name = data.LevelName || level;
  } catch {
    /* level.dat ilegible o todavia no creado */
  }
  if (!out.seed) {
    try {
      const { value } = await nbt.readFile(path.join(dir, 'data', 'minecraft', 'world_gen_settings.dat'));
      out.seed = findSeed(value);
    } catch {
      /* formato anterior a 26.1 */
    }
  }
  const dimChecks = [
    ['overworld', [dir]],
    ['nether', [path.join(dir, 'DIM-1'), path.join(dir, 'dimensions', 'minecraft', 'the_nether'), path.join(servers.dir(id), `${level}_nether`)]],
    ['end', [path.join(dir, 'DIM1'), path.join(dir, 'dimensions', 'minecraft', 'the_end'), path.join(servers.dir(id), `${level}_the_end`)]],
  ];
  for (const [name, candidates] of dimChecks) {
    for (const c of candidates) {
      if (await exists(c)) {
        out.dims.push(name);
        break;
      }
    }
  }
  out.datapacks = (await listDatapacks(id).catch(() => [])).length;
  return out;
}

function ensureOffline(id) {
  if (servers.isRunning(id)) throw new Error(t('servers.errStopFirst'));
}

// Copia saves/<carpeta> de una instancia como mundo del servidor.
async function importFromInstance(id, instanceId, folder, { replace = false } = {}) {
  ensureOffline(id);
  const instances = require('../../core/instances');
  if (typeof instanceId !== 'string' || !/^[\w.-]+$/.test(instanceId) || /^\.+$/.test(instanceId)) throw new Error(t('servers.errWorldName'));
  if (typeof folder !== 'string' || !folder || /[\\/]|^\.\.?$/.test(folder)) throw new Error(t('servers.errWorldName'));
  const src = path.join(instances.dir(instanceId), 'saves', folder);
  if (!(await exists(path.join(src, 'level.dat')))) throw new Error(t('servers.errNoWorld'));
  const { dir, folders } = await worldFolders(id);
  if (folders.length && !replace) throw Object.assign(new Error(t('servers.errWorldExists')), { code: 'exists' });
  for (const f of folders) await trash(f.dir);
  await fsp.cp(src, dir, { recursive: true, filter: (p) => !/[\\/]session\.lock$/i.test(p) });
  return info(id);
}

function stampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

const backupsDir = (id) => path.join(servers.dir(id), 'backups');

// Copia del mundo en backups/<mundo>-<fecha>.zip. Con el servidor encendido desactiva el guardado
// automatico mientras comprime para que los archivos no cambien a mitad de la copia.
async function backup(id, { auto = false, task } = {}) {
  const { level, folders } = await worldFolders(id);
  if (!folders.length) throw new Error(t('servers.errNoWorld'));
  const state = servers.runtimeState(id);
  if (state === 'starting' || state === 'stopping') throw new Error(t('servers.errBusy'));
  const live = state === 'online';
  const safeLevel = level.replace(/[^\w.-]+/g, '_');
  const file = path.join(backupsDir(id), `${safeLevel}-${stampName()}${auto ? '-auto' : ''}.zip`);
  if (live) {
    servers.command(id, 'save-off');
    const saved = servers.waitForLine(id, /Saved the (game|world)|All dimensions are saved|saved the world/i, 60000);
    servers.command(id, 'save-all flush');
    task?.update({ detail: t('servers.detailSaving'), progress: null });
    await saved;
  }
  try {
    const res = await zip.zipFolders(folders, file, {
      exclude: (rel) => /(^|\/)session\.lock$/i.test(rel),
      signal: task?.signal,
      onProgress: ({ bytes, totalBytes }) => {
        if (totalBytes) task?.update({ detail: t('servers.detailZipping', { done: (bytes / 1048576).toFixed(0), total: (totalBytes / 1048576).toFixed(0) }), progress: bytes / totalBytes });
      },
    });
    servers.venusLog(id, t('servers.logBackup', { file: path.basename(file) }));
    return { name: path.basename(file), file, size: res.size, time: Date.now(), auto };
  } finally {
    if (live && servers.isRunning(id)) {
      try {
        servers.command(id, 'save-on');
      } catch {
        /* el servidor se apago */
      }
    }
  }
}

async function listBackups(id) {
  let names = [];
  try {
    names = await fsp.readdir(backupsDir(id));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.zip')) continue;
    const st = await fsp.stat(path.join(backupsDir(id), name)).catch(() => null);
    if (st?.isFile()) out.push({ name, file: path.join(backupsDir(id), name), size: st.size, time: st.mtimeMs, auto: /-auto\.zip$/i.test(name) });
  }
  return out.sort((a, b) => b.time - a.time);
}

function backupPath(id, name) {
  const base = path.basename(String(name || ''));
  if (!base.toLowerCase().endsWith('.zip') || base !== name) throw new Error(t('servers.errBackupName'));
  return path.join(backupsDir(id), base);
}

async function deleteBackup(id, name) {
  await trash(backupPath(id, name));
  return true;
}

// Rota las copias automaticas: deja solo las ultimas "keep".
async function pruneAuto(id, keep) {
  const autos = (await listBackups(id)).filter((b) => b.auto);
  for (const b of autos.slice(Math.max(1, keep))) await trash(b.file, { hard: true }).catch(() => {});
}

async function restore(id, name, task) {
  ensureOffline(id);
  const file = backupPath(id, name);
  if (!(await exists(file))) throw new Error(t('servers.errBackupName'));
  const entries = await zip.listEntries(file);
  const { folders } = await worldFolders(id);
  const tops = new Set(entries.map((e) => e.name.split('/')[0]));
  for (const f of folders) await trash(f.dir);
  // Tambien se reemplazan carpetas del zip que no coinciden con el nombre actual del mundo.
  for (const top of tops) if (top && !folders.some((f) => f.prefix === top)) await trash(path.join(servers.dir(id), top));
  await zip.unzip(file, servers.dir(id), {
    signal: task?.signal,
    filter: (n) => !/^(eula\.txt|server\.properties|venus-server\.json)$/i.test(n) && !/\.jar$/i.test(n),
    onProgress: ({ bytes, totalBytes }) => totalBytes && task?.update({ detail: t('servers.detailUnzipping'), progress: bytes / totalBytes }),
  });
  servers.venusLog(id, t('servers.logRestored', { file: name }));
  return info(id);
}

async function regenerate(id, { seed, levelType } = {}) {
  ensureOffline(id);
  const { folders } = await worldFolders(id);
  for (const f of folders) await trash(f.dir);
  const patch = {};
  if (seed !== undefined && seed !== null) patch['level-seed'] = String(seed).trim().slice(0, 100);
  if (levelType) patch['level-type'] = String(levelType);
  if (Object.keys(patch).length) await servers.writeProperties(id, patch);
  servers.venusLog(id, t('servers.logRegenerated'));
  return info(id);
}

// ---------- Data packs ----------

async function datapackDir(id) {
  const { dir } = await worldFolders(id);
  return path.join(dir, 'datapacks');
}

function flattenText(desc) {
  if (desc === null || desc === undefined) return '';
  if (typeof desc === 'string') return desc;
  if (Array.isArray(desc)) return desc.map(flattenText).join('');
  if (typeof desc === 'object') return `${desc.text || desc.translate || ''}${desc.extra ? flattenText(desc.extra) : ''}`;
  return String(desc);
}

async function packMeta(full, isDir) {
  try {
    let raw;
    if (isDir) raw = await fsp.readFile(path.join(full, 'pack.mcmeta'), 'utf8');
    else {
      const AdmZip = require('adm-zip');
      const st = await fsp.stat(full);
      if (st.size > 64 * 1024 * 1024) return null;
      raw = new AdmZip(full).readAsText('pack.mcmeta');
    }
    if (!raw) return null;
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

async function enabledPacks(id) {
  const { dir } = await worldFolders(id);
  try {
    const { value } = await nbt.readFile(path.join(dir, 'level.dat'));
    const dp = value.Data?.DataPacks || {};
    return { enabled: dp.Enabled || [], disabled: dp.Disabled || [] };
  } catch {
    return { enabled: [], disabled: [] };
  }
}

async function listDatapacks(id) {
  const folder = await datapackDir(id);
  let entries = [];
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const state = await enabledPacks(id);
  const out = [];
  for (const e of entries) {
    const full = path.join(folder, e.name);
    const isDir = e.isDirectory();
    if (!isDir && !e.name.toLowerCase().endsWith('.zip')) continue;
    const meta = await packMeta(full, isDir);
    if (isDir && !meta) continue;
    const st = await fsp.stat(full).catch(() => null);
    const ref = `file/${e.name}`;
    out.push({
      name: e.name,
      isDir,
      size: isDir ? await dirSize(full) : st?.size || 0,
      description: flattenText(meta?.pack?.description).slice(0, 300),
      enabled: !state.disabled.includes(ref),
      known: state.enabled.includes(ref) || state.disabled.includes(ref),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function addDatapacks(id, filePaths = []) {
  const folder = await datapackDir(id);
  const { folders } = await worldFolders(id);
  if (!folders.length) throw new Error(t('servers.errNoWorldYet'));
  await fsp.mkdir(folder, { recursive: true });
  const added = [];
  for (const src of filePaths) {
    const st = await fsp.stat(src).catch(() => null);
    if (!st) continue;
    const meta = await packMeta(src, st.isDirectory());
    if (!meta?.pack) throw new Error(t('servers.errNotDatapack', { name: path.basename(src) }));
    const dest = path.join(folder, path.basename(src));
    if (st.isDirectory()) await fsp.cp(src, dest, { recursive: true });
    else await fsp.copyFile(src, dest);
    added.push(path.basename(src));
  }
  if (added.length && servers.isRunning(id)) servers.command(id, 'reload');
  return added;
}

function packName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name || base === '.' || base === '..') throw new Error(t('servers.errWorldName'));
  return base;
}

async function toggleDatapack(id, name, enable) {
  const n = packName(name);
  const ref = `file/${n}`;
  if (servers.isRunning(id)) {
    servers.command(id, `datapack ${enable ? 'enable' : 'disable'} "${ref}"`);
    return true;
  }
  const { dir } = await worldFolders(id);
  const file = path.join(dir, 'level.dat');
  const buf = await fsp.readFile(file);
  const root = nbt.readTyped(buf);
  const data = root.value.Data?.value;
  if (!data) throw new Error(t('servers.errNoWorld'));
  const { TAG } = nbt;
  if (!data.DataPacks) data.DataPacks = { type: TAG.Compound, value: {} };
  const dp = data.DataPacks.value;
  const listOf = (k) => {
    if (!dp[k] || dp[k].type !== TAG.List) dp[k] = { type: TAG.List, value: { itemType: TAG.String, items: [] } };
    return dp[k].value;
  };
  const en = listOf('Enabled');
  const dis = listOf('Disabled');
  en.items = en.items.filter((i) => i.value !== ref);
  dis.items = dis.items.filter((i) => i.value !== ref);
  (enable ? en : dis).items.push({ type: TAG.String, value: ref });
  en.itemType = TAG.String;
  dis.itemType = TAG.String;
  await fsp.copyFile(file, `${file}.venus-bak`).catch(() => {});
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, nbt.write(root, { gzip: buf[0] === 0x1f }));
  await fsp.rename(tmp, file);
  return true;
}

async function removeDatapack(id, name) {
  const n = packName(name);
  const full = path.join(await datapackDir(id), n);
  await trash(full);
  if (servers.isRunning(id)) servers.command(id, 'reload');
  return true;
}

module.exports = {
  setTrash,
  trash,
  levelName,
  worldFolders,
  info,
  importFromInstance,
  backup,
  listBackups,
  deleteBackup,
  pruneAuto,
  restore,
  regenerate,
  listDatapacks,
  addDatapacks,
  toggleDatapack,
  removeDatapack,
  backupsDir,
};
