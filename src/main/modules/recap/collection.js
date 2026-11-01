'use strict';
// Lo que hay hoy en las instancias para el resumen (sin Electron): cuantos mods (archivos de mods/, activos o
// desactivados, como cuenta la ficha de la instancia) y cuantos mundos (carpetas de saves/ con level.dat).
// Solo lee carpetas: no abre los .jar ni los mundos. La carpeta de cada instancia la da dirOf(id).
const path = require('path');
const fsPromises = require('fs/promises');

const MOD_FILE = /\.(jar|zip|litemod)(\.disabled)?$/i;
const MAX_ENTRIES = 20000; // una carpeta con mas archivos que esto no es una carpeta de mods normal

async function entries(fsp, dir) {
  try {
    const list = await fsp.readdir(dir, { withFileTypes: true });
    return list.length > MAX_ENTRIES ? list.slice(0, MAX_ENTRIES) : list;
  } catch {
    return [];
  }
}

async function countMods(fsp, dir) {
  return (await entries(fsp, dir)).filter((e) => e.isFile() && MOD_FILE.test(e.name)).length;
}

async function countWorlds(fsp, dir) {
  const dirs = (await entries(fsp, dir)).filter((e) => e.isDirectory() && e.name !== '.' && e.name !== '..');
  let n = 0;
  for (const e of dirs) {
    const st = await fsp.stat(path.join(dir, e.name, 'level.dat')).catch(() => null);
    if (st && st.isFile()) n++;
  }
  return n;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// instances: [{ id }]. Una instancia cuya carpeta no se puede resolver se cuenta como instancia sin contenido.
async function scanCollection(instances, { dirOf, fsp = fsPromises, concurrency = 6 } = {}) {
  const list = (Array.isArray(instances) ? instances : []).filter((i) => i && typeof i.id === 'string' && i.id);
  const perInstance = {};
  let mods = 0;
  let worlds = 0;
  await mapLimit(list, concurrency, async (inst) => {
    let dir;
    try {
      dir = dirOf(inst.id);
    } catch {
      return;
    }
    if (typeof dir !== 'string' || !dir) return;
    const m = await countMods(fsp, path.join(dir, 'mods'));
    const w = await countWorlds(fsp, path.join(dir, 'saves'));
    perInstance[inst.id] = { mods: m, worlds: w };
    mods += m;
    worlds += w;
  });
  return { instances: list.length, mods, worlds, perInstance };
}

module.exports = { scanCollection, countMods, countWorlds, MOD_FILE };
