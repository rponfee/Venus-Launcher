'use strict';
// Archivos de region de Anvil (r.X.Z.mca): cabecera con la ubicacion de los 1024 chunks
// (desplazamiento en sectores de 4 KiB + cantidad de sectores), fechas, y la descompresion de cada chunk.
// Compresion: 1 gzip · 2 zlib · 3 sin comprimir · 4 LZ4 (1.20.5+). Con el bit 0x80 el chunk esta en c.X.Z.mcc.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const lz4 = require('./lz4');

const SECTOR = 4096;
const HEADER_SIZE = 8192;
const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
const MCREGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mcr$/;

class UnsupportedChunkError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'unsupported';
  }
}

function parseRegionName(name) {
  const m = REGION_RE.exec(name);
  return m ? { rx: Number(m[1]), rz: Number(m[2]) } : null;
}

// Regiones de una carpeta: [{ rx, rz, file, size, mtime }] (las que solo tienen la cabecera no cuentan).
async function listRegions(dir) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { regions: [], mcregion: 0 };
  }
  let mcregion = 0;
  const found = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const pos = parseRegionName(e.name);
    if (pos) found.push({ ...pos, file: path.join(dir, e.name) });
    else if (MCREGION_RE.test(e.name)) mcregion++;
  }
  const out = [];
  const BATCH = 64;
  for (let i = 0; i < found.length; i += BATCH) {
    const stats = await Promise.all(found.slice(i, i + BATCH).map((r) => fsp.stat(r.file).catch(() => null)));
    stats.forEach((st, j) => {
      if (st && st.size > HEADER_SIZE) out.push({ ...found[i + j], size: st.size, mtime: Math.round(st.mtimeMs) });
    });
  }
  return { regions: out, mcregion };
}

function decompress(type, data) {
  switch (type) {
    case 1:
      return zlib.gunzipSync(data);
    case 2:
      return zlib.inflateSync(data);
    case 3:
      return data;
    case 4:
      return lz4.decompressStream(data);
    default:
      // 127 = compresion personalizada (1.20.5+): no hay forma de leerla sin el algoritmo
      throw new UnsupportedChunkError(`Compresion ${type} no soportada`, 'compression');
  }
}

// Region en memoria: buf = contenido completo del .mca
class Region {
  constructor(buf, dir, rx, rz) {
    this.buf = buf;
    this.dir = dir;
    this.rx = rx;
    this.rz = rz;
  }

  // true si el chunk (0..31, 0..31) esta guardado
  has(lx, lz) {
    if (this.buf.length < HEADER_SIZE) return false;
    const loc = this.buf.readUInt32BE((lx + lz * 32) << 2);
    return loc >>> 8 !== 0 && (loc & 0xff) !== 0;
  }

  timestamp(lx, lz) {
    if (this.buf.length < HEADER_SIZE) return 0;
    return this.buf.readUInt32BE(SECTOR + ((lx + lz * 32) << 2));
  }

  // NBT sin comprimir del chunk, o null si no existe o esta cortado (por ejemplo, el juego lo esta escribiendo)
  read(lx, lz) {
    const buf = this.buf;
    if (buf.length < HEADER_SIZE) return null;
    const loc = buf.readUInt32BE((lx + lz * 32) << 2);
    const off = (loc >>> 8) * SECTOR;
    if (!off || !(loc & 0xff) || off + 5 > buf.length) return null;
    const len = buf.readUInt32BE(off);
    if (len < 1) return null;
    let type = buf[off + 4];
    let payload;
    if (type & 0x80) {
      type &= 0x7f;
      const cx = this.rx * 32 + lx;
      const cz = this.rz * 32 + lz;
      try {
        payload = fs.readFileSync(path.join(this.dir, `c.${cx}.${cz}.mcc`));
      } catch {
        return null;
      }
    } else {
      if (off + 4 + len > buf.length) return null;
      payload = buf.subarray(off + 5, off + 4 + len);
    }
    return decompress(type, payload);
  }
}

function openRegionSync(file) {
  const name = path.basename(file);
  const pos = parseRegionName(name);
  if (!pos) throw new Error('Nombre de region invalido');
  return new Region(fs.readFileSync(file), path.dirname(file), pos.rx, pos.rz);
}

module.exports = { Region, openRegionSync, listRegions, parseRegionName, decompress, UnsupportedChunkError, SECTOR, HEADER_SIZE, REGION_RE };
