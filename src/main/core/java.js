'use strict';
// Gestor de Java: descarga el runtime oficial de Mojang que pide cada version
// (jre-legacy=8, alpha=16, gamma=17, delta=21, epsilon=25...) con Adoptium como respaldo.
// Sin internet (o si fallan las descargas) usa otro Java ya instalado de la misma version.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const paths = require('./paths');
const http = require('./http');
const { t } = require('./i18n');
const { exists, readJson, writeJson, rmrf } = require('./util');

const RUNTIME_INDEX =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

const COMPONENT_MAJOR = {
  'jre-legacy': 8,
  'java-runtime-alpha': 16,
  'java-runtime-beta': 17,
  'java-runtime-gamma': 17,
  'java-runtime-gamma-snapshot': 17,
  'java-runtime-delta': 21,
  'java-runtime-epsilon': 25,
};

// Componente de Mojang preferido para cada version de Java (cuando el JSON no trae uno conocido).
const MAJOR_COMPONENT = { 8: 'jre-legacy', 16: 'java-runtime-alpha', 17: 'java-runtime-gamma', 21: 'java-runtime-delta', 25: 'java-runtime-epsilon' };

function mojangPlatform() {
  const a = process.arch;
  if (process.platform === 'win32') return a === 'arm64' ? 'windows-arm64' : a === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (process.platform === 'darwin') return a === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return a === 'ia32' ? 'linux-i386' : a === 'x64' ? 'linux' : `linux-${a}`;
}

function fallbackPlatform() {
  if (process.platform === 'win32' && process.arch === 'arm64') return 'windows-x64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'mac-os';
  return null;
}

// Versiones de Java con las que corre cada requerimiento (1.17 pide 16 pero anda con 17).
function compatibleMajors(required) {
  if (required === 16) return [16, 17];
  return [required];
}

// Java que pide cada version de Minecraft cuando todavia no se tiene su JSON.
function majorForMinecraft(mcVersion) {
  const s = String(mcVersion || '');
  const m = s.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) {
    const w = s.match(/^(\d{2})w(\d{2})/);
    if (!w) return 8;
    const year = Number(w[1]);
    const week = Number(w[2]);
    if (year >= 26) return 25;
    if (year === 25 || (year === 24 && week >= 14)) return 21;
    if (year >= 22 || (year === 21 && week >= 37)) return 17;
    return year === 21 || (year === 20 && week >= 45) ? 16 : 8;
  }
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  if (major >= 26) return 25;
  if (major !== 1) return 21;
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

const JAVA_CANDIDATES = ['bin/java', 'jre.bundle/Contents/Home/bin/java', 'Contents/Home/bin/java'];

// Busca el ejecutable java dentro de una carpeta de runtime (hasta 2 niveles).
async function findJava(dir, consoleExe = false) {
  const winName = consoleExe ? 'java.exe' : 'javaw.exe';
  const tryIn = async (base) => {
    for (const c of JAVA_CANDIDATES) {
      const p = path.join(base, process.platform === 'win32' ? c.replace(/java$/, winName) : c);
      if (await exists(p)) return p;
    }
    return null;
  };
  const direct = await tryIn(dir);
  if (direct) return direct;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await tryIn(path.join(dir, e.name));
      if (found) return found;
    }
  }
  return null;
}

function toConsoleJava(javaPath) {
  if (process.platform !== 'win32') return javaPath;
  return javaPath.replace(/javaw\.exe$/i, 'java.exe');
}

// ---------- Version de un ejecutable ----------
const versionCache = new Map(); // ruta -> { mtime, info }

function runVersion(javaPath) {
  return new Promise((resolve) => {
    execFile(toConsoleJava(javaPath), ['-version'], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`;
      const m = out.match(/version "([^"]+)"/);
      if (!m) return resolve(null);
      const v = m[1];
      const major = v.startsWith('1.') ? parseInt(v.split('.')[1], 10) : parseInt(v, 10);
      resolve({ version: v, major, vendor: (out.split('\n')[1] || '').trim() });
    });
  });
}

async function getJavaVersion(javaPath) {
  if (!javaPath) return null;
  let mtime = -1;
  try {
    mtime = (await fsp.stat(toConsoleJava(javaPath))).mtimeMs;
  } catch {
    mtime = -1; // puede ser un comando del PATH ("java")
  }
  const hit = versionCache.get(javaPath);
  if (mtime >= 0 && hit && hit.mtime === mtime) return hit.info;
  const info = await runVersion(javaPath);
  if (info && mtime >= 0) versionCache.set(javaPath, { mtime, info });
  return info;
}

// ---------- Instalacion ----------
async function installMojangRuntime(component, entry, dir, task, major) {
  const manifest = await http.getJson(entry.manifest.url);
  const items = [];
  const links = [];
  const executables = [];
  await fsp.mkdir(dir, { recursive: true });
  for (const [rel, info] of Object.entries(manifest.files)) {
    const target = path.join(dir, rel);
    if (info.type === 'directory') {
      await fsp.mkdir(target, { recursive: true });
    } else if (info.type === 'file') {
      const raw = info.downloads.raw;
      items.push({ url: raw.url, path: target, sha1: raw.sha1, size: raw.size });
      if (info.executable) executables.push(target);
    } else if (info.type === 'link') {
      links.push({ target, link: info.target });
    }
  }
  await http.downloadAll(items, {
    concurrency: 12,
    verify: 'hash',
    signal: task?.signal,
    onProgress: task?.downloadProgress(t('java.downloadLabel', { major })),
  });
  if (process.platform !== 'win32') {
    for (const f of executables) await fsp.chmod(f, 0o755).catch(() => {});
    for (const l of links) {
      await fsp.rm(l.target, { force: true }).catch(() => {});
      await fsp.symlink(l.link, l.target).catch(() => {});
    }
  }
}

// Paquete del JRE con el sha256 que publica la API de Adoptium (se verifica al bajarlo).
async function adoptiumPackage(major, osName, arch, signal) {
  const q = new URLSearchParams({ architecture: arch, image_type: 'jre', os: osName, vendor: 'eclipse' });
  const list = await http.getJson(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?${q}`, { signal });
  const bin = (Array.isArray(list) ? list : []).map((a) => a?.binary).find((b) => b?.image_type === 'jre' && (b.heap_size || 'normal') === 'normal' && b.package?.link);
  const pkg = bin?.package;
  if (!pkg || !/^https:\/\//i.test(pkg.link) || !/^[0-9a-f]{64}$/i.test(String(pkg.checksum || ''))) throw new Error(t('java.errNoAdoptium', { major }));
  return { url: pkg.link, sha256: pkg.checksum.toLowerCase(), size: Number(pkg.size) || undefined };
}

async function installAdoptium(major, dir, task) {
  const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  let arch = { x64: 'x64', arm64: 'aarch64', ia32: 'x32', arm: 'arm' }[process.arch] || 'x64';
  // Java 8 no existe para ARM en Windows/Mac: se usa x64 (emulado).
  if (major === 8 && arch === 'aarch64' && osName !== 'linux') arch = 'x64';
  const ext = osName === 'windows' ? 'zip' : 'tar.gz';
  let lastErr = null;
  // Java 16 ya no se publica en todas las plataformas: 17 sirve para las mismas versiones.
  for (const m of compatibleMajors(major)) {
    const archive = paths.cache('java', `adoptium-${m}-${osName}-${arch}.${ext}`);
    try {
      task?.update({ detail: t('java.downloadingAdoptium', { major: m }), progress: null });
      const pkg = await adoptiumPackage(m, osName, arch, task?.signal);
      await http.download({ ...pkg, path: archive, force: true }, { verify: 'hash', signal: task?.signal });
      await rmrf(dir);
      await fsp.mkdir(dir, { recursive: true });
      task?.update({ detail: t('java.extracting', { major: m }) });
      if (ext === 'zip') {
        const AdmZip = require('adm-zip');
        new AdmZip(archive).extractAllTo(dir, true);
      } else {
        const tar = require('tar');
        await tar.x({ file: archive, cwd: dir });
      }
      await fsp.rm(archive, { force: true }).catch(() => {});
      return m;
    } catch (err) {
      await fsp.rm(archive, { force: true }).catch(() => {});
      if (task?.signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error(t('java.errInstall', { major, error: '?' }));
}

async function readIndex() {
  try {
    return await http.getJson(RUNTIME_INDEX, { cacheFile: paths.cache('java-runtimes.json'), cacheMaxAge: 6 * 3600 * 1000 });
  } catch {
    return null;
  }
}

function indexEntry(index, component) {
  for (const plat of [mojangPlatform(), fallbackPlatform()].filter(Boolean)) {
    const list = index?.[plat]?.[component];
    if (list && list.length) return list[0];
  }
  return null;
}

// Runtimes ya probados en esta sesion (para no lanzar "java -version" en cada partida).
const verified = new Set();

async function verifyRuntime(javaPath, major) {
  if (verified.has(javaPath)) return true;
  const info = await getJavaVersion(javaPath);
  if (!info || !compatibleMajors(major).includes(info.major)) return false;
  verified.add(javaPath);
  return true;
}

// Otro Java ya instalado (de Venus o del sistema) que sirva para esa version.
async function findCompatibleInstalled(major, skipDir) {
  const majors = compatibleMajors(major);
  for (const r of await listInstalledRuntimes()) {
    if (skipDir && path.resolve(r.dir) === path.resolve(skipDir)) continue;
    if (r.major && majors.includes(r.major) && (await verifyRuntime(r.path, major))) return r.path;
  }
  for (const j of await detectSystemJava().catch(() => [])) {
    if (majors.includes(j.major)) return j.path;
  }
  return null;
}

// Instala en una carpeta temporal y reemplaza la vieja solo si todo salio bien
// (si la vieja esta en uso por un juego abierto, se sigue usando esa).
async function installInto(dir, major, component, entry, task) {
  const temp = `${dir}.partial`;
  await rmrf(temp).catch(() => {});
  const errors = [];
  let source = null;
  if (entry) {
    try {
      await installMojangRuntime(component, entry, temp, task, major);
      source = `mojang:${entry.version.name}`;
    } catch (err) {
      if (task?.signal?.aborted) throw err;
      errors.push(err);
      console.warn(`[java] Runtime de Mojang (Java ${major}) fallo, probando Adoptium:`, err.message);
    }
  }
  if (!source) {
    try {
      const got = await installAdoptium(major, temp, task);
      source = `adoptium:${got}`;
    } catch (err) {
      if (task?.signal?.aborted) throw err;
      errors.push(err);
    }
  }
  if (!source) {
    await rmrf(temp).catch(() => {});
    throw errors[errors.length - 1] || new Error('?');
  }
  const exe = await findJava(temp);
  if (!exe || !(await verifyRuntime(exe, major))) {
    await rmrf(temp).catch(() => {});
    throw new Error(t('java.errNotFound', { major }));
  }
  verified.delete(exe);
  await writeJson(path.join(temp, '.venus-runtime.json'), { source, component, major, installed: Date.now() });
  // Cambio de carpetas: si la vieja esta en uso (un juego abierto) Windows no deja moverla y queda como estaba
  const old = `${dir}.old-${Date.now()}`;
  let movedOld = false;
  if (await exists(dir)) {
    try {
      await fsp.rename(dir, old);
      movedOld = true;
    } catch (err) {
      await rmrf(temp).catch(() => {});
      throw err;
    }
  }
  try {
    await fsp.rename(temp, dir);
  } catch (err) {
    if (movedOld) await fsp.rename(old, dir).catch(() => {});
    await rmrf(temp).catch(() => {});
    throw err;
  }
  if (movedOld) rmrf(old).catch(() => {});
  return findJava(dir);
}

// Asegura el runtime y devuelve la ruta al ejecutable (javaw en Windows).
async function ensureRuntime(component = 'jre-legacy', majorVersion, task) {
  const major = Number(majorVersion) || COMPONENT_MAJOR[component] || 8;
  const comp = component || MAJOR_COMPONENT[major] || `java-${major}`;
  const dir = path.join(paths.runtime(), comp);
  const marker = await readJson(path.join(dir, '.venus-runtime.json'), null);
  const existing = marker ? await findJava(dir) : null;

  const index = await readIndex();
  const entry = indexEntry(index, comp);
  const wanted = entry ? `mojang:${entry.version.name}` : null;

  if (existing) {
    const upToDate = !index || !wanted || marker.source === wanted;
    if (upToDate && (await verifyRuntime(existing, major))) return existing;
  }

  task?.update({ detail: t('java.preparing', { major }), progress: null });
  try {
    return await installInto(dir, major, comp, entry, task);
  } catch (err) {
    if (task?.signal?.aborted) throw err;
    // Actualizacion fallida: si el runtime anterior funciona, seguimos con ese
    if (existing && (await verifyRuntime(existing, major))) {
      console.warn(`[java] No se pudo actualizar Java ${major}, se usa el instalado:`, err.message);
      return existing;
    }
    const alt = await findCompatibleInstalled(major, dir);
    if (alt) {
      console.warn(`[java] Se usa otro Java ${major} instalado:`, alt);
      return alt;
    }
    if (!index) throw new Error(t('java.errOffline', { major }));
    throw new Error(t('java.errInstall', { major, error: err.message }));
  }
}

// ---------- Listados ----------
async function listInstalledRuntimes() {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(paths.runtime(), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || /\.(partial|old-\d+)$/.test(e.name)) continue;
    const dir = path.join(paths.runtime(), e.name);
    const java = await findJava(dir);
    if (!java) continue;
    const marker = await readJson(path.join(dir, '.venus-runtime.json'), {});
    out.push({ component: e.name, major: marker.major || COMPONENT_MAJOR[e.name] || null, source: marker.source || '', path: java, dir });
  }
  return out;
}

// Busca instalaciones de Java del sistema para que el usuario pueda elegir una.
async function detectSystemJava() {
  const found = new Set();
  const roots = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'GraalVM']) {
        roots.push(path.join(base, vendor));
      }
    }
  } else if (process.platform === 'darwin') {
    roots.push('/Library/Java/JavaVirtualMachines');
  } else {
    roots.push('/usr/lib/jvm', '/opt/java');
  }
  if (process.env.USERPROFILE || process.env.HOME) roots.push(path.join(process.env.USERPROFILE || process.env.HOME, '.jdks'));
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);
  for (const r of roots) {
    try {
      for (const e of fs.readdirSync(r, { withFileTypes: true })) if (e.isDirectory()) candidates.push(path.join(r, e.name));
    } catch {
      /* no existe */
    }
  }
  const result = [];
  for (const c of candidates) {
    const java = await findJava(c);
    if (!java || found.has(java.toLowerCase())) continue;
    found.add(java.toLowerCase());
    const info = await getJavaVersion(java);
    if (info) result.push({ path: java, ...info });
  }
  return result.sort((a, b) => b.major - a.major);
}

// ---------- Chequeo de un Java elegido a mano ----------
// Devuelve { ok, major, problem: null | 'broken' | 'tooOld' | 'legacyModded', message }
async function checkJavaFor({ javaPath, requiredMajor, mcVersion, loader } = {}) {
  const required = Number(requiredMajor) || majorForMinecraft(mcVersion);
  const info = await getJavaVersion(javaPath);
  if (!info) return { ok: false, major: null, problem: 'broken', message: t('java.warnBroken', { path: javaPath }) };
  const major = info.major;
  if (major < required && !compatibleMajors(required).includes(major)) {
    return { ok: false, major, problem: 'tooOld', message: t('java.warnTooOld', { current: major, required, mc: mcVersion }) };
  }
  if (required === 8 && major > 8 && ['forge', 'optifine', 'legacyfabric'].includes(loader)) {
    return { ok: false, major, problem: 'legacyModded', message: t('java.warnLegacyModded', { current: major, mc: mcVersion }) };
  }
  return { ok: true, major, problem: null, message: '' };
}

module.exports = {
  ensureRuntime,
  findJava,
  toConsoleJava,
  getJavaVersion,
  listInstalledRuntimes,
  detectSystemJava,
  checkJavaFor,
  majorForMinecraft,
  compatibleMajors,
  COMPONENT_MAJOR,
  MAJOR_COMPONENT,
};
