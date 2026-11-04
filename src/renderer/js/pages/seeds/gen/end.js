// Biomas del End (1.9+). Port de setEndSeed(), mapEndBiome() y genEndScaled() de biomenoise.c de cubiomes (MIT, ver
// LICENSE-cubiomes.txt). Cambian por chunk: a 1:4 y 1:16 son exactos; mas lejos genEndScaled() usa un calculo mas rapido
// con menos radio (ver `areaScaled`).
import { JavaRandom } from './rng.js';
import { Octaves, sampleSimplex2D } from './noise.js';
import { THE_END, SMALL_END_ISLANDS, END_MIDLANDS, END_HIGHLANDS, END_BARRENS } from './biomes.js';

const F = Math.fround;
const LIMIT = F(-0.9);
// (25-2*i)*(25-2*i)
const DS = Uint16Array.of(625, 529, 441, 361, 289, 225, 169, 121, 81, 49, 25, 9, 1, 1, 9, 25, 49, 81, 121, 169, 225, 289, 361, 441, 529, 625);

function endBiome(hx, hz, hmap, offset, hw) {
  const di = hx < 0 ? 1 : 0;
  const dj = hz < 0 ? 1 : 0;
  let h = Math.abs(hx) <= 15 && Math.abs(hz) <= 15 ? 64 * (hx * hx + hz * hz) : 14401;
  let p = offset;
  for (let j = 0; j < 25; j++) {
    const dsj = DS[j + dj];
    for (let i = 0; i < 25; i++) {
      const e = hmap[p + i];
      if (e !== 0) {
        const u = (DS[i + di] + dsj) * e;
        if (u < h) h = u;
      }
    }
    p += hw;
  }
  if (h < 3600) return END_HIGHLANDS;
  if (h <= 10000) return END_MIDLANDS;
  if (h <= 14400) return END_BARRENS;
  return SMALL_END_ISLANDS;
}

export class EndNoise {
  constructor(seed) {
    const rng = new JavaRandom().setSeed(seed);
    rng.skip(17292);
    const o = new Octaves(1);
    o.init(0, rng, 1, 1);
    this.perm = o.perm;
  }

  // Altura de una isla en esa celda de 2 chunks (0 si no hay)
  island(rx, rz) {
    if (rx * rx + rz * rz > 4096 && sampleSimplex2D(this.perm, rx, rz) < LIMIT) {
      const v = (Math.trunc(F(F(Math.abs(F(rx)) * 3439) + F(Math.abs(F(rz)) * 147))) >>> 0) % 13 + 9;
      return v;
    }
    return 0;
  }

  // mapEndBiome(): biomas de un area en chunks (escala 1:16)
  area(out, x, z, w, h) {
    const hw = w + 26;
    const hh = h + 26;
    const hmap = new Uint16Array(hw * hh);
    for (let j = 0; j < hh; j++) {
      for (let i = 0; i < hw; i++) {
        const v = this.island(x + i - 12, z + j - 12);
        hmap[j * hw + i] = v * v;
      }
    }
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let hx = i + x;
        let hz = j + z;
        if (hx * hx + hz * hz <= 4096) {
          out[j * w + i] = THE_END;
          continue;
        }
        hx = 2 * hx + 1;
        hz = 2 * hz + 1;
        // Los anillos de afuera: el juego desborda un int
        if (((hx * hx + hz * hz) | 0) < 0) {
          out[j * w + i] = END_BARRENS;
          continue;
        }
        const offset = (Math.trunc(hz / 2) - z) * hw + (Math.trunc(hx / 2) - x);
        out[j * w + i] = endBiome(hx, hz, hmap, offset, hw);
      }
    }
  }

  // getEndHeightNoise()
  heightNoise(x, z, range) {
    const hx = Math.trunc(x / 2);
    const hz = Math.trunc(z / 2);
    const oddx = x % 2;
    const oddz = z % 2;
    let h = 64 * (x * x + z * z);
    for (let j = -range; j <= range; j++) {
      for (let i = -range; i <= range; i++) {
        const v = this.island(hx + i, hz + j);
        if (v) {
          const rx = oddx - i * 2;
          const rz = oddz - j * 2;
          const noise = (rx * rx + rz * rz) * v * v;
          if (noise < h) h = noise;
        }
      }
    }
    const ret = F(100 - F(Math.sqrt(F(h))));
    return ret < -100 ? -100 : ret > 80 ? 80 : ret;
  }

  // genEndScaled() para escalas distintas de 1, 4 y 16: aproxima con un radio de 4 celdas. Coincide con cubiomes, pero no
  // es el bioma exacto del juego en ese punto.
  areaScaled(out, scale, x, z, w, h) {
    const d = F(scale / 8);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const hx = Math.trunc(F(F(i + x) * d));
        const hz = Math.trunc(F(F(j + z) * d));
        const rsq = hx * hx + hz * hz;
        if (rsq <= 16384) {
          out[j * w + i] = THE_END;
          continue;
        }
        if ((rsq | 0) < 0) {
          out[j * w + i] = END_BARRENS;
          continue;
        }
        const v = this.heightNoise(hx, hz, 4);
        out[j * w + i] = v > 40 ? END_HIGHLANDS : v >= 0 ? END_MIDLANDS : v >= -20 ? END_BARRENS : SMALL_END_ISLANDS;
      }
    }
  }
}
