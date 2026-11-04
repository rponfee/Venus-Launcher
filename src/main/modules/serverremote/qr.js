'use strict';
// Codificador de códigos QR chico y propio (ISO/IEC 18004): modo byte, corrección M y versiones 1 a 10, que alcanzan
// para la dirección del control remoto. Sin dependencias ni Electron. La prueba (test/qr.test.js) lo decodifica de vuelta.
//   encodeQr('http://192.168.0.5:49152/#t=...') -> { size, rows: ['0101...', ...] }  (1 = módulo oscuro, sin zona blanca)

// Corrección M: palabras de corrección por bloque y cantidad de bloques (versión 1 a 10).
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_M = 0; // bits de "M" en la información de formato
const MAX_VERSION = 10;

// ---------- Reed-Solomon sobre GF(256) (polinomio 0x11D) ----------
function gfMul(a, b) {
  let r = 0;
  for (let i = 7; i >= 0; i--) {
    r = (r << 1) ^ ((r >>> 7) * 0x11d);
    r ^= ((b >>> i) & 1) * a;
  }
  return r;
}

function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 2);
  }
  return out;
}

function rsRemainder(data, divisor) {
  const out = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((d, i) => {
      out[i] ^= gfMul(d, factor);
    });
  }
  return out;
}

// ---------- Tamaños ----------
const sizeOf = (version) => version * 4 + 17;

function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = sizeOf(version) - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

// Módulos disponibles para datos y corrección (sin patrones de función)
function rawModules(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

const dataCodewords = (version) => Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version - 1] * BLOCKS[version - 1];

function pickVersion(bytes) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const header = 4 + (v < 10 ? 8 : 16);
    if (header + bytes * 8 <= dataCodewords(v) * 8) return v;
  }
  throw new Error('qr: texto demasiado largo');
}

// ---------- Datos ----------
function buildCodewords(bytes, version) {
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  const capacity = dataCodewords(version) * 8;
  push(0b0100, 4); // modo byte
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity - bits.length)); // terminador
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  return data;
}

// Parte en bloques, calcula la corrección y los intercala
function withCorrection(data, version) {
  const blocks = BLOCKS[version - 1];
  const eccLen = ECC_PER_BLOCK[version - 1];
  const raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks) - eccLen;
  const divisor = rsDivisor(eccLen);
  const parts = [];
  let at = 0;
  for (let i = 0; i < blocks; i++) {
    const len = shortLen + (i < shortBlocks ? 0 : 1);
    const chunk = data.slice(at, at + len);
    at += len;
    parts.push({ chunk, ecc: rsRemainder(chunk, divisor) });
  }
  const out = [];
  for (let i = 0; i <= shortLen; i++) for (const p of parts) if (i < p.chunk.length) out.push(p.chunk[i]);
  for (let i = 0; i < eccLen; i++) for (const p of parts) out.push(p.ecc[i]);
  return out;
}

// ---------- Matriz ----------
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function formatBits(mask) {
  const data = (FORMAT_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function newGrid(size) {
  return { size, dark: Array.from({ length: size }, () => new Array(size).fill(false)), fixed: Array.from({ length: size }, () => new Array(size).fill(false)) };
}

function drawFunctionPatterns(g, version) {
  const set = (x, y, on) => {
    g.dark[y][x] = on;
    g.fixed[y][x] = true;
  };
  const { size } = g;
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const pos = alignmentPositions(version);
  pos.forEach((ax, i) => {
    pos.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    });
  });
  drawFormat(g, 0);
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, on);
      set(b, a, on);
    }
  }
}

function drawFormat(g, mask) {
  const bits = formatBits(mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  const set = (x, y, on) => {
    g.dark[y][x] = on;
    g.fixed[y][x] = true;
  };
  const { size } = g;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // módulo siempre oscuro
}

// Recorre la matriz en zigzag, de derecha a izquierda de a dos columnas
function drawData(g, codewords) {
  const { size } = g;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!g.fixed[y][x] && i < codewords.length * 8) {
          g.dark[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

function applyMask(g, mask) {
  const fn = MASKS[mask];
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!g.fixed[y][x] && fn(x, y)) g.dark[y][x] = !g.dark[y][x];
}

// Penalidades de la norma: el mejor patrón de máscara es el de menor puntaje
function penalty(g) {
  const { size, dark } = g;
  let score = 0;
  const line = (get) => {
    let run = 0;
    let color = null;
    const bits = [];
    for (let i = 0; i < size; i++) {
      const c = get(i);
      bits.push(c);
      if (c === color) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else {
        color = c;
        run = 1;
      }
    }
    // Patrón parecido al de los buscadores: 1011101 con cuatro claros a un lado
    for (let i = 0; i + 11 <= size; i++) {
      const seg = bits.slice(i, i + 11).map((b) => (b ? 1 : 0)).join('');
      if (seg === '10111010000' || seg === '00001011101') score += 40;
    }
  };
  for (let y = 0; y < size; y++) line((i) => dark[y][i]);
  for (let x = 0; x < size; x++) line((i) => dark[i][x]);
  let total = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (dark[y][x]) total++;
      if (x + 1 < size && y + 1 < size) {
        const c = dark[y][x];
        if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3;
      }
    }
  }
  const pct = (total * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

function encodeQr(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const version = pickVersion(bytes.length);
  const codewords = withCorrection(buildCodewords(bytes, version), version);
  const grid = newGrid(sizeOf(version));
  drawFunctionPatterns(grid, version);
  drawData(grid, codewords);
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(grid, mask);
    drawFormat(grid, mask);
    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
    applyMask(grid, mask); // aplicar dos veces la deshace
  }
  applyMask(grid, best);
  drawFormat(grid, best);
  return { size: grid.size, rows: grid.dark.map((row) => row.map((on) => (on ? '1' : '0')).join('')) };
}

module.exports = { encodeQr, MAX_VERSION };
