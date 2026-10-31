'use strict';
// Filtros extra de la busqueda de contenido (navegador de Modrinth y CurseForge, y Buscador inteligente):
// frase exacta, palabras a excluir, autor, descargas minimas, actualizado en los ultimos N dias, solo codigo
// abierto y entorno (cliente o servidor).
//
// Que admite cada API (verificado en docs.modrinth.com y docs.curseforge.com, y probado contra la API real):
//  - Modrinth: facets para autor (author), descargas (downloads >=), fecha (modified_timestamp >=, en segundos
//    Unix), codigo abierto (open_source) y entorno (environment). NO admite frase exacta ni excluir palabras.
//  - CurseForge: ninguno de estos criterios (searchFilter solo mira nombre y autor; authorId pide un numero).
// Lo que la API no admite se filtra en la app con matcher() y collect(): collect() recorre las paginas de la
// API (alineadas a un tamaño fijo, asi las siguientes salen de la cache) hasta juntar los resultados pedidos o
// agotar la busqueda, y devuelve desde donde seguir. Asi no quedan paginas vacias ni cortas mientras haya mas.
//
// Sin dependencias de Electron: se prueba con Node puro.

const DAY = 86400000;
const MAX_PHRASE = 120;
const MAX_TERMS = 12;
const MAX_TERM = 60;
const MAX_DAYS = 3650;
const MAX_DOWNLOADS = 2000000000;
const AUTHOR_RE = /^[\w.-]{1,40}$/; // nombres de usuario de Modrinth

// Valores del facet "environment" que funcionan en el cliente o en un servidor dedicado.
const ENVIRONMENTS = {
  client: ['client_and_server', 'client_only', 'client_only_server_optional', 'singleplayer_only', 'server_only_client_optional', 'client_or_server', 'client_or_server_prefers_both'],
  server: ['client_and_server', 'server_only', 'server_only_client_optional', 'dedicated_server_only', 'client_only_server_optional', 'client_or_server', 'client_or_server_prefers_both'],
};

// ---------- Texto ----------

// Minusculas, sin tildes y solo letras y numeros separados por un espacio ("Ender-Dragon's" -> "ender dragon s").
// Las marcas que no son tildes latinas (dakuten del japones, jamo del coreano) se recomponen y se conservan.
function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

// true si `needle` (ya normalizado) aparece en `haystack` (ya normalizado) como palabras completas y seguidas.
function containsWords(haystack, needle) {
  return Boolean(needle) && ` ${haystack} `.includes(` ${needle} `);
}

// Palabras o frases entre comillas. Separan la coma, el punto y coma, la barra vertical, el salto de linea y el
// espacio; lo que va entre comillas es una sola frase. Un arreglo ya viene separado (cada elemento es un
// termino), asi normalize() se puede aplicar dos veces sin cambiar nada. Se descartan los de menos de 2 letras
// y los repetidos.
function splitTerms(input, max = MAX_TERMS) {
  let raw;
  if (Array.isArray(input)) raw = input.map((x) => String(x ?? ''));
  else raw = [...String(input ?? '').matchAll(/"([^"]*)"|[^\s,;|"]+/g)].map((m) => m[1] ?? m[0]);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const text = item.replace(/\s+/g, ' ').trim().slice(0, MAX_TERM);
    const key = normalizeText(text);
    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

const toInt = (value, max) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
};

// ---------- Parametros ----------

// Sanea los criterios que llegan de la interfaz. Devuelve siempre la misma forma (y aplicarlo de nuevo no cambia nada):
//   { phrase, exclude[], author, authorInvalid, minDownloads, updatedDays, openSource, environment: '' | 'client' | 'server' }
// Un autor con espacios o simbolos no puede ser un usuario de Modrinth: queda vacio y authorInvalid en true.
function normalize(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const phrase = String(p.phrase ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_PHRASE);
  let author = String(p.author ?? '').trim().replace(/^@/, '');
  let authorInvalid = false;
  if (author && !AUTHOR_RE.test(author)) {
    author = '';
    authorInvalid = true;
  }
  return {
    phrase: normalizeText(phrase).length >= 2 ? phrase : '',
    exclude: splitTerms(p.exclude),
    author,
    authorInvalid,
    minDownloads: toInt(p.minDownloads, MAX_DOWNLOADS),
    updatedDays: toInt(p.updatedDays, MAX_DAYS),
    openSource: p.openSource === true || p.openSource === 'true',
    environment: p.environment === 'client' || p.environment === 'server' ? p.environment : '',
  };
}

// true si hay que filtrar en la app (la API de esa fuente no admite alguno de los criterios activos).
function needsClient(f, source = 'modrinth') {
  if (!f) return false;
  if (f.phrase || (f.exclude && f.exclude.length)) return true;
  if (source === 'curseforge') return Boolean(f.author || f.minDownloads || f.updatedDays || f.openSource);
  return false;
}

// Consulta para la API de Modrinth: la del usuario mas las palabras de la frase que le falten. Las dos van
// juntas (Modrinth exige todas las palabras), asi la API ya devuelve primero lo que tiene la frase y hay que
// recorrer menos paginas. No se manda entre comillas: la busqueda con comillas de Modrinth se pierde algunos
// proyectos que si tienen la frase en el titulo o la descripcion.
function apiQuery(query, f, max = 300) {
  const q = String(query ?? '').trim();
  if (!f || !f.phrase) return q.slice(0, max);
  const have = new Set(normalizeText(q).split(' ').filter(Boolean));
  const extra = normalizeText(f.phrase).split(' ').filter((w) => w && !have.has(w));
  return [q, ...extra].filter(Boolean).join(' ').slice(0, max);
}

// Clausulas de facets de Modrinth para lo que su API si admite (cada arreglo es un OR; los arreglos se combinan con AND).
//   opts.environment: false para no aplicar el entorno (por ejemplo en tipos que no lo tienen)
function modrinthFacets(f, { now = Date.now(), environment = true } = {}) {
  const out = [];
  if (!f) return out;
  if (f.author) out.push([`author:${f.author}`]);
  if (f.minDownloads) out.push([`downloads>=${f.minDownloads}`]);
  if (f.updatedDays) out.push([`modified_timestamp>=${Math.floor(now / 1000) - f.updatedDays * 86400}`]);
  if (f.openSource) out.push(['open_source:true']);
  if (environment && ENVIRONMENTS[f.environment]) out.push(ENVIRONMENTS[f.environment].map((e) => `environment:${e}`));
  return out;
}

// ---------- Filtro en la app ----------

// Vista comun de un resultado: texto normalizado de titulo y descripcion (por separado, para que una frase no
// pueda cruzar de uno a otro), sus etiquetas (categorias y loaders: Modrinth tambien las toma como texto al buscar,
// asi que excluir "forge" saca los proyectos de Forge) y, en CurseForge, los datos que su API no filtra.
function view(hit, source) {
  const h = hit || {};
  const tags = [...(Array.isArray(h.categories) ? h.categories : []), ...(Array.isArray(h.loaders) ? h.loaders : [])].map((c) => normalizeText(c && typeof c === 'object' ? c.name : c)).filter(Boolean);
  const v = { texts: [normalizeText(h.title ?? h.name), normalizeText(h.description ?? h.summary)], tags };
  if (source !== 'curseforge') return v;
  const authors = Array.isArray(h.authors) && h.authors.length ? h.authors.map((a) => a && a.name) : [h.author];
  v.authors = authors.map(normalizeText).filter(Boolean);
  v.downloads = Number(h.downloads ?? h.downloadCount) || 0;
  v.updated = Date.parse(h.date_modified ?? h.dateModified) || 0;
  v.openSource = Boolean(h.links && (h.links.source ?? h.links.sourceUrl));
  return v;
}

// Funcion (resultado) => boolean con los criterios que la API de esa fuente no filtra:
//   Modrinth: frase y palabras excluidas.  CurseForge: ademas autor, descargas, fecha y codigo fuente enlazado.
function matcher(f, { source = 'modrinth', now = Date.now() } = {}) {
  const phrase = normalizeText(f && f.phrase);
  const exclude = ((f && f.exclude) || []).map(normalizeText).filter(Boolean);
  const cf = source === 'curseforge';
  const author = cf ? normalizeText(f && f.author) : '';
  const minDownloads = cf ? (f && f.minDownloads) || 0 : 0;
  const since = cf && f && f.updatedDays ? now - f.updatedDays * DAY : 0;
  const openSource = cf && Boolean(f && f.openSource);
  return (hit) => {
    const v = view(hit, source);
    if (phrase && !v.texts.some((t) => containsWords(t, phrase))) return false;
    for (const term of exclude) if (v.texts.some((t) => containsWords(t, term)) || v.tags.some((t) => containsWords(t, term))) return false;
    if (author && !v.authors.includes(author)) return false;
    if (minDownloads && v.downloads < minDownloads) return false;
    if (since && !(v.updated >= since)) return false;
    if (openSource && !v.openSource) return false;
    return true;
  };
}

const matches = (hit, f, opts) => matcher(f, opts)(hit);

// Junta `limit` resultados que cumplan `accept` pidiendo paginas a la API, hasta llenar la pagina o agotar la busqueda.
//   fetchPage(offset, size) -> Promise<{ hits: [], total }>   se pide siempre con offset multiplo de `rawSize`
//   accept(hit) -> boolean            stop(hit) -> boolean: corte anticipado (los que siguen ya no pueden cumplir)
//   reachable: tope de resultados que la API deja recorrer (CurseForge: 10.000)
//   maxRequests y deadlineMs acotan lo que se espera en una sola llamada: si se acaban sin juntar `limit`,
//   devuelve lo que hay con exhausted en false y `next` para seguir.
// Devuelve { hits, next, exhausted, capped, total, scanned, requests }:
//   next = posicion cruda desde donde seguir (justo despues del ultimo resultado revisado, sin saltear ni repetir)
//   exhausted = no queda nada por revisar   capped = la API corto antes del total
async function collect({ fetchPage, offset = 0, limit, rawSize, accept, stop = null, reachable = null, maxRequests = 8, deadlineMs = 6000 }) {
  const want = Math.max(1, Math.floor(limit) || 1);
  const size = Math.max(1, Math.floor(rawSize) || 1);
  const started = Date.now();
  const out = [];
  let pos = Math.max(0, Math.floor(offset) || 0);
  const first = pos;
  let total = null;
  let requests = 0;
  let exhausted = false;
  let capped = false;
  const end = () => (total === null ? Infinity : reachable === null ? total : Math.min(total, reachable));
  scan: while (out.length < want) {
    if (pos >= end()) {
      exhausted = true;
      break;
    }
    if (requests >= maxRequests || (requests > 0 && Date.now() - started > deadlineMs)) break;
    const base = pos - (pos % size);
    const page = await fetchPage(base, size);
    requests++;
    if (Number.isFinite(page && page.total)) total = page.total;
    else if (total === null) total = 0;
    const hits = Array.isArray(page && page.hits) ? page.hits : [];
    if (pos - base >= hits.length) {
      // pagina vacia, o mas corta de lo esperado: no hay mas resultados (o la API corto antes del total)
      exhausted = true;
      capped = pos < end();
      break;
    }
    for (let i = pos - base; i < hits.length; i++) {
      const hit = hits[i];
      pos++;
      if (stop && stop(hit)) {
        exhausted = true;
        break scan;
      }
      if (accept(hit)) {
        out.push(hit);
        if (out.length >= want) break scan;
      }
    }
  }
  if (!exhausted && total !== null && pos >= end()) exhausted = true;
  return { hits: out, next: pos, exhausted, capped, total: total ?? 0, scanned: pos - first, requests };
}

module.exports = {
  ENVIRONMENTS,
  AUTHOR_RE,
  normalizeText,
  containsWords,
  splitTerms,
  normalize,
  needsClient,
  apiQuery,
  modrinthFacets,
  matcher,
  matches,
  collect,
};
