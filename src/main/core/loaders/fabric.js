'use strict';
// Fabric, Quilt, Legacy Fabric y Babric: todos publican perfiles de version listos para usar
// (mismo formato de meta: /versions/game, /versions/loader/<mc>, .../<loader>/profile/json).
const paths = require('../paths');
const http = require('../http');
const minecraft = require('../minecraft');
const { t } = require('../i18n');
const { compareSemver } = require('../util');

const META = {
  fabric: 'https://meta.fabricmc.net/v2',
  quilt: 'https://meta.quiltmc.org/v3',
  legacyfabric: 'https://meta.legacyfabric.net/v2',
  babric: 'https://meta.babric.glass-launcher.net/v2',
};
const KINDS = Object.keys(META);
const NAMES = { fabric: 'Fabric', quilt: 'Quilt', legacyfabric: 'Legacy Fabric', babric: 'Babric' };
const CACHE_AGE = 30 * 60 * 1000;

function meta(kind) {
  const base = META[kind];
  if (!base) throw new Error(t('loaders.errUnknown', { kind: String(kind) }));
  return base;
}

function cacheName(s) {
  return String(s).replace(/[^\w.-]/g, '_');
}

// El flag "stable" de la meta de Fabric marca solo la version recomendada (la ultima estable);
// la estabilidad real sale del numero de version (0.16.0 estable, 0.16.0-beta.3 no).
function isStableVersion(v) {
  return !/(alpha|beta|pre|rc|snapshot|dev)/i.test(String(v));
}

// [{ version, stable }] de las versiones de Minecraft que soporta el loader.
async function getGameVersions(kind) {
  return http.getJson(`${meta(kind)}/versions/game`, {
    cacheFile: paths.cache(`${kind}-game.json`),
    cacheMaxAge: CACHE_AGE,
  });
}

// Versiones del loader compatibles con una version de Minecraft (la mas nueva primero):
// [{ version, label, stable, recommended }]
async function getLoaderVersions(kind, mcVersion) {
  const list = await http.getJson(`${meta(kind)}/versions/loader/${encodeURIComponent(mcVersion)}`, {
    cacheFile: paths.cache(`${kind}-loader-${cacheName(mcVersion)}.json`),
    cacheMaxAge: CACHE_AGE,
  });
  const seen = new Set();
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const version = e?.loader?.version;
    if (!version || seen.has(version)) continue;
    seen.add(version);
    out.push({ version, label: version, stable: isStableVersion(version), recommended: e.loader.stable === true && isStableVersion(version) });
  }
  out.sort((a, b) => compareSemver(b.version, a.version));
  // Una sola recomendada: la que marca la meta o, si no marca ninguna (Quilt), la estable mas nueva.
  const rec = out.find((l) => l.recommended) || out.find((l) => l.stable) || out[0];
  for (const l of out) l.recommended = l === rec;
  return out;
}

async function install(kind, mcVersion, loaderVersion, task) {
  let version = loaderVersion;
  if (!version || version === 'latest') {
    const list = await getLoaderVersions(kind, mcVersion);
    if (!list.length) throw new Error(t('loaders.errNoVersions', { loader: NAMES[kind] || kind, mc: mcVersion }));
    version = (list.find((l) => l.recommended) || list.find((l) => l.stable) || list[0]).version;
  }
  task?.update({ detail: t('loaders.downloadingProfile', { loader: NAMES[kind] || kind, version }), progress: null });
  let profile;
  try {
    profile = await http.getJson(`${meta(kind)}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(version)}/profile/json`);
  } catch (err) {
    if (err.status === 400 || err.status === 404) throw new Error(t('loaders.errProfile', { loader: NAMES[kind] || kind, version, mc: mcVersion }));
    throw err;
  }
  if (!profile || !profile.id || !profile.inheritsFrom) throw new Error(t('loaders.errProfile', { loader: NAMES[kind] || kind, version, mc: mcVersion }));
  await minecraft.saveVersionJson(profile);
  return { versionId: profile.id, loaderVersion: version };
}

// Jar de servidor de Fabric (un solo ejecutable que descarga lo que necesita).
async function serverJarUrl(mcVersion, loaderVersion) {
  const installers = await http.getJson(`${META.fabric}/versions/installer`);
  const inst = (installers.find((i) => i.stable) || installers[0]).version;
  return `${META.fabric}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/${inst}/server/jar`;
}

module.exports = { getGameVersions, getLoaderVersions, install, serverJarUrl, isStableVersion, KINDS, NAMES };
