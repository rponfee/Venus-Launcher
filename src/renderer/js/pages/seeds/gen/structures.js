// Estructuras 1.18+: posicion por region, validacion por biomas y terreno, fortalezas, punto de aparicion y slime chunks.
// Port de finders.c y finders.h de cubiomes (MIT, ver LICENSE-cubiomes.txt).
//
// Que tan exacto es cada paso: la posicion candidata de una region sale del mismo calculo que usa el juego. Que la
// estructura aparezca ahi depende ademas de chequeos que cubiomes aproxima: biomas en un punto y altura del terreno
// estimada desde la profundidad (isViableStructureTerrain). Por eso la interfaz dice que eso es una estimacion y muestra
// aparte las que quedan en duda (evaluate).
import { JavaRandom, mul48, add48, splitInt, bigToLimbs, rHi, rLo } from './rng.js';
import { MC_1_19_2, MC_1_20, MC_1_21_1 } from './versions.js';
import * as B from './biomes.js';

const TWO24 = 16777216;
const MASK24 = 0xffffff;
const SURFACE_Y = 319 >> 2;

// salt, tamano de region y rango en chunks; `large` promedia dos numeros por eje (getLargeStructurePos)
export const STRUCTURES = {
  desert_pyramid: { salt: 14357617, size: 32, range: 24 },
  jungle_temple: { salt: 14357619, size: 32, range: 24 },
  swamp_hut: { salt: 14357620, size: 32, range: 24 },
  igloo: { salt: 14357618, size: 32, range: 24 },
  village: { salt: 10387312, size: 34, range: 26 },
  monument: { salt: 10387313, size: 32, range: 27, large: true },
  mansion: { salt: 10387319, size: 80, range: 60, large: true },
  outpost: { salt: 165745296, size: 32, range: 24 },
  ancient_city: { salt: 20083232, size: 24, range: 16, minMc: MC_1_19_2 },
  trail_ruins: { salt: 83469867, size: 34, range: 26, minMc: MC_1_20 },
  trial_chambers: { salt: 94251327, size: 34, range: 22, minMc: MC_1_21_1 },
  fortress: { salt: 30084232, size: 27, range: 23, nether: true },
  bastion: { salt: 30084232, size: 27, range: 23, nether: true },
};

// Estructuras de cada dimension que se calculan por regiones; las fortalezas (stronghold) van aparte
export const OVERWORLD_TYPES = ['village', 'desert_pyramid', 'jungle_temple', 'swamp_hut', 'igloo', 'monument', 'mansion', 'outpost', 'ancient_city', 'trail_ruins', 'trial_chambers'];
export const NETHER_TYPES = ['fortress', 'bastion'];

const has = (type, mc) => !STRUCTURES[type].minMc || mc >= STRUCTURES[type].minMc;
export const typesFor = (dim, mc) => (dim === 0 ? OVERWORLD_TYPES : dim === -1 ? NETHER_TYPES : []).filter((t) => has(t, mc));

// regX*341873128712 + regZ*132897987541: las dos constantes partidas en mitades de 24 bits
const REG_X_HI = Math.floor(341873128712 / TWO24);
const REG_X_LO = 341873128712 % TWO24;
const REG_Z_HI = Math.floor(132897987541 / TWO24);
const REG_Z_LO = 132897987541 % TWO24;

// isViableFeatureBiome() para 1.18+
const OUTPOST_BIOMES = new Set([B.DESERT, B.PLAINS, B.SAVANNA, B.SNOWY_PLAINS, B.TAIGA, B.MEADOW, B.FROZEN_PEAKS, B.JAGGED_PEAKS, B.STONY_PEAKS, B.SNOWY_SLOPES, B.GROVE, B.CHERRY_GROVE]);
const TRAIL_BIOMES = new Set([B.TAIGA, B.SNOWY_TAIGA, B.OLD_GROWTH_PINE_TAIGA, B.OLD_GROWTH_SPRUCE_TAIGA, B.OLD_GROWTH_BIRCH_FOREST, B.JUNGLE]);
const VILLAGE_TYPES = [B.PLAINS, B.DESERT, B.SAVANNA, B.TAIGA, B.SNOWY_PLAINS];

function viableBiome(type, mc, id) {
  switch (type) {
    case 'desert_pyramid':
      return id === B.DESERT;
    case 'jungle_temple':
      return id === B.JUNGLE || id === B.BAMBOO_JUNGLE;
    case 'swamp_hut':
      return id === B.SWAMP;
    case 'igloo':
      return id === B.SNOWY_PLAINS || id === B.SNOWY_TAIGA || id === B.SNOWY_SLOPES;
    case 'ancient_city':
      return id === B.DEEP_DARK;
    case 'trail_ruins':
      return TRAIL_BIOMES.has(id);
    case 'trial_chambers':
      return id !== B.DEEP_DARK && B.isOverworld(mc, id);
    case 'outpost':
      return OUTPOST_BIOMES.has(id);
    case 'mansion':
      return id === B.DARK_FOREST;
    case 'bastion':
      return id === B.NETHER_WASTES || id === B.SOUL_SAND_VALLEY || id === B.WARPED_FOREST || id === B.CRIMSON_FOREST;
    default:
      return false;
  }
}

// Oceanos y rios alrededor de un monumento
const MONUMENT_AREA = new Set([B.OCEAN, B.DEEP_OCEAN, B.RIVER, B.FROZEN_RIVER, B.FROZEN_OCEAN, B.DEEP_FROZEN_OCEAN, B.COLD_OCEAN, B.DEEP_COLD_OCEAN, B.LUKEWARM_OCEAN, B.DEEP_LUKEWARM_OCEAN, B.WARM_OCEAN, B.DEEP_WARM_OCEAN]);

function strongholdBiomes(mc) {
  const ok = new Uint8Array(256);
  for (let id = 0; id < 256; id++) {
    if ((id >= 64 && id < 128) || id >= 192) continue;
    if (!B.isOverworld(mc, id) || B.isOceanic(id)) continue;
    if (id === B.SWAMP || id === B.RIVER || id === B.FROZEN_RIVER || id === B.BEACH || id === B.SNOWY_BEACH || id === 25 /* stony_shore */ || id === B.MANGROVE_SWAMP || id === B.DEEP_DARK) continue;
    ok[id] = 1;
  }
  return ok;
}

// Redondeo de C: las mitades se alejan del cero
const cRound = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));

export class StructureFinder {
  // `overworld` y `nether` son los generadores de biomas de esa dimension (uno de los dos puede faltar)
  constructor({ seed, mc, overworld = null, nether = null }) {
    this.seed = seed;
    this.mc = mc;
    this.overworld = overworld;
    this.nether = nether;
    bigToLimbs(seed);
    this.sHi = rHi;
    this.sLo = rLo;
    this.rng = new JavaRandom();
    // chunkGenerateRnd(): los dos nextLong() de la semilla salen una sola vez
    const r = new JavaRandom().setSeed(seed);
    bigToLimbs(r.nextLong());
    this.aHi = rHi;
    this.aLo = rLo;
    bigToLimbs(r.nextLong());
    this.bHi = rHi;
    this.bLo = rLo;
    this.x = 0;
    this.z = 0;
    // Resultado de variant()
    this.v = { rotation: 0, start: 0, abandoned: false, x: 0, z: 0, sx: 0, sz: 0, y: 320 };
    this.strongOk = null;
  }

  // ---------- Posicion en una region ----------
  regionRng(cfg, rx, rz) {
    mul48(REG_X_HI, REG_X_LO, rx);
    let hi = rHi;
    let lo = rLo;
    mul48(REG_Z_HI, REG_Z_LO, rz);
    add48(hi, lo, rHi, rLo);
    add48(rHi, rLo, this.sHi, this.sLo);
    hi = rHi;
    lo = rLo;
    splitInt(cfg.salt);
    add48(hi, lo, rHi, rLo);
    this.rng.setLimbs(rHi, rLo);
    return this.rng;
  }

  // getFeaturePos(): sin el rechazo de nextInt, como cubiomes (pasa una vez cada miles de millones)
  featurePos(cfg, rx, rz) {
    const rng = this.regionRng(cfg, rx, rz);
    const r = cfg.range;
    let cx;
    let cz;
    if (r & (r - 1)) {
      cx = rng.next31() % r;
      cz = rng.next31() % r;
    } else {
      cx = Math.floor((r * rng.next31()) / 2147483648);
      cz = Math.floor((r * rng.next31()) / 2147483648);
    }
    this.x = (rx * cfg.size + cx) * 16;
    this.z = (rz * cfg.size + cz) * 16;
  }

  largePos(cfg, rx, rz) {
    const rng = this.regionRng(cfg, rx, rz);
    const r = cfg.range;
    let cx = rng.next31() % r;
    cx += rng.next31() % r;
    let cz = rng.next31() % r;
    cz += rng.next31() % r;
    this.x = (rx * cfg.size + (cx >> 1)) * 16;
    this.z = (rz * cfg.size + (cz >> 1)) * 16;
  }

  // chunkGenerateRnd()
  chunkRng(cx, cz) {
    mul48(this.aHi, this.aLo, cx);
    const hi = rHi;
    const lo = rLo;
    mul48(this.bHi, this.bLo, cz);
    this.rng.setLimbs(hi ^ rHi ^ this.sHi, lo ^ rLo ^ this.sLo);
    return this.rng;
  }

  // setAttemptSeed()
  attemptRng(cx, cz) {
    splitInt(cx >> 4);
    const hi = rHi;
    const lo = rLo;
    splitInt((cz >> 4) * 16);
    this.rng.setLimbs(this.sHi ^ hi ^ rHi, this.sLo ^ lo ^ rLo);
    this.rng.next31();
    return this.rng;
  }

  // getStructurePos(): false si en esa region no hay intento. La posicion queda en this.x y this.z (bloques)
  position(type, rx, rz) {
    const cfg = STRUCTURES[type];
    if (cfg.large) {
      this.largePos(cfg, rx, rz);
      return true;
    }
    this.featurePos(cfg, rx, rz);
    if (type === 'outpost') return this.attemptRng(this.x >> 4, this.z >> 4).nextInt(5) === 0;
    if (type === 'bastion') return this.chunkRng(this.x >> 4, this.z >> 4).nextInt(5) >= 2;
    return true;
  }

  // ---------- Variantes (getVariant) ----------
  // true si se pudo calcular; rellena this.v
  variant(type, x, z, biome) {
    const v = this.v;
    const rng = this.chunkRng(x >> 4, z >> 4);
    v.rotation = 0;
    v.start = -1;
    v.abandoned = false;
    v.x = 0;
    v.z = 0;
    v.sx = 0;
    v.sz = 0;
    v.y = 320;
    let sx;
    let sz;
    if (type === 'village') {
      v.rotation = rng.nextInt(4);
      [sx, sz] = villageSize(rng, biome, v);
    } else if (type === 'bastion') {
      v.rotation = rng.nextInt(4);
      v.start = rng.nextInt(4);
      [sx, sz] = [[46, 46], [30, 48], [38, 38], [16, 32]][v.start];
    } else if (type === 'ancient_city') {
      v.rotation = rng.nextInt(4);
      v.start = 1 + rng.nextInt(3);
      sx = 18;
      sz = 41;
      let px;
      let pz;
      switch (v.rotation) {
        case 0:
          px = x > 0 ? -1 : 0;
          pz = z > 0 ? -1 : 0;
          v.sx = sx;
          v.sz = sz;
          v.x = px - 13;
          v.z = pz - 20;
          break;
        case 1:
          px = (x < 0 ? 1 : 0) - sz;
          pz = z > 0 ? -1 : 0;
          v.sx = sz;
          v.sz = sx;
          v.x = px + 20;
          v.z = pz - 13;
          break;
        case 2:
          px = (x < 0 ? 1 : 0) - sx;
          pz = (z < 0 ? 1 : 0) - sz;
          v.sx = sx;
          v.sz = sz;
          v.x = px + 13;
          v.z = pz + 20;
          break;
        default:
          px = x > 0 ? -1 : 0;
          pz = (z < 0 ? 1 : 0) - sx;
          v.sx = sz;
          v.sz = sx;
          v.x = px - 20;
          v.z = pz + 13;
      }
      v.y = -27;
      return;
    } else if (type === 'trial_chambers') {
      v.y = rng.nextInt(21) - 40;
      v.rotation = rng.nextInt(4);
      v.start = rng.nextInt(2);
      v.sx = 19;
      v.sz = 19;
      if (v.rotation === 1) v.x = -18;
      else if (v.rotation === 2) {
        v.x = -18;
        v.z = -18;
      } else if (v.rotation === 3) v.z = -18;
      return;
    }
    switch (v.rotation) {
      case 0:
        v.sx = sx;
        v.sz = sz;
        break;
      case 1:
        v.x = 1 - sz;
        v.sx = sz;
        v.sz = sx;
        break;
      case 2:
        v.x = 1 - sx;
        v.z = 1 - sz;
        v.sx = sx;
        v.sz = sz;
        break;
      default:
        v.z = 1 - sx;
        v.sx = sz;
        v.sz = sx;
    }
  }

  // Celda 1:4 del centro de la pieza inicial
  centerCell(chunk, off, size) {
    return Math.trunc((chunk * 32 + 2 * off + size - 1) / 2) >> 2;
  }

  // ---------- Validacion por biomas (isViableStructurePos) ----------
  // 0 si no puede aparecer ahi; si no, 1 (o el bioma de la aldea)
  viable(type, x, z) {
    const cx = x >> 4;
    const cz = z >> 4;
    const mc = this.mc;
    switch (type) {
      case 'fortress': {
        const cfg = STRUCTURES.fortress;
        // En 1.18+ una fortaleza del Nether aparece donde no hay un bastion: comparten posicion
        const size = cfg.size * 16;
        if (!this.position('bastion', Math.floor(x / size), Math.floor(z / size))) return 1;
        return this.viable('bastion', x, z) ? 0 : 1;
      }
      case 'bastion': {
        this.variant('bastion', x, z, -1);
        const sx = this.centerCell(cx, this.v.x, this.v.sx);
        const sz = this.centerCell(cz, this.v.z, this.v.sz);
        return viableBiome('bastion', mc, this.nether.biome(sx, sz)) ? 1 : 0;
      }
      case 'desert_pyramid':
      case 'jungle_temple':
      case 'swamp_hut':
      case 'igloo':
      case 'trail_ruins':
        return viableBiome(type, mc, this.overworld.biome(cx * 4 + 2, SURFACE_Y, cz * 4 + 2)) ? 1 : 0;
      case 'village': {
        for (const biome of VILLAGE_TYPES) {
          this.variant('village', x, z, biome);
          const id = this.overworld.biome(this.centerCell(cx, this.v.x, this.v.sx), SURFACE_Y, this.centerCell(cz, this.v.z, this.v.sz));
          if (id === biome || (id === B.MEADOW && biome === B.PLAINS)) return biome;
        }
        return 0;
      }
      case 'outpost':
        return this.outpostViable(cx, cz) ? 1 : 0;
      case 'monument': {
        const sx = cx * 16 + 8;
        const sz = cz * 16 + 8;
        if (!B.isDeepOcean(this.overworld.biome(sx >> 2, 36 >> 2, sz >> 2))) return 0;
        return this.areaViable(sx, 63, sz, 29, MONUMENT_AREA) ? 1 : 0;
      }
      case 'mansion': {
        const sx = cx * 16 + 7;
        const sz = cz * 16 + 7;
        return viableBiome(type, mc, this.overworld.biome(sx >> 2, SURFACE_Y, sz >> 2)) ? 1 : 0;
      }
      case 'ancient_city':
      case 'trial_chambers': {
        this.variant(type, x, z, -1);
        const v = this.v;
        return viableBiome(type, mc, this.overworld.biome(this.centerCell(cx, v.x, v.sx), v.y >> 2, this.centerCell(cz, v.z, v.sz))) ? 1 : 0;
      }
      default:
        return 0;
    }
  }

  outpostViable(cx, cz) {
    if (this.attemptRng(cx, cz).nextInt(5) !== 0) return false;
    // Un puesto no aparece a menos de 10 chunks de un intento de aldea, aunque esa aldea no llegue a generarse
    const cfg = STRUCTURES.village;
    const x0 = cx - 10;
    const x1 = cx + 10;
    const z0 = cz - 10;
    const z1 = cz + 10;
    const rx0 = Math.floor(x0 / cfg.size);
    const rx1 = Math.floor(x1 / cfg.size);
    const rz0 = Math.floor(z0 / cfg.size);
    const rz1 = Math.floor(z1 / cfg.size);
    for (let rz = rz0; rz <= rz1; rz++) {
      for (let rx = rx0; rx <= rx1; rx++) {
        this.featurePos(cfg, rx, rz);
        const vx = this.x >> 4;
        const vz = this.z >> 4;
        if (vx >= x0 && vx <= x1 && vz >= z0 && vz <= z1) return false;
      }
    }
    const rot = this.chunkRng(cx, cz).nextInt(4);
    const offX = rot === 0 || rot === 3 ? 15 : -15;
    const offZ = rot === 0 || rot === 1 ? 15 : -15;
    const sx = Math.trunc((cx * 32 + offX) / 2) >> 2;
    const sz = Math.trunc((cz * 32 + offZ) / 2) >> 2;
    return viableBiome('outpost', this.mc, this.overworld.biome(sx, SURFACE_Y, sz));
  }

  // areBiomesViable(): esquinas y despues toda el area, a una sola altura
  areaViable(x, yIn, z, rad, valid) {
    const x1 = (x - rad) >> 2;
    const x2 = (x + rad) >> 2;
    const z1 = (z - rad) >> 2;
    const z2 = (z + rad) >> 2;
    const y = (yIn - rad) >> 2;
    const w = this.overworld;
    if (!valid.has(w.biome(x1, y, z1)) || !valid.has(w.biome(x2, y, z2)) || !valid.has(w.biome(x1, y, z2)) || !valid.has(w.biome(x2, y, z1))) return false;
    const hint = { node: 0 };
    for (let i = x1; i <= x2; i++) {
      hint.node = 0;
      for (let j = z1; j <= z2; j++) {
        if (!valid.has(w.biomeHinted(i, y, j, hint))) return false;
      }
    }
    return true;
  }

  // ---------- Terreno (isViableStructureTerrain) ----------
  terrain(type, xIn, zIn) {
    let x = xIn;
    let z = zIn;
    let sx;
    let sz;
    if (type === 'desert_pyramid') {
      sx = 21;
      sz = 21;
    } else if (type === 'jungle_temple') {
      sx = 12;
      sz = 15;
    } else if (type === 'mansion') {
      const cx = x >> 4;
      const cz = z >> 4;
      const rot = this.chunkRng(cx, cz).nextInt(4);
      sx = rot === 0 || rot === 1 ? -5 : 5;
      sz = rot === 1 || rot === 2 ? -5 : 5;
      x = cx * 16 + 7;
      z = cz * 16 + 7;
    } else return true;
    const w = this.overworld;
    return !(w.depthAt(x / 4, z / 4) < 0.48 || w.depthAt((x + sx) / 4, (z + sz) / 4) < 0.48 || w.depthAt(x / 4, (z + sz) / 4) < 0.48 || w.depthAt((x + sx) / 4, z / 4) < 0.48);
  }

  // ---------- Una region completa ----------
  // { x, z, biome? } si cubiomes da la estructura por valida; { x, z, doubt: true } si la estimacion la descarta por poco y
  // podria estar igual (ver doubtful); null si no hay nada
  evaluate(type, rx, rz) {
    if (!this.position(type, rx, rz)) return null;
    const x = this.x;
    const z = this.z;
    const v = this.viable(type, x, z);
    if (!v) return this.doubtful(type, x, z) ? { x, z, doubt: true } : null;
    if (this.overworld && !this.terrain(type, x, z)) return { x, z, doubt: true };
    return type === 'village' ? { x, z, biome: v } : { x, z };
  }

  // Comparado con listas publicadas de semillas, la validacion descarta algunas ciudades antiguas que existen: en el punto
  // que revisa no hay Abismo, pero empieza justo una celda mas abajo. Esto no sale de cubiomes: solo sirve para mostrarlas
  // como dudosas en lugar de esconderlas.
  doubtful(type, x, z) {
    if (type !== 'ancient_city') return false;
    this.variant(type, x, z, -1);
    const v = this.v;
    return this.overworld.biome(this.centerCell(x >> 4, v.x, v.sx), (v.y >> 2) - 1, this.centerCell(z >> 4, v.z, v.sz)) === B.DEEP_DARK;
  }

  // ---------- Fortalezas (stronghold) ----------
  // Generador: va devolviendo { x, z } de las 128. initFirstStronghold() + nextStronghold()
  *strongholds() {
    if (!this.strongOk) this.strongOk = strongholdBiomes(this.mc);
    const rnds = new JavaRandom().setSeed(this.seed);
    let angle = 2 * Math.PI * rnds.nextDouble();
    let dist = 4 * 32 + (rnds.nextDouble() - 0.5) * 32 * 2.5;
    let approxX = cRound(Math.cos(angle) * dist) * 16 + 8;
    let approxZ = cRound(Math.sin(angle) * dist) * 16 + 8;
    let index = 0;
    let ringnum = 0;
    let ringmax = 3;
    let ringidx = 0;
    const lbr = new JavaRandom();
    const local = this.mc > MC_1_19_2;
    while (index < 128) {
      if (local) lbr.setSeed(rnds.nextLong());
      const pos = this.locateBiome(approxX, 0, approxZ, 112, this.strongOk, local ? lbr : rnds);
      yield { x: (pos.x & ~15) + 4, z: (pos.z & ~15) + 4 };
      ringidx++;
      angle += (2 * Math.PI) / ringmax;
      if (ringidx === ringmax) {
        ringnum++;
        ringidx = 0;
        ringmax += Math.trunc((2 * ringmax) / (ringnum + 1));
        if (ringmax > 128 - index) ringmax = 128 - index;
        angle += rnds.nextDouble() * Math.PI * 2;
      }
      dist = 4 * 32 + 6 * ringnum * 32 + (rnds.nextDouble() - 0.5) * 32 * 2.5;
      approxX = cRound(Math.cos(angle) * dist) * 16 + 8;
      approxZ = cRound(Math.sin(angle) * dist) * 16 + 8;
      index++;
    }
  }

  // locateBiome() en 1.18+: recorre el area con el resultado anterior de partida, como el juego
  locateBiome(xIn, y, zIn, radIn, valid, rng) {
    const x = xIn >> 2;
    const z = zIn >> 2;
    const radius = radIn >> 2;
    const out = { x: xIn, z: zIn };
    const hint = { node: 0 };
    const w = this.overworld;
    let found = 0;
    for (let j = -radius; j <= radius; j++) {
      for (let i = -radius; i <= radius; i++) {
        const id = w.biomeHinted(x + i, y, z + j, hint);
        if (!valid[id]) continue;
        if (found === 0 || rng.nextInt(found + 1) === 0) {
          out.x = (x + i) * 4;
          out.z = (z + j) * 4;
        }
        found++;
      }
    }
    return out;
  }

  // ---------- Punto de aparicion (getSpawn en 1.18+): siempre aproximado ----------
  findFittest(p, maxrad, step) {
    const w = this.overworld;
    const newFormula = this.mc > MC_1_21_1;
    const ox = p.x;
    const oz = p.z;
    for (let rad = step; rad <= maxrad; rad += step) {
      for (let ang = 0; ang <= Math.PI * 2; ang += step / rad) {
        const x = ox + Math.trunc(Math.sin(ang) * rad);
        const z = oz + Math.trunc(Math.cos(ang) * rad);
        const fit = w.spawnFitness(x, z, newFormula);
        if (fit < p.fitness) {
          p.x = x;
          p.z = z;
          p.fitness = fit;
        }
      }
    }
  }

  // estimateSpawn(): el lugar con mejor clima cerca del origen
  estimateSpawn() {
    const p = { x: 0, z: 0, fitness: this.overworld.spawnFitness(0, 0, this.mc > MC_1_21_1) };
    this.findFittest(p, 2048, 512);
    this.findFittest(p, 512, 32);
    return { x: (p.x & ~15) + 8, z: (p.z & ~15) + 8 };
  }

  // getSpawn(): busca en espiral un lugar por encima del nivel del mar
  spawn() {
    const est = this.estimateSpawn();
    const w = this.overworld;
    let j = 0;
    let k = 0;
    let u = 0;
    let v = -1;
    for (let i = 0; i < 121; i++) {
      if (j >= -5 && j <= 5 && k >= -5 && k <= 5) {
        const cx0 = (est.x & ~15) + j * 16;
        const cz0 = (est.z & ~15) + k * 16;
        for (let ii = 0; ii < 4; ii++) {
          for (let jj = 0; jj < 4; jj++) {
            const x = cx0 + ii * 4;
            const z = cz0 + jj * 4;
            const y = w.approxHeight(x >> 2, z >> 2);
            const id = w.lastBiome;
            if (y > 63 || id === B.FROZEN_OCEAN || id === B.DEEP_FROZEN_OCEAN || id === B.FROZEN_RIVER) return { x, z };
          }
        }
      }
      if (j === k || (j < 0 && j === -k) || (j > 0 && j === 1 - k)) {
        const tmp = u;
        u = -v;
        v = tmp;
      }
      j += u;
      k += v;
    }
    return { x: (est.x & ~15) + 8, z: (est.z & ~15) + 8 };
  }
}

function villageSize(rng, biome, v) {
  const pick = (table, total) => {
    const t = rng.nextInt(total);
    for (const [limit, start, sx, sz, abandoned] of table) {
      if (t < limit) {
        v.start = start;
        v.abandoned = Boolean(abandoned);
        return [sx, sz];
      }
    }
    return [0, 0];
  };
  switch (biome) {
    case B.PLAINS:
      return pick([[50, 0, 9, 9], [100, 1, 10, 10], [150, 2, 8, 15], [200, 3, 11, 11], [201, 0, 9, 9, 1], [202, 1, 10, 10, 1], [203, 2, 8, 15, 1], [204, 3, 11, 11, 1]], 204);
    case B.DESERT:
      return pick([[98, 1, 17, 9], [196, 2, 12, 12], [245, 3, 15, 15], [247, 1, 17, 9, 1], [249, 2, 12, 12, 1], [250, 3, 15, 15, 1]], 250);
    case B.SAVANNA:
      return pick([[100, 1, 14, 12], [150, 2, 11, 11], [300, 3, 9, 11], [450, 4, 9, 9], [452, 1, 14, 12, 1], [453, 2, 11, 11, 1], [456, 3, 9, 11, 1], [459, 4, 9, 9, 1]], 459);
    case B.TAIGA:
      return pick([[49, 1, 22, 18], [98, 2, 9, 9], [99, 1, 22, 18, 1], [100, 2, 9, 9, 1]], 100);
    default:
      return pick([[100, 1, 12, 8], [150, 2, 11, 9], [300, 3, 7, 7], [302, 1, 12, 8, 1], [303, 2, 11, 9, 1], [306, 3, 7, 7, 1]], 306);
  }
}

// ---------- Slime chunks ----------
// isSlimeChunk() de finders.h, igual a la formula del juego: `s` es { hi, lo } de la semilla (48 bits)
const slimeRng = new JavaRandom();
export function isSlimeChunk(sHi, sLo, cx, cz) {
  splitInt(Math.imul(cx, 0x5ac0db));
  add48(sHi, sLo, rHi, rLo);
  let hi = rHi;
  let lo = rLo;
  splitInt(Math.imul(Math.imul(cx, cx), 0x4c1906));
  add48(hi, lo, rHi, rLo);
  hi = rHi;
  lo = rLo;
  splitInt(Math.imul(cz, 0x5f24f));
  add48(hi, lo, rHi, rLo);
  hi = rHi;
  lo = rLo;
  mul48(0, 0x4307a7, Math.imul(cz, cz));
  add48(hi, lo, rHi, rLo);
  hi = rHi;
  lo = rLo ^ (0x3ad8025f & MASK24);
  hi ^= 0x3ad8025f >> 24;
  slimeRng.setLimbs(hi, lo);
  return slimeRng.nextInt(10) === 0;
}

export function seedLimbs(seed) {
  bigToLimbs(seed);
  return { hi: rHi, lo: rLo };
}
