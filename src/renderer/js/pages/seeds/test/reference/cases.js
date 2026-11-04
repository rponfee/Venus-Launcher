// Compara un caso de referencia (una linea de harness.c, entera o resumida en golden.json) con el port en JS.
// Devuelve la lista de diferencias; `stats` acumula lo comparado.
import { SeedWorld, loadTree } from '../../gen/world.js';
import { versionByKey } from '../../gen/versions.js';
import { isSlimeChunk, seedLimbs } from '../../gen/structures.js';
import { mixId, gridHash, endGridHash } from './hashes.js';

// El ultimo mundo se reutiliza: los casos de una misma combinacion vienen seguidos
let cached = null;
let cachedKey = '';
async function worldFor(version, dim, seedText) {
  const key = `${version}|${dim}|${seedText}`;
  if (key !== cachedKey) {
    const tree = dim === 0 ? await loadTree(versionByKey(version).table) : null;
    cached = new SeedWorld({ seed: BigInt(seedText), version, dim, tree });
    cachedKey = key;
  }
  return cached;
}

export const newStats = () => ({ cases: 0, cells: 0, regions: 0, candidates: 0, structures: 0, strongholds: 0, spawns: 0, slimeChunks: 0, seeds: new Set() });

// [rx, rz, x, z, v, t] de cada intento de una ventana de regiones, como las escribe el harness
export function structEntries(world, c, stats) {
  const out = [];
  const f = world.finder;
  for (let rz = c.rz - c.rad; rz <= c.rz + c.rad; rz++) {
    for (let rx = c.rx - c.rad; rx <= c.rx + c.rad; rx++) {
      if (stats) stats.regions++;
      if (!f.position(c.type, rx, rz)) continue;
      const x = f.x;
      const z = f.z;
      const v = f.viable(c.type, x, z);
      let t = 0;
      if (v) t = c.dim === 0 ? (f.terrain(c.type, x, z) ? 1 : 0) : 1;
      out.push([rx, rz, x, z, v, t]);
      if (stats) {
        stats.candidates++;
        if (t) stats.structures++;
      }
    }
  }
  return out;
}

export function listHash(entries) {
  let hash = 0;
  let i = 0;
  for (const e of entries) for (const n of e) hash = mixId(hash, i++, n);
  return hash;
}

export async function checkCase(c, stats) {
  const diffs = [];
  stats.cases++;
  if (c.seed !== undefined) stats.seeds.add(c.seed);
  if (c.k === 'grid') {
    const w = await worldFor(c.mc, c.dim, c.seed);
    const hash = c.dim === 1 ? endGridHash(w, c) : gridHash(w, c);
    stats.cells += c.n;
    if (hash !== c.hash) diffs.push(`biomas: hash ${hash} en lugar de ${c.hash}`);
  } else if (c.k === 'struct') {
    const w = await worldFor(c.mc, c.dim, c.seed);
    const entries = structEntries(w, c, stats);
    if (c.list) {
      // Linea entera del harness: dice en que parte esta la diferencia
      const want = new Map(c.list.map((e) => [`${e[0]},${e[1]}`, e]));
      const got = new Map(entries.map((e) => [`${e[0]},${e[1]}`, e]));
      for (const [key, e] of want) {
        const g = got.get(key);
        if (!g) diffs.push(`${c.type} region ${key}: cubiomes tiene intento y el port no`);
        else if (g[2] !== e[2] || g[3] !== e[3]) diffs.push(`${c.type} region ${key}: posicion ${g[2]},${g[3]} en lugar de ${e[2]},${e[3]}`);
        else if (g[4] !== e[4]) diffs.push(`${c.type} ${e[2]},${e[3]}: biomas ${g[4]} en lugar de ${e[4]}`);
        else if (g[5] !== (e[5] ? 1 : 0)) diffs.push(`${c.type} ${e[2]},${e[3]}: terreno ${g[5]} en lugar de ${e[5]}`);
      }
      for (const key of got.keys()) if (!want.has(key)) diffs.push(`${c.type} region ${key}: el port tiene intento y cubiomes no`);
    } else if (listHash(entries) !== c.listHash || entries.length !== c.n) {
      diffs.push(`${c.type}: resumen ${listHash(entries)}/${entries.length} en lugar de ${c.listHash}/${c.n}`);
    }
  } else if (c.k === 'strong') {
    const w = await worldFor(c.mc, 0, c.seed);
    const it = w.finder.strongholds();
    const got = [];
    for (let i = 0; i < c.count; i++) got.push(it.next().value);
    stats.strongholds += got.length;
    if (c.list) {
      c.list.forEach(([x, z], i) => {
        if (got[i].x !== x || got[i].z !== z) diffs.push(`fortaleza ${i}: ${got[i].x},${got[i].z} en lugar de ${x},${z}`);
      });
    } else if (listHash(got.map((p) => [p.x, p.z])) !== c.listHash) diffs.push(`fortalezas: resumen ${listHash(got.map((p) => [p.x, p.z]))} en lugar de ${c.listHash}`);
  } else if (c.k === 'spawn') {
    const w = await worldFor(c.mc, 0, c.seed);
    const e = w.finder.estimateSpawn();
    const p = w.finder.spawn();
    stats.spawns++;
    if (e.x !== c.est[0] || e.z !== c.est[1]) diffs.push(`aparicion estimada ${e.x},${e.z} en lugar de ${c.est}`);
    if (p.x !== c.pos[0] || p.z !== c.pos[1]) diffs.push(`aparicion ${p.x},${p.z} en lugar de ${c.pos}`);
  } else if (c.k === 'slime') {
    const s = seedLimbs(BigInt(c.seed));
    let hash = 0;
    let n = 0;
    for (let j = 0; j < c.h; j++) {
      for (let i = 0; i < c.w; i++) {
        const v = isSlimeChunk(s.hi, s.lo, c.x + i, c.z + j) ? 1 : 0;
        n += v;
        hash = mixId(hash, j * c.w + i, v);
      }
    }
    stats.slimeChunks += c.w * c.h;
    if (hash !== c.hash || n !== c.n) diffs.push(`slime: hash ${hash} (${n}) en lugar de ${c.hash} (${c.n})`);
  }
  return diffs;
}
