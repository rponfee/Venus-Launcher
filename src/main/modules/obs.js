'use strict';
// Integracion con OBS (obs-websocket v5), apagada por defecto. Con el interruptor prendido se conecta a OBS en esta PC o en
// la red local y cambia a la escena elegida al abrir y al cerrar el juego. Si OBS no esta abierto,
// reintenta con espera creciente sin avisar nada. La contraseña va cifrada (core/secure) y nunca vuelve a la interfaz.
//
// Canales: obs:status() -> estado · obs:test({ host, port, password? }) -> { ok, version, scenes, current, streaming, recording } o error con code
//   obs:setPassword(texto | null)
// Evento: obs:state (lo mismo que obs:status).
// Ajustes: settings.obs (obs/logic.js). Guia: docs/implementacion/clips.md.
const settings = require('../core/settings');
const secure = require('../core/secure');
const game = require('../core/game');
const { t } = require('../core/i18n');
const { ObsClient } = require('./obs/client');
const logic = require('./obs/logic');

const SECRET_KEY = 'obs.password';

let ctx = null;
let cfg = logic.normalizeSettings({});
let client = null;
let state = 'off'; // off | connecting | connected | waiting | authFailed
let lastError = null;
let attempt = 0;
let retryTimer = null;
let generation = 0;
let info = { version: null, scenes: [], current: null, streaming: false, recording: false };
let hasPassword = false;

const send = (...a) => ctx?.send?.(...a);

function view() {
  return { enabled: cfg.enabled, state, error: lastError, host: cfg.host, port: cfg.port, hasPassword, ...info };
}

function emit() {
  send('obs:state', view());
}

function setState(next, error = null) {
  state = next;
  lastError = error;
  emit();
}

function dropClient() {
  const c = client;
  client = null;
  if (c) {
    c.removeAllListeners();
    c.close();
  }
}

function resetInfo() {
  info = { version: null, scenes: [], current: null, streaming: false, recording: false };
}

// ---------- Conexion ----------

function scheduleRetry() {
  clearTimeout(retryTimer);
  if (!cfg.enabled) return;
  const delay = logic.backoff(attempt++);
  retryTimer = setTimeout(() => connect(), delay);
  retryTimer.unref?.();
}

function onEvent(type, data) {
  if (type === 'StreamStateChanged') {
    info.streaming = data.outputActive === true;
    emit();
  } else if (type === 'RecordStateChanged') {
    info.recording = data.outputActive === true;
    emit();
  } else if (type === 'CurrentProgramSceneChanged') {
    info.current = data.sceneName || null;
    emit();
  } else if (type === 'SceneListChanged' || type === 'SceneNameChanged') {
    refreshScenes().catch(() => {});
  } else if (type === 'ExitStarted') {
    // OBS se esta cerrando: el cierre llega enseguida y reintenta solo
    info.streaming = false;
    info.recording = false;
    emit();
  }
}

async function refreshScenes() {
  if (!client?.identified) return view();
  const { scenes, current } = await client.sceneList();
  info.scenes = scenes;
  info.current = current;
  emit();
  return view();
}

async function connect() {
  clearTimeout(retryTimer);
  if (!cfg.enabled) return;
  const gen = ++generation;
  dropClient();
  setState('connecting');
  const password = hasPassword ? (await secure.get(SECRET_KEY).catch(() => null)) || '' : '';
  if (gen !== generation) return;
  const c = new ObsClient({ host: cfg.host, port: cfg.port, password });
  client = c;
  try {
    const hello = await c.connect();
    if (gen !== generation) return c.close();
    attempt = 0;
    info.version = hello.obsWebSocketVersion;
    c.on('event', onEvent);
    c.on('close', () => {
      if (client !== c) return;
      dropClient();
      setState('waiting');
      scheduleRetry();
    });
    const [scenes, outputs] = await Promise.all([c.sceneList(), c.outputs()]);
    if (gen !== generation) return c.close();
    info.scenes = scenes.scenes;
    info.current = scenes.current;
    info.streaming = outputs.streaming;
    info.recording = outputs.recording;
    setState('connected');
    // Si ya hay un juego abierto al conectar, la escena de abrir tambien vale
    if (runningGames().length) await applyScene('open');
  } catch (err) {
    if (gen !== generation) return;
    dropClient();
    if (err?.code === 'auth' || err?.code === 'authRequired') {
      // Con la contraseña mal, reintentar no sirve: se espera a que la cambien
      setState('authFailed', err.code);
      return;
    }
    setState('waiting', err?.code === 'version' ? 'version' : null);
    scheduleRetry();
  }
}

function disconnect() {
  generation += 1;
  clearTimeout(retryTimer);
  dropClient();
  resetInfo();
  attempt = 0;
  setState('off');
}

// ---------- Escenas ----------

const runningGames = (exceptId) =>
  Object.entries(game.status() || {})
    .filter(([id, g]) => id !== exceptId && g?.state === 'running' && !g.quiet)
    .map(([id]) => id);

async function applyScene(event, exceptId) {
  const scene = logic.sceneFor(event, cfg, { othersRunning: runningGames(exceptId).length > 0 });
  if (!scene || !client?.identified) return;
  try {
    await client.setScene(scene);
  } catch (err) {
    // La escena se borro o se renombro en OBS: no se avisa con un error en pleno juego
    console.warn('[obs] escena:', err?.message || err);
  }
}

function onGameState(id, st) {
  if (!st || st.quiet || !cfg.enabled) return;
  if (st.state === 'running') applyScene('open');
  else if (st.state === 'stopped' || st.state === 'crashed') applyScene('close', id);
}

// ---------- Ajustes ----------

function applySettings(raw) {
  const prev = cfg;
  cfg = logic.normalizeSettings(raw);
  const changed = prev.host !== cfg.host || prev.port !== cfg.port;
  if (!cfg.enabled) {
    if (prev.enabled || state !== 'off') disconnect();
    return;
  }
  if (!prev.enabled || changed || state === 'off') {
    attempt = 0;
    connect();
    return;
  }
  emit();
}

// ---------- Probar ----------

function errorText(code) {
  const key = { auth: 'errObsAuth', authRequired: 'errObsNeedPassword', timeout: 'errObsTimeout', version: 'errObsVersion' }[code] || 'errObsRefused';
  return t(`clipstudio.${key}`);
}

async function test(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const host = String(o.host ?? cfg.host).trim();
  if (!logic.isLocalHost(host)) throw Object.assign(new Error(t('clipstudio.errObsHost')), { code: 'host' });
  const port = logic.normalizeSettings({ port: o.port }).port;
  const password = typeof o.password === 'string' && o.password ? o.password : hasPassword ? (await secure.get(SECRET_KEY).catch(() => null)) || '' : '';
  const c = new ObsClient({ host, port, password });
  try {
    const hello = await c.connect();
    const [scenes, outputs] = await Promise.all([c.sceneList(), c.outputs()]);
    return { ok: true, version: hello.obsWebSocketVersion, scenes: scenes.scenes, current: scenes.current, ...outputs };
  } catch (err) {
    throw Object.assign(new Error(errorText(err?.code)), { code: err?.code || 'refused' });
  } finally {
    c.close();
  }
}

// ---------- Registro ----------

function register(c) {
  ctx = c;
  const { handle, onQuit } = c;

  Promise.all([settings.get(), secure.has(SECRET_KEY).catch(() => false)])
    .then(([s, has]) => {
      hasPassword = Boolean(has);
      applySettings(s?.obs);
    })
    .catch(() => {});
  settings.onChange((s, patch) => {
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'obs')) applySettings(s?.obs);
  });
  game.events.on('state', onGameState);

  handle('obs:status', () => view());
  handle('obs:test', (o) => test(o));
  handle('obs:setPassword', async (value) => {
    const text = typeof value === 'string' ? value.slice(0, 256) : '';
    if (text) await secure.set(SECRET_KEY, text);
    else await secure.remove(SECRET_KEY);
    hasPassword = Boolean(text);
    if (cfg.enabled) {
      attempt = 0;
      connect();
    } else emit();
    return view();
  });

  onQuit(() => {
    generation += 1;
    clearTimeout(retryTimer);
    dropClient();
  });
}

module.exports = { register };
