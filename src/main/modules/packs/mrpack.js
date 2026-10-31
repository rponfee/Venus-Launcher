'use strict';
// Archivos .mrpack: leer el indice y los overrides (con su sha1) e instalarlos en una instancia
// registrando que archivos maneja el pack (.venus/pack-index.json y pack-files.json).
const fsp = require('fs/promises');
const path = require('path');
const http = require('../../core/http');
const modrinth = require('../../core/modrinth');
const { t } = require('../../core/i18n');
const { openZip } = require('./zip');
const { userError, safePackRel, resolveInside, allowedUrls, hostOf, clientFiles, writeState } = require('./state');

// Entradas de overrides que van en el cliente: client-overrides pisa a overrides. Map ruta -> entrada
function overrideEntries(zip, prefixes = ['overrides/', 'client-overrides/']) {
  const out = new Map();
  for (const prefix of prefixes) {
    for (const e of zip.entries) {
      if (e.isDir || !e.name.startsWith(prefix)) continue;
      const rel = safePackRel(e.name.slice(prefix.length));
      if (rel) out.set(rel, e);
    }
  }
  return out;
}

async function openPack(file) {
  let zip;
  try {
    zip = await openZip(file);
  } catch (err) {
    if (err.code === 'BAD_ZIP') throw userError('packs.errNotZip');
    throw err;
  }
  return zip;
}

function parseIndex(text) {
  let index;
  try {
    index = JSON.parse(text);
  } catch {
    throw userError('packs.errBadIndex');
  }
  if (!index || typeof index !== 'object' || index.game !== 'minecraft' || !Array.isArray(index.files) || !index.dependencies?.minecraft) throw userError('packs.errBadIndex');
  if (Number(index.formatVersion) !== 1) throw userError('packs.errPackFormat', { version: String(index.formatVersion) });
  return index;
}

// Lee un .mrpack: { index, overrides: { ruta: sha1 } }
const packCache = new Map(); // ruta|tamanio|fecha -> resultado
async function readPack(file) {
  const st = await fsp.stat(file);
  const key = `${path.resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}`;
  if (packCache.has(key)) return packCache.get(key);
  const zip = await openPack(file);
  try {
    const text = await zip.readText('modrinth.index.json');
    if (text === null) throw userError('packs.errNoIndex');
    const index = parseIndex(text);
    const overrides = {};
    for (const [rel, e] of overrideEntries(zip)) overrides[rel] = await zip.hash(e);
    const out = { index, overrides };
    packCache.set(key, out);
    if (packCache.size > 20) packCache.delete(packCache.keys().next().value);
    return out;
  } finally {
    await zip.close().catch(() => {});
  }
}

// Descarga (o toma del cache) el .mrpack de una version de Modrinth.
async function fetchVersion(versionId, signal) {
  try {
    return await modrinth.downloadPack(versionId, signal ? { signal } : undefined);
  } catch (err) {
    if (err?.userFacing || err?.code === 'notfound') throw err;
    throw userError('packs.errDownloadPack', { error: err?.message || String(err) });
  }
}

function downloadItems(instDir, files, staging = null) {
  const items = [];
  const blocked = [];
  for (const f of files) {
    const urls = allowedUrls(f.downloads);
    if (!urls.length || (!f.sha1 && !f.sha512)) {
      blocked.push({ path: f.path, host: hostOf(f.downloads) });
      continue;
    }
    const dest = staging ? path.join(staging, `${items.length}-${path.basename(f.path)}`) : resolveInside(instDir, f.path);
    if (!dest) continue;
    // Se verifican todos los hashes que trae el indice (sha1 y sha512, con el formato ya validado).
    items.push({ urls, path: dest, sha1: f.sha1 || undefined, sha512: f.sha512 || undefined, size: f.size || undefined, file: f });
  }
  return { items, blocked };
}

// Tarea con el progreso mapeado a un tramo [from, to] de otra (para pasarla a otro paso).
function scaledTask(task, from, to) {
  if (!task) return null;
  return {
    get signal() {
      return task.signal;
    },
    update({ detail, progress, title } = {}) {
      task.update({ detail, title, progress: progress === null || progress === undefined ? progress : from + (to - from) * progress });
    },
  };
}

// Progreso de descargas mapeado a [from, to] de la tarea.
function downloadProgress(task, from, to) {
  return ({ done, total, bytes, totalBytes }) => {
    const frac = totalBytes > 0 ? bytes / totalBytes : total ? done / total : 1;
    task?.update({ detail: t('packs.stepDownloading', { done, total }), progress: from + (to - from) * Math.min(1, frac) });
  };
}

async function runDownloads(items, task, signal, from, to) {
  if (!items.length) return;
  try {
    await http.downloadAll(items, { concurrency: 8, verify: 'hash', signal, onProgress: downloadProgress(task, from, to) });
  } catch (err) {
    if (signal?.aborted) throw err;
    const failed = err.failures?.length || 0;
    throw userError('packs.errDownloads', { count: failed || 1, file: err.failures?.[0] ? path.basename(err.failures[0].item.path) : '?', error: err.failures?.[0]?.err?.message || err.message });
  }
}

/**
 * Instala un .mrpack en una carpeta de instancia (instalacion nueva) y guarda el estado del pack.
 * meta: { projectId, versionId, versionNumber }. Devuelve { index, warnings: [...] }
 */
async function installPack(file, instDir, { task, signal, meta = {}, from = 0, to = 1 } = {}) {
  const zip = await openPack(file);
  try {
    const text = await zip.readText('modrinth.index.json');
    if (text === null) throw userError('packs.errNoIndex');
    const index = parseIndex(text);
    const files = [...clientFiles(index).values()];
    const { items, blocked } = downloadItems(instDir, files);
    task?.update({ detail: t('packs.stepDownloading', { done: 0, total: items.length }), progress: from });
    await runDownloads(items, task, signal, from, from + (to - from) * 0.85);

    const tracked = {};
    for (const it of items) tracked[it.file.path] = { sha1: it.file.sha1 || null, src: 'index' };
    const overrides = {};
    const entries = overrideEntries(zip);
    let n = 0;
    for (const [rel, e] of entries) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      const dest = resolveInside(instDir, rel);
      if (!dest) continue;
      const r = await zip.extract(e, dest, { signal });
      overrides[rel] = r.sha1;
      tracked[rel] = { sha1: r.sha1, src: 'override' };
      if (++n % 25 === 0) task?.update({ detail: t('packs.stepOverrides', { done: n, total: entries.size }), progress: from + (to - from) * (0.85 + 0.15 * (n / entries.size)) });
    }
    await writeState(instDir, { meta: { ...meta, versionNumber: meta.versionNumber || index.versionId }, index, overrides, files: tracked });
    const warnings = blocked.length ? [{ code: 'blocked', vars: { count: blocked.length, files: blocked.slice(0, 5).map((b) => `${path.basename(b.path)} (${b.host})`).join(', ') } }] : [];
    return { index, warnings, files: items.length, overrides: entries.size };
  } finally {
    await zip.close().catch(() => {});
  }
}

module.exports = { overrideEntries, openPack, parseIndex, readPack, fetchVersion, downloadItems, runDownloads, downloadProgress, scaledTask, installPack };
