'use strict';
// Entorno falso para probar modules/overlay.js entero (la orquestacion: ventana, ayudante, atajos, paneles, ajustes) sin
// Electron ni juego. Se arma con cache de require: electron, core/game, core/settings, servers y tasks son falsos; el
// ayudante de la ventana (tracker.track), el de rendimiento (perf.createSampler) y la ventana del overlay
// (window.createOverlayWindow) se reemplazan por dobles que dejan ver que les pidio el modulo.
//   const env = makeEnv();          // modulo nuevo, con su propio estado
//   env.startGame('inst', 4242);    // como si core/game avisara que la partida esta abierta
//   env.tracker.last().update({...})  // lo que diria el ayudante de PowerShell
// VENUS_OVERLAY_FILE=overlay.old.js corre las mismas pruebas contra otra copia del modulo (para ver que fallaban antes).
const { EventEmitter } = require('events');
const path = require('path');

const MODULES = path.join(__dirname, '..', '..');
const OVERLAY = path.join(MODULES, process.env.VENUS_OVERLAY_FILE || 'overlay.js');


function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

class FakeWebContents extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.sent = [];
    this.destroyed = false;
  }
  send(channel, data) {
    this.sent.push({ channel, data });
  }
  isDestroyed() {
    return this.destroyed;
  }
}

let nextId = 100;

// Ventana del overlay falsa. quirk.firstSize: la primera vez que se la mueve queda con otro ancho (monitores de distinta escala).
class FakeWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.hwnd = String(900000 + nextId++);
    this.webContents = new FakeWebContents(nextId++);
    this.opts = opts;
    this.destroyedFlag = false;
    this.bounds = { x: 0, y: 0, width: 800, height: 450 };
    this.visible = false;
    this.calls = [];
    this.boundsCalls = 0;
    this.focusable = false;
    this.ignoreMouse = true;
  }
  isDestroyed() {
    return this.destroyedFlag;
  }
  destroy() {
    if (this.destroyedFlag) return;
    this.destroyedFlag = true;
    this.webContents.destroyed = true;
    this.visible = false;
    this.emit('closed');
  }
  setBounds(b) {
    this.boundsCalls++;
    this.calls.push(['setBounds', b]);
    if (this.opts.throwOnBounds) throw new Error('setBounds roto');
    this.bounds = { ...b };
    if (this.opts.firstSize && this.boundsCalls === 1) this.bounds.width = b.width + 7;
  }
  getBounds() {
    return { ...this.bounds };
  }
  showInactive() {
    this.visible = true;
    this.calls.push(['showInactive']);
  }
  hide() {
    this.visible = false;
    this.calls.push(['hide']);
  }
  isVisible() {
    return this.visible;
  }
  moveTop() {}
  setAlwaysOnTop() {}
  setIgnoreMouseEvents(on) {
    this.ignoreMouse = on;
    this.calls.push(['setIgnoreMouseEvents', on]);
  }
  setFocusable(on) {
    this.focusable = on;
  }
  setSkipTaskbar() {}
  focus() {
    this.calls.push(['focus']);
  }
  blur() {
    this.calls.push(['blur']);
  }
  isFocused() {
    return false;
  }
  getNativeWindowHandle() {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(this.hwnd), 0);
    return b;
  }
  // Lo que le llego a la pagina por un canal
  sentOn(channel) {
    return this.webContents.sent.filter((s) => s.channel === channel).map((s) => s.data);
  }
}

// t: el contexto de la prueba; al terminar se devuelve todo lo que se reemplazo (si no, las otras pruebas verian dobles)
function makeEnv(options = {}, t = null) {
  const env = { options, online: true, now: () => Date.now() };
  const undo = [];
  const stub = (file, exports) => {
    const filename = require.resolve(file);
    const before = require.cache[filename];
    undo.push(() => (before ? (require.cache[filename] = before) : delete require.cache[filename]));
    require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
    return exports;
  };
  const replace = (obj, key, value) => {
    const before = obj[key];
    undo.push(() => {
      obj[key] = before;
    });
    obj[key] = value;
  };
  env.stub = stub;
  env.restore = () => {
    env.quit?.();
    while (undo.length) undo.pop()();
    delete require.cache[OVERLAY];
  };
  t?.after?.(() => env.restore());

  // ---- Electron falso ----
  const shortcuts = new Map(); // atajo -> funcion
  const takenByOthers = new Set(); // atajos que "otra aplicacion" tiene tomados
  const globalShortcut = {
    register(accel, fn) {
      env.attempts.push(accel);
      if (takenByOthers.has(accel) || shortcuts.has(accel)) return false;
      shortcuts.set(accel, fn);
      env.registerCalls.push(accel);
      return true;
    },
    unregister(accel) {
      shortcuts.delete(accel);
    },
    isRegistered: (accel) => shortcuts.has(accel),
  };
  const screen = Object.assign(new EventEmitter(), {
    screenToDipRect: (w, r) => ({ ...r }),
    getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  });
  const ipcMain = {
    listeners: new Map(),
    handlers: new Map(),
    on(channel, fn) {
      ipcMain.listeners.set(channel, fn);
    },
    handle(channel, fn) {
      ipcMain.handlers.set(channel, fn);
    },
  };
  const app = Object.assign(new EventEmitter(), { isPackaged: false, whenReady: () => Promise.resolve() });
  env.shell = { opened: [], openExternal: async (url) => void env.shell.opened.push(url) };
  const electron = { app, globalShortcut, screen, ipcMain, net: { isOnline: () => env.online }, shell: env.shell, BrowserWindow: class {} };
  stub('electron', electron);
  env.shortcuts = shortcuts;
  env.takenByOthers = takenByOthers;
  env.registerCalls = [];
  env.attempts = []; // cada vez que el modulo intento registrar un atajo (salga bien o no)
  env.screen = screen;
  env.app = app;
  env.ipcMain = ipcMain;

  // ---- Ajustes y juego falsos ----
  const listeners = new Set();
  // El overlay viene apagado desde la 6.1: las pruebas lo prenden salvo que pidan otra cosa (settings: { overlay: { enabled: false } })
  let data = deepMerge({ language: 'es', ai: { enabled: true }, voice: { muteShortcut: 'CommandOrControl+Shift+M' }, overlay: { enabled: true } }, options.settings || {});
  env.setCalls = [];
  const settings = {
    get: async () => data,
    async set(patch) {
      env.setCalls.push(patch);
      data = deepMerge(data, JSON.parse(JSON.stringify(patch)));
      for (const fn of listeners) fn(data, patch);
      return data;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  stub('../../../core/settings', settings);
  env.settings = settings;
  const game = { events: new EventEmitter(), before: [], addBeforeLaunch: (fn) => game.before.push(fn), activity: () => null };
  stub('../../../core/game', game);
  stub('../../../core/servers', { events: new EventEmitter(), get: async () => null });
  stub('../../../core/tasks', { bus: new EventEmitter() });
  stub('../../../core/instances', { dir: () => null, get: async () => ({ mcVersion: '1.20.1', dir: 'C:/instancia' }) });
  stub('../../../core/paths', { assets: () => 'C:/assets', versionJar: (id) => `C:/versions/${id}/${id}.jar`, cache: (...parts) => ['C:/cache', ...parts].join('/') });
  env.game = game;

  // ---- Dobles del ayudante, del medidor y de la ventana ----
  const tracker = require('../tracker');
  env.tracks = [];
  replace(tracker, 'track', (opts) => {
    const handle = { opts, stopped: false, fronts: [], stop() { handle.stopped = true; }, front(h) { handle.fronts.push(String(h)); return true; } };
    // Lo que diria el ayudante: update(info) con la forma de geometry.parseLine; end({ clean })
    handle.update = (info) => opts.onUpdate?.(info);
    handle.end = (arg) => opts.onEnd?.(arg);
    if (options.noTracker) return null;
    env.tracks.push(handle);
    return handle;
  });
  env.tracker = { last: () => env.tracks[env.tracks.length - 1], all: env.tracks };

  const perf = require('../perf');
  env.samplers = [];
  replace(perf, 'createSampler', (opts) => {
    const s = { opts, stopped: false, pid: opts.pid, stop() { s.stopped = true; } };
    env.samplers.push(s);
    return s;
  });

  const windowMod = require('../window');
  env.windows = [];
  replace(windowMod, 'createOverlayWindow', () => {
    if (options.windowThrows) throw new Error('no hay ventana');
    const w = new FakeWindow(options.window || {});
    env.windows.push(w);
    return w;
  });
  env.win = () => env.windows[env.windows.length - 1];

  // Ventana principal del launcher
  env.main = { minimized: false, visible: true, calls: [], isDestroyed: () => false, isVisible: () => env.main.visible, isMinimized: () => env.main.minimized, minimize() { env.main.minimized = true; env.main.calls.push('minimize'); }, restore() { env.main.minimized = false; }, show() {}, focus() {}, getBounds: () => ({ x: 0, y: 0, width: 1300, height: 820 }) };

  // La lectura del idioma y de los textos del juego no toca disco
  const gamelang = require('../../capture/gamelang');
  replace(gamelang, 'readLanguage', async () => 'es_ar');
  replace(gamelang, 'loadTables', async () => ({}));

  // ---- Modulo nuevo con su propio estado ----
  delete require.cache[OVERLAY];
  process.env.VENUS_OVERLAY_TEST = '1';
  const overlay = require(OVERLAY);
  env.overlay = overlay;
  env.sent = [];
  env.quitHooks = [];
  overlay.register({
    app,
    handle: (channel, fn) => ipcMain.handle(channel, (...args) => fn(...args)),
    send: (channel, payload) => env.sent.push({ channel, payload }),
    getWindow: () => env.main,
    onQuit: (fn) => env.quitHooks.push(fn),
  });

  env.invoke = (channel, ...args) => ipcMain.handlers.get(channel)(...args);
  env.status = () => env.invoke('overlay:status');
  env.quit = () => {
    const hooks = env.quitHooks.splice(0);
    hooks.forEach((fn) => fn());
  };
  // Mensajes de la pagina del overlay (ipcMain.on('overlay:page')): solo cuentan si vienen de su ventana
  env.page = (msg, from = env.win()) => ipcMain.listeners.get('overlay:page')({ sender: from?.webContents }, msg);
  env.panelRequest = (req, from = env.win()) => ipcMain.handlers.get('overlay:panel')({ sender: from?.webContents }, req);
  env.startGame = (id, pid, extra = {}) => game.events.emit('state', id, { state: 'running', pid, startedAt: Date.now(), ...extra });
  env.stopGame = (id, state = 'stopped') => game.events.emit('state', id, { state });
  env.state = () => overlay.__state;
  return env;
}

// Linea del ayudante ya leida (lo que recibe onUpdate): el juego esta en x, y con w por h y adelante o no
function info({ hwnd = '5000', foreground = hwnd, x = 100, y = 100, width = 1280, height = 720, minimized = false, visible = true, fullscreen = false } = {}) {
  return { found: true, hwnd: String(hwnd), foreground: String(foreground), rect: { x, y, width, height }, minimized, visible, fullscreen, dpi: 96 };
}

// Deja correr las promesas pendientes (los ajustes se guardan de forma asincronica)
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

module.exports = { makeEnv, info, flush, FakeWindow };
