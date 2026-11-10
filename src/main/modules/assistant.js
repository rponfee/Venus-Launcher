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
//     presupuesto (budget), saldos de Claude y ChatGPT (wallets, con el que esta en uso), renovaciones (resets),
//     needsPlan y catalogo de planes (plans: del backend o plans.json)
//   assistant:useWallet('anthropic'|'openai') -> elige que saldo usar (RPC ai_use_wallet); devuelve assistant:status
// Evento: assistant:event (conversationId, { type: 'turn-start'|'thinking'|'text'|'tool-start'|'tool-result'|
//   'confirm'|'undo'|'done'|'error'|'quota'|'notice'|'switched', seq, ... }). 'text' y 'done' traen failover: true
//   (y failoverProvider) si respondio el proveedor de respaldo (served_by.failover del backend); 'switched' ({ from,
//   to, reason }) avisa que el servidor paso al otro saldo.
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

// Modulos hermanos que se usan si existen (los construyen otros equipos): nunca son obligatorios.
const OPTIONAL = new Set(['compat', 'crash', 'perf', 'snapshots', 'curseforge']);
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
  const wallets = models.walletsOf(quota);
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
    // Saldos de la cuenta (uno por familia). Con dos que tienen saldo, el usuario elige cual usar (assistant:useWallet)
    wallets,
    planFamily: quota?.plan ? models.planFamily(quota) : null,
    planTier: quota ? models.planTier(quota) : null,
    resets: quota?.resets && typeof quota.resets === 'object' ? quota.resets : null,
    jvmFlags: config.jvmFlags().map((f) => ({ id: f.id, label: f.label?.[lang] || f.label?.en || f.id })),
    limits: { maxRounds: agent.MAX_ROUNDS, bulkInstall: agent.BULK_LIMIT },
    running: agent.runningIds(),
  };
}

function register({ app, handle, send, onQuit }) {
  // Modo falso SOLO para pruebas y capturas de desarrollo: nunca en la app empaquetada.
  // VENUS_ASSISTANT_FAKE=noplan simula una cuenta sin plan (para ver la invitacion a elegir uno); =wallets, una
  // cuenta con saldo de Claude y de ChatGPT; =switch, el saldo de Claude se termina en la primera respuesta y el
  // servidor pasa al de ChatGPT (aviso switched); =<id de plan> (claude_pro, go...), ese plan solo.
  const fakeEnv = process.env.VENUS_ASSISTANT_FAKE;
  const fakePlans = config.plans('es').plans.map((p) => p.id);
  fakeMode = (fakeEnv === '1' || ['noplan', 'wallets', 'switch'].includes(fakeEnv) || fakePlans.includes(fakeEnv)) && !(app?.isPackaged && !process.env.VENUS_DEVSHOT);
  if (fakeMode) {
    const scenario = fakeEnv === 'noplan' ? { plan: 'none' } : fakeEnv === 'wallets' || fakeEnv === 'switch' ? { scenario: fakeEnv } : { plan: fakeEnv === '1' ? 'claude_ultra' : fakeEnv };
    aiImpl = require('./assistant/fake-ai').createDemoAi(scenario);
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

  agent.configure({ ai: aiImpl, send: safeSend, optional });
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
  handle('assistant:confirm', (requestId, approved) => agent.confirm(String(requestId || ''), approved === true));
  handle('assistant:cancel', (conversationId) => agent.cancel(String(conversationId || '')));
  handle('assistant:undo', (undoId) => agent.undoAction(String(undoId || '')));
  handle('assistant:conversations', () => agent.conversations());
  handle('assistant:conversation', (id) => agent.conversation(String(id || '')));
  handle('assistant:deleteConversation', (id) => agent.deleteConversation(String(id || '')));
  handle('assistant:status', (opts) => status(opts && typeof opts === 'object' ? opts : {}));
  handle('assistant:useWallet', async (family) => {
    const quota = await aiImpl.useWallet(String(family || ''));
    // modules/ai avisa la cuota nueva solo (ai:quota); la IA de demostracion no habla con nadie: se avisa aca
    if (fakeMode) safeSend('ai:quota', quota);
    return status({});
  });
  onQuit(() => agent.shutdown());
}

module.exports = {
  register,
  // Para otros modulos del proceso principal
  status,
  send: (...a) => agent.send(...a),
};
