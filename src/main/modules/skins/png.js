'use strict';
// PNG sin dependencias (solo zlib de Node): valida la firma, el encabezado y los CRC, decodifica los pixeles
// a RGBA de 8 bits (todos los tipos de color, de 1 a 16 bits, sin entrelazado) y adivina el modelo de una
// skin (brazos clasicos de 4 pixeles o finos de 3) mirando las zonas que el modelo fino no usa.
// Sin Electron: se prueba con Node puro (test/png.test.js).
const zlib = require('zlib');
const crypto = require('crypto');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIDE = 1024;
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const SKIN_SIZES = [
  [64, 64],
  [64, 32],
];

// Zonas del brazo que el modelo fino (slim) no usa: si tienen transparencia, o son todas negras o todas
// blancas, la skin es de brazos finos. [x, y, ancho, alto]
const SLIM_AREAS = [
  [50, 16, 2, 4],
  [54, 20, 2, 12],
  [42, 48, 2, 4],
  [46, 52, 2, 12],
];

function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 33 && buf.subarray(0, 8).equals(SIGNATURE);
}

// Encabezado (IHDR) o null si no es un PNG valido.
function inspect(buf) {
  if (!isPng(buf)) return null;
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const [bitDepth, colorType, compression, filter, interlace] = [buf[24], buf[25], buf[26], buf[27], buf[28]];
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE) return null;
  if (!DEPTHS[colorType]?.includes(bitDepth) || compression !== 0 || filter !== 0 || interlace > 1) return null;
  return { width, height, bitDepth, colorType, interlace };
}

const crcOf = typeof zlib.crc32 === 'function' ? (b) => zlib.crc32(b) >>> 0 : null;

// Recorre los bloques: null si falta IEND, un bloque esta cortado o un CRC no coincide.
function chunks(buf) {
  const out = { palette: null, trns: null, idat: [] };
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    if (len > buf.length - pos - 12) return null;
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (crcOf && crcOf(buf.subarray(pos + 4, pos + 8 + len)) !== buf.readUInt32BE(pos + 8 + len)) return null;
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'PLTE') out.palette = data;
    else if (type === 'tRNS') out.trns = data;
    else if (type === 'IDAT') out.idat.push(data);
    else if (type === 'IEND') return out.idat.length ? out : null;
    pos += 12 + len;
  }
  return null;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Deshace los filtros de cada fila. null si un filtro es invalido.
function unfilter(raw, height, rowBytes, bpp) {
  const out = Buffer.alloc(height * rowBytes);
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const start = y * (rowBytes + 1);
    const type = raw[start];
    if (type > 4) return null;
    const line = raw.subarray(start + 1, start + 1 + rowBytes);
    const cur = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) v += paeth(a, b, c);
      cur[i] = v & 255;
    }
    prev = cur;
  }
  return out;
}

function sampleAt(row, index, depth) {
  if (depth === 8) return row[index];
  if (depth === 16) return (row[index * 2] << 8) | row[index * 2 + 1];
  const perByte = 8 / depth;
  const byte = row[Math.floor(index / perByte)];
  const shift = 8 - depth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

const to8 = (v, depth) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));

// Imagen RGBA de 8 bits: { width, height, data } o null si el archivo no es un PNG integro.
// Un PNG entrelazado valido devuelve data: null (se acepta, pero no se leen sus pixeles).
function decode(buf) {
  const head = inspect(buf);
  if (!head) return null;
  const parts = chunks(buf);
  if (!parts) return null;
  const { width, height, bitDepth: depth, colorType } = head;
  const palette = parts.palette;
  if (colorType === 3 && (!palette || !palette.length || palette.length % 3 || palette.length > 768)) return null;
  if (head.interlace) return { ...head, data: null };
  const channels = CHANNELS[colorType];
  const rowBytes = Math.ceil((width * channels * depth) / 8);
  const bpp = Math.max(1, (channels * depth) >> 3);
  const expected = height * (rowBytes + 1);
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(parts.idat), { maxOutputLength: expected + 64 });
  } catch {
    return null;
  }
  if (raw.length < expected) return null;
  const pixels = unfilter(raw, height, rowBytes, bpp);
  if (!pixels) return null;
  const trns = parts.trns;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r;
      let g;
      let b;
      let a = 255;
      if (colorType === 3) {
        const i = sampleAt(row, x, depth);
        if (i * 3 + 2 >= palette.length) return null;
        [r, g, b] = [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]];
        if (trns && i < trns.length) a = trns[i];
      } else if (colorType === 0 || colorType === 4) {
        const gray = sampleAt(row, x * channels, depth);
        r = g = b = to8(gray, depth);
        if (colorType === 4) a = to8(sampleAt(row, x * channels + 1, depth), depth);
        else if (trns && trns.length >= 2 && gray === trns.readUInt16BE(0)) a = 0;
      } else {
        const rs = sampleAt(row, x * channels, depth);
        const gs = sampleAt(row, x * channels + 1, depth);
        const bs = sampleAt(row, x * channels + 2, depth);
        [r, g, b] = [to8(rs, depth), to8(gs, depth), to8(bs, depth)];
        if (colorType === 6) a = to8(sampleAt(row, x * channels + 3, depth), depth);
        else if (trns && trns.length >= 6 && rs === trns.readUInt16BE(0) && gs === trns.readUInt16BE(2) && bs === trns.readUInt16BE(4)) a = 0;
      }
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { ...head, data };
}

function pixel(img, x, y) {
  const o = (y * img.width + x) * 4;
  return img.data.subarray(o, o + 4);
}

// 'slim' o 'classic'. Las skins de 64x32 (formato viejo) son siempre clasicas.
function guessVariant(img) {
  if (!img?.data || img.width !== 64 || img.height !== 64) return 'classic';
  let transparent = false;
  let black = true;
  let white = true;
  for (const [x0, y0, w, h] of SLIM_AREAS) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const [r, g, b, a] = pixel(img, x, y);
        if (a < 255) transparent = true;
        if (r || g || b) black = false;
        if (r !== 255 || g !== 255 || b !== 255) white = false;
      }
    }
  }
  return transparent || black || white ? 'slim' : 'classic';
}

// Huella de los pixeles (no del archivo): dos PNG con la misma imagen dan lo mismo aunque se hayan
// comprimido distinto. El color de los pixeles transparentes no cuenta.
function pixelHash(img) {
  if (!img?.data) return null;
  const copy = Buffer.from(img.data);
  for (let i = 0; i < copy.length; i += 4) if (copy[i + 3] === 0) copy[i] = copy[i + 1] = copy[i + 2] = 0;
  const h = crypto.createHash('sha1');
  h.update(`${img.width}x${img.height}:`);
  h.update(copy);
  return h.digest('hex');
}

// Revisa una imagen que llega de afuera. Devuelve { ok: true, image, sha1, pixelHash } o { ok: false, code }
// con code 'tooBig', 'notPng', 'wrongSize' o 'corrupt'.
function check(buf, { maxBytes = 64 * 1024, sizes = SKIN_SIZES } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, code: 'notPng' };
  if (buf.length > maxBytes) return { ok: false, code: 'tooBig' };
  if (!isPng(buf)) return { ok: false, code: 'notPng' };
  const head = inspect(buf);
  if (!head) return { ok: false, code: 'corrupt' };
  if (!sizes.some(([w, h]) => w === head.width && h === head.height)) return { ok: false, code: 'wrongSize', width: head.width, height: head.height };
  const image = decode(buf);
  if (!image) return { ok: false, code: 'corrupt' };
  return { ok: true, image, sha1: crypto.createHash('sha1').update(buf).digest('hex'), pixelHash: pixelHash(image) };
}

module.exports = { SIGNATURE, SKIN_SIZES, SLIM_AREAS, isPng, inspect, decode, guessVariant, pixelHash, check };
