'use strict';
// Forge y NeoForge: descarga el instalador oficial y replica lo que hace
// (extraer librerias, ejecutar "processors" y guardar el JSON de version).
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const paths = require('../paths');
const http = require('../http');
const minecraft = require('../minecraft');
const java = require('../java');
const { t } = require('../i18n');
const { exists, mavenPath, hashFile, rmrf } = require('../util');

const FORGE_MAVEN = 'https://maven.minecraftforge.net/';
const NEO_MAVEN = 'https://maven.neoforged.net/releases/';
const CACHE_AGE = 60 * 60 * 1000;

function loaderName(kind) {
  return kind === 'forge' ? 'Forge' : 'NeoForge';
}

// ---------- Listas de versiones ----------

async function forgeVersionMap() {
  return http.getJson('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json', {
    cacheFile: paths.cache('forge-maven-metadata.json'),
    cacheMaxAge: CACHE_AGE,
  });
}

async function forgePromotions() {
  const data = await http.getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', {
    cacheFile: paths.cache('forge-promotions.json'),
    cacheMaxAge: CACHE_AGE,
  });
  return data.promos || {};
}

// Mapea una version de NeoForge a su version de Minecraft.
function neoforgeMc(v) {
  if (v.startsWith('0.')) return v.split('.')[1];
  const [main, suffix] = v.split('+');
  const core = main.split('-')[0];
  const p = core.split('.');
  const major = parseInt(p[0], 10);
  let mc;
  if (major >= 25) mc = p[2] && p[2] !== '0' ? `${p[0]}.${p[1]}.${p[2]}` : `${p[0]}.${p[1]}`;
  else mc = p[1] === '0' ? `1.${p[0]}` : `1.${p[0]}.${p[1]}`;
  if (suffix && /^(snapshot|pre|rc)-\d+$/.test(suffix)) mc = `${mc}-${suffix}`;
  return mc;
}

async function neoforgeVersionMap() {
  const [neo, legacy] = await Promise.all([
    http.getJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', {
      cacheFile: paths.cache('neoforge-versions.json'),
      cacheMaxAge: CACHE_AGE,
    }),
    http
      .getJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge', {
        cacheFile: paths.cache('neoforge-legacy-versions.json'),
        cacheMaxAge: 24 * CACHE_AGE,
      })
      .catch(() => ({ versions: [] })),
  ]);
  const map = {};
  for (const v of legacy.versions || []) {
    const mc = v.split('-')[0];
    (map[mc] = map[mc] || []).push(v);
  }
  for (const v of neo.versions || []) {
    const mc = neoforgeMc(v);
    (map[mc] = map[mc] || []).push(v);
  }
  return map;
}

// Orden descendente "natural" (47.4.26 > 47.4.3, alpha.15 > alpha.9) ignorando el prefijo de Minecraft.
function sortVersionsDesc(list, mcVersion) {
  const key = (v) => (v.startsWith(`${mcVersion}-`) ? v.slice(mcVersion.length + 1) : v);
  return [...list].sort((a, b) => key(b).localeCompare(key(a), 'en', { numeric: true }));
}

// Devuelve [{ version (completa para el instalador), label, stable, recommended, latest }]
async function getLoaderVersions(kind, mcVersion) {
  if (kind === 'forge') {
    const [map, promos] = await Promise.all([forgeVersionMap(), forgePromotions().catch(() => ({}))]);
    const list = map[mcVersion] || [];
    const rec = promos[`${mcVersion}-recommended`];
    const latest = promos[`${mcVersion}-latest`];
    return sortVersionsDesc(list, mcVersion).map((full) => {
      const short = full.slice(mcVersion.length + 1).replace(new RegExp(`-${mcVersion.replace(/\./g, '\\.')}$`), '');
      return { version: full, label: short, stable: true, recommended: short === rec, latest: short === latest };
    });
  }
  const map = await neoforgeVersionMap();
  const list = sortVersionsDesc(map[mcVersion] || [], mcVersion).map((v, i) => ({
    version: v,
    label: v.startsWith(`${mcVersion}-`) ? v.slice(mcVersion.length + 1) : v,
    stable: !/beta|alpha/i.test(v),
    recommended: false,
    latest: i === 0,
  }));
  const rec = list.find((l) => l.stable);
  if (rec) rec.recommended = true;
  return list;
}

async function getGameVersions(kind) {
  const map = kind === 'forge' ? await forgeVersionMap() : await neoforgeVersionMap();
  return Object.keys(map);
}

function installerUrl(kind, full) {
  if (kind === 'forge') return `${FORGE_MAVEN}net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
  if (/^1\.20\.1-/.test(full)) return `${NEO_MAVEN}net/neoforged/forge/${full}/forge-${full}-installer.jar`;
  return `${NEO_MAVEN}net/neoforged/neoforge/${full}/neoforge-${full}-installer.jar`;
}

// ---------- Instalacion ----------

function readManifestMainClass(jarPath) {
  const zip = new AdmZip(jarPath);
  const mf = zip.readAsText('META-INF/MANIFEST.MF');
  const m = mf.match(/^Main-Class:\s*(.+)$/m);
  if (!m) throw new Error(t('loaders.errMainClass', { name: path.basename(jarPath) }));
  return m[1].trim();
}

function runJava(javaExe, args, cwd, task, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaExe, args, { cwd, windowsHide: true });
    const tail = [];
    const onData = (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        task?.update({ detail: `${label}: ${line.slice(0, 120)}` });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const onAbort = () => child.kill();
    task?.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('exit', (code) => {
      task?.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(t('loaders.errProcess', { name: label, code, log: tail.slice(-12).join('\n') })));
    });
  });
}

function artifactPath(spec) {
  return paths.library(mavenPath(spec));
}

async function processorOutputsValid(outputs, resolveToken) {
  const entries = Object.entries(outputs || {});
  if (!entries.length) return false;
  for (const [k, v] of entries) {
    const file = resolveToken(k);
    const expected = resolveToken(v).replace(/^'|'$/g, '');
    if (!(await exists(file))) return false;
    if ((await hashFile(file, 'sha1')) !== expected.toLowerCase()) return false;
  }
  return true;
}

// Acepta "latest", la version completa o la corta (ej. "47.2.0" de un modpack) y devuelve la completa.
// Puede llegar de un modpack sin validar: como va en rutas del cache y en la URL, se rechaza si no es un id
// de version comun (sin separadores ni "?" o "#").
async function normalizeVersion(kind, mcVersion, full) {
  const list = await getLoaderVersions(kind, mcVersion);
  if (!list.length) throw new Error(t('loaders.errNoVersions', { loader: loaderName(kind), mc: mcVersion }));
  if (!full || full === 'latest') return (list.find((l) => l.recommended) || list.find((l) => l.stable) || list[0]).version;
  if (list.some((l) => l.version === full)) return full;
  const match = list.find((l) => l.label === full || l.version === `${mcVersion}-${full}` || l.version.startsWith(`${mcVersion}-${full}-`));
  const out = match ? match.version : full;
  if (!minecraft.validVersionId(out)) throw new Error(t('loaders.errBadVersion', { loader: loaderName(kind), version: String(out).slice(0, 80) }));
  return out;
}

// sha1 que publica el maven junto al instalador (null si no lo publica).
async function publishedSha1(url, signal) {
  try {
    const m = /^\s*([0-9a-f]{40})\b/i.exec(await http.getText(`${url}.sha1`, { signal }));
    return m ? m[1].toLowerCase() : null;
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

// Descarga el instalador al cache (compartido por cliente y servidor), verificado con el sha1 del maven.
async function downloadInstaller(kind, full, task) {
  const installer = paths.cache('installers', `${kind}-${full}-installer.jar`);
  const url = installerUrl(kind, full);
  task?.update({ detail: t('loaders.downloadingInstaller', { loader: loaderName(kind), version: full }), progress: null });
  try {
    let sha1 = null;
    try {
      sha1 = await publishedSha1(url, task?.signal);
    } catch (err) {
      // Sin conexion: sirve el instalador que ya estaba en el cache (como antes)
      if (task?.signal?.aborted || !(await exists(installer))) throw err;
    }
    await http.download({ url, path: installer, sha1: sha1 || undefined }, { verify: sha1 ? 'hash' : 'size', signal: task?.signal });
  } catch (err) {
    if (err.status === 404) throw new Error(t('loaders.errNoInstaller', { loader: loaderName(kind), version: full }));
    throw err;
  }
  return installer;
}

async function install(kind, mcVersion, full, task) {
  full = await normalizeVersion(kind, mcVersion, full);
  const label = loaderName(kind);

  // 1) Minecraft vanilla completo (los processors necesitan el .jar del cliente)
  task?.update({ detail: t('loaders.installingMinecraft', { mc: mcVersion }), progress: 0 });
  const vanilla = await minecraft.installVersion(mcVersion, task);
  const javaPath = await java.ensureRuntime(vanilla.javaVersion.component, vanilla.javaVersion.majorVersion, task);
  const javaExe = java.toConsoleJava(javaPath);

  // 2) Instalador
  const installer = await downloadInstaller(kind, full, task);
  const zip = new AdmZip(installer);
  const profileEntry = zip.getEntry('install_profile.json');
  if (!profileEntry) throw new Error(t('loaders.errInstallerFormat', { loader: label, version: full }));
  const profile = JSON.parse(zip.readAsText(profileEntry));

  // 3a) Formato antiguo (Forge <= 1.12.2 viejo): versionInfo + universal jar
  if (profile.versionInfo) {
    const vi = profile.versionInfo;
    const dest = artifactPath(profile.install.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    zip.extractEntryTo(profile.install.filePath, path.dirname(dest), false, true, false, path.basename(dest));
    await minecraft.saveVersionJson(vi);
    return { versionId: vi.id, loaderVersion: full };
  }

  // 3b) Formato moderno: version.json + maven/ + processors
  const versionJson = JSON.parse(zip.readAsText(profile.json.replace(/^\//, '')));
  const libRoot = path.resolve(paths.libraries());
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.startsWith('maven/')) continue;
    const dest = path.resolve(libRoot, entry.entryName.slice(6));
    if (!dest.startsWith(libRoot + path.sep)) continue;
    if (await exists(dest)) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, entry.getData());
  }

  const libs = [...(profile.libraries || []), ...(versionJson.libraries || [])];
  const items = [];
  const seen = new Set();
  for (const lib of libs) {
    const a = lib.downloads?.artifact;
    const rel = a?.path || mavenPath(lib.name);
    const dest = paths.library(rel);
    if (seen.has(dest)) continue;
    seen.add(dest);
    if (a && !a.url) continue; // lo genera el instalador
    const urls = a?.url ? [a.url] : [FORGE_MAVEN, NEO_MAVEN, ...minecraft.MAVEN_MIRRORS].map((b) => b + rel);
    items.push({ urls, path: dest, sha1: a?.sha1, size: a?.size });
  }
  await http.downloadAll(items, {
    concurrency: 12,
    signal: task?.signal,
    onProgress: task?.downloadProgress(t('loaders.librariesOf', { loader: label }), 0, 0.4),
  });

  // 4) Processors
  const processors = (profile.processors || []).filter((p) => !p.sides || p.sides.includes('client'));
  if (processors.length) {
    const temp = paths.cache('installers', `tmp-${kind}-${full}`);
    await rmrf(temp);
    await fsp.mkdir(temp, { recursive: true });
    const data = {
      SIDE: 'client',
      MINECRAFT_JAR: minecraft.clientJarPath(vanilla),
      MINECRAFT_VERSION: profile.minecraft || mcVersion,
      ROOT: paths.root(),
      INSTALLER: installer,
      LIBRARY_DIR: paths.libraries(),
    };
    for (const [key, val] of Object.entries(profile.data || {})) {
      const v = val.client;
      if (v === undefined) continue;
      if (v.startsWith('[') && v.endsWith(']')) data[key] = artifactPath(v.slice(1, -1));
      else if (v.startsWith("'") && v.endsWith("'")) data[key] = v.slice(1, -1);
      else {
        const rel = v.replace(/^\//, '');
        const target = path.resolve(temp, rel);
        if (!target.startsWith(path.resolve(temp) + path.sep)) continue;
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, zip.readFile(rel));
        data[key] = target;
      }
    }
    const resolveToken = (s) => {
      if (s.startsWith('[') && s.endsWith(']')) return artifactPath(s.slice(1, -1));
      return s.replace(/\{([A-Z0-9_]+)\}/g, (m, k) => (k in data ? data[k] : m));
    };
    for (let i = 0; i < processors.length; i++) {
      const proc = processors[i];
      const name = proc.jar.split(':')[1];
      task?.update({ detail: t('loaders.runningProcessor', { name, current: i + 1, total: processors.length }), progress: 0.4 + (0.6 * i) / processors.length });
      if (await processorOutputsValid(proc.outputs, resolveToken)) continue;
      const jar = artifactPath(proc.jar);
      const cp = [jar, ...(proc.classpath || []).map(artifactPath)];
      const mainClass = readManifestMainClass(jar);
      const args = proc.args.map(resolveToken);
      await runJava(javaExe, ['-cp', cp.join(path.delimiter), mainClass, ...args], temp, task, name);
    }
    await rmrf(temp);
  }

  await minecraft.saveVersionJson(versionJson);
  return { versionId: versionJson.id, loaderVersion: full };
}

// Instalacion de servidor: el instalador oficial lo hace en modo headless.
async function installServer(kind, mcVersion, full, serverDir, javaExe, task) {
  full = await normalizeVersion(kind, mcVersion, full);
  const installer = await downloadInstaller(kind, full, task);
  await runJava(javaExe, ['-jar', installer, '--installServer', serverDir], serverDir, task, t('loaders.installer'));
  return full;
}

module.exports = { getLoaderVersions, getGameVersions, install, installServer, neoforgeMc };
