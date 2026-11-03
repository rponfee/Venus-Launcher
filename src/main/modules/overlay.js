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
// Eventos a la interfaz: overlay:state (lo mismo que status, sin config ni defaults) y overlay:config (la
// configuracion normalizada cada vez que cambia, por ejemplo al mover un widget en el modo edicion).
// La pagina del overlay (renderer/overlay.html) habla solo por su preload (overlay/preload.js).
const { t } = require('../core/i18n');
const config = require('./overlay/config');
const events = require('./overlay/events');
const geometry = require('./overlay/geometry');
const tracker = require('./overlay/tracker');
const perf = require('./overlay/perf');

const TEST_MS = 9000;
const EDIT_MAX_MS = 15 * 60 * 1000; // el modo edicion se apaga solo (la ventana no puede quedar tomando el mouse)
const IDLE_CLOSE_MS = 60000; // sin juego ni prueba la ventana se cierra para no ocupar memoria
const CAPTURE_DEDUPE_MS = 5000;
const TASK_MIN_MS = 10000; // tareas largas que terminan mientras se juega
const QUEUE_MAX = 40;

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
  lastLayout: '',
  lastStatus: '',
  quitting: false,
  mainGone: false,
};

const supported = () => process.platform === 'win32';
const testing = () => Date.now() < st.testUntil;
const wanted = () => st.editing || testing() || (st.cfg.enabled && supported() && st.games.size > 0);
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
  const d = geometry.decide({ enabled: st.cfg.enabled, userHidden: st.userHidden, editing: st.editing, testing: testing(), target: tg, overlayHwnd: st.winHwnd });
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
  setInteractive(st.editing && st.shown);
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
      onSample: (ev) => {
        if (st.perfSampler?.pid === game.pid) push(ev);
      },
    });
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
  const g = { id, pid, startedAt: startedAt || Date.now(), info: { found: false }, track: null };
  st.games.set(id, g);
  startTracker(g);
  armShortcut();
  evaluate();
}

function stopGame(id) {
  const g = st.games.get(id);
  if (!g) return;
  g.track?.stop();
  st.games.delete(id);
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
}

function onShortcut() {
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
  st.editing = false;
  clearTimeout(st.editTimer);
  st.editTimer = null;
  setInteractive(false);
  syncTrackers();
  evaluate();
  sendLayout();
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
}

function onPageMessage(event, msg) {
  if (!alive(st.win) || event.sender?.id !== st.win.webContents.id || !msg || typeof msg !== 'object') return;
  if (msg.type === 'ready') return onPageReady();
  if (msg.type === 'done') return stopEdit();
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

  onQuit?.(() => {
    st.quitting = true;
    clearTimeout(st.testTimer);
    clearTimeout(st.editTimer);
    for (const g of st.games.values()) g.track?.stop();
    st.perfSampler?.stop();
    st.perfSampler = null;
    unregisterShortcut();
    closeWindow();
  });
}

module.exports = { register, push, status, onStreamerChange };
