'use strict';
// Competir: lee saves/<mundo>/stats/<uuid>.json de todas las instancias, solo de las cuentas de este launcher (los otros
// jugadores de una partida LAN no cuentan). Lo que no cambió desde el último envío (fecha + tamaño) ni se abre.
const fsp = require('fs/promises');
const path = require('path');
const ingame = require('../statsplus/ingame');
const { totalsOf } = require('./logic');

const MAX_BYTES = 32 * 1024 * 1024;

const cleanUuid = (s) => String(s || '').replace(/-/g, '').toLowerCase();

/**
 * list: instancias ({ id, dir }). known: Set de uuid sin guiones. baseline: { clave: { mtimeMs, size, ... } }.
 * Devuelve [{ key, unchanged: true } | { key, mtimeMs, size, totals }]. Clave = '<instancia>|<mundo>|<uuid>'.
 */
async function scanStats(list, known, baseline = {}) {
  const out = [];
  if (!known || !known.size) return out;
  for (const inst of Array.isArray(list) ? list : []) {
    if (!inst?.dir) continue;
    for (const world of await ingame.listWorlds(inst.dir)) {
      const dir = path.join(world.dir, 'stats');
      for (const name of await fsp.readdir(dir).catch(() => [])) {
        if (!name.toLowerCase().endsWith('.json')) continue;
        const uuid = cleanUuid(name.slice(0, -5));
        if (!known.has(uuid)) continue;
        const key = `${inst.id}|${world.folder}|${uuid}`;
        const file = path.join(dir, name);
        const st = await fsp.stat(file).catch(() => null);
        if (!st?.isFile() || st.size > MAX_BYTES) continue;
        const prev = baseline[key];
        if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
          out.push({ key, unchanged: true });
          continue;
        }
        try {
          const totals = totalsOf(ingame.normalize(JSON.parse(await fsp.readFile(file, 'utf8'))));
          out.push({ key, mtimeMs: st.mtimeMs, size: st.size, totals });
        } catch {
          out.push({ key, unchanged: true }); // el juego lo está escribiendo: se lee la próxima vez
        }
      }
    }
  }
  return out;
}

module.exports = { scanStats, cleanUuid };
