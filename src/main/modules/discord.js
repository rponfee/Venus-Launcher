'use strict';
// Discord Rich Presence: muestra en tu perfil de Discord si estás en el launcher o jugando
// (instancia, versión y loader, mundo o servidor, tiempo de juego y botones opcionales).
// Usa el Application ID público configurado en Ajustes, o el ID incluido por el dueño del launcher.
// Sin ID se muestra la guía de configuración, sin publicar ninguna actividad. No utiliza tokens.
// La conexión es por el IPC local de Discord (./discord/ipc.js).
// Canales: discord:status, discord:configure, discord:reconnect, discord:test · Evento: discord:statusChanged
const { t } = require('../core/i18n');
const settings = require('../core/settings');
const appConfig = require('../core/app-config');
const { PresenceManager } = require('./discord/presence');
const { resolveConfig, validateClientIdInput, buildActivity, testActivity, validClientId, ASSET_KEY } = require('./discord/activity');
const { fetchAppInfo, cached } = require('./discord/appinfo');

function register({ app, handle, send, onQuit }) {
  const game = require('../core/game');
  const instances = require('../core/instances');
  const appVersion = app.getVersion();
  const launcherStartedAt = Date.now();
  const manager = new PresenceManager({ t });
  const sessions = new Map(); // instanceId -> { state, startedAt, instance }
  const sessionGenerations = new Map();
  let closed = false;
  let settingsTimer = null;
  const activities = new Map(); // instanceId -> última actividad recibida (menú, mundo, servidor)
  // Ajustes del usuario (activar, privacidad, botones) + el Application ID del launcher
  const readConfig = (s) => resolveConfig(s, appConfig.get().discordClientId);
  let cfg = readConfig({});
  let preview = null; // lo que se muestra (o se mostraría si estuviera activado)
  let appCheck = null; // promesa en curso de fetchAppInfo

  const userAgent = () => {
    try {
      return require('../core/http').getUserAgent();
    } catch {
      return 'VenusLauncher';
    }
  };

  const appInfo = () => (validClientId(cfg.clientId) ? cached(cfg.clientId) : null);

  const fullStatus = () => ({
    ...manager.status(),
    available: validClientId(cfg.clientId),
    clientId: cfg.clientId,
    clientIdSource: cfg.clientIdSource,
    bundledClientId: appConfig.get().discordClientId,
    app: appInfo(),
    preview,
    playing: currentSession() !== null,
    assetKey: ASSET_KEY,
  });

  const emitStatus = () => send('discord:statusChanged', fullStatus());
  manager.on('status', emitStatus);

  // Partida que se muestra: la que empezó más recientemente (si hay varias abiertas)
  function currentSession() {
    let best = null;
    for (const [id, s] of sessions) {
      if (!best || (s.state === 'running' && best.state !== 'running') || (s.state === best.state && (s.startedAt || 0) > (best.startedAt || 0))) best = { id, ...s };
    }
    if (!best) return null;
    let activity = activities.get(best.id) || null;
    if (!activity) {
      try {
        activity = game.activity(best.id);
      } catch {
        activity = null;
      }
    }
    return { state: best.state, startedAt: best.startedAt, instance: best.instance, activity };
  }

  function recompute() {
    try {
      // null si no hay nada para mostrar (por ejemplo, fuera del juego con "mostrar en el launcher" apagado)
      preview = buildActivity({ cfg, session: currentSession(), t, appVersion, launcherStartedAt, asset: appInfo()?.hasAsset === true ? ASSET_KEY : null });
      manager.setDesired(cfg.enabled ? preview : null);
    } catch (err) {
      console.warn('[discord] actividad', err.message);
    }
    emitStatus();
  }

  // Valida el Application ID con Discord (nombre de la app y si tiene la imagen "venus")
  function checkApp(force = false) {
    if (!validClientId(cfg.clientId)) return Promise.resolve(null);
    if (appCheck?.id === cfg.clientId && !force) return appCheck.promise;
    const id = cfg.clientId;
    const check = { id, promise: null };
    check.promise = fetchAppInfo(id, { userAgent: userAgent(), force })
      .then((info) => {
        if (!closed && cfg.clientId === id) recompute();
        return info;
      })
      .catch(() => null)
      .finally(() => {
        if (appCheck === check) appCheck = null;
      });
    appCheck = check;
    return check.promise;
  }

  async function applySettings(s) {
    if (closed) return;
    const prevId = cfg.clientId;
    cfg = readConfig(s);
    manager.configure(cfg);
    recompute();
    if (cfg.clientId !== prevId && validClientId(cfg.clientId)) checkApp();
  }

  settings
    .get()
    .then(applySettings)
    .catch((err) => console.warn('[discord] ajustes', err.message));

  // Ajustes: settings:set dispara onChange antes de cambiar el idioma; se espera un instante
  const offSettings = settings.onChange((s, patch) => {
    if (!patch || !('discord' in patch || 'language' in patch)) return;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => settings.get().then(applySettings).catch((err) => console.warn('[discord]', err.message)), 60);
  });

  const onState = async (id, st) => {
    if (closed || st?.quiet) return; // pruebas del buscador de mods culpables
    const generation = (sessionGenerations.get(id) || 0) + 1;
    sessionGenerations.set(id, generation);
    try {
      if (st?.state === 'preparing' || st?.state === 'running') {
        const prev = sessions.get(id);
        const instance = prev?.instance || (await instances.get(id).catch(() => null));
        if (closed || sessionGenerations.get(id) !== generation) return;
        sessions.set(id, { state: st.state, startedAt: st.startedAt || prev?.startedAt || Date.now(), instance });
      } else {
        sessions.delete(id);
        activities.delete(id);
      }
      recompute();
    } catch (err) {
      console.warn('[discord] estado del juego', err.message);
    }
  };
  const onActivity = (id, act, meta) => {
    if (closed || act?.quiet || meta?.quiet) return;
    if (act) activities.set(id, act);
    else activities.delete(id);
    recompute();
  };
  game.events.on('state', onState);
  game.events.on('activity', onActivity);

  handle('discord:status', () => {
    if (validClientId(cfg.clientId) && !appInfo()) checkApp();
    return fullStatus();
  });

  handle('discord:configure', async (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'clientId')) throw new Error(t('discord.errClientIdFormat'));
    let clientId;
    try { clientId = validateClientIdInput(input.clientId); }
    catch { throw new Error(t('discord.errClientIdFormat')); }
    const saved = await settings.set({ discord: { clientId } });
    await applySettings(saved);
    return fullStatus();
  });

  handle('discord:reconnect', async () => {
    await manager.reconnect();
    return fullStatus();
  });

  // Muestra una actividad de prueba durante unos segundos
  handle('discord:test', async () => {
    const info = validClientId(cfg.clientId) ? await checkApp(true) : null;
    if (info && info.valid === false) throw new Error(t('discord.errInvalidClient'));
    await manager.test(testActivity({ cfg, t, appVersion, asset: info?.hasAsset === true ? ASSET_KEY : null }));
    return fullStatus();
  });

  onQuit(() => {
    closed = true;
    clearTimeout(settingsTimer);
    offSettings();
    game.events.off('state', onState);
    game.events.off('activity', onActivity);
    manager.removeListener('status', emitStatus);
    return manager.shutdown();
  });
}

module.exports = { register };
