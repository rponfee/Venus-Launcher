// Lo que usa el resto del visor para preguntarle cosas a un mundo: una semilla, una version y una dimension.
// Corre igual en el Worker de la interfaz y en Node (pruebas).
import { versionByKey } from './versions.js';
import { buildTree } from './tree.js';
import { OverworldNoise } from './overworld.js';
import { NetherNoise } from './nether.js';
import { EndNoise } from './end.js';
import { StructureFinder } from './structures.js';

// Pedazos del mapa: 128 x 128 muestras. Nivel 0 = una muestra por celda 1:4 (la escala del juego); cada nivel duplica el paso
export const TILE = 128;
// Altura de "superficie": la que usa cubiomes para validar estructuras. Solo la tocan las capas de superficie.
export const SURFACE_Y = 319 >> 2;

// Tablas de biomas: cada una se carga una vez y solo si se usa
const LOADERS = {
  btree18: () => import('./tables/btree18.js'),
  btree192: () => import('./tables/btree192.js'),
  btree19: () => import('./tables/btree19.js'),
  btree20: () => import('./tables/btree20.js'),
  btree21wd: () => import('./tables/btree21wd.js'),
};
const trees = new Map();
export async function loadTree(table) {
  if (!trees.has(table)) trees.set(table, LOADERS[table]().then((m) => buildTree(m.default)));
  return trees.get(table);
}

export class SeedWorld {
  // seed: BigInt; dim: 0 Overworld, -1 Nether, 1 End; tree: resultado de loadTree (solo hace falta en el Overworld)
  constructor({ seed, version, dim, tree }) {
    this.seed = seed;
    this.dim = dim;
    this.version = versionByKey(version);
    this.overworld = dim === 0 ? new OverworldNoise(seed, tree) : null;
    this.nether = dim === -1 ? new NetherNoise(seed) : null;
    this.end = dim === 1 ? new EndNoise(seed) : null;
    this.finder = dim === 1 ? null : new StructureFinder({ seed, mc: this.version.mc, overworld: this.overworld, nether: this.nether });
    this.endBuf = null;
  }

  // Bioma exacto en una celda 1:4 (en el End, el de su chunk)
  biomeAt(x4, y4, z4) {
    if (this.overworld) return this.overworld.biome(x4, y4, z4);
    if (this.nether) return this.nether.biome(x4, z4);
    const out = new Int32Array(1);
    this.end.area(out, x4 >> 2, z4 >> 2, 1, 1);
    return out[0];
  }

  // Un pedazo del mapa. Cada muestra es el bioma exacto de la celda 1:4 en el centro de lo que cubre ese pixel.
  fillTile(out, level, tx, tz, y4) {
    const step = 1 << level;
    const mid = step >> 1;
    const x0 = tx * TILE * step + mid;
    const z0 = tz * TILE * step + mid;
    const w = this.overworld;
    if (w) {
      for (let j = 0, p = 0; j < TILE; j++) {
        const z = z0 + j * step;
        for (let i = 0; i < TILE; i++) out[p++] = w.biome(x0 + i * step, y4, z);
      }
      return;
    }
    const n = this.nether;
    if (n) {
      for (let j = 0, p = 0; j < TILE; j++) {
        const z = z0 + j * step;
        for (let i = 0; i < TILE; i++) out[p++] = n.biome(x0 + i * step, z);
      }
      return;
    }
    this.fillEndTile(out, level, tx, tz);
  }

  fillEndTile(out, level, tx, tz) {
    if (level >= 3) {
      // Mas lejos que 1:16 se usa la version rapida de cubiomes (aproximada)
      if (!this.endBuf) this.endBuf = new Int32Array(TILE * TILE);
      this.end.areaScaled(this.endBuf, 4 << level, tx * TILE, tz * TILE, TILE, TILE);
      out.set(this.endBuf);
      return;
    }
    const step = 1 << level;
    const mid = step >> 1;
    const x0 = tx * TILE * step;
    const z0 = tz * TILE * step;
    const cx0 = x0 >> 2;
    const cz0 = z0 >> 2;
    const span = (TILE * step) >> 2;
    const area = new Int32Array(span * span);
    this.end.area(area, cx0, cz0, span, span);
    for (let j = 0, p = 0; j < TILE; j++) {
      const cj = ((z0 + j * step + mid) >> 2) - cz0;
      for (let i = 0; i < TILE; i++) out[p++] = area[cj * span + (((x0 + i * step + mid) >> 2) - cx0)];
    }
  }
}
