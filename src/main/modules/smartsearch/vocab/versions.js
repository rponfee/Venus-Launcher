'use strict';
// Versiones de Minecraft en el pedido: rangos ("1.18 a 1.20", "1.19 o superior", "hasta la 1.16"), series
// ("1.20.x", "1.20+") y apodos de las actualizaciones ("la Caves and Cliffs" = 1.18). Sin Electron ni red:
// lo usa interpreter.js y se prueba solo.
//
// Flujo: prepare(texto crudo) -> el interprete normaliza -> aliases(texto normalizado) -> range(texto normalizado).

const V = '(1\\.[0-9]{1,2}(?:\\.[0-9]{1,2})?|2[0-9]\\.[0-9]{1,2}(?:\\.[0-9]{1,2})?)';
const ONE_VERSION = new RegExp(`^${V}$`);

// Apodos de actualizaciones -> version menor ("nether update" = 1.16).
const ALIASES = [
  ['(?:the )?nether update|actualizacion del nether|update del nether|nether upd', '1.16'],
  ['caves? (?:and|y|e|&) cliffs?|cuevas y acantilados|cavernas e penhascos', '1.18'],
  ['(?:the )?wild update|actualizacion salvaje|wild upd', '1.19'],
  ['trails? (?:and|y|e|&) tales?|senderos y relatos|trilhas e contos', '1.20'],
  ['tricky trials?|pruebas peliagudas|desafios astutos', '1.21'],
  ['(?:the )?update aquatic|aquatic update|actualizacion acuatica|update acuatico|update aquatica', '1.13'],
  ['buzzy bees?|abejas zumbantes|abelhas zumbidoras', '1.15'],
  ['village (?:and|y|e|&) pillage|aldeas y saqueos|aldeias e saques', '1.14'],
  ['(?:the )?combat update|actualizacion del combate|update del combate', '1.9'],
  ['(?:the )?bountiful update|actualizacion de la abundancia', '1.8'],
  ['(?:the )?frostburn update|actualizacion frostburn', '1.10'],
  ['(?:the )?exploration update|actualizacion de la exploracion', '1.11'],
  ['(?:the )?world of color update|actualizacion del mundo de color', '1.12'],
];

// Trabaja sobre el texto CRUDO: la normalizacion borra guiones y signos, que aca significan algo.
function prepare(raw) {
  return String(raw || '')
    .replace(/(\d\.\d{1,2}(?:\.\d{1,2})?)\s*(?:-|–|—|~|→|=>|\.\.)\s*(\d\.\d{1,2}(?:\.\d{1,2})?)/g, '$1 hasta $2')
    .replace(/(\d\.\d{1,2})\.[xX*](?![a-zA-Z0-9])/g, '$1')
    .replace(/(\d\.\d{1,2}(?:\.\d{1,2})?)\s*\+(?![a-zA-Z0-9])/g, '$1 o superior');
}

// Reemplaza los apodos por la version ("nether update" -> "1.16") en el texto normalizado.
function aliases(text) {
  let out = text;
  for (const [pattern, version] of ALIASES) out = out.replace(new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`, 'g'), version);
  return out;
}

// "1.20.4" > "1.20" > "1.19.2": comparacion numerica componente a componente.
function compare(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
const minorOf = (v) => String(v).split('.').slice(0, 2).join('.');

const RANGE_BETWEEN = new RegExp(
  `(?<![0-9.])(?:entre |between |de |desde |from |da |dos? )?(?:la |the |a )?${V} (?:a la|a|al|hasta la|hasta|to the|to|until|through|thru|e a|e|y la|y|and|ate a|ate) (?:la |the |a )?${V}(?![0-9.])`,
);
const RANGE_MIN = new RegExp(
  `(?<![0-9.])${V} (?:o (?:superior|mayor|posterior|mas nueva|mas reciente|mas)|en adelante|para adelante|hacia adelante|para arriba|pa arriba|pa adelante|hacia arriba|y (?:mas|superior|superiores|posterior|posteriores|mayor)|o mas (?:nuev[oa]s?|recientes?)|and beyond|or (?:newer|higher|later|above|up|greater)|and (?:up|above|newer|higher|later)|ou (?:superior|mais|maior|posterior)|pra frente|para frente|onwards?)(?![a-z0-9])`,
);
const RANGE_MIN_PREFIX = new RegExp(
  `(?<![a-z0-9])(?:desde(?: la)?|a partir de(?: la)?|a partir da|desde a|from|since|starting (?:from|with|at)|minimo|min|at least|al menos)\\s+${V}(?![0-9.])`,
);
const RANGE_MAX = new RegExp(
  `(?<![0-9.])${V} (?:o (?:anterior|inferior|menor|mas vieja|mas antigua|menos)|para abajo|pa abajo|hacia abajo|y (?:menos|anterior|anteriores|inferior|inferiores|menor)|o mas (?:viej[oa]s?|antigu[oa]s?)|or (?:older|lower|earlier|below|less)|and (?:below|older|earlier|lower)|ou (?:anterior|inferior|menor)|para tras|hacia atras)(?![a-z0-9])`,
);
const RANGE_MAX_PREFIX = new RegExp(
  `(?<![a-z0-9])(?:hasta(?: la)?|up to|until|through|thru|como mucho|maximo|max|at most|antes de(?: la)?|before|ate(?: a)?)\\s+${V}(?![0-9.])`,
);

// Elige la version concreta de un rango. releases: Set de versiones estables conocidas (puede faltar sin conexion).
function pick({ kind, min, max }, { releases, latest, patches = {} } = {}) {
  const known = releases && releases.size ? [...releases] : [];
  const inMin = (v) => !min || compare(minorOf(v), minorOf(min)) >= 0;
  const inMax = (v) => !max || compare(minorOf(v), minorOf(max)) <= 0;
  const candidates = known.filter((v) => /^1\.\d+(\.\d+)?$|^2\d\.\d+(\.\d+)?$/.test(v) && inMin(v) && inMax(v)).sort((a, b) => compare(b, a));
  if (kind === 'min') {
    if (latest && compare(latest, min) >= 0) return latest;
    return candidates[0] || patches[min] || min;
  }
  const top = max || min;
  if ((kind === 'max' || kind === 'between') && /^\d+\.\d+\.\d+$/.test(top) && (!known.length || candidates.includes(top))) return top;
  const wanted = patches[minorOf(top)] || null;
  if (kind === 'max' || kind === 'between') {
    if (wanted && (!candidates.length || candidates.includes(wanted))) return wanted;
    return candidates[0] || wanted || top;
  }
  return top;
}

// Busca un rango en el texto normalizado. Devuelve { kind, min, max, start, end, text } o null.
function range(text) {
  let m = RANGE_BETWEEN.exec(text);
  if (m && compare(m[1], m[2]) <= 0) return { kind: 'between', min: m[1], max: m[2], start: m.index, end: m.index + m[0].length, text: m[0] };
  if (m) return { kind: 'between', min: m[2], max: m[1], start: m.index, end: m.index + m[0].length, text: m[0] };
  m = RANGE_MIN.exec(text) || RANGE_MIN_PREFIX.exec(text);
  if (m) return { kind: 'min', min: m[1], max: null, start: m.index, end: m.index + m[0].length, text: m[0] };
  m = RANGE_MAX.exec(text) || RANGE_MAX_PREFIX.exec(text);
  if (m) return { kind: 'max', min: null, max: m[1], start: m.index, end: m.index + m[0].length, text: m[0] };
  return null;
}

// "La ultima": se suma a LATEST_PATTERNS de lexicon.js
const LATEST = [
  'la mas (?:nueva|reciente|actual)', 'mas recientes?', 'recien salida', 'recien lanzada', 'newest release', 'latest release', 'ultimo (?:update|lanzamiento)', 'ultima actualizacion',
  'last version', 'the most recent(?: version)?', 'most recent version', 'a mais (?:nova|recente)', 'mais recente', 'ultima atualizacao', 'version nueva', 'nueva version', 'new version',
];

module.exports = { V, ONE_VERSION, ALIASES, LATEST, prepare, aliases, compare, minorOf, range, pick };
