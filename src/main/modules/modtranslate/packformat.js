'use strict';
// Formato de paquetes de recursos segun la version de Minecraft y como se llaman sus archivos de idioma.
//   1.6.1 - 1.10.2   -> assets/<ns>/lang/es_ES.lang
//   1.11 - 1.12.2    -> assets/<ns>/lang/es_es.lang
//   1.13 en adelante -> assets/<ns>/lang/es_es.json
// La fuente mas confiable es el version.json del jar del juego ("pack_version"); la tabla es el respaldo.
const { ZipReader } = require('./zip');

// [primera version, formato de resource pack] (ordenado). Desde 1.21.9 los formatos son "mayor.menor".
const RESOURCE_FORMATS = [
  ['1.6.1', 1],
  ['1.9', 2],
  ['1.11', 3],
  ['1.13', 4],
  ['1.15', 5],
  ['1.16.2', 6],
  ['1.17', 7],
  ['1.18', 8],
  ['1.19', 9],
  ['1.19.3', 12],
  ['1.19.4', 13],
  ['1.20', 15],
  ['1.20.2', 18],
  ['1.20.3', 22],
  ['1.20.5', 32],
  ['1.21', 34],
  ['1.21.2', 42],
  ['1.21.4', 46],
  ['1.21.5', 55],
  ['1.21.6', 63],
  ['1.21.7', 64],
  ['1.21.9', 69],
  ['1.21.11', 75],
];
const LAST_KNOWN = RESOURCE_FORMATS[RESOURCE_FORMATS.length - 1];
const SUPPORTED_FORMATS_SINCE = 18; // 1.20.2: aparece "supported_formats"
const MIN_MAX_SINCE = 65; // 1.21.9: "min_format"/"max_format" reemplazan a supported_formats

// Snapshots semanales (24w14a) -> release a la que apuntaban (aproximado).
const WEEKLY = [
  [25, 41, [1, 21, 11]],
  [25, 31, [1, 21, 9]],
  [25, 14, [1, 21, 6]],
  [25, 0, [1, 21, 5]],
  [24, 44, [1, 21, 4]],
  [24, 33, [1, 21, 2]],
  [24, 18, [1, 21, 0]],
  [24, 14, [1, 20, 5]],
  [23, 40, [1, 20, 3]],
  [23, 31, [1, 20, 2]],
  [23, 12, [1, 20, 0]],
  [22, 42, [1, 19, 3]],
  [22, 11, [1, 19, 0]],
  [21, 37, [1, 18, 0]],
  [20, 45, [1, 17, 0]],
  [20, 6, [1, 16, 0]],
  [19, 34, [1, 15, 0]],
  [18, 43, [1, 14, 0]],
  [17, 43, [1, 13, 0]],
  [16, 32, [1, 11, 0]],
  [15, 31, [1, 9, 0]],
  [13, 16, [1, 6, 1]],
];

/**
 * "1.20.1" -> { v: [1,20,1], release: true }, "24w14a" -> { v: [1,20,5], release: false },
 * "26.1-snapshot-2" -> { v: [26,1,0], release: false }. Versiones antiguas (b1.7.3, rd-...) -> v: null.
 */
function parseVersion(id) {
  const s = String(id || '').trim().toLowerCase();
  let m = /^(\d{2})w(\d{2})[a-z~]?$/.exec(s);
  if (m) {
    const year = Number(m[1]);
    const week = Number(m[2]);
    if (year >= 26) return { v: [year, 0, 0], release: false };
    const hit = WEEKLY.find(([y, w]) => year > y || (year === y && week >= w));
    return { v: hit ? hit[2] : null, release: false };
  }
  m = /^(\d+)\.(\d+)(?:\.(\d+))?(.*)$/.exec(s);
  if (!m) return { v: null, release: false };
  return { v: [Number(m[1]), Number(m[2]), Number(m[3] || 0)], release: !m[4] };
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0) ? -1 : 1;
  return 0;
}

function atLeast(v, target) {
  return Boolean(v) && cmp(v, parseVersion(target).v) >= 0;
}

// Estilo de archivos de idioma: 'json' | 'lang' (1.11-1.12) | 'legacy' (1.6-1.10) | null (sin resource packs)
function langStyle(mcVersion) {
  const { v } = parseVersion(mcVersion);
  if (!v || !atLeast(v, '1.6.1')) return null;
  if (atLeast(v, '1.13')) return 'json';
  if (atLeast(v, '1.11')) return 'lang';
  return 'legacy';
}

// Formato segun la tabla: { major, minor, certain }
function formatFromTable(mcVersion) {
  const { v, release } = parseVersion(mcVersion);
  if (!v || !atLeast(v, '1.6.1')) return null;
  let found = null;
  for (const [ver, fmt] of RESOURCE_FORMATS) if (cmp(v, parseVersion(ver).v) >= 0) found = { ver, fmt };
  if (!found) return null;
  // Mas nueva que lo que conocemos (o una pre-release/snapshot): no sabemos el numero exacto.
  const newer = cmp(v, parseVersion(LAST_KNOWN[0]).v) > 0;
  return { major: found.fmt, minor: 0, certain: release && !newer };
}

// Lee "pack_version" del version.json que viene dentro del jar del juego.
async function formatFromJar(jarPath) {
  let zip = null;
  try {
    zip = await ZipReader.open(jarPath);
    const entry = zip.get('version.json');
    if (!entry) return null;
    const data = JSON.parse((await zip.read(entry)).toString('utf8'));
    const pv = data?.pack_version;
    if (typeof pv === 'number') return { major: pv, minor: 0, certain: true };
    if (pv && typeof pv === 'object') {
      if (Number.isInteger(pv.resource_major)) return { major: pv.resource_major, minor: Number(pv.resource_minor) || 0, certain: true };
      if (Number.isInteger(pv.resource)) return { major: pv.resource, minor: 0, certain: true };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (zip) await zip.close();
  }
}

// Formato para una instancia: primero el jar del juego (si esta descargado), despues la tabla.
async function resolveFormat(mcVersion, jarPath) {
  const style = langStyle(mcVersion);
  if (!style) return null;
  const fromJar = jarPath ? await formatFromJar(jarPath) : null;
  const fmt = fromJar || formatFromTable(mcVersion);
  if (!fmt) return null;
  return { ...fmt, style, source: fromJar ? 'jar' : 'table' };
}

/**
 * Contenido de pack.mcmeta para el formato dado.
 *  - antes de 1.20.2: solo pack_format
 *  - 1.20.2 a 1.21.8: pack_format + supported_formats
 *  - 1.21.9 en adelante: min_format/max_format (y pack_format por compatibilidad)
 * Si el formato no es seguro se declara un rango amplio para que el juego no lo descarte.
 */
function buildMcmeta(fmt, description) {
  const pack = {};
  const major = fmt.major;
  if (major >= MIN_MAX_SINCE) {
    if (fmt.certain) {
      pack.pack_format = major;
      pack.min_format = fmt.minor ? [major, fmt.minor] : major;
      pack.max_format = Math.max(major, LAST_KNOWN[1]);
    } else {
      pack.pack_format = MIN_MAX_SINCE;
      pack.min_format = MIN_MAX_SINCE;
      pack.max_format = 1000;
    }
  } else {
    pack.pack_format = major;
    if (major >= SUPPORTED_FORMATS_SINCE) pack.supported_formats = fmt.certain ? [major, MIN_MAX_SINCE - 1] : [SUPPORTED_FORMATS_SINCE, MIN_MAX_SINCE - 1];
  }
  pack.description = description;
  return { pack };
}

module.exports = { RESOURCE_FORMATS, parseVersion, atLeast, langStyle, formatFromTable, formatFromJar, resolveFormat, buildMcmeta, LAST_KNOWN, MIN_MAX_SINCE };
