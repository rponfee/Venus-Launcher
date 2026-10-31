'use strict';
// ZIP por streaming para las copias de seguridad de mundos: no carga archivos en memoria (sirve para
// mundos de varios GB), soporta ZIP64 (archivos de mas de 4 GB o mas de 65535 entradas) y nombres UTF-8.
//   zipDirectory(dir, destZip, { root, exclude, signal, onProgress }) -> { files, bytes, size, skipped }
//   readEntries(zipFile) -> [{ name, method, crc, compressedSize, size, offset, dir, mtime }]
//   extract(zipFile, destDir, { prefix, signal, onProgress }) -> { files, bytes }
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const { Transform, Writable } = require('stream');
const safety = require('../packs/safety');

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const SMALL = 1024 * 1024; // hasta 1 MB se lee el archivo entero antes de escribirlo
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);
// Ya vienen comprimidos: se guardan tal cual
const STORED = new Set(['.zip', '.jar', '.png', '.jpg', '.jpeg', '.gz', '.ogg', '.mp3', '.mp4', '.webm', '.7z', '.rar', '.webp']);

// CRC32 (zlib.crc32 desde Node 22.2; tabla propia como respaldo)
let CRC_TABLE = null;
function crc32(buf, prev = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, prev);
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = (prev ^ MAX32) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ MAX32) >>> 0;
}

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & MAX16,
    date: (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & MAX16,
  };
}

function fromDos(date, time) {
  const y = ((date >> 9) & 0x7f) + 1980;
  const mo = ((date >> 5) & 0x0f) - 1;
  const d = date & 0x1f;
  const h = (time >> 11) & 0x1f;
  const mi = (time >> 5) & 0x3f;
  const s = (time & 0x1f) * 2;
  const ts = new Date(y, mo, d || 1, h, mi, s).getTime();
  return Number.isFinite(ts) ? ts : Date.now();
}

const abortError = (signal) => signal?.reason || Object.assign(new Error('aborted'), { name: 'AbortError' });

// Archivos de una carpeta (recursivo, sin enlaces simbolicos) -> [{ abs, rel, size, mtime }]
async function walk(dir, { exclude, signal } = {}, rel = '', out = []) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (signal?.aborted) throw abortError(signal);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (exclude && exclude(r, e.isDirectory())) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, { exclude, signal }, r, out);
    else if (e.isFile()) {
      const st = await fsp.stat(abs).catch(() => null);
      if (st) out.push({ abs, rel: r, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

// Escritor con contrapresion que cuenta los bytes escritos.
function output(file) {
  const ws = fs.createWriteStream(file);
  let offset = 0;
  let failed = null;
  ws.on('error', (err) => {
    failed = err;
  });
  return {
    get offset() {
      return offset;
    },
    async write(buf) {
      if (failed) throw failed;
      offset += buf.length;
      if (ws.write(buf)) return;
      await new Promise((resolve, reject) => {
        const onDrain = () => {
          ws.off('error', onError);
          resolve();
        };
        const onError = (err) => {
          ws.off('drain', onDrain);
          reject(err);
        };
        ws.once('drain', onDrain);
        ws.once('error', onError);
      });
    },
    async close() {
      if (failed) throw failed;
      ws.end();
      await once(ws, 'finish');
    },
    destroy() {
      ws.destroy();
    },
  };
}

/**
 * Comprime una carpeta en un ZIP. root: nombre de la carpeta raiz dentro del ZIP (por ejemplo el
 * nombre del mundo). exclude(rel, isDir) -> true para omitir. Los archivos bloqueados (el juego los
 * tiene abiertos) se omiten y se cuentan en `skipped`.
 */
async function zipDirectory(dir, destZip, { root = '', exclude, signal, onProgress, level = 4 } = {}) {
  const files = await walk(dir, { exclude, signal });
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  await fsp.mkdir(path.dirname(destZip), { recursive: true });
  const tmp = `${destZip}.part`;
  const out = output(tmp);
  const central = [];
  let bytes = 0;
  let skipped = 0;
  let lastReport = 0;
  const report = (force) => {
    const now = Date.now();
    if (!onProgress || (!force && now - lastReport < 200)) return;
    lastReport = now;
    onProgress({ bytes, totalBytes, files: central.length, totalFiles: files.length });
  };
  const prefix = root ? `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/` : '';
  try {
    if (prefix) {
      // Entrada de la carpeta raiz (algunos programas la necesitan para mostrar la estructura)
      const name = Buffer.from(prefix, 'utf8');
      const { time, date } = dosDateTime(Date.now());
      const offset = out.offset;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0x0800, 6);
      lh.writeUInt16LE(0, 8);
      lh.writeUInt16LE(time, 10);
      lh.writeUInt16LE(date, 12);
      lh.writeUInt16LE(name.length, 26);
      await out.write(lh);
      await out.write(name);
      central.push({ name, method: 0, time, date, crc: 0, csize: 0, size: 0, offset, dir: true, zip64: false });
    }
    for (const f of files) {
      if (signal?.aborted) throw abortError(signal);
      const name = Buffer.from(prefix + f.rel, 'utf8');
      const stored = STORED.has(path.extname(f.rel).toLowerCase()) || f.size === 0;
      const { time, date } = dosDateTime(f.mtime);
      const offset = out.offset;
      if (f.size <= SMALL) {
        // Archivos chicos: se leen enteros primero, asi uno bloqueado por el juego se puede omitir
        let data;
        try {
          data = await fsp.readFile(f.abs);
        } catch (err) {
          if (LOCKED.has(err.code)) {
            skipped++;
            continue;
          }
          throw err;
        }
        const crc = crc32(data) >>> 0;
        const body = stored ? data : await deflateRaw(data, { level });
        const method = stored || body.length >= data.length ? 0 : 8;
        const payload = method === 8 ? body : data;
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(0x0800, 6); // UTF-8
        lh.writeUInt16LE(method, 8);
        lh.writeUInt16LE(time, 10);
        lh.writeUInt16LE(date, 12);
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(payload.length, 18);
        lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(name.length, 26);
        lh.writeUInt16LE(0, 28);
        await out.write(lh);
        await out.write(name);
        await out.write(payload);
        bytes += data.length;
        report(false);
        central.push({ name, method, time, date, crc, csize: payload.length, size: data.length, offset, dir: false, zip64: false, descriptor: false });
        continue;
      }
      let fd = null;
      try {
        fd = await fsp.open(f.abs, 'r');
      } catch (err) {
        if (LOCKED.has(err.code) || err.code === 'ENOENT') {
          skipped++;
          continue;
        }
        throw err;
      }
      try {
        const method = stored ? 0 : 8;
        const zip64 = f.size >= MAX32 - 1024 * 1024; // un archivo enorme: tamanios de 8 bytes
        const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
        if (zip64) {
          extra.writeUInt16LE(0x0001, 0);
          extra.writeUInt16LE(16, 2); // tamanios en 0: van en el descriptor de datos
        }
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(zip64 ? 45 : 20, 4);
        lh.writeUInt16LE(0x0008 | 0x0800, 6); // descriptor de datos + UTF-8
        lh.writeUInt16LE(method, 8);
        lh.writeUInt16LE(time, 10);
        lh.writeUInt16LE(date, 12);
        lh.writeUInt32LE(0, 14);
        lh.writeUInt32LE(zip64 ? MAX32 : 0, 18);
        lh.writeUInt32LE(zip64 ? MAX32 : 0, 22);
        lh.writeUInt16LE(name.length, 26);
        lh.writeUInt16LE(extra.length, 28);
        await out.write(lh);
        await out.write(name);
        if (extra.length) await out.write(extra);
        let crc = 0;
        let size = 0;
        let csize = 0;
        const src = fd.createReadStream({ highWaterMark: 256 * 1024, autoClose: false });
        const counter = new Transform({
          transform(chunk, enc, cb) {
            crc = crc32(chunk, crc);
            size += chunk.length;
            bytes += chunk.length;
            report(false);
            cb(null, chunk);
          },
        });
        const sink = new Writable({
          write(chunk, enc, cb) {
            csize += chunk.length;
            out.write(chunk).then(() => cb(), cb);
          },
        });
        const stages = method === 8 ? [src, counter, zlib.createDeflateRaw({ level }), sink] : [src, counter, sink];
        await pipeline(...stages, { signal });
        const dd = Buffer.alloc(zip64 ? 24 : 16);
        dd.writeUInt32LE(0x08074b50, 0);
        dd.writeUInt32LE(crc >>> 0, 4);
        if (zip64) {
          dd.writeBigUInt64LE(BigInt(csize), 8);
          dd.writeBigUInt64LE(BigInt(size), 16);
        } else {
          dd.writeUInt32LE(csize, 8);
          dd.writeUInt32LE(size, 12);
        }
        await out.write(dd);
        central.push({ name, method, time, date, crc: crc >>> 0, csize, size, offset, dir: false, zip64, descriptor: true });
      } finally {
        await fd.close().catch(() => {});
      }
    }
    // Directorio central
    const cdStart = out.offset;
    for (const e of central) {
      const needs64 = e.zip64 || e.offset >= MAX32 || e.size >= MAX32 || e.csize >= MAX32;
      const fields = [];
      if (needs64) {
        if (e.size >= MAX32 || e.zip64) fields.push(BigInt(e.size));
        if (e.csize >= MAX32 || e.zip64) fields.push(BigInt(e.csize));
        if (e.offset >= MAX32) fields.push(BigInt(e.offset));
      }
      const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
      if (fields.length) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(fields.length * 8, 2);
        fields.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + i * 8));
      }
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE((3 << 8) | (needs64 ? 45 : 20), 4); // creado en "Unix" para respetar permisos simples
      ch.writeUInt16LE(needs64 ? 45 : 20, 6);
      ch.writeUInt16LE(e.descriptor ? 0x0008 | 0x0800 : 0x0800, 8);
      ch.writeUInt16LE(e.method, 10);
      ch.writeUInt16LE(e.time, 12);
      ch.writeUInt16LE(e.date, 14);
      ch.writeUInt32LE(e.crc, 16);
      ch.writeUInt32LE(needs64 && (e.csize >= MAX32 || e.zip64) ? MAX32 : e.csize, 20);
      ch.writeUInt32LE(needs64 && (e.size >= MAX32 || e.zip64) ? MAX32 : e.size, 24);
      ch.writeUInt16LE(e.name.length, 28);
      ch.writeUInt16LE(extra.length, 30);
      ch.writeUInt16LE(0, 32);
      ch.writeUInt16LE(0, 34);
      ch.writeUInt16LE(0, 36);
      ch.writeUInt32LE(e.dir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
      ch.writeUInt32LE(e.offset >= MAX32 ? MAX32 : e.offset, 42);
      await out.write(ch);
      await out.write(e.name);
      if (extra.length) await out.write(extra);
    }
    const cdEnd = out.offset;
    const cdSize = cdEnd - cdStart;
    const count = central.length;
    const need64 = count >= MAX16 || cdSize >= MAX32 || cdStart >= MAX32;
    if (need64) {
      const z = Buffer.alloc(56);
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE(45, 12);
      z.writeUInt16LE(45, 14);
      z.writeUInt32LE(0, 16);
      z.writeUInt32LE(0, 20);
      z.writeBigUInt64LE(BigInt(count), 24);
      z.writeBigUInt64LE(BigInt(count), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(cdEnd), 8);
      loc.writeUInt32LE(1, 16);
      await out.write(z);
      await out.write(loc);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(Math.min(count, MAX16), 8);
    eocd.writeUInt16LE(Math.min(count, MAX16), 10);
    eocd.writeUInt32LE(Math.min(cdSize, MAX32), 12);
    eocd.writeUInt32LE(Math.min(cdStart, MAX32), 16);
    eocd.writeUInt16LE(0, 20);
    await out.write(eocd);
    await out.close();
    report(true);
    await fsp.rename(tmp, destZip);
    const st = await fsp.stat(destZip);
    return { files: central.filter((e) => !e.dir).length, bytes, size: st.size, skipped };
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// ---------- Lectura ----------

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return bytesRead === len ? buf : buf.subarray(0, bytesRead);
}

function badZip() {
  return Object.assign(new Error('ZIP inválido'), { code: 'EBADZIP' });
}

// Entradas del directorio central
async function readEntries(zipFile) {
  const fh = await fsp.open(zipFile, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw badZip();
    const tailLen = Math.min(size, 22 + 65535);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eo = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eo = i;
        break;
      }
    }
    if (eo < 0) throw badZip();
    let count = tail.readUInt16LE(eo + 10);
    let cdSize = tail.readUInt32LE(eo + 12);
    let cdStart = tail.readUInt32LE(eo + 16);
    if (count === MAX16 || cdSize === MAX32 || cdStart === MAX32) {
      // ZIP64: el localizador esta justo antes del fin del directorio
      const locPos = size - tailLen + eo - 20;
      if (locPos < 0) throw badZip();
      const loc = await readAt(fh, locPos, 20);
      if (loc.readUInt32LE(0) !== 0x07064b50) throw badZip();
      const z64Pos = Number(loc.readBigUInt64LE(8));
      const z = await readAt(fh, z64Pos, 56);
      if (z.readUInt32LE(0) !== 0x06064b50) throw badZip();
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdStart = Number(z.readBigUInt64LE(48));
    }
    if (cdStart + cdSize > size) throw badZip();
    const cd = await readAt(fh, cdStart, cdSize);
    const out = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw badZip();
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const time = cd.readUInt16LE(p + 12);
      const date = cd.readUInt16LE(p + 14);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nLen = cd.readUInt16LE(p + 28);
      const xLen = cd.readUInt16LE(p + 30);
      const cLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nLen);
      const name = (flags & 0x0800 ? nameBuf.toString('utf8') : nameBuf.toString('latin1')).replace(/\\/g, '/');
      const extra = cd.subarray(p + 46 + nLen, p + 46 + nLen + xLen);
      let x = 0;
      while (x + 4 <= extra.length) {
        const id = extra.readUInt16LE(x);
        const len = extra.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === MAX32 && q + 8 <= x + 4 + len) {
            usize = Number(extra.readBigUInt64LE(q));
            q += 8;
          }
          if (csize === MAX32 && q + 8 <= x + 4 + len) {
            csize = Number(extra.readBigUInt64LE(q));
            q += 8;
          }
          if (offset === MAX32 && q + 8 <= x + 4 + len) offset = Number(extra.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      out.push({ name, method, crc, compressedSize: csize, size: usize, offset, dir: name.endsWith('/'), encrypted: Boolean(flags & 1), mtime: fromDos(date, time) });
      p += 46 + nLen + xLen + cLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

// Ruta segura dentro de destDir (evita "zip slip": rutas absolutas o con ".."). Los segmentos vacios y '.'
// se ignoran como siempre; el resto pasa por las reglas compartidas de packs/safety (unidades, nombres de
// dispositivo como CON o NUL, nombres que Windows recorta).
function safeJoin(destDir, rel) {
  const clean = String(rel).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (!clean.length || clean.some((s) => s === '..' || /[\x00-\x1f<>:"|?*]/.test(s))) return null;
  return safety.resolveInside(destDir, clean.join('/'), { instance: false });
}

/**
 * Extrae las entradas que empiezan con `prefix` (sin el prefijo) en destDir.
 */
async function extract(zipFile, destDir, { prefix = '', signal, onProgress, entries } = {}) {
  const list = (entries || (await readEntries(zipFile))).filter((e) => e.name.startsWith(prefix) && e.name.length > prefix.length);
  const totalBytes = list.reduce((a, e) => a + (e.dir ? 0 : e.size), 0);
  let bytes = 0;
  let files = 0;
  let lastReport = 0;
  await fsp.mkdir(destDir, { recursive: true });
  const fh = await fsp.open(zipFile, 'r');
  try {
    for (const e of list) {
      if (signal?.aborted) throw abortError(signal);
      if (e.encrypted) throw badZip();
      const target = safeJoin(destDir, e.name.slice(prefix.length));
      if (!target) continue;
      if (e.dir) {
        await fsp.mkdir(target, { recursive: true });
        continue;
      }
      const lh = await readAt(fh, e.offset, 30);
      if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw badZip();
      const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      let crc = 0;
      let size = 0;
      const check = new Transform({
        transform(chunk, enc, cb) {
          crc = crc32(chunk, crc);
          size += chunk.length;
          bytes += chunk.length;
          if (size > e.size) return cb(badZip()); // mas datos que los declarados: archivo danado o malicioso
          const now = Date.now();
          if (onProgress && now - lastReport > 200) {
            lastReport = now;
            onProgress({ bytes, totalBytes, files, totalFiles: list.length });
          }
          cb(null, chunk);
        },
      });
      if (e.method !== 0 && e.method !== 8) throw badZip();
      if (e.compressedSize === 0) {
        await fsp.writeFile(target, Buffer.alloc(0));
      } else if (e.compressedSize <= SMALL && e.size <= 16 * SMALL) {
        // Entradas chicas: se leen de una vez con el mismo descriptor
        const raw = await readAt(fh, start, e.compressedSize);
        if (raw.length !== e.compressedSize) throw badZip();
        const data = e.method === 8 ? await inflateRaw(raw) : raw;
        crc = crc32(data);
        size = data.length;
        bytes += data.length;
        await fsp.writeFile(target, data);
      } else {
        const src = fs.createReadStream(zipFile, { start, end: start + e.compressedSize - 1, highWaterMark: 256 * 1024 });
        const stages = e.method === 8 ? [src, zlib.createInflateRaw(), check, fs.createWriteStream(target)] : [src, check, fs.createWriteStream(target)];
        await pipeline(...stages, { signal });
      }
      if (size !== e.size || (e.size > 0 && (crc >>> 0) !== (e.crc >>> 0))) throw badZip();
      await fsp.utimes(target, new Date(e.mtime), new Date(e.mtime)).catch(() => {});
      files++;
    }
    onProgress?.({ bytes, totalBytes, files, totalFiles: list.length });
    return { files, bytes };
  } finally {
    await fh.close();
  }
}

// Prefijo de la carpeta del mundo dentro del ZIP: la del level.dat menos profundo ('' si esta en la raiz)
function worldPrefix(entries) {
  const levels = entries.filter((e) => !e.dir && /(^|\/)level\.dat$/.test(e.name)).sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  if (!levels.length) return null;
  return levels[0].name.slice(0, -'level.dat'.length);
}

module.exports = { zipDirectory, readEntries, extract, worldPrefix, crc32, walk, safeJoin };
