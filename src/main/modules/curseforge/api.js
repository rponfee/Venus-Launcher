'use strict';
// Cliente de la API de CurseForge (https://api.curseforge.com/v1). Usa la API key del launcher, que viene incluida
// en core/app-config.js (curseforgeApiKey; la completa el dueño antes de compilar). Sin key, CurseForge queda
// desactivado. Los usuarios no cargan claves: la 'curseforge.apiKey' guardada por versiones anteriores se ignora.
const appConfig = require('../../core/app-config');
const http = require('../../core/http');
const { t } = require('../../core/i18n');
const { sleep } = require('../../core/util');
// Filtros extra de la busqueda (frase exacta, palabras excluidas, autor, descargas, fecha, codigo fuente).
const searchFilters = require('../../core/search-filters');

// VENUS_CURSEFORGE_API permite apuntar a un servidor de prueba local (solo 127.0.0.1 / localhost).
const BASE = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(process.env.VENUS_CURSEFORGE_API || '') ? process.env.VENUS_CURSEFORGE_API : 'https://api.curseforge.com';
const GAME_ID = 432;
const CLASS_IDS = { mod: 6, modpack: 4471, resourcepack: 12, shader: 6552, datapack: 6945 };
const TYPE_BY_CLASS = Object.fromEntries(Object.entries(CLASS_IDS).map(([k, v]) => [v, k]));
const LOADER_TYPES = { forge: 1, cauldron: 2, liteloader: 3, fabric: 4, quilt: 5, neoforge: 6 };
const LOADER_NAMES = { 1: 'forge', 2: 'cauldron', 3: 'liteloader', 4: 'fabric', 5: 'quilt', 6: 'neoforge' };
// ModsSearchSortField de la API
const SORT_FIELDS = { featured: 1, popularity: 2, updated: 3, name: 4, author: 5, downloads: 6, category: 7, gameVersion: 8, released: 11, rating: 12 };
const RELATIONS = { 1: 'embedded', 2: 'optional', 3: 'required', 4: 'tool', 5: 'incompatible', 6: 'include' };
const RELEASES = { 1: 'release', 2: 'beta', 3: 'alpha' };
const MAX_WINDOW = 10000; // la API no devuelve resultados mas alla de index + pageSize = 10.000
const MAX_PAGE = 50;
const TIMEOUT = 30000;

const MIN = 60 * 1000;

async function getKey() {
  return appConfig.get().curseforgeApiKey || null;
}

async function hasKey() {
  return Boolean(await getKey());
}

function cfError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

function userAgent() {
  try {
    return (typeof http.getUserAgent === 'function' && http.getUserAgent()) || 'VenusLauncher (venus-launcher)';
  } catch {
    return 'VenusLauncher (venus-launcher)';
  }
}

// Pedido a la API con la key del launcher.
async function request(pathname, { method = 'GET', body, retries = 2, notFound, signal } = {}) {
  const apiKey = await getKey();
  if (!apiKey) throw cfError(t('curseforge.errNoKey'), { code: 'nokey' });
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      const timeout = AbortSignal.timeout(TIMEOUT);
      res = await fetch(`${BASE}${pathname}`, {
        method,
        headers: {
          'x-api-key': apiKey,
          Accept: 'application/json',
          'User-Agent': userAgent(),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) throw signal.reason || err;
      lastErr = cfError(err?.name === 'TimeoutError' ? t('curseforge.errTimeout') : t('curseforge.errNetwork'), { code: 'network', cause: err });
      if (attempt < retries) {
        await sleep(700 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw cfError(t('curseforge.errBadKey'), { status: res.status, code: 'badkey' });
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw cfError(notFound || t('curseforge.errNotFound'), { status: 404, code: 'notfound' });
    }
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(30, Number(res.headers.get('retry-after')) || 2 ** (attempt + 1));
      await res.body?.cancel().catch(() => {});
      lastErr = cfError(res.status === 429 ? t('curseforge.errRateLimit') : t('curseforge.errServer', { status: res.status }), { status: res.status, code: res.status === 429 ? 'ratelimit' : 'server' });
      if (attempt < retries) {
        await sleep(wait * 1000);
        continue;
      }
      throw lastErr;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw cfError(t('curseforge.errApi', { status: res.status, detail: text.slice(0, 160) || res.statusText }), { status: res.status, code: 'api' });
    }
    try {
      return await res.json();
    } catch {
      throw cfError(t('curseforge.errBadResponse'), { code: 'parse' });
    }
  }
  throw lastErr;
}

// Cache en memoria (con pedidos en vuelo compartidos).
const memo = new Map();
function remember(key, ttl, fn) {
  const hit = memo.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < ttl)) return (hit.pending || Promise.resolve(hit.value)).then((v) => (v && typeof v === 'object' ? structuredClone(v) : v));
  const pending = fn().then(
    (value) => {
      memo.set(key, { at: Date.now(), value });
      while (memo.size > 300) memo.delete(memo.keys().next().value);
      return value;
    },
    (err) => {
      memo.delete(key);
      throw err;
    },
  );
  memo.set(key, { pending, at: Date.now() });
  return pending.then((v) => (v && typeof v === 'object' ? structuredClone(v) : v));
}

function qs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

// ---------- Normalizacion para la interfaz ----------

const MC_VERSION = /^(\d+\.\d+(\.\d+)?(-(pre|rc)[\w.-]*)?|\d\dw\d\d[a-z])$/i;
const LOADER_WORDS = { forge: 'forge', fabric: 'fabric', quilt: 'quilt', neoforge: 'neoforge', liteloader: 'liteloader', rift: 'rift', cauldron: 'cauldron' };

function splitGameVersions(list = []) {
  const versions = [];
  const loaders = [];
  let client = false;
  let server = false;
  for (const raw of list) {
    const v = String(raw || '').trim();
    const low = v.toLowerCase().replace(/\s+/g, '');
    if (MC_VERSION.test(v)) versions.push(v);
    else if (LOADER_WORDS[low]) loaders.push(LOADER_WORDS[low]);
    else if (low === 'client') client = true;
    else if (low === 'server') server = true;
  }
  return { versions, loaders, client, server };
}

function typeForClass(classId) {
  return TYPE_BY_CLASS[classId] || 'mod';
}

function normalizeMod(m) {
  if (!m) return null;
  const indexes = (m.latestFilesIndexes || []).map((f) => ({
    gameVersion: f.gameVersion,
    fileId: f.fileId,
    fileName: f.filename,
    releaseType: RELEASES[f.releaseType] || 'release',
    loader: LOADER_NAMES[f.modLoader] || null,
  }));
  const gameVersions = [...new Set(indexes.map((i) => i.gameVersion).filter((v) => MC_VERSION.test(v || '')))];
  return {
    source: 'curseforge',
    id: m.id,
    slug: m.slug,
    title: m.name,
    description: m.summary || '',
    author: m.authors?.[0]?.name || '',
    authors: (m.authors || []).map((a) => ({ id: a.id, name: a.name, url: a.url })),
    icon_url: m.logo?.thumbnailUrl || m.logo?.url || null,
    downloads: m.downloadCount || 0,
    thumbsUp: m.thumbsUpCount || 0,
    date_created: m.dateCreated,
    date_modified: m.dateModified,
    date_released: m.dateReleased,
    categories: (m.categories || []).map((c) => ({ id: c.id, name: c.name, slug: c.slug, icon: c.iconUrl || null })),
    classId: m.classId,
    project_type: typeForClass(m.classId),
    links: { website: m.links?.websiteUrl || null, wiki: m.links?.wikiUrl || null, issues: m.links?.issuesUrl || null, source: m.links?.sourceUrl || null },
    screenshots: (m.screenshots || []).map((s) => ({ title: s.title || '', description: s.description || '', url: s.url, thumb: s.thumbnailUrl || s.url })),
    mainFileId: m.mainFileId,
    latestFiles: indexes,
    gameVersions,
    loaders: [...new Set(indexes.map((i) => i.loader).filter(Boolean))],
    allowDistribution: m.allowModDistribution !== false,
    available: m.isAvailable !== false,
  };
}

function hashOf(f, algo) {
  return (f.hashes || []).find((x) => x.algo === algo)?.value || null;
}

function normalizeFile(f) {
  if (!f) return null;
  const split = splitGameVersions(f.gameVersions);
  return {
    id: f.id,
    modId: f.modId,
    displayName: f.displayName || f.fileName,
    fileName: f.fileName,
    releaseType: RELEASES[f.releaseType] || 'release',
    date: f.fileDate,
    size: f.fileLength || 0,
    downloads: f.downloadCount || 0,
    downloadUrl: f.downloadUrl || null,
    gameVersions: split.versions,
    loaders: split.loaders,
    client: split.client,
    server: split.server,
    sha1: hashOf(f, 1),
    fingerprint: f.fileFingerprint,
    dependencies: (f.dependencies || []).map((d) => ({ modId: d.modId, type: RELATIONS[d.relationType] || 'optional' })),
    isServerPack: Boolean(f.isServerPack),
    serverPackFileId: f.serverPackFileId || null,
    available: f.isAvailable !== false,
  };
}

// ---------- Endpoints ----------

// params: { query, type, classId, categoryId, gameVersion, loader, sort, sortOrder, index, pageSize,
//           phrase, exclude (texto o arreglo de palabras), author, minDownloads, updatedDays, openSource }
// CurseForge no filtra por ninguno de los criterios extra (searchFilter solo mira nombre y autor): se filtran
// aca (autor por nombre exacto, openSource = tiene enlace al codigo fuente). Con alguno activo se piden paginas
// de a 50 hasta juntar `pageSize` resultados (ver search-filters.collect) y total pasa a ser el de la API sin
// ese filtro (filtered: true). Para seguir paginando: next_index (desde donde pedir lo que sigue) y exhausted.
async function search(params = {}) {
  const pageSize = Math.max(1, Math.min(MAX_PAGE, Math.floor(Number(params.pageSize) || 24)));
  const index = Math.max(0, Math.min(MAX_WINDOW - pageSize, Math.floor(Number(params.index) || 0)));
  const classId = params.classId || CLASS_IDS[params.type] || CLASS_IDS.mod;
  const sortField = SORT_FIELDS[params.sort] || SORT_FIELDS.popularity;
  const sortOrder = params.sortOrder === 'asc' || (params.sort === 'name' && params.sortOrder !== 'desc') ? 'asc' : 'desc';
  const f = searchFilters.normalize(params);
  const base = {
    gameId: GAME_ID,
    classId,
    searchFilter: String(params.query || '').trim().slice(0, 200) || undefined,
    categoryId: params.categoryId || undefined,
    gameVersion: params.gameVersion || undefined,
    modLoaderType: LOADER_TYPES[params.loader] || undefined,
    sortField,
    sortOrder,
  };
  const fetchPage = async (idx, size) => {
    const query = qs({ ...base, index: idx, pageSize: size });
    const res = await remember(`search?${query}`, MIN, () => request(`/v1/mods/search?${query}`));
    return { hits: (res?.data || []).map(normalizeMod), total: Number(res?.pagination?.totalCount) || 0 };
  };
  if (!searchFilters.needsClient(f, 'curseforge')) {
    const { hits, total } = await fetchPage(index, pageSize);
    const next = index + hits.length;
    return {
      hits,
      total,
      index,
      pageSize,
      // cuantos resultados se pueden recorrer como maximo
      reachable: Math.min(total, MAX_WINDOW),
      capped: total > MAX_WINDOW,
      next_index: next,
      exhausted: hits.length < pageSize || next >= Math.min(total, MAX_WINDOW),
      filtered: false,
    };
  }
  // Con el orden por descargas o por actualizacion (de mayor a menor) los que siguen ya no pueden cumplir el minimo
  // ni la fecha: se corta cuando varios seguidos ya no lo cumplen, en lugar de recorrer miles de resultados.
  // (Varios y no uno solo, por si el orden de CurseForge no coincide exacto con el campo que se compara.)
  const now = Date.now();
  const since = f.updatedDays ? now - f.updatedDays * 86400000 : 0;
  const trailing = (fails, n) => {
    let run = 0;
    return (hit) => (fails(hit) ? ++run >= n : ((run = 0), false));
  };
  let stop = null;
  if (sortOrder === 'desc' && params.sort === 'downloads' && f.minDownloads) stop = trailing((hit) => hit.downloads < f.minDownloads, 3);
  else if (sortOrder === 'desc' && params.sort === 'updated' && since) stop = trailing((hit) => !((Date.parse(hit.date_modified) || 0) >= since), 25);
  const r = await searchFilters.collect({ fetchPage, offset: index, limit: pageSize, rawSize: MAX_PAGE, accept: searchFilters.matcher(f, { source: 'curseforge', now }), stop, reachable: MAX_WINDOW, maxRequests: 12 });
  return {
    hits: r.hits,
    total: r.total,
    index,
    pageSize,
    reachable: Math.min(r.total, MAX_WINDOW),
    capped: r.total > MAX_WINDOW,
    next_index: r.next,
    exhausted: r.exhausted,
    filtered: true,
    scanned: r.scanned,
  };
}

async function getModRaw(id) {
  const res = await remember(`mod/${id}`, 5 * MIN, () => request(`/v1/mods/${encodeURIComponent(id)}`, { notFound: t('curseforge.errProjectNotFound') }));
  return res.data;
}

async function getDescription(id) {
  const res = await remember(`desc/${id}`, 10 * MIN, () => request(`/v1/mods/${encodeURIComponent(id)}/description`, { notFound: t('curseforge.errProjectNotFound') }));
  return typeof res?.data === 'string' ? res.data : '';
}

// Datos crudos de la API (para otros modulos: importacion de packs, analisis de seguridad).
async function getMods(ids) {
  const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = [];
  for (let i = 0; i < list.length; i += 500) {
    const res = await request('/v1/mods', { method: 'POST', body: { modIds: list.slice(i, i + 500), filterPcOnly: true } });
    out.push(...(res?.data || []));
  }
  return out;
}

async function getFiles(fileIds) {
  const list = [...new Set((fileIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = [];
  for (let i = 0; i < list.length; i += 500) {
    const res = await request('/v1/mods/files', { method: 'POST', body: { fileIds: list.slice(i, i + 500) } });
    out.push(...(res?.data || []));
  }
  return out;
}

async function getFileRaw(modId, fileId) {
  const res = await remember(`file/${modId}/${fileId}`, 10 * MIN, () => request(`/v1/mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(fileId)}`, { notFound: t('curseforge.errFileNotFound') }));
  return res.data;
}

// filters: { gameVersion, loader, index, pageSize }
async function getModFiles(modId, filters = {}) {
  const pageSize = Math.max(1, Math.min(MAX_PAGE, Math.floor(Number(filters.pageSize) || MAX_PAGE)));
  const index = Math.max(0, Math.floor(Number(filters.index) || 0));
  const query = qs({ gameVersion: filters.gameVersion || undefined, modLoaderType: LOADER_TYPES[filters.loader] || undefined, index, pageSize });
  const res = await remember(`files/${modId}?${query}`, 3 * MIN, () => request(`/v1/mods/${encodeURIComponent(modId)}/files?${query}`, { notFound: t('curseforge.errProjectNotFound') }));
  return { data: res?.data || [], total: Number(res?.pagination?.totalCount) || 0, index, pageSize };
}

async function getChangelog(modId, fileId) {
  const res = await remember(`changelog/${modId}/${fileId}`, 30 * MIN, () => request(`/v1/mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(fileId)}/changelog`, { notFound: t('curseforge.errFileNotFound') }));
  return typeof res?.data === 'string' ? res.data : '';
}

// URL de descarga; null si el autor no permite descargas desde otras apps.
async function getDownloadUrl(modId, fileId) {
  try {
    const res = await request(`/v1/mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(fileId)}/download-url`);
    return typeof res?.data === 'string' && /^https:\/\//i.test(res.data) ? res.data : null;
  } catch (err) {
    if (err.code === 'notfound' || err.status === 403) return null;
    throw err;
  }
}

async function fingerprintMatches(fingerprints) {
  const list = [...new Set((fingerprints || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff))];
  if (!list.length) return { exactMatches: [], exactFingerprints: [], partialMatches: [], unmatchedFingerprints: [], installedFingerprints: [] };
  const res = await request(`/v1/fingerprints/${GAME_ID}`, { method: 'POST', body: { fingerprints: list } });
  return res?.data || { exactMatches: [], exactFingerprints: [], unmatchedFingerprints: list };
}

async function getCategories(type) {
  const classId = CLASS_IDS[type] || CLASS_IDS.mod;
  const res = await remember(`categories/${classId}`, 24 * 60 * MIN, () => request(`/v1/categories?${qs({ gameId: GAME_ID, classId })}`));
  return (res?.data || [])
    .filter((c) => !c.isClass && c.classId === classId)
    .map((c) => ({ id: c.id, name: c.name, slug: c.slug, icon: c.iconUrl || null, parent: c.parentCategoryId || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Pagina de un proyecto en curseforge.com (para descargas manuales).
function fileWebUrl(mod, fileId) {
  const site = mod?.links?.websiteUrl || mod?.links?.website || null;
  if (site) return `${site.replace(/\/+$/, '')}/files/${fileId}`;
  return `https://www.curseforge.com/projects/${mod?.id}`;
}

module.exports = {
  GAME_ID,
  CLASS_IDS,
  LOADER_TYPES,
  LOADER_NAMES,
  SORT_FIELDS,
  MAX_WINDOW,
  getKey,
  hasKey,
  request,
  search,
  getModRaw,
  getDescription,
  getMods,
  getFiles,
  getFileRaw,
  getModFiles,
  getChangelog,
  getDownloadUrl,
  fingerprintMatches,
  getCategories,
  normalizeMod,
  normalizeFile,
  splitGameVersions,
  typeForClass,
  fileWebUrl,
};
