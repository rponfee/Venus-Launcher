'use strict';
// Lector del paquete .venusext: un zip con manifest.json y archivos estáticos. El contenido se trata como hostil:
//  - lector propio del directorio central (adm-zip descomprime sin tope), con topes de tamaño y cantidad antes de
//    inflar nada, y el inflado cortado al tamaño declarado (un encabezado que miente no pasa);
//  - rutas: sin absolutas, '..', '\', nombres de dispositivo ni enlaces simbólicos (zip-slip), y sin repetidas aunque
//    cambie la mayúscula, porque Windows las pisa;
//  - la entrada del directorio central tiene que coincidir con su encabezado local y las entradas no se pueden
//    solapar (así se arman las bombas que no se ven en los tamaños);
//  - allowlist de extensiones: HTML, CSS, JS y raster. SVG no: es un documento activo que se puede abrir solo.
// readPackage(buffer) -> { manifest, files: [{ path, size, data }], sha256, size }. Lanza ExtensionError (manifest.js).
const crypto = require('crypto');
const zlib = require('zlib');
const path = require('path');
const fsp = require('fs/promises');
const safety = require('../packs/safety');
const { ExtensionError, validateManifest } = require('./manifest');

const MAX_PACKAGE = 5 * 1024 * 1024; // el mismo tope del bucket (0036)
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_ENTRIES = MAX_FILES + 100; // archivos más carpetas
const MAX_RATIO = 60;
const RATIO_FROM = 256 * 1024; // un archivo chico puede comprimir mucho sin ser una bomba
const MAX_DEPTH = 8;
const MAX_PATH = 180;

const TEXT_TYPES = Object.freeze({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' });
const IMAGE_TYPES = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' });
const MANIFEST = 'manifest.json';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const decoder = new TextDecoder('utf-8', { fatal: true });
// Marcos anidados: traen un ámbito nuevo, sin lo que quita boot.js. Ninguna extensión los necesita.
const FRAME_TAG = /<(iframe|frame|frameset|object|embed|portal|fencedframe)[\s/>]/i;

const contentTypeOf = (rel) => {
  const ext = path.posix.extname(rel).toLowerCase();
  return TEXT_TYPES[ext] || IMAGE_TYPES[ext] || null;
};

function decodeName(buf) {
  try {
    return decoder.decode(buf);
  } catch {
    throw new ExtensionError('bad_path', '?');
  }
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  throw new ExtensionError('bad_zip', 'eocd');
}

// Entradas del directorio central, validadas pero sin descomprimir nada todavía.
function readEntries(buf) {
  if (buf.length < 22) throw new ExtensionError('bad_zip', 'size');
  const eocd = findEocd(buf);
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const countHere = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdStart = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || countHere !== count) throw new ExtensionError('bad_zip', 'disks');
  if (count === 0xffff || cdSize === 0xffffffff || cdStart === 0xffffffff) throw new ExtensionError('bad_zip', 'zip64');
  if (count > MAX_ENTRIES) throw new ExtensionError('too_many_files', String(count));
  if (cdStart + cdSize > eocd) throw new ExtensionError('bad_zip', 'central');

  const entries = [];
  let at = cdStart;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || buf.readUInt32LE(at) !== SIG_CENTRAL) throw new ExtensionError('bad_zip', 'central');
    const madeBy = buf.readUInt16LE(at + 4) >> 8;
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const attrs = buf.readUInt32LE(at + 38);
    const offset = buf.readUInt32LE(at + 42);
    const end = at + 46 + nameLen + extraLen + commentLen;
    if (end > eocd) throw new ExtensionError('bad_zip', 'central');
    const nameBuf = buf.subarray(at + 46, at + 46 + nameLen);
    const name = decodeName(nameBuf);
    if (flags & 0x1) throw new ExtensionError('bad_zip', 'encrypted');
    if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) throw new ExtensionError('bad_zip', 'zip64');
    // Unix: enlaces simbólicos y demás archivos especiales no entran
    if (madeBy === 3) {
      const type = (attrs >>> 16) & 0o170000;
      if (type && type !== 0o100000 && type !== 0o040000) throw new ExtensionError('bad_path', name);
    }
    entries.push({ name, nameBuf, method, flags, crc, compressedSize, size, offset, dir: /[/\\]$/.test(name) });
    at = end;
  }
  return entries;
}

// La ruta dentro del paquete, o error. Una barra invertida cuenta como separador (el Compress-Archive de Windows las
// escribe así) y pasa por las mismas reglas que las demás.
function cleanEntryPath(name) {
  if (name.includes('\0')) throw new ExtensionError('bad_path', name);
  const slashes = name.replace(/\\/g, '/');
  const raw = slashes.endsWith('/') ? slashes.slice(0, -1) : slashes;
  const clean = safety.safeRelPath(raw, { instance: false, maxLength: MAX_PATH, maxDepth: MAX_DEPTH });
  if (!clean || clean !== raw) throw new ExtensionError('bad_path', name);
  // Las carpetas y archivos con punto adelante son del launcher (.venus/boot.js)
  if (clean.split('/').some((seg) => seg.startsWith('.'))) throw new ExtensionError('bad_path', name);
  return clean;
}

function checkEntries(entries) {
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const e of entries) {
    const rel = cleanEntryPath(e.name);
    const key = rel.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new ExtensionError('bad_path', e.name);
    seen.add(key);
    if (e.dir) {
      if (e.size !== 0) throw new ExtensionError('bad_zip', e.name);
      continue;
    }
    if (rel !== MANIFEST && !contentTypeOf(rel)) throw new ExtensionError('bad_file_type', rel);
    if (e.method !== 0 && e.method !== 8) throw new ExtensionError('bad_zip', 'method');
    if (e.method === 0 && e.size !== e.compressedSize) throw new ExtensionError('bad_zip', rel);
    if (e.size > MAX_FILE) throw new ExtensionError('file_too_large', rel);
    total += e.size;
    if (total > MAX_TOTAL) throw new ExtensionError('package_too_large', 'total');
    if (e.size > RATIO_FROM && e.size > e.compressedSize * MAX_RATIO) throw new ExtensionError('zip_bomb', rel);
    out.push({ ...e, rel });
  }
  if (out.length > MAX_FILES) throw new ExtensionError('too_many_files', String(out.length));
  return out;
}

// Encabezados locales: que coincidan con el directorio central y que ninguna entrada se solape con otra.
function locateData(buf, entries) {
  const ranges = [];
  for (const e of entries) {
    if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== SIG_LOCAL) throw new ExtensionError('bad_zip', e.rel);
    const flags = buf.readUInt16LE(e.offset + 6);
    const method = buf.readUInt16LE(e.offset + 8);
    const nameLen = buf.readUInt16LE(e.offset + 26);
    const extraLen = buf.readUInt16LE(e.offset + 28);
    const start = e.offset + 30 + nameLen + extraLen;
    const end = start + e.compressedSize;
    if (end > buf.length) throw new ExtensionError('bad_zip', e.rel);
    if (flags & 0x1 || method !== e.method) throw new ExtensionError('bad_zip', e.rel);
    if (!buf.subarray(e.offset + 30, e.offset + 30 + nameLen).equals(e.nameBuf)) throw new ExtensionError('bad_zip', e.rel);
    e.start = start;
    e.end = end;
    ranges.push(e);
  }
  ranges.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].offset < ranges[i - 1].end) throw new ExtensionError('zip_bomb', ranges[i].rel);
}

function inflate(buf, e) {
  const raw = buf.subarray(e.start, e.end);
  let data;
  if (e.method === 0) data = Buffer.from(raw);
  else {
    try {
      // maxOutputLength corta el inflado aunque el tamaño declarado sea mentira
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
    } catch {
      throw new ExtensionError('zip_bomb', e.rel);
    }
  }
  if (data.length !== e.size) throw new ExtensionError('zip_bomb', e.rel);
  if (typeof zlib.crc32 === 'function' && zlib.crc32(data) >>> 0 !== e.crc >>> 0) throw new ExtensionError('bad_zip', e.rel);
  return data;
}

function hasSignature(ext, d) {
  const head = (...bytes) => bytes.every((b, i) => d[i] === b);
  if (ext === '.png') return head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (ext === '.jpg' || ext === '.jpeg') return head(0xff, 0xd8, 0xff);
  if (ext === '.gif') return head(0x47, 0x49, 0x46, 0x38);
  if (ext === '.webp') return head(0x52, 0x49, 0x46, 0x46) && d.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

// Una imagen tiene que ser esa imagen, y un texto tiene que ser texto: así nada binario viaja disfrazado.
function checkContent(rel, data) {
  const ext = path.posix.extname(rel).toLowerCase();
  if (IMAGE_TYPES[ext]) {
    if (!hasSignature(ext, data)) throw new ExtensionError('bad_file_content', rel);
    return;
  }
  if (data.includes(0)) throw new ExtensionError('bad_file_content', rel);
  let text;
  try {
    text = decoder.decode(data);
  } catch {
    throw new ExtensionError('bad_file_content', rel);
  }
  if (ext === '.html' && FRAME_TAG.test(text)) throw new ExtensionError('bad_file_content', rel);
}

function readPackage(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new ExtensionError('bad_zip', 'buffer');
  if (buffer.length > MAX_PACKAGE) throw new ExtensionError('package_too_large', 'package');
  const entries = checkEntries(readEntries(buffer));
  locateData(buffer, entries);
  const manifestEntry = entries.find((e) => e.rel === MANIFEST);
  if (!manifestEntry) throw new ExtensionError('bad_manifest', MANIFEST);
  const manifest = validateManifest(inflate(buffer, manifestEntry));
  const files = [];
  let total = 0;
  for (const e of entries) {
    if (e === manifestEntry) continue;
    const data = inflate(buffer, e);
    total += data.length;
    if (total > MAX_TOTAL) throw new ExtensionError('package_too_large', 'total');
    checkContent(e.rel, data);
    files.push({ path: e.rel, size: data.length, data });
  }
  for (const page of [manifest.entry, manifest.homeCard]) {
    if (page && !files.some((f) => f.path === page)) throw new ExtensionError('bad_manifest', page);
  }
  return { manifest, files, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), size: buffer.length };
}

// Escribe los archivos en una carpeta temporal vecina y la pone en su lugar de una sola vez: nunca queda a medias.
async function writePackage(pkg, destDir) {
  const tmp = `${destDir}.new-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  try {
    for (const f of pkg.files) {
      const full = safety.resolveInside(tmp, f.path, { instance: false, maxLength: MAX_PATH, maxDepth: MAX_DEPTH });
      if (!full) throw new ExtensionError('bad_path', f.path);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, f.data, { flag: 'wx' });
    }
    await fsp.writeFile(path.join(tmp, MANIFEST), JSON.stringify(pkg.manifest, null, 2), { flag: 'wx' });
    await fsp.rm(destDir, { recursive: true, force: true });
    await fsp.rename(tmp, destDir);
  } catch (err) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

module.exports = {
  readPackage,
  writePackage,
  readEntries,
  contentTypeOf,
  LIMITS: Object.freeze({ MAX_PACKAGE, MAX_TOTAL, MAX_FILE, MAX_FILES, MAX_RATIO, MAX_DEPTH, MAX_PATH }),
};
