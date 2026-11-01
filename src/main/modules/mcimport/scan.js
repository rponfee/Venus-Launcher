'use strict';
// Escaneo de la carpeta del launcher oficial (.minecraft), sin Electron: perfiles, version y loader de cada uno,
// carpetas de juego (la compartida y las propias de cada perfil) y su contenido con cantidades y tamanios.
// Solo lee: nunca escribe, mueve ni borra nada de esa carpeta.
//
// Reglas de seguridad de las rutas:
//  - gameDir de un perfil: se rechazan rutas de red (\\servidor\recurso), la raiz de un disco, la carpeta de
//    usuario entera, carpetas del sistema y cualquier cosa dentro de la carpeta de datos de Venus.
//  - Enlaces simbolicos y uniones (junctions) se saltean siempre y se cuentan; nada que resuelva fuera de la
//    carpeta de origen se lee.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const nbt = require('../../core/nbt');
const { BOM, PROFILE_FILES, MAX_FILE, parseProfilesText, mergeProfiles, validVersionId, cleanText } = require('./profiles');
const { detectVersion, resolveLatest, isModded, vanillaShape } = require('./versions');

const CATEGORIES = Object.freeze(['worlds', 'mods', 'resourcepacks', 'shaderpacks', 'config', 'options', 'servers']);
const MODDED_ONLY = new Set(['mods', 'config']);
const OPTION_FILES = Object.freeze(['options.txt', 'optionsof.txt', 'optionsshaders.txt']);
const FOLDER_OF = { mods: 'mods', resourcepacks: 'resourcepacks', shaderpacks: 'shaderpacks', config: 'config' };
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const MOD_FILE = /\.(jar|zip|litemod)(\.disabled)?$/i;
const PACK_FILE = /\.zip(\.disabled)?$/i;
const MAX_WORLDS = 400;
const MAX_ENTRIES = 400000; // tope de archivos que se recorren por escaneo (carpetas gigantes: el tamanio queda aproximado)
const MAX_VERSION_JSON = 4 * 1024 * 1024;
const MAX_LEVEL_DAT = 8 * 1024 * 1024;
const STAT_BATCH = 48;

const isWin = (platform) => platform === 'win32';

// ---------- Rutas ----------

function normKey(p, platform = process.platform) {
  const r = path.resolve(p);
  return isWin(platform) ? r.toLowerCase() : r;
}

function samePath(a, b, platform) {
  return normKey(a, platform) === normKey(b, platform);
}

// ¿child esta dentro de base (o es base)?
function insideOrSame(base, child, platform) {
  const b = normKey(base, platform);
  const c = normKey(child, platform);
  return c === b || c.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

function isNetworkPath(p) {
  return /^(?:\\\\|\/\/)/.test(String(p || ''));
}

// Carpeta del launcher oficial en cada sistema (la Microsoft Store usa la misma en Windows).
function defaultDirs({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (isWin(platform)) return [path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), '.minecraft')];
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'minecraft')];
  return [path.join(home, '.minecraft')];
}

// Carpetas que nunca se aceptan como carpeta de juego de un perfil (o como carpeta elegida).
function forbiddenDirs({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const out = [];
  if (isWin(platform)) {
    for (const k of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) if (env[k]) out.push(env[k]);
  } else {
    out.push('/bin', '/boot', '/dev', '/etc', '/lib', '/proc', '/sbin', '/sys', '/usr', '/System', '/Library');
  }
  return { exact: [home].filter(Boolean), inside: out };
}

/**
 * Valida una carpeta de origen. Devuelve null si se puede leer o el motivo: 'network', 'unsafe' (raiz de un
 * disco, carpeta del usuario o del sistema) o 'venus' (dentro de la carpeta de datos de Venus).
 */
function sourceProblem(dir, { venusRoot, platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (typeof dir !== 'string' || !dir) return 'unsafe';
  if (isNetworkPath(dir)) return 'network';
  const full = path.resolve(dir);
  if (path.parse(full).root === full || path.dirname(full) === full) return 'unsafe';
  if (venusRoot && (insideOrSame(venusRoot, full, platform) || insideOrSame(full, venusRoot, platform))) return 'venus';
  const bad = forbiddenDirs({ platform, env, home });
  if (bad.exact.some((d) => samePath(d, full, platform))) return 'unsafe';
  if (bad.inside.some((d) => insideOrSame(d, full, platform))) return 'unsafe';
  return null;
}

// gameDir de un perfil -> ruta absoluta (las relativas, que el launcher no deberia escribir, van contra la raiz).
function resolveGameDir(root, gameDir) {
  if (!gameDir) return path.resolve(root);
  if (isNetworkPath(gameDir)) return gameDir;
  return path.isAbsolute(gameDir) ? path.resolve(gameDir) : path.resolve(root, gameDir);
}

async function realDir(p) {
  try {
    const real = await fsp.realpath(p);
    const st = await fsp.stat(real);
    return st.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

// lstat que no lanza (null si no existe o no se puede leer).
async function lstatSafe(p) {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}

// ¿Un archivo esta bloqueado por otro programa? Minecraft 1.16+ bloquea session.lock mientras el mundo esta abierto.
async function isLocked(file) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    await fh.read(Buffer.alloc(1), 0, 1, 0);
    return false;
  } catch (err) {
    return LOCK_CODES.has(err?.code);
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// ---------- Recorrido (tamanios) ----------

// Cuenta archivos y bytes de una carpeta sin seguir enlaces. counter: { entries } compartido (tope por escaneo).
async function treeStats(dir, counter = { entries: 0 }, { skip } = {}) {
  const out = { files: 0, bytes: 0, links: 0, partial: false };
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = [];
    for (const e of entries) {
      if (counter.entries++ > MAX_ENTRIES) {
        out.partial = true;
        return out;
      }
      const full = path.join(cur, e.name);
      if (skip && skip(e.name, full)) continue;
      if (e.isSymbolicLink()) {
        // Windows marca como enlace cualquier punto de reanalisis: se confirma con lstat (OneDrive, dedup).
        const st = await lstatSafe(full);
        if (!st || st.isSymbolicLink()) {
          out.links++;
          continue;
        }
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile()) {
          out.files++;
          out.bytes += st.size;
        }
        continue;
      }
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) files.push(full);
    }
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const sts = await Promise.all(files.slice(i, i + STAT_BATCH).map((f) => fsp.stat(f).catch(() => null)));
      for (const st of sts) {
        if (!st) continue;
        out.files++;
        out.bytes += st.size;
      }
    }
  }
  return out;
}

// Entrada de primer nivel de la carpeta de juego: no puede ser un enlace ni salir de la carpeta.
async function topEntry(gameDir, rel) {
  const full = path.join(gameDir, rel);
  const st = await lstatSafe(full);
  if (!st) return null;
  if (st.isSymbolicLink()) return { link: true };
  return { full, st };
}

// ---------- Archivos del launcher ----------

async function readSmallText(file, max) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) return { missing: true };
  if (st.size > max) return { tooBig: true };
  try {
    return { text: await fsp.readFile(file, 'utf8') };
  } catch {
    return { unreadable: true };
  }
}

async function readProfiles(root, { now = Date.now() } = {}) {
  const lists = [];
  const files = [];
  const errors = [];
  let selected = null;
  for (const def of PROFILE_FILES) {
    const r = await readSmallText(path.join(root, def.file), MAX_FILE);
    if (r.missing) continue;
    files.push(def.file);
    if (!r.text) {
      errors.push({ file: def.file, error: 'malformed' });
      continue;
    }
    const parsed = parseProfilesText(r.text, { source: def.source, prefix: def.prefix, now });
    if (!parsed.ok) {
      errors.push({ file: def.file, error: parsed.error });
      continue;
    }
    lists.push(parsed.profiles);
    if (!selected && parsed.selected) selected = parsed.selected;
  }
  return { files, errors, profiles: mergeProfiles(lists), selected };
}

async function readVersionJson(root, id) {
  if (!validVersionId(id)) return null;
  const file = path.join(root, 'versions', id, `${id}.json`);
  const st = await lstatSafe(file);
  if (!st || !st.isFile() || st.size > MAX_VERSION_JSON) return null;
  try {
    const text = await fsp.readFile(file, 'utf8');
    const data = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// Versiones vanilla instaladas por el launcher oficial (para "ultima version": la que ya se jugo). Solo ids con
// forma de version de Mojang: una copia renombrada no cuenta.
async function localVanilla(root) {
  const out = [];
  const entries = await fsp.readdir(path.join(root, 'versions'), { withFileTypes: true }).catch(() => []);
  for (const e of entries.slice(0, 300)) {
    if (!e.isDirectory() || !vanillaShape(e.name)) continue;
    const json = await readVersionJson(root, e.name);
    if (json && !json.inheritsFrom && json.id === e.name && typeof json.type === 'string' && typeof json.releaseTime === 'string') {
      out.push({ id: e.name, type: json.type, releaseTime: json.releaseTime });
    }
  }
  return out;
}

// level.dat -> { name, lastPlayed } (con tope de tamanio y de descompresion: un archivo roto no traba nada).
async function readLevel(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_LEVEL_DAT) return null;
    const buf = await fsp.readFile(file);
    let raw = buf;
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) raw = zlib.gunzipSync(buf, { maxOutputLength: 32 * 1024 * 1024 });
    else if (buf.length > 2 && buf[0] === 0x78) raw = zlib.inflateSync(buf, { maxOutputLength: 32 * 1024 * 1024 });
    const data = nbt.parse(raw)?.value?.Data;
    if (!data || typeof data !== 'object') return null;
    const last = data.LastPlayed !== undefined ? Number(data.LastPlayed) : 0;
    return { name: cleanText(typeof data.LevelName === 'string' ? data.LevelName : '', 80), lastPlayed: Number.isFinite(last) && last > 0 ? last : 0 };
  } catch {
    return null;
  }
}

// ---------- Contenido de una carpeta de juego ----------

function emptyContent() {
  const c = {};
  for (const k of CATEGORIES) c[k] = { count: 0, bytes: 0 };
  c.worlds.items = [];
  c.options.files = [];
  return c;
}

async function scanWorlds(gameDir, counter, out, { checkLocks = true } = {}) {
  const saves = await topEntry(gameDir, 'saves');
  if (!saves) return;
  if (saves.link) {
    out.links++;
    return;
  }
  if (!saves.st.isDirectory()) return;
  const entries = await fsp.readdir(saves.full, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (out.content.worlds.items.length >= MAX_WORLDS) break;
    const wdir = path.join(saves.full, e.name);
    if (e.isSymbolicLink()) {
      const st = await lstatSafe(wdir);
      if (!st || st.isSymbolicLink()) {
        out.links++;
        continue;
      }
      if (!st.isDirectory()) continue;
    } else if (!e.isDirectory()) continue;
    const level = await lstatSafe(path.join(wdir, 'level.dat'));
    if (!level || !level.isFile()) continue;
    const info = await readLevel(path.join(wdir, 'level.dat'));
    const stats = await treeStats(wdir, counter, { skip: (name) => name === 'session.lock' });
    out.links += stats.links;
    if (stats.partial) out.partial = true;
    const locked = checkLocks ? await isLocked(path.join(wdir, 'session.lock')) : false;
    out.content.worlds.items.push({
      folder: e.name,
      name: info?.name || cleanText(e.name, 80),
      bytes: stats.bytes,
      files: stats.files,
      lastPlayed: info?.lastPlayed || level.mtimeMs || 0,
      locked,
    });
  }
  const items = out.content.worlds.items.sort((a, b) => b.lastPlayed - a.lastPlayed || a.folder.localeCompare(b.folder));
  out.content.worlds.count = items.length;
  out.content.worlds.bytes = items.reduce((a, w) => a + w.bytes, 0);
}

async function scanFolderCategory(gameDir, cat, counter, out) {
  const top = await topEntry(gameDir, FOLDER_OF[cat]);
  if (!top) return;
  if (top.link) {
    out.links++;
    return;
  }
  if (!top.st.isDirectory()) return;
  const stats = await treeStats(top.full, counter);
  out.links += stats.links;
  if (stats.partial) out.partial = true;
  let count = 0;
  const entries = await fsp.readdir(top.full, { withFileTypes: true }).catch(() => []);
  if (cat === 'mods') count = entries.filter((e) => e.isFile() && MOD_FILE.test(e.name)).length;
  else if (cat === 'config') count = stats.files;
  else count = entries.filter((e) => e.isDirectory() || (e.isFile() && PACK_FILE.test(e.name))).length;
  if (!stats.files) return; // carpeta vacia: no hay nada que traer
  out.content[cat] = { count, bytes: stats.bytes, files: stats.files };
}

async function scanFiles(gameDir, out) {
  for (const name of OPTION_FILES) {
    const top = await topEntry(gameDir, name);
    if (!top) continue;
    if (top.link) {
      out.links++;
      continue;
    }
    if (!top.st.isFile()) continue;
    out.content.options.files.push(name);
    out.content.options.count++;
    out.content.options.bytes += top.st.size;
  }
  const servers = await topEntry(gameDir, 'servers.dat');
  if (servers?.link) out.links++;
  else if (servers?.st.isFile()) out.content.servers = { count: 1, bytes: servers.st.size };
}

/** Contenido de una carpeta de juego: { content, links, partial }. */
async function scanContent(gameDir, { counter = { entries: 0 }, checkLocks = true } = {}) {
  const out = { content: emptyContent(), links: 0, partial: false };
  await scanWorlds(gameDir, counter, out, { checkLocks });
  for (const cat of ['mods', 'resourcepacks', 'shaderpacks', 'config']) await scanFolderCategory(gameDir, cat, counter, out);
  await scanFiles(gameDir, out);
  return out;
}

function hasContent(content) {
  return CATEGORIES.some((k) => content[k].count > 0);
}

// ---------- Escaneo completo ----------

function groupId(key) {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

// El perfil importado antes desde esta misma carpeta (marca mcimport de la instancia), si sigue en Venus.
function importedFor(existing, root, profile, platform) {
  for (const inst of Array.isArray(existing) ? existing : []) {
    const m = inst?.mcimport;
    if (!m || m.profile !== profile.key || typeof m.dir !== 'string') continue;
    if (samePath(m.dir, root, platform)) return { instanceId: inst.id, name: inst.name };
  }
  return null;
}

/**
 * Escanea una carpeta del launcher oficial.
 * opts: { venusRoot, manifest ({ latest, versions } o null), existing (instancias de Venus con su marca mcimport),
 *         platform, env, home, now, checkLocks, names: { latestRelease(v), latestSnapshot(v), unnamed(loader, v) } }
 * Devuelve { dir, found, reason?, files, errors, profiles, groups, latest, links, partial }.
 */
async function scanFolder(dir, opts = {}) {
  const { venusRoot = null, manifest = null, existing = [], platform = process.platform, env = process.env, home = os.homedir(), now = Date.now(), checkLocks = true, names = {} } = opts;
  const problem = sourceProblem(dir, { venusRoot, platform, env, home });
  if (problem) return { dir, found: false, reason: problem, profiles: [], groups: [] };
  const root = await realDir(dir);
  if (!root) return { dir, found: false, reason: 'notFound', profiles: [], groups: [] };
  // La carpeta real (si .minecraft es una union a otro disco) tambien tiene que ser aceptable.
  const realProblem = sourceProblem(root, { venusRoot, platform, env, home });
  if (realProblem) return { dir, found: false, reason: realProblem, profiles: [], groups: [] };

  const { files, errors, profiles: raw, selected } = await readProfiles(root, { now });
  const manifestIds = Array.isArray(manifest?.versions) ? new Set(manifest.versions.map((v) => v?.id).filter((id) => typeof id === 'string')) : null;
  let local = null;
  const latest = {};
  // Manifest y versiones vanilla instaladas por el launcher oficial: la mas nueva de las dos (un manifest
  // guardado hace tiempo no puede hacer que se importe una version anterior a la que ya se jugo).
  const latestOf = async (type) => {
    const k = type === 'latest-snapshot' ? 'snapshot' : 'release';
    if (latest[k] !== undefined) return latest[k];
    if (!local) local = await localVanilla(root);
    latest[k] = resolveLatest(type, { manifest, local }) || null;
    return latest[k];
  };

  const groups = new Map();
  const counter = { entries: 0 };
  const groupFor = async (gameDirRaw) => {
    const abs = resolveGameDir(root, gameDirRaw);
    const problemDir = sourceProblem(abs, { venusRoot, platform, env, home });
    const real = problemDir ? null : await realDir(abs);
    const key = real ? normKey(real, platform) : `x:${normKey(abs, platform)}`;
    if (!groups.has(key)) {
      const isRoot = Boolean(real) && samePath(real, root, platform);
      const realProblemDir = real && !isRoot ? sourceProblem(real, { venusRoot, platform, env, home }) : null;
      groups.set(key, {
        id: groupId(key),
        dir: real || abs,
        isRoot,
        exists: Boolean(real),
        problem: problemDir || realProblemDir || null,
        label: isRoot ? path.basename(root) : real && insideOrSame(root, real, platform) ? path.relative(root, real).replace(/\\/g, '/') : real || abs,
        profileIds: [],
      });
    }
    return groups.get(key);
  };

  const buildProfile = async (p) => {
    let versionId = p.lastVersionId;
    let latestType = null;
    if (p.type === 'latest-release' || p.type === 'latest-snapshot' || p.implicitLatest) {
      latestType = p.type === 'latest-snapshot' || p.implicitLatest === 'latest-snapshot' ? 'latest-snapshot' : 'latest-release';
      versionId = await latestOf(latestType);
    }
    let version;
    if (!versionId) version = { ok: false, reason: latestType ? 'latestUnknown' : 'noVersion' };
    else version = detectVersion(versionId, await readVersionJson(root, versionId), { manifestIds });
    const group = await groupFor(p.gameDir);
    group.profileIds.push(p.id);
    let suggestedName = p.name;
    if (!suggestedName && version.ok) {
      if (p.type === 'latest-release') suggestedName = names.latestRelease ? names.latestRelease(version.mcVersion) : `Minecraft ${version.mcVersion}`;
      else if (p.type === 'latest-snapshot') suggestedName = names.latestSnapshot ? names.latestSnapshot(version.mcVersion) : `Snapshot ${version.mcVersion}`;
      else suggestedName = names.unnamed ? names.unnamed(version.loader, version.mcVersion) : `${version.loader} ${version.mcVersion}`;
    }
    return {
      id: p.id,
      key: p.key,
      source: p.source,
      sources: p.sources,
      type: p.type,
      name: p.name,
      suggestedName: cleanText(suggestedName || versionId || 'Minecraft', 60),
      versionId: versionId || null,
      latestType,
      synthetic: Boolean(p.synthetic),
      icon: p.icon,
      lastUsed: p.lastUsed,
      created: p.created,
      selected: p.id === selected,
      groupId: group.id,
      version,
      modded: version.ok && isModded(version.loader),
      imported: importedFor(existing, root, p, platform),
    };
  };

  const profiles = [];
  for (const p of raw) profiles.push(await buildProfile(p));
  // La carpeta principal siempre se mira (aunque ningun perfil la use, puede tener mundos).
  const rootGroup = await groupFor(null);

  let links = 0;
  let partial = false;
  const contents = new Map();
  for (const g of groups.values()) {
    let content = emptyContent();
    if (g.exists && !g.problem) {
      const r = await scanContent(g.dir, { counter, checkLocks });
      content = r.content;
      links += r.links;
      partial = partial || r.partial;
    }
    contents.set(g.id, content);
  }
  // Sin archivo de perfiles (o roto) pero con mundos u opciones: un perfil "ultima version" para traerlos igual.
  if (!profiles.length && hasContent(contents.get(rootGroup.id))) {
    profiles.push(await buildProfile({ id: 'v:latest', key: 'venus-latest', source: 'venus', sources: ['venus'], type: 'latest-release', name: '', lastVersionId: null, implicitLatest: null, gameDir: null, icon: null, lastUsed: 0, created: 0, synthetic: true }));
  }

  const outGroups = [];
  for (const g of groups.values()) {
    const content = contents.get(g.id);
    const any = hasContent(content);
    if (!g.profileIds.length && !any) continue;
    outGroups.push({ ...g, shared: g.profileIds.length > 1, content, hasContent: any });
  }
  outGroups.sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || a.label.localeCompare(b.label));
  const anyContent = outGroups.some((g) => g.hasContent);
  let reason;
  if (!files.length && !anyContent) reason = 'notMinecraft';
  else if (!profiles.length && !anyContent) reason = 'empty';
  return {
    dir: root,
    found: !reason,
    reason,
    files,
    errors,
    latest,
    profiles,
    groups: outGroups,
    links,
    partial,
    scannedAt: now,
  };
}

/**
 * Deteccion rapida (pantalla de bienvenida): sin tamanios, sin red y sin mirar los bloqueos.
 * Devuelve { found, dir, profiles, worlds } (found: hay perfiles usados, perfiles propios o mundos).
 */
async function quickDetect(dir, { venusRoot = null, platform = process.platform, env = process.env, home = os.homedir(), now = Date.now() } = {}) {
  if (sourceProblem(dir, { venusRoot, platform, env, home })) return { found: false };
  const root = await realDir(dir);
  if (!root || sourceProblem(root, { venusRoot, platform, env, home })) return { found: false };
  const { profiles } = await readProfiles(root, { now });
  let worlds = 0;
  const saves = await topEntry(root, 'saves');
  if (saves && !saves.link && saves.st.isDirectory()) {
    const entries = await fsp.readdir(saves.full, { withFileTypes: true }).catch(() => []);
    for (const e of entries.slice(0, MAX_WORLDS)) {
      if (!e.isDirectory()) continue;
      const level = await lstatSafe(path.join(saves.full, e.name, 'level.dat'));
      if (level?.isFile()) worlds++;
    }
  }
  const used = profiles.filter((p) => p.type === 'custom' || p.lastUsed > 0).length;
  return { found: used > 0 || worlds > 0, dir: root, profiles: used, worlds };
}

module.exports = {
  CATEGORIES,
  MODDED_ONLY,
  OPTION_FILES,
  FOLDER_OF,
  defaultDirs,
  sourceProblem,
  resolveGameDir,
  insideOrSame,
  samePath,
  isNetworkPath,
  isLocked,
  treeStats,
  readProfiles,
  readVersionJson,
  readLevel,
  scanContent,
  scanFolder,
  quickDetect,
  hasContent,
};
