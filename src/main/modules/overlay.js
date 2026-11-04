'use strict';
// Overlay dentro del juego: una ventana transparente, siempre encima, sin foco y que deja pasar los clics, puesta
// sobre el area de la ventana del juego. Muestra el Voice Chat (quien habla, quien esta silenciado), los mensajes
// que llegan, avisos (launcher, amigos, servidores, logros y puntos), capturas, clips y grabacion, y la cancion
// que suena. Funciona con cualquier version y loader porque no toca el juego; no se ve en pantalla completa
// exclusiva (docs/overlay.md). Ajustes en settings.overlay (overlay/config.js).
//
// Contrato 1 de la 2.0 (otros modulos): require('./overlay').push(evento) -> true | false (nunca lanza).
// Canales:
//   overlay:push(evento)          -> true (lanza err.code 'badEvent' si el evento no cumple el contrato)
//   overlay:status()              -> { supported, enabled, active, running, found, fullscreen, minimized, visible,
//                                      hidden, editing, testing, mode, shortcut, shortcutOk, config, defaults }
//   overlay:edit(bool)            -> status (modo edicion: arrastrar los widgets sobre el juego o la pantalla)
//   overlay:test([eventos])       -> status (muestra el overlay unos segundos con eventos de ejemplo)
//   overlay:reset()               -> status (posiciones de fabrica)
//   overlay:setShortcut(accel)    -> { ok, shortcut } (atajo para mostrar u ocultar; '' lo apaga)
//   overlay:accent('#rrggbb')     -> true (color de acento del launcher para el tema "Acento")
//   overlay:setPanelShortcut(id, accel) -> { ok, shortcut, code? } (atajo del panel 'recipes' o 'assistant')
//   overlay:assistantEvent(conversacion, evento) -> la interfaz le pasa al overlay los eventos del asistente
// Eventos a la interfaz: overlay:state (lo mismo que status, sin config ni defaults), overlay:config (la
// configuracion normalizada cada vez que cambia, por ejemplo al mover un widget en el modo edicion) y overlay:route
// (un panel pidio abrir una pantalla del launcher).
// La pagina del overlay (renderer/overlay.html) habla solo por su preload (overlay/preload.js). Paneles: docs/wip/overlay-32.md.
const { t } = require('../core/i18n');
const config = require('./overlay/config');
const events = require('./overlay/events');
const geometry = require('./overlay/geometry');
const tracker = require('./overlay/tracker');
const perf = require('./overlay/perf');
const panels = require('./overlay/panels');
const counters = require('./overlay/counters');
const { GameLogReader } = require('./capture/gamelog');
const gamelang = require('./capture/gamelang');

const TEST_MS = 9000;
const EDIT_MAX_MS = 15 * 60 * 1000; // el modo edicion se apaga solo (la ventana no puede quedar tomando el mouse)
const IDLE_CLOSE_MS = 60000; // sin juego ni prueba la ventana se cierra para no ocupar memoria
const CAPTURE_DEDUPE_MS = 5000;
const TASK_MIN_MS = 10000; // tareas largas que terminan mientras se juega
const QUEUE_MAX = 40;
const PANEL_MAX_MS = 15 * 60 * 1000; // sin usarlo, un panel se cierra solo (la ventana no puede quedar tomando el mouse)
const PANEL_FOCUS_CHECK_MS = 700;
const PANEL_FOCUS_GIVEUP_MS = 1800;
const RETURN_DELAY_MS = 60; // al soltar el foco, Windows se lo da a la ventana que sigue: despues se le pide el juego
const RETURN_RETRY_MS = 450;
const PANEL_BLUR_GRACE_MS = 500; // al abrir, Windows puede avisar un cambio de foco que no es del usuario
const PANEL_FS_BOUNCE_MS = 6000; // en pantalla completa el juego se minimiza al perder el foco
const LANG_RELOAD_MS = 1500;

const st = {
  ctx: null,
  cfg: config.normalize(null),
  lang: 'es',
  motion: 'auto',
  accent: '#f29a2e',
  games: new Map(), // instanceId -> { id, pid, startedAt, info, track }
  userHidden: false,
  editing: false,
  editTimer: null,
  testUntil: 0,
  testTimer: null,
  win: null,
  winReady: false,
  winHwnd: '',
  bounds: null,
  shown: false,
  interactive: false,
  mode: null,
  queue: [],
  cache: { voice: null, music: null, recording: null },
  shortcut: { accel: null, ok: true },
  idleTimer: null,
  captures: new Map(), // tipo|ruta -> hora (para no mostrar dos veces la misma captura)
  perfSampler: null, // widget de rendimiento (overlay/perf.js): muestras del juego que se sigue
  plays: new Map(), // instanceId -> { uuid, dir, rootId, assetIndex, reader, lang, recipes } (de los chequeos previos)
  panel: null, // panel abierto ('recipes' o 'assistant'): la ventana toma el mouse y el teclado
  panelAt: 0,
  panelGame: null,
  panelFs: false,
  panelFsBlocked: null, // pid del juego que se minimizo al abrir un panel en pantalla completa
  panelTimer: null,
  panelFocusTimers: [],
  panelKeys: Object.fromEntries(config.PANELS.map((id) => [id, { accel: null, ok: true }])),
  assistant: { conv: null, awaiting: false, buffer: [] },
  devHold: false, // capturas de desarrollo: la ventana no se muestra ni toma el foco
  lastLayout: '',
  lastStatus: '',
  quitting: false,
  mainGone: false,
};

const supported = () => process.platform === 'win32';
const testing = () => Date.now() < st.testUntil;
const wanted = () => st.devHold || st.editing || testing() || (st.cfg.enabled && supported() && st.games.size > 0);
const alive = (w) => Boolean(w && !w.isDestroyed());

function coded(key, code, vars) {
  const err = new Error(t(`overlay.${key}`, vars));
  err.code = code;
  return err;
}

// ---------- Estado para la interfaz ----------
function target() {
  return geometry.pickTarget(st.games.values());
}

function status({ full = true } = {}) {
  const tg = target();
  const out = {
    supported: supported(),
    enabled: st.cfg.enabled,
    active: wanted(),
    running: st.games.size > 0,
    found: Boolean(tg),
    fullscreen: Boolean(tg?.info?.fullscreen),
    minimized: Boolean(tg?.info?.minimized),
    visible: st.shown,
    hidden: st.userHidden,
    editing: st.editing,
    testing: testing(),
    mode: st.mode,
    shortcut: st.cfg.shortcut,
    shortcutOk: st.shortcut.ok,
    panel: st.panel,
    panelShortcuts: st.cfg.panelShortcuts,
    panelShortcutsOk: Object.fromEntries(config.PANELS.map((id) => [id, st.panelKeys[id].ok])),
  };
  if (full) {
    out.config = st.cfg;
    out.defaults = config.DEFAULTS;
  }
  return out;
}

function emitStatus() {
  const s = status({ full: false });
  const key = JSON.stringify(s);
  if (key === st.lastStatus) return;
  st.lastStatus = key;
  st.ctx?.send?.('overlay:state', s);
}

// ---------- Ventana ----------
function layout() {
  return { lang: st.lang, accent: st.accent, motion: st.motion, editing: st.editing, mode: st.mode, shortcut: st.cfg.shortcut, widgets: st.cfg.widgets };
}

function toPage(channel, data) {
  if (alive(st.win) && st.winReady) st.win.webContents.send(channel, data);
}

function sendLayout(force = false) {
  const data = layout();
  const key = JSON.stringify(data);
  if (!force && key === st.lastLayout) return;
  st.lastLayout = key;
  toPage('overlay:layout', data);
}

function ensureWindow() {
  clearTimeout(st.idleTimer);
  st.idleTimer = null;
  if (alive(st.win) || st.quitting || st.mainGone) return st.win;
  const { createOverlayWindow, hwndOf } = require('./overlay/window');
  const win = createOverlayWindow();
  st.win = win;
  st.winReady = false;
  st.shown = false;
  st.interactive = false;
  st.bounds = null;
  st.winHwnd = hwndOf(win);
  st.lastLayout = '';
  win.on('closed', () => {
    if (st.win !== win) return;
    st.win = null;
    st.winReady = false;
    st.shown = false;
    st.queue = [];
    emitStatus();
  });
  win.webContents.on('render-process-gone', () => {
    if (st.win === win && !win.isDestroyed()) win.destroy();
  });
  // El usuario se fue a otra ventana con un panel abierto: se cierra (no puede quedar interactivo por error)
  win.on('blur', () => {
    if (st.panel && st.win === win && !st.devHold && Date.now() - st.panelAt > PANEL_BLUR_GRACE_MS) closePanel({ refocus: false });
  });
  return win;
}

function closeWindow() {
  clearTimeout(st.idleTimer);
  st.idleTimer = null;
  if (alive(st.win)) st.win.destroy();
  st.win = null;
  st.winReady = false;
  st.shown = false;
}

function scheduleIdleClose() {
  if (!alive(st.win) || st.idleTimer) return;
  st.idleTimer = setTimeout(() => {
    st.idleTimer = null;
    if (!wanted()) closeWindow();
  }, IDLE_CLOSE_MS);
}

// Rectangulo fisico del ayudante -> DIP (Electron hace la cuenta con la escala de cada monitor).
function toDip(rect) {
  const { screen } = require('electron');
  let r = null;
  try {
    if (typeof screen.screenToDipRect === 'function') r = screen.screenToDipRect(null, rect);
  } catch {
    r = null;
  }
  if (!r) {
    try {
      r = geometry.physicalToDip(rect, screen.getAllDisplays());
    } catch {
      r = rect;
    }
  }
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
}

// Sin juego (modo edicion o prueba): el area de trabajo de la pantalla del launcher.
function screenArea() {
  try {
    const { screen } = require('electron');
    const main = st.ctx?.getWindow?.();
    const d = alive(main) && main.isVisible() && !main.isMinimized() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
    return { ...d.workArea };
  } catch {
    return null;
  }
}

function setInteractive(on) {
  if (st.interactive === on || !alive(st.win)) return;
  st.interactive = on;
  require('./overlay/window').setInteractive(st.win, on);
}

// Corazon del modulo: con el estado de los juegos, los ajustes y los modos decide si la ventana existe, donde
// va y si se ve. Se llama con cada linea del ayudante (unas 4 por segundo como mucho) y con cada cambio.
function evaluate() {
  if (st.quitting) return;
  if (st.devHold) {
    ensureWindow();
    emitStatus();
    return;
  }
  if (st.panel && checkPanelGame()) return;
  if (!wanted()) {
    st.mode = null;
    if (alive(st.win) && st.shown) {
      st.win.hide();
      st.shown = false;
    }
    setInteractive(false);
    scheduleIdleClose();
    emitStatus();
    return;
  }
  ensureWindow();
  const tg = target();
  const d = geometry.decide({ enabled: st.cfg.enabled, userHidden: st.userHidden, editing: st.editing, testing: testing(), target: tg, overlayHwnd: st.winHwnd, panel: Boolean(st.panel) });
  const modeChanged = d.mode !== st.mode;
  st.mode = d.mode;
  if (!alive(st.win)) return emitStatus();
  const bounds = d.mode === 'game' && tg ? toDip(tg.info.rect) : d.mode === 'screen' ? screenArea() : null;
  if (d.show && bounds) {
    if (!geometry.sameRect(bounds, st.bounds)) {
      st.bounds = bounds;
      st.win.setBounds(bounds);
    }
    if (!st.shown) {
      st.win.showInactive();
      st.win.setAlwaysOnTop(true, 'screen-saver');
      st.win.moveTop();
      st.shown = true;
    }
  } else if (st.shown) {
    st.win.hide();
    st.shown = false;
  }
  setInteractive((st.editing || Boolean(st.panel)) && st.shown);
  if (modeChanged) sendLayout();
  syncPerf();
  emitStatus();
}

// ---------- Widget de rendimiento (3.1) ----------
// Muestras cada 2 s del juego que se sigue (RAM, CPU, ping del servidor y tiempo de sesion), solo mientras el
// overlay y el widget estan activados y hay un juego abierto. El ayudante es barato (overlay/perf.js).
const perfWanted = () => supported() && !st.quitting && st.cfg.enabled && st.cfg.widgets.perf?.enabled !== false && st.games.size > 0;

function serverAddress(id) {
  try {
    const a = require('../core/game').activity(id);
    return a?.type === 'server' && typeof a.address === 'string' ? a.address : null;
  } catch {
    return null;
  }
}

function gameDir(id) {
  try {
    return require('../core/instances').dir(id);
  } catch {
    return null;
  }
}

// FPS del juego: los informa el mod Venus Badge con un archivo (sin el mod, o sin mundo abierto, no hay)
function fpsOf(id) {
  try {
    const dir = gameDir(id);
    const r = dir ? require('./perfhistory/fps').readFps(dir) : null;
    return r ? r.fps : null;
  } catch {
    return null;
  }
}

function syncPerf() {
  const game = perfWanted() ? target() || [...st.games.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] : null;
  if (st.perfSampler && (!game || st.perfSampler.pid !== game.pid)) {
    st.perfSampler.stop();
    st.perfSampler = null;
    // Sin muestras, la pagina esconde el widget enseguida (si no, lo haria sola a los segundos).
    deliver({ kind: 'perf', ram: null, cpu: null, ping: null, session: null });
  }
  if (game && !st.perfSampler) {
    st.perfSampler = perf.createSampler({
      pid: game.pid,
      startedAt: game.startedAt,
      getAddress: () => serverAddress(game.id),
      getFps: () => fpsOf(game.id),
      onSample: (ev) => {
        if (st.perfSampler?.pid === game.pid) push(ev);
      },
    });
  }
}

// ---------- Contadores en pantalla ----------
// Cuentan desde que se abre el juego, este o no el widget a la vista (leer la fecha de un archivo cada 5 s no cuesta nada).
function startCounters(g) {
  const play = st.plays.get(g.id);
  g.counters = counters.createWatch({
    instanceDir: play?.dir || gameDir(g.id),
    uuid: play?.uuid || null,
    startedAt: g.startedAt,
    getActivity: () => {
      try {
        return require('../core/game').activity(g.id);
      } catch {
        return null;
      }
    },
    // Con varios juegos abiertos se muestra el que se sigue
    onUpdate: (ev) => {
      if ((target() || g) === g) push(ev);
    },
  });
}

async function loadPlayTables(play) {
  const lang = await gamelang.readLanguage(play.dir);
  if (play.lang === lang) return;
  play.lang = lang;
  const paths = require('../core/paths');
  const rootId = play.rootId && /^[\w.+-]+$/.test(play.rootId) ? play.rootId : null;
  // Mismo archivo de textos que los clips automaticos (capture.js)
  play.reader.setTables(await gamelang.loadTables({ assetsDir: paths.assets(), indexId: play.assetIndex, lang, jarPath: rootId ? paths.versionJar(rootId) : null, cacheFile: rootId ? paths.cache('capture-lang', `${rootId}.json`) : null }));
}

function reloadPlayTables(play) {
  loadPlayTables(play).catch((err) => console.warn('[overlay] textos del juego:', err?.message || err));
}

// Antes de lanzar: de donde salen las recetas y los textos del juego. Nada de la cuenta salvo su nombre y su uuid.
function onBeforeLaunch({ id, instance, resolved, account, quiet }) {
  if (quiet) {
    st.plays.delete(id);
    return;
  }
  const play = {
    uuid: counters.dashUuid(account?.uuid),
    dir: instance?.dir || null,
    rootId: resolved?.rootId || null,
    assetIndex: resolved?.assetIndex?.id || null,
    reader: new GameLogReader({ player: account?.name }),
    lang: null,
    langTimer: null,
    recipes: null,
  };
  st.plays.set(id, play);
  reloadPlayTables(play);
}

// Muertes en vivo: el mismo lector de registro que los clips automaticos, solo para el jugador local
function onGameLog(id, lines) {
  const play = st.plays.get(id);
  if (!play || !Array.isArray(lines)) return;
  for (const l of lines) {
    const ev = play.reader.read(l?.text);
    if (!ev) continue;
    if (ev.reason === 'death') st.games.get(id)?.counters?.death();
    else if (ev.setup === 'reload') {
      clearTimeout(play.langTimer);
      play.langTimer = setTimeout(() => reloadPlayTables(play), LANG_RELOAD_MS);
      play.langTimer.unref?.();
    }
  }
}

// ---------- Juegos y seguimiento de la ventana ----------
function needsTracker() {
  return supported() && (st.cfg.enabled || st.editing || testing());
}

function startTracker(g) {
  if (g.track || !needsTracker()) return;
  g.track = tracker.track({
    pid: g.pid,
    onUpdate: (info) => {
      if (st.games.get(g.id) !== g) return;
      g.info = info;
      evaluate();
    },
    onEnd: () => {
      if (st.games.get(g.id) !== g) return;
      g.track = null;
      g.info = { found: false };
      evaluate();
    },
  });
}

function syncTrackers() {
  for (const g of st.games.values()) {
    if (needsTracker()) startTracker(g);
    else if (g.track) {
      g.track.stop();
      g.track = null;
      g.info = { found: false };
    }
  }
}

function startGame(id, pid, startedAt) {
  const prev = st.games.get(id);
  if (prev?.pid === pid) return;
  prev?.track?.stop();
  prev?.counters?.stop();
  const g = { id, pid, startedAt: startedAt || Date.now(), info: { found: false }, track: null, counters: null };
  st.games.set(id, g);
  startTracker(g);
  startCounters(g);
  armShortcut();
  evaluate();
}

function stopGame(id) {
  const g = st.games.get(id);
  if (!g) return;
  g.track?.stop();
  g.counters?.stop();
  st.games.delete(id);
  clearTimeout(st.plays.get(id)?.langTimer);
  st.plays.delete(id);
  // Sin datos, la pagina esconde los contadores
  if (!st.games.size) deliver({ kind: 'counters', deaths: null, mined: null, session: null, multiplayer: false });
  if (!st.games.size) {
    st.userHidden = false;
    if (st.editing && st.mode === 'game') stopEdit();
  }
  armShortcut();
  syncPerf();
  evaluate();
}

// ---------- Atajo global (solo mientras hay un juego abierto, asi no le roba la tecla al resto del tiempo) ----------
function unregisterShortcut() {
  if (!st.shortcut.accel) return;
  try {
    require('electron').globalShortcut.unregister(st.shortcut.accel);
  } catch {
    /* ya no estaba registrado */
  }
  st.shortcut.accel = null;
}

function registerShortcut(accel) {
  unregisterShortcut();
  if (!accel) {
    st.shortcut = { accel: null, ok: true };
    return true;
  }
  let ok = false;
  try {
    ok = Boolean(require('electron').globalShortcut.register(accel, onShortcut));
  } catch {
    ok = false; // atajo invalido
  }
  st.shortcut = { accel: ok ? accel : null, ok };
  return ok;
}

function armShortcut() {
  const want = st.cfg.enabled && st.games.size > 0 && st.cfg.shortcut;
  if (want && st.shortcut.accel !== st.cfg.shortcut) registerShortcut(st.cfg.shortcut);
  else if (!want) {
    unregisterShortcut();
    st.shortcut.ok = true;
  }
  armPanelShortcuts();
}

// Atajos de los paneles: como el de arriba, solo mientras hay un juego abierto.
function dropPanelKey(id) {
  const key = st.panelKeys[id];
  if (!key.accel) return;
  try {
    require('electron').globalShortcut.unregister(key.accel);
  } catch {
    /* ya no estaba registrado */
  }
  key.accel = null;
}

function takePanelKey(id, accel) {
  dropPanelKey(id);
  let ok = false;
  try {
    ok = Boolean(require('electron').globalShortcut.register(accel, () => onPanelShortcut(id)));
  } catch {
    ok = false;
  }
  st.panelKeys[id] = { accel: ok ? accel : null, ok };
  return ok;
}

function armPanelShortcuts() {
  const on = st.cfg.enabled && st.games.size > 0;
  for (const id of config.PANELS) {
    const want = on ? st.cfg.panelShortcuts[id] : '';
    if (want && st.panelKeys[id].accel !== want) takePanelKey(id, want);
    else if (!want) {
      dropPanelKey(id);
      st.panelKeys[id].ok = true;
    }
  }
}

function onPanelShortcut(id) {
  if (st.panel === id) closePanel();
  else openPanel(id);
}

// Prueba un atajo de panel: si se puede registrar, se guarda (y queda registrado solo si hay un juego abierto).
async function setPanelShortcut(id, accel) {
  if (!config.PANELS.includes(id)) return { ok: false, shortcut: '', code: 'invalid' };
  const value = typeof accel === 'string' ? accel.trim() : '';
  const current = st.cfg.panelShortcuts[id];
  if (value && !config.validAccelerator(value)) return { ok: false, shortcut: current, code: 'invalid' };
  const others = [st.cfg.shortcut, ...config.PANELS.filter((p) => p !== id).map((p) => st.cfg.panelShortcuts[p])];
  if (value && others.includes(value)) return { ok: false, shortcut: current, code: 'taken' };
  if (value && value !== st.panelKeys[id].accel) {
    const old = st.panelKeys[id].accel;
    if (!takePanelKey(id, value)) {
      if (old) takePanelKey(id, old);
      else st.panelKeys[id] = { accel: null, ok: true };
      return { ok: false, shortcut: current, code: 'taken' };
    }
  }
  await require('../core/settings').set({ overlay: { panelShortcuts: { [id]: value } } });
  st.cfg = { ...st.cfg, panelShortcuts: { ...st.cfg.panelShortcuts, [id]: value } };
  armPanelShortcuts();
  emitStatus();
  return { ok: true, shortcut: value };
}

function onShortcut() {
  if (st.panel) return closePanel();
  if (st.editing) return stopEdit();
  st.userHidden = !st.userHidden;
  evaluate();
}

// Prueba un atajo nuevo: si se puede registrar, se guarda (y queda registrado solo si hay un juego abierto).
async function setShortcut(accel) {
  const value = typeof accel === 'string' ? accel.trim() : '';
  if (value && !config.validAccelerator(value)) return { ok: false, shortcut: st.cfg.shortcut, code: 'invalid' };
  if (value) {
    const old = st.shortcut.accel;
    unregisterShortcut();
    const ok = registerShortcut(value);
    if (!ok) {
      if (old) registerShortcut(old);
      else st.shortcut = { accel: null, ok: true };
      return { ok: false, shortcut: st.cfg.shortcut, code: 'taken' };
    }
  }
  await require('../core/settings').set({ overlay: { shortcut: value } });
  st.cfg = { ...st.cfg, shortcut: value };
  armShortcut();
  emitStatus();
  return { ok: true, shortcut: value };
}

// ---------- Modo edicion y prueba ----------
function startEdit() {
  if (st.panel) closePanel({ refocus: false });
  // Se pide desde Ajustes, con el launcher adelante: se minimiza para que el juego quede a la vista y el overlay
  // pueda tomar el foco (Escape y las flechas andan sin hacer clic antes).
  const main = st.ctx?.getWindow?.();
  if (!st.editing && target() && alive(main) && main.isVisible() && !main.isMinimized()) main.minimize();
  st.editing = true;
  clearTimeout(st.editTimer);
  st.editTimer = setTimeout(stopEdit, EDIT_MAX_MS);
  syncTrackers();
  evaluate();
  sendLayout();
}

function stopEdit() {
  if (!st.editing) return;
  const tg = target();
  st.editing = false;
  clearTimeout(st.editTimer);
  st.editTimer = null;
  setInteractive(false);
  syncTrackers();
  evaluate();
  sendLayout();
  if (tg) returnToGame(tg);
}

function startTest(list) {
  st.testUntil = Date.now() + TEST_MS;
  clearTimeout(st.testTimer);
  st.testTimer = setTimeout(() => {
    restoreAfterTest();
    syncTrackers();
    evaluate();
  }, TEST_MS + 50);
  syncTrackers();
  evaluate();
  for (const raw of Array.isArray(list) ? list.slice(0, 12) : []) {
    try {
      dispatch(events.validate(raw), { force: true, test: true });
    } catch {
      /* evento de ejemplo invalido: se saltea */
    }
  }
}

// La voz y la musica de ejemplo no se guardan: al terminar la prueba vuelve lo real (o nada).
function restoreAfterTest() {
  deliver(masked(st.cache.voice || { kind: 'voice', room: null, self: { muted: false, deafened: false }, members: [] }));
  deliver(st.cache.music || { kind: 'music', state: null });
}

// ---------- Paneles (recetas y asistente) ----------
// Se abren con su atajo: la ventana toma el mouse y el teclado (como en el modo edicion) hasta que el jugador vuelve al
// juego con Esc. Si se va a otra ventana, si el juego se cierra o se minimiza, o si no se usan en 15 minutos, se cierran.
function toPanel(msg) {
  toPage('overlay:panelMsg', msg);
}

function notice(key, vars) {
  toPanel({ type: 'notice', key, vars: vars || null });
}

function clearPanelTimers() {
  clearTimeout(st.panelTimer);
  st.panelTimer = null;
  st.panelFocusTimers.forEach(clearTimeout);
  st.panelFocusTimers = [];
}

function touchPanel() {
  clearTimeout(st.panelTimer);
  st.panelTimer = setTimeout(() => closePanel(), PANEL_MAX_MS);
  st.panelTimer.unref?.();
}

// Que partida hay detras: la pagina no reutiliza lo que leyo de otra (puede ser otra version)
function panelKey() {
  const g = st.games.get(st.panelGame);
  return g ? `${g.id}|${g.pid}` : null;
}

function openPanel(id) {
  if (!config.PANELS.includes(id) || st.quitting) return false;
  if (st.panel) {
    st.panel = id;
    touchPanel();
    toPanel({ type: 'open', id, key: panelKey() });
    emitStatus();
    return true;
  }
  if (st.editing) stopEdit();
  const tg = target();
  const check = panels.canOpen({ usable: geometry.usableInfo(tg?.info), fullscreen: Boolean(tg?.info?.fullscreen), fsBlocked: st.panelFsBlocked === tg?.pid });
  if (check !== 'ok') {
    if (check === 'fullscreen') notice('pn_fullscreen');
    return false;
  }
  clearPanelTimers();
  st.panel = id;
  st.panelAt = Date.now();
  st.panelGame = tg.id;
  st.panelFs = Boolean(tg.info.fullscreen);
  touchPanel();
  evaluate();
  toPanel({ type: 'open', id, key: panelKey() });
  // Windows no siempre le da el foco a una ventana que lo pide (isFocused dice que si aunque no este adelante): lo que
  // vale es la ventana de adelante que informa el ayudante. El ayudante lo pide tambien y, si no se pudo, el panel se
  // cierra: una ventana que toma el mouse sin tener el teclado dejaria al jugador trabado.
  const game = st.games.get(st.panelGame);
  const front = () => game?.info?.foreground === st.winHwnd;
  st.panelFocusTimers = [
    setTimeout(() => {
      if (st.panel && !front()) game?.track?.front(st.winHwnd);
    }, PANEL_FOCUS_CHECK_MS),
    setTimeout(() => {
      if (!st.panel || front()) return;
      closePanel();
      notice('pn_noFocus');
    }, PANEL_FOCUS_GIVEUP_MS),
  ];
  return true;
}

// De vuelta al juego: la ventana que Windows elige sola al soltar el foco puede ser cualquier otra
function returnToGame(g) {
  const ask = () => {
    if (!st.panel && st.games.get(g.id) === g && g.info?.hwnd && g.info.foreground !== g.info.hwnd) g.track?.front(g.info.hwnd);
  };
  st.panelFocusTimers = [setTimeout(ask, RETURN_DELAY_MS), setTimeout(ask, RETURN_RETRY_MS)];
}

function closePanel({ refocus = true } = {}) {
  if (!st.panel) return;
  const g = st.games.get(st.panelGame);
  st.panel = null;
  st.panelGame = null;
  clearPanelTimers();
  toPanel({ type: 'close' });
  evaluate();
  if (refocus && g) returnToGame(g);
}

// El juego que estaba detras del panel ya no se puede cubrir. true si el panel se cerro (evaluate ya corrio de nuevo).
function checkPanelGame() {
  const g = st.games.get(st.panelGame);
  if (g && geometry.usableInfo(g.info)) return false;
  // Pantalla completa: al perder el foco el juego se minimiza solo. Se vuelve y no se intenta mas en esta partida.
  const bounced = Boolean(g && st.panelFs && g.info?.minimized && Date.now() - st.panelAt < PANEL_FS_BOUNCE_MS);
  if (bounced) st.panelFsBlocked = g.pid;
  closePanel({ refocus: bounced });
  if (bounced) notice('pn_fullscreen');
  return true;
}

// --- Recetas ---
function panelGameId() {
  return st.panelGame || target()?.id || null;
}

async function recipeSession() {
  const recipes = require('./recipes');
  const id = panelGameId();
  const devJar = st.devHold ? process.env.VENUS_RECIPES_DEV_JAR : null;
  if (devJar) return recipes.open({ rootId: 'dev', jarPath: devJar });
  if (!id) throw Object.assign(new Error('noGame'), { code: 'noGame' });
  const play = st.plays.get(id);
  if (play) {
    if (!play.recipes) {
      const lang = play.lang || (await gamelang.readLanguage(play.dir));
      play.recipes = recipes.open({ rootId: play.rootId, instanceDir: play.dir, lang, assetIndex: play.assetIndex, mods: true });
      play.recipes.catch(() => {
        play.recipes = null;
      });
    }
    return play.recipes;
  }
  // Partida sin chequeos previos: la version sale de la instancia
  const inst = await require('../core/instances').get(id);
  return recipes.open({ rootId: inst.mcVersion, instanceDir: inst.dir, lang: await gamelang.readLanguage(inst.dir), mods: true });
}

const wikiAllowed = async () => (await require('../core/settings').get()).privacy?.wiki === true;

// Abre la wiki en el navegador: nunca una direccion de la pagina, solo la que se arma aca con un item del juego
async function openWiki(id) {
  if (!(await wikiAllowed())) return { opened: false, code: 'optin' };
  const url = (await recipeSession()).wiki(id);
  if (!url || new URL(url).hostname !== 'minecraft.wiki') return { opened: false, code: 'nopage' };
  if (st.devHold) return { opened: false, code: 'dev', url }; // en las capturas de desarrollo no se abre el navegador
  closePanel({ refocus: false });
  await require('electron').shell.openExternal(url);
  return { opened: true };
}

// --- Asistente: el mismo de la pagina (modules/assistant), con su conversacion, sus permisos y su plan ---
function assistantFlush() {
  const list = st.assistant.buffer.splice(0);
  for (const [convId, ev] of list) relayAssistant(convId, ev);
}

async function assistantOpen() {
  const assistant = require('./assistant');
  const agent = require('./assistant/agent');
  const status = await assistant.status({});
  let online = true;
  try {
    online = require('electron').net.isOnline();
  } catch {
    online = true;
  }
  if (!st.assistant.conv) st.assistant.conv = panels.pickConversation(await agent.conversations().catch(() => []));
  let conv = null;
  if (st.assistant.conv) {
    try {
      conv = panels.cleanConversation(await agent.conversation(st.assistant.conv));
    } catch {
      st.assistant.conv = null; // se borro o es de otra cuenta
    }
  }
  return { block: panels.assistantBlock(status, { online }), conv };
}

async function assistantSend(body) {
  const assistant = require('./assistant');
  if (!st.assistant.conv) {
    st.assistant.awaiting = true;
    st.assistant.buffer = [];
  }
  try {
    const instanceId = st.plays.has(panelGameId()) ? panelGameId() : null;
    const r = await assistant.send(st.assistant.conv, body, { instanceId });
    st.assistant.conv = r.conversationId;
    return { conversationId: r.conversationId };
  } finally {
    st.assistant.awaiting = false;
    assistantFlush();
  }
}

// Eventos del asistente que pasa la interfaz (features/overlaytools.js): con el panel abierto se dibujan; cerrado, un
// aviso cuando contesto o cuando pide una confirmacion.
function relayAssistant(convId, ev) {
  if (typeof convId !== 'string' || !ev || typeof ev !== 'object') return false;
  if (st.assistant.awaiting && !st.assistant.conv) {
    if (st.assistant.buffer.length < 200) st.assistant.buffer.push([convId, ev]);
    return true;
  }
  if (convId !== st.assistant.conv) return false;
  if (st.panel === 'assistant') {
    const clean = panels.cleanEvent(ev);
    if (clean) toPanel({ type: 'assistant', event: clean });
    return true;
  }
  if (playing() && !st.panel) {
    const shortcut = st.cfg.panelShortcuts.assistant || '';
    if (ev.type === 'confirm' && ev.state === 'pending') notice('as_alertConfirm', { shortcut });
    else if (ev.type === 'done' && ev.stopReason !== 'cancelled') notice('as_alertDone', { shortcut });
  }
  return true;
}

function openInLauncher(route) {
  closePanel({ refocus: false });
  const main = st.ctx?.getWindow?.();
  if (alive(main)) {
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  }
  st.ctx?.send?.('overlay:route', route);
  return true;
}

async function runPanel(req) {
  switch (req.action) {
    case 'recipes.info':
      return { ...(await recipeSession()).info, wikiAllowed: await wikiAllowed() };
    case 'recipes.search':
      return (await recipeSession()).search(req.query);
    case 'recipes.item':
      return (await recipeSession()).card(req.id);
    case 'recipes.wiki':
      return openWiki(req.id);
    case 'recipes.wikiAllow':
      await require('../core/settings').set({ privacy: { wiki: true } });
      return { allowed: true };
    case 'assistant.open':
      return assistantOpen();
    case 'assistant.send':
      return assistantSend(req.text);
    case 'assistant.cancel':
      return st.assistant.conv ? require('./assistant/agent').cancel(st.assistant.conv) : false;
    case 'assistant.confirm':
      return require('./assistant/agent').confirm(req.requestId, req.approved);
    case 'assistant.new':
      st.assistant.conv = null;
      return true;
    case 'launcher.open':
      return openInLauncher(req.route);
    case 'panel.switch':
      // Cambio de pestana en la pagina: los eventos del asistente siguen al panel que se ve
      st.panel = req.id;
      emitStatus();
      return true;
    default:
      return null;
  }
}

// Pedidos de la pagina: solo de la ventana del overlay, solo con un panel abierto y solo lo que acepta cleanRequest.
async function onPanelRequest(event, raw) {
  if (!alive(st.win) || event.sender?.id !== st.win.webContents.id) return { ok: false, code: 'forbidden' };
  if (!st.panel) return { ok: false, code: 'closed' };
  const req = panels.cleanRequest(raw);
  if (!req) return { ok: false, code: 'bad' };
  touchPanel();
  try {
    return { ok: true, data: await runPanel(req) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: typeof err?.code === 'string' ? err.code : 'error' };
  }
}

// ---------- Eventos ----------
function deliver(ev, { force = false } = {}) {
  if (!alive(st.win)) {
    if (!force) return;
    ensureWindow();
  }
  if (st.winReady) st.win.webContents.send('overlay:event', ev);
  else {
    st.queue.push(ev);
    if (st.queue.length > QUEUE_MAX) st.queue.splice(0, st.queue.length - QUEUE_MAX);
  }
}

function dispatch(ev, opts = {}) {
  const now = Date.now();
  if (opts.test) {
    deliver(ev.kind === 'capture' || ev.kind === 'music' ? { ...ev, path: null, at: now } : ev, opts);
    return true;
  }
  if (ev.kind === 'capture') {
    if (ev.path) {
      // Misma ruta = misma captura (la puede avisar capture.js y tambien la interfaz).
      const key = ev.path;
      for (const [k, at] of st.captures) if (now - at > CAPTURE_DEDUPE_MS) st.captures.delete(k);
      if (st.captures.has(key)) return true;
      st.captures.set(key, now);
    }
    if (ev.type === 'recording-start') st.cache.recording = { at: now };
    if (ev.type === 'recording-stop') st.cache.recording = null;
    // La ruta no viaja a la pagina: solo sirve para no repetir la misma captura.
    ev = { ...ev, path: null, at: now };
  }
  if (ev.kind === 'voice') st.cache.voice = ev;
  if (ev.kind === 'music') {
    st.cache.music = { ...ev, at: now };
    ev = st.cache.music;
  }
  // Durante una prueba la voz y la musica reales solo se guardan (se muestran al terminar).
  if ((ev.kind === 'voice' || ev.kind === 'music') && testing()) return true;
  deliver(masked(ev), opts);
  return true;
}

// Modo streamer (modules/streamer.js): sin nombres de amigos, mensajes, codigos ni direcciones en el juego.
// La cache guarda el evento real: al apagar el modo vuelve a verse todo.
function masked(ev) {
  try {
    const streamer = require('./streamer');
    return streamer.isOn() ? streamer.maskEvent(ev, t) : ev;
  } catch {
    return ev;
  }
}

// Cambio el modo streamer con la ventana abierta: el Voice Chat que se ve se vuelve a dibujar con o sin nombres.
function onStreamerChange() {
  if (st.cache.voice && !testing()) deliver(masked(st.cache.voice));
}

// Contrato 1: lo llaman otros modulos del proceso principal. Nunca lanza.
function push(ev) {
  try {
    return dispatch(events.validate(ev));
  } catch (err) {
    console.warn('[overlay] evento descartado:', err?.field || err?.message || err);
    return false;
  }
}

// Cuando la pagina avisa que esta lista: layout, lo ultimo de voz, musica y grabacion, y lo que esperaba.
function onPageReady() {
  st.winReady = true;
  sendLayout(true);
  const replay = [st.cache.voice, st.cache.music, st.cache.recording ? { kind: 'capture', type: 'recording-start', at: st.cache.recording.at } : null];
  for (const ev of replay) if (ev) st.win.webContents.send('overlay:event', masked(ev));
  const queued = st.queue.splice(0);
  for (const ev of queued) st.win.webContents.send('overlay:event', ev);
  if (st.panel) toPanel({ type: 'open', id: st.panel, key: panelKey() });
}

function onPageMessage(event, msg) {
  if (!alive(st.win) || event.sender?.id !== st.win.webContents.id || !msg || typeof msg !== 'object') return;
  if (msg.type === 'ready') return onPageReady();
  if (msg.type === 'done') return stopEdit();
  if (msg.type === 'panelClose') return closePanel();
  if (!st.editing) return;
  const settings = require('../core/settings');
  if (msg.type === 'move') {
    const patch = config.positionPatch(msg.id, msg.pos);
    if (patch) settings.set({ overlay: { widgets: patch } }).catch((err) => console.warn('[overlay] guardar posicion', err?.message || err));
  } else if (msg.type === 'reset') {
    settings.set({ overlay: { widgets: config.resetPatch() } }).catch((err) => console.warn('[overlay] restablecer', err?.message || err));
  }
}

// ---------- Avisos propios: servidores locales y tareas largas mientras se juega ----------
const playing = () => st.cfg.enabled && st.games.size > 0;

async function serverName(id) {
  try {
    return (await require('../core/servers').get(id))?.name || id;
  } catch {
    return id;
  }
}

function watchServers() {
  let servers;
  try {
    servers = require('../core/servers');
  } catch {
    return;
  }
  const last = new Map();
  servers.events?.on('state', async (id, s) => {
    const prev = last.get(id);
    last.set(id, s?.state);
    if (!playing() || !s || prev === s.state) return;
    if (s.state === 'online') push({ kind: 'alert', icon: 'server', title: t('overlay.serverOnlineTitle'), body: t('overlay.serverOnlineBody', { name: await serverName(id) }) });
    else if (s.state === 'offline' && s.crashed) push({ kind: 'alert', icon: 'server', title: t('overlay.serverCrashedTitle'), body: t('overlay.serverCrashedBody', { name: await serverName(id) }) });
  });
  servers.events?.on('player', async (id, p) => {
    if (!playing() || p?.type !== 'join' || !p.name) return;
    push({ kind: 'alert', icon: 'server', title: t('overlay.playerJoinTitle', { player: p.name }), body: t('overlay.playerJoinBody', { name: await serverName(id) }) });
  });
}

function watchTasks() {
  let tasks;
  try {
    tasks = require('../core/tasks');
  } catch {
    return;
  }
  const started = new Map();
  tasks.bus?.on('update', (task) => {
    if (!task?.id) return;
    if (task.state === 'running') {
      if (!started.has(task.id)) started.set(task.id, Date.now());
      return;
    }
    const since = started.get(task.id);
    started.delete(task.id);
    if (!since || Date.now() - since < TASK_MIN_MS || !playing()) return;
    const title = String(task.title || '');
    if (task.state === 'done') push({ kind: 'alert', icon: 'info', title: t('overlay.taskDoneTitle'), body: title });
    else if (task.state === 'error') push({ kind: 'alert', icon: 'info', title: t('overlay.taskFailedTitle'), body: title });
  });
}

// Musica (contrato 2, agente A): nowplaying.js hace push({ kind: 'music', state }) cuando cambia algo y solo si
// el usuario dejo la musica en el overlay; aca se guarda la ultima y se manda al abrir la ventana.

// ---------- Ajustes ----------
function applySettings(s, patch) {
  st.cfg = config.normalize(s?.overlay);
  if (typeof patch?.language === 'string') st.lang = patch.language;
  else if (typeof s?.language === 'string') st.lang = s.language;
  st.motion = ['auto', 'on', 'off'].includes(s?.a11y?.reduceMotion) ? s.a11y.reduceMotion : 'auto';
}

function register({ app, handle, send, getWindow, onQuit }) {
  st.ctx = { app, send, getWindow };
  const settings = require('../core/settings');
  const game = require('../core/game');
  const { ipcMain } = require('electron');
  try {
    st.lang = require('../core/i18n').getLanguage() || 'es';
  } catch {
    /* espanol */
  }
  settings
    .get()
    .then((s) => {
      applySettings(s);
      syncTrackers();
      armShortcut();
      evaluate();
    })
    .catch(() => {});

  settings.onChange((s, patch) => {
    if (!patch || !(patch.overlay || patch.language || patch.a11y)) return;
    const before = JSON.stringify(st.cfg);
    applySettings(s, patch);
    if (JSON.stringify(st.cfg) !== before) send?.('overlay:config', st.cfg);
    syncTrackers();
    armShortcut();
    sendLayout();
    evaluate();
  });

  game.events.on('state', (id, s) => {
    if (!s || s.quiet) return; // partidas de prueba: sin overlay
    if (s.state === 'running' && Number.isInteger(s.pid)) startGame(id, s.pid, s.startedAt);
    else if (s.state !== 'running' && s.state !== 'preparing') stopGame(id);
  });

  ipcMain.on('overlay:page', onPageMessage);
  ipcMain.handle('overlay:panel', onPanelRequest);
  game.addBeforeLaunch(onBeforeLaunch);
  game.events.on('log', onGameLog);

  // Si se cierra la ventana principal, el overlay no puede dejar el launcher abierto.
  app.on('browser-window-created', (e, w) => {
    setImmediate(() => {
      if (alive(w) && w === getWindow()) w.once('closed', () => {
        st.mainGone = true;
        closeWindow();
      });
    });
  });

  watchServers();
  watchTasks();

  handle('overlay:push', (ev) => {
    let clean;
    try {
      clean = events.validate(ev);
    } catch (err) {
      throw coded('errBadEvent', 'badEvent', { field: err?.field || 'event' });
    }
    return dispatch(clean);
  });
  handle('overlay:status', () => status());
  handle('overlay:edit', (on) => {
    if (on) startEdit();
    else stopEdit();
    return status();
  });
  handle('overlay:test', (list) => {
    startTest(list);
    return status();
  });
  handle('overlay:reset', async () => {
    await settings.set({ overlay: { widgets: config.resetPatch() } });
    return status();
  });
  handle('overlay:setShortcut', (accel) => setShortcut(accel));
  handle('overlay:setPanelShortcut', (id, accel) => setPanelShortcut(id, accel));
  handle('overlay:assistantEvent', (convId, ev) => relayAssistant(convId, ev));
  handle('overlay:accent', (color) => {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return false;
    st.accent = color.toLowerCase();
    sendLayout();
    return true;
  });

  // Capturas de desarrollo: VENUS_OVERLAY_FAKE_PID=<pid> trata esa ventana como si fuera el juego.
  const fakePid = Number(process.env.VENUS_OVERLAY_FAKE_PID);
  if (process.env.VENUS_DEVSHOT && !app.isPackaged && Number.isInteger(fakePid) && fakePid > 0) {
    app.whenReady().then(() => setTimeout(() => startGame('devshot-fake', fakePid, Date.now()), 500));
  }
  // Capturas de desarrollo sin juego: la pagina en una ventana que no se muestra ni toma el foco (overlay/dev.js).
  if (process.env.VENUS_DEVSHOT && !app.isPackaged) {
    require('./overlay/dev').register({
      handle,
      win: () => st.win,
      hold: () => {
        st.devHold = true;
        evaluate();
        st.win?.setBounds?.({ x: 0, y: 0, width: 1280, height: 720 });
      },
      panel: (id) => {
        st.panel = id;
        toPanel({ type: 'open', id });
      },
      close: () => {
        st.panel = null;
        toPanel({ type: 'close' });
      },
      // Con VENUS_OVERLAY_FAKE_PID: el camino de verdad (ventana a la vista, toma el foco) y como quedo
      open: (id) => openPanel(id),
      info: () => {
        const tg = target();
        return { panel: st.panel, shown: st.shown, interactive: st.interactive, focused: alive(st.win) && st.win.isFocused(), found: Boolean(tg), hwnd: tg?.info?.hwnd, foreground: tg?.info?.foreground, overlay: st.winHwnd, fullscreen: tg?.info?.fullscreen, rect: tg?.info?.rect };
      },
      front: (hwnd) => target()?.track?.front(hwnd),
      deliver: (ev) => dispatch(events.validate(ev), { force: true }),
      layout: () => sendLayout(true),
      notice,
    });
  }

  onQuit?.(() => {
    st.quitting = true;
    clearTimeout(st.testTimer);
    clearTimeout(st.editTimer);
    clearPanelTimers();
    for (const g of st.games.values()) {
      g.track?.stop();
      g.counters?.stop();
    }
    st.perfSampler?.stop();
    st.perfSampler = null;
    unregisterShortcut();
    config.PANELS.forEach(dropPanelKey);
    closeWindow();
  });
}

module.exports = { register, push, status, onStreamerChange };
