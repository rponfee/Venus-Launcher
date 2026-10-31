'use strict';
// ZIP por streaming para mundos grandes: se escribe y se lee archivo por archivo (nunca el mundo entero en
// memoria, como haria adm-zip). Formato ZIP estandar (deflate + descriptor de datos, nombres en UTF-8),
// compatible con adm-zip y con cualquier descompresor. Sin ZIP64: hasta 65.535 archivos y ~4 GB.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { Writable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const safety = require('../packs/safety');

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

const SIG_LOCAL = 0x04034b50;
const SIG_DESC = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const FLAG_DESC = 0x0008;
const FLAG_UTF8 = 0x0800;
const LIMIT_32 = 0xffffffff;
const MAX_ENTRIES = 65535;
const SMALL = 1024 * 1024; // hasta 1 MB se comprime de una vez
// Formatos ya comprimidos: se guardan sin volver a comprimir.
const STORE_EXT = /\.(png|jpe?g|webp|gif|zip|jar|gz|xz|bz2|7z|ogg|mp3|mp4)$/i;

class ZipError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const crc32 = (buf, prev = 0) => zlib.crc32(buf, prev) >>> 0;

function dosDateTime(ms) {
  const d = new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now());
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  };
}

/**
 * Escritor: sink.write(buffer) -> Promise (por ejemplo, PartSink que corta en partes de 45 MB).
 *   const zw = new ZipWriter(sink); await zw.addFile('region/r.0.0.mca', ruta); await zw.finish();
 */
class ZipWriter {
  constructor(sink, { level = 6 } = {}) {
    this.sink = sink;
    this.level = level;
    this.offset = 0;
    this.entries = [];
    this.bytesIn = 0;
  }

  async _out(buf) {
    if (!buf.length) return;
    await this.sink.write(buf);
    this.offset += buf.length;
    if (this.offset > LIMIT_32) throw new ZipError('too_big');
  }

  _local(nameBuf, method, dt) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(SIG_LOCAL, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(FLAG_DESC | FLAG_UTF8, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(dt.time, 10);
    h.writeUInt16LE(dt.date, 12);
    // crc y tamaños van en el descriptor de datos (bit 3)
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    return Buffer.concat([h, nameBuf]);
  }

  _descriptor(crc, comp, size) {
    const d = Buffer.alloc(16);
    d.writeUInt32LE(SIG_DESC, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    d.writeUInt32LE(comp, 8);
    d.writeUInt32LE(size, 12);
    return d;
  }

  _begin(name, mtime, method) {
    if (this.entries.length >= MAX_ENTRIES) throw new ZipError('too_many');
    const nameBuf = Buffer.from(String(name).replace(/\\/g, '/'), 'utf8');
    if (!nameBuf.length || nameBuf.length > 0xffff) throw new ZipError('bad_name');
    return { nameBuf, method, dt: dosDateTime(mtime), offset: this.offset, crc: 0, comp: 0, size: 0 };
  }

  async _end(e) {
    if (e.comp > LIMIT_32 || e.size > LIMIT_32) throw new ZipError('too_big');
    await this._out(this._descriptor(e.crc, e.comp, e.size));
    this.entries.push(e);
  }

  async addBuffer(name, data, { mtime } = {}) {
    const store = STORE_EXT.test(name) || data.length < 64;
    const e = this._begin(name, mtime, store ? 0 : 8);
    await this._out(this._local(e.nameBuf, e.method, e.dt));
    const out = store ? data : await deflateRaw(data, { level: this.level });
    e.crc = crc32(data);
    e.size = data.length;
    e.comp = out.length;
    await this._out(out);
    this.bytesIn += data.length;
    await this._end(e);
  }

  async addFile(name, absPath, { mtime, signal, onBytes } = {}) {
    const st = await fsp.stat(absPath);
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    if (st.size <= SMALL) {
      const data = await fsp.readFile(absPath);
      await this.addBuffer(name, data, { mtime: mtime ?? st.mtimeMs });
      onBytes?.(data.length);
      return;
    }
    const store = STORE_EXT.test(name);
    const e = this._begin(name, mtime ?? st.mtimeMs, store ? 0 : 8);
    await this._out(this._local(e.nameBuf, e.method, e.dt));
    const self = this;
    const tap = new Transform({
      transform(chunk, enc, cb) {
        e.crc = crc32(chunk, e.crc);
        e.size += chunk.length;
        onBytes?.(chunk.length);
        cb(null, chunk);
      },
    });
    const sinkStream = new Writable({
      write(chunk, enc, cb) {
        e.comp += chunk.length;
        self._out(chunk).then(() => cb(), cb);
      },
    });
    const stages = [fs.createReadStream(absPath, { highWaterMark: 1024 * 1024 }), tap];
    if (!store) stages.push(zlib.createDeflateRaw({ level: this.level }));
    stages.push(sinkStream);
    await pipeline(...stages, signal ? { signal } : {});
    this.bytesIn += e.size;
    await this._end(e);
  }

  async finish() {
    const cdStart = this.offset;
    const parts = [];
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(FLAG_DESC | FLAG_UTF8, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.dt.time, 12);
      h.writeUInt16LE(e.dt.date, 14);
      h.writeUInt32LE(e.crc >>> 0, 16);
      h.writeUInt32LE(e.comp, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt32LE(e.offset, 42);
      parts.push(h, e.nameBuf);
    }
    await this._out(Buffer.concat(parts));
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_END, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    await this._out(end);
    return { entries: this.entries.length, bytes: this.offset, bytesIn: this.bytesIn };
  }
}

// ---------- Lectura ----------

const BAD_SEGMENT = /[\x00-\x1f<>:"|?*]/;

// Nombre de entrada seguro -> segmentos (o null si intenta salir de la carpeta destino). Ademas de lo propio,
// las reglas compartidas de packs/safety (nombres de dispositivo como CON o NUL, espacios que Windows recorta).
function safeSegments(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.replace(/\/+$/, '').split('/');
  if (parts.length > 48) return null;
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || p.length > 255 || BAD_SEGMENT.test(p) || p.endsWith('.') || p.endsWith(' ')) return null;
    if (!safety.validSegment(p)) return null;
  }
  return parts;
}

async function readEntries(fh, size) {
  const tailLen = Math.min(size, 22 + 0xffff);
  if (tailLen < 22) throw new ZipError('bad_zip');
  const tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, size - tailLen);
  let i = tailLen - 22;
  while (i >= 0 && tail.readUInt32LE(i) !== SIG_END) i--;
  if (i < 0) throw new ZipError('bad_zip');
  const total = tail.readUInt16LE(i + 10);
  const cdSize = tail.readUInt32LE(i + 12);
  const cdOffset = tail.readUInt32LE(i + 16);
  if (cdOffset + cdSize > size) throw new ZipError('bad_zip');
  const cd = Buffer.alloc(cdSize);
  await fh.read(cd, 0, cdSize, cdOffset);
  const entries = [];
  let p = 0;
  for (let n = 0; n < total; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('bad_zip');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const comp = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const offset = cd.readUInt32LE(p + 42);
    const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
    const name = nameBuf.toString(flags & FLAG_UTF8 ? 'utf8' : 'utf8');
    entries.push({ name, flags, method, crc, comp, size: usize, offset, dir: name.endsWith('/') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Lista las entradas de un .zip: [{ name, size, comp, dir }] */
async function listZip(zipPath) {
  const fh = await fsp.open(zipPath, 'r');
  try {
    const st = await fh.stat();
    return (await readEntries(fh, st.size)).map(({ name, size, comp, dir }) => ({ name, size, comp, dir }));
  } finally {
    await fh.close();
  }
}

/**
 * Extrae un .zip en destDir validando cada ruta y el crc32 de cada archivo.
 * opts: { signal, onBytes(n), filter(segments) -> boolean, maxTotal }
 */
async function extractZip(zipPath, destDir, opts = {}) {
  const root = path.resolve(destDir);
  const fh = await fsp.open(zipPath, 'r');
  let written = 0;
  let files = 0;
  try {
    const st = await fh.stat();
    const entries = await readEntries(fh, st.size);
    const declared = entries.reduce((a, e) => a + (e.dir ? 0 : e.size), 0);
    if (declared > (opts.maxTotal || 8 * 1024 * 1024 * 1024)) throw new ZipError('too_big');
    await fsp.mkdir(root, { recursive: true });
    for (const e of entries) {
      if (opts.signal?.aborted) throw opts.signal.reason || new Error('aborted');
      const segs = safeSegments(e.name);
      if (!segs) throw new ZipError('bad_path', e.name);
      if (opts.filter && !opts.filter(segs, e)) continue;
      const out = path.resolve(root, ...segs);
      if (out !== root && !out.startsWith(root + path.sep)) throw new ZipError('bad_path', e.name);
      if (e.dir) {
        await fsp.mkdir(out, { recursive: true });
        continue;
      }
      if (e.method !== 0 && e.method !== 8) throw new ZipError('bad_method', e.name);
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, e.offset);
      if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError('bad_zip');
      const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      if (start + e.comp > st.size) throw new ZipError('bad_zip');
      await fsp.mkdir(path.dirname(out), { recursive: true });
      if (e.comp <= SMALL * 4) {
        const raw = Buffer.alloc(e.comp);
        if (e.comp) await fh.read(raw, 0, e.comp, start);
        const data = e.method === 8 ? await inflateRaw(raw, { maxOutputLength: Math.max(e.size, 1) }) : raw;
        if (data.length !== e.size || crc32(data) !== e.crc >>> 0) throw new ZipError('bad_crc', e.name);
        await fsp.writeFile(out, data);
        written += data.length;
        opts.onBytes?.(data.length);
      } else {
        let crc = 0;
        let size = 0;
        const tap = new Transform({
          transform(chunk, enc, cb) {
            crc = crc32(chunk, crc);
            size += chunk.length;
            if (size > e.size) return cb(new ZipError('bad_crc', e.name));
            opts.onBytes?.(chunk.length);
            return cb(null, chunk);
          },
        });
        const stages = [fs.createReadStream(zipPath, { start, end: start + e.comp - 1, highWaterMark: 1024 * 1024 })];
        if (e.method === 8) stages.push(zlib.createInflateRaw());
        stages.push(tap, fs.createWriteStream(out));
        await pipeline(...stages, opts.signal ? { signal: opts.signal } : {});
        if (size !== e.size || crc >>> 0 !== e.crc >>> 0) throw new ZipError('bad_crc', e.name);
        written += size;
      }
      files++;
    }
    return { files, bytes: written };
  } finally {
    await fh.close();
  }
}

module.exports = { ZipWriter, ZipError, extractZip, listZip, safeSegments, crc32 };
