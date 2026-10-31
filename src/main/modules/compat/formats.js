'use strict';
// Formato de resource packs y data packs que espera cada versión de Minecraft (pack.mcmeta -> pack_format).
// Solo versiones confirmadas: para las que no están acá no se compara el formato (se usa lo que declara Modrinth).
const { compare } = require('./versions');

const RESOURCE = [
  ['1.6.1', '1.8.9', 1],
  ['1.9', '1.10.2', 2],
  ['1.11', '1.12.2', 3],
  ['1.13', '1.14.4', 4],
  ['1.15', '1.16.1', 5],
  ['1.16.2', '1.16.5', 6],
  ['1.17', '1.17.1', 7],
  ['1.18', '1.18.2', 8],
  ['1.19', '1.19.2', 9],
  ['1.19.3', '1.19.3', 12],
  ['1.19.4', '1.19.4', 13],
  ['1.20', '1.20.1', 15],
  ['1.20.2', '1.20.2', 18],
  ['1.20.3', '1.20.4', 22],
  ['1.20.5', '1.20.6', 32],
  ['1.21', '1.21.1', 34],
  ['1.21.2', '1.21.3', 42],
  ['1.21.4', '1.21.4', 46],
  ['1.21.5', '1.21.5', 55],
  ['1.21.6', '1.21.6', 63],
  ['1.21.7', '1.21.8', 64],
];

const DATA = [
  ['1.13', '1.14.4', 4],
  ['1.15', '1.16.1', 5],
  ['1.16.2', '1.16.5', 6],
  ['1.17', '1.17.1', 7],
  ['1.18', '1.18.1', 8],
  ['1.18.2', '1.18.2', 9],
  ['1.19', '1.19.3', 10],
  ['1.19.4', '1.19.4', 12],
  ['1.20', '1.20.1', 15],
  ['1.20.2', '1.20.2', 18],
  ['1.20.3', '1.20.4', 26],
  ['1.20.5', '1.20.6', 41],
  ['1.21', '1.21.1', 48],
  ['1.21.2', '1.21.3', 57],
  ['1.21.4', '1.21.4', 61],
  ['1.21.5', '1.21.5', 71],
  ['1.21.6', '1.21.6', 80],
  ['1.21.7', '1.21.8', 81],
];

function lookup(table, mcVersion) {
  if (!/^1\.\d+(\.\d+)?$/.test(String(mcVersion || ''))) return null; // snapshots y versiones nuevas: sin dato
  for (const [min, max, format] of table) if (compare(mcVersion, min) >= 0 && compare(mcVersion, max) <= 0) return format;
  return null;
}

const expected = (type, mcVersion) => lookup(type === 'datapack' ? DATA : RESOURCE, mcVersion);

// pack = { format, min, max } de meta.parsePack. Devuelve { ok, expected } o null si no se puede saber.
function checkPack(type, mcVersion, pack) {
  const want = expected(type, mcVersion);
  if (!want || !pack || (pack.format === null && pack.min === null)) return null;
  // El rango (supported_formats) lo entiende el juego desde la 1.20.2; antes solo cuenta pack_format.
  if (compare(mcVersion, '1.20.2') >= 0 && pack.min !== null && pack.max !== null) return { ok: want >= pack.min && want <= pack.max, expected: want };
  return { ok: pack.format === want, expected: want };
}

module.exports = { expected, checkPack };
