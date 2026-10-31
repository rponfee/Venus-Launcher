// Bienvenida obligatoria (primer inicio): asistente a pantalla completa que deja el launcher listo para jugar.
// Pasos: idioma -> apariencia -> cuenta de Minecraft -> cuenta de Venus (opcional) -> primera instancia -> contenido extra (opcional)
// -> rendimiento -> preferencias -> resumen. Al terminar guarda los ajustes, crea la instancia (se instala en segundo
// plano), pide los paquetes de contenido y la optimización al módulo de rendimiento y llama a finishOnboarding().
// El estado vive a nivel de módulo: sobrevive al redibujado que hace app.js cuando cambia el idioma.
import { h, icon, mount, toast, confirmDialog, emptyState, skeleton, fmtBytes, fmtMb, fmtDate, avatarImg, registerIcons, switchEl, instanceIcon, instanceLoaderKey, LOADERS } from '../ui.js';
import { store, api } from '../store.js';
import { finishOnboarding } from '../app.js';
import { t, LANGUAGES, setLanguage, systemLanguage, getLanguage } from '../i18n.js';
import { cloud } from '../cloud.js';
import { appearancePicker, appearanceSettings, flushAppearance } from '../appearance.js';
import { getWallpaper } from '../wallpapers.js';
import { discordButton } from '../community.js';

registerIcons({
  wlWifiOff:
    '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
  wlMinimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  wlWindow: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
  wlUserCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>',
  wlCheckCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  wlXCircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
});

// ---------------- Constantes ----------------

const STEPS = [
  { id: 'language', icon: 'languages' },
  { id: 'appearance', icon: 'palette' },
  { id: 'account', icon: 'user' },
  { id: 'venus', icon: 'cloud' },
  { id: 'instance', icon: 'layers' },
  { id: 'content', icon: 'package' },
  { id: 'performance', icon: 'memory' },
  { id: 'prefs', icon: 'sliders' },
  { id: 'summary', icon: 'rocket' },
];
const STEP_INDEX = Object.fromEntries(STEPS.map((s, i) => [s.id, i]));

const OFFLINE_NAME = /^[A-Za-z0-9_]{3,16}$/;
const VENUS_USER = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 6;

// Combinaciones recomendadas para la primera instancia (la versión se calcula según lo que soporta cada loader).
const COMBOS = [
  { id: 'vanilla', icon: 'box', kind: 'vanilla' },
  { id: 'perf', icon: 'zap', kind: 'fabric', recommended: true },
  { id: 'shaders', icon: 'sun', kind: 'iris' },
  { id: 'mods', icon: 'puzzle', kind: 'neoforge' },
  { id: 'custom', icon: 'sliders', kind: null },
];
const KINDS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'iris', 'optifine', 'legacyfabric'];

// Loaders de Modrinth válidos para mods según el loader de la instancia (vanilla y OptiFine no cargan mods).
const MOD_LOADERS = { fabric: ['fabric'], quilt: ['quilt', 'fabric'], legacyfabric: ['fabric'], forge: ['forge'], neoforge: ['neoforge'] };

// Lista incluida por si el catálogo del módulo de rendimiento no está disponible (ids de Modrinth).
const EXTRAS = [
  { slug: 'sodium', id: 'AANobbMI', key: 'sodium', title: 'Sodium', glyph: 'zap', perf: true },
  { slug: 'lithium', id: 'gvQqBUqZ', key: 'lithium', title: 'Lithium', glyph: 'cpu', perf: true },
  { slug: 'ferrite-core', id: 'uXXizFIs', key: 'ferritecore', title: 'FerriteCore', glyph: 'memory', perf: true },
  { slug: 'iris', id: 'YL57xq9U', key: 'iris', title: 'Iris Shaders', glyph: 'sun' },
  { slug: 'xaeros-minimap', id: '1bokaNcj', key: 'xaero', title: "Xaero's Minimap", glyph: 'map' },
  { slug: 'modmenu', id: 'mOgUt4GM', key: 'modmenu', title: 'Mod Menu', glyph: 'list' },
  { slug: 'jei', id: 'u6dRKJwZ', key: 'jei', title: 'Just Enough Items', glyph: 'search' },
  { slug: 'simple-voice-chat', id: '9eGKb6K1', key: 'voicechat', title: 'Simple Voice Chat', glyph: 'mic' },
  { slug: 'controlify', id: 'DOUdJVEm', key: 'controlify', title: 'Controlify', glyph: 'gamepad' },
];
const SODIUM_IDS = new Set(['AANobbMI', 'sodium']);

const VENUS_FEATURES = [
  ['users', 'venusFeatFriends'],
  ['message', 'venusFeatChat'],
  ['mic', 'venusFeatVoice'],
  ['share', 'venusFeatPacks'],
  ['cloudUpload', 'venusFeatSaves'],
];

// ---------------- Estado del asistente ----------------

let S = null; // estado (se reinicia al terminar)
let view = null; // vista activa
let pendingFocus = null; // data-fk a enfocar en el próximo dibujado
let venusPass = ''; // contraseña de Venus: solo en memoria mientras se completa el formulario

function freshState() {
  const s = store.settings || {};
  const insts = store.instances || [];
  return {
    step: 0,
    visited: 0,
    dir: 0,
    language: s.language || getLanguage() || systemLanguage(store.info?.locale),
    langBusy: false,
    // Cuenta de Minecraft
    accMode: null,
    accBusy: false,
    accMsg: null,
    offlineName: '',
    // Cuenta de Venus
    venusTab: 'signin',
    venusEmail: '',
    venusUser: '',
    venusCode: '',
    venusBusy: false,
    venusMsg: null,
    resendAt: 0,
    fieldErr: null, // { fk, text }: error de un campo, se muestra debajo de el
    // Instancia
    instMode: insts.length ? 'existing' : 'new',
    existingId: (store.selectedInstance() || insts[0])?.id || null,
    combo: 'perf',
    comboLv: {},
    custom: { kind: 'vanilla', mc: null, snapshots: false, old: false, query: '', loaderVersion: null },
    instName: '',
    nameTouched: false,
    instSkip: false,
    // Contenido extra
    packIds: new Set(),
    extraSlugs: new Set(),
    contentKey: null,
    // Rendimiento
    memoryMode: s.memoryMode === 'manual' ? 'manual' : 'auto',
    manualMax: Number(s.memory?.max) || 4096,
    lowEnd: null,
    // Preferencias
    afterLaunch: ['keep', 'minimize', 'hide'].includes(s.afterLaunch) ? s.afterLaunch : 'minimize',
    discord: s.discord?.enabled ?? true,
    // Final
    finishing: false,
    finishMsg: null,
    createdId: null,
  };
}

// ---------------- Datos remotos (se piden una vez y se comparten entre redibujados) ----------------

const data = { manifest: null, sys: null, sodium: null, support: {}, loaders: {}, content: {}, perf: {} };

function resetData() {
  Object.assign(data, { manifest: null, sys: null, sodium: null, support: {}, loaders: {}, content: {}, perf: {} });
}

// Pasos que se redibujan cuando llega cada tipo de dato.
const TOPIC_STEPS = {
  versions: ['instance', 'content', 'performance', 'summary'],
  content: ['content', 'summary'],
  perf: ['performance', 'summary'],
  sys: ['performance', 'summary'],
};

function notify(topic) {
  if (!view || !S) return;
  if (TOPIC_STEPS[topic]?.includes(STEPS[S.step].id)) view.refreshSoon();
  else view.chromeSoon();
}

// Guarda en holder[key] { status: 'loading'|'ready'|'error', value, error } y avisa cuando termina.
// Un error queda guardado hasta que se pida reintentar (retry = true): nunca se reintenta solo.
function fetchInto(holder, key, topic, fn, retry = false) {
  const cur = holder[key];
  if (cur && (cur.status !== 'error' || !retry)) return cur;
  const entry = { status: 'loading', value: null, error: null };
  holder[key] = entry;
  Promise.resolve()
    .then(fn)
    .then(
      (value) => {
        entry.status = 'ready';
        entry.value = value;
      },
      (error) => {
        entry.status = 'error';
        entry.error = error;
      },
    )
    .finally(() => notify(topic));
  return entry;
}

const isMissing = (err) => /No handler registered/i.test(String(err?.message || err));

const ensureManifest = (retry) => fetchInto(data, 'manifest', 'versions', () => api.versions.manifest(false), retry);
const ensureSys = (retry) => fetchInto(data, 'sys', 'sys', () => api.system.info(), retry);
const ensureSodium = (retry) => fetchInto(data, 'sodium', 'versions', async () => new Set((await api.modrinth.project('sodium'))?.game_versions || []), retry);

function ensureSupport(kind, retry) {
  return fetchInto(
    data.support,
    kind,
    'versions',
    async () => {
      const list = await api.loaders.gameVersions(kind);
      return new Set((Array.isArray(list) ? list : []).map((v) => v.id));
    },
    retry,
  );
}

function ensureLoaderVersions(kind, mc, retry) {
  return fetchInto(
    data.loaders,
    `${kind}|${mc}`,
    'versions',
    async () => {
      const list = await api.loaders.versions(kind, mc);
      return Array.isArray(list) ? list : [];
    },
    retry,
  );
}

// Lo necesario para las combinaciones recomendadas: se pide apenas abre la bienvenida.
function prefetch(retry) {
  ensureManifest(retry);
  ensureSys(retry);
  ensureSupport('fabric', retry);
  ensureSodium(retry);
  ensureSupport('iris', retry);
  ensureSupport('neoforge', retry);
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// ---------------- Instancia: combinaciones, versiones y loaders ----------------

const kindLoader = (kind) => (kind === 'iris' ? 'fabric' : kind);
const loaderName = (kind) => LOADERS[kind]?.name || kind;

let releaseCache = { src: null, list: [] };
function releases() {
  const m = data.manifest?.value;
  if (!m) return [];
  if (releaseCache.src !== m) releaseCache = { src: m, list: (m.versions || []).filter((v) => v.type === 'release').map((v) => v.id) };
  return releaseCache.list;
}

function latestRelease() {
  const m = data.manifest?.value;
  return m?.latest?.release || releases()[0] || null;
}

// Versión más nueva que soporta un loader (y opcionalmente otro requisito, como Sodium).
function newestFor(kind, rel, extra) {
  const sup = data.support[kind];
  if (!sup || sup.status === 'loading' || extra?.status === 'loading') return { status: 'loading', kind };
  if (sup.status === 'error') return { status: 'error', kind };
  const ok = (id) => sup.value.has(id) && (!extra || extra.status !== 'ready' || extra.value.has(id));
  const mc = rel.find(ok);
  return mc ? { status: 'ready', kind, mc } : { status: 'none', kind };
}

// { status: 'loading'|'ready'|'none'|'error', kind, mc } de cada combinación recomendada.
function comboTarget(id) {
  const m = data.manifest;
  const combo = COMBOS.find((c) => c.id === id);
  if (!m || m.status === 'loading') return { status: 'loading', kind: combo?.kind };
  if (m.status === 'error') return { status: 'error', kind: combo?.kind };
  const rel = releases();
  switch (id) {
    case 'vanilla':
      return { status: 'ready', kind: 'vanilla', mc: latestRelease() };
    case 'perf':
      return newestFor('fabric', rel, data.sodium);
    case 'shaders':
      return newestFor('iris', rel, data.support.fabric);
    case 'mods': {
      const neo = newestFor('neoforge', rel);
      if (neo.status === 'ready' || neo.status === 'loading') return neo;
      ensureSupport('forge');
      const forge = newestFor('forge', rel);
      return forge.status === 'ready' || forge.status === 'loading' ? forge : neo;
    }
    default:
      return { status: 'none' };
  }
}

// Loader recomendado: el marcado como recomendado o, si no, el estable más nuevo.
function pickLoader(list) {
  return (list.find((l) => l.recommended) || list.find((l) => l.stable !== false) || list[0])?.version || null;
}

// Versiones visibles en el modo personalizado según el loader elegido y los filtros.
function customVersions() {
  const m = data.manifest?.value;
  if (!m) return [];
  const kind = S.custom.kind;
  const sup = kind === 'vanilla' ? null : data.support[kind];
  if (sup && sup.status !== 'ready') return [];
  return m.versions.filter((v) => {
    if (v.type === 'snapshot' && !S.custom.snapshots) return false;
    if ((v.type === 'old_beta' || v.type === 'old_alpha') && !S.custom.old) return false;
    return !sup || sup.value.has(v.id);
  });
}

function customMc() {
  const list = customVersions();
  if (S.custom.mc && list.some((v) => v.id === S.custom.mc)) return S.custom.mc;
  return (list.find((v) => v.type === 'release') || list[0])?.id || null;
}

// Qué se va a crear (o qué instancia existente se va a usar).
function instanceTarget() {
  if (!S) return null;
  if (S.instMode === 'existing') {
    const inst = store.instances.find((i) => i.id === S.existingId);
    if (!inst) return null;
    return { existing: inst, kind: instanceLoaderKey(inst), mcVersion: inst.mcVersion, loader: inst.loader, preset: inst.preset || null, ready: true };
  }
  if (S.instSkip) return null;
  let kind;
  let mc;
  let chosen;
  if (S.combo === 'custom') {
    kind = S.custom.kind;
    mc = customMc();
    chosen = S.custom.loaderVersion;
  } else {
    const c = comboTarget(S.combo);
    if (c.status !== 'ready') return { kind: c.kind, status: c.status, ready: false };
    kind = c.kind;
    mc = c.mc;
    chosen = S.comboLv[`${S.combo}|${mc}`];
  }
  if (!mc) return { kind, ready: false, status: 'loading' };
  const loader = kindLoader(kind);
  const preset = kind === 'iris' ? 'iris' : null;
  if (kind === 'vanilla') return { kind, mcVersion: mc, loader, preset, loaderVersion: null, ready: true };
  const lv = ensureLoaderVersions(kind, mc);
  const list = lv.status === 'ready' ? lv.value : [];
  const loaderVersion = chosen && list.some((l) => l.version === chosen) ? chosen : pickLoader(list);
  // Las combinaciones salen de la lista de versiones del propio loader: si falla la lista de builds se usa la última estable.
  const ready = S.combo === 'custom' ? lv.status === 'ready' && list.length > 0 : lv.status === 'error' || (lv.status === 'ready' && list.length > 0);
  return { kind, mcVersion: mc, loader, preset, loaderVersion, loaderState: lv, ready };
}

function uniqueName(base) {
  const names = new Set(store.instances.map((i) => String(i.name).toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base} (${n})`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

function syncName() {
  if (!S || S.nameTouched || S.instMode !== 'new') return;
  const tg = instanceTarget();
  if (!tg?.mcVersion) return;
  const base =
    S.combo === 'custom'
      ? t('welcome.instNameCustom', { loader: loaderName(tg.kind), version: tg.mcVersion })
      : t(`welcome.instName_${S.combo}`, { loader: loaderName(tg.kind), version: tg.mcVersion });
  S.instName = uniqueName(base);
}

// ---------------- Contenido extra ----------------

const contentKey = (tg) => `${tg.mcVersion}|${tg.loader}|${tg.preset || ''}`;

function normalizePacks(list) {
  return list
    .filter((p) => p && p.id !== undefined && p.id !== null)
    .map((p) => {
      const items = (Array.isArray(p.items) ? p.items : []).map((it) => ({
        projectId: String(it.projectId || it.id || ''),
        title: String(it.title || it.name || it.projectId || ''),
        type: it.type || 'mod',
        available: it.available !== false,
      }));
      return {
        id: String(p.id),
        title: String(p.title || p.name || p.id),
        description: p.description ? String(p.description) : '',
        icon: typeof p.icon === 'string' ? p.icon : '',
        items,
        available: items.some((i) => i.available),
      };
    });
}

// Lista incluida: una búsqueda (los 100 mods más descargados para la versión y el loader) y, para los que no
// aparezcan, una consulta de versiones por proyecto. Pocos pedidos, y se reutilizan por versión + loader.
const builtinCache = new Map();
function builtinExtras(tg) {
  let loaders = MOD_LOADERS[tg.loader];
  if (!loaders) return Promise.resolve([]);
  if (tg.loader === 'neoforge' && tg.mcVersion === '1.20.1') loaders = ['neoforge', 'forge'];
  const key = `${tg.mcVersion}|${loaders.join(',')}`;
  if (!builtinCache.has(key)) {
    const run = resolveExtras(tg.mcVersion, loaders);
    builtinCache.set(key, run);
    run.catch(() => builtinCache.delete(key));
  }
  return builtinCache.get(key);
}

async function resolveExtras(mcVersion, loaders) {
  const res = await api.modrinth.search({ type: 'mod', gameVersion: mcVersion, loaders, sort: 'downloads', limit: 100 });
  const byId = new Map();
  for (const hit of Array.isArray(res?.hits) ? res.hits : []) {
    byId.set(hit.project_id, hit);
    byId.set(hit.slug, hit);
  }
  const out = new Map();
  const missing = [];
  for (const x of EXTRAS) {
    const hit = byId.get(x.id) || byId.get(x.slug);
    if (hit) out.set(x.slug, { ...x, iconUrl: /^https:\/\//.test(hit.icon_url || '') ? hit.icon_url : null, available: true });
    else missing.push(x);
  }
  await pool(missing, 3, async (x) => {
    try {
      const versions = await api.modrinth.versions(x.slug, { loaders, gameVersions: [mcVersion] });
      out.set(x.slug, { ...x, iconUrl: null, available: Array.isArray(versions) && versions.length > 0 });
    } catch {
      out.set(x.slug, { ...x, iconUrl: null, available: false });
    }
  });
  return EXTRAS.map((x) => out.get(x.slug)).filter(Boolean);
}

function ensureContent(tg, retry) {
  return fetchInto(
    data.content,
    contentKey(tg),
    'content',
    async () => {
      try {
        const packs = await api.invoke('catalog:packs', { mcVersion: tg.mcVersion, loader: tg.loader, preset: tg.preset });
        if (Array.isArray(packs)) return { source: 'catalog', packs: normalizePacks(packs) };
      } catch (err) {
        if (!isMissing(err)) console.warn('[welcome] catalog:packs', err?.message || err);
      }
      return { source: 'builtin', items: await builtinExtras(tg) };
    },
    retry,
  );
}

// La combinación "Rendimiento" siempre lleva Sodium (aunque se omita el contenido extra).
const comboAddsSodium = () => Boolean(S && S.instMode === 'new' && S.combo === 'perf');

// Ya viene con la instancia (Iris + Sodium en el preset de shaders, Sodium en "Rendimiento") o ya está instalado.
function extraIncluded(x, tg) {
  if (tg.preset === 'iris' && (x.slug === 'iris' || x.slug === 'sodium')) return true;
  if (x.slug === 'sodium' && comboAddsSodium()) return true;
  return Boolean(tg.existing?.modrinth?.projects?.[x.id]);
}

function applyPreselection(key, value, tg) {
  if (S.contentKey === key) return;
  S.contentKey = key;
  S.packIds = new Set();
  S.extraSlugs = new Set();
  if (S.instMode !== 'new' || S.combo !== 'perf') return;
  if (value.source === 'catalog') {
    const pack = value.packs.find((p) => p.available && p.items.some((i) => i.available && (SODIUM_IDS.has(i.projectId) || /sodium/i.test(i.title))));
    if (pack) S.packIds.add(pack.id);
  } else {
    for (const x of value.items) if (x.perf && x.available && !extraIncluded(x, tg)) S.extraSlugs.add(x.slug);
  }
}

// Lo que se instala al terminar.
function contentPlan() {
  const empty = { packIds: [], packItems: [], extras: [], count: 0, kind: null };
  const tg = instanceTarget();
  if (!tg?.mcVersion) return empty;
  const key = contentKey(tg);
  const entry = data.content[key];
  if (!entry || entry.status !== 'ready' || S.contentKey !== key) return empty;
  if (entry.value.source === 'catalog') {
    const packs = entry.value.packs.filter((p) => p.available && S.packIds.has(p.id));
    const seen = new Set();
    const packItems = [];
    for (const p of packs) {
      for (const it of p.items) {
        if (!it.available || !it.projectId || seen.has(it.projectId)) continue;
        seen.add(it.projectId);
        packItems.push({ projectId: it.projectId, title: it.title });
      }
    }
    return { packIds: packs.map((p) => p.id), packItems, extras: [], count: packs.length, kind: 'packs' };
  }
  const extras = entry.value.items.filter((x) => S.extraSlugs.has(x.slug) && x.available && !extraIncluded(x, tg));
  return { packIds: [], packItems: [], extras: extras.map((x) => ({ projectId: x.slug, title: x.title })), count: extras.length, kind: 'mods' };
}

// ---------------- Rendimiento ----------------

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

// El módulo de rendimiento decide el formato; se aceptan las variantes razonables (MB o GB).
function normalizeRec(r) {
  if (!r || typeof r !== 'object') return null;
  const mem = r.memory && typeof r.memory === 'object' ? r.memory : r;
  let max = num(mem.max ?? mem.maxMb ?? r.maxMemory ?? r.ram ?? r.memoryMb ?? (typeof r.memory === 'number' ? r.memory : null));
  if (!max) return null;
  if (max < 64) max *= 1024;
  let min = num(mem.min ?? mem.minMb ?? r.minMemory);
  if (min && min < 64) min *= 1024;
  const reason = [r.reason, r.why, r.explanation, r.summary].find((x) => typeof x === 'string' && x.trim()) || (Array.isArray(r.reasons) ? r.reasons.filter((x) => typeof x === 'string').join(' ') : null);
  // "lowEnd" en la respuesta repite lo que se pidió: la detección real sale de la gama del equipo (tier).
  const detectedLowEnd = typeof r.tier === 'string' ? r.tier === 'low' : typeof r.isLowEnd === 'boolean' ? r.isLowEnd : null;
  return { memory: { min: Math.min(min || 1024, max), max: Math.round(max) }, reason: reason || null, detectedLowEnd };
}

const lowEndGuess = (sys) => Boolean(sys && (sys.totalMem < 6 * 1024 ** 3 || sys.cpuCores <= 2));

// Recomendación para la instancia elegida (con o sin modo de PC de pocos recursos).
function perfFetch(tg, lowEnd) {
  const key = `${tg?.mcVersion ? `${tg.mcVersion}|${tg.loader}|${tg.preset || ''}` : 'none'}|${lowEnd ? 'low' : 'std'}`;
  return fetchInto(data.perf, key, 'perf', async () => {
    if (tg?.mcVersion) {
      try {
        const rec = normalizeRec(await api.invoke('perf:recommend', { mcVersion: tg.mcVersion, loader: tg.loader, preset: tg.preset, lowEnd }));
        if (rec) return { ...rec, source: 'module' };
      } catch (err) {
        if (!isMissing(err)) console.warn('[welcome] perf:recommend', err?.message || err);
      }
    }
    const sys = await api.system.info();
    const max = num(sys?.recommended?.max) || 4096;
    return { memory: { min: Math.min(num(sys?.recommended?.min) || 1024, max), max }, reason: null, detectedLowEnd: lowEndGuess(sys), source: 'system' };
  });
}

function effectiveLowEnd() {
  if (S.lowEnd !== null) return S.lowEnd;
  const base = perfFetch(instanceTarget(), false);
  if (base.status === 'ready' && typeof base.value.detectedLowEnd === 'boolean') return base.value.detectedLowEnd;
  return lowEndGuess(data.sys?.value);
}

function perfEntry() {
  return perfFetch(instanceTarget(), effectiveLowEnd());
}

function sliderMax() {
  const sys = data.sys?.value;
  const totalMb = sys ? Math.floor(sys.totalMem / 1048576) : 8192;
  return Math.max(2048, Math.floor((totalMb - 1024) / 512) * 512);
}

function chosenMemory() {
  if (S.memoryMode === 'manual') return { min: Math.min(1024, S.manualMax), max: S.manualMax };
  const e = perfEntry();
  return e.status === 'ready' ? e.value.memory : null;
}

// ---------------- Validez y resúmenes ----------------

function stepNeed(id) {
  if (id === 'language' || id === 'account') return 'required';
  if (id === 'instance') return store.instances.length ? 'optional' : 'required';
  if (id === 'appearance' || id === 'venus' || id === 'content') return 'optional';
  return null;
}

function stepValid(id) {
  if (id === 'account') return store.accounts.accounts.length > 0;
  if (id === 'instance') {
    if (S.instSkip && S.instMode === 'new') return true;
    const tg = instanceTarget();
    return Boolean(tg?.ready && (S.instMode === 'existing' || S.instName.trim()));
  }
  return true;
}

function canReach(i) {
  for (let j = 0; j < i; j++) if (!stepValid(STEPS[j].id)) return false;
  return true;
}

// Explicación de por qué no se puede seguir (se muestra junto al botón Siguiente).
function blockReason(id) {
  if (id === 'account') return t('welcome.hintAccount');
  if (id === 'instance') {
    const tg = instanceTarget();
    if (data.manifest?.status === 'error') return t('welcome.hintVersions');
    if (tg && (tg.status === 'error' || tg.status === 'none')) return t('welcome.hintCombo');
    if (!tg || !tg.mcVersion || tg.loaderState?.status === 'loading') return t('welcome.hintLoading');
    if (!tg.ready) return t('welcome.hintLoader');
    return t('welcome.hintName');
  }
  return '';
}

function busy() {
  return Boolean(S && (S.accBusy || S.venusBusy || S.finishing || S.langBusy));
}

function railSummary(id) {
  switch (id) {
    case 'language':
      return LANGUAGES.find((l) => l.code === S.language)?.name || null;
    case 'appearance':
      return appearanceSummary();
    case 'account':
      return store.selectedAccount()?.name || null;
    case 'venus':
      return cloud.isSignedIn() ? cloud.profile?.username || cloud.user?.email || null : t('welcome.railSkipped');
    case 'instance': {
      const tg = instanceTarget();
      if (tg?.existing) return tg.existing.name;
      return tg?.mcVersion ? `${loaderName(tg.kind)} ${tg.mcVersion}` : null;
    }
    case 'content': {
      const plan = contentPlan();
      return plan.count ? t(plan.kind === 'packs' ? 'welcome.railPacks' : 'welcome.railMods', { count: plan.count }) : t('welcome.railNothing');
    }
    case 'performance': {
      const mem = chosenMemory();
      return mem ? t(S.memoryMode === 'manual' ? 'welcome.railManual' : 'welcome.railAuto', { ram: fmtMb(mem.max) }) : null;
    }
    case 'prefs':
      return t(`welcome.after_${S.afterLaunch}`);
    default:
      return null;
  }
}

function appearanceSummary() {
  const a = appearanceSettings().appearance;
  const color = a.accent === 'custom' ? a.customColor : t(`appearance.preset_${a.accent}`);
  const background = a.background === 'wallpaper'
    ? getWallpaper(a.wallpaperId)?.name || t('appearance.bgStars')
    : t(a.background === 'image' && a.bgFile ? 'appearance.bgImage' : 'appearance.bgStars');
  return `${color} · ${background}`;
}

function stepTexts(id) {
  if (id === 'instance' && store.instances.length) return [t('welcome.t_instance'), t('welcome.s_instanceExisting', { count: store.instances.length })];
  if (id === 'content') {
    const tg = instanceTarget();
    const name = tg?.existing?.name || S.instName.trim();
    return [t('welcome.t_content'), name ? t('welcome.s_contentFor', { name }) : t('welcome.s_content')];
  }
  return [t(`welcome.t_${id}`), t(`welcome.s_${id}`)];
}

// ---------------- Acciones ----------------

async function saveLanguage() {
  try {
    if (store.settings?.language !== S.language) await store.setSettings({ language: S.language });
  } catch (err) {
    console.warn('[welcome] idioma', err?.message || err);
  }
}

async function chooseLanguage(code) {
  if (S.langBusy) return;
  S.language = code;
  S.langBusy = true;
  pendingFocus = `lang-${code}`;
  const changed = code !== getLanguage();
  try {
    await store.setSettings({ language: code });
    if (changed) await setLanguage(code); // app.js vuelve a dibujar la página con el idioma nuevo
  } catch (err) {
    console.warn('[welcome] idioma', err?.message || err);
  } finally {
    if (S) S.langBusy = false;
  }
  // Con idioma nuevo app.js ya redibujó: solo hay que reactivar los botones. Si no cambió, se actualiza la selección.
  setTimeout(() => (changed ? view?.chromeSoon() : view?.refreshSoon()), 0);
}

async function loginMicrosoft(ctx) {
  if (S.accBusy) return;
  S.accBusy = true;
  S.accMsg = null;
  ctx.refresh();
  try {
    await api.accounts.loginMicrosoft();
    await store.refreshAccounts();
    S.accMsg = { kind: 'good', text: t('welcome.accAddedOk', { name: store.selectedAccount()?.name || '' }) };
    pendingFocus = 'next';
  } catch (err) {
    const cancelled = /cancel/i.test(err?.message || '');
    S.accMsg = { kind: cancelled ? 'info' : 'bad', text: err?.message || String(err) };
  } finally {
    S.accBusy = false;
    if (ctx.alive()) ctx.refresh();
  }
}

async function addOffline(ctx) {
  const name = S.offlineName.trim();
  if (!OFFLINE_NAME.test(name)) {
    S.accMsg = null;
    S.fieldErr = { fk: 'offline-name', text: t('welcome.accNameInvalid') };
    pendingFocus = 'offline-name';
    ctx.refresh();
    return;
  }
  try {
    await api.accounts.addOffline(name);
    await store.refreshAccounts();
    S.offlineName = '';
    S.accMsg = { kind: 'good', text: t('welcome.accAddedOk', { name }) };
    pendingFocus = 'next';
  } catch (err) {
    S.accMsg = { kind: 'bad', text: err?.message || String(err) };
    pendingFocus = 'offline-name';
  }
  if (ctx.alive()) ctx.refresh();
}

async function selectAccount(id, ctx) {
  try {
    await api.accounts.select(id);
    await store.refreshAccounts();
  } catch (err) {
    S.accMsg = { kind: 'bad', text: err?.message || String(err) };
  }
  pendingFocus = `acc-${id}`;
  if (ctx.alive()) ctx.refresh();
}

async function removeAccount(acc, ctx) {
  const okRemove = await confirmDialog(t('welcome.accRemoveTitle'), t('welcome.accRemoveConfirm', { name: acc.name }), {
    okText: t('welcome.remove'),
    cancelText: t('welcome.cancel'),
    danger: true,
  });
  if (!okRemove) return;
  try {
    await api.accounts.remove(acc.id);
    await store.refreshAccounts();
    S.accMsg = null;
  } catch (err) {
    S.accMsg = { kind: 'bad', text: err?.message || String(err) };
  }
  if (ctx.alive()) ctx.refresh();
}

// Mensajes de Supabase en el idioma del usuario.
function cloudErrorText(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || err || '');
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return t('welcome.venusErrCredentials');
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) return t('welcome.venusErrNotConfirmed');
  if (['user_already_exists', 'email_exists'].includes(code) || /already registered|already exists/i.test(msg)) return t('welcome.venusErrExists');
  if (code === 'weak_password' || /password should|password is too|weak password/i.test(msg)) return t('welcome.venusErrWeak');
  if (code === 'otp_expired' || /token has expired|invalid otp|otp.*(invalid|expired)/i.test(msg)) return t('welcome.venusErrCode');
  if (/rate_limit/.test(code) || err?.status === 429 || /rate limit|security purposes/i.test(msg)) return t('welcome.venusErrRate');
  if (code === 'signup_disabled' || /signups? not allowed|signup.*disabled/i.test(msg)) return t('welcome.venusErrSignupDisabled');
  if (code === 'email_address_invalid' || /invalid.*email|email.*invalid/i.test(msg)) return t('welcome.venusErrEmail');
  if (/database error saving new user/i.test(msg)) return t('welcome.venusErrDb');
  if (err?.name === 'AuthRetryableFetchError' || /failed to fetch|fetch failed|network/i.test(msg)) return t('welcome.venusErrNetwork');
  return msg ? t('welcome.venusErrGeneric', { error: msg }) : t('welcome.venusErrUnknown');
}

async function venusRun(ctx, fn) {
  if (S.venusBusy) return;
  S.venusBusy = true;
  S.venusMsg = null;
  S.fieldErr = null;
  ctx.refresh();
  try {
    await fn();
  } catch (err) {
    if (/email_not_confirmed/.test(String(err?.code)) || /email not confirmed/i.test(String(err?.message))) {
      S.venusTab = 'verify';
      S.venusMsg = { kind: 'info', text: t('welcome.venusConfirmFirst', { email: S.venusEmail.trim() }) };
      pendingFocus = 'v-code';
    } else {
      S.venusMsg = { kind: 'bad', text: cloudErrorText(err) };
    }
  } finally {
    S.venusBusy = false;
    if (ctx.alive()) ctx.refresh();
  }
}

function venusSignIn(ctx) {
  const email = S.venusEmail.trim();
  if (!EMAIL.test(email)) return venusInvalid(ctx, t('welcome.venusErrEmail'), 'v-email');
  if (!venusPass) return venusInvalid(ctx, t('welcome.venusPassRequired'), 'v-pass');
  return venusRun(ctx, async () => {
    await cloud.signIn({ email, password: venusPass });
    venusPass = '';
    S.venusMsg = { kind: 'good', text: t('welcome.venusSignedInOk') };
    pendingFocus = 'next';
  });
}

function venusSignUp(ctx) {
  const username = S.venusUser.trim();
  const email = S.venusEmail.trim();
  if (!VENUS_USER.test(username)) return venusInvalid(ctx, t('welcome.venusUserInvalid'), 'v-user');
  if (!EMAIL.test(email)) return venusInvalid(ctx, t('welcome.venusErrEmail'), 'v-email');
  if (venusPass.length < MIN_PASSWORD) return venusInvalid(ctx, t('welcome.venusPassShort', { count: MIN_PASSWORD }), 'v-pass');
  return venusRun(ctx, async () => {
    const res = await cloud.signUp({ email, password: venusPass, username });
    // Supabase no avisa si el email ya existe: devuelve un usuario sin identidades.
    if (res?.user && Array.isArray(res.user.identities) && res.user.identities.length === 0) {
      S.venusTab = 'signin';
      S.venusMsg = { kind: 'bad', text: t('welcome.venusErrExists') };
      pendingFocus = 'v-pass';
      return;
    }
    venusPass = '';
    if (res?.session) {
      S.venusMsg = { kind: 'good', text: t('welcome.venusCreatedOk') };
      pendingFocus = 'next';
    } else {
      S.venusTab = 'verify';
      S.venusCode = '';
      S.resendAt = Date.now() + 60000;
      S.venusMsg = { kind: 'info', text: t('welcome.venusCodeSent', { email }) };
      pendingFocus = 'v-code';
    }
  });
}

function venusVerify(ctx) {
  const code = S.venusCode.replace(/\D/g, '');
  if (code.length < 6) return venusInvalid(ctx, t('welcome.venusCodeInvalid'), 'v-code');
  return venusRun(ctx, async () => {
    await cloud.verifyEmailCode(S.venusEmail.trim(), code, 'signup');
    S.venusMsg = { kind: 'good', text: t('welcome.venusCreatedOk') };
    pendingFocus = 'next';
  });
}

function venusResend(ctx) {
  return venusRun(ctx, async () => {
    await cloud.resendSignupCode(S.venusEmail.trim());
    S.resendAt = Date.now() + 60000;
    S.venusMsg = { kind: 'info', text: t('welcome.venusResent', { email: S.venusEmail.trim() }) };
  });
}

// Error de un dato del formulario: se muestra debajo de su campo (no en el aviso general) y el foco va ahi.
function venusInvalid(ctx, text, fk) {
  S.venusMsg = null;
  S.fieldErr = { fk, text };
  pendingFocus = fk;
  ctx.refresh();
}

// Instalaciones que siguen después de cerrar la bienvenida (no bloquean: se ven en el panel de tareas).
async function installProjects(instanceId, list) {
  const failed = [];
  for (const p of list) {
    try {
      await api.modrinth.install(instanceId, p.projectId, null, {});
    } catch (err) {
      console.warn('[welcome] instalar', p.projectId, err?.message || err);
      failed.push(p.title || p.projectId);
    }
  }
  if (failed.length) toast('bad', t('welcome.bgModsFailed', { count: failed.length }), failed.join(', '), 9000);
}

function runBackground({ instanceId, created, plan, perfOpts }) {
  (async () => {
    if (plan.packIds.length) {
      try {
        await api.invoke('catalog:installPacks', instanceId, plan.packIds);
      } catch (err) {
        if (isMissing(err)) await installProjects(instanceId, plan.packItems);
        else toast('bad', t('welcome.bgPacksFailed'), err?.message || String(err), 9000);
      }
    }
    if (plan.extras.length) await installProjects(instanceId, plan.extras);
    if (created) {
      try {
        await api.invoke('perf:applyRecommended', instanceId, perfOpts);
      } catch (err) {
        if (!isMissing(err)) console.warn('[welcome] perf:applyRecommended', err?.message || err);
      }
    }
  })().catch((err) => console.error('[welcome]', err));
}

async function finish(ctx) {
  if (S.finishing) return;
  const missing = ['account', 'instance'].find((id) => !stepValid(id));
  if (missing) {
    ctx.go(STEP_INDEX[missing]);
    return;
  }
  S.finishing = true;
  S.finishMsg = null;
  ctx.refresh();
  try {
    await flushAppearance();
    const memory = chosenMemory() || (await api.system.info().then((s) => s.recommended).catch(() => null));
    const patch = {
      language: S.language,
      memoryMode: S.memoryMode,
      afterLaunch: S.afterLaunch,
      discord: { enabled: Boolean(S.discord) },
    };
    if (memory) patch.memory = { min: memory.min, max: memory.max };
    await store.setSettings(patch);

    const tg = instanceTarget();
    let instanceId = null;
    let created = false;
    if (S.instMode === 'existing') instanceId = tg?.existing?.id || null;
    else if (tg?.mcVersion) {
      if (!S.createdId) {
        const inst = await api.instances.create({
          name: S.instName.trim() || uniqueName(`${loaderName(tg.kind)} ${tg.mcVersion}`),
          mcVersion: tg.mcVersion,
          loader: tg.loader,
          loaderVersion: tg.loaderVersion || null,
          preset: tg.preset,
        });
        S.createdId = inst.id;
      }
      instanceId = S.createdId;
      created = true;
    }
    const plan = contentPlan();
    if (created && comboAddsSodium()) {
      const hasSodium = [...plan.packItems, ...plan.extras].some((p) => SODIUM_IDS.has(p.projectId) || /sodium/i.test(p.title || ''));
      if (!hasSodium) plan.extras.unshift({ projectId: 'sodium', title: 'Sodium' });
    }
    const lowEnd = effectiveLowEnd();
    await store.setSettings({ onboarded: true, ...(instanceId ? { selectedInstance: instanceId } : {}) });
    if (instanceId) runBackground({ instanceId, created, plan, perfOpts: { memory: S.memoryMode === 'auto', mods: false, options: true, lowEnd } });
    const name = S.instMode === 'new' ? S.instName.trim() : tg?.existing?.name;
    S = null;
    venusPass = '';
    resetData(); // si se vuelve a abrir la bienvenida más adelante, los datos se piden de nuevo
    if (created) toast('good', t('welcome.doneTitle'), t('welcome.doneInstalling', { name }), 7000);
    else toast('good', t('welcome.doneTitle'), t('welcome.doneReady'), 5000);
    await finishOnboarding();
  } catch (err) {
    if (!S) return;
    S.finishing = false;
    S.finishMsg = err?.message || String(err);
    if (ctx.alive()) ctx.refresh();
  }
}

// ---------------- Piezas de interfaz ----------------

function note(kind, ic, text, extra) {
  return h(
    'div',
    { class: ['notice', kind !== 'warn' && kind, 'wl-notice'], role: kind === 'bad' ? 'alert' : 'status' },
    icon(ic),
    h('div', { class: 'wl-notice-text' }, text),
    extra || null,
  );
}

function spinner() {
  return h('div', { class: 'spinner' });
}

// ---- Errores de un campo (S.fieldErr): debajo del campo, con aria-invalid y aria-describedby ----
const errId = (fk) => `wl-${fk}-err`;

function describe(input, add, remove) {
  const ids = new Set(String(input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  if (remove) ids.delete(remove);
  if (add) ids.add(add);
  if (ids.size) input.setAttribute('aria-describedby', [...ids].join(' '));
  else input.removeAttribute('aria-describedby');
}

function fieldErrorEl(fk) {
  if (S?.fieldErr?.fk !== fk) return null;
  return h('div', { class: 'field-error', id: errId(fk), role: 'alert' }, icon('alert'), h('span', {}, S.fieldErr.text));
}

function showFieldError(input, fk, text) {
  S.fieldErr = { fk, text };
  input.setAttribute('aria-invalid', 'true');
  describe(input, errId(fk));
  document.getElementById(errId(fk))?.remove();
  input.closest('.field')?.append(fieldErrorEl(fk));
}

// Marca el campo si tiene un error guardado, lo borra al volver a escribir y (con check) valida al salir
// del campo: solo valores escritos, los vacios los avisa Siguiente o el envio.
function watchField(input, fk, check) {
  if (S?.fieldErr?.fk === fk) {
    input.setAttribute('aria-invalid', 'true');
    describe(input, errId(fk));
  }
  input.addEventListener('input', () => {
    if (S?.fieldErr?.fk !== fk) return;
    S.fieldErr = null;
    input.removeAttribute('aria-invalid');
    describe(input, null, errId(fk));
    document.getElementById(errId(fk))?.remove();
  });
  if (check) {
    input.addEventListener('blur', () => {
      const v = input.value.trim();
      if (!S || !v || S.fieldErr?.fk === fk) return;
      const text = check(v);
      if (text) showFieldError(input, fk, text);
    });
  }
  return input;
}

function inlineLoading(text) {
  return h('div', { class: 'wl-inline-load' }, spinner(), text);
}

// Estado vacio del sistema de diseño (icono en recuadro de acento + que pasa + como seguir).
function emptyBox(ic, title, text, action) {
  const el = emptyState(ic, title, text, action || null);
  el.classList.add('wl-empty');
  return el;
}

function columns(list) {
  const top = list[0].getBoundingClientRect().top;
  let n = 0;
  for (const el of list) {
    if (Math.abs(el.getBoundingClientRect().top - top) > 4) break;
    n++;
  }
  return Math.max(1, n);
}

// Tabindex itinerante: solo la opción elegida (o la primera habilitada) entra en el orden de Tab.
function rove(container, selector) {
  const items = [...container.querySelectorAll(selector)];
  const current = items.find((el) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true') || items.find((el) => !el.disabled);
  items.forEach((el) => el.setAttribute('tabindex', el === current ? '0' : '-1'));
}

// Grupo de opciones navegable con flechas (las opciones se buscan al apretar, así sirve aunque se redibujen).
function radioGroup(container, selector) {
  rove(container, selector);
  container.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const list = [...container.querySelectorAll(selector)].filter((el) => !el.disabled);
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    let j = i;
    if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    else if (e.key === 'ArrowRight') j = i + 1;
    else if (e.key === 'ArrowLeft') j = i - 1;
    else j = i + (e.key === 'ArrowDown' ? 1 : -1) * columns(list);
    j = Math.max(0, Math.min(list.length - 1, j));
    list[i].setAttribute('tabindex', '-1');
    list[j].setAttribute('tabindex', '0');
    list[j].focus();
    list[j].scrollIntoView({ block: 'nearest' });
  });
  return container;
}

function segmented(name, options, value, onChange, label) {
  const el = h(
    'div',
    { class: 'segmented wl-seg', role: 'radiogroup', 'aria-label': label },
    options.map(([v, ic, text]) =>
      h('button', { type: 'button', class: [v === value && 'active'], role: 'radio', 'aria-checked': String(v === value), 'data-fk': `${name}-${v}`, onclick: () => v !== value && onChange(v) }, ic ? icon(ic) : null, text),
    ),
  );
  return radioGroup(el, 'button');
}

// Tarjeta de opción (radio) con ícono, título, texto y lista de ventajas/desventajas.
function choiceCard({ on, fk, ic, title, sub, pros, onPick, disabled }) {
  return h(
    'button',
    { type: 'button', class: ['wl-choice', on && 'is-on'], role: 'radio', 'aria-checked': String(Boolean(on)), 'data-fk': fk, disabled, onclick: onPick },
    h('span', { class: 'wl-choice-head' }, h('span', { class: 'wl-choice-icon' }, icon(ic)), h('span', { class: 'wl-choice-title' }, title), h('span', { class: 'wl-radio', 'aria-hidden': 'true' })),
    sub ? h('span', { class: 'wl-choice-sub' }, sub) : null,
    pros
      ? h(
          'span',
          { class: 'wl-pros' },
          pros.map(([yes, text]) => h('span', { class: ['wl-pro', yes ? 'is-yes' : 'is-no'] }, icon(yes ? 'wlCheckCircle' : 'wlXCircle'), text)),
        )
      : null,
  );
}

function msLogo() {
  return h('span', { class: 'ms-logo', 'aria-hidden': 'true' }, ['#f25022', '#7fba00', '#00a4ef', '#ffb900'].map((c) => h('i', { style: { background: c } })));
}

// ---------------- Paso 1: idioma ----------------

function stepLanguage(ctx) {
  const grid = h(
    'div',
    { class: 'wl-langs', role: 'radiogroup', 'aria-label': t('welcome.langLabel') },
    LANGUAGES.map((l) => {
      const on = S.language === l.code;
      return h(
        'button',
        { type: 'button', class: ['wl-lang', on && 'is-on'], role: 'radio', 'aria-checked': String(on), 'data-fk': `lang-${l.code}`, lang: l.locale, onclick: () => chooseLanguage(l.code) },
        h('span', { class: 'wl-lang-code', 'aria-hidden': 'true' }, l.code.toUpperCase()),
        h('span', { class: 'wl-lang-text' }, h('span', { class: 'wl-lang-name' }, l.name), h('span', { class: 'wl-lang-en', lang: 'en' }, l.english)),
        h('span', { class: 'wl-lang-check', 'aria-hidden': 'true' }, on ? icon('check') : null),
      );
    }),
  );
  radioGroup(grid, '.wl-lang');
  const ready = store.accounts.accounts.length > 0 && store.instances.length > 0;
  return h(
    'div',
    { class: 'wl-stack' },
    grid,
    h('p', { class: 'wl-hint' }, icon('info'), t('welcome.langHint')),
    ready
      ? note('good', 'check', t('welcome.reentryText'), h('button', { type: 'button', class: 'btn sm', onclick: () => ctx.go(STEP_INDEX.summary) }, t('welcome.reentryGo'), icon('arrowRight')))
      : null,
  );
}

// ---------------- Apariencia: misma selección y guardado que Ajustes ----------------

function stepAppearance() {
  return appearancePicker({ compact: true });
}

// ---------------- Cuenta de Minecraft ----------------

function setAccMode(mode, ctx) {
  S.accMode = mode;
  S.accMsg = null;
  S.fieldErr = null;
  pendingFocus = mode === 'offline' ? 'offline-name' : 'ms-login';
  ctx.refresh();
}

function accountList(ctx) {
  const accs = store.accounts.accounts;
  const sel = store.selectedAccount();
  if (!accs.length) return h('div', { class: 'wl-acc-empty' }, icon('user'), h('span', {}, t('welcome.accNone')));
  return h(
    'div',
    { class: 'wl-acc-list' },
    accs.map((a) => {
      const on = a.id === sel?.id;
      return h(
        'div',
        { class: ['wl-acc', on && 'is-on'] },
        h(
          'button',
          { type: 'button', class: 'wl-acc-main', 'data-fk': `acc-${a.id}`, 'aria-pressed': String(on), title: on ? t('welcome.accInUse') : t('welcome.accUse'), onclick: () => !on && selectAccount(a.id, ctx) },
          avatarImg(a.type === 'msa' ? a.uuid : a.name, 64, 'wl-acc-avatar'),
          h(
            'span',
            { class: 'wl-acc-text' },
            h('span', { class: 'wl-acc-name' }, a.name),
            h('span', { class: 'wl-acc-type' }, a.type === 'msa' ? t('welcome.accTypeMsa') : t('welcome.accTypeOffline')),
            a.needsLogin
              ? h('span', { class: 'wl-acc-flag is-warn' }, icon('alert'), t('welcome.accNeedsLogin'))
              : on
                ? h('span', { class: 'wl-acc-flag' }, icon('check'), t('welcome.accInUse'))
                : null,
          ),
        ),
        h(
          'button',
          { type: 'button', class: 'icon-btn sm danger', title: t('welcome.accRemove', { name: a.name }), 'aria-label': t('welcome.accRemove', { name: a.name }), onclick: () => removeAccount(a, ctx) },
          icon('trash'),
        ),
      );
    }),
  );
}

function premiumBox(ctx) {
  return h(
    'div',
    { class: 'wl-action' },
    h(
      'button',
      { type: 'button', class: 'ms-btn wl-ms', 'data-fk': 'ms-login', disabled: S.accBusy, 'aria-busy': S.accBusy ? 'true' : null, onclick: () => loginMicrosoft(ctx) },
      S.accBusy ? spinner() : msLogo(),
      S.accBusy ? t('welcome.accWaiting') : t('welcome.accMsButton'),
    ),
    h('p', { class: 'wl-hint' }, icon('lock'), t('welcome.accMsHint')),
  );
}

function offlineBox(ctx) {
  const valid = () => OFFLINE_NAME.test(S.offlineName.trim());
  const input = h('input', {
    class: 'input',
    id: 'wl-offline-name',
    'data-fk': 'offline-name',
    value: S.offlineName,
    maxlength: 16,
    placeholder: t('welcome.accNamePlaceholder'),
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'wl-offline-hint',
  });
  const add = h('button', { type: 'button', class: 'btn primary', disabled: !valid(), onclick: () => addOffline(ctx) }, icon('plus'), t('welcome.accAddOffline'));
  // La regla queda siempre a la vista; el error se marca al salir del campo o al intentar agregar.
  const hint = h('div', { class: 'field-help', id: 'wl-offline-hint' }, t('welcome.accNameRule'));
  input.addEventListener('input', () => {
    S.offlineName = input.value;
    add.disabled = !valid();
  });
  watchField(input, 'offline-name', (v) => (OFFLINE_NAME.test(v) ? null : t('welcome.accNameInvalid')));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addOffline(ctx);
    }
  });
  return h(
    'div',
    { class: 'wl-action' },
    h('div', { class: 'field' }, h('label', { for: 'wl-offline-name' }, t('welcome.accNameLabel')), h('div', { class: 'wl-input-row' }, input, add), hint, fieldErrorEl('offline-name')),
  );
}

function stepAccount(ctx) {
  const choices = radioGroup(
    h(
      'div',
      { class: 'wl-choices', role: 'radiogroup', 'aria-label': t('welcome.accQuestion') },
      choiceCard({
        on: S.accMode === 'premium',
        fk: 'acc-premium',
        ic: 'wlUserCheck',
        title: t('welcome.accPremium'),
        sub: t('welcome.accPremiumSub'),
        pros: [
          [true, t('welcome.accProPremiumServers')],
          [true, t('welcome.accProSkin')],
          [true, t('welcome.accProAll')],
        ],
        onPick: () => setAccMode('premium', ctx),
      }),
      choiceCard({
        on: S.accMode === 'offline',
        fk: 'acc-offline',
        ic: 'wlWifiOff',
        title: t('welcome.accOffline'),
        sub: t('welcome.accOfflineSub'),
        pros: [
          [true, t('welcome.accProSingle')],
          [true, t('welcome.accProLan')],
          [false, t('welcome.accConPremium')],
        ],
        onPick: () => setAccMode('offline', ctx),
      }),
    ),
    '.wl-choice',
  );
  const msg = S.accMsg
    ? note(
        S.accMsg.kind,
        S.accMsg.kind === 'good' ? 'check' : S.accMsg.kind === 'info' ? 'info' : 'alert',
        S.accMsg.text,
        S.accMsg.offerOffline && S.accMode !== 'offline' ? h('button', { type: 'button', class: 'btn sm', onclick: () => setAccMode('offline', ctx) }, t('welcome.accTryOffline')) : null,
      )
    : null;
  if (msg) msg.dataset.reveal = '1';
  const count = store.accounts.accounts.length;
  return h(
    'div',
    { class: 'wl-split' },
    h(
      'div',
      { class: 'wl-split-main wl-stack' },
      h('div', { class: 'wl-question', id: 'wl-acc-q' }, t('welcome.accQuestion')),
      choices,
      S.accMode === 'premium' ? premiumBox(ctx) : S.accMode === 'offline' ? offlineBox(ctx) : null,
      msg,
    ),
    h(
      'aside',
      { class: 'wl-split-side' },
      h('div', { class: 'wl-side-title' }, icon('users'), t('welcome.accAddedTitle'), count ? h('span', { class: 'wl-count' }, String(count)) : null),
      accountList(ctx),
      count ? h('p', { class: 'wl-hint' }, icon('info'), t('welcome.accMoreLater')) : null,
    ),
  );
}

// ---------------- Paso 3: cuenta de Venus ----------------

function passwordInput(fk, autocomplete, check) {
  const input = h('input', { class: 'input', type: 'password', id: `wl-${fk}`, 'data-fk': fk, value: venusPass, autocomplete, spellcheck: 'false' });
  input.addEventListener('input', () => {
    venusPass = input.value;
  });
  watchField(input, fk, check);
  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'wl-eye',
      title: t('welcome.venusShowPass'),
      'aria-label': t('welcome.venusShowPass'),
      'aria-pressed': 'false',
      onclick: () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.setAttribute('aria-pressed', String(show));
        mount(toggle, icon(show ? 'eyeOff' : 'eye'));
      },
    },
    icon('eye'),
  );
  return h('div', { class: 'wl-pass' }, input, toggle);
}

function textField(fk, label, value, onInput, { hint, check, ...attrs } = {}) {
  const helpId = hint ? `wl-${fk}-help` : null;
  const input = h('input', { class: 'input', id: `wl-${fk}`, 'data-fk': fk, value, spellcheck: 'false', 'aria-describedby': helpId, ...attrs });
  input.addEventListener('input', () => onInput(input.value));
  watchField(input, fk, check);
  return h('div', { class: 'field' }, h('label', { for: `wl-${fk}` }, label), input, hint ? h('div', { class: 'field-help', id: helpId }, hint) : null, fieldErrorEl(fk));
}

const checkEmail = (v) => (EMAIL.test(v) ? null : t('welcome.venusErrEmail'));
const checkUser = (v) => (VENUS_USER.test(v) ? null : t('welcome.venusUserInvalid'));
const checkNewPass = (v) => (v.length >= MIN_PASSWORD ? null : t('welcome.venusPassShort', { count: MIN_PASSWORD }));

function venusForm(ctx, onSubmit, fields, submitIcon, submitText) {
  return h(
    'form',
    {
      class: 'wl-form',
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        onSubmit(ctx);
      },
    },
    fields,
    h(
      'div',
      { class: 'wl-form-actions' },
      h('button', { type: 'submit', class: 'btn primary', disabled: S.venusBusy, 'aria-busy': S.venusBusy ? 'true' : null }, S.venusBusy ? spinner() : icon(submitIcon), submitText),
    ),
  );
}

function venusForms(ctx) {
  let body;
  if (S.venusTab === 'verify') {
    const code = h('input', {
      class: 'input wl-code',
      id: 'wl-v-code',
      'data-fk': 'v-code',
      value: S.venusCode,
      inputmode: 'numeric',
      autocomplete: 'one-time-code',
      maxlength: 10,
      placeholder: '000000',
      'aria-describedby': 'wl-v-code-hint',
    });
    code.addEventListener('input', () => {
      code.value = code.value.replace(/\D/g, '');
      S.venusCode = code.value;
    });
    watchField(code, 'v-code', (v) => (v.replace(/\D/g, '').length >= 6 ? null : t('welcome.venusCodeInvalid')));
    const resend = h('button', { type: 'button', class: 'btn sm ghost num', onclick: () => venusResend(ctx) });
    const paintResend = () => {
      const wait = Math.max(0, Math.ceil((S ? S.resendAt - Date.now() : 0) / 1000));
      resend.disabled = wait > 0 || Boolean(S?.venusBusy);
      mount(resend, icon('mail'), wait > 0 ? t('welcome.venusResendIn', { s: wait }) : t('welcome.venusResend'));
      return wait;
    };
    if (paintResend() > 0) {
      const timer = setInterval(() => {
        if (!resend.isConnected || paintResend() === 0) clearInterval(timer);
      }, 1000);
    }
    body = venusForm(
      ctx,
      venusVerify,
      [
        h('p', { class: 'wl-hint', id: 'wl-v-code-hint' }, icon('mail'), t('welcome.venusCodeHelp', { email: S.venusEmail.trim() })),
        h('div', { class: 'field' }, h('label', { for: 'wl-v-code' }, t('welcome.venusCode')), code, fieldErrorEl('v-code')),
        h(
          'div',
          { class: 'row wrap' },
          resend,
          h(
            'button',
            {
              type: 'button',
              class: 'btn sm ghost',
              onclick: () => {
                S.venusTab = 'signup';
                S.venusMsg = null;
                S.fieldErr = null;
                ctx.refresh();
              },
            },
            icon('edit'),
            t('welcome.venusOtherEmail'),
          ),
        ),
      ],
      'check',
      t('welcome.venusVerify'),
    );
  } else if (S.venusTab === 'signup') {
    body = venusForm(
      ctx,
      venusSignUp,
      [
        textField('v-user', t('welcome.venusUser'), S.venusUser, (v) => (S.venusUser = v), { maxlength: 20, autocomplete: 'username', hint: t('welcome.venusUserHint'), check: checkUser }),
        textField('v-email', t('welcome.venusEmail'), S.venusEmail, (v) => (S.venusEmail = v), { type: 'email', autocomplete: 'email', check: checkEmail }),
        h('div', { class: 'field' }, h('label', { for: 'wl-v-pass' }, t('welcome.venusPassword')), passwordInput('v-pass', 'new-password', checkNewPass), h('div', { class: 'field-help' }, t('welcome.venusPassRule', { count: MIN_PASSWORD })), fieldErrorEl('v-pass')),
      ],
      'userPlus',
      t('welcome.venusCreate'),
    );
  } else {
    body = venusForm(
      ctx,
      venusSignIn,
      [
        textField('v-email', t('welcome.venusEmail'), S.venusEmail, (v) => (S.venusEmail = v), { type: 'email', autocomplete: 'email', check: checkEmail }),
        h('div', { class: 'field' }, h('label', { for: 'wl-v-pass' }, t('welcome.venusPassword')), passwordInput('v-pass', 'current-password'), fieldErrorEl('v-pass')),
      ],
      'logIn',
      t('welcome.venusSignInBtn'),
    );
  }
  const tabs =
    S.venusTab === 'verify'
      ? null
      : segmented(
          'vtab',
          [
            ['signin', 'logIn', t('welcome.venusSignIn')],
            ['signup', 'userPlus', t('welcome.venusSignUp')],
          ],
          S.venusTab,
          (v) => {
            S.venusTab = v;
            S.venusMsg = null;
            S.fieldErr = null;
            pendingFocus = `vtab-${v}`;
            ctx.refresh();
          },
          t('welcome.venusModeLabel'),
        );
  const msg = S.venusMsg ? note(S.venusMsg.kind, S.venusMsg.kind === 'good' ? 'check' : S.venusMsg.kind === 'info' ? 'mail' : 'alert', S.venusMsg.text) : null;
  if (msg) msg.dataset.reveal = '1';
  return h('div', { class: 'wl-stack' }, tabs, h('div', { class: 'card wl-form-card' }, body), msg);
}

function venusSignedIn(ctx) {
  const p = cloud.profile;
  const u = cloud.user;
  const name = p?.display_name || p?.username || u?.email || '';
  return h(
    'div',
    { class: 'wl-stack' },
    h(
      'div',
      { class: 'card wl-venus-card' },
      h('div', { class: 'wl-venus-avatar', 'aria-hidden': 'true' }, (name.trim()[0] || 'V').toUpperCase()),
      h(
        'div',
        { class: 'wl-venus-text' },
        h('div', { class: 'wl-venus-name' }, t('welcome.venusSignedAs', { name })),
        u?.email && u.email !== name ? h('div', { class: 'small muted' }, u.email) : null,
        p?.friend_code ? h('div', { class: 'small muted' }, t('welcome.venusFriendCode', { code: p.friend_code })) : null,
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn sm ghost',
          onclick: async () => {
            try {
              await cloud.signOut();
            } catch (err) {
              console.warn('[welcome] cerrar sesión', err?.message || err);
            }
            S.venusMsg = null;
            if (ctx.alive()) ctx.refresh();
          },
        },
        icon('logout'),
        t('welcome.venusSignOut'),
      ),
    ),
    S.venusMsg?.kind === 'good' ? note('good', 'check', S.venusMsg.text) : note('good', 'check', t('welcome.venusReady')),
  );
}

function stepVenus(ctx) {
  let main;
  if (!cloud.isConfigured()) {
    main = h(
      'div',
      { class: 'wl-stack' },
      note('info', 'cloud', t('welcome.venusNotConfigured')),
      h('div', { class: 'card wl-later' }, h('div', { class: 'wl-later-icon' }, icon('settings')), h('div', {}, h('div', { class: 'wl-later-title' }, t('welcome.venusLaterTitle')), h('div', { class: 'wl-later-text' }, t('welcome.venusLater')))),
    );
  } else if (cloud.isSignedIn()) main = venusSignedIn(ctx);
  else main = venusForms(ctx);
  return h(
    'div',
    { class: 'wl-split' },
    h('div', { class: 'wl-split-main' }, main),
    h(
      'aside',
      { class: 'wl-split-side' },
      h('div', { class: 'wl-side-title' }, icon('sparkles'), t('welcome.venusWhat')),
      h(
        'div',
        { class: 'wl-feats' },
        VENUS_FEATURES.map(([ic, key]) => h('div', { class: 'wl-feat' }, h('span', { class: 'wl-feat-icon' }, icon(ic)), h('span', { class: 'wl-feat-text' }, t(`welcome.${key}`)))),
      ),
    ),
  );
}

// ---------------- Paso 4: primera instancia ----------------

function pickCombo(id, ctx) {
  if (id === 'custom' && S.combo !== 'custom') {
    const prev = instanceTarget();
    if (prev?.mcVersion && !S.custom.mc) {
      S.custom.kind = prev.kind;
      S.custom.mc = prev.mcVersion;
    }
  }
  S.combo = id;
  if (id === 'custom' && S.custom.kind !== 'vanilla') ensureSupport(S.custom.kind);
  syncName();
  pendingFocus = `combo-${id}`;
  ctx.refresh();
}

function comboGrid(ctx) {
  const grid = h(
    'div',
    { class: ['wl-combos', S.combo === 'custom' && 'is-compact'], role: 'radiogroup', 'aria-label': t('welcome.instComboLabel') },
    COMBOS.map((c) => {
      const info = c.id === 'custom' ? { status: 'ready' } : comboTarget(c.id);
      const kind = info.kind || c.kind || 'vanilla';
      const on = S.combo === c.id;
      const disabled = info.status === 'none' || info.status === 'error';
      let meta;
      if (c.id === 'custom') meta = t('welcome.comboCustomMeta');
      else if (info.status === 'ready') meta = t('welcome.comboMeta', { version: info.mc, loader: loaderName(kind) });
      else if (info.status === 'loading') meta = h('span', { class: 'wl-dots' }, t('welcome.loadingShort'));
      else meta = t('welcome.comboUnavailable');
      return h(
        'button',
        {
          type: 'button',
          class: ['wl-combo', on && 'is-on'],
          role: 'radio',
          'aria-checked': String(on),
          disabled,
          style: { '--c': c.id === 'custom' ? 'var(--accent)' : LOADERS[kind]?.color || 'var(--accent)' },
          'data-fk': `combo-${c.id}`,
          title: t(`welcome.combo_${c.id}Desc`),
          onclick: () => !on && pickCombo(c.id, ctx),
        },
        h('span', { class: 'wl-combo-head' }, h('span', { class: 'wl-combo-icon' }, icon(c.icon)), h('span', { class: 'wl-combo-title' }, t(`welcome.combo_${c.id}`))),
        h('span', { class: 'wl-combo-desc' }, t(`welcome.combo_${c.id}Desc`)),
        h(
          'span',
          { class: 'wl-combo-foot' },
          h('span', { class: 'wl-combo-meta' }, meta),
          c.recommended ? h('span', { class: 'wl-combo-badge' }, icon('star'), t('welcome.recommended')) : null,
        ),
      );
    }),
  );
  return radioGroup(grid, '.wl-combo');
}

function nameField(ctx) {
  const empty = !S.instName.trim();
  const input = h('input', { class: 'input', id: 'wl-inst-name', 'data-fk': 'inst-name', value: S.instName, maxlength: 60, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'wl-inst-name-hint', 'aria-invalid': empty ? 'true' : null });
  // El nombre viene puesto: si lo borran, el error aparece debajo y Siguiente explica por que no sigue.
  const hint = h('div', { class: ['field-error', !empty && 'hidden'], id: 'wl-inst-name-hint' }, icon('alert'), h('span', {}, t('welcome.instNameEmpty')));
  input.addEventListener('input', () => {
    S.instName = input.value;
    S.nameTouched = true;
    const isEmpty = !S.instName.trim();
    hint.classList.toggle('hidden', !isEmpty);
    if (isEmpty) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    ctx.chrome();
  });
  const reset = S.nameTouched
    ? h(
        'button',
        {
          type: 'button',
          class: 'icon-btn sm',
          title: t('welcome.instNameAuto'),
          'aria-label': t('welcome.instNameAuto'),
          onclick: () => {
            S.nameTouched = false;
            syncName();
            pendingFocus = 'inst-name';
            ctx.refresh();
          },
        },
        icon('refresh'),
      )
    : null;
  return h('div', { class: 'field' }, h('label', { for: 'wl-inst-name' }, t('welcome.instName')), h('div', { class: 'wl-input-row' }, input, reset), hint);
}

function loaderOptionLabel(l) {
  const base = l.label || l.version;
  if (l.recommended) return t('welcome.loaderOptRecommended', { version: base });
  if (l.stable === false) return t('welcome.loaderOptBeta', { version: base });
  return base;
}

function loaderVersionField(tg, onPick, ctx) {
  const st = tg.loaderState;
  const label = tg.kind === 'iris' ? t('welcome.loaderVersionFabric') : tg.kind === 'optifine' ? t('welcome.loaderVersionOptifine') : t('welcome.loaderVersion', { loader: loaderName(tg.kind) });
  let control;
  if (!st || st.status === 'loading') control = inlineLoading(t('welcome.loadingShort'));
  else if (st.status === 'error') control = h('div', { class: 'wl-inline-note' }, icon('info'), t('welcome.loaderListError'));
  else if (!st.value.length) control = h('div', { class: 'wl-inline-note wl-bad' }, icon('alert'), t('welcome.loaderNone', { loader: loaderName(tg.kind), version: tg.mcVersion }));
  else {
    const sel = h(
      'select',
      { class: 'select', id: 'wl-loader-version', 'data-fk': 'loader-version' },
      st.value.map((l) => h('option', { value: l.version, selected: l.version === tg.loaderVersion }, loaderOptionLabel(l))),
    );
    sel.addEventListener('change', () => {
      onPick(sel.value);
      ctx.chrome();
    });
    control = sel;
  }
  return h('div', { class: 'field' }, h('label', { for: 'wl-loader-version' }, label), control);
}

function kindNote(kind) {
  if (kind === 'iris') return note('info', 'sun', t('welcome.noteIris'));
  if (kind === 'optifine') return note('info', 'info', t('welcome.noteOptifine'));
  if (kind === 'forge') return note('info', 'info', t('welcome.noteForge'));
  return null;
}

function comboDetails(ctx) {
  const tg = instanceTarget();
  const fields = [nameField(ctx)];
  if (tg?.mcVersion && tg.kind !== 'vanilla') {
    fields.push(
      loaderVersionField(
        tg,
        (v) => {
          S.comboLv[`${S.combo}|${tg.mcVersion}`] = v;
        },
        ctx,
      ),
    );
  }
  const notes = [];
  if (S.combo === 'perf') notes.push(note('info', 'zap', t('welcome.notePerf')));
  const kn = tg?.kind ? kindNote(tg.kind) : null;
  if (kn) notes.push(kn);
  return h('div', { class: 'wl-details' }, h('div', { class: 'wl-fields' }, fields), notes);
}

function customPanel(ctx) {
  const kind = S.custom.kind;
  if (kind !== 'vanilla') ensureSupport(kind);
  const loaders = radioGroup(
    h(
      'div',
      { class: 'wl-loaders', role: 'radiogroup', 'aria-label': t('welcome.customLoader') },
      KINDS.map((k) => {
        const on = k === kind;
        return h(
          'button',
          {
            type: 'button',
            class: ['wl-loader', on && 'is-on'],
            role: 'radio',
            'aria-checked': String(on),
            style: { '--c': LOADERS[k].color },
            'data-fk': `kind-${k}`,
            title: t(`welcome.loaderDesc_${k}`),
            onclick: () => {
              if (on) return;
              S.custom.kind = k;
              S.custom.loaderVersion = null;
              syncName();
              pendingFocus = `kind-${k}`;
              ctx.refresh();
            },
          },
          h('span', { class: 'wl-loader-letter', 'aria-hidden': 'true' }, LOADERS[k].letter),
          LOADERS[k].name,
        );
      }),
    ),
    '.wl-loader',
  );

  const listBox = radioGroup(h('div', { class: 'wl-versions', role: 'listbox', 'aria-label': t('welcome.customVersion'), 'data-sk': 'versions' }), '.wl-ver');
  const visible = () => {
    const q = S.custom.query;
    const all = customVersions();
    return q ? all.filter((v) => v.id.toLowerCase().includes(q)) : all;
  };
  const pickVersion = (id) => {
    S.custom.mc = id;
    S.custom.loaderVersion = null;
    syncName();
    pendingFocus = `ver-${id}`;
    ctx.refresh();
  };
  const drawList = () => {
    const sup = kind === 'vanilla' ? null : data.support[kind];
    if (!data.manifest || data.manifest.status === 'loading' || sup?.status === 'loading') {
      mount(listBox, inlineLoading(t('welcome.loadingVersions')));
      return;
    }
    if (sup?.status === 'error') {
      mount(
        listBox,
        h(
          'div',
          { class: 'wl-pad' },
          note(
            'bad',
            'alert',
            t('welcome.customSupportError', { loader: loaderName(kind) }),
            h(
              'button',
              {
                type: 'button',
                class: 'btn sm',
                onclick: () => {
                  ensureSupport(kind, true);
                  ctx.refresh();
                },
              },
              icon('refresh'),
              t('welcome.retry'),
            ),
          ),
        ),
      );
      return;
    }
    const list = visible();
    const current = customMc();
    const latest = latestRelease();
    if (!list.length) {
      mount(listBox, h('div', { class: 'wl-empty-mini' }, t('welcome.customNoMatch')));
      return;
    }
    mount(
      listBox,
      list.map((v) =>
        h(
          'button',
          { type: 'button', class: ['wl-ver', v.id === current && 'is-on'], role: 'option', 'aria-selected': String(v.id === current), 'data-fk': `ver-${v.id}`, onclick: () => pickVersion(v.id) },
          h('span', { class: 'wl-ver-id' }, v.id),
          v.type !== 'release' ? h('span', { class: 'badge' }, t(`welcome.vtype_${v.type}`)) : null,
          v.id === latest ? h('span', { class: 'badge accent' }, t('welcome.latest')) : null,
          h('span', { class: 'wl-ver-date' }, v.releaseTime ? fmtDate(v.releaseTime) : ''),
        ),
      ),
    );
    rove(listBox, '.wl-ver');
  };
  drawList();

  const search = h('input', { class: 'input', type: 'search', value: S.custom.query, placeholder: t('welcome.customSearch'), 'aria-label': t('welcome.customSearch'), 'data-fk': 'ver-search', spellcheck: 'false' });
  search.addEventListener('input', () => {
    S.custom.query = search.value.trim().toLowerCase();
    drawList();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = visible()[0];
      if (first) pickVersion(first.id);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      (listBox.querySelector('.wl-ver.is-on') || listBox.querySelector('.wl-ver'))?.focus();
    }
  });
  const toggle = (key, label) =>
    h(
      'button',
      {
        type: 'button',
        class: ['chip', S.custom[key] && 'active'],
        'aria-pressed': String(Boolean(S.custom[key])),
        'data-fk': `tog-${key}`,
        onclick: () => {
          S.custom[key] = !S.custom[key];
          syncName();
          pendingFocus = `tog-${key}`;
          ctx.refresh();
        },
      },
      S.custom[key] ? icon('check') : null,
      label,
    );

  const tg = instanceTarget();
  const side = h(
    'div',
    { class: 'wl-custom-side' },
    tg?.mcVersion
      ? h('div', { class: 'wl-picked' }, h('span', { class: 'wl-picked-letter', style: { '--c': LOADERS[kind].color } }, LOADERS[kind].letter), h('span', {}, h('span', { class: 'wl-picked-title' }, `${loaderName(kind)} ${tg.mcVersion}`), h('span', { class: 'wl-picked-sub' }, t(`welcome.loaderDesc_${kind}`))))
      : null,
    kind !== 'vanilla' && tg?.mcVersion
      ? loaderVersionField(
          tg,
          (v) => {
            S.custom.loaderVersion = v;
          },
          ctx,
        )
      : null,
    nameField(ctx),
    kindNote(kind),
  );
  return h(
    'div',
    { class: 'wl-custom' },
    h('div', { class: 'wl-label' }, t('welcome.customLoader')),
    loaders,
    h(
      'div',
      { class: 'wl-custom-grid' },
      h(
        'div',
        { class: 'wl-custom-list' },
        h('div', { class: 'wl-custom-tools' }, h('div', { class: 'input-icon wl-search' }, icon('search'), search), toggle('snapshots', t('welcome.customSnapshots')), toggle('old', t('welcome.customOld'))),
        listBox,
      ),
      side,
    ),
  );
}

function existingList(ctx) {
  const grid = radioGroup(
    h(
      'div',
      { class: 'wl-existing', role: 'radiogroup', 'aria-label': t('welcome.instExistingLabel') },
      store.instances.map((inst) => {
        const on = inst.id === S.existingId;
        return h(
          'button',
          {
            type: 'button',
            class: ['wl-exist', on && 'is-on'],
            role: 'radio',
            'aria-checked': String(on),
            'data-fk': `exist-${inst.id}`,
            onclick: () => {
              S.existingId = inst.id;
              pendingFocus = `exist-${inst.id}`;
              ctx.refresh();
            },
          },
          instanceIcon(inst, 'wl-exist-icon'),
          h('span', { class: 'wl-exist-text' }, h('span', { class: 'wl-exist-name' }, inst.name), h('span', { class: 'wl-exist-sub' }, t('welcome.instExistingSub', { version: inst.mcVersion, loader: loaderName(instanceLoaderKey(inst)) }))),
          h('span', { class: 'wl-radio', 'aria-hidden': 'true' }),
        );
      }),
    ),
    '.wl-exist',
  );
  return h('div', { class: 'wl-stack' }, h('p', { class: 'wl-hint' }, icon('info'), t('welcome.instExistingHint')), grid);
}

function versionsError(ctx) {
  const retry = h(
    'button',
    {
      type: 'button',
      class: 'btn sm',
      onclick: () => {
        S.instSkip = false;
        prefetch(true);
        ctx.refresh();
      },
    },
    icon('refresh'),
    t('welcome.retry'),
  );
  const parts = [note('bad', 'alert', t('welcome.instVersionsError', { error: data.manifest?.error?.message || '' }), retry)];
  if (!store.instances.length) {
    parts.push(
      S.instSkip
        ? note('info', 'info', t('welcome.instSkipped'))
        : h(
            'button',
            {
              type: 'button',
              class: 'btn ghost sm wl-skip-inst',
              onclick: () => {
                S.instSkip = true;
                ctx.refresh();
              },
            },
            t('welcome.instSkip'),
          ),
    );
  }
  return h('div', { class: 'wl-stack' }, parts);
}

function stepInstance(ctx) {
  const insts = store.instances;
  if (S.instMode === 'existing' && !insts.length) S.instMode = 'new';
  const parts = [];
  if (insts.length) {
    parts.push(
      segmented(
        'imode',
        [
          ['new', 'plus', t('welcome.instModeNew')],
          ['existing', 'layers', t('welcome.instModeExisting', { count: insts.length })],
        ],
        S.instMode,
        (v) => {
          S.instMode = v;
          syncName();
          pendingFocus = `imode-${v}`;
          ctx.refresh();
        },
        t('welcome.instModeLabel'),
      ),
    );
  }
  if (S.instMode === 'existing') parts.push(existingList(ctx));
  else if (data.manifest?.status === 'error') parts.push(versionsError(ctx));
  else {
    syncName();
    parts.push(comboGrid(ctx), S.combo === 'custom' ? customPanel(ctx) : comboDetails(ctx));
    parts.push(h('p', { class: 'wl-hint' }, icon('download'), t('welcome.instBackground')));
  }
  return h('div', { class: 'wl-stack' }, parts);
}

// ---------------- Paso 5: contenido extra ----------------

function packVisual(pack) {
  if (/^https:\/\//.test(pack.icon)) {
    const img = h('img', { class: 'wl-pack-img', src: pack.icon, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.replaceWith(h('span', { class: 'wl-pack-glyph' }, icon('package'))), { once: true });
    return img;
  }
  return h('span', { class: 'wl-pack-glyph' }, icon(pack.icon && /^[a-zA-Z]+$/.test(pack.icon) ? pack.icon : 'package'));
}

function packGrid(packs, ctx) {
  if (!packs.length) return emptyBox('package', t('welcome.contentNone'), t('welcome.contentNoneText'));
  return h(
    'div',
    { class: 'wl-packs' },
    packs.map((p) => {
      const on = S.packIds.has(p.id);
      return h(
        'button',
        {
          type: 'button',
          class: ['wl-pack', on && 'is-on'],
          role: 'checkbox',
          'aria-checked': String(on),
          disabled: !p.available,
          'data-fk': `pack-${p.id}`,
          onclick: () => {
            if (on) S.packIds.delete(p.id);
            else S.packIds.add(p.id);
            pendingFocus = `pack-${p.id}`;
            ctx.refresh();
          },
        },
        packVisual(p),
        h(
          'span',
          { class: 'wl-pack-main' },
          h('span', { class: 'wl-pack-title' }, p.title, p.available ? null : h('span', { class: 'badge' }, t('welcome.contentUnavailable'))),
          p.description ? h('span', { class: 'wl-pack-desc' }, p.description) : null,
          p.items.length
            ? h(
                'span',
                { class: 'wl-pack-items' },
                p.items.map((it) => h('span', { class: ['wl-mini', !it.available && 'is-off'], title: it.available ? it.title : t('welcome.contentItemUnavailable') }, it.title)),
              )
            : null,
        ),
        h('span', { class: 'wl-check', 'aria-hidden': 'true' }, on ? icon('check') : null),
      );
    }),
  );
}

function extraVisual(x) {
  if (x.iconUrl) {
    const img = h('img', { class: 'wl-pack-img', src: x.iconUrl, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.replaceWith(h('span', { class: 'wl-pack-glyph' }, icon(x.glyph))), { once: true });
    return img;
  }
  return h('span', { class: 'wl-pack-glyph' }, icon(x.glyph));
}

function extrasGrid(all, tg, ctx) {
  // Solo lo que existe para esta versión y loader (o ya viene incluido).
  const items = all.filter((x) => x.available || extraIncluded(x, tg));
  if (MOD_LOADERS[tg.loader] && !items.length) {
    return emptyBox('package', t('welcome.contentNone'), t('welcome.contentNoneText'));
  }
  if (!MOD_LOADERS[tg.loader]) {
    return emptyBox('package', t('welcome.contentNoMods', { loader: loaderName(tg.kind) }), t('welcome.contentNoModsText'), S.instMode === 'new' ? h('button', { type: 'button', class: 'btn sm', onclick: () => ctx.go(STEP_INDEX.instance) }, icon('arrowLeft'), t('welcome.contentChangeInstance')) : null);
  }
  return h(
    'div',
    { class: 'wl-packs wl-mods' },
    items.map((x) => {
      const included = extraIncluded(x, tg);
      const on = included || S.extraSlugs.has(x.slug);
      const disabled = included || !x.available;
      return h(
        'button',
        {
          type: 'button',
          class: ['wl-pack', 'wl-mod', on && 'is-on', included && 'is-included'],
          role: 'checkbox',
          'aria-checked': String(on),
          disabled,
          'data-fk': `extra-${x.slug}`,
          onclick: () => {
            if (S.extraSlugs.has(x.slug)) S.extraSlugs.delete(x.slug);
            else S.extraSlugs.add(x.slug);
            pendingFocus = `extra-${x.slug}`;
            ctx.refresh();
          },
        },
        extraVisual(x),
        h(
          'span',
          { class: 'wl-pack-main' },
          h('span', { class: 'wl-pack-title' }, x.title),
          h('span', { class: 'wl-pack-desc' }, t(`welcome.extra_${x.key}`)),
          included
            ? h('span', { class: 'badge good' }, icon('check'), t('welcome.contentIncluded'))
            : !x.available
              ? h('span', { class: 'badge' }, t('welcome.contentNotFor', { version: tg.mcVersion }))
              : null,
        ),
        h('span', { class: 'wl-check', 'aria-hidden': 'true' }, on ? icon('check') : null),
      );
    }),
  );
}

function stepContent(ctx) {
  const tg = instanceTarget();
  if (!tg?.mcVersion) {
    return emptyBox('layers', t('welcome.contentNoInstance'), t('welcome.contentNoInstanceText'), h('button', { type: 'button', class: 'btn sm', onclick: () => ctx.go(STEP_INDEX.instance) }, icon('arrowLeft'), t('welcome.contentPickInstance')));
  }
  const key = contentKey(tg);
  const entry = ensureContent(tg);
  const target = h(
    'div',
    { class: 'wl-target' },
    h('span', { class: 'wl-picked-letter', style: { '--c': LOADERS[tg.kind]?.color || 'var(--accent)' } }, LOADERS[tg.kind]?.letter || '?'),
    h('span', { class: 'wl-target-text' }, t('welcome.contentTarget', { version: tg.mcVersion, loader: loaderName(tg.kind) })),
  );
  if (entry.status === 'loading') {
    // Skeleton con la forma de las tarjetas de paquetes (se anuncia una sola vez como cargando)
    return h(
      'div',
      { class: 'wl-stack' },
      target,
      h(
        'div',
        { class: 'skeleton-group', role: 'status', 'aria-busy': 'true' },
        h('span', { class: 'sr-only' }, t('welcome.loadingContent')),
        h('div', { class: 'wl-packs', 'aria-hidden': 'true' }, Array.from({ length: 6 }, () => h('div', { class: 'wl-skel' }, h('span', { class: 'skeleton skeleton-icon' }), h('span', { class: 'skeleton-lines' }, h('span', { class: 'skeleton skeleton-line' }), h('span', { class: 'skeleton skeleton-line' }))))),
      ),
    );
  }
  if (entry.status === 'error') {
    return h(
      'div',
      { class: 'wl-stack' },
      target,
      note(
        'bad',
        'alert',
        t('welcome.contentError'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn sm',
            onclick: () => {
              ensureContent(tg, true);
              ctx.refresh();
            },
          },
          icon('refresh'),
          t('welcome.retry'),
        ),
      ),
      h('p', { class: 'wl-hint' }, icon('info'), t('welcome.contentLater')),
    );
  }
  applyPreselection(key, entry.value, tg);
  const plan = contentPlan();
  const grid = entry.value.source === 'catalog' ? packGrid(entry.value.packs, ctx) : extrasGrid(entry.value.items, tg, ctx);
  return h(
    'div',
    { class: 'wl-stack' },
    target,
    grid,
    h(
      'p',
      { class: 'wl-hint' },
      icon('info'),
      plan.count ? t(plan.kind === 'packs' ? 'welcome.contentSelectedPacks' : 'welcome.contentSelectedMods', { count: plan.count }) : t('welcome.contentLater'),
    ),
  );
}

// ---------------- Paso 6: rendimiento ----------------

function sysTile(ic, label, value, title) {
  return h('div', { class: 'wl-sys-tile', title: title || null }, h('span', { class: 'wl-sys-icon' }, icon(ic)), h('span', { class: 'wl-sys-text' }, h('span', { class: 'wl-sys-label' }, label), h('span', { class: 'wl-sys-value' }, value)));
}

function stepPerformance(ctx) {
  const entry = perfEntry();
  const sys = ensureSys().value;
  const max = sliderMax();
  if (S.manualMax > max) S.manualMax = max;
  if (S.manualMax < 1024) S.manualMax = 1024;
  const rec = entry.status === 'ready' ? entry.value : null;
  const tg = instanceTarget();
  const totalMb = sys ? Math.floor(sys.totalMem / 1048576) : null;

  const strip = h(
    'div',
    { class: 'wl-sys' },
    sysTile('memory', t('welcome.sysRam'), sys ? fmtBytes(sys.totalMem) : '…'),
    sysTile('cpu', t('welcome.sysCpu'), sys ? t('welcome.sysCores', { count: sys.cpuCores }) : '…', sys?.cpuModel),
    sysTile('monitor', t('welcome.sysGpu'), sys?.gpu || '…', sys?.gpu),
  );

  const autoOn = S.memoryMode === 'auto';
  const autoBody = rec
    ? h(
        'div',
        { class: 'wl-mem' },
        h('span', { class: 'wl-mem-value' }, fmtMb(rec.memory.max)),
        h('span', { class: 'wl-mem-why' }, rec.reason || t('welcome.perfWhySystem', { total: sys ? fmtBytes(sys.totalMem) : '?', ram: fmtMb(rec.memory.max) })),
      )
    : // mientras se calcula: la forma del valor y su explicacion, dentro del mismo margen de la tarjeta
      h('div', { class: 'wl-mem wl-mem-loading' }, skeleton('title', { width: 96, label: t('welcome.perfCalculating') }), h('span', { class: 'wl-mem-why', 'aria-hidden': 'true' }, t('welcome.perfCalculating')));
  const autoCard = h(
    'div',
    { class: ['wl-choice', 'wl-mem-card', autoOn && 'is-on'] },
    h(
      'button',
      {
        type: 'button',
        class: 'wl-choice-hit',
        role: 'radio',
        'aria-checked': String(autoOn),
        'data-fk': 'mem-auto',
        onclick: () => {
          S.memoryMode = 'auto';
          pendingFocus = 'mem-auto';
          ctx.refresh();
        },
      },
      h('span', { class: 'wl-choice-head' }, h('span', { class: 'wl-choice-icon' }, icon('sparkles')), h('span', { class: 'wl-choice-title' }, t('welcome.perfAuto')), h('span', { class: 'wl-radio', 'aria-hidden': 'true' })),
    ),
    autoBody,
  );

  const value = h('span', { class: 'wl-mem-value' }, fmtMb(S.manualMax));
  const warn = h('div', { class: 'wl-mem-warn' });
  const paintWarn = () => {
    let text = '';
    if (totalMb && S.manualMax > totalMb - 2048) text = t('welcome.perfWarnHigh');
    else if (S.manualMax < 2048 && tg?.kind && tg.kind !== 'vanilla') text = t('welcome.perfWarnLowMods');
    mount(warn, text ? [icon('alert'), h('span', {}, text)] : null);
    warn.classList.toggle('hidden', !text || S.memoryMode !== 'manual');
  };
  const manualOn = S.memoryMode === 'manual';
  const range = h('input', { type: 'range', class: 'range', min: 1024, max, step: 512, value: S.manualMax, 'aria-label': t('welcome.perfManualLabel'), 'aria-valuetext': fmtMb(S.manualMax), 'data-fk': 'mem-range' });
  const manualCard = h('div', { class: ['wl-choice', 'wl-mem-card', manualOn && 'is-on'] });
  const manualHit = h(
    'button',
    {
      type: 'button',
      class: 'wl-choice-hit',
      role: 'radio',
      'aria-checked': String(manualOn),
      'data-fk': 'mem-manual',
      onclick: () => {
        S.memoryMode = 'manual';
        pendingFocus = 'mem-manual';
        ctx.refresh();
      },
    },
    h('span', { class: 'wl-choice-head' }, h('span', { class: 'wl-choice-icon' }, icon('sliders')), h('span', { class: 'wl-choice-title' }, t('welcome.perfManual')), h('span', { class: 'wl-radio', 'aria-hidden': 'true' })),
  );
  range.addEventListener('input', () => {
    S.manualMax = Number(range.value);
    value.textContent = fmtMb(S.manualMax);
    range.setAttribute('aria-valuetext', fmtMb(S.manualMax));
    if (S.memoryMode !== 'manual') {
      S.memoryMode = 'manual';
      manualCard.classList.add('is-on');
      autoCard.classList.remove('is-on');
      manualHit.setAttribute('aria-checked', 'true');
      autoCard.querySelector('.wl-choice-hit')?.setAttribute('aria-checked', 'false');
    }
    paintWarn();
    ctx.chrome();
  });
  mount(
    manualCard,
    manualHit,
    h(
      'div',
      { class: 'wl-mem' },
      value,
      h('div', { class: 'wl-range' }, range, h('div', { class: 'ram-marks' }, h('span', {}, fmtMb(1024)), h('span', {}, fmtMb(Math.round(max / 2 / 512) * 512)), h('span', {}, fmtMb(max)))),
      warn,
    ),
  );
  paintWarn();
  const cards = radioGroup(h('div', { class: 'wl-mem-cards', role: 'radiogroup', 'aria-label': t('welcome.perfModeLabel') }, autoCard, manualCard), '.wl-choice-hit');

  // Cambiar el modo de PC de pocos recursos recalcula la memoria recomendada.
  const lowSwitch = switchEl(
    effectiveLowEnd(),
    (v) => {
      S.lowEnd = v;
      pendingFocus = 'low-end';
      ctx.refresh();
    },
    t('welcome.lowEnd'),
  );
  lowSwitch.querySelector('input').dataset.fk = 'low-end';
  const low = h(
    'div',
    { class: 'card wl-toggles' },
    h(
      'div',
      { class: 'toggle-row' },
      h('span', { class: 'wl-toggle-icon' }, icon('gauge')),
      h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('welcome.lowEnd')), h('div', { class: 'tr-sub' }, t('welcome.lowEndSub'))),
      lowSwitch,
    ),
  );
  return h('div', { class: 'wl-stack' }, strip, cards, low);
}

// ---------------- Paso 7: preferencias ----------------

function toggleRow(ic, title, sub, value, onChange) {
  return h(
    'div',
    { class: 'toggle-row' },
    h('span', { class: 'wl-toggle-icon' }, icon(ic)),
    h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), h('div', { class: 'tr-sub' }, sub)),
    switchEl(value, onChange, title),
  );
}

function stepPrefs(ctx) {
  const opts = [
    ['keep', 'wlWindow'],
    ['minimize', 'wlMinimize'],
    ['hide', 'eyeOff'],
  ];
  const group = radioGroup(
    h(
      'div',
      { class: 'wl-after', role: 'radiogroup', 'aria-labelledby': 'wl-after-label' },
      opts.map(([v, ic]) =>
        choiceCard({
          on: S.afterLaunch === v,
          fk: `after-${v}`,
          ic,
          title: t(`welcome.after_${v}`),
          sub: t(`welcome.after_${v}Sub`),
          onPick: () => {
            S.afterLaunch = v;
            pendingFocus = `after-${v}`;
            ctx.refresh();
          },
        }),
      ),
    ),
    '.wl-choice',
  );
  const dir = store.info?.dataDir || '';
  return h(
    'div',
    { class: 'wl-stack' },
    h('div', { class: 'wl-label', id: 'wl-after-label' }, t('welcome.afterLaunch')),
    group,
    h(
      'div',
      { class: 'card wl-toggles' },
      toggleRow('message', t('welcome.discord'), t('welcome.discordSub'), S.discord, (v) => {
        S.discord = v;
        ctx.chrome();
      }),
    ),
    h(
      'div',
      { class: 'card wl-folder' },
      h('span', { class: 'wl-toggle-icon' }, icon('folder')),
      h('div', { class: 'wl-folder-text' }, h('div', { class: 'tr-title' }, t('welcome.dataFolder')), h('div', { class: 'wl-path selectable', title: dir }, dir), h('div', { class: 'tr-sub' }, t('welcome.dataFolderSub'))),
      h(
        'button',
        {
          type: 'button',
          class: 'btn sm',
          disabled: !dir,
          onclick: () => api.app.openPath(dir).catch((err) => toast('bad', t('welcome.openFolderFailed'), err?.message || String(err))),
        },
        icon('folderOpen'),
        t('welcome.open'),
      ),
    ),
  );
}

// ---------------- Paso 8: resumen ----------------

function stepSummary(ctx) {
  const acc = store.selectedAccount();
  const tg = instanceTarget();
  const plan = contentPlan();
  const mem = chosenMemory();
  perfEntry();
  const lang = LANGUAGES.find((l) => l.code === S.language);
  const venusName = cloud.isSignedIn() ? cloud.profile?.username || cloud.user?.email || '' : null;
  const missing = ['account', 'instance'].find((id) => !stepValid(id));

  // La instancia va primero y destacada: es lo que se crea al terminar.
  let instTitle;
  let instSub;
  let instVisual;
  if (tg?.existing) {
    instTitle = tg.existing.name;
    instSub = t('welcome.sumInstanceExisting', { version: tg.mcVersion, loader: loaderName(tg.kind) });
    instVisual = instanceIcon(tg.existing, 'wl-sum-inst');
  } else if (tg?.mcVersion) {
    instTitle = S.instName.trim();
    instSub = t('welcome.sumInstanceNew', { version: tg.mcVersion, loader: loaderName(tg.kind) });
    instVisual = h('span', { class: 'wl-picked-letter wl-sum-inst', style: { '--c': LOADERS[tg.kind]?.color || 'var(--accent)' } }, LOADERS[tg.kind]?.letter || '?');
  } else {
    instTitle = t('welcome.sumInstanceLater');
    instSub = t('welcome.instSkipped');
    instVisual = h('span', { class: 'wl-sum-icon wl-sum-inst' }, icon('layers'));
  }
  const editBtn = (step, label) =>
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn sm',
        title: t('welcome.editStep', { step: label }),
        'aria-label': t('welcome.editStep', { step: label }),
        disabled: S.finishing,
        onclick: () => ctx.go(STEP_INDEX[step]),
      },
      icon('edit'),
    );
  const hero = h(
    'div',
    { class: ['wl-sum', 'wl-sum-hero', missing === 'instance' && 'is-bad'] },
    instVisual,
    h('span', { class: 'wl-sum-text' }, h('span', { class: 'wl-sum-label' }, t('welcome.sumInstance')), h('span', { class: 'wl-sum-value', title: instTitle }, instTitle), h('span', { class: 'wl-sum-extra' }, instSub)),
    editBtn('instance', t('welcome.sumInstance')),
  );
  const rows = [
    ['language', 'languages', t('welcome.sumLanguage'), lang ? (lang.name === lang.english ? lang.name : `${lang.name} · ${lang.english}`) : S.language],
    ['appearance', 'palette', t('welcome.step_appearance'), appearanceSummary()],
    ['account', 'user', t('welcome.sumAccount'), acc ? t(acc.type === 'msa' ? 'welcome.sumAccountMsa' : 'welcome.sumAccountOffline', { name: acc.name }) : t('welcome.sumMissing')],
    ['venus', 'cloud', t('welcome.sumVenus'), venusName || t('welcome.sumVenusNone')],
    ['content', 'package', t('welcome.sumContent'), plan.count ? t(plan.kind === 'packs' ? 'welcome.sumPacks' : 'welcome.sumMods', { count: plan.count }) : t('welcome.sumContentNone')],
    [
      'performance',
      'memory',
      t('welcome.sumMemory'),
      mem ? t(S.memoryMode === 'manual' ? 'welcome.sumMemManual' : 'welcome.sumMemAuto', { ram: fmtMb(mem.max) }) : t('welcome.perfCalculating'),
      effectiveLowEnd() ? t('welcome.sumLowEnd') : null,
    ],
    ['prefs', 'rocket', t('welcome.sumAfter'), t(`welcome.after_${S.afterLaunch}`)],
    ['prefs', 'message', t('welcome.sumDiscord'), S.discord ? t('welcome.on') : t('welcome.off')],
  ];
  return h(
    'div',
    { class: 'wl-stack' },
    S.finishMsg ? h('div', { 'data-reveal': '1' }, note('bad', 'alert', t('welcome.finishError', { error: S.finishMsg }))) : null,
    missing
      ? note('warn', 'alert', t(`welcome.missing_${missing}`), h('button', { type: 'button', class: 'btn sm', onclick: () => ctx.go(STEP_INDEX[missing]) }, t('welcome.fix'), icon('arrowRight')))
      : null,
    hero,
    h(
      'div',
      { class: 'wl-summary' },
      rows.map(([step, ic, label, value, extra]) =>
        h(
          'div',
          { class: ['wl-sum', step === missing && 'is-bad'] },
          h('span', { class: 'wl-sum-icon' }, icon(ic)),
          h('span', { class: 'wl-sum-text' }, h('span', { class: 'wl-sum-label' }, label), h('span', { class: 'wl-sum-value', title: value }, value), extra ? h('span', { class: 'wl-sum-extra' }, extra) : null),
          editBtn(step, label),
        ),
      ),
    ),
    h('p', { class: 'wl-hint' }, icon('download'), tg?.existing || !tg?.mcVersion ? t('welcome.sumNoteExisting') : t('welcome.sumNote')),
  );
}

const STEP_RENDER = {
  language: stepLanguage,
  appearance: stepAppearance,
  account: stepAccount,
  venus: stepVenus,
  instance: stepInstance,
  content: stepContent,
  performance: stepPerformance,
  prefs: stepPrefs,
  summary: stepSummary,
};

// ---------------- Vista (riel de pasos, encabezado, cuerpo y pie) ----------------

function createView(root) {
  let alive = true;
  let raf = 0;
  let chromeRaf = 0;
  let stepContent = null;
  const offs = [];

  const progressBar = h('i');
  const progressText = h('span');
  const stepsList = h('ol', { class: 'wl-steps' });
  const rail = h(
    'nav',
    { class: 'wl-rail', 'aria-label': t('welcome.stepsLabel') },
    h(
      'div',
      { class: 'wl-brand' },
      h('img', { class: 'wl-brand-planet', src: 'assets/logo-256.png', alt: '' }),
      h('div', { class: 'wl-brand-text' }, h('div', { class: 'wl-brand-name' }, 'VENUS'), h('div', { class: 'wl-brand-sub' }, t('welcome.brandSub'))),
    ),
    stepsList,
    h('div', { class: 'wl-rail-foot' }, discordButton({ className: 'btn ghost wl-discord', label: 'Discord' }), h('div', { class: 'wl-progress-label' }, progressText), h('div', { class: 'wl-progress', 'aria-hidden': 'true' }, progressBar)),
  );
  const head = h('header', { class: 'wl-head' });
  const body = h('div', { class: 'wl-body' });
  const foot = h('footer', { class: 'wl-foot' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const panel = h('section', { class: 'wl-panel', 'aria-labelledby': 'wl-title' }, h('img', { class: 'wl-planet', src: 'assets/logo-256.png', alt: '', 'aria-hidden': 'true' }), head, body, foot);
  mount(root, h('div', { class: 'wl' }, rail, panel, live));

  const ctx = {
    alive: () => alive,
    refresh: () => draw(false),
    chrome: () => drawChrome(),
    go,
  };

  function drawRail() {
    const pct = (S.step / (STEPS.length - 1)) * 100;
    progressBar.style.width = `${pct}%`;
    progressText.textContent = t('welcome.progress', { n: S.step + 1, total: STEPS.length });
    mount(
      stepsList,
      STEPS.map((st, i) => {
        const valid = stepValid(st.id);
        const state = i === S.step ? 'current' : i <= S.visited ? (valid ? 'done' : 'warn') : 'todo';
        const reachable = i === S.step || i < S.step || canReach(i);
        const need = stepNeed(st.id);
        const sub = state === 'done' || (state === 'current' && i < S.visited) ? railSummary(st.id) : state === 'warn' ? t('welcome.railPending') : need ? t(`welcome.need_${need}`) : null;
        const label = t(`welcome.step_${st.id}`);
        return h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: ['wl-step', `is-${state}`],
              disabled: !reachable || busy(),
              'aria-current': i === S.step ? 'step' : null,
              title: label,
              onclick: () => go(i),
            },
            h('span', { class: 'wl-step-dot', 'aria-hidden': 'true' }, state === 'done' ? icon('check') : state === 'warn' ? icon('alert') : icon(st.icon)),
            h('span', { class: 'wl-step-text' }, h('span', { class: 'wl-step-label' }, label), sub ? h('span', { class: 'wl-step-sub' }, sub) : null),
          ),
        );
      }),
    );
  }

  function drawHead(animate) {
    const id = STEPS[S.step].id;
    const [title, sub] = stepTexts(id);
    const need = stepNeed(id);
    mount(
      head,
      h(
        'div',
        { class: ['wl-head-in', animate && 'wl-anim'] },
        h(
          'div',
          { class: 'wl-kicker' },
          h('span', {}, t('welcome.kicker', { n: S.step + 1, total: STEPS.length })),
          need ? h('span', { class: ['wl-tag', `is-${need}`] }, t(`welcome.need_${need}`)) : null,
        ),
        h('h2', { class: 'wl-title', id: 'wl-title', tabindex: '-1', 'data-fk': 'title' }, title),
        sub ? h('p', { class: 'wl-sub' }, sub) : null,
      ),
    );
  }

  function drawFoot() {
    const id = STEPS[S.step].id;
    const last = S.step === STEPS.length - 1;
    const valid = stepValid(id);
    const isBusy = busy();
    const skippable = (id === 'venus' && cloud.isConfigured() && !cloud.isSignedIn()) || (id === 'content' && contentPlan().count > 0);
    const reason = !valid ? blockReason(id) : '';
    let primary;
    if (last) {
      const allOk = ['account', 'instance'].every(stepValid);
      primary = h(
        'button',
        { type: 'button', class: 'play-btn wl-start', 'data-fk': 'next', disabled: !allOk || isBusy, 'aria-busy': S.finishing ? 'true' : null, onclick: () => finish(ctx) },
        S.finishing ? h('div', { class: 'spinner' }) : icon('play'),
        S.finishing ? t('welcome.starting') : t('welcome.start'),
      );
    } else {
      primary = h(
        'button',
        { type: 'button', class: 'btn primary lg wl-next', 'data-fk': 'next', disabled: !valid || isBusy, 'aria-describedby': reason ? 'wl-reason' : null, onclick: () => next() },
        t('welcome.next'),
        icon('arrowRight'),
      );
    }
    mount(
      foot,
      h('button', { type: 'button', class: 'btn ghost wl-back', 'data-fk': 'back', disabled: S.step === 0 || isBusy, onclick: () => back() }, icon('arrowLeft'), t('welcome.back')),
      h(
        'div',
        { class: 'wl-keys', 'aria-hidden': 'true' },
        h('span', { class: 'kbd' }, 'Enter'),
        h('span', {}, last ? t('welcome.keyStart') : t('welcome.keyNext')),
        S.step > 0 ? h('span', { class: 'kbd' }, 'Esc') : null,
        S.step > 0 ? h('span', {}, t('welcome.keyBack')) : null,
      ),
      h(
        'div',
        { class: 'wl-foot-end' },
        reason ? h('span', { class: 'wl-reason', id: 'wl-reason' }, icon('info'), reason) : null,
        skippable
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn ghost',
                'data-fk': 'skip',
                disabled: isBusy,
                onclick: () => {
                  if (id === 'content') {
                    S.packIds = new Set();
                    S.extraSlugs = new Set();
                  }
                  go(S.step + 1, 1);
                },
              },
              t('welcome.skip'),
            )
          : null,
        primary,
      ),
    );
  }

  function drawChrome() {
    if (!alive) return;
    const keep = snapshotFocus();
    drawRail();
    drawFoot();
    restoreFocus(keep, false);
  }

  function snapshotFocus() {
    const a = document.activeElement;
    const out = { fk: null, sel: null, inside: false, scroll: {}, body: body.scrollTop };
    if (a && a !== document.body && root.contains(a)) {
      out.inside = true;
      out.fk = a.dataset?.fk || null;
      try {
        if (typeof a.selectionStart === 'number') out.sel = [a.selectionStart, a.selectionEnd];
      } catch {
        /* sin selección */
      }
    }
    root.querySelectorAll('[data-sk]').forEach((el) => {
      out.scroll[el.dataset.sk] = el.scrollTop;
    });
    return out;
  }

  function focusKey(fk, sel) {
    const el = fk === 'title' ? head.querySelector('#wl-title') : root.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
    if (!el || el.disabled) return false;
    el.focus({ preventScroll: true });
    if (sel) {
      try {
        el.setSelectionRange(sel[0], sel[1]);
      } catch {
        /* no es un campo de texto */
      }
    }
    if (fk !== 'title') reveal(el);
    return true;
  }

  // Desplaza solo el cuerpo del paso (nunca la página) para que el elemento quede a la vista.
  function reveal(el) {
    if (!el || !body.contains(el)) return;
    const b = body.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.bottom > b.bottom - 8) body.scrollTop += Math.min(r.bottom - b.bottom + 16, r.top - b.top - 8);
    else if (r.top < b.top + 8) body.scrollTop -= b.top - r.top + 16;
  }

  function restoreFocus(keep, stepChanged) {
    if (keep && !stepChanged) {
      body.scrollTop = keep.body;
      root.querySelectorAll('[data-sk]').forEach((el) => {
        if (keep.scroll[el.dataset.sk] !== undefined) el.scrollTop = keep.scroll[el.dataset.sk];
      });
    }
    const wanted = pendingFocus;
    pendingFocus = null;
    if (wanted && focusKey(wanted, null)) return;
    if (keep?.fk && !stepChanged && focusKey(keep.fk, keep.sel)) return;
    // Si el elemento con foco desapareció al redibujar, el foco vuelve al título del paso (no se pierde en el body).
    if (stepChanged || (keep?.inside && !root.contains(document.activeElement))) focusKey('title', null);
  }

  function draw(stepChanged) {
    if (!alive || !S) return;
    const keep = stepChanged ? null : snapshotFocus();
    const prevMsg = stepChanged ? null : body.querySelector('[data-reveal]')?.textContent || '';
    const id = STEPS[S.step].id;
    syncName();
    drawRail();
    drawHead(stepChanged);
    stepContent?.destroy?.();
    stepContent = null;
    let content;
    try {
      content = STEP_RENDER[id](ctx);
    } catch (err) {
      console.error('[welcome]', err);
      content = note('bad', 'alert', t('welcome.stepError', { error: err?.message || String(err) }));
    }
    stepContent = content;
    const anim = stepChanged ? (S.dir > 0 ? 'wl-in-next' : S.dir < 0 ? 'wl-in-prev' : 'wl-in-fade') : null;
    mount(body, h('div', { class: ['wl-stage', anim] }, content));
    drawFoot();
    if (stepChanged) {
      body.scrollTop = 0;
      live.textContent = t('welcome.liveStep', { n: S.step + 1, total: STEPS.length, title: stepTexts(id)[0] });
    }
    restoreFocus(keep, stepChanged);
    // Un mensaje nuevo (cuenta agregada, error de inicio de sesión...) se muestra aunque quede abajo.
    if (!stepChanged) {
      const msgEl = body.querySelector('[data-reveal]');
      if (msgEl && msgEl.textContent !== prevMsg) reveal(msgEl);
    }
  }

  function refreshSoon() {
    if (!alive || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      draw(false);
    });
  }

  function chromeSoon() {
    if (!alive || chromeRaf) return;
    chromeRaf = requestAnimationFrame(() => {
      chromeRaf = 0;
      drawChrome();
    });
  }

  function leaveStep(id) {
    if (id === 'language') saveLanguage();
    if (id === 'venus') venusPass = '';
    if (S) S.fieldErr = null;
  }

  let lastNav = 0;
  function go(i, dir) {
    if (!alive || !S || busy() || i === S.step || i < 0 || i >= STEPS.length) return;
    if (i > S.step && !canReach(i)) return;
    leaveStep(STEPS[S.step].id);
    S.dir = dir ?? (i > S.step ? 1 : -1);
    S.step = i;
    S.visited = Math.max(S.visited, i);
    lastNav = performance.now();
    draw(true);
  }

  // Un doble clic en Siguiente/Atrás no tiene que saltear un paso sin que se vea.
  const tooSoon = () => performance.now() - lastNav < 350;

  async function next() {
    if (!S || busy() || tooSoon()) return;
    const id = STEPS[S.step].id;
    if (!stepValid(id)) {
      foot.querySelector('.wl-reason')?.classList.remove('wl-shake');
      void foot.offsetWidth;
      foot.querySelector('.wl-reason')?.classList.add('wl-shake');
      return;
    }
    if (id === 'summary') {
      finish(ctx);
      return;
    }
    if (id === 'language') await saveLanguage();
    go(S.step + 1, 1);
  }

  function back() {
    if (!S || busy() || S.step === 0 || tooSoon()) return;
    go(S.step - 1, -1);
  }

  const onKey = (e) => {
    if (!alive || !S || e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    if (document.querySelector('.modal-backdrop')) return;
    const el = e.target instanceof Element ? e.target : null;
    if (el && el !== document.body && !root.contains(el)) return;
    if (e.key === 'Escape') {
      if (el?.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, select')) {
        e.preventDefault();
        el.blur();
        focusKey('title', null);
        return;
      }
      if (S.step > 0 && !busy()) {
        e.preventDefault();
        back();
      }
      return;
    }
    if (e.key === 'Enter' && !e.repeat && !e.shiftKey) {
      if (el?.closest('form, button, a, select, textarea, [role="button"], [role="radio"], [role="checkbox"], [role="option"], [contenteditable="true"]')) return;
      e.preventDefault();
      next();
    }
  };
  document.addEventListener('keydown', onKey);

  offs.push(
    store.on('accounts', () => refreshSoon()),
    store.on('instances', () => {
      if (!S) return;
      if (S.instMode === 'existing' && !store.instances.some((i) => i.id === S.existingId)) S.existingId = store.instances[0]?.id || null;
      refreshSoon();
    }),
    cloud.on('auth', () => refreshSoon()),
    cloud.on('profile', () => refreshSoon()),
    cloud.on('config', () => refreshSoon()),
  );

  return {
    ctx,
    draw,
    refreshSoon,
    chromeSoon,
    destroy() {
      alive = false;
      stepContent?.destroy?.();
      stepContent = null;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(chromeRaf);
      document.removeEventListener('keydown', onKey);
      offs.forEach((off) => {
        try {
          off();
        } catch {
          /* ya desuscripto */
        }
      });
    },
  };
}

// Espera a que cargue la hoja de estilos de la página (evita ver el asistente sin estilos un instante).
function cssReady() {
  const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => l.getAttribute('href') === 'styles/pages/welcome.css');
  if (!link || link.sheet) return Promise.resolve();
  return new Promise((resolve) => {
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
    setTimeout(resolve, 1500);
  });
}

export default {
  ns: ['welcome', 'appearance'],
  css: ['pages/welcome'],
  async render(root) {
    if (!S) S = freshState();
    prefetch();
    await cssReady();
    // Si mientras tanto app.js dibujó otra vez la ruta (cambio de hash o de idioma), esta vista ya no hace falta.
    if (!root.isConnected) return null;
    if (view) view.destroy();
    const v = createView(root);
    view = v;
    S.dir = 0; // al volver a dibujar (cambio de idioma) el paso aparece con un fundido, sin deslizarse
    v.draw(true);
    return () => {
      v.destroy();
      if (view === v) view = null;
    };
  },
};
