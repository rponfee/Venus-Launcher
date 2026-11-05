'use strict';
// Logros de Venus: cuentas de esta PC que no salen de las sesiones del launcher (mods, shaders y resource packs de todas
// las instancias). Los logros en si van directo de la interfaz a Supabase (features/achievements.js, 0023_venus3.sql).
// Canal: achievements:localCounts() -> { mods, shaders, resourcepacks }
const fsp = require('fs/promises');
const path = require('path');

async function countFiles(dir, match) {
  try {
    const names = await fsp.readdir(dir);
    return names.filter(match).length;
  } catch {
    return 0;
  }
}

async function localCounts() {
  const instances = require('../core/instances');
  const list = await instances.list().catch(() => []);
  const totals = { mods: 0, shaders: 0, resourcepacks: 0 };
  await Promise.all(
    list.map(async (inst) => {
      const [mods, shaders, packs] = await Promise.all([
        countFiles(path.join(inst.dir, 'mods'), (n) => /\.jar(\.disabled)?$/i.test(n)),
        countFiles(path.join(inst.dir, 'shaderpacks'), (n) => /\.zip$/i.test(n)),
        countFiles(path.join(inst.dir, 'resourcepacks'), (n) => /\.zip$/i.test(n)),
      ]);
      totals.mods += mods;
      totals.shaders += shaders;
      totals.resourcepacks += packs;
    }),
  );
  return totals;
}

function register({ handle }) {
  handle('achievements:localCounts', () => localCounts());
}

module.exports = { register };
