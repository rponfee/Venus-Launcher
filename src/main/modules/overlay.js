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
//                                      hidden, editing, testing, mode, shortcut, shortcutOk, tracker ('off' | 'starting' |
//                                      'ok' | 'failed'), pageFailed, panel, panelShortcuts, panelShortcutsOk, shortcutIssue,
//                                      panelShortcutIssues, config, defaults }
//   overlay:edit(bool)            -> status (modo edicion: arrastrar los widgets sobre el juego o la pantalla)
//   overlay:test([eventos])       -> status (muestra el overlay unos segundos con eventos de ejemplo)
//   overlay:reset()               -> status (posiciones de fabrica)
//   overlay:setShortcut(accel)    -> { ok, shortcut, code?, who? } (atajo para mostrar u ocultar; '' lo apaga). code: 'invalid',
//                                      'taken' (otra aplicacion), 'minecraft', 'system', 'altgr' o 'venus' (who: voice, capture, music, overlay)
//   overlay:accent('#rrggbb')     -> true (color de acento del launcher para el tema "Acento")
//   overlay:setPanelShortcut(id, accel) -> { ok, shortcut, code?, who? } (atajo del panel 'recipes' o 'assistant', mismos codigos)
//   overlay:assistantEvent(conversacion, evento) -> la interfaz le pasa al overlay los eventos del asistente
//   overlay:preset(id)            -> status (diseno listo 'minimal', 'full' o 'performance': prende y apaga widgets; code 'invalid')
//   overlay:dnd(modo)             -> status ("No molestar": 15 o 60 minutos, 'game' = hasta cerrar el juego, 'off' lo apaga)
// status suma presets (los disenos listos) y dnd: { on, until, game, missed } (avisos y mensajes que no se mostraron).
// Apagado (lo normal desde la 6.1) no hay ventana, ayudante, medidor, contadores, lectura del registro ni atajos: solo
// quedan escuchando los eventos del juego y de los ajustes. Plataformas: overlay/platform.js.
// Eventos a la interfaz: overlay:state (lo mismo que status, sin config ni defaults), overlay:config (la
// configuracion normalizada cada vez que cambia, por ejemplo al mover un widget en el modo edicion) y overlay:route
// (un panel pidio abrir una pantalla del launcher).
// La pagina del overlay (renderer/overlay.html) habla solo por su preload (overlay/preload.js). Paneles: docs/implementacion/overlay.md.
const { t } = require('../core/i18n');
const config = require('./overlay/config');
const events = require('./overlay/events');
const geometry = require('./overlay/geometry');
const tracker = require('./overlay/tracker');
const perf = require('./overlay/perf');
const panels = require('./overlay/panels');
const counters = require('./overlay/counters');
const platform = require('./overlay/platform');
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
const TRACKER_RETRY_MS = [1000, 3000, 8000]; // si el ayudante se cae solo, se vuelve a abrir (hasta 3 veces seguidas)
const PAGE_READY_MS = 10000; // la pagina del overlay tiene que avisar que esta lista
const PAGE_FAILS_MAX = 3; // intentos seguidos de abrir la pagina antes de rendirse hasta la proxima partida o prueba
const MOVE_FLUSH_MS = 150; // las posiciones del modo edicion se juntan antes de guardarlas (una flecha apretada manda 30 por segundo)
const RECIPES_MS = 90000; // leer los archivos del juego no puede dejar al panel esperando para siempre
const PARTIAL_RECHECK_MS = 20000; // una lectura de recetas incompleta (faltaban mods) se vuelve a pedir pasado este tiempo
const ASSISTANT_STATUS_MS = 8000;
const SHORTCUT_RETRY_MS = 5000; // un atajo que otra aplicacion tiene tomado no se vuelve a probar en cada vuelta
const FAULT_LOG_MS = 30000; // un mismo tipo de error se avisa una vez cada 30 s

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
  panelKeys: Object.fromEntries(config.SHORTCUT_IDS.map((id) => [id, { accel: null, ok: true }])),
  dnd: { until: 0, game: false, missed: 0, timer: null }, // "No molestar" (solo en memoria: no sobrevive a reiniciar el launcher)
  assistant: { conv: null, awaiting: false, buffer: [] },
  devHold: false, // capturas de desarrollo: la ventana no se muestra ni toma el foco
  lastLayout: '',
  lastStatus: '',
  quitting: false,
  mainGone: false,
  readyTimer: null,
  pageFails: 0, // veces seguidas que la pagina no llego a estar lista
  pageFailed: false, // se rindio: no se abre mas hasta la proxima partida, prueba o edicion
  moves: new Map(), // widget -> posicion que mando el modo edicion y todavia no se guardo
  moveTimer: null,
  faultAt: 0,
  screenOff: null,
};

const supported = () => platform.available();
const testing = () => Date.now() < st.testUntil;
const wanted = () => st.devHold || st.editing || testing() || (st.cfg.enabled && supported() && st.games.size > 0);
const alive = (w) => Boolean(w && !w.isDestroyed());

// Nada del overlay puede tirar el launcher ni trabar el juego: lo que corre solo (ayudante, atajos, temporizadores,
// eventos) va envuelto para que un error se avise una vez y no se propague.
function report(label, err) {
  const now = Date.now();
  if (now - st.faultAt < FAULT_LOG_MS) return;
  st.faultAt = now;
  console.warn(`[overlay] ${label}:`, err?.message || err);
}

function guard(label, fn) {
  return (...args) => {
    try {
      const out = fn(...args);
      return out && typeof out.catch === 'function' ? out.catch((err) => report(label, err)) : out;
    } catch (err) {
      report(label, err);
      return undefined;
    }
  };
}

// Espera una promesa, pero no para siempre (err.code queda como code)
function withTimeout(promise, ms, code) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
    timer.unref?.();
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function netOnline() {
  try {
    return require('electron').net.isOnline();
  } catch {
    return true;
  }
}

function coded(key, code, vars) {
  const err = new Error(t(`overlay.${key}`, vars));
  err.code = code;
  return err;
}

// ---------- Estado para la interfaz ----------
function target() {
  return geometry.pickTarget(st.games.values());
}

// Del ayudante que sigue la ventana: 'off' (no hace falta), 'starting' (arrancando o esperando la ventana), 'ok' o 'failed'
function trackerState() {
  if (!st.games.size || !needsTracker()) return 'off';
  const list = [...st.games.values()];
  if (list.some((g) => g.track && g.trackLines > 0)) return 'ok';
  return list.some((g) => g.track || g.retryTimer) ? 'starting' : 'failed';
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
    // Atajos guardados que le sacan teclas a Minecraft o a Windows ('minecraft', 'system', 'altgr'): la tarjeta los avisa
    shortcutIssue: st.cfg.shortcut ? config.shortcutIssue(st.cfg.shortcut) : null,
    panelShortcutIssues: Object.fromEntries(config.SHORTCUT_IDS.map((id) => [id, st.cfg.panelShortcuts[id] ? config.shortcutIssue(st.cfg.panelShortcuts[id]) : null])),
    tracker: trackerState(),
    pageFailed: st.pageFailed,
    panel: st.panel,
    panelShortcuts: st.cfg.panelShortcuts,
    panelShortcutsOk: Object.fromEntries(config.SHORTCUT_IDS.map((id) => [id, st.panelKeys[id].ok])),
    dnd: { on: dndOn(), until: dndOn() && !st.dnd.game ? st.dnd.until : null, game: dndOn() && st.dnd.game, missed: st.dnd.missed },
  };
  if (full) {
    out.config = st.cfg;
    out.defaults = config.DEFAULTS;
    out.presets = config.PRESETS;
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

// La pagina no se pudo abrir (o se cerro sola): se cuenta, y a la tercera vez seguida se deja de insistir
function pageFailure(why) {
  st.pageFails++;
  console.warn(`[overlay] la pagina del overlay fallo (${why})`);
  if (st.pageFails >= PAGE_FAILS_MAX && !st.pageFailed) {
    st.pageFailed = true;
    emitStatus();
  }
}

// Una partida, una prueba o abrir la edicion es un pedido nuevo: se vuelve a intentar abrir la pagina
function retryPage() {
  st.pageFails = 0;
  st.pageFailed = false;
}

function ensureWindow() {
  clearTimeout(st.idleTimer);
  st.idleTimer = null;
  if (alive(st.win) || st.quitting || st.mainGone || st.pageFailed) return st.win;
  const { createOverlayWindow, hwndOf } = require('./overlay/window');
  let win;
  try {
    win = createOverlayWindow();
  } catch (err) {
    pageFailure(err?.message || err);
    return null;
  }
  st.win = win;
  st.winReady = false;
  st.shown = false;
  st.interactive = false;
  st.bounds = null;
  st.winHwnd = hwndOf(win);
  st.lastLayout = '';
  win.on('closed', guard('ventana', () => {
    if (st.win !== win) return;
    clearTimeout(st.readyTimer);
    st.win = null;
    st.winReady = false;
    st.shown = false;
    st.queue = [];
    emitStatus();
  }));
  win.webContents.on('render-process-gone', guard('pagina', (e, details) => {
    if (st.win !== win || win.isDestroyed() || details?.reason === 'clean-exit') return;
    pageFailure('el proceso de la pagina se cerro');
    win.destroy();
  }));
  win.webContents.on('did-fail-load', guard('pagina', (e, code, desc, url, isMainFrame) => {
    if (st.win !== win || win.isDestroyed() || isMainFrame === false || code === -3) return; // -3: carga cancelada (se cerro la ventana)
    pageFailure(`no cargo: ${desc}`);
    win.destroy();
  }));
  // Si la pagina no avisa que esta lista, la ventana queda tapando el juego sin mostrar nada: se descarta y se arma de nuevo
  clearTimeout(st.readyTimer);
  st.readyTimer = setTimeout(guard('pagina', () => {
    if (st.win !== win || st.winReady || win.isDestroyed()) return;
    pageFailure('no aviso que estaba lista');
    win.destroy();
  }), PAGE_READY_MS);
  st.readyTimer.unref?.();
  // El usuario se fue a otra ventana con un panel abierto: se cierra (no puede quedar interactivo por error)
  win.on('blur', guard('ventana', () => {
    if (st.panel && st.win === win && !st.devHold && Date.now() - st.panelAt > PANEL_BLUR_GRACE_MS) closePanel({ refocus: false });
  }));
  // Una pagina colgada con el mouse tomado dejaria al jugador trabado: se sueltan los modos interactivos y se arma de nuevo
  win.on('unresponsive', guard('ventana', () => {
    if (st.win !== win || st.devHold) return;
    closePanel({ refocus: true });
    if (st.editing) stopEdit();
    pageFailure('la pagina dejo de responder');
    if (!win.isDestroyed()) win.destroy();
  }));
  return win;
}

function closeWindow() {
  clearTimeout(st.idleTimer);
  st.idleTimer = null;
  clearTimeout(st.readyTimer);
  if (alive(st.win)) st.win.destroy();
  st.win = null;
  st.winReady = false;
  st.shown = false;
}

function scheduleIdleClose() {
  if (!alive(st.win) || st.idleTimer) return;
  st.idleTimer = setTimeout(guard('ventana', () => {
    st.idleTimer = null;
    if (!wanted()) closeWindow();
  }), IDLE_CLOSE_MS);
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

// La pagina se entera de si la ventana se ve: escondida no corre temporizadores ni redibuja el reloj de la sesion
function setShown(on) {
  if (st.shown === on) return;
  st.shown = on;
  deliver({ kind: 'shown', shown: on });
}

// Con monitores de distinta escala, Electron a veces deja la ventana con otro tamano la primera vez que se la mueve a
// otro monitor: se compara con lo pedido y, si no coincide, se pide de nuevo (hasta dos veces).
function applyBounds(win, bounds) {
  win.setBounds(bounds);
  for (let i = 0; i < 2; i++) {
    let got;
    try {
      got = win.getBounds();
    } catch {
      return;
    }
    if (geometry.nearRect(got, bounds)) return; // un pixel de diferencia es el redondeo de la escala, no el problema
    win.setBounds(bounds);
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
  try {
    evaluateNow();
  } catch (err) {
    report('evaluate', err);
  }
}

function evaluateNow() {
  if (st.quitting) return;
  if (st.devHold) {
    ensureWindow();
    emitStatus();
    return;
  }
  // Los atajos globales siguen al juego: solo estan armados mientras esta adelante (o el overlay en un modo interactivo)
  armShortcut();
  if (st.panel && checkPanelGame()) return;
  if (!wanted()) {
    st.mode = null;
    if (alive(st.win) && st.shown) {
      st.win.hide();
      setShown(false);
    }
    setInteractive(false);
    syncPerf(); // sin overlay no se mide nada
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
      applyBounds(st.win, bounds);
    }
    if (!st.shown) {
      st.win.showInactive();
      st.win.setAlwaysOnTop(true, 'screen-saver');
      st.win.moveTop();
      setShown(true);
    }
  } else if (st.shown) {
    st.win.hide();
    setShown(false);
  }
  setInteractive((st.editing || Boolean(st.panel)) && st.shown);
  if (modeChanged) sendLayout();
  syncPerf();
  emitStatus();
}

// ---------- Widget de rendimiento (3.1) ----------
// Muestras cada 2 s del juego que se sigue (RAM, CPU, ping del servidor y tiempo de sesion), solo mientras el
// overlay y el widget estan activados y hay un juego abierto. El ayudante es barato (overlay/perf.js).
// Oculto con el atajo no hace falta medir (ni abrir el ayudante de PowerShell): al mostrarlo de nuevo vuelve en 2 s.
const perfWanted = () => supported() && !st.quitting && st.cfg.enabled && !st.userHidden && st.cfg.widgets.perf?.enabled !== false && st.games.size > 0;

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
// Con el overlay prendido cuentan desde que se abre el juego, este o no el widget a la vista (leer la fecha de un archivo
// cada 5 s no cuesta nada). Con el overlay apagado no corren: si se prende en medio de una partida, las muertes y los
// bloques se cuentan desde ese momento (la sesion sigue siendo desde que se abrio el juego).
const countersWanted = () => supported() && st.cfg.enabled && !st.quitting;

function syncCounters() {
  const want = countersWanted();
  for (const g of st.games.values()) {
    if (want && !g.counters) startCounters(g);
    else if (!want && g.counters) {
      g.counters.stop();
      g.counters = null;
    }
  }
  if (!want && st.games.size) deliver({ kind: 'counters', deaths: null, mined: null, session: null, multiplayer: false });
  // Los textos del juego (para reconocer las muertes en el registro) se leen recien cuando hacen falta
  if (want) for (const id of st.games.keys()) ensurePlayTables(st.plays.get(id));
}

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
  play.tablesAsked = true;
  loadPlayTables(play).catch((err) => console.warn('[overlay] textos del juego:', err?.message || err));
}

// Solo la primera vez (despues los vuelve a leer onGameLog cuando el juego recarga los recursos)
function ensurePlayTables(play) {
  if (play && !play.tablesAsked) reloadPlayTables(play);
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
    tablesAsked: false,
  };
  st.plays.set(id, play);
  // Con el overlay apagado no se lee nada del disco: se lee si lo prenden durante la partida (syncCounters)
  if (countersWanted()) reloadPlayTables(play);
}

// Muertes en vivo: el mismo lector de registro que los clips automaticos, solo para el jugador local. Apagado, no se lee.
function onGameLog(id, lines) {
  const play = st.plays.get(id);
  if (!play || !Array.isArray(lines) || !countersWanted()) return;
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
  clearTimeout(g.retryTimer);
  g.retryTimer = null;
  g.track = tracker.track({
    pid: g.pid,
    onUpdate: guard('seguimiento', (info) => {
      if (st.games.get(g.id) !== g) return;
      g.trackLines = (g.trackLines || 0) + 1;
      g.trackTries = 0; // si anduvo, una caida de mas adelante vuelve a tener sus tres intentos
      g.info = info;
      evaluate();
    }),
    onEnd: guard('seguimiento', ({ clean } = {}) => {
      if (st.games.get(g.id) !== g) return;
      g.track = null;
      g.info = { found: false };
      // Termino sin su ultima linea (no abrio, PowerShell bloqueado, un antivirus lo cerro): se vuelve a intentar
      if (!clean) retryTracker(g);
      evaluate();
    }),
  });
  if (!g.track) console.warn('[overlay] no se pudo abrir el ayudante que sigue la ventana del juego');
}

function retryTracker(g) {
  if (!needsTracker()) return;
  const tries = g.trackTries || 0;
  if (tries >= TRACKER_RETRY_MS.length) {
    console.warn('[overlay] el ayudante que sigue la ventana del juego se cae siempre: sin overlay en esta partida');
    return;
  }
  g.trackTries = tries + 1;
  clearTimeout(g.retryTimer);
  g.retryTimer = setTimeout(guard('seguimiento', () => {
    g.retryTimer = null;
    if (st.games.get(g.id) !== g || g.track) return;
    startTracker(g);
    evaluate();
  }), TRACKER_RETRY_MS[tries]);
  g.retryTimer.unref?.();
}

function stopTracker(g) {
  clearTimeout(g.retryTimer);
  g.retryTimer = null;
  g.track?.stop();
  g.track = null;
  g.info = { found: false };
}

function syncTrackers() {
  for (const g of st.games.values()) {
    if (needsTracker()) startTracker(g);
    else if (g.track || g.retryTimer) {
      stopTracker(g);
      g.trackLines = 0;
      g.trackTries = 0;
    }
  }
}

function startGame(id, pid, startedAt) {
  const prev = st.games.get(id);
  if (prev?.pid === pid) return;
  if (prev) stopTracker(prev);
  prev?.counters?.stop();
  const g = { id, pid, startedAt: startedAt || Date.now(), info: { found: false }, track: null, counters: null, trackLines: 0, trackTries: 0, retryTimer: null };
  st.games.set(id, g);
  retryPage();
  startTracker(g);
  syncCounters();
  armShortcut();
  evaluate();
}

// Lo que se preparo antes de lanzar (onBeforeLaunch) se tira aunque la partida no haya llegado a abrirse (fallo al lanzar)
function dropPlay(id) {
  clearTimeout(st.plays.get(id)?.langTimer);
  st.plays.delete(id);
}

function stopGame(id) {
  const g = st.games.get(id);
  if (!g) return dropPlay(id);
  stopTracker(g);
  g.counters?.stop();
  st.games.delete(id);
  dropPlay(id);
  // Sin datos, la pagina esconde los contadores
  if (!st.games.size) deliver({ kind: 'counters', deaths: null, mined: null, session: null, multiplayer: false });
  if (!st.games.size) {
    st.userHidden = false;
    if (st.editing && st.mode === 'game') stopEdit();
    if (st.dnd.game) setDnd('off'); // "hasta cerrar el juego"
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
    ok = Boolean(require('electron').globalShortcut.register(accel, guard('atajo', onShortcut)));
  } catch {
    ok = false; // atajo invalido
  }
  st.shortcut = { accel: ok ? accel : null, ok, tried: accel, at: Date.now() };
  return ok;
}

// Los atajos globales le sacan la combinacion a quien este adelante: por eso solo estan armados mientras hay un juego y
// ese juego (o el overlay, en el modo edicion o con un panel) esta adelante. En otra aplicacion no se le roba la tecla.
const shortcutsLive = () => playing() && (st.editing || Boolean(st.panel) || geometry.gameInFront(st.games.values(), st.winHwnd));

// Un atajo que otra aplicacion tiene tomado no se vuelve a probar en cada linea del ayudante, sino cada tanto
const retryDue = (entry, want) => !(entry.ok === false && entry.tried === want && Date.now() - entry.at < SHORTCUT_RETRY_MS);

function armShortcut() {
  const want = shortcutsLive() ? st.cfg.shortcut : '';
  if (want) {
    if (st.shortcut.accel !== want && retryDue(st.shortcut, want)) registerShortcut(want);
  } else {
    unregisterShortcut();
    // Con el juego atras se conserva si se pudo o no tomar (la tarjeta de Ajustes lo avisa); sin juego no hay nada que avisar
    if (!playing() || !st.cfg.shortcut) st.shortcut.ok = true;
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
    ok = Boolean(require('electron').globalShortcut.register(accel, guard('atajo', () => onPanelShortcut(id))));
  } catch {
    ok = false;
  }
  st.panelKeys[id] = { accel: ok ? accel : null, ok, tried: accel, at: Date.now() };
  return ok;
}

function armPanelShortcuts() {
  const live = shortcutsLive();
  for (const id of config.SHORTCUT_IDS) {
    const want = live ? st.cfg.panelShortcuts[id] : '';
    const key = st.panelKeys[id];
    if (want) {
      if (key.accel !== want && retryDue(key, want)) takePanelKey(id, want);
    } else {
      dropPanelKey(id);
      if (!playing() || !st.cfg.panelShortcuts[id]) st.panelKeys[id].ok = true;
    }
  }
}

function onPanelShortcut(id) {
  if (id === 'dnd') return toggleDnd();
  if (st.panel === id) closePanel();
  else openPanel(id);
}

// ---------- No molestar ----------
// Calla los avisos y los mensajes en pantalla un rato (15 min, 1 h o hasta cerrar el juego). Se prende desde Ajustes o con
// su atajo en el juego (ahi es "hasta cerrar el juego"); al terminar, si se perdio algo, un aviso dice cuantos fueron.
const dndOn = () => st.dnd.game || st.dnd.until > Date.now();

function setDnd(mode) {
  const was = st.dnd.game || st.dnd.until > 0; // prendido (o recien vencido: lo apaga su temporizador)
  clearTimeout(st.dnd.timer);
  st.dnd.timer = null;
  const plan = mode === 'off' ? null : config.dndPlan(mode, Date.now());
  if (mode !== 'off' && !plan) return false;
  const missed = st.dnd.missed;
  st.dnd = { until: plan?.until || 0, game: Boolean(plan?.game), missed: plan && was ? missed : 0, timer: null };
  if (plan && !plan.game) {
    st.dnd.timer = setTimeout(guard('no molestar', () => setDnd('off')), Math.max(0, plan.until - Date.now()));
    st.dnd.timer.unref?.();
  }
  // Al prenderlo se va de la pantalla lo que estaba (la pagina vacia avisos, cola y mensajes)
  if (plan && !was) deliver({ kind: 'dnd', on: true });
  if (!plan && was && missed > 0 && playing()) push({ kind: 'alert', icon: 'info', title: t('overlay.dndEndedTitle'), body: t('overlay.dndEndedBody', { count: missed }) });
  emitStatus();
  return true;
}

function toggleDnd() {
  const on = !dndOn();
  setDnd(on ? 'game' : 'off');
  // Desde el juego no se ve Ajustes: un aviso corto (que pasa aunque "No molestar" este prendido) dice como quedo
  const ev = { kind: 'alert', icon: 'info', title: t(on ? 'overlay.dndOnTitle' : 'overlay.dndOffTitle'), ttl: 3 };
  if (on) ev.body = t('overlay.dndOnBody');
  dispatch(events.validate(ev), { bypass: true });
}

// Los atajos de Venus que no son del overlay (silenciar el Voice Chat, capturas y musica), para no pisarlos. Los lee de los
// ajustes de cada modulo con su misma normalizacion; lo que no se pueda leer no cuenta.
async function venusShortcuts() {
  const list = [];
  let s = null;
  try {
    s = await require('../core/settings').get();
  } catch {
    return list;
  }
  const add = (id, accel) => {
    if (typeof accel === 'string' && accel.trim()) list.push({ id, accel: accel.trim() });
  };
  add('voice', s?.voice?.muteShortcut);
  try {
    for (const accel of Object.values(require('./capture/logic').normalizeSettings(s?.capture).shortcuts || {})) add('capture', accel);
  } catch {
    /* sin capturas */
  }
  try {
    const np = require('./nowplaying/config');
    const cfg = np.normalizeConfig(s?.nowplaying);
    if (cfg.shortcuts?.enabled) for (const action of np.SHORTCUT_ACTIONS) add('music', cfg.shortcuts[action]);
  } catch {
    /* sin musica */
  }
  return list;
}

// Que le pasa a un atajo nuevo: null si esta bien, o { code, who? } (codigos en el encabezado). self = cual se esta cambiando
// ('shortcut' o el id de un panel), para no compararlo consigo mismo.
async function shortcutProblem(value, self) {
  if (!config.validAccelerator(value)) return { code: 'invalid' };
  const issue = config.shortcutIssue(value);
  if (issue) return { code: issue };
  const own = [{ key: 'shortcut', accel: st.cfg.shortcut }, ...config.SHORTCUT_IDS.map((p) => ({ key: p, accel: st.cfg.panelShortcuts[p] }))].filter((o) => o.key !== self).map((o) => ({ id: 'overlay', accel: o.accel }));
  const hit = config.findConflict(value, [...own, ...(await venusShortcuts())]);
  return hit ? { code: 'venus', who: hit.id } : null;
}

// Prueba un atajo de panel: si se puede registrar, se guarda (y queda registrado solo si hay un juego adelante).
async function setPanelShortcut(id, accel) {
  if (!config.SHORTCUT_IDS.includes(id)) return { ok: false, shortcut: '', code: 'invalid' };
  const current = st.cfg.panelShortcuts[id];
  if (accel !== undefined && accel !== null && typeof accel !== 'string') return { ok: false, shortcut: current, code: 'invalid' };
  const value = typeof accel === 'string' ? accel.trim() : '';
  if (value) {
    const problem = await shortcutProblem(value, id);
    if (problem) return { ok: false, shortcut: current, ...problem };
  }
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

// Prueba un atajo nuevo: si se puede registrar, se guarda (y queda registrado solo si hay un juego adelante).
async function setShortcut(accel) {
  const current = st.cfg.shortcut;
  if (accel !== undefined && accel !== null && typeof accel !== 'string') return { ok: false, shortcut: current, code: 'invalid' };
  const value = typeof accel === 'string' ? accel.trim() : '';
  if (value) {
    const problem = await shortcutProblem(value, 'shortcut');
    if (problem) return { ok: false, shortcut: current, ...problem };
    const old = st.shortcut.accel;
    unregisterShortcut();
    const ok = registerShortcut(value);
    if (!ok) {
      if (old) registerShortcut(old);
      else st.shortcut = { accel: null, ok: true };
      return { ok: false, shortcut: current, code: 'taken' };
    }
  }
  await require('../core/settings').set({ overlay: { shortcut: value } });
  st.cfg = { ...st.cfg, shortcut: value };
  armShortcut();
  emitStatus();
  return { ok: true, shortcut: value };
}

// ---------- Modo edicion y prueba ----------
// Lo que manda la pagina en el modo edicion (posiciones, tamano, opacidad) se junta unos milisegundos y se guarda de una
// vez (si no, mantener una flecha apretada escribe el archivo de ajustes 30 veces por segundo y cada escritura vuelve a
// mandar el layout a la pagina). Lo de un mismo widget se va sumando.
function queueMove(patch) {
  for (const [id, part] of Object.entries(patch)) st.moves.set(id, { ...st.moves.get(id), ...part });
  clearTimeout(st.moveTimer);
  st.moveTimer = setTimeout(guard('posiciones', flushMoves), MOVE_FLUSH_MS);
  st.moveTimer.unref?.();
}

function flushMoves() {
  clearTimeout(st.moveTimer);
  st.moveTimer = null;
  if (!st.moves.size) return Promise.resolve();
  const patch = Object.fromEntries(st.moves);
  st.moves.clear();
  return require('../core/settings').set({ overlay: { widgets: patch } }).catch((err) => console.warn('[overlay] guardar posicion', err?.message || err));
}

function startEdit() {
  retryPage();
  if (st.panel) closePanel({ refocus: false });
  // Se pide desde Ajustes, con el launcher adelante: se minimiza para que el juego quede a la vista y el overlay
  // pueda tomar el foco (Escape y las flechas andan sin hacer clic antes). Con el overlay apagado el ayudante arranca
  // recien ahora y todavia no informo la ventana: alcanza con que haya un juego abierto.
  const main = st.ctx?.getWindow?.();
  if (!st.editing && (target() || (supported() && st.games.size > 0)) && alive(main) && main.isVisible() && !main.isMinimized()) main.minimize();
  st.editing = true;
  clearTimeout(st.editTimer);
  st.editTimer = setTimeout(guard('edicion', stopEdit), EDIT_MAX_MS);
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
  flushMoves();
  setInteractive(false);
  // Con el overlay apagado el ayudante solo corria para la edicion: se suelta despues de devolver el foco al juego (la
  // orden la manda el ayudante), no antes.
  const late = Boolean(tg && !needsTracker());
  if (!late) syncTrackers();
  evaluate();
  sendLayout();
  if (tg) returnToGame(tg);
  if (late) {
    st.editTimer = setTimeout(guard('edicion', () => {
      st.editTimer = null;
      syncTrackers();
      evaluate();
    }), RETURN_RETRY_MS + 100);
    st.editTimer.unref?.();
  }
}

function startTest(list) {
  retryPage();
  st.testUntil = Date.now() + TEST_MS;
  clearTimeout(st.testTimer);
  st.testTimer = setTimeout(guard('prueba', () => {
    restoreAfterTest();
    syncTrackers();
    evaluate();
  }), TEST_MS + 50);
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
  deliver(st.cache.voice || { kind: 'voice', room: null, self: { muted: false, deafened: false }, members: [] });
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
  st.panelTimer = setTimeout(guard('panel', () => closePanel()), PANEL_MAX_MS);
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
    setTimeout(guard('panel', () => {
      if (st.panel && !front()) game?.track?.front(st.winHwnd);
    }), PANEL_FOCUS_CHECK_MS),
    setTimeout(guard('panel', () => {
      if (!st.panel || front()) return;
      closePanel();
      notice('pn_noFocus');
    }), PANEL_FOCUS_GIVEUP_MS),
  ];
  return true;
}

// De vuelta al juego: la ventana que Windows elige sola al soltar el foco puede ser cualquier otra
function returnToGame(g) {
  // No si en el medio se abrio otro panel o el modo edicion: ahi el foco lo tiene que tener el overlay
  const ask = guard('panel', () => {
    if (!st.panel && !st.editing && st.games.get(g.id) === g && g.info?.hwnd && g.info.foreground !== g.info.hwnd) g.track?.front(g.info.hwnd);
  });
  st.panelFocusTimers.forEach(clearTimeout);
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
    if (play.recipes && play.partialAt && Date.now() - play.partialAt > PARTIAL_RECHECK_MS) {
      play.recipes = null; // faltaban mods por leer: ahora ya deberian estar en la cache
      play.partialAt = 0;
    }
    if (!play.recipes) {
      const lang = play.lang || (await gamelang.readLanguage(play.dir));
      // Con cientos de mods la primera lectura es larga: no se espera para siempre (lo leido queda en la cache y la
      // proxima vez sale enseguida). Si fallo o vencio, se vuelve a pedir en el siguiente intento.
      const pending = withTimeout(recipes.open({ rootId: play.rootId, instanceDir: play.dir, lang, assetIndex: play.assetIndex, mods: true }), RECIPES_MS, 'timeout');
      play.recipes = pending;
      pending.then(
        (session) => {
          if (play.recipes === pending && session?.info?.modsPending > 0) play.partialAt = Date.now();
        },
        () => {
          if (play.recipes === pending) play.recipes = null;
        },
      );
    }
    return play.recipes;
  }
  // Partida sin chequeos previos: la version sale de la instancia
  const inst = await require('../core/instances').get(id);
  return withTimeout(recipes.open({ rootId: inst.mcVersion, instanceDir: inst.dir, lang: await gamelang.readLanguage(inst.dir), mods: true }), RECIPES_MS, 'timeout');
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
  // Sin conexion o con la IA apagada no hace falta preguntarle a la nube (podria tardar): se sabe de entrada. Y si el estado
  // no llega en unos segundos, el panel dice que no esta disponible en vez de quedarse en blanco.
  const enabled = (await require('../core/settings').get()).ai?.enabled !== false;
  const online = netOnline();
  const status = enabled && online ? await withTimeout(assistant.status({}), ASSISTANT_STATUS_MS, 'timeout').catch(() => null) : { enabled };
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
  if (!netOnline()) throw coded('errOffline', 'offline');
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
  // "No molestar": los avisos y los mensajes no se muestran (se cuentan, para decir cuantos fueron al terminar)
  if (!opts.bypass && config.dndSilences(ev) && dndOn()) {
    if (playing()) {
      st.dnd.missed++;
      emitStatus();
    }
    return true;
  }
  deliver(ev, opts);
  return true;
}

// Contrato 1: lo llaman otros modulos del proceso principal. Nunca lanza.
// opts.direct: el aviso es respuesta a algo que hizo el jugador o es critico (modo familia): "No molestar" no lo calla ni
// lo cuenta. Solo desde el proceso principal: el canal overlay:push de la interfaz no lo puede pedir.
function push(ev, opts) {
  try {
    return dispatch(events.validate(ev), opts && opts.direct === true ? { bypass: true } : {});
  } catch (err) {
    console.warn('[overlay] evento descartado:', err?.field || err?.message || err);
    return false;
  }
}

// Cuando la pagina avisa que esta lista: layout, lo ultimo de voz, musica y grabacion, y lo que esperaba.
function onPageReady() {
  clearTimeout(st.readyTimer);
  st.pageFails = 0;
  st.pageFailed = false;
  st.winReady = true;
  sendLayout(true);
  const replay = [st.cache.voice, st.cache.music, st.cache.recording ? { kind: 'capture', type: 'recording-start', at: st.cache.recording.at } : null];
  for (const ev of replay) if (ev) st.win.webContents.send('overlay:event', ev);
  const queued = st.queue.splice(0);
  for (const ev of queued) st.win.webContents.send('overlay:event', ev);
  st.win.webContents.send('overlay:event', { kind: 'shown', shown: st.shown });
  if (st.panel) toPanel({ type: 'open', id: st.panel, key: panelKey() });
}

function onPageMessage(event, msg) {
  if (!alive(st.win) || event.sender?.id !== st.win.webContents.id || !msg || typeof msg !== 'object') return;
  if (msg.type === 'ready') return onPageReady();
  if (msg.type === 'done') return stopEdit();
  if (msg.type === 'panelClose') return closePanel();
  if (!st.editing) return;
  if (msg.type === 'move') {
    const patch = config.positionPatch(msg.id, msg.pos);
    if (patch) queueMove(patch);
  } else if (msg.type === 'tweak') {
    const patch = config.tweakPatch(msg.id, msg.patch);
    if (patch) queueMove(patch);
  } else if (msg.type === 'reset') {
    st.moves.clear();
    clearTimeout(st.moveTimer);
    require('../core/settings').set({ overlay: { widgets: config.resetPatch() } }).catch((err) => console.warn('[overlay] restablecer', err?.message || err));
  }
}

// ---------- Avisos propios: servidores locales y tareas largas mientras se juega ----------
// Sin overlay en esta plataforma (macOS) no se juega "con overlay": ni atajos globales, ni avisos, ni avisos perdidos.
const playing = () => supported() && st.cfg.enabled && st.games.size > 0;

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
    .then(guard('ajustes', (s) => {
      applySettings(s);
      syncTrackers();
      syncCounters();
      armShortcut();
      evaluate();
    }))
    .catch(() => {});

  settings.onChange(guard('ajustes', (s, patch) => {
    if (!patch || !(patch.overlay || patch.language || patch.a11y)) return;
    const before = JSON.stringify(st.cfg);
    applySettings(s, patch);
    if (JSON.stringify(st.cfg) !== before) send?.('overlay:config', st.cfg);
    syncTrackers();
    syncCounters();
    armShortcut();
    sendLayout();
    evaluate();
  }));

  game.events.on('state', guard('juego', (id, s) => {
    if (!s || s.quiet) return; // partidas de prueba: sin overlay
    if (s.state === 'running' && Number.isInteger(s.pid)) startGame(id, s.pid, s.startedAt);
    else if (s.state !== 'running' && s.state !== 'preparing') stopGame(id);
  }));

  ipcMain.on('overlay:page', guard('pagina', onPageMessage));
  ipcMain.handle('overlay:panel', onPanelRequest);
  game.addBeforeLaunch(onBeforeLaunch);
  game.events.on('log', guard('registro', onGameLog));

  // Si se cierra la ventana principal, el overlay no puede dejar el launcher abierto.
  app.on('browser-window-created', (e, w) => {
    setImmediate(() => {
      if (alive(w) && w === getWindow()) w.once('closed', () => {
        st.mainGone = true;
        closeWindow();
      });
    });
  });

  // Cambia la escala o las pantallas (se enchufa un monitor, se cambia la escala de Windows): el rectangulo del juego se
  // vuelve a poner aunque el ayudante no haya notado ningun cambio
  Promise.resolve(app.whenReady?.())
    .then(() => {
      const { screen } = require('electron');
      const events = ['display-metrics-changed', 'display-added', 'display-removed'];
      const refresh = guard('pantallas', () => {
        st.bounds = null;
        evaluate();
      });
      for (const name of events) screen.on(name, refresh);
      st.screenOff = () => events.forEach((name) => screen.removeListener(name, refresh));
    })
    .catch(() => {});

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
  handle('overlay:preset', async (id) => {
    const widgets = config.presetPatch(id);
    if (!widgets) throw coded('errBadPreset', 'invalid');
    await settings.set({ overlay: { widgets } });
    return status();
  });
  handle('overlay:dnd', (mode) => {
    if (!setDnd(mode)) throw coded('errBadDnd', 'invalid');
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
      // size: '1366x768' (por defecto 1280x720): el tamano del "juego" de las capturas
      hold: (size) => {
        st.devHold = true;
        evaluate();
        const m = /^(\d{3,4})x(\d{3,4})$/.exec(String(size || ''));
        st.win?.setBounds?.({ x: 0, y: 0, width: m ? Number(m[1]) : 1280, height: m ? Number(m[2]) : 720 });
        deliver({ kind: 'shown', shown: true }); // oculta, pero la pagina se comporta como si se viera
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
    clearTimeout(st.readyTimer);
    clearTimeout(st.idleTimer);
    clearPanelTimers();
    clearTimeout(st.dnd.timer);
    st.screenOff?.();
    st.screenOff = null;
    flushMoves();
    for (const g of st.games.values()) {
      stopTracker(g);
      g.counters?.stop();
    }
    st.perfSampler?.stop();
    st.perfSampler = null;
    unregisterShortcut();
    config.SHORTCUT_IDS.forEach(dropPanelKey);
    closeWindow();
  });
}

module.exports = { register, push, status };
// Solo para las pruebas (overlay/test/harness.js): el estado interno, para ver lo que no sale por ningun canal
if (process.env.VENUS_OVERLAY_TEST === '1') module.exports.__state = st;
