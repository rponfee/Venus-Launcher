'use strict';
// PlugManX: recarga en caliente de un plugin sin reiniciar el servidor (/plugman unload + load).
// Donde se publica: Modrinth (proyecto "plugmanx", id yro4niHu, con builds para Paper, Purpur, Folia y
// Spigot) y SpigotMC (recurso 88135, sin API de descarga directa). No esta en Hangar. Codigo fuente:
// https://github.com/Test-Account666/PlugManX. Se descarga de Modrinth con verificacion de hash.
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../../core/paths');
const detect = require('./detect');

const PROJECT_ID = 'yro4niHu';
const PAGE = 'https://modrinth.com/plugin/plugmanx';
const LOADERS = {
  paper: ['paper', 'spigot', 'bukkit'],
  purpur: ['purpur', 'paper', 'spigot', 'bukkit'],
  folia: ['folia'],
  spigot: ['spigot', 'bukkit'],
};
const NAME_RE = /^plugman(x)?$/i;

// Jars de la carpeta plugins/ con el nombre del plugin que declaran.
async function scanPlugins(dir) {
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!/\.jar$/i.test(n)) continue;
    const p = path.join(dir, n);
    const st = await fsp.stat(p).catch(() => null);
    if (!st?.isFile()) continue;
    const info = await detect.describeJar({ path: p, file: n, size: st.size, mtime: Math.round(st.mtimeMs) });
    out.push({ file: n, path: p, size: st.size, mtime: Math.round(st.mtimeMs), name: info.kind === 'plugin' ? info.name : null, version: info.version || null, paper: Boolean(info.paper) });
  }
  return out;
}

async function installed(pluginsDir, scanned) {
  const list = scanned || (await scanPlugins(pluginsDir));
  return list.find((p) => p.name && NAME_RE.test(p.name)) || null;
}

// Version de PlugManX compatible con el servidor: { id, versionNumber, type, file: { url, filename, sha1, size } } o null.
async function available(type, mcVersion) {
  const http = require('../../core/http');
  const loaders = LOADERS[type] || LOADERS.paper;
  const enc = (v) => encodeURIComponent(JSON.stringify(v));
  const url = `https://api.modrinth.com/v2/project/${PROJECT_ID}/version?loaders=${enc(loaders)}&game_versions=${enc([mcVersion])}`;
  const safe = `${type}-${mcVersion}`.replace(/[^\w.-]/g, '_');
  const versions = await http.getJson(url, { cacheFile: paths.cache(`devmode-plugmanx-${safe}.json`), cacheMaxAge: 3600 * 1000 });
  if (!Array.isArray(versions) || !versions.length) return null;
  const pick = versions.find((v) => v.version_type === 'release') || versions[0];
  const file = (pick.files || []).find((f) => f.primary) || (pick.files || [])[0];
  if (!file?.url) return null;
  return {
    id: pick.id,
    versionNumber: pick.version_number,
    type: pick.version_type,
    file: { url: file.url, filename: file.filename, sha1: file.hashes?.sha1 || null, size: file.size || 0 },
  };
}

// Descarga PlugManX en plugins/ (y borra versiones viejas). Devuelve { file, version }.
async function install(pluginsDir, version, { signal, onBytes, trash } = {}) {
  const http = require('../../core/http');
  if (!version?.file?.url || !/^https:\/\/cdn\.modrinth\.com\//.test(version.file.url)) throw Object.assign(new Error('badUrl'), { code: 'badUrl' });
  const filename = path.basename(version.file.filename || `PlugManX-${version.versionNumber}.jar`).replace(/[^\w.+-]/g, '_');
  if (!/\.jar$/i.test(filename)) throw Object.assign(new Error('badFile'), { code: 'badFile' });
  await fsp.mkdir(pluginsDir, { recursive: true });
  const old = (await scanPlugins(pluginsDir)).filter((p) => p.name && NAME_RE.test(p.name) && p.file !== filename);
  await http.download(
    { url: version.file.url, path: path.join(pluginsDir, filename), sha1: version.file.sha1 || undefined, size: version.file.size || undefined, force: true },
    { verify: version.file.sha1 ? 'hash' : 'size', signal, onBytes },
  );
  for (const o of old) {
    if (trash) await trash(o.path).catch(() => fsp.rm(o.path, { force: true }));
    else await fsp.rm(o.path, { force: true });
  }
  return { file: filename, version: version.versionNumber };
}

module.exports = { PROJECT_ID, PAGE, scanPlugins, installed, available, install, NAME_RE };
