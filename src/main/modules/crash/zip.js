'use strict';
// Lector minimo de ZIP/JAR: lee solo el directorio central y las entradas pedidas, sin cargar el
// archivo entero en memoria (un modpack puede tener cientos de mods de varios MB cada uno).
// Soporta ZIP64, entradas guardadas (stored) y comprimidas (deflate). Funciona sobre archivos y buffers.
const fsp = require('fs/promises');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_Z64_LOC = 0x07064b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const MAX_CENTRAL = 64 * 1024 * 1024;
const MAX_ENTRY = 48 * 1024 * 1024;

// Origen de bytes: archivo abierto o buffer en memoria (jar anidado dentro de otro jar).
function bufferSource(buf) {
  return {
    size: async () => buf.length,
    read: async (pos, len) => {
      if (pos < 0 || pos + len > buf.length) throw new Error('Lectura fuera del ZIP');
      return buf.subarray(pos, pos + len);
    },
    close: async () => {},
  };
}

async function fileSource(file) {
  const fh = await fsp.open(file, 'r');
  const st = await fh.stat();
  return {
    size: async () => st.size,
    read: async (pos, len) => {
      if (pos < 0 || pos + len > st.size) throw new Error('Lectura fuera del ZIP');
      const out = Buffer.allocUnsafe(len);
      let done = 0;
      while (done < len) {
        const { bytesRead } = await fh.read(out, done, len - done, pos + done);
        if (!bytesRead) throw new Error('ZIP truncado');
        done += bytesRead;
      }
      return out;
    },
    close: () => fh.close().catch(() => {}),
  };
}

function findEocd(tail) {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

function parseCentral(cd, count) {
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== SIG_CEN) break;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    if (size === 0xffffffff || compSize === 0xffffffff || offset === 0xffffffff) {
      // Campo extra ZIP64 con los tamanos reales
      let e = p + 46 + nameLen;
      const end = Math.min(cd.length, e + extraLen);
      while (e + 4 <= end) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff && q + 8 <= end) {
            size = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (compSize === 0xffffffff && q + 8 <= end) {
            compSize = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (offset === 0xffffffff && q + 8 <= end) offset = Number(cd.readBigUInt64LE(q));
          break;
        }
        e += 4 + len;
      }
    }
    entries.push({ name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function openSource(src) {
  try {
    const size = await src.size();
    if (size < 22) throw new Error('No es un archivo ZIP');
    const tailLen = Math.min(size, 65557);
    const tail = await src.read(size - tailLen, tailLen);
    const i = findEocd(tail);
    if (i < 0) throw new Error('No es un archivo ZIP');
    const eocdPos = size - tailLen + i;
    let count = tail.readUInt16LE(i + 10);
    let cdSize = tail.readUInt32LE(i + 12);
    let cdOffset = tail.readUInt32LE(i + 16);
    let zip64 = false;
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = i - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === SIG_Z64_LOC) {
        const recPos = Number(tail.readBigUInt64LE(loc + 8));
        const rec = await src.read(recPos, 56);
        if (rec.readUInt32LE(0) === SIG_Z64_EOCD) {
          count = Number(rec.readBigUInt64LE(32));
          cdSize = Number(rec.readBigUInt64LE(40));
          cdOffset = Number(rec.readBigUInt64LE(48));
          zip64 = true;
        }
      }
    }
    if (cdSize > MAX_CENTRAL) throw new Error('Directorio del ZIP demasiado grande');
    // Archivos con datos agregados al principio (poco comun): corregir el desplazamiento
    let base = 0;
    if (!zip64 && cdOffset + cdSize !== eocdPos && eocdPos - cdSize >= 0) base = eocdPos - cdSize - cdOffset;
    const cd = await src.read(cdOffset + base, cdSize);
    const entries = parseCentral(cd, count);
    const byName = new Map(entries.map((e) => [e.name, e]));

    async function read(entry) {
      const e = typeof entry === 'string' ? byName.get(entry) : entry;
      if (!e) return null;
      if (e.compSize > MAX_ENTRY || e.size > MAX_ENTRY) throw new Error('Entrada del ZIP demasiado grande');
      const head = await src.read(e.offset + base, 30);
      if (head.readUInt32LE(0) !== SIG_LOC) throw new Error('Entrada del ZIP dañada');
      const start = e.offset + base + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      const data = await src.read(start, e.compSize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
      throw new Error(`Compresión no soportada (${e.method})`);
    }

    async function readText(name) {
      const buf = await read(name).catch(() => null);
      if (!buf) return null;
      let text = buf.toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return text;
    }

    return { entries, get: (name) => byName.get(name) || null, read, readText, close: () => src.close() };
  } catch (err) {
    await src.close();
    throw err;
  }
}

async function openZipFile(file) {
  return openSource(await fileSource(file));
}

async function openZipBuffer(buf) {
  return openSource(bufferSource(buf));
}

module.exports = { openZipFile, openZipBuffer };
