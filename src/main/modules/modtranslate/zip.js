'use strict';
// Lector de ZIP/JAR liviano: lee solo el directorio central y las entradas que se piden.
// Los jars de mods pesan decenas de MB y solo necesitamos unos pocos KB de textos, asi que
// no conviene cargarlos enteros en memoria (como hace adm-zip).
const fsp = require('fs/promises');
const zlib = require('zlib');
const { promisify } = require('util');

const inflateRaw = promisify(zlib.inflateRaw);

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const MAX_ENTRIES = 250000;
const MAX_ENTRY_SIZE = 64 * 1024 * 1024; // nada de lo que leemos deberia pesar mas (evita zip bombs)

class ZipReader {
  constructor(source, size) {
    this.source = source; // { fh } o { buf }
    this.size = size;
    this.entries = [];
    this.byName = new Map();
  }

  static async open(file) {
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      const z = new ZipReader({ fh }, size);
      await z.init();
      return z;
    } catch (err) {
      await fh.close().catch(() => {});
      throw err;
    }
  }

  static async fromBuffer(buf) {
    const z = new ZipReader({ buf }, buf.length);
    await z.init();
    return z;
  }

  async readAt(pos, len) {
    if (pos < 0 || len < 0 || pos + len > this.size) throw new Error('zip: lectura fuera de rango');
    if (this.source.buf) return this.source.buf.subarray(pos, pos + len);
    const out = Buffer.alloc(len);
    let done = 0;
    while (done < len) {
      const { bytesRead } = await this.source.fh.read(out, done, len - done, pos + done);
      if (!bytesRead) throw new Error('zip: lectura incompleta');
      done += bytesRead;
    }
    return out;
  }

  async init() {
    if (this.size < 22) throw new Error('zip: archivo demasiado chico');
    const tailLen = Math.min(this.size, 22 + 0xffff + 20);
    const tailPos = this.size - tailLen;
    const tail = await this.readAt(tailPos, tailLen);
    let i = tail.length - 22;
    for (; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD) break;
    if (i < 0) throw new Error('zip: no es un archivo zip');
    let count = tail.readUInt16LE(i + 10);
    let cdSize = tail.readUInt32LE(i + 12);
    let cdOffset = tail.readUInt32LE(i + 16);
    const eocdPos = tailPos + i;
    let zip64 = false;
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = i - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === SIG_LOC64) {
        const recPos = Number(tail.readBigUInt64LE(loc + 8));
        const rec = await this.readAt(recPos, 56);
        if (rec.readUInt32LE(0) === SIG_EOCD64) {
          count = Number(rec.readBigUInt64LE(32));
          cdSize = Number(rec.readBigUInt64LE(40));
          cdOffset = Number(rec.readBigUInt64LE(48));
          zip64 = true;
        }
      }
    }
    // Jars con datos antepuestos (scripts ejecutables): todo quedo corrido la misma cantidad de bytes.
    const delta = !zip64 && eocdPos - cdSize > cdOffset ? eocdPos - cdSize - cdOffset : 0;
    if (count > MAX_ENTRIES) throw new Error('zip: demasiadas entradas');
    const cd = await this.readAt(cdOffset + delta, cdSize);
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== SIG_CEN) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
      if (csize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
        // Campo extra ZIP64 (0x0001): tamanios y offset de 64 bits en ese orden, solo los que faltan.
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = cd.readUInt16LE(e);
          const len = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            const stop = e + 4 + len;
            if (size === 0xffffffff && q + 8 <= stop) {
              size = Number(cd.readBigUInt64LE(q));
              q += 8;
            }
            if (csize === 0xffffffff && q + 8 <= stop) {
              csize = Number(cd.readBigUInt64LE(q));
              q += 8;
            }
            if (offset === 0xffffffff && q + 8 <= stop) offset = Number(cd.readBigUInt64LE(q));
            break;
          }
          e += 4 + len;
        }
      }
      const entry = { name, flags, method, csize, size, offset: offset + delta, dir: name.endsWith('/') };
      this.entries.push(entry);
      if (!this.byName.has(name)) this.byName.set(name, entry);
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  get(name) {
    return this.byName.get(name) || null;
  }

  async read(entry) {
    if (typeof entry === 'string') entry = this.get(entry);
    if (!entry || entry.dir) throw new Error('zip: entrada inexistente');
    if (entry.flags & 1) throw new Error('zip: entrada cifrada');
    if (entry.size > MAX_ENTRY_SIZE || entry.csize > MAX_ENTRY_SIZE) throw new Error('zip: entrada demasiado grande');
    const head = await this.readAt(entry.offset, 30);
    if (head.readUInt32LE(0) !== SIG_LOC) throw new Error('zip: cabecera local invalida');
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const raw = await this.readAt(start, entry.csize);
    if (entry.method === 0) return this.source.buf ? Buffer.from(raw) : raw;
    if (entry.method === 8) return inflateRaw(raw, { maxOutputLength: MAX_ENTRY_SIZE });
    throw new Error(`zip: metodo de compresion ${entry.method} no soportado`);
  }

  async close() {
    if (this.source.fh) await this.source.fh.close().catch(() => {});
    this.source = { buf: Buffer.alloc(0) };
  }
}

module.exports = { ZipReader };
