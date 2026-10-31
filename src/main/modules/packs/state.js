'use strict';
// Estado del modpack instalado en una instancia:
//   <instancia>/.venus/pack-index.json  el modrinth.index.json de la version instalada + sha1 de cada override
//   <instancia>/.venus/pack-files.json  archivos que maneja el pack (los que el usuario agrego a mano no estan)
// Con esto, al actualizar se tocan solo los archivos del pack y se respetan los mods agregados a mano.
const fsp = require('fs/promises');
const path = require('path');
const { t } = require('../../core/i18n');
const safety = require('./safety');

const STATE_VERSION = 1;
// Dominios del formato .mrpack (la lista vive en safety.js, compartida con core/modrinth).
const ALLOWED_HOSTS = new Set(safety.PACK_HOSTS);

function userError(key, vars) {
  return Object.assign(new Error(t(key, vars)), { userFacing: true, key });
}

// Ruta relativa segura dentro de la instancia (o null). Nunca archivos internos del launcher
// (venus-instance.json, .venus/): ver safety.safeRelPath.
function safePackRel(rel) {
  return safety.safeRelPath(rel);
}

function resolveInside(instDir, rel) {
  return safety.resolveInside(instDir, rel);
}

// URLs de descarga permitidas por el formato .mrpack (https y dominios conocidos).
function allowedUrls(list) {
  return safety.allowedPackUrls(list);
}

function hostOf(list) {
  return safety.firstHost(list);
}

// Archivos del indice que van en el cliente, con la ruta validada. Map ruta -> archivo
// (los hashes con formato invalido quedan en null: ese archivo no se baja porque no se puede verificar).
function clientFiles(index) {
  const out = new Map();
  for (const f of Array.isArray(index?.files) ? index.files : []) {
    if (!f || typeof f !== 'object') continue;
    if (f.env && f.env.client === 'unsupported') continue;
    const rel = safePackRel(f.path);
    if (!rel) continue;
    const { sha1, sha512 } = safety.packHashes(f.hashes);
    out.set(rel, { ...f, path: rel, sha1, sha512, size: Number(f.fileSize) || 0 });
  }
  return out;
}

function statePaths(instDir) {
  return { index: path.join(instDir, '.venus', 'pack-index.json'), files: path.join(instDir, '.venus', 'pack-files.json') };
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, data) {
  await safety.writeFileAtomic(file, JSON.stringify(data, null, 1));
}

async function readState(instDir) {
  const p = statePaths(instDir);
  const index = await readJson(p.index);
  if (!index || index.v !== STATE_VERSION || !index.index || typeof index.index !== 'object') return null;
  const files = await readJson(p.files);
  return {
    meta: {
      source: index.source || 'modrinth',
      projectId: index.projectId || null,
      versionId: index.versionId || null,
      versionNumber: index.versionNumber || null,
      installedAt: index.installedAt || null,
      reconstructed: Boolean(index.reconstructed),
    },
    index: index.index,
    overrides: index.overrides && typeof index.overrides === 'object' ? index.overrides : null,
    files: files && files.v === STATE_VERSION && files.files && typeof files.files === 'object' ? files.files : null,
  };
}

// meta: { projectId, versionId, versionNumber, reconstructed }, index: modrinth.index.json,
// overrides: { ruta: sha1 } | null, files: { ruta: { sha1, src: 'index'|'override', disabled? } }
async function writeState(instDir, { meta = {}, index, overrides, files }) {
  const p = statePaths(instDir);
  await writeJson(p.index, {
    v: STATE_VERSION,
    source: 'modrinth',
    projectId: meta.projectId || null,
    versionId: meta.versionId || null,
    versionNumber: meta.versionNumber || index?.versionId || null,
    installedAt: meta.installedAt || Date.now(),
    reconstructed: Boolean(meta.reconstructed),
    index,
    overrides: overrides || null,
  });
  await writeJson(p.files, { v: STATE_VERSION, files: files || {} });
}

// Info del modpack de Modrinth guardada en la instancia (core la guarda en inst.modrinth.pack).
function packInfo(inst) {
  const p = inst?.modrinth?.pack || inst?.pack || null;
  return p && typeof p === 'object' ? p : null;
}

module.exports = { ALLOWED_HOSTS, userError, safePackRel, resolveInside, allowedUrls, hostOf, clientFiles, readState, writeState, statePaths, packInfo };
