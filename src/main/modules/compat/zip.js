'use strict';
// Lector mínimo de ZIP/JAR que solo lee lo necesario: el directorio central y las entradas pedidas.
// Sirve para archivos locales (lectura por posición) y remotos (pedidos HTTP con Range), así se pueden
// leer los metadatos de un mod de Modrinth sin descargar el .jar completo.
const fsp = require('fs/promises');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const SMALL_REMOTE = 256 * 1024; // archivos remotos chicos: se bajan enteros en un solo pedido

function bufferSource(buf) {
  return {
    size: buf.length,
    read: async (start, len) => buf.subarray(start, Math.min(buf.length, start + len)),
    close: async () => {},
  };
}

async function fileSource(file) {
  const fh = await fsp.open(file, 'r');
  const st = await fh.stat();
  return {
    size: st.size,
    async read(start, len) {
      const n = Math.max(0, Math.min(len, st.size - start));
      const b = Buffer.alloc(n);
      const { bytesRead } = await fh.read(b, 0, n, start);
      return b.subarray(0, bytesRead);
    },
    close: () => fh.close().catch(() => {}),
  };
}

// Fuente remota con pedidos por rango. opts: { userAgent, signal, maxBytes }
function urlSource(url, size, { userAgent, signal, maxBytes = 4 * 1024 * 1024 } = {}) {
  let whole = null;
  let fetched = 0;
  const headers = (extra) => ({ 'User-Agent': userAgent || 'VenusLauncher', ...extra });
  const timeout = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000));
  async function getWhole() {
    const res = await fetch(url, { headers: headers(), signal: timeout() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    whole = Buffer.from(await res.arrayBuffer());
    return whole;
  }
  return {
    size,
    async read(start, len) {
      if (whole) return whole.subarray(start, start + len);
      if (size <= SMALL_REMOTE) return (await getWhole()).subarray(start, start + len);
      const end = Math.min(size, start + len) - 1;
      if (end < start) return Buffer.alloc(0);
      const res = await fetch(url, { headers: headers({ Range: `bytes=${start}-${end}` }), signal: timeout() });
      if (res.status === 206) {
        const b = Buffer.from(await res.arrayBuffer());
        fetched += b.length;
        if (fetched > maxBytes) throw new Error('Demasiados datos para leer metadatos');
        return b;
      }
      if (res.status === 200) {
        // El servidor ignoro el rango: solo se acepta si el archivo es razonablemente chico
        const total = Number(res.headers.get('content-length')) || size;
        if (total > maxBytes) {
          await res.body?.cancel?.().catch(() => {});
          throw new Error('El servidor no permite leer por partes');
        }
        whole = Buffer.from(await res.arrayBuffer());
        return whole.subarray(start, start + len);
      }
      throw new Error(`HTTP ${res.status}`);
    },
    close: async () => {},
  };
}

function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  return -1;
}

async function openZip(src) {
  if (src.size < 22) throw new Error('No es un archivo zip');
  const maxTail = Math.min(src.size, 22 + 65535 + 20);
  let tailStart = 0;
  let tail = null;
  let eocd = -1;
  for (const len of [Math.min(src.size, 16384), maxTail]) {
    tailStart = src.size - len;
    tail = await src.read(tailStart, len);
    eocd = findEocd(tail);
    if (eocd >= 0 || len === maxTail) break;
  }
  if (eocd < 0) throw new Error('No es un archivo zip');
  let total = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || total === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tail.readUInt32LE(loc) === SIG_LOC64) {
      const recOff = Number(tail.readBigUInt64LE(loc + 8));
      const rec = recOff >= tailStart ? tail.subarray(recOff - tailStart, recOff - tailStart + 56) : await src.read(recOff, 56);
      if (rec.length >= 56 && rec.readUInt32LE(0) === SIG_EOCD64) {
        total = Number(rec.readBigUInt64LE(32));
        cdSize = Number(rec.readBigUInt64LE(40));
        cdOffset = Number(rec.readBigUInt64LE(48));
      }
    }
  }
  if (cdOffset + cdSize > src.size) throw new Error('Zip dañado');
  let cd;
  if (cdOffset >= tailStart) cd = tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize);
  else {
    const before = await src.read(cdOffset, Math.min(cdSize, tailStart - cdOffset));
    cd = cdOffset + cdSize <= tailStart ? before : Buffer.concat([before, tail.subarray(0, cdOffset + cdSize - tailStart)]);
  }
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < total && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== SIG_CEN) break;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
    const name = flags & 0x800 ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
    if (size === 0xffffffff || compSize === 0xffffffff || offset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 1) {
          let q = e + 4;
          if (size === 0xffffffff) {
            size = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (compSize === 0xffffffff) {
            compSize = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
          break;
        }
        e += 4 + len;
      }
    }
    entries.set(name, { name, method, flags, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { src, entries };
}

// Devuelve el contenido (Buffer) de una entrada o null si no existe.
async function readEntry(zip, name, { maxSize = 4 * 1024 * 1024 } = {}) {
  const e = zip.entries.get(name);
  if (!e) return null;
  if (e.size > maxSize || e.compSize > maxSize) throw new Error(`Entrada demasiado grande: ${name}`);
  if (e.flags & 1) throw new Error('Entrada cifrada');
  const guess = Math.min(zip.src.size - e.offset, 30 + 1024 + e.compSize);
  const head = await zip.src.read(e.offset, guess);
  if (head.length < 30 || head.readUInt32LE(0) !== SIG_LOC) throw new Error('Encabezado local inválido');
  const start = 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const data = start + e.compSize <= head.length ? head.subarray(start, start + e.compSize) : await zip.src.read(e.offset + start, e.compSize);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: maxSize });
  throw new Error(`Compresión no soportada (${e.method})`);
}

module.exports = { bufferSource, fileSource, urlSource, openZip, readEntry };
