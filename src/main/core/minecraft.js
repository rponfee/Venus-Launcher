'use strict';
// Versiones de Minecraft: manifest, JSON de versiones (con herencia inheritsFrom),
// librerias, nativos, assets, configuracion de logging y verificacion rapida para el arranque.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const paths = require('./paths');
const http = require('./http');
const { t } = require('./i18n');
const { rulesAllow } = require('./rules');
const { OS_NAME, exists, readJson, writeJson, mavenPath, parseMaven } = require('./util');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MANIFEST_MAX_AGE = 10 * 60 * 1000;
const RESOURCES_URL = 'https://resources.download.minecraft.net';
const MAVEN_MIRRORS = [
  'https://libraries.minecraft.net/',
  'https://maven.minecraftforge.net/',
  'https://maven.neoforged.net/releases/',
  'https://maven.fabricmc.net/',
  'https://repo1.maven.org/maven2/',
];
// Loaders tipo Fabric con muy pocas versiones de juego: su lista completa puede viajar junto al manifest.
const INLINE_LOADER_GAMES = 3;

// Un id de version es un solo segmento de ruta (ej. "1.20.1", "3D Shareware v1.34", "fabric-loader-0.16.0-1.21").
function validVersionId(id) {
  return typeof id === 'string' && /^[\w .+-]{1,100}$/.test(id) && id.trim() === id && id !== '.' && id !== '..';
}

function assertVersionId(id) {
  if (!validVersionId(id)) throw new Error(t('minecraft.errVersionId', { id: String(id) }));
}

/**
 * Manifest de Mojang (todas las versiones: release, snapshot, old_beta, old_alpha).
 * opts: true/false (forzar descarga) o { force, loaders: ['babric'] } para sumar en `venus.loaders`
 * las versiones de loaders tipo Fabric que todavia no tienen canal propio en la interfaz.
 */
async function getManifest(opts = false) {
  const o = opts && typeof opts === 'object' ? opts : { force: Boolean(opts) };
  const manifest = await http.getJson(MANIFEST_URL, {
    cacheFile: paths.cache('version_manifest_v2.json'),
    cacheMaxAge: o.force ? 0 : MANIFEST_MAX_AGE,
  });
  if (!Array.isArray(o.loaders) || !o.loaders.length) return manifest;
  return { ...manifest, venus: { loaders: await extraLoaderInfo(o.loaders) } };
}

async function extraLoaderInfo(kinds) {
  const fabric = require('./loaders/fabric'); // perezoso: fabric.js tambien requiere este modulo
  const out = {};
  for (const kind of [...new Set(kinds)].slice(0, 6)) {
    if (!fabric.KINDS.includes(kind)) continue;
    try {
      const games = await fabric.getGameVersions(kind);
      const entry = { games: games.map((g) => ({ id: g.version, stable: g.stable !== false })), versions: {} };
      if (games.length <= INLINE_LOADER_GAMES) {
        for (const g of games) entry.versions[g.version] = await fabric.getLoaderVersions(kind, g.version);
      }
      out[kind] = entry;
    } catch (err) {
      out[kind] = { error: err.message, games: [], versions: {} };
    }
  }
  return out;
}

// Lee el JSON de una version. Para versiones vanilla verifica el sha1 contra el manifest.
async function getVersionJson(id) {
  assertVersionId(id);
  const file = paths.versionJson(id);
  let raw = null;
  try {
    raw = await fsp.readFile(file);
  } catch {
    raw = null;
  }
  let entry = null;
  try {
    const manifest = await getManifest();
    entry = manifest.versions.find((v) => v.id === id) || null;
  } catch {
    entry = null;
  }
  if (raw && (!entry || crypto.createHash('sha1').update(raw).digest('hex') === entry.sha1)) {
    return JSON.parse(raw.toString('utf8'));
  }
  if (!entry) {
    if (raw) return JSON.parse(raw.toString('utf8'));
    throw new Error(t('minecraft.errVersionMissing', { id }));
  }
  const text = await http.getText(entry.url);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
  return JSON.parse(text);
}

function libKey(lib) {
  const { group, artifact, classifier } = parseMaven(lib.name || '');
  const nativeOnly = lib.natives && !lib.downloads?.artifact;
  return `${group}:${artifact}:${classifier}${nativeOnly ? '@natives' : ''}`;
}

// Un hijo (ej. Babric) que trae la lista nueva de argumentos completa, con el nombre del jugador incluido,
// reemplaza a los minecraftArguments viejos del padre: igual que el launcher oficial, que usa "arguments" si existe.
function childReplacesLegacyArgs(chain) {
  const children = chain.slice(0, -1);
  if (children.some((v) => v.minecraftArguments)) return false;
  return children.some(
    (v) => Array.isArray(v.arguments?.game) && v.arguments.game.some((a) => typeof a === 'string' && a.includes('${auth_player_name}')),
  );
}

// Fusiona la cadena de herencia (hijo -> ... -> raiz) en un objeto resuelto.
function mergeChain(chain) {
  const root = chain[chain.length - 1];
  const top = chain[0];
  const r = {
    id: top.id,
    rootId: root.id,
    chain: chain.map((v) => v.id),
    type: top.type || root.type,
    releaseTime: root.releaseTime,
    mainClass: null,
    minecraftArguments: null,
    arguments: { game: [], jvm: [] },
    defaultUserJvm: null,
    libraries: [],
    assetIndex: null,
    assets: null,
    javaVersion: null,
    logging: null,
    downloads: root.downloads || {},
    jarId: root.id,
  };
  for (let i = chain.length - 1; i >= 0; i--) {
    const v = chain[i];
    if (v.mainClass) r.mainClass = v.mainClass;
    if (v.minecraftArguments) r.minecraftArguments = v.minecraftArguments;
    if (v.arguments) {
      if (Array.isArray(v.arguments.game)) r.arguments.game.push(...v.arguments.game);
      if (Array.isArray(v.arguments.jvm)) r.arguments.jvm.push(...v.arguments.jvm);
      if (Array.isArray(v.arguments['default-user-jvm'])) r.defaultUserJvm = v.arguments['default-user-jvm'];
    }
    if (v.assetIndex) r.assetIndex = v.assetIndex;
    if (v.assets) r.assets = v.assets;
    if (v.javaVersion) r.javaVersion = v.javaVersion;
    if (v.logging && Object.keys(v.logging).length) r.logging = v.logging;
    if (v.downloads?.client) r.downloads = v.downloads;
  }
  if (chain.length > 1 && r.minecraftArguments && childReplacesLegacyArgs(chain)) r.minecraftArguments = null;
  // Librerias: primero las del hijo (loader), sin duplicados por group:artifact:classifier.
  const seen = new Set();
  for (const v of chain) {
    for (const lib of v.libraries || []) {
      if (!lib || !lib.name) continue;
      if (!rulesAllow(lib.rules)) continue;
      if (lib.clientreq === false) continue;
      const key = libKey(lib);
      if (seen.has(key)) continue;
      seen.add(key);
      r.libraries.push(lib);
    }
  }
  if (!r.assets && r.assetIndex) r.assets = r.assetIndex.id;
  if (!r.javaVersion) r.javaVersion = { component: 'jre-legacy', majorVersion: 8 };
  return r;
}

async function resolveVersion(id) {
  const chain = [];
  let cur = await getVersionJson(id);
  chain.push(cur);
  while (cur.inheritsFrom) {
    if (chain.length > 8) throw new Error(t('minecraft.errInheritance'));
    cur = await getVersionJson(cur.inheritsFrom);
    chain.push(cur);
  }
  return mergeChain(chain);
}

// Igual que resolveVersion pero solo con lo que ya esta en disco (sin red ni manifest).
// Devuelve { resolved, hash } (hash = sha1 de los JSON de toda la cadena) o null si falta alguno.
async function resolveVersionLocal(id) {
  const chain = [];
  const hash = crypto.createHash('sha1');
  let cur = id;
  while (cur) {
    if (chain.length > 8) throw new Error(t('minecraft.errInheritance'));
    if (!validVersionId(cur)) return null;
    let raw;
    try {
      raw = await fsp.readFile(paths.versionJson(cur), 'utf8');
    } catch {
      return null;
    }
    const json = JSON.parse(raw);
    hash.update(`${cur}\n${raw}\n`);
    chain.push(json);
    cur = json.inheritsFrom || null;
  }
  return { resolved: mergeChain(chain), hash: hash.digest('hex') };
}

function withSlash(u) {
  return u.endsWith('/') ? u : `${u}/`;
}

// Convierte una entrada de libreria en archivos concretos (artefacto y/o nativos).
function libraryFiles(lib) {
  const out = [];
  const artifact = lib.downloads?.artifact;
  if (artifact) {
    const rel = artifact.path || mavenPath(lib.name);
    out.push({
      name: lib.name,
      rel,
      path: paths.library(rel),
      urls: artifact.url ? [artifact.url] : [],
      sha1: artifact.sha1,
      size: artifact.size,
      classpath: true,
    });
  } else if (!lib.natives) {
    const rel = mavenPath(lib.name);
    const base = lib.url ? withSlash(lib.url) : null;
    const urls = [...new Set([base, ...MAVEN_MIRRORS].filter(Boolean).map((b) => b.replace(/^http:\/\/files\.minecraftforge\.net\/maven\//, 'https://maven.minecraftforge.net/') + rel))];
    out.push({ name: lib.name, rel, path: paths.library(rel), urls, sha1: lib.sha1, size: lib.size, classpath: true });
  }
  if (lib.natives && lib.natives[OS_NAME]) {
    const classifier = lib.natives[OS_NAME].replace('${arch}', process.arch === 'ia32' ? '32' : '64');
    const info = lib.downloads?.classifiers?.[classifier];
    let rel;
    let urls;
    if (info) {
      rel = info.path || mavenPath(`${lib.name}:${classifier}`);
      urls = [info.url];
    } else {
      rel = mavenPath(`${lib.name}:${classifier}`);
      urls = [withSlash(lib.url || MAVEN_MIRRORS[0]) + rel];
    }
    out.push({
      name: `${lib.name}:${classifier}`,
      rel,
      path: paths.library(rel),
      urls,
      sha1: info?.sha1,
      size: info?.size,
      classpath: false,
      natives: true,
      exclude: lib.extract?.exclude || ['META-INF/'],
    });
  }
  return out;
}

function allLibraryFiles(resolved) {
  const files = [];
  const seen = new Set();
  for (const lib of resolved.libraries) {
    for (const f of libraryFiles(lib)) {
      const k = f.path.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      files.push(f);
    }
  }
  return files;
}

function clientJarPath(resolved) {
  return paths.versionJar(resolved.rootId);
}

function assetIndexPath(resolved) {
  return resolved.assetIndex ? path.join(paths.assets(), 'indexes', `${resolved.assetIndex.id}.json`) : null;
}

async function installAssets(resolved, task, { verify = 'size', from = 0.3, to = 1 } = {}) {
  const ai = resolved.assetIndex;
  if (!ai) return;
  const assetsDir = paths.assets();
  const indexPath = assetIndexPath(resolved);
  await http.download({ url: ai.url, path: indexPath, sha1: ai.sha1, size: ai.size }, { verify: 'hash', signal: task?.signal });
  const index = await readJson(indexPath);
  const byHash = new Map();
  for (const obj of Object.values(index.objects || {})) {
    if (!byHash.has(obj.hash)) {
      byHash.set(obj.hash, {
        url: `${RESOURCES_URL}/${obj.hash.slice(0, 2)}/${obj.hash}`,
        path: path.join(assetsDir, 'objects', obj.hash.slice(0, 2), obj.hash),
        sha1: obj.hash,
        size: obj.size,
      });
    }
  }
  await http.downloadAll([...byHash.values()], {
    concurrency: 32,
    verify,
    signal: task?.signal,
    onProgress: task?.downloadProgress(t('minecraft.assets'), from, to),
  });
  if (index.virtual) {
    const vdir = path.join(assetsDir, 'virtual', ai.id);
    for (const [name, obj] of Object.entries(index.objects)) {
      const dest = path.resolve(vdir, name);
      if (!dest.startsWith(path.resolve(vdir) + path.sep)) continue;
      if (await exists(dest)) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.join(assetsDir, 'objects', obj.hash.slice(0, 2), obj.hash), dest);
    }
  }
}

// Versiones muy antiguas (pre-1.6) leen los recursos desde <gameDir>/resources.
async function mapResourcesToGameDir(resolved, gameDir) {
  const ai = resolved.assetIndex;
  if (!ai) return;
  const index = await readJson(path.join(paths.assets(), 'indexes', `${ai.id}.json`), null);
  if (!index || !index.map_to_resources) return;
  const base = path.resolve(gameDir, 'resources');
  for (const [name, obj] of Object.entries(index.objects)) {
    const dest = path.resolve(base, name);
    if (!dest.startsWith(base + path.sep)) continue;
    if (await exists(dest)) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(paths.assets(), 'objects', obj.hash.slice(0, 2), obj.hash), dest).catch(() => {});
  }
}

function assetsGameDir(resolved, gameDir) {
  const id = resolved.assetIndex?.id || resolved.assets;
  if (id === 'pre-1.6') return path.join(gameDir, 'resources');
  if (id === 'legacy') return path.join(paths.assets(), 'virtual', 'legacy');
  return paths.assets();
}

function loggingFile(resolved) {
  const file = resolved.logging?.client?.file;
  if (!file) return null;
  return { ...file, path: path.join(paths.assets(), 'log_configs', file.id) };
}

// Instala todo lo necesario para lanzar una version ya presente (JSON) o vanilla.
async function installVersion(id, task, { verify = 'size' } = {}) {
  task?.update({ detail: t('minecraft.readingVersion', { id }), progress: null });
  const resolved = await resolveVersion(id);
  const items = [];
  const client = resolved.downloads?.client;
  const jar = clientJarPath(resolved);
  if (client) items.push({ url: client.url, path: jar, sha1: client.sha1, size: client.size });
  else if (!(await exists(jar))) throw new Error(t('minecraft.errClientJar', { id: resolved.rootId }));

  for (const f of allLibraryFiles(resolved)) {
    if (!f.urls.length) {
      if (!(await exists(f.path))) throw new Error(t('minecraft.errLibraryMissing', { name: f.name }));
      continue;
    }
    items.push({ urls: f.urls, path: f.path, sha1: f.sha1, size: f.size });
  }
  const log = loggingFile(resolved);
  if (log) items.push({ url: log.url, path: log.path, sha1: log.sha1, size: log.size });

  await http.downloadAll(items, {
    concurrency: 16,
    verify,
    signal: task?.signal,
    onProgress: task?.downloadProgress(t('minecraft.libraries'), 0, 0.3),
  });
  await installAssets(resolved, task, { verify, from: 0.3, to: 1 });

  // Los loaders necesitan el .jar del cliente con el nombre de su propia version (ej. ignoreList de Forge).
  if (resolved.id !== resolved.rootId) {
    const target = paths.versionJar(resolved.id);
    const srcSize = (await fsp.stat(jar)).size;
    const cur = await fsp.stat(target).catch(() => null);
    if (!cur || cur.size !== srcSize) {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(jar, target);
    }
  }
  return resolved;
}

// Chequeo barato para el arranque rapido: solo existencia (y tamanio cuando se conoce) de los archivos
// que necesita la version, sin hashes ni red. Devuelve { ok, missing: [rutas] }.
async function quickVerify(resolved) {
  const missing = [];
  const check = async (file, size) => {
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile() || (size && st.size !== size) || (!size && st.size === 0)) missing.push(file);
  };
  const clientSize = resolved.downloads?.client?.size;
  const jobs = [check(clientJarPath(resolved), clientSize)];
  if (resolved.id !== resolved.rootId) jobs.push(check(paths.versionJar(resolved.id), clientSize));
  for (const f of allLibraryFiles(resolved)) jobs.push(check(f.path, f.size));
  const index = assetIndexPath(resolved);
  if (index) jobs.push(check(index, resolved.assetIndex.size));
  const log = loggingFile(resolved);
  if (log) jobs.push(check(log.path, log.size));
  await Promise.all(jobs);
  return { ok: missing.length === 0, missing };
}

// Extrae nativos de formato antiguo (LWJGL 2 / 3 pre-1.19) a la carpeta de nativos.
async function extractNatives(resolved, dir) {
  await fsp.mkdir(dir, { recursive: true });
  const base = path.resolve(dir);
  const marker = path.join(dir, '.extracted');
  const files = allLibraryFiles(resolved).filter((f) => f.natives);
  const sig = files.map((f) => f.rel).join('|');
  if ((await fsp.readFile(marker, 'utf8').catch(() => '')) === sig) return;
  for (const f of files) {
    if (!(await exists(f.path))) continue;
    const zip = new AdmZip(f.path);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      if (f.exclude.some((ex) => entry.entryName.startsWith(ex))) continue;
      const dest = path.resolve(base, entry.entryName);
      if (!dest.startsWith(base + path.sep)) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, entry.getData()).catch(() => {});
    }
  }
  await fsp.writeFile(marker, sig);
}

async function listInstalledVersions() {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(paths.versions(), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !validVersionId(e.name)) continue;
    const json = await readJson(paths.versionJson(e.name), null);
    if (json) out.push({ id: json.id || e.name, type: json.type, inheritsFrom: json.inheritsFrom || null, releaseTime: json.releaseTime });
  }
  return out;
}

async function saveVersionJson(json) {
  assertVersionId(json?.id);
  if (json.inheritsFrom) assertVersionId(json.inheritsFrom);
  await writeJson(paths.versionJson(json.id), json);
}

module.exports = {
  getManifest,
  getVersionJson,
  resolveVersion,
  resolveVersionLocal,
  installVersion,
  installAssets,
  quickVerify,
  allLibraryFiles,
  clientJarPath,
  extractNatives,
  mapResourcesToGameDir,
  assetsGameDir,
  loggingFile,
  listInstalledVersions,
  saveVersionJson,
  mergeChain,
  validVersionId,
  MAVEN_MIRRORS,
};
