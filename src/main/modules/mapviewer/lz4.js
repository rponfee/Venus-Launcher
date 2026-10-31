'use strict';
// Descompresion LZ4 en JavaScript (chunks de Minecraft 1.20.5+ con region-file-compression=lz4).
// Minecraft usa el formato de lz4-java (LZ4BlockOutputStream): una serie de bloques, cada uno con
//   "LZ4Block" (8 bytes) · token (metodo | nivel) · largo comprimido (int LE) · largo original (int LE) · checksum (int LE)
// seguido de los datos (LZ4 en formato de bloque estandar, o crudos). El stream termina con un bloque vacio.

const MAGIC = 'LZ4Block';
const HEADER = 21;
const METHOD_RAW = 0x10;
const METHOD_LZ4 = 0x20;

// Descomprime un bloque LZ4 estandar: src[sIdx..sEnd) -> out[oIdx..oEnd). Devuelve la posicion final en out.
function decompressBlock(src, sIdx, sEnd, out, oIdx, oEnd) {
  while (sIdx < sEnd) {
    const token = src[sIdx++];
    let lit = token >>> 4;
    if (lit === 15) {
      let b;
      do {
        if (sIdx >= sEnd) throw new Error('LZ4: datos truncados');
        b = src[sIdx++];
        lit += b;
      } while (b === 255);
    }
    if (lit) {
      if (sIdx + lit > sEnd || oIdx + lit > oEnd) throw new Error('LZ4: literales fuera de rango');
      out.set(src.subarray(sIdx, sIdx + lit), oIdx);
      sIdx += lit;
      oIdx += lit;
    }
    // La ultima secuencia tiene solo literales
    if (sIdx >= sEnd) break;
    if (sIdx + 2 > sEnd) throw new Error('LZ4: datos truncados');
    const offset = src[sIdx] | (src[sIdx + 1] << 8);
    sIdx += 2;
    if (offset === 0 || offset > oIdx) throw new Error('LZ4: desplazamiento invalido');
    let len = token & 15;
    if (len === 15) {
      let b;
      do {
        if (sIdx >= sEnd) throw new Error('LZ4: datos truncados');
        b = src[sIdx++];
        len += b;
      } while (b === 255);
    }
    len += 4;
    if (oIdx + len > oEnd) throw new Error('LZ4: copia fuera de rango');
    let m = oIdx - offset;
    if (offset >= len) {
      out.copyWithin(oIdx, m, m + len);
      oIdx += len;
    } else {
      // Copia solapada (repite un patron corto): byte a byte
      for (let i = 0; i < len; i++) out[oIdx++] = out[m++];
    }
  }
  return oIdx;
}

function isMagic(buf, p) {
  for (let i = 0; i < 8; i++) if (buf[p + i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

// Descomprime un stream de LZ4BlockOutputStream completo.
function decompressStream(buf) {
  const parts = [];
  let total = 0;
  let p = 0;
  while (p + HEADER <= buf.length) {
    if (!isMagic(buf, p)) throw new Error('LZ4: cabecera invalida');
    const method = buf[p + 8] & 0xf0;
    const clen = buf.readInt32LE(p + 9);
    const dlen = buf.readInt32LE(p + 13);
    p += HEADER;
    if (dlen === 0 && clen === 0) break; // fin del stream
    if (clen < 0 || dlen < 0 || p + clen > buf.length) throw new Error('LZ4: bloque truncado');
    let out;
    if (method === METHOD_RAW) {
      if (clen !== dlen) throw new Error('LZ4: bloque crudo invalido');
      out = buf.subarray(p, p + clen);
    } else if (method === METHOD_LZ4) {
      out = Buffer.allocUnsafe(dlen);
      if (decompressBlock(buf, p, p + clen, out, 0, dlen) !== dlen) throw new Error('LZ4: largo incorrecto');
    } else {
      throw new Error('LZ4: metodo desconocido');
    }
    parts.push(out);
    total += dlen;
    p += clen;
  }
  if (parts.length === 1) return parts[0];
  return Buffer.concat(parts, total);
}

module.exports = { decompressBlock, decompressStream, MAGIC, METHOD_RAW, METHOD_LZ4 };
