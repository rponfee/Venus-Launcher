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
const aiSource = require('./smartsearch/ai-source');
const localAi = require('./smartsearch/local-ai');
const fake = require('./smartsearch/fake');
const L = require('./smartsearch/lexicon');
// Filtros extra (frase exacta, palabras excluidas, autor, descargas, fecha, codigo abierto, entorno): los mismos del catalogo.
const searchFilters = require('../core/search-filters');

const HISTORY_MAX = 20;
// La IA es opt-in y solo de pago (ver smartsearch/ai-source.js): por defecto apagada y sin aviso aceptado.
const DEFAULT_PREFS = { perType: 5, compatibleOnly: true, useAi: false, aiSource: null, aiConsent: { venus: null, local: null } };
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

// Estado de la IA del buscador: plan de la cuenta, fuentes disponibles (Venus IA o la IA local de la PC), cual esta
// elegida y si se acepto el aviso de privacidad. Si algo no se puede comprobar (sin conexion, sin sesion) la IA queda
// apagada: el buscador usa el interprete local. refresh = volver a preguntar el plan y detectar las apps locales.
async function aiView({ refresh = false } = {}) {
  // Capturas y pruebas de desarrollo (VENUS_SMARTSEARCH_AI_FAKE con VENUS_DEVSHOT): plan y apps locales simulados
  const simulated = fake.inputs();
  if (simulated) {
    const { prefs } = await prefsAndHistory();
    return aiSource.describe({ ...simulated, preferredEngine: 'claude', prefs });
  }
  let status = null;
  try {
    status = await ai().status({ refresh });
  } catch {
    status = null;
  }
  const { prefs } = await prefsAndHistory();
  const paid = aiSource.planOf(status).state === 'paid';
  let engines = null;
  let entitled = false;
  if (paid) {
    try {
      const eng = require('./smartsearch/cli');
      if (refresh || eng.stale()) await Promise.race([eng.detect({ refresh }).catch(() => {}), new Promise((r) => setTimeout(r, refresh ? 8000 : 1200))]);
      engines = eng.cached();
    } catch {
      engines = null;
    }
    // La fuente local pide plan Go o superior (cualquier plan de pago menos Basic)
    entitled = String(status?.quota?.plan || '').toLowerCase() !== 'basic';
  }
  return aiSource.describe({ status, engines, entitled, preferredEngine: 'claude', prefs });
}

// Quien responde segun la fuente elegida: la misma forma ({ json }) para Venus IA y para la IA local.
function runnerFor(view) {
  if (fake.mode()) return fake.runner();
  if (view.source !== 'local') return ai();
  const engine = view.sources.find((x) => x.id === 'local')?.engine;
  return { json: (o) => localAi.json({ ...o, engine }) };
}

async function prefsAndHistory() {
  const s = await settings.get();
  const cfg = s.smartsearch || {};
  return { prefs: { ...DEFAULT_PREFS, ...(cfg.prefs || {}) }, history: Array.isArray(cfg.history) ? cfg.history : [] };
}

async function context() {
  const [rel, view, ph] = await Promise.all([releases(), aiView(), prefsAndHistory()]);
  return { ai: view, latestRelease: rel.latest, releases: rel.list, ...ph };
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
      useAi: f.useAi === true,
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
  let runner = null;
  if (f.useAi) {
    const view = await aiView();
    if (view.active) {
      runner = runnerFor(view);
      progress('ai', { source: view.source });
      try {
        plan = await aiPlan.improve(plan, ctx, { signal, turnId, ai: runner });
        plan.aiVia = view.source;
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn('[smartsearch] IA:', err.message);
        runner = null;
        warnings.push({ key: err?.code === 'network' ? 'aiOffline' : 'aiFailed', vars: { error: String(err.message || err).slice(0, 160) } });
      }
    } else {
      const why = aiSource.whyNot(view);
      if (why) warnings.push({ key: why });
    }
  }
  return { plan, ctx, filters: f, query: q, runner };
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
function annotateLater(result, send, runner) {
  annotating?.abort(new Error('superseded'));
  const controller = new AbortController();
  annotating = controller;
  aiPlan
    .reasons(result.query, result.groups, getLanguage(), { signal: controller.signal, turnId: `ss:${result.runId}`, ai: runner || ai() })
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
    const { plan, ctx, filters: f, query: q, runner } = await makePlan(query, filters, { signal, progress, warnings, turnId: `ss:${runId}` });
    const result = await engine.run(plan, ctx, { signal, progress });
    result.runId = runId;
    result.warnings = [...warnings, ...result.warnings];
    result.aiReasons = plan.source === 'ai' && result.groups.some((g) => g.items.length) ? 'pending' : 'off';
    result.filters = f;
    progress('done', {});
    await saveHistory(q, f, result);
    if (result.aiReasons === 'pending') annotateLater(result, send, runner);
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
    // La IA (useAi, fuente y aviso aceptado) se cambia solo con smartsearch:aiSet: ahi se comprueba el plan.
    const clean = {
      perType: Math.max(1, Math.min(interpreter.MAX_PER_TYPE, Number(prefs.perType) || DEFAULT_PREFS.perType)),
      compatibleOnly: prefs.compatibleOnly !== false,
    };
    await settings.set({ smartsearch: { prefs: clean } });
    return clean;
  });
  // Estado de la IA (refresh = volver a preguntar el plan y detectar Claude Code / Codex)
  handle('smartsearch:ai', (opts) => aiView({ refresh: Boolean(opts && opts.refresh) }));
  // Prender o apagar la IA, elegir la fuente y aceptar el aviso. { useAi?, source?: 'venus' | 'local', consent?: true }
  handle('smartsearch:aiSet', async (change) => {
    const view = await aiView();
    const { prefs } = await prefsAndHistory();
    let next;
    try {
      next = aiSource.applyChange(view, prefs, change && typeof change === 'object' ? change : {});
    } catch (err) {
      throw Object.assign(new Error(t(`smartsearch.errAi_${err.code}`)), { code: err.code });
    }
    await settings.set({ smartsearch: { prefs: { useAi: next.useAi, aiSource: next.aiSource, aiConsent: next.aiConsent } } });
    return aiView();
  });
  handle('smartsearch:createInstance', (opts) => kit.createInstance(opts, { send }));
  handle('smartsearch:installKit', (opts) => kit.installKit(opts, { send }));
}

module.exports = {
  register,
  // Para otros modulos o pruebas:
  interpret: (query, ctx) => interpreter.interpret(query, ctx),
  aiView,
  _makePlan: (query, filters, opts) => makePlan(query, filters, opts),
  plan: async (query, filters) => (await makePlan(query, filters)).plan,
  run,
  cancel,
};
