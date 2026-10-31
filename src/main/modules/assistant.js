'use strict';
// Asistente de IA del launcher: agente con herramientas sobre el launcher (diagnostico de crashes, mods,
// modpacks, rendimiento, instancias, resource packs y shaders), con niveles de permiso por herramienta
// (lectura / reversible con "Deshacer" / destructiva con confirmacion) y conversaciones guardadas.
// La logica vive en ./assistant/*; la conexion con Claude la pone modules/ai.js (backend del launcher, segun el plan).
//
// Canales:
//   assistant:send(conversationId|null, texto, { instanceId, model, effort })
//     -> { conversationId, turnId, model, effort }  (corre en segundo plano; model 'haiku'|'sonnet'|'opus' o null =
//        el primero del plan; effort 'low'|'medium'|'high'. Sin model/effort: lo ultimo de la conversacion o
//        la ultima eleccion global, settings.ai.assistantModel / assistantEffort)
//   assistant:confirm(requestId, aprobado) · assistant:cancel(conversationId) · assistant:undo(undoId)
//   assistant:conversations() · assistant:conversation(id) · assistant:deleteConversation(id)
//   assistant:status({ refresh }?) -> ai.status() + modelos permitidos (modelOptions), eleccion (selection),
//     presupuesto (budget), renovaciones (resets), needsPlan y catalogo de planes (plans: del backend o plans.json)
//   assistant:confirm(requestId, aprobado, { always }?) -> always: "Permitir siempre" (herramientas MCP)
// Servidores MCP del asistente (./assistant/mcp-servers.js; solo con plan Go o superior, err.code 'plan'):
//   assistant:mcpServers({ refresh }?) -> { plan, servers, limits, claudeDesktop: { found } }
//   assistant:mcpSave(servidor) -> { server, servers } · assistant:mcpRemove(id) · assistant:mcpSetEnabled(id, bool)
//   assistant:mcpTest(id) -> { ok, tools, info, ms } o { ok: false, error, code } · assistant:mcpTools(id, { refresh }?)
//   assistant:mcpAllowAlways(id, herramienta, bool) · assistant:mcpImportPreview() · assistant:mcpImport(nombres)
// Evento: assistant:event (conversationId, { type: 'turn-start'|'thinking'|'text'|'tool-start'|'tool-result'|
//   'confirm'|'undo'|'done'|'error'|'quota'|'notice', seq, ... }). 'text' y 'done' traen failover: true si respondio
//   el proveedor de respaldo (served_by.failover del backend). Las herramientas MCP traen mcp: { server, tool }.
const settings = require('../core/settings');
const tasks = require('../core/tasks');
const game = require('../core/game');
const instances = require('../core/instances');
const servers = require('../core/servers');
const { t } = require('../core/i18n');
const agent = require('./assistant/agent');
const tools = require('./assistant/tools');
const sources = require('./assistant/sources');
const system = require('./assistant/system');
const undo = require('./assistant/undo');
const config = require('./assistant/config');
const models = require('./assistant/models');
const mcpServers = require('./assistant/mcp-servers');
const engines = require('./assistant/engines');

// Modulos hermanos que se usan si existen (los construyen otros equipos): nunca son obligatorios.
// 'mcp' da el control de plan de los servidores MCP del asistente (el mismo de Venus como servidor MCP).
const OPTIONAL = new Set(['compat', 'crash', 'perf', 'snapshots', 'curseforge', 'mcp']);
const optionalCache = new Map();
function optional(name) {
  if (!OPTIONAL.has(name)) return null;
  if (optionalCache.has(name)) return optionalCache.get(name);
  let mod = null;
  try {
    mod = require(`./${name}`);
  } catch (err) {
    if (err?.code !== 'MODULE_NOT_FOUND') console.warn(`[assistant] No se pudo cargar ./${name}:`, err.message);
    mod = null;
  }
  // Si todavia no existe se vuelve a probar mas tarde (puede aparecer en una actualizacion)
  if (mod) optionalCache.set(name, mod);
  return mod;
}

let aiImpl = null;
let fakeMode = false;

// meta (opcional): metadatos de la tarea, por ejemplo { serverId } para los servidores locales.
function runTask(title, fn, instanceId, signal, meta) {
  return tasks.run(
    title,
    async (task) => {
      const onAbort = () => task.cancel();
      if (signal?.aborted) task.cancel();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await fn(task);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
    meta && typeof meta === 'object' ? meta : instanceId ? { instanceId } : undefined,
  );
}

// Cancela las tareas en curso de una instancia (o de un servidor, con key 'serverId') y espera (hasta 10 s) a que terminen.
async function cancelInstanceTasks(instanceId, key = 'instanceId') {
  const running = () => tasks.list().filter((x) => x.meta?.[key] === instanceId && x.state === 'running');
  for (const x of running()) tasks.cancel(x.id);
  const started = Date.now();
  while (running().length && Date.now() - started < 10000) await new Promise((r) => setTimeout(r, 150));
}

// Motores del asistente para la interfaz: el elegido (settings.ai.engine), si el plan los incluye (Go o superior,
// el mismo control que el MCP) y que se detecto de Claude Code y de Codex (instalado, con sesion, plan). La
// deteccion corre aparte y avisa con el evento assistant:engines cuando cambia (ver engines.js).
async function enginesView(det, { planWait = 1500 } = {}) {
  const s = await settings.get();
  let plan = { entitled: false, reason: 'error', checking: false };
  try {
    const m = optional('mcp');
    if (typeof m?.planState === 'function') plan = await m.planState({ wait: planWait });
  } catch {
    plan = { entitled: false, reason: 'error', checking: false };
  }
  const one = (id) => {
    const e = det?.[id] || null;
    return {
      app: engines.APP_NAME[id],
      provider: engines.PROVIDER_NAME[id],
      installed: Boolean(e?.installed),
      loggedIn: e ? e.loggedIn : null,
      method: e?.method || null,
      plan: e?.plan || null,
      error: e?.error || null,
      usable: engines.usable(det, id),
    };
  };
  const current = engines.ENGINES.includes(s.ai?.engine) ? s.ai.engine : 'venus';
  return {
    current,
    entitled: plan.entitled === true,
    planReason: plan.reason || null,
    checking: !det,
    at: det?.at || null,
    claude: one('claude'),
    chatgpt: one('chatgpt'),
    models: engines.MODELS,
    efforts: engines.EFFORTS,
    choice: s.ai?.engineChoice && typeof s.ai.engineChoice === 'object' ? s.ai.engineChoice : {},
  };
}

async function enginesStatus(opts = {}) {
  if (opts.refresh === true || engines.stale()) engines.detect({ refresh: opts.refresh === true }).catch(() => {});
  return enginesView(engines.cached(), { planWait: opts.refresh === true ? 8000 : 1500 });
}

async function status(opts = {}) {
  let base;
  try {
    base = await aiImpl.status(opts || {});
  } catch {
    base = { provider: null, enabled: true, signedIn: false, cloudConfigured: false, configured: false, model: null, quota: null, plans: null };
  }
  const s = await settings.get();
  const lang = require('../core/i18n').getLanguage();
  const quota = base.quota && typeof base.quota === 'object' ? base.quota : null;
  const local = config.plans(lang);
  const remote = Array.isArray(base.plans) && base.plans.length ? base.plans : null;
  const options = models.modelOptions(base);
  const budget = models.budgetOf(quota);
  return {
    ...base,
    fake: fakeMode,
    tools: Object.keys(tools.REGISTRY).map((name) => ({ name, level: config.effectiveLevel(name, tools.REGISTRY[name].minLevel) })),
    // Catalogo de planes: el del backend o, sin el, el de respaldo (plans.json)
    plans: remote || local.plans,
    plansSource: remote ? 'backend' : 'local',
    plansPlaceholder: remote ? false : local.placeholder,
    // Sin suscripcion no hay IA: la interfaz muestra los planes ("Mejorar plan")
    needsPlan: Boolean(base.provider) && Boolean(quota) && (quota.status === 'none' || !quota.plan),
    modelOptions: options,
    // Eleccion por defecto del selector (sin eleccion previa: el primer modelo del plan, que es el que usa el
    // backend si no se manda model)
    selection: models.fitChoice({ model: s.ai?.assistantModel || null, effort: s.ai?.assistantEffort }, options),
    budget: budget ? { usedUsd: budget.usedUsd, limitUsd: budget.limitUsd, remainingUsd: budget.remainingUsd } : null,
    resets: quota?.resets && typeof quota.resets === 'object' ? quota.resets : null,
    jvmFlags: config.jvmFlags().map((f) => ({ id: f.id, label: f.label?.[lang] || f.label?.en || f.id })),
    limits: { maxRounds: agent.MAX_ROUNDS, bulkInstall: agent.BULK_LIMIT },
    running: agent.runningIds(),
    // Motores externos: el Claude Code o el Codex del usuario responden desde Venus (plan Go o superior)
    engines: await enginesStatus(opts || {}),
  };
}

function register({ app, handle, send, onQuit }) {
  // Modo falso SOLO para pruebas y capturas de desarrollo: nunca en la app empaquetada.
  // VENUS_ASSISTANT_FAKE=noplan simula una cuenta sin plan (para ver la invitacion a elegir uno).
  const fakeEnv = process.env.VENUS_ASSISTANT_FAKE;
  fakeMode = (fakeEnv === '1' || fakeEnv === 'noplan') && !(app?.isPackaged && !process.env.VENUS_DEVSHOT);
  if (fakeMode) {
    aiImpl = require('./assistant/fake-ai').createDemoAi({ plan: fakeEnv === 'noplan' ? 'none' : 'max' });
    console.warn('[assistant] Modo de demostracion (VENUS_ASSISTANT_FAKE=1): la IA es falsa.');
  } else {
    aiImpl = require('./ai');
  }

  let shell = null;
  try {
    shell = require('electron').shell;
  } catch {
    shell = null;
  }
  const trash = shell ? (p) => shell.trashItem(p) : null;
  const isRunning = (id) => Boolean(game.status()[id]);
  const safeSend = (...args) => {
    try {
      send(...args);
    } catch {
      /* ventana cerrada */
    }
  };

  const startInstall = (id, name) => {
    if (fakeMode) return;
    tasks
      .run(t('assistant.taskInstalling', { name: name || id }), (task) => instances.prepare(id, task), { instanceId: id })
      .then(() => safeSend('instances:changed'))
      .catch((err) => {
        if (!/cancel/i.test(err?.message || '')) console.warn('[assistant] Instalacion en segundo plano:', err?.message);
        safeSend('instances:changed');
      });
  };

  // Servidores MCP del asistente: el plan sale del mismo control que Venus como servidor MCP (modules/mcp)
  let version = '0.0.0';
  try {
    version = app?.getVersion?.() || version;
  } catch {
    /* sin app */
  }
  mcpServers.configure({
    version,
    plan: async (o) => {
      const m = optional('mcp');
      return typeof m?.planState === 'function' ? m.planState(o) : { entitled: false, reason: 'error' };
    },
    // El puente de Venus en Claude Desktop no se importa (seria el launcher hablandose a si mismo)
    isOwnBridge: (entry) => {
      const args = Array.isArray(entry?.args) ? entry.args.map(String) : [];
      return args.some((a) => /venus-mcp-bridge\.js$/i.test(a)) || (entry?.command === process.execPath && entry?.env?.ELECTRON_RUN_AS_NODE === '1');
    },
  });

  agent.configure({ ai: aiImpl, send: safeSend, optional, mcp: mcpServers, engines });
  engines.configure({
    onChange: (det) =>
      enginesView(det)
        .then((v) => safeSend('assistant:engines', v))
        .catch(() => {}),
  });
  // Software de un servidor recien creado: se instala en segundo plano (igual que al crearlo desde Servidores)
  const installServer = (id, name) => {
    if (fakeMode) return;
    tasks
      .run(t('assistantx.taskInstallServer', { name: name || id }), (task) => servers.install(id, task), { serverId: id })
      .then(() => safeSend('servers:changed'))
      .catch((err) => {
        if (!/cancel/i.test(err?.message || '')) console.warn('[assistant] Instalacion del servidor en segundo plano:', err?.message);
        safeSend('servers:changed');
      });
  };
  tools.configure({ optional, isRunning, gameStatus: () => game.status(), startInstall, installServer, runTask, trash, send: safeSend });
  sources.configure({ optional });
  system.configure({ optional, gpu: app?.getGPUInfo ? () => app.getGPUInfo('complete') : null });
  undo.configure({
    trash,
    isRunning,
    beforeRemove: cancelInstanceTasks,
    beforeRemoveServer: (id) => cancelInstanceTasks(id, 'serverId'),
    beforeUndo: async (entry) => {
      if (entry.tool === 'change_instance_version' && entry.instanceId) await cancelInstanceTasks(entry.instanceId);
      if (entry.tool === 'create_server' && entry.serverId) await cancelInstanceTasks(entry.serverId, 'serverId');
    },
  });

  handle('assistant:send', (conversationId, text, opts) => agent.send(typeof conversationId === 'string' && conversationId ? conversationId : null, text, opts && typeof opts === 'object' ? opts : {}));
  handle('assistant:confirm', (requestId, approved, opts) => agent.confirm(String(requestId || ''), approved === true, { always: opts?.always === true }));
  handle('assistant:cancel', (conversationId) => agent.cancel(String(conversationId || '')));
  handle('assistant:undo', (undoId) => agent.undoAction(String(undoId || '')));
  handle('assistant:conversations', () => agent.conversations());
  handle('assistant:conversation', (id) => agent.conversation(String(id || '')));
  handle('assistant:deleteConversation', (id) => agent.deleteConversation(String(id || '')));
  handle('assistant:status', (opts) => status(opts && typeof opts === 'object' ? opts : {}));
  // Motores externos (docs/asistente-ia.md, seccion 11): deteccion de Claude Code y Codex, y el motor por defecto
  handle('assistant:engines', async (opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    const det = await engines.detect({ refresh: o.refresh === true });
    return enginesView(det, { planWait: 8000 });
  });
  handle('assistant:setEngine', async (engine) => {
    const id = engines.ENGINES.includes(engine) ? engine : 'venus';
    const s = await settings.get();
    if ((s.ai?.engine || 'venus') !== id) {
      await settings.set({ ai: { engine: id } });
      safeSend('assistant:settingsChanged');
    }
    return enginesView(engines.cached());
  });

  // Servidores MCP del asistente (Ajustes > IA). Solo el usuario los agrega: la IA no tiene herramientas para esto.
  const id = (v) => String(v || '');
  handle('assistant:mcpServers', (opts) => mcpServers.overview(opts && typeof opts === 'object' ? opts : {}));
  handle('assistant:mcpSave', (server) => mcpServers.save(server && typeof server === 'object' ? server : {}));
  handle('assistant:mcpRemove', (serverId) => mcpServers.remove(id(serverId)));
  handle('assistant:mcpSetEnabled', (serverId, on) => mcpServers.setEnabled(id(serverId), on === true));
  handle('assistant:mcpTest', (serverId) => mcpServers.test(id(serverId)));
  handle('assistant:mcpTools', (serverId, opts) => mcpServers.tools(id(serverId), opts && typeof opts === 'object' ? opts : {}));
  handle('assistant:mcpAllowAlways', (serverId, tool, on) => mcpServers.setAlwaysAllow(id(serverId), typeof tool === 'string' ? tool : '', on === true));
  handle('assistant:mcpImportPreview', () => mcpServers.importPreview());
  handle('assistant:mcpImport', (names) => mcpServers.importServers(Array.isArray(names) ? names : []));

  onQuit(() => agent.shutdown());
}

module.exports = {
  register,
  // Para otros modulos del proceso principal
  status,
  send: (...a) => agent.send(...a),
};
