'use strict';
// Archivos locales de una instancia para compartir: listado de mods/packs con sha1 (con cache por
// tamaño+fecha), configs de texto chicas, validacion estricta de rutas y escrituras seguras.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson, hashFile } = require('../../core/util');
const { t } = require('../../core/i18n');
const safety = require('../packs/safety');

// Carpetas de contenido que se comparten (por hash de Modrinth) y extensiones validas en cada una.
const CONTENT_FOLDERS = ['mods', 'resourcepacks', 'shaderpacks'];
const CONTENT_EXT = {
  mods: /\.(jar|zip|litemod)$/i,
  resourcepacks: /\.zip$/i,
  shaderpacks: /\.zip$/i,
};
const TYPE_BY_FOLDER = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader' };

// Configs: solo texto, chicas, dentro de config/ (y las opciones del juego en la raiz).
const CONFIG_EXT = /\.(json|json5|jsonc|hjson|toml|properties|cfg|conf|config|txt|yml|yaml|ini|snbt|nbt\.txt|mcmeta|csv|list)$/i;
const OPTION_FILES = ['options.txt', 'optionsof.txt', 'optionsshaders.txt'];
const CONFIG_MAX_FILE = 64 * 1024;
const CONFIG_MAX_TOTAL = 2 * 1024 * 1024;
const CONFIG_MAX_FILES = 1500;
const CONFIG_MAX_DEPTH = 8;
// Archivos que pueden tener claves, tokens o datos de la cuenta: nunca se comparten.
const SECRET_PATH = /(token|secret|password|passwd|credential|oauth|auth|session|account|api[-_]?key|cookie|webhook|private)/i;
const SECRET_CONTENT = /(api[-_ ]?key|token|secret|password|passwd|webhook)["'\s]*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}/i;
// Opciones que dependen de la PC de cada uno (no se pisan al aplicar options.txt).
const DEVICE_OPTIONS = new Set(['soundDevice', 'fullscreenResolution', 'overrideWidth', 'overrideHeight', 'lastServer', 'glDebugVerbosity']);

const HASH_CACHE = 'share-hashes.json';
const VENUS_DIR = '.venus';

function validSegment(s) {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    s.length <= 255 &&
    s !== '.' &&
    s !== '..' &&
    s.trim() === s &&
    !s.endsWith('.') &&
    !/[\\/\x00-\x1f<>:"|?*]/.test(s) &&
    !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)
  );
}

// "mods/sodium.jar" (sin .disabled) -> { folder, base } o null si la ruta no es valida.
function parseContentPath(p) {
  if (typeof p !== 'string') return null;
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length !== 2) return null;
  const [folder, base] = parts;
  if (!CONTENT_FOLDERS.includes(folder) || !validSegment(base) || /\.disabled$/i.test(base)) return null;
  if (!CONTENT_EXT[folder].test(base)) return null;
  return { folder, base };
}

// Ruta de config valida: config/<...> o un archivo de opciones en la raiz.
function parseConfigPath(p) {
  if (typeof p !== 'string' || p.length > 400) return null;
  const norm = p.replace(/\\/g, '/');
  if (OPTION_FILES.includes(norm)) return { path: norm, option: true };
  const parts = norm.split('/');
  if (parts[0] !== 'config' || parts.length < 2 || parts.length > CONFIG_MAX_DEPTH + 1) return null;
  if (!parts.every(validSegment)) return null;
  if (!CONFIG_EXT.test(parts[parts.length - 1])) return null;
  return { path: parts.join('/'), option: false };
}

// Ruta absoluta dentro de la instancia (nunca sale de ella ni toca venus-instance.json o .venus/: las rutas
// llegan en manifiestos de otras personas). Reglas compartidas en packs/safety.
function insideInstance(instDir, rel) {
  const full = safety.resolveInside(instDir, rel);
  if (!full) throw new Error(t('share.errBadPath'));
  return full;
}

const sha1Text = (text) => crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');

// ---------- Listado de contenido con sha1 ----------

async function readHashCache(instDir) {
  const data = await readJson(path.join(instDir, VENUS_DIR, HASH_CACHE), null);
  return data && typeof data === 'object' && data.v === 1 && data.files && typeof data.files === 'object' ? data.files : {};
}

/**
 * Archivos de mods/resourcepacks/shaderpacks: [{ folder, file, base, path, enabled, size, mtime, sha1, dir }]
 * (los packs descomprimidos en carpeta vienen con dir: true y sin sha1).
 */
async function scanContent(instDir, { hash = true, signal } = {}) {
  const cache = hash ? await readHashCache(instDir) : {};
  const nextCache = {};
  const out = [];
  for (const folder of CONTENT_FOLDERS) {
    let entries = [];
    try {
      entries = await fsp.readdir(path.join(instDir, folder), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      if (!validSegment(e.name)) continue;
      const full = path.join(instDir, folder, e.name);
      if (e.isDirectory()) {
        if (folder === 'mods') continue;
        out.push({ folder, file: e.name, base: e.name, path: `${folder}/${e.name}`, enabled: true, size: 0, mtime: 0, sha1: null, dir: true });
        continue;
      }
      if (!e.isFile()) continue;
      const enabled = !/\.disabled$/i.test(e.name);
      const base = enabled ? e.name : e.name.slice(0, -'.disabled'.length);
      if (!CONTENT_EXT[folder].test(base)) continue;
      const st = await fsp.stat(full).catch(() => null);
      if (!st) continue;
      const key = `${folder}/${e.name}`;
      let sha1 = null;
      if (hash) {
        const c = cache[key];
        if (c && c.size === st.size && c.mtime === Math.round(st.mtimeMs) && /^[0-9a-f]{40}$/.test(c.sha1)) sha1 = c.sha1;
        else sha1 = await hashFile(full, 'sha1').catch(() => null);
        if (sha1) nextCache[key] = { size: st.size, mtime: Math.round(st.mtimeMs), sha1 };
      }
      out.push({ folder, file: e.name, base, path: `${folder}/${base}`, enabled, size: st.size, mtime: st.mtimeMs, sha1, dir: false });
    }
  }
  if (hash) await writeJson(path.join(instDir, VENUS_DIR, HASH_CACHE), { v: 1, files: nextCache }).catch(() => {});
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------- Configs ----------

function looksLikeText(buf) {
  if (buf.includes(0)) return false;
  const text = buf.toString('utf8');
  if (text.includes('�') && !Buffer.from(text, 'utf8').equals(buf)) return false;
  return true;
}

async function walkConfig(dir, rel, depth, out) {
  if (depth > CONFIG_MAX_DEPTH) return;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (!validSegment(e.name) || e.name.startsWith('.')) continue;
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) await walkConfig(path.join(dir, e.name), r, depth + 1, out);
    else if (e.isFile()) out.push(r);
  }
}

/**
 * Configs de texto para compartir: [{ path, content }] + lo que se omitio.
 * opts: { includeOptions, maxFile, maxTotal, secrets: false (no filtra datos sensibles; solo para la nube propia) }
 */
async function collectConfigs(instDir, opts = {}) {
  const maxFile = opts.maxFile || CONFIG_MAX_FILE;
  const maxTotal = opts.maxTotal || CONFIG_MAX_TOTAL;
  const filterSecrets = opts.secrets !== false;
  const candidates = [];
  if (opts.includeOptions) {
    for (const f of OPTION_FILES) candidates.push(f);
  }
  const rels = [];
  await walkConfig(path.join(instDir, 'config'), 'config', 1, rels);
  candidates.push(...rels);
  const configs = [];
  const skipped = { large: 0, binary: 0, secret: 0, limit: 0 };
  let total = 0;
  for (const rel of candidates) {
    const parsed = parseConfigPath(rel);
    if (!parsed) {
      if (rel.startsWith('config/')) skipped.binary++;
      continue;
    }
    const full = insideInstance(instDir, parsed.path);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || !st.isFile()) continue;
    if (st.size > maxFile) {
      skipped.large++;
      continue;
    }
    if (filterSecrets && !parsed.option && SECRET_PATH.test(parsed.path.slice('config/'.length))) {
      skipped.secret++;
      continue;
    }
    const buf = await fsp.readFile(full).catch(() => null);
    if (!buf || !looksLikeText(buf)) {
      skipped.binary++;
      continue;
    }
    let content = buf.toString('utf8');
    if (filterSecrets && !parsed.option && SECRET_CONTENT.test(content)) {
      skipped.secret++;
      continue;
    }
    if (parsed.option && filterSecrets) content = stripDeviceOptions(content);
    const size = Buffer.byteLength(content, 'utf8');
    if (configs.length >= CONFIG_MAX_FILES || total + size > maxTotal) {
      skipped.limit++;
      continue;
    }
    total += size;
    configs.push({ path: parsed.path, content });
  }
  return { configs, total, skipped };
}

// ---------- options.txt ----------

function parseOptions(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    map.set(line.slice(0, i), line.slice(i + 1));
  }
  return map;
}

function stripDeviceOptions(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => {
      const i = line.indexOf(':');
      return i <= 0 || !DEVICE_OPTIONS.has(line.slice(0, i));
    })
    .join('\n');
}

// Opciones del pack + las propias de esta PC (dispositivo de audio, resolucion...).
function mergeOptions(incoming, current) {
  const mine = parseOptions(current);
  const lines = stripDeviceOptions(incoming).split(/\r?\n/).filter((l) => l.length);
  for (const key of DEVICE_OPTIONS) {
    if (mine.has(key)) lines.push(`${key}:${mine.get(key)}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------- Escrituras ----------

async function writeTextAtomic(full, content) {
  await safety.writeFileAtomic(full, content, 'utf8');
}

async function readTextIfSmall(full, max = CONFIG_MAX_FILE * 4) {
  try {
    const st = await fsp.stat(full);
    if (!st.isFile() || st.size > max) return null;
    return await fsp.readFile(full, 'utf8');
  } catch {
    return null;
  }
}

// Papelera (Electron) o borrado directo en pruebas con Node.
async function trash(target) {
  let shell = null;
  try {
    shell = require('electron').shell;
  } catch {
    shell = null;
  }
  if (shell?.trashItem) {
    try {
      await shell.trashItem(target);
      return;
    } catch {
      /* sin papelera: se borra */
    }
  }
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

function existsSync(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  CONTENT_FOLDERS,
  CONTENT_EXT,
  TYPE_BY_FOLDER,
  OPTION_FILES,
  CONFIG_MAX_FILE,
  CONFIG_MAX_TOTAL,
  CONFIG_MAX_FILES,
  VENUS_DIR,
  validSegment,
  parseContentPath,
  parseConfigPath,
  insideInstance,
  sha1Text,
  scanContent,
  collectConfigs,
  parseOptions,
  stripDeviceOptions,
  mergeOptions,
  writeTextAtomic,
  readTextIfSmall,
  trash,
  existsSync,
};
