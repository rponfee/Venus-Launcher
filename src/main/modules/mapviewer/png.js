'use strict';
// Codificador PNG propio (8 bits, RGBA o RGB si no hay transparencia) usando zlib de Node.
// Cada fila elige el filtro (Sub, Up o Paeth) que deja la menor suma de diferencias: comprime mejor los mapas.
const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let table = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// rgba: Uint8Array (ancho * alto * 4). Devuelve un Buffer con el PNG.
function encode(rgba, width, height, { level = 6 } = {}) {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const bpp = opaque ? 3 : 4;
  const stride = width * bpp;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    // Fila sin filtrar
    let s = y * width * 4;
    if (opaque) {
      for (let i = 0; i < stride; i += 3, s += 4) {
        cur[i] = rgba[s];
        cur[i + 1] = rgba[s + 1];
        cur[i + 2] = rgba[s + 2];
      }
    } else cur.set(rgba.subarray(s, s + stride));

    // Costo de cada filtro (suma de valores con signo en valor absoluto)
    let costSub = 0;
    let costUp = 0;
    let costPaeth = 0;
    for (let i = 0; i < stride; i++) {
      const x = cur[i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const ds = (x - a) & 0xff;
      const du = (x - b) & 0xff;
      const dp = (x - paeth(a, b, c)) & 0xff;
      costSub += ds < 128 ? ds : 256 - ds;
      costUp += du < 128 ? du : 256 - du;
      costPaeth += dp < 128 ? dp : 256 - dp;
    }
    const filter = y === 0 ? 1 : costUp <= costSub && costUp <= costPaeth ? 2 : costSub <= costPaeth ? 1 : 4;
    const o = y * (stride + 1);
    raw[o] = filter;
    for (let i = 0; i < stride; i++) {
      const x = cur[i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      let v;
      if (filter === 1) v = x - a;
      else if (filter === 2) v = x - prev[i];
      else v = x - paeth(a, prev[i], i >= bpp ? prev[i - bpp] : 0);
      raw[o + 1 + i] = v & 0xff;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  const idat = zlib.deflateSync(raw, { level });
  return Buffer.concat([SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// Decodificador minimo (solo para PNG de 8 bits sin entrelazado, como los que genera encode): para pruebas.
function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('No es un PNG');
  let p = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      type = data[9];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) v += paeth(a, b, c);
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * bpp];
      out[o + 1] = cur[x * bpp + 1];
      out[o + 2] = cur[x * bpp + 2];
      out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = Uint8Array.from(cur);
  }
  return { width, height, data: out };
}

module.exports = { encode, decode, crc32 };
