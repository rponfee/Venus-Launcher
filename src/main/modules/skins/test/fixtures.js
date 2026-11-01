'use strict';
// Ayudantes de las pruebas de skins: un codificador PNG minimo (RGBA, paleta, gris; con los 5 filtros),
// patrones de skin de prueba y respuestas de fetch falsas. No es una prueba (no tiene test()).
const zlib = require('zlib');

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Aplica el filtro f (0 a 4) a una fila.
function filterRow(f, cur, prev, bpp) {
  const out = Buffer.alloc(cur.length + 1);
  out[0] = f;
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0;
    out[i + 1] = (cur[i] - pred) & 255;
  }
  return out;
}

// RGBA de 8 bits -> PNG. colorType 6 (RGBA), 2 (RGB), 3 (paleta con tRNS) o 0 (gris).
// filter: numero fijo o 'mixed' (cada fila con un filtro distinto).
function encodePng({ width, height, data, colorType = 6, filter = 'mixed' }) {
  let rows = [];
  let bpp = 4;
  let palette = null;
  let trns = null;
  if (colorType === 3) {
    const colors = new Map();
    const idx = Buffer.alloc(width * height);
    for (let i = 0; i < width * height; i++) {
      const key = data.readUInt32BE ? data.readUInt32BE(i * 4) : Buffer.from(data.slice(i * 4, i * 4 + 4)).readUInt32BE(0);
      if (!colors.has(key)) colors.set(key, colors.size);
      idx[i] = colors.get(key);
    }
    if (colors.size > 256) throw new Error('demasiados colores');
    palette = Buffer.alloc(colors.size * 3);
    trns = Buffer.alloc(colors.size);
    for (const [key, i] of colors) {
      palette[i * 3] = (key >>> 24) & 255;
      palette[i * 3 + 1] = (key >>> 16) & 255;
      palette[i * 3 + 2] = (key >>> 8) & 255;
      trns[i] = key & 255;
    }
    bpp = 1;
    for (let y = 0; y < height; y++) rows.push(idx.subarray(y * width, (y + 1) * width));
  } else {
    const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
    bpp = ch;
    for (let y = 0; y < height; y++) {
      const row = Buffer.alloc(width * ch);
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (ch === 1) row[x] = data[o];
        else for (let c = 0; c < ch; c++) row[x * ch + c] = data[o + c];
      }
      rows.push(row);
    }
  }
  let prev = Buffer.alloc(rows[0].length);
  const filtered = rows.map((row, y) => {
    const f = filter === 'mixed' ? y % 5 : filter;
    const out = filterRow(f, row, prev, bpp);
    prev = row;
    return out;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', palette), chunk('tRNS', trns));
  parts.push(chunk('IDAT', zlib.deflateSync(Buffer.concat(filtered))), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// Imagen RGBA llena de un color.
function solid(width, height, rgba = [200, 120, 60, 255]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

function setRect(img, x0, y0, w, h, rgba) {
  for (let y = y0; y < Math.min(y0 + h, img.height); y++) for (let x = x0; x < Math.min(x0 + w, img.width); x++) img.data.set(rgba, (y * img.width + x) * 4);
  return img;
}

// Skin opaca de 64x64 con colores distintos en cada zona; slim: deja transparentes las zonas que el
// modelo fino no usa (como hacen los editores).
function skinImage(variant = 'classic', height = 64) {
  const img = solid(64, height, [0, 0, 0, 0]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < 64; x++) img.data.set([(x * 4) & 255, (y * 4) & 255, (x + y) & 255, 255], (y * 64 + x) * 4);
  }
  // capa exterior (sombrero, campera...) casi toda transparente
  setRect(img, 32, 0, 32, 16, [0, 0, 0, 0]);
  setRect(img, 40, 8, 8, 2, [255, 255, 255, 255]);
  if (height === 64) {
    setRect(img, 0, 32, 64, 16, [0, 0, 0, 0]);
    setRect(img, 0, 48, 16, 16, [0, 0, 0, 0]);
    setRect(img, 48, 48, 16, 16, [0, 0, 0, 0]);
  }
  if (variant === 'slim') {
    setRect(img, 50, 16, 2, 4, [0, 0, 0, 0]);
    setRect(img, 54, 20, 2, 12, [0, 0, 0, 0]);
    setRect(img, 42, 48, 2, 4, [0, 0, 0, 0]);
    setRect(img, 46, 52, 2, 12, [0, 0, 0, 0]);
  }
  return img;
}

const skinPng = (variant = 'classic', height = 64, opts = {}) => encodePng({ ...skinImage(variant, height), ...opts });

// Respuesta de fetch falsa (con cuerpo en flujo, como la de Node).
function reply(status, body, { headers = {} } = {}) {
  const buf = body === undefined || body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => lower[String(k).toLowerCase()] ?? null },
    body: new ReadableStream({
      start(c) {
        if (buf.length) c.enqueue(new Uint8Array(buf));
        c.close();
      },
    }),
    async json() {
      return JSON.parse(buf.toString('utf8'));
    },
    async arrayBuffer() {
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    },
  };
}

const t = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);

module.exports = { encodePng, solid, setRect, skinImage, skinPng, reply, t };
