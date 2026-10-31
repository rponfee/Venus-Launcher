// Utilidades compartidas del catalogo (Modrinth y CurseForge): tipos de proyecto, loaders compatibles
// con cada instancia o servidor, etiquetas traducidas y el estado de la sesion de busqueda
// (para volver a los resultados sin recargarlos).
import { h, icon } from '../../ui.js';
import { store, api } from '../../store.js';
import { navigate } from '../../app.js';
import { t, has, locale } from '../../i18n.js';
import { FALLBACK_SERVER_TYPES, normalizeServerTypes, serverLoadersOf, acceptsPlugins, acceptsMods, isProxyType } from './servertypes.js';
import { emptyMore } from '../../features/searchfilters.js';

// Resultados por pagina que se pueden elegir (la API de Modrinth admite hasta 100; la de CurseForge, hasta 50).
// La eleccion de cada fuente se recuerda en los ajustes (settings.modrinth.pageSize).
export const PAGE_SIZES = { modrinth: [10, 20, 50, 100], curseforge: [10, 20, 50] };
export const DEFAULT_PAGE_SIZE = 20;
export const MODRINTH_URL = 'https://modrinth.com';
export const IRIS_ID = 'YL57xq9U';
export const CANVAS_ID = 'VOYxIjFI';

export const TYPES = [
  { id: 'mod', icon: 'puzzle' },
  { id: 'modpack', icon: 'package' },
  { id: 'shader', icon: 'sun' },
  { id: 'resourcepack', icon: 'palette' },
  { id: 'datapack', icon: 'database' },
  { id: 'plugin', icon: 'server' },
];
export const TYPE_IDS = TYPES.map((x) => x.id);
export const CF_TYPES = ['mod', 'modpack', 'shader', 'resourcepack', 'datapack'];
// Tipos con vista previa visual (se pueden comparar lado a lado)
export const VISUAL_TYPES = new Set(['shader', 'resourcepack']);
// Loaders de mods que Venus Launcher sabe instalar en una instancia nueva
export const INSTALLABLE_LOADERS = ['fabric', 'neoforge', 'forge', 'quilt'];

export const typeIcon = (type) => TYPES.find((x) => x.id === type)?.icon || 'box';
export const typeLabel = (type) => t(`modrinth.type_${type}`);
export const typeLabelOne = (type) => t(`modrinth.typeOne_${type}`);

// Estado de la sesion (vive mientras la app esta abierta). Los filtros de "Mas filtros" (frase, palabras excluidas,
// autor, descargas, dias, codigo abierto y entorno: emptyMore) se recuerdan por fuente igual que los demas.
export const session = {
  source: 'modrinth',
  mr: { type: 'mod', query: '', sort: 'relevance', categories: [], loaders: [], gameVersion: '', snapshots: false, license: '', target: null, ...emptyMore() },
  cf: { type: 'mod', query: '', sort: 'popularity', categoryId: null, loader: '', gameVersion: '', target: null, ...emptyMore() },
  filtersOpen: false,
  moreOpen: false,
  pageSize: { modrinth: null, curseforge: null },
  results: null,
  compare: new Map(),
  lastRoute: 'modrinth',
  typeCounts: null,
  typeCountsAt: 0,
};

// Resultados por pagina de una fuente: lo elegido en esta sesion, o lo guardado en los ajustes, o el valor por defecto.
export function pageSizeOf(source) {
  const list = PAGE_SIZES[source] || PAGE_SIZES.modrinth;
  const n = Number(session.pageSize[source] ?? store.settings?.modrinth?.pageSize?.[source]);
  if (list.includes(n)) return n;
  // un valor que esta fuente no admite (por ejemplo 100 en CurseForge) baja al mayor permitido
  const fit = Number.isFinite(n) && n > 0 ? [...list].reverse().find((x) => x <= n) : null;
  return fit || DEFAULT_PAGE_SIZE;
}

export function setPageSize(source, n) {
  const list = PAGE_SIZES[source];
  if (!list || !list.includes(n)) return;
  session.pageSize[source] = n;
  store.setSettings({ modrinth: { pageSize: { [source]: n } } }).catch((err) => console.warn('[modrinth] no se pudo guardar la cantidad de resultados', err));
}

// ---------- Formatos ----------

let nf = null;
export function fmtInt(n) {
  const loc = locale();
  if (!nf || nf.loc !== loc) nf = { loc, fmt: new Intl.NumberFormat(loc) };
  return nf.fmt.format(Number(n) || 0);
}

export const prettify = (s) => String(s || '').replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function categoryLabel(name) {
  const key = `modrinth.cat_${name}`;
  return has(key) ? t(key) : prettify(name);
}

export function headerLabel(header) {
  const key = `modrinth.hdr_${String(header).replace(/\s+/g, '_')}`;
  return has(key) ? t(key) : prettify(header);
}

const LOADER_NAMES = {
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
  liteloader: 'LiteLoader',
  modloader: 'ModLoader',
  rift: 'Rift',
  babric: 'Babric',
  'bta-babric': 'BTA (Babric)',
  'legacy-fabric': 'Legacy Fabric',
  nilloader: 'NilLoader',
  ornithe: 'Ornithe',
  'java-agent': 'Java Agent',
  bukkit: 'Bukkit',
  bungeecord: 'BungeeCord',
  folia: 'Folia',
  paper: 'Paper',
  purpur: 'Purpur',
  spigot: 'Spigot',
  sponge: 'Sponge',
  velocity: 'Velocity',
  waterfall: 'Waterfall',
  geyser: 'Geyser',
  canvas: 'Canvas',
  iris: 'Iris',
  optifine: 'OptiFine',
  minecraft: 'Minecraft',
  cauldron: 'Cauldron',
};
const LOADER_COLORS = {
  fabric: '#dbb98d',
  forge: '#6f8cff',
  neoforge: '#ff8a3d',
  quilt: '#b884f0',
  'legacy-fabric': '#c9a46a',
  iris: '#8f7bff',
  optifine: '#e45555',
  canvas: '#59c2ff',
  vanilla: '#5fae4d',
  minecraft: '#5fae4d',
  datapack: '#5fae4d',
  paper: '#e9e3e3',
  purpur: '#b884f0',
  spigot: '#f2a33a',
  bukkit: '#e8794d',
  folia: '#7bd88f',
  velocity: '#3fb6e8',
  bungeecord: '#d8b04b',
  waterfall: '#5aa7f0',
  sponge: '#f7cf0d',
};

const LOADER_TAGS = new Set([...Object.keys(LOADER_NAMES), 'vanilla', 'datapack']);
// true si la etiqueta de Modrinth es un loader (las categorias de busqueda mezclan ambos)
export const isLoaderTag = (name) => LOADER_TAGS.has(name);

export function loaderName(l) {
  if (l === 'vanilla') return t('modrinth.loaderVanillaShader');
  if (l === 'datapack') return t('modrinth.loaderDatapack');
  return LOADER_NAMES[l] || prettify(l);
}

export function loaderChip(l, extraClass) {
  return h('span', { class: ['badge loader-badge', extraClass], style: { '--c': LOADER_COLORS[l] || 'var(--muted)' } }, h('span', { class: 'ld' }), loaderName(l));
}

// Entorno (cliente / servidor) a partir del proyecto o resultado de busqueda
const ENV_KEYS = {
  client_and_server: 'envBoth',
  client_only: 'envClient',
  client_only_server_optional: 'envClientOptServer',
  singleplayer_only: 'envSingleplayer',
  server_only: 'envServer',
  server_only_client_optional: 'envServerOptClient',
  dedicated_server_only: 'envDedicated',
  client_or_server: 'envEither',
  client_or_server_prefers_both: 'envEitherBoth',
};
export function envLabel(p) {
  const env = Array.isArray(p?.environment) ? p.environment.find((e) => ENV_KEYS[e]) : null;
  if (env) return t(`modrinth.${ENV_KEYS[env]}`);
  const c = p?.client_side;
  const s = p?.server_side;
  if (!c && !s) return null;
  const cOk = c === 'required' || c === 'optional';
  const sOk = s === 'required' || s === 'optional';
  if (c === 'required' && s === 'required') return t('modrinth.envBoth');
  if (cOk && !sOk) return t('modrinth.envClient');
  if (sOk && !cOk) return t('modrinth.envServer');
  if (cOk && sOk) return t('modrinth.envEither');
  return null;
}

// Rango de versiones de Minecraft legible ("1.16.5 – 1.21.4" o "1.20.1, 1.20.4")
export const isReleaseVersion = (v) => /^\d+\.\d+(\.\d+)?$/.test(String(v || ''));
export function versionSummary(gameVersions, max = 3) {
  const all = (gameVersions || []).filter(Boolean);
  const releases = all.filter(isReleaseVersion);
  const list = releases.length ? releases : all;
  if (!list.length) return '';
  if (list.length <= max) return list.join(', ');
  return t('modrinth.versionRange', { from: list[0], to: list[list.length - 1] });
}

// Nombre legible de la licencia de un proyecto (las "LicenseRef-..." de Modrinth no tienen nombre)
export function licenseLabel(lic) {
  const id = typeof lic === 'string' ? lic : lic?.id;
  if (id === 'LicenseRef-All-Rights-Reserved') return t('modrinth.licenseArr');
  if (id === 'LicenseRef-Custom') return t('modrinth.licenseCustom');
  return (typeof lic === 'object' && lic?.name) || id || '';
}

export function projectUrl(p) {
  const type = p?.project_type || 'project';
  return `${MODRINTH_URL}/${type}/${p?.slug || p?.id || p?.project_id}`;
}

export function colorOf(p) {
  const c = Number(p?.color);
  return Number.isFinite(c) && c > 0 ? `#${c.toString(16).padStart(6, '0')}` : null;
}

export function projectIcon(url, cls = 'mx-icon', label = '') {
  if (url && /^https:\/\//i.test(url)) {
    const img = h('img', { class: cls, src: url, alt: label, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(h('div', { class: [cls, 'mx-icon-ph'], 'aria-hidden': 'true' }, icon('box'))), { once: true });
    return img;
  }
  return h('div', { class: [cls, 'mx-icon-ph'], 'aria-hidden': 'true' }, icon('box'));
}

export function stat(iconName, text, title, cls) {
  return h('span', { class: ['mx-stat', cls], title: title || null }, icon(iconName), text);
}

// Enlace a una pagina externa (se abre en el navegador). Con href para que se pueda enfocar con Tab.
export function extLink(url, label, cls) {
  return h(
    'a',
    {
      class: cls || null,
      href: url,
      title: url,
      onclick: (e) => {
        e.preventDefault();
        window.venus.app.openExternal(url).catch(() => {});
      },
    },
    label,
  );
}

// Enlace a otra ruta del launcher (#/ruta), enfocable con Tab.
export function routeLink(route, label, cls, before) {
  return h(
    'a',
    {
      class: cls || null,
      href: `#/${route}`,
      onclick: (e) => {
        e.preventDefault();
        before?.();
        navigate(route);
      },
    },
    label,
  );
}

// Redibuja un contenedor sin perder el foco del teclado: si el foco estaba en un control con data-fk,
// despues de render() vuelve al control nuevo con la misma clave.
export function keepFocus(container, render) {
  const a = document.activeElement;
  const fk = a && a !== document.body && container.contains(a) ? a.dataset?.fk : null;
  const out = render();
  if (fk) {
    const el = [...container.querySelectorAll('[data-fk]')].find((x) => x.dataset.fk === fk);
    if (el && !el.disabled && el.isConnected) el.focus({ preventScroll: true });
  }
  return out;
}

// Flechas, Inicio y Fin para moverse entre las pestañas de un role="tablist" (patron de pestañas).
export function tabKeys(e) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const list = e.currentTarget;
  const tabs = [...list.querySelectorAll('[role="tab"]:not(:disabled)')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0 || !tabs.length) return;
  e.preventDefault();
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  const fk = tabs[n].dataset.fk;
  tabs[n].click();
  // el clic pudo redibujar la lista (o reemplazarla entera): se enfoca la pestaña nueva con la misma clave
  const liveList = list.isConnected ? list : document.activeElement?.closest?.('[role="tablist"]');
  const live = liveList ? [...liveList.querySelectorAll('[role="tab"]:not(:disabled)')] : [];
  const target = (fk && live.find((x) => x.dataset.fk === fk)) || live[n] || tabs[n];
  if (target.isConnected) target.focus({ preventScroll: true });
}

// ---------- Compatibilidad con instancias y servidores ----------

export function modLoadersFor(inst) {
  switch (inst?.loader) {
    case 'fabric':
      return ['fabric'];
    case 'legacyfabric':
      return ['legacy-fabric', 'fabric'];
    case 'quilt':
      return ['quilt', 'fabric'];
    case 'forge':
      return ['forge'];
    case 'neoforge':
      return inst.mcVersion === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge'];
    default:
      return [];
  }
}

function hasProject(inst, id, re) {
  const projects = inst?.modrinth?.projects || {};
  return Boolean(projects[id]) || Object.values(projects).some((p) => re && re.test(p?.title || ''));
}

// Loaders de shaders reales de la instancia (sin contar los core shaders "vanilla")
export function shaderLoadersFor(inst) {
  if (!inst) return [];
  const out = [];
  if (inst.loader === 'optifine') out.push('optifine');
  if (inst.preset === 'iris' || hasProject(inst, IRIS_ID, /^(iris|oculus)\b/i)) out.push('iris');
  if (hasProject(inst, CANVAS_ID)) out.push('canvas');
  return out;
}

// Tipos de servidor (servers:types): que servidores reciben plugins o mods y con que loaders de Modrinth.
// Se cargan una vez (loadServerTypes) antes de dibujar destinos; mientras tanto valen los de respaldo.
let serverTypes = null;
let serverTypesPromise = null;

export function loadServerTypes() {
  if (serverTypes) return Promise.resolve(serverTypes);
  if (!serverTypesPromise) {
    serverTypesPromise = api
      .invoke('servers:types')
      .then((list) => {
        serverTypes = normalizeServerTypes(list) || FALLBACK_SERVER_TYPES;
        return serverTypes;
      })
      .catch((err) => {
        serverTypesPromise = null;
        if (/No handler registered/i.test(err?.message || '')) serverTypes = FALLBACK_SERVER_TYPES;
        else console.warn('[modrinth] servers:types', err);
        return FALLBACK_SERVER_TYPES;
      });
  }
  return serverTypesPromise;
}

// projectType: 'mod' | 'plugin' (sin tipo: todos los loaders del servidor)
export function serverLoadersFor(srv, projectType) {
  return serverLoadersOf(serverTypes, srv, projectType);
}

export const isPluginServer = (srv) => acceptsPlugins(serverTypes, srv);
export const isModServer = (srv) => acceptsMods(serverTypes, srv);
// Proxies (Velocity, Waterfall): su "version" es la del proxy, no la de Minecraft
export const isProxyServer = (srv) => isProxyType(serverTypes, srv);

// Loaders aceptados para instalar un tipo en un destino. null = cualquiera.
export function acceptedLoaders(type, target, kind = 'instance') {
  if (kind === 'server') return serverLoadersFor(target, type);
  if (type === 'mod') return modLoadersFor(target);
  if (type === 'shader') return [...shaderLoadersFor(target), 'vanilla'];
  if (type === 'datapack') return ['datapack'];
  return null;
}

// Facets de busqueda para "compatible con mi instancia/servidor"
export function targetFacets(type, target, kind = 'instance') {
  if (!target || type === 'modpack') return null;
  const out = { gameVersions: [target.mcVersion] };
  if (kind === 'server') {
    if (isProxyServer(target)) delete out.gameVersions;
    out.loaders = serverLoadersFor(target, type);
    if (type === 'mod') out.environment = 'server';
  } else if (type === 'mod') out.loaders = modLoadersFor(target);
  else if (type === 'shader') out.loaders = [...shaderLoadersFor(target), 'vanilla'];
  else if (type === 'datapack') out.loaders = ['datapack'];
  return out;
}

// Problema del destino para este tipo (null si puede usarlo)
export function targetProblem(type, target, kind = 'instance') {
  if (!target) return null;
  if (kind === 'server') {
    if (type === 'plugin' && !isPluginServer(target)) return 'serverNoPlugins';
    if (type === 'mod' && !isModServer(target)) return 'serverNoMods';
    if (!['mod', 'plugin'].includes(type)) return 'serverType';
    return null;
  }
  if (type === 'plugin') return 'instanceNoPlugins';
  if (type === 'mod' && !modLoadersFor(target).length) return 'instanceNoLoader';
  if (type === 'shader' && !shaderLoadersFor(target).length) return 'instanceNoShaders';
  return null;
}

// ---------- Versiones ----------

const CHANNEL_ORDER = { release: 0, beta: 1, alpha: 2 };
export function sortVersions(list) {
  return [...(list || [])].sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
}

export function versionMatches(v, { gameVersion, loaders } = {}) {
  if (gameVersion && !(v.game_versions || []).includes(gameVersion)) return false;
  if (loaders && loaders.length && !(v.loaders || []).some((l) => loaders.includes(l))) return false;
  return true;
}

// Mejor version compatible: la mas nueva del canal mas estable
export function bestVersion(versions, filter = {}) {
  const ok = sortVersions(versions).filter((v) => versionMatches(v, filter));
  return ok.find((v) => v.version_type === 'release') || ok.find((v) => v.version_type === 'beta') || ok[0] || null;
}

export function channelPill(type) {
  const kind = type === 'alpha' ? 'bad' : type === 'beta' ? 'warn' : 'good';
  return h('span', { class: `pill ${kind} mx-channel` }, t(`modrinth.channel_${CHANNEL_ORDER[type] !== undefined ? type : 'release'}`));
}

// ---------- Instalado en... ----------

export function installedIn(projectId) {
  return store.instances.filter((i) => i.modrinth?.projects?.[projectId]).map((i) => ({ kind: 'instance', id: i.id, name: i.name, version: i.modrinth.projects[projectId].versionNumber }));
}

export function installedInServers(projectId) {
  return (store.servers || []).filter((s) => s.modrinth?.projects?.[projectId]).map((s) => ({ kind: 'server', id: s.id, name: s.name, version: s.modrinth.projects[projectId].versionNumber }));
}

export function cfInstalledIn(modId) {
  return store.instances.filter((i) => i.curseforge?.projects?.[modId]).map((i) => ({ kind: 'instance', id: i.id, name: i.name, version: i.curseforge.projects[modId].versionNumber }));
}

// Boton/link externo con icono
export function externalButton(url, label, iconName = 'external', cls = 'btn sm ghost') {
  return h('button', { class: cls, type: 'button', title: url, onclick: () => window.venus.app.openExternal(url).catch(() => {}) }, icon(iconName), label);
}
