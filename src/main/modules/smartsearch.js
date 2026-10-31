'use strict';
// Buscador inteligente: entiende pedidos en lenguaje natural ("mods y texturas para un
// singleplayer de zombies"), busca en Modrinth, verifica compatibilidad y arma un kit instalable.
// Funciona sin IA (interprete local) y, si hay una API key de Claude, la usa para afinar el plan
// y explicar cada resultado.
const { t, getLanguage } = require('../core/i18n');
const settings = require('../core/settings');
const { uid } = require('../core/util');
const interpreter = require('./smartsearch/interpreter');
const engine = require('./smartsearch/engine');
const aiPlan = require('./smartsearch/ai-plan');
const kit = require('./smartsearch/kit');
const L = require('./smartsearch/lexicon');
// Filtros extra (frase exacta, palabras excluidas, autor, descargas, fecha, codigo abierto, entorno): los mismos del catalogo.
const searchFilters = require('../core/search-filters');

const HISTORY_MAX = 20;
const DEFAULT_PREFS = { perType: 5, compatibleOnly: true, useAi: true };
const LOADER_FILTERS = ['auto', 'fabric', 'forge', 'neoforge', 'quilt', 'vanilla'];
const ID_RE = /^[\w.-]{1,64}$/;

let current = null; // { runId, controller }
let annotating = null; // AbortController de los motivos de la IA
let releasesCache = null; // { at, latest, list }

function ai() {
  return require('./ai');
}

// ---------- Contexto ----------

async function releases() {
  if (releasesCache && Date.now() - releasesCache.at < 10 * 60 * 1000) return releasesCache;
  try {
    const m = await require('../core/minecraft').getManifest();
    releasesCache = { at: Date.now(), latest: m.latest?.release || null, list: m.versions.filter((v) => v.type === 'release').map((v) => v.id) };
  } catch (err) {
    console.warn('[smartsearch] manifest', err.message);
    if (!releasesCache) return { at: 0, latest: null, list: [] };
  }
  return releasesCache;
}

async function aiStatus() {
  try {
    // La IA va por el backend del launcher: lista si esta activada y hay sesion de Venus (provider 'backend')
    const st = await ai().status();
    const ready = Boolean(st.provider);
    return { configured: ready, enabled: ready && st.enabled !== false };
  } catch {
    return { configured: false, enabled: false };
  }
}

async function prefsAndHistory() {
  const s = await settings.get();
  const cfg = s.smartsearch || {};
  return { prefs: { ...DEFAULT_PREFS, ...(cfg.prefs || {}) }, history: Array.isArray(cfg.history) ? cfg.history : [] };
}

async function context() {
  const [rel, st, ph] = await Promise.all([releases(), aiStatus(), prefsAndHistory()]);
  return { ai: st.enabled, aiConfigured: st.configured, latestRelease: rel.latest, releases: rel.list, ...ph };
}

async function resolveTarget(instanceId) {
  if (!instanceId || !ID_RE.test(instanceId)) return null;
  try {
    const inst = await require('../core/instances').get(instanceId);
    const projects = inst.modrinth?.projects || {};
    return {
      kind: 'instance',
      id: inst.id,
      name: inst.name,
      mcVersion: inst.mcVersion,
      loader: inst.loader,
      preset: inst.preset || null,
      installed: projects,
      hasIris: inst.preset === 'iris' || Boolean(projects[L.IRIS_ID]),
    };
  } catch {
    return null;
  }
}

async function resolveServer(serverId) {
  if (!serverId || !ID_RE.test(serverId)) return null;
  try {
    const s = await require('../core/servers').get(serverId);
    return { id: s.id, name: s.name, type: s.type, mcVersion: s.mcVersion };
  } catch {
    return null;
  }
}

function sanitize(query, filters = {}) {
  const q = String(query || '').replace(/\s+/g, ' ').trim();
  if (!q) throw new Error(t('smartsearch.errEmptyQuery'));
  if (q.length > 400) throw new Error(t('smartsearch.errTooLong'));
  const f = filters && typeof filters === 'object' ? filters : {};
  const more = searchFilters.normalize(f);
  if (more.authorInvalid) throw new Error(t('smartsearch.errBadAuthor'));
  return {
    query: q,
    filters: {
      mcVersion: typeof f.mcVersion === 'string' && /^[\w.-]{1,40}$/.test(f.mcVersion) ? f.mcVersion : 'auto',
      loader: LOADER_FILTERS.includes(f.loader) ? f.loader : 'auto',
      types: Array.isArray(f.types) ? f.types.filter((tp) => L.TYPES.includes(tp)) : [],
      perType: Math.max(1, Math.min(interpreter.MAX_PER_TYPE, Number(f.perType) || DEFAULT_PREFS.perType)),
      compatibleOnly: f.compatibleOnly !== false,
      useAi: f.useAi !== false,
      instanceId: typeof f.instanceId === 'string' && ID_RE.test(f.instanceId) ? f.instanceId : null,
      serverId: typeof f.serverId === 'string' && ID_RE.test(f.serverId) ? f.serverId : null,
      runId: typeof f.runId === 'string' && /^[\w-]{4,40}$/.test(f.runId) ? f.runId : null,
      // Filtros extra: phrase, exclude[], author, minDownloads, updatedDays, openSource y environment
      phrase: more.phrase,
      exclude: more.exclude,
      author: more.author,
      minDownloads: more.minDownloads,
      updatedDays: more.updatedDays,
      openSource: more.openSource,
      environment: more.environment,
    },
  };
}

async function buildContext(filters) {
  const [rel, target, server] = await Promise.all([releases(), resolveTarget(filters.instanceId), resolveServer(filters.serverId)]);
  return {
    filters,
    target,
    server,
    latestRelease: rel.latest,
    releases: new Set(rel.list),
    uiLang: getLanguage(),
  };
}

// ---------- Plan y busqueda ----------

async function makePlan(query, filters, { signal, progress = () => {}, warnings = [], turnId } = {}) {
  const { query: q, filters: f } = sanitize(query, filters);
  const ctx = await buildContext(f);
  progress('interpret', {});
  let plan = interpreter.plan(q, ctx);
  if (f.useAi) {
    const st = await aiStatus();
    if (st.enabled) {
      progress('ai', {});
      try {
        plan = await aiPlan.improve(plan, ctx, { signal, turnId });
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn('[smartsearch] IA:', err.message);
        warnings.push({ key: 'aiFailed', vars: { error: err.message } });
      }
    }
  }
  return { plan, ctx, filters: f, query: q };
}

async function saveHistory(query, filters, result) {
  try {
    const { history } = await prefsAndHistory();
    const counts = {};
    for (const g of result.groups) counts[g.type] = g.items.filter((i) => !i.helper).length;
    const entry = {
      id: uid(8),
      query,
      at: Date.now(),
      mcVersion: result.plan.mcVersion,
      loader: result.plan.resolvedLoader || result.plan.loader || null,
      types: result.plan.types,
      counts,
      ai: result.plan.source === 'ai',
      filters: { mcVersion: filters.mcVersion, loader: filters.loader, types: filters.types, instanceId: filters.instanceId },
    };
    const norm = (s) => interpreter.normalize(s);
    const next = [entry, ...history.filter((h) => norm(h.query) !== norm(query))].slice(0, HISTORY_MAX);
    await settings.set({ smartsearch: { history: next } });
  } catch (err) {
    console.warn('[smartsearch] historial', err.message);
  }
}

// Motivos de la IA en segundo plano: llegan despues como 'smartsearch:reasons'.
function annotateLater(result, send) {
  annotating?.abort(new Error('superseded'));
  const controller = new AbortController();
  annotating = controller;
  aiPlan
    .reasons(result.query, result.groups, getLanguage(), { signal: controller.signal, turnId: `ss:${result.runId}` })
    .then((items) => send?.('smartsearch:reasons', { runId: result.runId, items }))
    .catch((err) => {
      if (controller.signal.aborted) return;
      console.warn('[smartsearch] motivos IA:', err.message);
      send?.('smartsearch:reasons', { runId: result.runId, items: {}, error: err.message });
    })
    .finally(() => {
      if (annotating === controller) annotating = null;
    });
}

async function run(query, filters, { send, onProgress } = {}) {
  const runId = (filters && typeof filters.runId === 'string' && /^[\w-]{4,40}$/.test(filters.runId) && filters.runId) || uid(12);
  current?.controller.abort(new Error(t('smartsearch.errCanceled')));
  annotating?.abort(new Error('superseded'));
  const controller = new AbortController();
  current = { runId, controller };
  const signal = controller.signal;
  const progress = (stage, data = {}) => {
    const payload = { runId, stage, ...data };
    send?.('smartsearch:progress', payload);
    onProgress?.(payload);
  };
  try {
    const warnings = [];
    const { plan, ctx, filters: f, query: q } = await makePlan(query, filters, { signal, progress, warnings, turnId: `ss:${runId}` });
    const result = await engine.run(plan, ctx, { signal, progress });
    result.runId = runId;
    result.warnings = [...warnings, ...result.warnings];
    result.aiReasons = plan.source === 'ai' && result.groups.some((g) => g.items.length) ? 'pending' : 'off';
    result.filters = f;
    progress('done', {});
    await saveHistory(q, f, result);
    if (result.aiReasons === 'pending') annotateLater(result, send);
    return result;
  } catch (err) {
    if (signal.aborted) throw new Error(t('smartsearch.errCanceled'));
    throw err;
  } finally {
    if (current?.runId === runId) current = null;
  }
}

function cancel(runId) {
  if (current && (!runId || current.runId === runId)) {
    current.controller.abort(new Error(t('smartsearch.errCanceled')));
    return true;
  }
  return false;
}

// ---------- Registro ----------

function register({ handle, send, onQuit }) {
  onQuit?.(() => {
    current?.controller.abort(new Error(t('smartsearch.errCanceled')));
    annotating?.abort(new Error('quit'));
  });
  handle('smartsearch:context', () => context());
  handle('smartsearch:plan', async (query, filters) => (await makePlan(query, filters)).plan);
  handle('smartsearch:run', (query, filters) => run(query, filters, { send }));
  handle('smartsearch:cancel', (runId) => cancel(runId));
  handle('smartsearch:history', async () => (await prefsAndHistory()).history);
  handle('smartsearch:removeHistory', async (id) => {
    const { history } = await prefsAndHistory();
    const next = history.filter((h) => h.id !== id);
    await settings.set({ smartsearch: { history: next } });
    return next;
  });
  handle('smartsearch:clearHistory', async () => {
    await settings.set({ smartsearch: { history: [] } });
    return [];
  });
  handle('smartsearch:savePrefs', async (prefs = {}) => {
    const clean = {
      perType: Math.max(1, Math.min(interpreter.MAX_PER_TYPE, Number(prefs.perType) || DEFAULT_PREFS.perType)),
      compatibleOnly: prefs.compatibleOnly !== false,
      useAi: prefs.useAi !== false,
    };
    await settings.set({ smartsearch: { prefs: clean } });
    return clean;
  });
  handle('smartsearch:createInstance', (opts) => kit.createInstance(opts, { send }));
  handle('smartsearch:installKit', (opts) => kit.installKit(opts, { send }));
}

module.exports = {
  register,
  // Para otros modulos o pruebas:
  interpret: (query, ctx) => interpreter.interpret(query, ctx),
  plan: async (query, filters) => (await makePlan(query, filters)).plan,
  run,
  cancel,
};
