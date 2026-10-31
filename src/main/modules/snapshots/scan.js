'use strict';
// Que archivos de una instancia entran en una instantanea y como se recorren.
// Siempre: mods, configuracion, scripts, opciones y packs. Opcional: mundos elegidos (saves/<mundo>).
// Nunca: logs, crash-reports, capturas, caches ni los archivos internos de .venus (salvo el estado del modpack).
const fsp = require('fs/promises');
const path = require('path');

// rel: ruta relativa a la instancia. dir: carpeta (si no, archivo suelto).
// content: cambia lo que se juega (mods/packs); un cambio aca nunca se "agrupa" con la instantanea anterior.
// link: los .jar/.zip de estas carpetas son inmutables (se reemplazan, no se editan) y se pueden enlazar.
const ROOTS = [
  { rel: 'mods', dir: true, content: true, link: true, skipDot: true },
  { rel: 'config', dir: true },
  { rel: 'defaultconfigs', dir: true },
  { rel: 'kubejs', dir: true },
  { rel: 'scripts', dir: true },
  { rel: 'resourcepacks', dir: true, content: true, link: true, skipDot: true },
  { rel: 'shaderpacks', dir: true, content: true, link: true, skipDot: true },
  { rel: 'options.txt' },
  { rel: 'optionsof.txt' },
  { rel: 'optionsshaders.txt' },
  // Estado del modpack (lo escribe el modulo packs): tiene que volver junto con los mods.
  { rel: '.venus/pack-index.json', content: true },
  { rel: '.venus/pack-files.json', content: true },
];
const ROOT_KEYS = ROOTS.map((r) => r.rel);
const CONTENT_ROOTS = ROOTS.filter((r) => r.content).map((r) => r.rel);

const LINK_EXT = /\.(jar|zip|litemod)(\.disabled)?$/i;
const SKIP_NAMES = new Set(['session.lock', '.ds_store', 'thumbs.db', 'desktop.ini']);
const SKIP_FILE = /\.(tmp|part|crdownload)$/i;
const MAX_FILES = 400000;

// Un nombre de carpeta (mundo, instancia) es un solo segmento de ruta seguro.
function validSegment(s) {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    s.length <= 255 &&
    s !== '.' &&
    s !== '..' &&
    s.trim() === s &&
    !/[\\/\x00-\x1f<>:"|?*]/.test(s)
  );
}

function tooMany() {
  return Object.assign(new Error('too many files'), { code: 'TOO_MANY' });
}

function aborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
}

async function walkDir(abs, rel, out, opts) {
  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
    throw err;
  }
  for (const e of entries) {
    aborted(opts.signal);
    const name = e.name;
    const low = name.toLowerCase();
    if (SKIP_NAMES.has(low)) continue;
    const childRel = `${rel}/${name}`;
    const childAbs = path.join(abs, name);
    if (e.isDirectory()) {
      if (opts.skipDot && name.startsWith('.')) continue; // caches (.connector, .index...)
      await walkDir(childAbs, childRel, out, opts);
    } else if (e.isFile()) {
      if (SKIP_FILE.test(low)) continue;
      const st = await fsp.stat(childAbs).catch(() => null);
      if (!st || !st.isFile()) continue;
      out.push({ rel: childRel, abs: childAbs, size: st.size, mtime: Math.round(st.mtimeMs), link: Boolean(opts.link && LINK_EXT.test(name)) });
      if (out.length > MAX_FILES) throw tooMany();
    }
    // Enlaces simbolicos y otros tipos: se ignoran a proposito.
  }
}

async function scanFile(instDir, rel, out) {
  const abs = path.join(instDir, ...rel.split('/'));
  const st = await fsp.lstat(abs).catch(() => null);
  if (!st || !st.isFile()) return;
  out.push({ rel, abs, size: st.size, mtime: Math.round(st.mtimeMs), link: false });
}

// Carpetas de mundos validas (con level.dat) dentro de saves/.
async function listWorldFolders(instDir) {
  const saves = path.join(instDir, 'saves');
  const entries = await fsp.readdir(saves, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !validSegment(e.name)) continue;
    const st = await fsp.stat(path.join(saves, e.name, 'level.dat')).catch(() => null);
    if (st) out.push(e.name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Recorre lo que entra en una instantanea.
 * opts: { roots: [rel] (por defecto todas), worlds: [carpeta], signal }
 * Devuelve { files: [{ rel, abs, size, mtime, link }], roots, worlds }
 */
async function scan(instDir, { roots = ROOT_KEYS, worlds = [], signal } = {}) {
  const files = [];
  const wanted = ROOTS.filter((r) => roots.includes(r.rel));
  for (const r of wanted) {
    aborted(signal);
    if (r.dir) await walkDir(path.join(instDir, ...r.rel.split('/')), r.rel, files, { link: r.link, skipDot: r.skipDot, signal });
    else await scanFile(instDir, r.rel, files);
  }
  for (const w of worlds) {
    if (!validSegment(w)) continue;
    await walkDir(path.join(instDir, 'saves', w), `saves/${w}`, files, { signal });
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, roots: wanted.map((r) => r.rel), worlds: [...worlds] };
}

// Raiz (de ROOTS) o mundo al que pertenece una ruta relativa: 'mods', 'options.txt', 'saves/<mundo>'.
function rootOf(rel) {
  if (rel.startsWith('saves/')) {
    const w = rel.split('/')[1];
    return w ? `saves/${w}` : null;
  }
  for (const r of ROOT_KEYS) {
    if (rel === r || rel.startsWith(`${r}/`)) return r;
  }
  return null;
}

// Ruta relativa segura para escribir dentro de la instancia (las que vienen de un manifiesto).
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024) return false;
  if (rel.includes('\\') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false;
  return rel.split('/').every(validSegment) && rootOf(rel) !== null;
}

module.exports = { ROOTS, ROOT_KEYS, CONTENT_ROOTS, LINK_EXT, scan, listWorldFolders, rootOf, safeRel, validSegment };
