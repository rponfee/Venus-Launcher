'use strict';
// Puente seguro entre la interfaz y el proceso principal (contextIsolation + sandbox).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Canales con formato "modulo:accion" (los registra cada modulo en el proceso principal).
const CHANNEL = /^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9][\w:.-]*$/;

// Llamada cruda: devuelve la respuesta de ipc.js tal cual ({ ok, data } o { ok: false, error, code }).
function rawInvoke(channel, ...args) {
  if (typeof channel !== 'string' || !CHANNEL.test(channel)) return Promise.reject(new Error(`Canal inválido: ${channel}`));
  return ipcRenderer.invoke(channel, ...args);
}

// Respaldo en este mundo aislado (contextBridge copia los Error solo con el mensaje: aca se pierde .code).
async function isolatedInvoke(channel, ...args) {
  const r = await rawInvoke(channel, ...args);
  if (r && r.ok === false) {
    const err = new Error(r.error);
    if (r.code !== undefined && r.code !== null) err.code = r.code;
    throw err;
  }
  return r ? r.data : r;
}

// Los errores de los canales tienen que llegar a la interfaz como Error con .code (por ejemplo 'cancelled'),
// pero contextBridge solo conserva el mensaje. Por eso invoke y los atajos son funciones del mundo de la
// pagina (executeInMainWorld) que llaman a rawInvoke y arman ahi el Error: al exponerlas, contextBridge
// devuelve la funcion original de ese mundo en vez de envolverla otra vez.
function mainWorldInvoke() {
  try {
    const make = contextBridge.executeInMainWorld({
      func: () => (raw) => {
        const invoke = async (channel, ...args) => {
          const r = await raw(channel, ...args);
          if (r && r.ok === false) {
            const err = new Error(r.error);
            if (r.code !== undefined && r.code !== null) err.code = r.code;
            throw err;
          }
          return r ? r.data : r;
        };
        return { invoke, call: (channel) => (...args) => invoke(channel, ...args) };
      },
    });
    return make && typeof make === 'function' ? make(rawInvoke) : null;
  } catch {
    return null;
  }
}

const mainWorld = mainWorldInvoke();
const invoke = mainWorld && typeof mainWorld.invoke === 'function' ? mainWorld.invoke : isolatedInvoke;
const call = (ch) => (mainWorld && typeof mainWorld.call === 'function' ? mainWorld.call(ch) : (...a) => isolatedInvoke(ch, ...a));

contextBridge.exposeInMainWorld('venus', {
  // Llamada generica: venus.invoke('netplay:upnpOpen', 25565). Los errores traen err.code si el handler lo puso.
  invoke,
  // Eventos del proceso principal: venus.on('game:state', (id, st) => ...) -> devuelve la funcion para desuscribirse
  on(channel, cb) {
    if (typeof channel !== 'string' || !CHANNEL.test(channel)) throw new Error(`Evento no permitido: ${channel}`);
    const fn = (e, ...args) => cb(...args);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  app: {
    info: call('app:info'),
    window: call('app:window'),
    openExternal: call('app:openExternal'),
    openPath: call('app:openPath'),
    showItem: call('app:showItem'),
    selectFiles: call('app:selectFiles'),
    selectFolder: call('app:selectFolder'),
    setDataDir: call('app:setDataDir'),
    relaunch: call('app:relaunch'),
    dataUsage: call('app:dataUsage'),
    clearCache: call('app:clearCache'),
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
  },
  settings: { get: call('settings:get'), set: call('settings:set') },
  support: { call: call('support:call'), list: call('support:list'), create: call('support:create'), detail: call('support:detail'), reply: call('support:reply'), resolve: call('support:resolve') },
  system: { info: call('system:info'), usage: call('system:usage') },
  java: { runtimes: call('java:runtimes'), detect: call('java:detect'), test: call('java:test') },
  accounts: {
    list: call('accounts:list'),
    addOffline: call('accounts:addOffline'),
    loginMicrosoft: call('accounts:loginMicrosoft'),
    select: call('accounts:select'),
    remove: call('accounts:remove'),
  },
  versions: { manifest: call('versions:manifest'), patchNotes: call('versions:patchNotes'), patchNote: call('versions:patchNote') },
  loaders: { gameVersions: call('loaders:gameVersions'), versions: call('loaders:versions') },
  instances: {
    list: call('instances:list'),
    get: call('instances:get'),
    create: call('instances:create'),
    update: call('instances:update'),
    remove: call('instances:remove'),
    duplicate: call('instances:duplicate'),
    repair: call('instances:repair'),
    content: call('instances:content'),
    toggleFile: call('instances:toggleFile'),
    deleteFile: call('instances:deleteFile'),
    addFiles: call('instances:addFiles'),
    openFolder: call('instances:openFolder'),
    addOptifine: call('instances:addOptifine'),
    launch: call('instances:launch'),
    stop: call('instances:stop'),
    status: call('instances:status'),
    logs: call('instances:logs'),
    latestLog: call('instances:latestLog'),
  },
  modrinth: {
    search: call('modrinth:search'),
    project: call('modrinth:project'),
    versions: call('modrinth:versions'),
    tags: call('modrinth:tags'),
    install: call('modrinth:install'),
    installModpack: call('modrinth:installModpack'),
    identify: call('modrinth:identify'),
    updates: call('modrinth:updates'),
  },
  servers: {
    list: call('servers:list'),
    get: call('servers:get'),
    create: call('servers:create'),
    update: call('servers:update'),
    start: call('servers:start'),
    stop: call('servers:stop'),
    kill: call('servers:kill'),
    command: call('servers:command'),
    logs: call('servers:logs'),
    remove: call('servers:remove'),
    properties: call('servers:properties'),
    setProperties: call('servers:setProperties'),
    addresses: call('servers:addresses'),
    openFolder: call('servers:openFolder'),
    content: call('servers:content'),
    installProject: call('servers:installProject'),
    reinstall: call('servers:reinstall'),
    deleteFile: call('servers:deleteFile'),
    versions: call('servers:versions'),
  },
  stats: { get: call('stats:get'), reset: call('stats:reset') },
  tasks: { list: call('tasks:list'), cancel: call('tasks:cancel') },
  // setShortcut(accel) -> true si quedo registrado (false: atajo invalido o lo usa otra aplicacion)
  voice: { setShortcut: call('voice:setShortcut') },
});
