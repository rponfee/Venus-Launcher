'use strict';
// Integracion con Modrinth: cliente de la API (respeta el limite de pedidos y guarda cache), busqueda con
// todos los filtros, instalacion con dependencias, modpacks (.mrpack), identificacion de archivos locales
// y actualizaciones.
const fsp = require('fs/promises');
const path = require('path');
const AdmZip = require('adm-zip');
const paths = require('./paths');
const http = require('./http');
const { t } = require('./i18n');
const { hashFile, readJson, writeJson, sleep } = require('./util');
// Rutas seguras, dominios del formato .mrpack y escrituras que respetan los enlaces duros (compartido).
const safety = require('../modules/packs/safety');
// Filtros extra de la busqueda (frase exacta, palabras excluidas, autor, descargas, fecha, codigo abierto, entorno).
const searchFilters = require('./search-filters');

const API = 'https://api.modrinth.com/v2';
const API_V3 = 'https://api.modrinth.com/v3';

const FOLDERS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks', plugin: 'plugins' };
const PROJECT_TYPES = ['mod', 'modpack', 'resourcepack', 'shader', 'datapack', 'plugin'];
const SORTS = ['relevance', 'downloads', 'follows', 'newest', 'updated'];
const MAX_LIMIT = 100;
const IRIS_ID = 'YL57xq9U';
const CANVAS_ID = 'VOYxIjFI';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Valores del facet "environment" que funcionan en el cliente o en un servidor dedicado (viven en search-filters).
const ENVIRONMENTS = searchFilters.ENVIRONMENTS;

// Licencias mas usadas en Modrinth (identificadores SPDX tal como los guarda la API).
const POPULAR_LICENSES = [
  'MIT',
  'Apache-2.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'LGPL-2.1-only',
  'MPL-2.0',
  'AGPL-3.0-only',
  'BSD-3-Clause',
  'Unlicense',
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-4.0',
  'CC-BY-NC-SA-4.0',
  'CC-BY-NC-ND-4.0',
  'LicenseRef-All-Rights-Reserved',
  'LicenseRef-Custom',
];

function q(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`)
    .join('&');
}

// ---------- Cliente HTTP con limite de pedidos ----------
// Modrinth permite ~300 pedidos por minuto por IP e informa el saldo en X-Ratelimit-*.
// Cuando quedan pocos se espera a que se renueve la ventana en lugar de recibir errores 429.

const LOW_WATER = 6;
const MAX_PARALLEL = 6;
const TIMEOUT = 30000;
const rate = { limit: 300, remaining: 300, resetAt: 0, active: 0, waiting: [] };

function userAgent() {
  try {
    return (typeof http.getUserAgent === 'function' && http.getUserAgent()) || 'VenusLauncher (venus-launcher)';
  } catch {
    return 'VenusLauncher (venus-launcher)';
  }
}

async function acquire() {
  if (rate.active >= MAX_PARALLEL) await new Promise((resolve) => rate.waiting.push(resolve));
  rate.active++;
  const now = Date.now();
  if (now >= rate.resetAt) rate.remaining = Math.max(rate.remaining, LOW_WATER + 1);
  if (rate.remaining <= LOW_WATER && rate.resetAt > now) await sleep(Math.min(rate.resetAt - now + 250, 65000));
  rate.remaining--;
}

function release() {
  rate.active = Math.max(0, rate.active - 1);
  const next = rate.waiting.shift();
  if (next) next();
}

function track(res) {
  const limit = Number(res.headers.get('x-ratelimit-limit'));
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (Number.isFinite(limit) && limit > 0) rate.limit = limit;
  if (remaining !== null && Number.isFinite(Number(remaining))) rate.remaining = Number(remaining);
  if (reset !== null && Number.isFinite(Number(reset))) rate.resetAt = Date.now() + Number(reset) * 1000;
}

function apiError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

async function request(url, { method = 'GET', body, signal, retries = 3, notFound } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res = null;
    let netErr = null;
    await acquire();
    try {
      const timeout = AbortSignal.timeout(TIMEOUT);
      res = await fetch(url, {
        method,
        headers: {
          'User-Agent': userAgent(),
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      track(res);
    } catch (err) {
      netErr = err;
    } finally {
      release();
    }

    if (netErr) {
      if (signal?.aborted) throw signal.reason || netErr;
      const timedOut = netErr?.name === 'TimeoutError';
      lastErr = apiError(timedOut ? t('modrinth.errTimeout') : t('modrinth.errNetwork'), { code: timedOut ? 'timeout' : 'network', cause: netErr });
      if (attempt < retries) {
        await sleep(600 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }

    if (res.status === 429) {
      const secs = Number(res.headers.get('x-ratelimit-reset')) || Number(res.headers.get('retry-after')) || 2 ** (attempt + 1);
      rate.remaining = 0;
      rate.resetAt = Date.now() + secs * 1000;
      lastErr = apiError(t('modrinth.errRateLimit', { seconds: Math.ceil(secs) }), { status: 429, code: 'ratelimit' });
      await res.body?.cancel().catch(() => {});
      if (attempt < retries && secs <= 65) {
        await sleep(secs * 1000 + 250);
        continue;
      }
      throw lastErr;
    }
    if (res.status >= 500) {
      lastErr = apiError(t('modrinth.errServer', { status: res.status }), { status: res.status, code: 'server' });
      await res.body?.cancel().catch(() => {});
      if (attempt < retries) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw apiError(notFound || t('modrinth.errNotFound'), { status: 404, code: 'notfound' });
    }
    if (res.status === 410) {
      await res.body?.cancel().catch(() => {});
      throw apiError(t('modrinth.errGone'), { status: 410, code: 'gone' });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = text.slice(0, 200);
      try {
        const j = JSON.parse(text);
        detail = j.description || j.error || detail;
      } catch {
        /* respuesta sin JSON */
      }
      throw apiError(t('modrinth.errApi', { status: res.status, detail: detail || res.statusText }), { status: res.status, code: 'api' });
    }
    if (res.status === 204) return null;
    try {
      return await res.json();
    } catch {
      throw apiError(t('modrinth.errBadResponse'), { code: 'parse' });
    }
  }
  throw lastErr;
}

// ---------- Cache en memoria (con pedidos en vuelo compartidos) ----------

const memo = new Map();
const MEMO_MAX = 500;
const clone = (v) => (v && typeof v === 'object' ? structuredClone(v) : v);

function remember(key, ttl, fn) {
  const hit = memo.get(key);
  if (hit) {
    if (hit.pending) return hit.pending.then(clone);
    if (Date.now() - hit.at < hit.ttl) {
      memo.delete(key);
      memo.set(key, hit);
      return Promise.resolve(clone(hit.value));
    }
    memo.delete(key);
  }
  const pending = fn().then(
    (value) => {
      memo.set(key, { at: Date.now(), ttl, value });
      while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
      return value;
    },
    (err) => {
      memo.delete(key);
      throw err;
    },
  );
  memo.set(key, { pending, at: Date.now(), ttl });
  return pending.then(clone);
}

function clearCache() {
  memo.clear();
}

// Cache en disco con respaldo sin conexion (etiquetas que cambian poco).
async function diskCached(name, maxAge, fn) {
  const file = paths.cache(name);
  try {
    const st = await fsp.stat(file);
    if (Date.now() - st.mtimeMs < maxAge) return await readJson(file);
  } catch {
    /* sin cache */
  }
  try {
    const data = await fn();
    await writeJson(file, data).catch(() => {});
    return data;
  } catch (err) {
    const old = await readJson(file, null);
    if (old) return old;
    throw err;
  }
}

// Pedido a la API. opts.ttl (ms) guarda la respuesta en memoria; opts.base cambia a la API v3.
function api(pathname, { ttl = 0, base = API, ...opts } = {}) {
  const url = `${base}${pathname}`;
  if (!ttl || (opts.method && opts.method !== 'GET')) return request(url, opts);
  return remember(url, ttl, () => request(url, opts));
}

function rateLimit() {
  return { limit: rate.limit, remaining: Math.max(0, rate.remaining), resetIn: Math.max(0, Math.round((rate.resetAt - Date.now()) / 1000)) };
}

// ---------- Loaders compatibles ----------

// loaders validos para mods segun el loader de la instancia
function modLoadersFor(instance) {
  switch (instance?.loader) {
    case 'fabric':
      return ['fabric'];
    case 'legacyfabric':
      return ['legacy-fabric', 'fabric'];
    case 'quilt':
      return ['quilt', 'fabric'];
    case 'forge':
      return ['forge'];
    case 'neoforge':
      return instance.mcVersion === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge'];
    case 'babric':
      return ['babric'];
    default:
      return [];
  }
}

function hasProject(instance, id, titleRe) {
  const projects = instance?.modrinth?.projects || {};
  if (projects[id]) return true;
  return Boolean(titleRe && Object.values(projects).some((p) => titleRe.test(p?.title || '')));
}

// Shaders: Iris/Oculus cargan los de formato Iris, OptiFine los suyos y Canvas los propios.
// (Los "core shaders" con loader vanilla son resource packs: ver folderFor.) Vacio = la instancia no carga shaders.
function shaderLoadersFor(instance) {
  if (!instance) return [];
  const out = [];
  if (instance.loader === 'optifine') out.push('optifine');
  if (instance.preset === 'iris' || hasProject(instance, IRIS_ID, /^(iris|oculus)\b/i)) out.push('iris');
  if (hasProject(instance, CANVAS_ID)) out.push('canvas');
  return out;
}

function loadersFor(type, instance) {
  if (type === 'mod') return modLoadersFor(instance);
  if (type === 'shader') return shaderLoadersFor(instance);
  if (type === 'resourcepack') return ['minecraft'];
  if (type === 'datapack') return ['datapack'];
  return [];
}

// ---------- Busqueda ----------

// Facets de Modrinth: cada arreglo interno es un OR y los arreglos se combinan con AND.
// Autor, descargas minimas, fecha de actualizacion, codigo abierto y entorno salen de search-filters.modrinthFacets.
function buildFacets(p = {}, { now = Date.now() } = {}) {
  const type = PROJECT_TYPES.includes(p.type) ? p.type : 'mod';
  const facets = [[`project_type:${type}`]];
  const versions = [...new Set([...(Array.isArray(p.gameVersions) ? p.gameVersions : []), ...(p.gameVersion ? [p.gameVersion] : [])].filter(Boolean).map(String))];
  if (versions.length) facets.push(versions.map((v) => `versions:${v}`));
  if (Array.isArray(p.loaders) && p.loaders.length) facets.push([...new Set(p.loaders.map(String))].map((l) => `categories:${l}`));
  for (const c of p.categories || []) facets.push([`categories:${c}`]);
  for (const c of p.excludeCategories || []) facets.push([`categories!=${c}`]);
  const env = p.environment || (p.serverSide ? 'server' : p.clientSide ? 'client' : null);
  facets.push(...searchFilters.modrinthFacets(searchFilters.normalize({ ...p, environment: env }), { now }));
  if (p.license) facets.push([`license:${p.license}`]);
  return facets;
}

// params: { query, type, sort, offset, limit, gameVersion, gameVersions[], loaders[], categories[],
//           excludeCategories[], environment: 'client'|'server', serverSide, openSource, license,
//           author, minDownloads, updatedDays, phrase, exclude (texto o arreglo de palabras) }
// Devuelve la respuesta de Modrinth ({ hits, offset, limit, total_hits }) + capped si la API corta antes, y
// para seguir paginando: next_offset (desde donde pedir lo que sigue), exhausted (no queda nada) y filtered.
// Con phrase o exclude (que la API no admite) se filtra aca: se piden paginas de a 100 hasta juntar `limit`
// resultados y total_hits pasa a ser el de la API sin ese filtro (filtered: true avisa que no es el total real).
async function search(params = {}) {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(params.limit) || 20)));
  const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
  const index = SORTS.includes(params.sort) ? params.sort : 'relevance';
  const f = searchFilters.normalize(params);
  // Un autor con espacios o simbolos no existe en Modrinth: nada puede cumplirlo
  if (f.authorInvalid) return { hits: [], offset, limit, total_hits: 0, capped: false, next_offset: offset, exhausted: true, filtered: false };
  const query = searchFilters.apiQuery(String(params.query || '').trim().slice(0, 300), f);
  const facets = buildFacets(params);
  const fetchPage = async (off, size) => {
    const res = await api(`/search?${q({ query, facets, index, offset: off, limit: size })}`, { ttl: MIN });
    return { res, hits: Array.isArray(res?.hits) ? res.hits : [], total: Number(res?.total_hits) || 0 };
  };
  if (!searchFilters.needsClient(f, 'modrinth')) {
    const { res, hits, total } = await fetchPage(offset, limit);
    const next = offset + hits.length;
    return { ...res, hits, total_hits: total, capped: hits.length === 0 && offset > 0 && offset < total, next_offset: next, exhausted: hits.length < limit || next >= total, filtered: false };
  }
  const r = await searchFilters.collect({ fetchPage, offset, limit, rawSize: MAX_LIMIT, accept: searchFilters.matcher(f, { source: 'modrinth' }) });
  return { hits: r.hits, offset, limit, total_hits: r.total, capped: r.capped, next_offset: r.next, exhausted: r.exhausted, filtered: true, scanned: r.scanned };
}

// ---------- Proyectos, versiones y equipo ----------

async function getProject(id) {
  if (!id) throw apiError(t('modrinth.errBadProject'), { code: 'bad' });
  return api(`/project/${encodeURIComponent(id)}`, { ttl: 5 * MIN, notFound: t('modrinth.errProjectNotFound') });
}

async function getProjects(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return [];
  const out = [];
  for (let i = 0; i < list.length; i += 100) out.push(...(await api(`/projects?${q({ ids: list.slice(i, i + 100) })}`, { ttl: 5 * MIN })));
  return out;
}

// filters: { loaders[], gameVersions[], featured, includeChangelog } (los changelogs vienen salvo includeChangelog: false)
async function getVersions(projectId, { loaders, gameVersions, featured, includeChangelog } = {}) {
  return api(
    `/project/${encodeURIComponent(projectId)}/version?${q({
      loaders: loaders?.length ? loaders : undefined,
      game_versions: gameVersions?.length ? gameVersions : undefined,
      featured: typeof featured === 'boolean' ? featured : undefined,
      include_changelog: includeChangelog === false ? false : undefined,
    })}`,
    { ttl: 3 * MIN, notFound: t('modrinth.errProjectNotFound') },
  );
}

async function getVersion(versionId) {
  return api(`/version/${encodeURIComponent(versionId)}`, { ttl: 5 * MIN, notFound: t('modrinth.errVersionNotFound') });
}

async function getVersionsByIds(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return [];
  const out = [];
  for (let i = 0; i < list.length; i += 100) out.push(...(await api(`/versions?${q({ ids: list.slice(i, i + 100) })}`, { ttl: 5 * MIN })));
  return out;
}

async function getMembers(projectId) {
  return api(`/project/${encodeURIComponent(projectId)}/members`, { ttl: 30 * MIN, notFound: t('modrinth.errProjectNotFound') });
}

async function getOrganization(id) {
  return api(`/organization/${encodeURIComponent(id)}`, { base: API_V3, ttl: 30 * MIN });
}

async function getDependencies(projectId) {
  return api(`/project/${encodeURIComponent(projectId)}/dependencies`, { ttl: 10 * MIN, notFound: t('modrinth.errProjectNotFound') });
}

function slimUser(m) {
  const u = m?.user || {};
  return { id: u.id, username: u.username, avatar_url: u.avatar_url || null, role: m?.role || '', accepted: m?.accepted !== false, ordering: m?.ordering ?? 0 };
}

// Equipo del proyecto: miembros y organizacion (si la tiene), sin datos privados.
async function getTeam(idOrProject) {
  const project = idOrProject && typeof idOrProject === 'object' ? idOrProject : await getProject(idOrProject);
  const [members, org] = await Promise.all([
    getMembers(project.id).catch(() => []),
    project.organization ? getOrganization(project.organization).catch(() => null) : null,
  ]);
  return {
    members: (members || []).map(slimUser).filter((m) => m.accepted).sort((a, b) => a.ordering - b.ordering),
    organization: org
      ? {
          id: org.id,
          slug: org.slug,
          name: org.name,
          description: org.description || '',
          icon_url: org.icon_url || null,
          members: (org.members || []).map(slimUser).filter((m) => m.accepted).sort((a, b) => a.ordering - b.ordering),
        }
      : null,
  };
}

async function getTags() {
  return remember('tags', 30 * MIN, async () => {
    const [categories, loaders, gameVersions] = await Promise.all([
      diskCached('modrinth-categories.json', DAY, () => request(`${API}/tag/category`)),
      diskCached('modrinth-loaders.json', DAY, () => request(`${API}/tag/loader`)),
      diskCached('modrinth-game-versions.json', 6 * HOUR, () => request(`${API}/tag/game_version`)),
    ]);
    return { categories, loaders, gameVersions, licenses: POPULAR_LICENSES };
  });
}

const PLUGIN_LOADERS = new Set(['bukkit', 'bungeecord', 'folia', 'paper', 'purpur', 'spigot', 'sponge', 'velocity', 'waterfall', 'geyser']);

// Filtros disponibles para un tipo de proyecto: categorias agrupadas por encabezado, loaders,
// versiones del juego y licencias populares.
async function getTypeTags(type) {
  const kind = PROJECT_TYPES.includes(type) ? type : 'mod';
  const tags = await getTags();
  const catType = kind === 'datapack' || kind === 'plugin' ? 'mod' : kind;
  const groups = new Map();
  for (const c of tags.categories || []) {
    if (c.project_type !== catType) continue;
    if (!groups.has(c.header)) groups.set(c.header, []);
    groups.get(c.header).push(c.name);
  }
  const order = ['categories', 'features', 'resolutions', 'performance impact'];
  const categories = [...groups.entries()]
    .sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99))
    .map(([header, names]) => ({ header, names: header === 'resolutions' ? names.sort((x, y) => parseInt(x, 10) - parseInt(y, 10)) : names.sort() }));
  let loaders = (tags.loaders || []).filter((l) => (l.supported_project_types || []).includes(kind)).map((l) => l.name);
  if (kind === 'mod') loaders = loaders.filter((l) => !PLUGIN_LOADERS.has(l) && l !== 'datapack');
  if (kind === 'resourcepack' || kind === 'datapack') loaders = [];
  const first = ['fabric', 'forge', 'neoforge', 'quilt', 'iris', 'optifine', 'paper', 'purpur', 'spigot', 'bukkit'];
  loaders.sort((a, b) => (first.indexOf(a) + 1 || 99) - (first.indexOf(b) + 1 || 99) || a.localeCompare(b));
  return {
    type: kind,
    categories,
    loaders,
    gameVersions: (tags.gameVersions || []).map((v) => ({ version: v.version, type: v.version_type, date: v.date, major: Boolean(v.major) })),
    licenses: tags.licenses || POPULAR_LICENSES,
  };
}

// ---------- Instalacion ----------

function primaryFile(version) {
  return version.files.find((f) => f.primary) || version.files[0];
}

async function pickVersion(projectId, gameVersion, loaders) {
  const list = await getVersions(projectId, { loaders, gameVersions: gameVersion ? [gameVersion] : undefined, includeChangelog: false });
  if (!list.length) return null;
  return list.find((v) => v.version_type === 'release') || list.find((v) => v.version_type === 'beta') || list[0];
}

// Calcula que archivos instalar (el proyecto + dependencias requeridas que falten).
async function resolveInstall(target, projectId, versionId, opts = {}) {
  const { gameVersion, installed = {} } = target;
  const plan = [];
  const visited = new Set(Object.keys(installed));
  const warnings = [];

  async function add(pid, vid, depth, explicitType) {
    if (depth > 6) return;
    if (pid && visited.has(pid) && depth > 0) return;
    let version;
    if (vid) version = await getVersion(vid);
    if (!version && pid) {
      const project = await getProject(pid);
      const loaders = target.loadersFor(project.project_type);
      version = await pickVersion(pid, gameVersion, loaders);
      if (!version) {
        if (depth === 0) {
          throw new Error(
            loaders.length
              ? t('modrinth.errNoCompatibleLoaders', { title: project.title, gameVersion, loaders: loaders.join('/') })
              : t('modrinth.errNoCompatible', { title: project.title, gameVersion }),
          );
        }
        warnings.push(t('modrinth.warnDepNoVersion', { title: project.title }));
        return;
      }
    }
    if (!version) return;
    if (!version.files?.length) throw new Error(t('modrinth.errNoFiles'));
    const projectIdReal = version.project_id;
    if (visited.has(projectIdReal) && depth > 0) return;
    visited.add(projectIdReal);
    const project = await getProject(projectIdReal);
    const type = explicitType || project.project_type;
    plan.push({ project, version, file: primaryFile(version), type });
    if (opts.dependencies === false) return;
    for (const dep of version.dependencies || []) {
      if (dep.dependency_type === 'incompatible' && dep.project_id && installed[dep.project_id]) {
        warnings.push(t('modrinth.warnIncompatible', { title: project.title, other: installed[dep.project_id].title || dep.project_id }));
      }
      if (dep.dependency_type !== 'required') continue;
      if (dep.project_id && visited.has(dep.project_id)) continue;
      await add(dep.project_id, dep.version_id, depth + 1);
    }
  }

  await add(projectId, versionId, 0, opts.type);
  return { plan, warnings };
}

// Carpeta de destino: los "core shaders" (solo loader vanilla) son resource packs.
function folderFor(type, version) {
  if (type === 'shader' && version?.loaders?.length && version.loaders.every((l) => l === 'vanilla')) return FOLDERS.resourcepack;
  return FOLDERS[type] || 'mods';
}

// Descarga los archivos del plan a la carpeta base (instancia o servidor).
async function executePlan(baseDir, plan, { installed = {}, world, task } = {}) {
  const records = {};
  const items = [];
  for (const p of plan) {
    let folder = folderFor(p.type, p.version);
    if (p.type === 'datapack') {
      if (!world) throw new Error(t('modrinth.errNeedWorld'));
      if (typeof world !== 'string' || world !== path.basename(world) || world === '.' || world === '..') throw new Error(t('modrinth.errBadWorld'));
      folder = path.join('saves', world, 'datapacks');
    }
    const fileName = path.basename(p.file.filename);
    const dir = path.join(baseDir, folder);
    const dest = path.join(dir, fileName);
    const prev = installed[p.project.id];
    if (prev?.file && prev.file !== fileName) {
      await fsp.rm(path.join(baseDir, prev.folder || folder, path.basename(prev.file)), { force: true }).catch(() => {});
    }
    items.push({ url: p.file.url, path: dest, sha1: p.file.hashes?.sha1, size: p.file.size });
    records[p.project.id] = {
      title: p.project.title,
      icon: p.project.icon_url || null,
      type: p.type,
      versionId: p.version.id,
      versionNumber: p.version.version_number,
      file: fileName,
      folder,
      installedAt: Date.now(),
    };
  }
  await http.downloadAll(items, { concurrency: 6, verify: 'hash', signal: task?.signal, onProgress: task?.downloadProgress('Modrinth') });
  return records;
}

// ---------- Modpacks ----------

async function readMrpack(file) {
  let zip;
  let index;
  try {
    zip = new AdmZip(file);
    index = JSON.parse(zip.readAsText('modrinth.index.json').replace(/^\s+/, ''));
  } catch {
    throw new Error(t('modrinth.errBadPack'));
  }
  if (!index || typeof index !== 'object' || Array.isArray(index)) throw new Error(t('modrinth.errBadPack'));
  return { zip, index };
}

function packLoader(deps) {
  if (deps['fabric-loader']) return { loader: 'fabric', loaderVersion: deps['fabric-loader'] };
  if (deps['quilt-loader']) return { loader: 'quilt', loaderVersion: deps['quilt-loader'] };
  if (deps.neoforge) return { loader: 'neoforge', loaderVersion: deps.neoforge };
  if (deps.forge) {
    const v = deps.forge.includes('-') ? deps.forge : `${deps.minecraft}-${deps.forge}`;
    return { loader: 'forge', loaderVersion: v };
  }
  return { loader: 'vanilla', loaderVersion: null };
}

// Descarga un .mrpack de Modrinth al cache y devuelve su ruta.
async function downloadPack(versionId, task) {
  const version = await getVersion(versionId);
  const file = version.files.find((f) => f.filename.endsWith('.mrpack')) || primaryFile(version);
  if (!file) throw new Error(t('modrinth.errNoFiles'));
  const dest = paths.cache('modpacks', path.basename(file.filename));
  await http.download({ url: file.url, path: dest, sha1: file.hashes?.sha1, size: file.size }, { verify: 'hash', signal: task?.signal });
  return { file: dest, version };
}

// Texto seguro para mostrar una ruta que vino dentro de un pack (sin caracteres de control).
const shownPath = (p) => String(p ?? '?').replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 120);

/**
 * Instala el contenido de un .mrpack en la carpeta de la instancia. Por seguridad:
 *  - rutas: solo relativas y seguras, nunca venus-instance.json ni .venus/ (un pack podria cambiar la ruta de
 *    Java y ejecutar un programa al jugar). Las que no cumplen se saltean y se avisa.
 *  - descargas: solo https desde los dominios del formato .mrpack y con hash (sha1/sha512) verificado.
 *  - overrides: temporal + renombrado; si el archivo ya existia y era un enlace duro del almacen, las otras
 *    instancias conservan su copia.
 * opts.warnings (opcional): arreglo donde se agregan los avisos traducidos de lo que se salteo.
 * Devuelve el indice del pack (como siempre).
 */
async function installPackContents(packFile, instanceDir, task, opts = {}) {
  const { zip, index } = await readMrpack(packFile);
  const root = path.resolve(instanceDir);
  const items = [];
  const blocked = [];
  const unsafe = [];
  for (const f of Array.isArray(index.files) ? index.files : []) {
    if (!f || typeof f !== 'object') continue;
    if (f.env && f.env.client === 'unsupported') continue;
    const dest = safety.resolveInside(root, f.path);
    if (!dest) {
      unsafe.push(shownPath(f.path));
      continue;
    }
    const urls = safety.allowedPackUrls(f.downloads);
    const { sha1, sha512 } = safety.packHashes(f.hashes);
    if (!urls.length || (!sha1 && !sha512)) {
      blocked.push(`${path.basename(dest)} (${shownPath(safety.firstHost(f.downloads))})`);
      continue;
    }
    const size = Number(f.fileSize);
    items.push({ urls, path: dest, sha1: sha1 || undefined, sha512: sha512 || undefined, size: Number.isSafeInteger(size) && size > 0 ? size : undefined });
  }
  await http.downloadAll(items, { concurrency: 8, verify: 'hash', signal: task?.signal, onProgress: task?.downloadProgress('Modpack') });

  // overrides y despues client-overrides (pisan a los anteriores); server-overrides no van en el cliente.
  const overrides = new Map();
  for (const prefix of ['overrides/', 'client-overrides/']) {
    for (const entry of zip.getEntries()) {
      const name = entry.entryName.replace(/\\/g, '/');
      if (entry.isDirectory || !name.startsWith(prefix) || name.length === prefix.length) continue;
      const dest = safety.resolveInside(root, name.slice(prefix.length));
      if (!dest) {
        unsafe.push(shownPath(name));
        continue;
      }
      overrides.set(dest, entry);
    }
  }
  for (const [dest, entry] of overrides) {
    if (task?.signal?.aborted) throw task.signal.reason || new Error(t('storage.errCancelled'));
    await safety.writeFileAtomic(dest, entry.getData());
  }

  const warnings = [];
  if (blocked.length) warnings.push(t('modrinth.warnPackBlocked', { count: blocked.length, files: blocked.slice(0, 5).join(', ') }));
  if (unsafe.length) warnings.push(t('modrinth.warnPackUnsafe', { count: unsafe.length, files: unsafe.slice(0, 5).join(', ') }));
  for (const w of warnings) console.warn('[modrinth] modpack:', w);
  if (Array.isArray(opts?.warnings)) opts.warnings.push(...warnings);
  if (warnings.length) task?.update({ detail: warnings.join(' ') });
  return index;
}

// ---------- Archivos locales ----------

async function listFolder(baseDir, folder) {
  const dir = path.join(baseDir, folder);
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() && !(folder !== 'mods' && e.isDirectory())) continue;
    if (folder === 'mods' && !/\.(jar|zip|litemod)(\.disabled)?$/i.test(e.name)) continue;
    const full = path.join(dir, e.name);
    const st = await fsp.stat(full).catch(() => null);
    out.push({
      file: e.name,
      folder,
      enabled: !e.name.endsWith('.disabled'),
      isDir: e.isDirectory(),
      size: st?.size || 0,
      mtime: st?.mtimeMs || 0,
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

// Identifica archivos locales en Modrinth por su sha1 (icono, nombre, proyecto).
async function identify(baseDir, files) {
  const hashes = {};
  for (const f of files) {
    if (f.isDir) continue;
    hashes[await hashFile(path.join(baseDir, f.folder, f.file), 'sha1')] = f;
  }
  const keys = Object.keys(hashes);
  if (!keys.length) return {};
  const versions = await api('/version_files', { method: 'POST', body: { hashes: keys, algorithm: 'sha1' } }).catch(() => ({}));
  const projectIds = [...new Set(Object.values(versions || {}).map((v) => v.project_id))];
  const projects = await getProjects(projectIds).catch(() => []);
  const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
  const result = {};
  for (const [hash, f] of Object.entries(hashes)) {
    const v = versions?.[hash];
    if (!v) continue;
    const p = byId[v.project_id];
    result[f.file] = {
      hash,
      projectId: v.project_id,
      versionId: v.id,
      versionNumber: v.version_number,
      title: p?.title,
      icon: p?.icon_url,
      slug: p?.slug,
    };
  }
  return result;
}

async function checkUpdates(hashes, loaders, gameVersion) {
  if (!hashes.length) return {};
  return api('/version_files/update', {
    method: 'POST',
    body: { hashes, algorithm: 'sha1', loaders: loaders?.length ? loaders : undefined, game_versions: gameVersion ? [gameVersion] : undefined },
  });
}

module.exports = {
  search,
  buildFacets,
  getProject,
  getProjects,
  getVersions,
  getVersion,
  getVersionsByIds,
  getMembers,
  getOrganization,
  getTeam,
  getDependencies,
  getTags,
  getTypeTags,
  resolveInstall,
  executePlan,
  folderFor,
  loadersFor,
  modLoadersFor,
  shaderLoadersFor,
  readMrpack,
  packLoader,
  downloadPack,
  installPackContents,
  listFolder,
  identify,
  checkUpdates,
  primaryFile,
  pickVersion,
  // Reglas compartidas de packs/safety (rutas seguras dentro de una instancia y dominios del formato .mrpack)
  safeRelPath: safety.safeRelPath,
  allowedPackUrls: safety.allowedPackUrls,
  api,
  rateLimit,
  clearCache,
  FOLDERS,
  PROJECT_TYPES,
  SORTS,
  ENVIRONMENTS,
  POPULAR_LICENSES,
};
