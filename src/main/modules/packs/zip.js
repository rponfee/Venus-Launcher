'use strict';
// ZIP propio del modulo packs (lectura y escritura por streaming, con ZIP64 en el indice):
// no carga los archivos enteros en memoria, asi que sirve para packs con mundos de varios GB.
//  - Lectura: directorio central + entradas guardadas (0) o comprimidas (8), con verificacion de CRC.
//  - Escritura: archivos chicos con tamanios exactos en el encabezado (maxima compatibilidad) y
//    archivos grandes por streaming con descriptor de datos.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { once } = require('events');
const { finished } = require('stream/promises');
const { replaceFile } = require('./safety');

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const IN_MEMORY = 32 * 1024 * 1024;
const MAX_ENTRY = 0xff000000; // un solo archivo de mas de ~4 GB no se puede escribir
// Formatos que ya vienen comprimidos: se guardan tal cual.
const STORED_EXT = new Set(['.zip', '.jar', '.png', '.jpg', '.jpeg', '.gz', '.ogg', '.mp3', '.7z', '.rar', '.mrpack', '.mca', '.mcr', '.webp']);

// CRC32 (zlib.crc32 existe desde Node 22; respaldo por las dudas)
let crcTable = null;
function crc32(buf, prev = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, prev);
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = (prev ^ MAX32) >>> 0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ MAX32) >>> 0;
}

function badZip(msg = 'invalid zip') {
  return Object.assign(new Error(msg), { code: 'BAD_ZIP' });
}

function dosToMs(date, time) {
  if (!date) return 0;
  const d = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, pos + off);
    if (!bytesRead) break;
    off += bytesRead;
  }
  if (off < len) throw badZip('truncated zip');
  return buf;
}

// ---------- Lectura ----------

async function openZip(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw badZip();
    const tailLen = Math.min(size, 22 + 65535);
    const tailPos = size - tailLen;
    const tail = await readAt(fh, tailPos, tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw badZip();
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
      const locPos = tailPos + eocd - 20;
      if (locPos >= 0) {
        const loc = await readAt(fh, locPos, 20);
        if (loc.readUInt32LE(0) === 0x07064b50) {
          const z = await readAt(fh, Number(loc.readBigUInt64LE(8)), 56);
          if (z.readUInt32LE(0) === 0x06064b50) {
            count = Number(z.readBigUInt64LE(32));
            cdSize = Number(z.readBigUInt64LE(40));
            cdOffset = Number(z.readBigUInt64LE(48));
          }
        }
      }
    }
    if (cdOffset + cdSize > size || cdSize > 512 * 1024 * 1024) throw badZip();
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const time = cd.readUInt16LE(p + 12);
      const date = cd.readUInt16LE(p + 14);
      const crc = cd.readUInt32LE(p + 16);
      let compSize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      if (usize === MAX32 || compSize === MAX32 || localOffset === MAX32) {
        let q = 0;
        while (q + 4 <= extra.length) {
          const id = extra.readUInt16LE(q);
          const len = extra.readUInt16LE(q + 2);
          if (id === 1) {
            let r = q + 4;
            if (usize === MAX32 && r + 8 <= extra.length) {
              usize = Number(extra.readBigUInt64LE(r));
              r += 8;
            }
            if (compSize === MAX32 && r + 8 <= extra.length) {
              compSize = Number(extra.readBigUInt64LE(r));
              r += 8;
            }
            if (localOffset === MAX32 && r + 8 <= extra.length) localOffset = Number(extra.readBigUInt64LE(r));
            break;
          }
          q += 4 + len;
        }
      }
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
      entries.push({ name, method, flags, crc, compSize, size: usize, localOffset, isDir: name.endsWith('/'), mtime: dosToMs(date, time) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (!entries.length && count > 0) throw badZip();
    const byName = new Map(entries.map((e) => [e.name, e]));

    async function dataStart(e) {
      if (e._data !== undefined) return e._data;
      const lh = await readAt(fh, e.localOffset, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw badZip('bad local header');
      e._data = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      if (e._data + e.compSize > size) throw badZip('truncated entry');
      return e._data;
    }

    function check(e) {
      if (e.flags & 1) throw badZip('encrypted entries are not supported');
      if (e.method !== 0 && e.method !== 8) throw badZip(`unsupported compression ${e.method}`);
    }

    // Contenido completo de una entrada (para archivos chicos: indices, configuracion).
    async function read(e, { maxSize = 256 * 1024 * 1024 } = {}) {
      check(e);
      if (e.size > maxSize) throw badZip('entry too large');
      if (!e.compSize) return Buffer.alloc(0);
      const raw = await readAt(fh, await dataStart(e), e.compSize);
      const data = e.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) }) : raw;
      if (data.length !== e.size || crc32(data) !== e.crc) throw badZip(`corrupt entry ${e.name}`);
      return data;
    }

    async function readText(name) {
      const e = byName.get(name);
      return e ? (await read(e, { maxSize: 64 * 1024 * 1024 })).toString('utf8').replace(/^﻿/, '') : null;
    }

    // Extrae una entrada a un archivo (via temporal) y devuelve su sha1 y tamanio.
    async function extract(e, dest, { signal } = {}) {
      check(e);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
      const sha1 = crypto.createHash('sha1');
      let written = 0;
      let crc = 0;
      try {
        if (e.size <= IN_MEMORY) {
          const data = await read(e);
          sha1.update(data);
          written = data.length;
          await fsp.writeFile(tmp, data);
        } else {
          const start = await dataStart(e);
          const src = fs.createReadStream(file, { start, end: start + e.compSize - 1 });
          const stream = e.method === 8 ? src.pipe(zlib.createInflateRaw()) : src;
          src.on('error', (err) => stream.destroy(err));
          const out = fs.createWriteStream(tmp);
          try {
            for await (const chunk of stream) {
              if (signal?.aborted) throw signal.reason || new Error('aborted');
              written += chunk.length;
              if (written > e.size) throw badZip(`corrupt entry ${e.name}`);
              crc = crc32(chunk, crc);
              sha1.update(chunk);
              if (!out.write(chunk)) await once(out, 'drain');
            }
            out.end();
            await finished(out);
          } catch (err) {
            out.destroy();
            src.destroy();
            throw err;
          }
          if (written !== e.size || crc !== e.crc) throw badZip(`corrupt entry ${e.name}`);
        }
        // Renombrar encima (nunca escribir sobre dest): si es un enlace duro, las otras copias no cambian.
        await replaceFile(tmp, dest);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      if (e.mtime) await fsp.utimes(dest, new Date(), new Date(e.mtime)).catch(() => {});
      return { sha1: sha1.digest('hex'), size: written };
    }

    // sha1 del contenido sin escribirlo a disco.
    async function hash(e) {
      check(e);
      if (e.size <= IN_MEMORY) return crypto.createHash('sha1').update(await read(e)).digest('hex');
      const start = await dataStart(e);
      const src = fs.createReadStream(file, { start, end: start + e.compSize - 1 });
      const stream = e.method === 8 ? src.pipe(zlib.createInflateRaw()) : src;
      src.on('error', (err) => stream.destroy(err));
      const h = crypto.createHash('sha1');
      for await (const chunk of stream) h.update(chunk);
      return h.digest('hex');
    }

    return { file, size, entries, get: (n) => byName.get(n) || null, read, readText, extract, hash, close: () => fh.close() };
  } catch (err) {
    await fh.close().catch(() => {});
    if (err.code === 'BAD_ZIP' || err instanceof RangeError) throw err.code ? err : badZip();
    throw err;
  }
}

// ---------- Escritura ----------

class ZipWriter {
  constructor(file) {
    this.file = file;
    this.out = fs.createWriteStream(file);
    this.offset = 0;
    this.entries = [];
    this.names = new Set();
    this.failed = null;
    this.out.on('error', (err) => {
      this.failed = err;
    });
  }

  async write(buf) {
    if (this.failed) throw this.failed;
    if (!this.out.write(buf)) await once(this.out, 'drain');
    if (this.failed) throw this.failed;
    this.offset += buf.length;
  }

  uniqueName(name) {
    const clean = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || clean.split('/').some((p) => p === '..' || p === '.')) throw badZip(`bad entry name ${name}`);
    if (this.names.has(clean)) throw badZip(`duplicate entry ${clean}`);
    this.names.add(clean);
    return Buffer.from(clean, 'utf8');
  }

  localHeader(nameBuf, { flags, method, time, date, crc, compSize, size }) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(flags, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc >>> 0, 14);
    h.writeUInt32LE(compSize, 18);
    h.writeUInt32LE(size, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    return Buffer.concat([h, nameBuf]);
  }

  async addBuffer(name, data, { mtime, store } = {}) {
    const nameBuf = this.uniqueName(name);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const crc = crc32(buf);
    let method = 0;
    let comp = buf;
    const ext = path.extname(String(name)).toLowerCase();
    if (!store && buf.length > 64 && !STORED_EXT.has(ext)) {
      const deflated = zlib.deflateRawSync(buf, { level: 6 });
      if (deflated.length < buf.length) {
        method = 8;
        comp = deflated;
      }
    }
    const { time, date } = dosDateTime(mtime);
    const flags = 0x0800; // nombres en UTF-8
    const offset = this.offset;
    await this.write(this.localHeader(nameBuf, { flags, method, time, date, crc, compSize: comp.length, size: buf.length }));
    await this.write(comp);
    this.entries.push({ nameBuf, flags, method, time, date, crc, compSize: comp.length, size: buf.length, offset });
  }

  async addFile(name, abs, { signal } = {}) {
    const st = await fsp.stat(abs);
    if (st.size <= IN_MEMORY) return this.addBuffer(name, await fsp.readFile(abs), { mtime: st.mtimeMs });
    if (st.size >= MAX_ENTRY) throw Object.assign(new Error(`file too large: ${name}`), { code: 'TOO_LARGE', file: name });
    const nameBuf = this.uniqueName(name);
    const { time, date } = dosDateTime(st.mtimeMs);
    const flags = 0x0808; // UTF-8 + descriptor de datos
    const offset = this.offset;
    await this.write(this.localHeader(nameBuf, { flags, method: 8, time, date, crc: 0, compSize: 0, size: 0 }));
    const src = fs.createReadStream(abs);
    const deflate = zlib.createDeflateRaw({ level: 6 });
    let crc = 0;
    let size = 0;
    let compSize = 0;
    src.on('data', (c) => {
      crc = crc32(c, crc);
      size += c.length;
    });
    src.on('error', (err) => deflate.destroy(err));
    src.pipe(deflate);
    for await (const chunk of deflate) {
      if (signal?.aborted) {
        src.destroy();
        throw signal.reason || new Error('aborted');
      }
      compSize += chunk.length;
      await this.write(chunk);
    }
    if (compSize >= MAX32 || size >= MAX32) throw Object.assign(new Error(`file too large: ${name}`), { code: 'TOO_LARGE', file: name });
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc >>> 0, 4);
    dd.writeUInt32LE(compSize, 8);
    dd.writeUInt32LE(size, 12);
    await this.write(dd);
    this.entries.push({ nameBuf, flags, method: 8, time, date, crc, compSize, size, offset });
  }

  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const big = e.offset >= MAX32;
      const extra = big ? Buffer.alloc(12) : Buffer.alloc(0);
      if (big) {
        extra.writeUInt16LE(1, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(e.offset), 4);
      }
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(big ? 45 : 20, 4);
      h.writeUInt16LE(big ? 45 : 20, 6);
      h.writeUInt16LE(e.flags, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc >>> 0, 16);
      h.writeUInt32LE(e.compSize, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt16LE(0, 32);
      h.writeUInt16LE(0, 34);
      h.writeUInt16LE(0, 36);
      h.writeUInt32LE(0, 38);
      h.writeUInt32LE(big ? MAX32 : e.offset, 42);
      await this.write(Buffer.concat([h, e.nameBuf, extra]));
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    if (count >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32) {
      const z64At = this.offset;
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
      loc.writeBigUInt64LE(BigInt(z64At), 8);
      loc.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([z, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(count, MAX16), 8);
    end.writeUInt16LE(Math.min(count, MAX16), 10);
    end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
    end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
    await this.write(end);
    this.out.end();
    await finished(this.out);
    return { size: this.offset, entries: count };
  }

  async abort() {
    this.out.destroy();
    await fsp.rm(this.file, { force: true }).catch(() => {});
  }
}

module.exports = { openZip, ZipWriter, crc32 };
