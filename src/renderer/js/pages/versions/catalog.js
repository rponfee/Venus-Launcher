// Catalogo de versiones e instancias: clasificacion de versiones de Minecraft (release, snapshot, pre-release,
// release candidate, experimental, bromas del 1 de abril, beta, alpha, infdev, indev, classic, pre-classic),
// filtros, conteos, orden por fecha y orden/agrupado de instancias.
// Funciones puras, sin DOM ni imports, para poder usarlas en la interfaz y probarlas con Node.

export const NEW_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

// Versiones de broma del 1 de abril que estan en el manifest de Mojang (las nuevas se detectan por fecha).
const APRIL_FOOLS = new Set([
  '15w14a',
  '1.RV-Pre1',
  '3D Shareware v1.34',
  '20w14infinite',
  '22w13oneblockatatime',
  '23w13a_or_b',
  '24w14potato',
  '25w14craftmine',
  '26w14a',
]);
// Nombres de snapshots "normales" (no cuentan como broma aunque salgan un 1 de abril).
const REGULAR_SNAPSHOT = /(-(snapshot|pre|rc)-?\d+|-pre\d+|-rc\d+| pre-release \d+)$/i;

export const GROUPS = ['all', 'release', 'snapshot', 'aprilfools', 'beta', 'alpha'];
export const LOADER_ORDER = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'optifine', 'iris', 'legacyfabric', 'babric'];
export const INSTANCE_SORTS = ['recent', 'name', 'version', 'playtime'];

export function isAprilFools(v) {
  if (!v || v.type !== 'snapshot') return false;
  if (APRIL_FOOLS.has(v.id)) return true;
  return String(v.releaseTime || '').slice(5, 10) === '04-01' && !REGULAR_SNAPSHOT.test(v.id);
}

// Tipo detallado para la insignia de cada version.
export function versionKind(v) {
  const id = String(v?.id || '');
  switch (v?.type) {
    case 'release':
      return 'release';
    case 'old_beta':
      return 'beta';
    case 'old_alpha':
      if (/^rd-/i.test(id)) return 'preclassic';
      if (/^c0\./i.test(id)) return 'classic';
      if (/^inf-/i.test(id)) return 'infdev';
      if (/^in-/i.test(id)) return 'indev';
      return 'alpha';
    default:
      if (isAprilFools(v)) return 'aprilfools';
      if (/experimental/i.test(id)) return 'experimental';
      if (/(-rc-?\d+|-rc\d+)$/i.test(id)) return 'rc';
      if (/(-pre-?\d+|-pre\d+| pre-release \d+)$/i.test(id) || /-pre$/i.test(id)) return 'pre';
      return 'snapshot';
  }
}

// Grupo para los filtros (chips).
export function versionGroup(v) {
  switch (v?.type) {
    case 'release':
      return 'release';
    case 'old_beta':
      return 'beta';
    case 'old_alpha':
      return 'alpha';
    default:
      return isAprilFools(v) ? 'aprilfools' : 'snapshot';
  }
}

export function releaseMs(v) {
  const t = Date.parse(v?.releaseTime || '');
  return Number.isFinite(t) ? t : 0;
}

export function isNewVersion(v, now = Date.now(), days = NEW_DAYS) {
  const t = releaseMs(v);
  return t > 0 && t <= now + DAY && now - t < days * DAY;
}

// Catalogo para la interfaz: todas las versiones del manifest, anotadas y ordenadas por fecha (la mas nueva primero).
export function buildCatalog(manifest, { now = Date.now() } = {}) {
  const latest = manifest?.latest || {};
  const seen = new Set();
  const out = [];
  for (const v of manifest?.versions || []) {
    if (!v || typeof v.id !== 'string' || seen.has(v.id)) continue;
    seen.add(v.id);
    out.push({
      id: v.id,
      type: v.type,
      releaseTime: v.releaseTime || null,
      time: releaseMs(v),
      kind: versionKind(v),
      group: versionGroup(v),
      isNew: isNewVersion(v, now),
      latest: v.id === latest.release ? 'release' : v.id === latest.snapshot ? 'snapshot' : null,
    });
  }
  return out.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id, 'en', { numeric: true }));
}

// Cruza las versiones de juego que soporta un loader con el catalogo (descarta las que Mojang no publica).
export function catalogForLoader(catalog, gameVersions) {
  const byId = new Map();
  for (const g of gameVersions || []) {
    const id = typeof g === 'string' ? g : g?.id;
    if (id && !byId.has(id)) byId.set(id, typeof g === 'string' ? { id } : g);
  }
  return catalog.filter((v) => byId.has(v.id)).map((v) => ({ ...v, loaderStable: byId.get(v.id).stable !== false }));
}

function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Todas las palabras de la busqueda tienen que aparecer (en el id o en el texto extra, ej. "snapshot", "abril").
export function matchesQuery(text, query) {
  const q = normalize(query);
  if (!q) return true;
  const hay = normalize(text);
  return q.split(/\s+/).every((word) => hay.includes(word));
}

export function filterVersions(list, { group = 'all', query = '', searchText } = {}) {
  return list.filter((v) => (group === 'all' || v.group === group) && matchesQuery(searchText ? searchText(v) : v.id, query));
}

// Cantidad por grupo (respetando la busqueda) para mostrar en los chips.
export function countGroups(list, { query = '', searchText } = {}) {
  const counts = Object.fromEntries(GROUPS.map((g) => [g, 0]));
  for (const v of list) {
    if (!matchesQuery(searchText ? searchText(v) : v.id, query)) continue;
    counts.all++;
    if (v.group in counts) counts[v.group]++;
  }
  return counts;
}

// Versiones de un loader: solo estables salvo que se pidan todas (o no haya ninguna estable).
export function visibleLoaderVersions(list, showAll = false) {
  if (showAll) return list;
  const stable = list.filter((l) => l.stable !== false);
  return stable.length ? stable : list;
}

export function pickLoaderVersion(list) {
  return (list.find((l) => l.recommended) || list.find((l) => l.stable !== false) || list[0] || null)?.version || null;
}

// ---------- Instancias ----------

export function instanceLoaderKind(inst) {
  return inst?.preset === 'iris' ? 'iris' : inst?.loader || 'vanilla';
}

export function matchesInstance(inst, query) {
  return matchesQuery(`${inst.name} ${inst.mcVersion} ${instanceLoaderKind(inst)} ${inst.loader} ${inst.group || ''}`, query);
}

// Compara ids de version: mas nueva primero segun la fecha del manifest y, si no se conoce, orden natural.
export function compareVersionIds(a, b, timeMap) {
  const ta = timeMap?.get(a) || 0;
  const tb = timeMap?.get(b) || 0;
  if (ta && tb && ta !== tb) return tb - ta;
  if (ta && !tb) return -1;
  if (tb && !ta) return 1;
  return String(b).localeCompare(String(a), 'en', { numeric: true });
}

export function sortInstances(list, sort = 'recent', { timeMap, locale } = {}) {
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), locale, { sensitivity: 'base', numeric: true });
  const arr = [...list];
  switch (sort) {
    case 'name':
      return arr.sort(byName);
    case 'version':
      return arr.sort((a, b) => compareVersionIds(a.mcVersion, b.mcVersion, timeMap) || byName(a, b));
    case 'playtime':
      return arr.sort((a, b) => (b.playtime || 0) - (a.playtime || 0) || (b.lastPlayed || 0) - (a.lastPlayed || 0) || byName(a, b));
    default:
      return arr.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || (b.created || 0) - (a.created || 0) || byName(a, b));
  }
}

// Agrupa por loader en el orden habitual (los desconocidos al final), conservando el orden de cada grupo.
export function groupByLoader(list) {
  const map = new Map();
  for (const inst of list) {
    const k = instanceLoaderKind(inst);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(inst);
  }
  const keys = [...LOADER_ORDER.filter((k) => map.has(k)), ...[...map.keys()].filter((k) => !LOADER_ORDER.includes(k)).sort()];
  return keys.map((loader) => ({ loader, items: map.get(loader) }));
}
