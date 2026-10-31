'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
const CP_SEP = process.platform === 'win32' ? ';' : ':';

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(p) {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return -1;
  }
}

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
// Archivos que readJson no pudo leer (dañados o tomados por otro programa): quien recibio el valor por
// defecto puede escribir encima, asi que writeJson los guarda aparte antes de reemplazarlos.
const unreadable = new Set();

// En Windows un antivirus o un programa de backup puede tener el archivo tomado un instante: se reintenta.
async function readFileRetry(p) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.readFile(p, 'utf8');
    } catch (err) {
      if (i >= 3 || !LOCK_CODES.has(err.code)) throw err;
      await sleep(60 * 2 ** i);
    }
  }
}

async function readJson(p, fallback = undefined) {
  const key = path.resolve(p);
  try {
    const data = JSON.parse(await readFileRetry(p));
    unreadable.delete(key);
    return data;
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') unreadable.add(key);
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

function readJsonSync(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      if (i >= 4 || !LOCK_CODES.has(err.code)) throw err;
      await sleep(50 * 2 ** i);
    }
  }
}

async function writeJsonNow(p, data) {
  const key = path.resolve(p);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  // Un archivo que no se pudo leer no se pisa: queda como <archivo>.corrupt-<fecha> (si no estaba vacio).
  if (unreadable.has(key)) {
    const st = await fsp.stat(p).catch(() => null);
    if (st?.isFile() && st.size > 0) {
      await renameRetry(p, `${p}.corrupt-${Date.now()}`);
      console.warn(`[util] ${path.basename(p)} no se podía leer: se guardó una copia aparte antes de reemplazarlo`);
    }
    unreadable.delete(key);
  }
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(data, null, 2));
      // A disco antes de renombrar: con un corte de luz no queda un archivo vacio o lleno de ceros.
      await fh.sync().catch(() => {});
    } finally {
      await fh.close();
    }
    await renameRetry(tmp, p);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Escritura atomica: evita archivos corruptos si la app se cierra a mitad de escritura. Las escrituras
// de un mismo archivo van en orden (la ultima llamada es la que queda).
const writeChains = new Map();
function writeJson(p, data) {
  const key = path.resolve(p);
  const run = (writeChains.get(key) || Promise.resolve()).then(() => writeJsonNow(p, data));
  const tail = run.catch(() => {});
  writeChains.set(key, tail);
  tail.then(() => {
    if (writeChains.get(key) === tail) writeChains.delete(key);
  });
  return run;
}

function hashFile(p, algo = 'sha1') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(p)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}

// "group:artifact:version[:classifier][@ext]" -> partes
function parseMaven(name) {
  let ext = 'jar';
  let coords = name;
  const at = name.indexOf('@');
  if (at !== -1) {
    ext = name.slice(at + 1);
    coords = name.slice(0, at);
  }
  const [group, artifact, version, classifier] = coords.split(':');
  return { group, artifact, version, classifier: classifier || '', ext };
}

function mavenPath(name) {
  const { group, artifact, version, classifier, ext } = parseMaven(name);
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return [...group.split('.'), artifact, version, file].join('/');
}

function uid(len = 10) {
  return crypto.randomBytes(16).toString('base64url').replace(/[-_]/g, '').slice(0, len).toLowerCase();
}

// UUID offline identico al de Java: UUID.nameUUIDFromBytes("OfflinePlayer:" + nombre)
function offlineUUID(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  return md5.toString('hex');
}

function dashUUID(u) {
  const s = u.replace(/-/g, '');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// Compara versiones tipo "10.0.17134"
function compareNumeric(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Comparacion estilo semver: 0.20.0 > 0.20.0-beta.10 > 0.20.0-beta.9
function compareSemver(a, b) {
  const [ma, pa = ''] = String(a).split(/-(.*)/s);
  const [mb, pb = ''] = String(b).split(/-(.*)/s);
  const main = compareNumeric(ma.split('+')[0], mb.split('+')[0]);
  if (main) return main;
  if (!pa && pb) return 1;
  if (pa && !pb) return -1;
  return pa.localeCompare(pb, 'en', { numeric: true });
}

function sanitizeFileName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'sin-nombre';
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  OS_NAME,
  CP_SEP,
  exists,
  fileSize,
  readJson,
  readJsonSync,
  writeJson,
  hashFile,
  parseMaven,
  mavenPath,
  uid,
  offlineUUID,
  dashUUID,
  compareNumeric,
  compareSemver,
  sanitizeFileName,
  rmrf,
  dirSize,
  sleep,
};
