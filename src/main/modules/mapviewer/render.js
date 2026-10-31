'use strict';
// Renderizado de una region (32x32 chunks) a una imagen de 512x512 vista desde arriba.
// - Superficie/End: bloque mas alto segun el mapa de alturas WORLD_SURFACE (o buscando desde arriba).
// - Agua: color del bioma mezclado con el fondo segun la profundidad (OCEAN_FLOOR vs WORLD_SURFACE).
// - Nether: se mira por debajo del techo (desde y=100 se baja hasta el primer bloque solido debajo de aire).
// - Relieve: mas claro si el bloque esta mas alto que el de su vecino del norte, mas oscuro si esta mas bajo.
const colors = require('./colors');
const { legacyName } = require('./legacy');
const { decodeChunk } = require('./chunk');

const { KIND, TINT } = colors;
const SIZE = 512;
const NO_HEIGHT = -32768;
const DIM = { overworld: 0, nether: 1, end: 2 };

// ---------- Registro de bloques y biomas (ids globales por hilo) ----------
class Registry {
  constructor() {
    this.map = new Map();
    this.cap = 512;
    this.K = new Uint8Array(this.cap);
    this.C = new Int32Array(this.cap);
    this.T = new Uint8Array(this.cap);
    this.M = new Float32Array(this.cap);
    this.A = new Float32Array(this.cap);
    this.size = 0;
    this.legacyMap = new Int32Array(1 << 16).fill(-1);
    this.biomes = new Map();
    this.bcap = 64;
    this.BG = new Int32Array(this.bcap);
    this.BF = new Int32Array(this.bcap);
    this.BW = new Int32Array(this.bcap);
    this.bsize = 0;
    this.legacyBiomes = new Int32Array(256).fill(-1);
    this.block('minecraft:air', null); // id 0 = aire
    this.biome('minecraft:plains'); // id 0 = llanura (por defecto)
  }

  grow() {
    const cap = this.cap * 2;
    const g = (Old) => {
      const n = new Old.constructor(cap);
      n.set(Old);
      return n;
    };
    this.K = g(this.K);
    this.C = g(this.C);
    this.T = g(this.T);
    this.M = g(this.M);
    this.A = g(this.A);
    this.cap = cap;
  }

  block(name, props) {
    let key = name;
    if (props) {
      if (props.axis && props.axis !== 'y') key += `|${props.axis}`;
      if (props.lit === 'true') key += '|lit';
      if (props.moisture === '7') key += '|m7';
    }
    const known = this.map.get(key);
    if (known !== undefined) return known;
    if (this.size >= 65535) return 0;
    if (this.size >= this.cap) this.grow();
    const id = this.size++;
    const r = colors.resolveBlock(name, props);
    this.K[id] = r.k;
    this.C[id] = r.c;
    this.T[id] = r.t;
    this.M[id] = r.m;
    this.A[id] = r.a;
    this.map.set(key, id);
    return id;
  }

  legacy(id, meta) {
    const k = ((id & 0xfff) << 4) | (meta & 15);
    const known = this.legacyMap[k];
    if (known >= 0) return known;
    const [name, props] = legacyName(id, meta);
    const gid = name === 'air' ? 0 : this.block(`minecraft:${name}`, props);
    this.legacyMap[k] = gid;
    return gid;
  }

  biome(name) {
    const known = this.biomes.get(name);
    if (known !== undefined) return known;
    if (this.bsize >= this.bcap) {
      const cap = this.bcap * 2;
      for (const k of ['BG', 'BF', 'BW']) {
        const n = new Int32Array(cap);
        n.set(this[k]);
        this[k] = n;
      }
      this.bcap = cap;
    }
    const id = this.bsize++;
    const b = colors.resolveBiome(name);
    this.BG[id] = b.grass;
    this.BF[id] = b.foliage;
    this.BW[id] = b.water;
    this.biomes.set(name, id);
    return id;
  }

  legacyBiome(n) {
    const k = n & 0xff;
    const known = this.legacyBiomes[k];
    if (known >= 0) return known;
    const id = this.biome(`minecraft:${colors.legacyBiomeName(k)}`);
    this.legacyBiomes[k] = id;
    return id;
  }
}

let shared = null;
function registry() {
  if (!shared) shared = new Registry();
  return shared;
}

// ---------- Color de un bloque en una posicion ----------
function blockColor(ch, gid, x, y, z) {
  const reg = ch.reg;
  const t = reg.T[gid];
  if (t === TINT.NONE) return reg.C[gid];
  const bid = ch.biome(x, y, z);
  const base = t === TINT.GRASS ? reg.BG[bid] : t === TINT.FOLIAGE ? reg.BF[bid] : reg.BW[bid];
  const m = reg.M[gid];
  const r = Math.min(255, ((base >> 16) & 255) * m);
  const g = Math.min(255, ((base >> 8) & 255) * m);
  const b = Math.min(255, (base & 255) * m);
  return (r << 16) | (g << 8) | b;
}

// Resultado de una columna (variables del modulo para no crear objetos por pixel)
let outR = 0;
let outG = 0;
let outB = 0;
let outH = 0;
let outWater = 0;

// Capas translucidas acumuladas (plantas, vidrios...) de adelante hacia atras
let accR = 0;
let accG = 0;
let accB = 0;
let accA = 0;
function resetAcc() {
  accR = 0;
  accG = 0;
  accB = 0;
  accA = 0;
}
function addLayer(c, a) {
  const w = (1 - accA) * a;
  accR += ((c >> 16) & 255) * w;
  accG += ((c >> 8) & 255) * w;
  accB += (c & 255) * w;
  accA += w;
}
function finish(c) {
  const k = 1 - accA;
  outR = accR + ((c >> 16) & 255) * k;
  outG = accG + ((c >> 8) & 255) * k;
  outB = accB + (c & 255) * k;
}

// Bloque visible en el fondo del agua (-1 si no hay): busca desde fy hacia abajo saltando agua y aire.
// Deja en floorY la altura donde termino la busqueda.
let floorY = 0;
function floorColor(ch, x, fy, z, limit) {
  const reg = ch.reg;
  const K = reg.K;
  let y = fy;
  for (let n = 0; y >= ch.minY && n < limit; ) {
    const sec = ch.section(y);
    if (sec === null || sec.clear) {
      const next = ((y >> 4) << 4) - 1;
      n += y - next;
      y = next;
      continue;
    }
    const gid = ch.blocks(sec)[((y & 15) << 8) | (z << 4) | x];
    const k = K[gid];
    if (k === KIND.WATER || k === KIND.CLEAR) {
      y--;
      n++;
      continue;
    }
    floorY = y;
    return blockColor(ch, gid, x, y, z);
  }
  floorY = y;
  return -1;
}

// Agua: mezcla del color del bioma con el fondo segun la profundidad
function waterColumn(ch, gid, x, y, z) {
  const water = blockColor(ch, gid, x, y, z);
  let fy = y - 1;
  if (ch.of) {
    const v = ch.minY + ch.of[(z << 4) | x] - 1;
    if (v < y) fy = v;
  }
  const floor = floorColor(ch, x, fy, z, 256);
  const depth = Math.max(1, y - floorY);
  let r = (water >> 16) & 255;
  let g = (water >> 8) & 255;
  let b = water & 255;
  if (floor >= 0) {
    const a = Math.min(0.94, 0.48 + depth * 0.075);
    r = ((floor >> 16) & 255) * (1 - a) + r * a;
    g = ((floor >> 8) & 255) * (1 - a) + g * a;
    b = (floor & 255) * (1 - a) + b * a;
  }
  const dark = 1 - Math.min(0.4, Math.max(0, depth - 1) * 0.0105);
  return ((r * dark) << 16) | ((g * dark) << 8) | (b * dark);
}

// Superficie (Overworld, End y dimensiones de mods): desde el bloque mas alto hacia abajo
function surfaceColumn(ch, x, z) {
  const K = ch.reg.K;
  let y;
  if (ch.ws) {
    const v = ch.ws[(z << 4) | x];
    if (v <= 0) return false;
    y = ch.minY + v - 1;
    // Mapa de alturas desactualizado (mods, ediciones): no pasar del techo real del chunk
    if (y > ch.topY) y = ch.topY;
  } else y = ch.topY;
  resetAcc();
  let top = NO_HEIGHT;
  for (let guard = 0; y >= ch.minY && guard < 4096; guard++) {
    const sec = ch.section(y);
    if (sec === null || sec.clear) {
      y = ((y >> 4) << 4) - 1;
      continue;
    }
    const gid = ch.blocks(sec)[((y & 15) << 8) | (z << 4) | x];
    const k = K[gid];
    if (k === KIND.CLEAR) {
      y--;
      continue;
    }
    if (top === NO_HEIGHT) top = y;
    if (k === KIND.OVERLAY) {
      addLayer(blockColor(ch, gid, x, y, z), ch.reg.A[gid]);
      if (accA > 0.97) {
        finish(0);
        outH = top;
        outWater = 0;
        return true;
      }
      y--;
      continue;
    }
    if (k === KIND.WATER) {
      finish(waterColumn(ch, gid, x, y, z));
      outH = top;
      outWater = accA < 0.5 ? 1 : 0;
      return true;
    }
    finish(blockColor(ch, gid, x, y, z));
    outH = top;
    outWater = 0;
    return true;
  }
  if (accA > 0) {
    finish(0);
    outH = top === NO_HEIGHT ? ch.minY : top;
    outWater = 0;
    return true;
  }
  return false;
}

// Nether: desde y=100 se busca aire y despues el primer bloque visible debajo
const NETHER_START = 100;
function netherColumn(ch, x, z) {
  const K = ch.reg.K;
  let y = Math.min(NETHER_START, ch.topY);
  if (y < ch.minY) return false;
  const startY = y;
  let seekingAir = true;
  resetAcc();
  let top = NO_HEIGHT;
  for (let guard = 0; y >= ch.minY && guard < 4096; guard++) {
    const sec = ch.section(y);
    if (sec === null || sec.clear) {
      seekingAir = false;
      y = ((y >> 4) << 4) - 1;
      continue;
    }
    if (seekingAir && sec.solid) {
      y = ((y >> 4) << 4) - 1;
      continue;
    }
    const gid = ch.blocks(sec)[((y & 15) << 8) | (z << 4) | x];
    const k = K[gid];
    if (seekingAir) {
      if (k === KIND.CLEAR) seekingAir = false;
      y--;
      continue;
    }
    if (k === KIND.CLEAR) {
      y--;
      continue;
    }
    if (top === NO_HEIGHT) top = y;
    if (k === KIND.OVERLAY) {
      addLayer(blockColor(ch, gid, x, y, z), ch.reg.A[gid]);
      y--;
      continue;
    }
    if (k === KIND.WATER) {
      finish(waterColumn(ch, gid, x, y, z));
      outH = top;
      outWater = 1;
      return true;
    }
    finish(blockColor(ch, gid, x, y, z));
    outH = top;
    outWater = 0;
    return true;
  }
  if (accA > 0) {
    finish(0);
    outH = top === NO_HEIGHT ? ch.minY : top;
    outWater = 0;
    return true;
  }
  // Roca maciza (sin cuevas): se muestra oscurecida para que se note el terreno sin explorar
  const gid = ch.block(x, startY, z);
  if (gid === 0) return false;
  const c = blockColor(ch, gid, x, startY, z);
  outR = ((c >> 16) & 255) * 0.42;
  outG = ((c >> 8) & 255) * 0.42;
  outB = (c & 255) * 0.42;
  outH = startY;
  outWater = 1; // sin relieve
  return true;
}

function drawChunk(ch, ox, oz, dim, rgba, heights, water) {
  const column = dim === DIM.nether ? netherColumn : surfaceColumn;
  for (let z = 0; z < 16; z++) {
    let pi = (oz + z) * SIZE + ox;
    for (let x = 0; x < 16; x++, pi++) {
      if (!column(ch, x, z)) continue;
      const o = pi << 2;
      rgba[o] = outR;
      rgba[o + 1] = outG;
      rgba[o + 2] = outB;
      rgba[o + 3] = 255;
      heights[pi] = outH;
      water[pi] = outWater;
    }
  }
}

// Relieve: compara con el vecino del norte (z - 1). En la primera fila se extrapola con el del sur.
function relief(rgba, heights, water) {
  for (let pz = 0; pz < SIZE; pz++) {
    for (let px = 0; px < SIZE; px++) {
      const i = pz * SIZE + px;
      const h = heights[i];
      if (h === NO_HEIGHT || water[i]) continue;
      let hn;
      if (pz > 0 && heights[i - SIZE] !== NO_HEIGHT) hn = heights[i - SIZE];
      else if (pz < SIZE - 1 && heights[i + SIZE] !== NO_HEIGHT) hn = 2 * h - heights[i + SIZE];
      else continue;
      const d = h - hn;
      if (d === 0) continue;
      const f = d > 0 ? 1 + Math.min(d, 5) * 0.05 : 1 + Math.max(d, -5) * 0.06;
      const o = i << 2;
      rgba[o] = Math.min(255, rgba[o] * f);
      rgba[o + 1] = Math.min(255, rgba[o + 1] * f);
      rgba[o + 2] = Math.min(255, rgba[o + 2] * f);
    }
  }
}

// region: anvil.Region. dim: 'overworld' | 'nether' | 'end' (u otra = superficie).
function renderRegion(region, dimName) {
  const reg = registry();
  const dim = DIM[dimName] ?? DIM.overworld;
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  const heights = new Int16Array(SIZE * SIZE).fill(NO_HEIGHT);
  const water = new Uint8Array(SIZE * SIZE);
  const stats = { chunks: 0, skipped: 0, unsupported: 0, errors: 0, legacy: 0, formats: {} };
  for (let lz = 0; lz < 32; lz++) {
    for (let lx = 0; lx < 32; lx++) {
      if (!region.has(lx, lz)) continue;
      let data;
      try {
        data = region.read(lx, lz);
      } catch (err) {
        if (err && err.code === 'compression') stats.unsupported++;
        else stats.errors++;
        continue;
      }
      if (!data) {
        stats.errors++;
        continue;
      }
      let ch = null;
      try {
        ch = decodeChunk(data, reg);
        if (ch.format === 'unknown') {
          stats.unsupported++;
          continue;
        }
        if (!ch.full) {
          stats.skipped++;
          continue;
        }
        stats.formats[ch.format] = (stats.formats[ch.format] || 0) + 1;
        if (ch.format === 'legacy') stats.legacy++;
        drawChunk(ch, lx * 16, lz * 16, dim, rgba, heights, water);
        stats.chunks++;
      } catch {
        stats.errors++;
      } finally {
        if (ch) ch.release();
      }
    }
  }
  if (stats.chunks) relief(rgba, heights, water);
  return { rgba, heights, empty: stats.chunks === 0, ...stats };
}

module.exports = { renderRegion, registry, Registry, blockColor, SIZE, NO_HEIGHT };
