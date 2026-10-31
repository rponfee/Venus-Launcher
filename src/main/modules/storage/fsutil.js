'use strict';
// Utilidades de disco del modulo de almacenamiento: stat exactos, recorridos, hash y tareas en paralelo.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { t } = require('../../core/i18n');

// stat con numeros exactos: en NTFS el id de archivo (ino) tiene 64 bits y como number pierde precision,
// lo que podria hacer pasar dos archivos distintos por el mismo.
async function statExact(p, { lstat = false } = {}) {
  const st = await (lstat ? fsp.lstat(p, { bigint: true }) : fsp.stat(p, { bigint: true }));
  return fromBigStat(st);
}

function fromBigStat(st) {
  return {
    key: `${st.dev}:${st.ino}`,
    dev: String(st.dev),
    ino: String(st.ino),
    size: Number(st.size),
    nlink: Number(st.nlink),
    mtimeNs: String(st.mtimeNs),
    ctimeNs: String(st.ctimeNs),
    mtimeMs: Number(st.mtimeMs),
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymbolicLink: st.isSymbolicLink(),
  };
}

function abortError(signal) {
  return signal?.reason || new Error(t('storage.errCancelled'));
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError(signal);
}

// SHA-1 de un archivo leyendo en bloques de 1 MB (cancelable).
async function sha1File(p, signal) {
  const h = crypto.createHash('sha1');
  const stream = fs.createReadStream(p, { highWaterMark: 1 << 20 });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw abortError(signal);
      h.update(chunk);
    }
  } finally {
    stream.destroy();
  }
  return h.digest('hex');
}

// Ejecuta fn sobre cada elemento con como mucho `limit` en paralelo.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

async function readdirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Recorre un arbol sin seguir enlaces simbolicos ni uniones (junctions).
// onFile(ruta, statExacto) para cada archivo; onDir(ruta, rel) puede devolver false para no entrar.
async function walk(dir, { onFile, onDir, maxDepth = Infinity, signal, concurrency = 24 } = {}, depth = 0, rel = '') {
  checkAbort(signal);
  const entries = await readdirSafe(dir);
  const files = [];
  const dirs = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (depth + 1 > maxDepth) continue;
      if (onDir && onDir(full, r, e.name) === false) continue;
      dirs.push([full, r]);
    } else if (e.isFile()) files.push([full, r, e.name]);
  }
  await mapLimit(files, concurrency, async ([full, r, name]) => {
    checkAbort(signal);
    let st;
    try {
      st = await statExact(full);
    } catch {
      return;
    }
    await onFile(full, st, r, name);
  });
  for (const [full, r] of dirs) await walk(full, { onFile, onDir, maxDepth, signal, concurrency }, depth + 1, r);
}

async function removeTree(p) {
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}

// Ruta relativa a la carpeta de datos, con barras normales (para mostrar).
function relTo(root, p) {
  return path.relative(root, p).split(path.sep).join('/');
}

// La ruta queda dentro de la carpeta de datos (nunca se borra nada afuera).
function inside(root, p) {
  const full = path.resolve(p);
  const base = path.resolve(root);
  return full !== base && full.startsWith(base + path.sep);
}

module.exports = { statExact, fromBigStat, sha1File, mapLimit, walk, readdirSafe, removeTree, relTo, inside, checkAbort, abortError };
