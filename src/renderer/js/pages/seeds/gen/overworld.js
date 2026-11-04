// Biomas del Overworld 1.18+: los 6 parametros climaticos y su bioma. Port de biomenoise.c de cubiomes (MIT, ver
// LICENSE-cubiomes.txt). El juego hace estas cuentas en float: cada operacion de cubiomes en float lleva su Math.fround y
// las que van en double quedan sin redondear; mezclarlas cambia el resultado en los bordes de un bioma.
import { Xoroshiro } from './rng.js';
import { xDoublePerlin, sampleDoublePerlin } from './noise.js';
import { nearestNode, biomeOfNode } from './tree.js';

const F = Math.fround;
const lerp = (part, from, to) => from + part * (to - from);

// ---------- Curva de profundidad (el "offset" del terreno) ----------
const SP_CONTINENTALNESS = 0;
const SP_EROSION = 1;
const SP_RIDGES = 2;

const fix = (val) => ({ fixed: true, val: F(val) });
const curve = (typ) => ({ fixed: false, typ, loc: [], der: [], val: [] });
function add(sp, loc, val, der) {
  sp.loc.push(F(loc));
  sp.val.push(val);
  sp.der.push(F(der));
}

const N0_46 = F(0.46082947);
const N1_17 = F(1.17);
const N0_7 = F(-0.7);

function offsetValue(weirdness, continentalness) {
  const f0 = F(1 - F(F(1 - continentalness) * 0.5));
  const f1 = F(0.5 * F(1 - continentalness));
  const f2 = F(F(weirdness + N1_17) * N0_46);
  const off = F(F(f2 * f0) - f1);
  if (weirdness < N0_7) return off > F(-0.2222) ? off : F(-0.2222);
  return off > 0 ? off : 0;
}

function spline38219(f, bl) {
  const sp = curve(SP_RIDGES);
  const i = offsetValue(F(-1), f);
  const k = offsetValue(1, f);
  let l = F(1 - F(F(1 - f) * 0.5));
  let u = F(0.5 * F(1 - f));
  l = F(F(u / F(N0_46 * l)) - N1_17);
  if (F(-0.65) < l && l < 1) {
    u = offsetValue(F(-0.65), f);
    const p = offsetValue(F(-0.75), f);
    const q = F(F(p - i) * 4);
    const r = offsetValue(l, f);
    const s = F(F(k - r) / F(1 - l));
    add(sp, -1, fix(i), q);
    add(sp, F(-0.75), fix(p), 0);
    add(sp, F(-0.65), fix(u), 0);
    add(sp, F(l - F(0.01)), fix(r), 0);
    add(sp, l, fix(r), s);
    add(sp, 1, fix(k), s);
  } else {
    u = F(F(k - i) * 0.5);
    if (bl) {
      add(sp, -1, fix(i > 0.2 ? i : 0.2), 0);
      add(sp, 0, fix(lerp(0.5, i, k)), u);
    } else {
      add(sp, -1, fix(i), u);
    }
    add(sp, 1, fix(k), u);
  }
  return sp;
}

function flatOffset(f, g, h, i, j, k) {
  const sp = curve(SP_RIDGES);
  let l = F(0.5 * F(g - f));
  if (l < k) l = k;
  const m = F(5 * F(h - g));
  add(sp, -1, fix(f), l);
  add(sp, F(-0.4), fix(g), l < m ? l : m);
  add(sp, 0, fix(h), m);
  add(sp, F(0.4), fix(i), F(2 * F(i - h)));
  add(sp, 1, fix(j), F(F(0.7) * F(j - i)));
  return sp;
}

function landSpline(fIn, gIn, hIn, iIn, jIn, kIn, bl) {
  const f = F(fIn);
  const g = F(gIn);
  const h = F(hIn);
  const i = F(iIn);
  const j = F(jIn);
  const k = F(kIn);
  const sp1 = spline38219(F(lerp(i, F(0.6), 1.5)), bl);
  const sp2 = spline38219(F(lerp(i, F(0.6), 1)), bl);
  const sp3 = spline38219(i, bl);
  const ih = F(0.5 * i);
  const i06 = F(i * F(0.6));
  const sp4 = flatOffset(F(f - F(0.15)), ih, ih, ih, i06, 0.5);
  const sp5 = flatOffset(f, F(j * i), F(g * i), ih, i06, 0.5);
  const sp6 = flatOffset(f, j, j, g, h, 0.5);
  const sp7 = flatOffset(f, j, j, g, h, 0.5);
  const sp8 = curve(SP_RIDGES);
  add(sp8, -1, fix(f), 0);
  add(sp8, F(-0.4), sp6, 0);
  add(sp8, 0, fix(F(h + F(0.07))), 0);
  const sp9 = flatOffset(F(-0.02), k, k, g, h, 0);
  const sp = curve(SP_EROSION);
  add(sp, F(-0.85), sp1, 0);
  add(sp, F(-0.7), sp2, 0);
  add(sp, F(-0.4), sp3, 0);
  add(sp, F(-0.35), sp4, 0);
  add(sp, F(-0.1), sp5, 0);
  add(sp, F(0.2), sp6, 0);
  if (bl) {
    add(sp, F(0.4), sp7, 0);
    add(sp, F(0.45), sp8, 0);
    add(sp, F(0.55), sp8, 0);
    add(sp, F(0.58), sp7, 0);
  }
  add(sp, F(0.7), sp9, 0);
  return sp;
}

function buildSpline() {
  const sp = curve(SP_CONTINENTALNESS);
  const sp1 = landSpline(-0.15, 0.0, 0.0, 0.1, 0.0, -0.03, false);
  const sp2 = landSpline(-0.1, 0.03, 0.1, 0.1, 0.01, -0.03, false);
  const sp3 = landSpline(-0.1, 0.03, 0.1, 0.7, 0.01, -0.03, true);
  const sp4 = landSpline(-0.05, 0.03, 0.1, 1.0, 0.01, 0.01, true);
  add(sp, F(-1.1), fix(0.044), 0);
  add(sp, F(-1.02), fix(-0.2222), 0);
  add(sp, F(-0.51), fix(-0.2222), 0);
  add(sp, F(-0.44), fix(-0.12), 0);
  add(sp, F(-0.18), fix(-0.12), 0);
  add(sp, F(-0.16), sp1, 0);
  add(sp, F(-0.15), sp1, 0);
  add(sp, F(-0.1), sp2, 0);
  add(sp, F(0.25), sp3, 0);
  add(sp, 1, sp4, 0);
  return sp;
}

const SPLINE = buildSpline();
// Parametros de la curva para la muestra actual: continentalidad, erosion, crestas (la cuarta casilla de cubiomes no se usa)
const vals = [0, 0, 0];

function getSpline(sp) {
  if (sp.fixed) return sp.val;
  const f = vals[sp.typ];
  const locs = sp.loc;
  const n = locs.length;
  let i = 0;
  while (i < n && !(locs[i] >= f)) i++;
  if (i === 0 || i === n) {
    if (i) i--;
    const v = getSpline(sp.val[i]);
    return F(v + F(sp.der[i] * F(f - locs[i])));
  }
  const g = locs[i - 1];
  const h = locs[i];
  const k = F(F(f - g) / F(h - g));
  const l = sp.der[i - 1];
  const m = sp.der[i];
  const v1 = getSpline(sp.val[i - 1]);
  const v2 = getSpline(sp.val[i]);
  const hg = F(h - g);
  const p = F(F(l * hg) - F(v2 - v1));
  const q = F(F(-m * hg) + F(v2 - v1));
  return F(lerp(k, v1, v2) + F(k * F(1 - k)) * lerp(k, p, q));
}

const C_0667 = F(0.6666667);
const C_0333 = F(0.33333334);
const C_0015 = F(0.015);
const DEPTH_BASE = 83 / 160;

function depthOffset(c, e, w) {
  vals[0] = c;
  vals[1] = e;
  vals[2] = F(-3 * F(Math.abs(F(Math.abs(w) - C_0667)) - C_0333));
  return F(getSpline(SPLINE) + C_0015);
}

// ---------- Semilla ----------
// md5 de "minecraft:offset", "minecraft:temperature", etc.
const md5 = (lo, hi) => [Number(BigInt.asIntN(32, lo)), Number(BigInt.asIntN(32, lo >> 32n)), Number(BigInt.asIntN(32, hi)), Number(BigInt.asIntN(32, hi >> 32n))];
const NOISES = {
  shift: { m: md5(0x080518cf6af25384n, 0x3f3dfb40a54febd5n), amps: [1, 1, 1, 0], omin: -3 },
  temperature: { m: md5(0x5c7e6b29735f0d7fn, 0xf7d86f1bbc734988n), amps: [1.5, 0, 1, 0, 0, 0], omin: -10 },
  humidity: { m: md5(0x81bb4d22e8dc168en, 0xf1c8b4bea16303cdn), amps: [1, 1, 0, 0, 0, 0], omin: -8 },
  continentalness: { m: md5(0x83886c9d0ae3a662n, 0xafa638a61b42e8adn), amps: [1, 1, 2, 2, 2, 1, 1, 1, 1], omin: -9 },
  erosion: { m: md5(0xd02491e6058f6fd8n, 0x4792512c94c17a80n), amps: [1, 1, 0, 1, 1], omin: -9 },
  weirdness: { m: md5(0xefc8ef4d36102b34n, 0x1beeeb324a0f24ean), amps: [1, 2, 1, 0, 0, 0], omin: -7 },
};

// Parametros de la ultima muestra (salida de climate())
let npT = 0;
let npH = 0;
let npC = 0;
let npE = 0;
let npD = 0;
let npW = 0;

export class OverworldNoise {
  constructor(seed, tree) {
    this.tree = tree;
    const xr = new Xoroshiro().setSeed(seed);
    xr.next();
    const lo0 = xr.r0;
    const lo1 = xr.r1;
    xr.next();
    const hi0 = xr.r0;
    const hi1 = xr.r1;
    const make = ({ m, amps, omin }) => xDoublePerlin(new Xoroshiro().set(lo0 ^ m[0], lo1 ^ m[1], hi0 ^ m[2], hi1 ^ m[3]), amps, omin);
    this.shift = make(NOISES.shift);
    this.temperature = make(NOISES.temperature);
    this.humidity = make(NOISES.humidity);
    this.continentalness = make(NOISES.continentalness);
    this.erosion = make(NOISES.erosion);
    this.weirdness = make(NOISES.weirdness);
  }

  // Deja los parametros en np*: sampleBiomeNoise() sin la busqueda del bioma
  climate(x, y, z, withDepth) {
    const px = x + sampleDoublePerlin(this.shift, x, 0, z) * 4;
    const pz = z + sampleDoublePerlin(this.shift, z, x, 0) * 4;
    const c = F(sampleDoublePerlin(this.continentalness, px, 0, pz));
    const e = F(sampleDoublePerlin(this.erosion, px, 0, pz));
    const w = F(sampleDoublePerlin(this.weirdness, px, 0, pz));
    let d = 0;
    if (withDepth) {
      const off = depthOffset(c, e, w);
      d = F(1 - (y * 4) / 128 - DEPTH_BASE + off);
    }
    const t = F(sampleDoublePerlin(this.temperature, px, 0, pz));
    const h = F(sampleDoublePerlin(this.humidity, px, 0, pz));
    npT = F(10000 * t) | 0;
    npH = F(10000 * h) | 0;
    npC = F(10000 * c) | 0;
    npE = F(10000 * e) | 0;
    npD = F(10000 * d) | 0;
    npW = F(10000 * w) | 0;
  }

  // Bioma exacto de una celda 1:4 (x, y y z en celdas de 4 bloques)
  biome(x, y, z) {
    this.climate(x, y, z, true);
    return biomeOfNode(this.tree, nearestNode(this.tree, npT, npH, npC, npE, npD, npW, -1));
  }

  // Igual, pero arranca del resultado anterior (hint.node), como locateBiome() y areBiomesViable() de cubiomes
  biomeHinted(x, y, z, hint) {
    this.climate(x, y, z, true);
    hint.node = nearestNode(this.tree, npT, npH, npC, npE, npD, npW, hint.node);
    return biomeOfNode(this.tree, hint.node);
  }

  // Parametro de profundidad sin desplazamiento, para isViableStructureTerrain() (x y z pueden ser fraccionarios)
  depthAt(x, z) {
    const c = F(sampleDoublePerlin(this.continentalness, x, 0, z));
    const e = F(sampleDoublePerlin(this.erosion, x, 0, z));
    const w = F(sampleDoublePerlin(this.weirdness, x, 0, z));
    const off = depthOffset(c, e, w);
    return F(1 - DEPTH_BASE + off);
  }

  // calcFitness() de cubiomes: que tan buen lugar es para aparecer. x y z en bloques; `newFormula` desde 1.21.2
  spawnFitness(x, z, newFormula) {
    this.climate(x >> 2, 0, z >> 2, false);
    const q = (v, lo, hi) => {
      const a = v - hi;
      const b = lo - v;
      const d = a > 0 ? a : b > 0 ? b : 0;
      return d * d;
    };
    const ds = q(npT, -10000, 10000) + q(npH, -10000, 10000) + q(npC, -1100, 10000) + q(npE, -10000, 10000) + q(npD, 0, 0);
    const ds1 = ds + q(npW, -10000, -1600);
    const ds2 = ds + q(npW, 1600, 10000);
    const best = ds1 <= ds2 ? ds1 : ds2;
    const a = x * x;
    const b = z * z;
    if (!newFormula) {
      const s = (a + b) / (2500 * 2500);
      return Math.floor(s * s * 1e8) + best;
    }
    return best * (2048 * 2048) + a + b;
  }

  // mapApproxHeight() en 1.18+: altura aproximada desde la profundidad; deja el bioma en `this.lastBiome`
  approxHeight(x, z) {
    this.climate(x, 0, z, true);
    this.lastBiome = biomeOfNode(this.tree, nearestNode(this.tree, npT, npH, npC, npE, npD, npW, -1));
    return F(npD / 76);
  }
}
