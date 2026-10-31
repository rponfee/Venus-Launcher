'use strict';
// Lectura rapida de chunks para el mapa. El lector NBT de aca no copia los arrays (quedan como vistas
// { t, o, n } sobre el buffer) y saltea lo que el mapa no usa (entidades, luz, estructuras, ticks...).
// Formatos:
//   modern  1.18+  (DataVersion >= 2860): sections[] en la raiz, block_states { palette, data } y biomes por seccion
//   flat    1.13-1.17: Level.Sections[] con Palette + BlockStates (hasta la 1.15 los valores cruzan los longs)
//   legacy  antes de la 1.13: Level.Sections[] con Blocks/Add/Data numericos
// Los paquetes de bits se detectan por el largo del array (con o sin valores que cruzan de un long al siguiente).

const SKIP = new Set([
  'block_entities', 'TileEntities', 'Entities', 'entities', 'structures', 'Structures', 'PostProcessing', 'fluid_ticks', 'block_ticks',
  'TileTicks', 'LiquidTicks', 'ToBeTicked', 'LiquidsToBeTicked', 'CarvingMasks', 'Lights', 'BlockLight', 'SkyLight', 'blending_data',
  'UpgradeData', 'below_zero_retrogen', 'InhabitedTime', 'LastUpdate', 'isLightOn', 'LightPopulated', 'ForgeCaps', 'ForgeDataVersion',
  'neoforge:attachments', 'fabric:attachments', 'Upgrade', 'ChunkBukkitValues', 'PaperData',
]);
const FIXED = [0, 1, 2, 4, 8, 4, 8];
const FULL = new Set(['full', 'minecraft:full', 'postprocessed', 'minecraft:postprocessed', 'fullchunk', 'minecraft:fullchunk']);

class NbtError extends Error {}

function mutf8(buf, start, end) {
  let out = '';
  let i = start;
  while (i < end) {
    const a = buf[i++];
    if (a < 0x80) out += String.fromCharCode(a);
    else if ((a & 0xe0) === 0xc0) out += String.fromCharCode(((a & 0x1f) << 6) | (buf[i++] & 0x3f));
    else {
      const b = buf[i++];
      const c = buf[i++];
      out += String.fromCharCode(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f));
    }
  }
  return out;
}

class Reader {
  constructor(buf) {
    this.b = buf;
    this.p = 0;
    this.end = buf.length;
  }
  need(n) {
    if (this.p + n > this.end) throw new NbtError('NBT truncado');
  }
  u8() {
    this.need(1);
    return this.b[this.p++];
  }
  i32() {
    this.need(4);
    const b = this.b;
    const p = this.p;
    this.p += 4;
    return (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
  }
  u16() {
    this.need(2);
    const v = (this.b[this.p] << 8) | this.b[this.p + 1];
    this.p += 2;
    return v;
  }
  str() {
    const n = this.u16();
    this.need(n);
    const s = this.p;
    const e = s + n;
    this.p = e;
    const b = this.b;
    for (let i = s; i < e; i++) if (b[i] & 0x80) return mutf8(b, s, e);
    return b.latin1Slice ? b.latin1Slice(s, e) : b.toString('latin1', s, e);
  }
  skip(t) {
    switch (t) {
      case 1:
      case 2:
      case 3:
      case 4:
      case 5:
      case 6:
        this.need(FIXED[t]);
        this.p += FIXED[t];
        return;
      case 7: {
        const n = this.i32();
        this.need(n);
        this.p += n;
        return;
      }
      case 8: {
        const n = this.u16();
        this.need(n);
        this.p += n;
        return;
      }
      case 9: {
        const it = this.u8();
        const n = this.i32();
        if (n <= 0) return;
        if (it >= 1 && it <= 6) {
          this.need(FIXED[it] * n);
          this.p += FIXED[it] * n;
          return;
        }
        for (let i = 0; i < n; i++) this.skip(it);
        return;
      }
      case 10:
        for (;;) {
          const tt = this.u8();
          if (tt === 0) return;
          const len = this.u16();
          this.need(len);
          this.p += len;
          this.skip(tt);
        }
      case 11: {
        const n = this.i32();
        this.need(n * 4);
        this.p += n * 4;
        return;
      }
      case 12: {
        const n = this.i32();
        this.need(n * 8);
        this.p += n * 8;
        return;
      }
      default:
        throw new NbtError(`NBT: tipo desconocido ${t}`);
    }
  }
  value(t) {
    switch (t) {
      case 1: {
        const v = this.u8();
        return v > 127 ? v - 256 : v;
      }
      case 2: {
        const v = this.u16();
        return v > 32767 ? v - 65536 : v;
      }
      case 3:
        return this.i32();
      case 4: {
        const hi = this.i32();
        const lo = this.i32() >>> 0;
        return hi * 4294967296 + lo;
      }
      case 5: {
        this.need(4);
        const v = this.b.readFloatBE(this.p);
        this.p += 4;
        return v;
      }
      case 6: {
        this.need(8);
        const v = this.b.readDoubleBE(this.p);
        this.p += 8;
        return v;
      }
      case 7: {
        const n = this.i32();
        this.need(n);
        const v = { t: 7, o: this.p, n };
        this.p += n;
        return v;
      }
      case 8:
        return this.str();
      case 9: {
        const it = this.u8();
        const n = this.i32();
        const arr = new Array(n > 0 ? n : 0);
        for (let i = 0; i < n; i++) arr[i] = this.value(it);
        return arr;
      }
      case 10:
        return this.compound();
      case 11: {
        const n = this.i32();
        this.need(n * 4);
        const v = { t: 11, o: this.p, n };
        this.p += n * 4;
        return v;
      }
      case 12: {
        const n = this.i32();
        this.need(n * 8);
        const v = { t: 12, o: this.p, n };
        this.p += n * 8;
        return v;
      }
      default:
        throw new NbtError(`NBT: tipo desconocido ${t}`);
    }
  }
  compound() {
    const obj = {};
    for (;;) {
      const t = this.u8();
      if (t === 0) return obj;
      const name = this.str();
      if (SKIP.has(name)) this.skip(t);
      else obj[name] = this.value(t);
    }
  }
  root() {
    const t = this.u8();
    if (t !== 10) throw new NbtError('NBT: la raiz no es un Compound');
    this.str();
    return this.compound();
  }
}

// ---------- Paquetes de bits ----------
// Devuelve { bits, vpl } (vpl = valores por long sin cruzar; 0 = bits continuos) o null si el largo no cierra.
function layout(n, entries, minBits) {
  for (let bits = Math.max(1, minBits); bits <= 32; bits++) {
    const vpl = Math.floor(64 / bits);
    if (Math.ceil(entries / vpl) === n) return { bits, vpl };
    if ((entries * bits) / 64 === n) return { bits, vpl: 0 };
  }
  return null;
}

// Palabra de 32 bits w de un array de longs big-endian, contando desde el bit menos significativo
function word(b, o, w) {
  const p = o + ((w >>> 1) << 3) + (w & 1 ? 0 : 4);
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

// Valor i de un array empaquetado
function packedAt(b, o, i, bits, vpl) {
  let bitIndex;
  if (vpl) {
    const li = (i / vpl) | 0;
    bitIndex = li * 64 + (i - li * vpl) * bits;
  } else bitIndex = i * bits;
  const w = bitIndex >>> 5;
  const s = bitIndex & 31;
  let v = word(b, o, w) >>> s;
  if (s + bits > 32) v |= word(b, o, w + 1) << (32 - s);
  return bits >= 32 ? v >>> 0 : v & ((1 << bits) - 1);
}

// Desempaqueta 4096 indices de paleta -> ids globales (out: Uint16Array(4096))
function unpackInto(b, sec, out) {
  const pal = sec.pal;
  const plen = pal.length;
  const { o, n } = sec.data;
  const bits = sec.bits;
  const mask = (1 << bits) - 1;
  if (sec.vpl) {
    const vpl = sec.vpl;
    let i = 0;
    for (let k = 0; k < n && i < 4096; k++) {
      const p = o + (k << 3);
      const hi = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      const lo = ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0;
      for (let j = 0, s = 0; j < vpl && i < 4096; j++, s += bits) {
        let v;
        if (s + bits <= 32) v = (lo >>> s) & mask;
        else if (s >= 32) v = (hi >>> (s - 32)) & mask;
        else v = ((lo >>> s) | (hi << (32 - s))) & mask;
        out[i++] = v < plen ? pal[v] : 0;
      }
    }
    if (i < 4096) out.fill(0, i);
  } else {
    let bitPos = 0;
    const maxWord = n * 2;
    for (let i = 0; i < 4096; i++) {
      const w = bitPos >>> 5;
      const s = bitPos & 31;
      if (w >= maxWord) {
        out.fill(0, i);
        break;
      }
      let v = word(b, o, w) >>> s;
      if (s + bits > 32 && w + 1 < maxWord) v |= word(b, o, w + 1) << (32 - s);
      v &= mask;
      out[i] = v < plen ? pal[v] : 0;
      bitPos += bits;
    }
  }
}

// Secciones viejas (antes de la 1.13): Blocks (8 bits) + Add (4 bits extra) + Data (metadato, 4 bits)
function unpackLegacy(b, sec, reg, out) {
  const bo = sec.blocks;
  const ao = sec.add;
  const mo = sec.meta;
  for (let i = 0; i < 4096; i++) {
    const half = i >> 1;
    let id = b[bo + i];
    if (ao >= 0) id |= (i & 1 ? b[ao + half] >> 4 : b[ao + half] & 15) << 8;
    const meta = mo >= 0 ? (i & 1 ? b[mo + half] >> 4 : b[mo + half] & 15) : 0;
    out[i] = reg.legacy(id, meta);
  }
}

// Buffers reutilizables para las secciones desempaquetadas (un chunk a la vez por hilo)
const POOL = [];
let poolUsed = 0;
function takeBuffer() {
  if (poolUsed >= POOL.length) POOL.push(new Uint16Array(4096));
  return POOL[poolUsed++];
}

// ---------- Modelo del chunk ----------
class Chunk {
  constructor(buf, reg) {
    this.buf = buf;
    this.reg = reg;
    this.format = 'unknown';
    this.dataVersion = 0;
    this.status = null;
    this.full = true;
    this.minSection = 0;
    this.secs = [];
    this.minY = 0;
    this.topY = -1;
    this.ws = null; // WORLD_SURFACE: altura del bloque mas alto + 1 (relativa a minY)
    this.of = null; // OCEAN_FLOOR
    this.biomeKind = 0; // 0 ninguno, 1 por seccion, 2 int 3D, 3 int 2D, 4 byte 2D
    this.biomeView = null;
  }

  section(y) {
    const si = (y >> 4) - this.minSection;
    return si >= 0 && si < this.secs.length ? this.secs[si] : null;
  }

  // Bloques ya desempaquetados de la seccion (se calcula la primera vez)
  blocks(sec) {
    if (sec.cache) return sec.cache;
    const out = takeBuffer();
    if (sec.legacyBlocks) unpackLegacy(this.buf, sec, this.reg, out);
    else if (!sec.data || sec.pal.length === 1) out.fill(sec.pal[0]);
    else unpackInto(this.buf, sec, out);
    sec.cache = out;
    return out;
  }

  block(x, y, z) {
    const sec = this.section(y);
    if (sec === null) return 0;
    return this.blocks(sec)[((y & 15) << 8) | (z << 4) | x];
  }

  biome(x, y, z) {
    const reg = this.reg;
    const b = this.buf;
    switch (this.biomeKind) {
      case 1: {
        let sec = this.section(y);
        if (sec === null || !sec.bpal) {
          // Arriba o abajo del mundo: la seccion valida mas cercana
          const si = Math.max(0, Math.min(this.secs.length - 1, (y >> 4) - this.minSection));
          sec = this.secs[si];
          if (!sec || !sec.bpal) return 0;
        }
        if (!sec.bdata || sec.bpal.length === 1) return sec.bpal[0];
        const i = (((y & 15) >> 2) << 4) | ((z >> 2) << 2) | (x >> 2);
        const v = packedAt(b, sec.bdata.o, i, sec.bbits, sec.bvpl);
        return v < sec.bpal.length ? sec.bpal[v] : 0;
      }
      case 2: {
        const v = this.biomeView;
        const layers = (v.n / 16) | 0;
        const layer = Math.max(0, Math.min(layers - 1, (y - this.minY) >> 2));
        const p = v.o + ((layer << 4) | ((z >> 2) << 2) | (x >> 2)) * 4;
        return reg.legacyBiome(((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) & 0xff);
      }
      case 3: {
        const p = this.biomeView.o + ((z << 4) | x) * 4;
        return reg.legacyBiome(b[p + 3]);
      }
      case 4:
        return reg.legacyBiome(b[this.biomeView.o + ((z << 4) | x)]);
      default:
        return 0;
    }
  }

  // Libera los buffers de las secciones (se reutilizan en el proximo chunk)
  release() {
    poolUsed = 0;
    for (const s of this.secs) if (s) s.cache = null;
  }
}

function paletteGids(reg, list) {
  const pal = new Int32Array(list.length || 1);
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    pal[i] = e && typeof e.Name === 'string' ? reg.block(e.Name, e.Properties || null) : 0;
  }
  return pal;
}

function biomePalette(reg, list) {
  const pal = new Int32Array(list.length || 1);
  for (let i = 0; i < list.length; i++) pal[i] = typeof list[i] === 'string' ? reg.biome(list[i]) : 0;
  return pal;
}

function markKinds(reg, sec) {
  if (!sec.pal) {
    sec.clear = false;
    sec.solid = false;
    return;
  }
  let clear = 0;
  for (let i = 0; i < sec.pal.length; i++) if (reg.K[sec.pal[i]] === 1) clear++;
  sec.clear = clear === sec.pal.length;
  sec.solid = clear === 0;
}

function newSection(y) {
  return { y, pal: null, data: null, bits: 0, vpl: 0, legacyBlocks: false, blocks: -1, add: -1, meta: -1, clear: false, solid: false, cache: null, bpal: null, bdata: null, bbits: 0, bvpl: 0 };
}

function decodeHeights(view) {
  if (!view || view.t !== 12 || !view.n) return null;
  const lay = layout(view.n, 256, 9) || layout(view.n, 256, 1);
  return lay ? lay : null;
}

function readHeights(buf, view) {
  const lay = decodeHeights(view);
  if (!lay) return null;
  const out = new Int16Array(256);
  for (let i = 0; i < 256; i++) out[i] = packedAt(buf, view.o, i, lay.bits, lay.vpl);
  return out;
}

function placeSections(ch, list, minSectionHint) {
  const withBlocks = list.filter((s) => s.pal || s.legacyBlocks);
  if (!withBlocks.length) {
    ch.secs = [];
    ch.minSection = minSectionHint ?? 0;
    return;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const s of withBlocks) {
    if (s.y < min) min = s.y;
    if (s.y > max) max = s.y;
  }
  if (Number.isInteger(minSectionHint) && minSectionHint < min) min = minSectionHint;
  ch.minSection = min;
  ch.secs = new Array(max - min + 1).fill(null);
  for (const s of withBlocks) ch.secs[s.y - min] = s;
  ch.topY = max * 16 + 15;
}

// buf: NBT sin comprimir. Devuelve un Chunk (format 'unknown' si no se reconoce).
function decodeChunk(buf, reg) {
  const root = new Reader(buf).root();
  const ch = new Chunk(buf, reg);
  ch.dataVersion = typeof root.DataVersion === 'number' ? root.DataVersion : 0;
  const lvl = root.Level && typeof root.Level === 'object' && !Array.isArray(root.Level) ? root.Level : null;

  if (!lvl && Array.isArray(root.sections)) {
    // 1.18+
    ch.format = 'modern';
    ch.status = typeof root.Status === 'string' ? root.Status : null;
    const list = [];
    for (const s of root.sections) {
      if (!s || typeof s.Y !== 'number') continue;
      const sec = newSection(s.Y);
      const bs = s.block_states;
      if (bs && Array.isArray(bs.palette) && bs.palette.length) {
        sec.pal = paletteGids(reg, bs.palette);
        if (bs.data && bs.data.t === 12 && bs.data.n && sec.pal.length > 1) {
          const lay = layout(bs.data.n, 4096, Math.max(4, Math.ceil(Math.log2(sec.pal.length))));
          if (lay) {
            sec.data = bs.data;
            sec.bits = lay.bits;
            sec.vpl = lay.vpl;
          }
        }
        markKinds(reg, sec);
      }
      const bi = s.biomes;
      if (bi && Array.isArray(bi.palette) && bi.palette.length) {
        sec.bpal = biomePalette(reg, bi.palette);
        if (bi.data && bi.data.t === 12 && bi.data.n && sec.bpal.length > 1) {
          const lay = layout(bi.data.n, 64, Math.ceil(Math.log2(sec.bpal.length)));
          if (lay) {
            sec.bdata = bi.data;
            sec.bbits = lay.bits;
            sec.bvpl = lay.vpl;
          }
        }
      }
      list.push(sec);
    }
    const yPos = typeof root.yPos === 'number' ? root.yPos : null;
    placeSections(ch, list, yPos);
    ch.minY = (yPos ?? ch.minSection) * 16;
    ch.biomeKind = 1;
    const hm = root.Heightmaps || {};
    ch.ws = readHeights(buf, hm.WORLD_SURFACE);
    ch.of = readHeights(buf, hm.OCEAN_FLOOR);
  } else if (lvl && Array.isArray(lvl.Sections) && lvl.Sections.some((s) => s && s.Blocks)) {
    // Antes de la 1.13
    ch.format = 'legacy';
    ch.status = null;
    const list = [];
    for (const s of lvl.Sections) {
      if (!s || typeof s.Y !== 'number' || !s.Blocks || s.Blocks.n !== 4096) continue;
      const sec = newSection(s.Y);
      sec.legacyBlocks = true;
      sec.blocks = s.Blocks.o;
      sec.add = s.Add && s.Add.n === 2048 ? s.Add.o : -1;
      sec.meta = s.Data && s.Data.n === 2048 ? s.Data.o : -1;
      list.push(sec);
    }
    placeSections(ch, list, null);
    ch.minY = 0;
    const hm = lvl.HeightMap;
    if (hm && hm.t === 11 && hm.n === 256) {
      ch.ws = new Int16Array(256);
      for (let i = 0; i < 256; i++) {
        const p = hm.o + i * 4;
        ch.ws[i] = (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
      }
    }
    if (lvl.Biomes && lvl.Biomes.t === 7 && lvl.Biomes.n === 256) {
      ch.biomeKind = 4;
      ch.biomeView = lvl.Biomes;
    } else if (lvl.Biomes && lvl.Biomes.t === 11 && lvl.Biomes.n === 256) {
      ch.biomeKind = 3;
      ch.biomeView = lvl.Biomes;
    }
  } else if (lvl && Array.isArray(lvl.Sections)) {
    // 1.13 - 1.17
    ch.format = 'flat';
    ch.status = typeof lvl.Status === 'string' ? lvl.Status : null;
    const list = [];
    for (const s of lvl.Sections) {
      if (!s || typeof s.Y !== 'number' || !Array.isArray(s.Palette) || !s.Palette.length) continue;
      const sec = newSection(s.Y);
      sec.pal = paletteGids(reg, s.Palette);
      const data = s.BlockStates;
      if (data && data.t === 12 && data.n && sec.pal.length > 1) {
        const lay = layout(data.n, 4096, Math.max(4, Math.ceil(Math.log2(sec.pal.length))));
        if (lay) {
          sec.data = data;
          sec.bits = lay.bits;
          sec.vpl = lay.vpl;
        }
      }
      markKinds(reg, sec);
      list.push(sec);
    }
    placeSections(ch, list, null);
    ch.minY = 0;
    const hm = lvl.Heightmaps || {};
    ch.ws = readHeights(buf, hm.WORLD_SURFACE);
    ch.of = readHeights(buf, hm.OCEAN_FLOOR);
    const bio = lvl.Biomes;
    if (bio && bio.t === 11 && bio.n >= 1024 && bio.n % 16 === 0) {
      ch.biomeKind = 2;
      ch.biomeView = bio;
    } else if (bio && bio.t === 11 && bio.n === 256) {
      ch.biomeKind = 3;
      ch.biomeView = bio;
    } else if (bio && bio.t === 7 && bio.n === 256) {
      ch.biomeKind = 4;
      ch.biomeView = bio;
    }
  } else {
    return ch;
  }
  ch.full = !ch.status || FULL.has(ch.status);
  return ch;
}

module.exports = { decodeChunk, Reader, layout, packedAt, NbtError, Chunk };
