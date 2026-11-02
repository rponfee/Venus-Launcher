'use strict';
// Música: controla Spotify (gratis o Premium) y cualquier reproductor que use los controles multimedia de
// Windows (YouTube Music, Apple Music, navegadores...) desde el launcher y mientras se juega. No usa la Web API
// de Spotify (sus controles exigen Premium): un ayudante de PowerShell lee SMTC y el mezclador de volumen de
// Windows (nowplaying/script.js). El ayudante se abre solo cuando hace falta (la interfaz pidió el estado hace
// menos de 45 s o hay un juego abierto con la música en el overlay (settings.nowplaying.overlay y el widget de
// música de settings.overlay) o los atajos activos), se cierra solo y se
// reabre con espera creciente si se cae. Solo Windows: en otras plataformas todo responde "no disponible".
//
// Canales:
//  nowplaying:state({ retry? }?) -> vista: { available, reason (null, 'platform' o 'unsupported'), status ('idle',
//      'starting', 'ready', 'retrying', 'stopping' o 'unsupported'), retryAt, loaded, state (abajo) o null,
//      can: { play, pause, toggle, next, prev, seek }, volume: { available, level (0 a 1), muted },
//      source: { choice, id, missing }, sessions, overlay, shortcuts: { enabled, items: [{ action, accel, state }] },
//      spotify: { installed } }. Renueva el pedido de la interfaz (la interfaz lo llama cada 15 s mientras se ve).
//  nowplaying:control(acción, valor?) -> vista. Acciones: toggle, play, pause, next, prev, stop, forward y back
//      (valor = ms, 10 s por defecto), seek (valor = ms desde el principio), mute (valor = bool o alternar),
//      volumeUp y volumeDown (valor = paso de 0 a 1, 5 % por defecto).
//  nowplaying:setVolume(nivel 0 a 1) -> vista (volumen de la app en el mezclador de Windows).
//  nowplaying:sources() -> { choice, loaded, list: [{ id, appName, source, title, artist, playing, system, selected }] }
//  nowplaying:openSpotify() -> true (abre la app de Spotify; err.code 'noSpotify' si no está instalada)
//  Evento nowplaying:update (vista) cuando cambia algo que se ve.
// Errores con err.code: platform, unsupported, unavailable, noSession, rejected, noSeek, noAudio, noSpotify,
//  badAction, timeout.
//
// Para otros módulos: getState() -> { title, artist, album, art (data: URL chica o null), playing, position,
// duration (ms), source ('spotify', 'apple-music', 'youtube-music', 'browser', 'media-player' u 'other'), appName,
// appId, status, positionAt (epoch ms de position), canSeek } o null, y events ('update', mismo estado). Además
// se avisa al overlay con require('./overlay').push({ kind: 'music', state }) cuando cambia la canción o el estado.
// Ajustes: settings.nowplaying (nowplaying/config.js). La clave vieja `music` no se usa.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { t } = require('../core/i18n');
const settings = require('../core/settings');
const { normalizeConfig, planShortcuts, VOICE_DEFAULT_SHORTCUT, SHORTCUT_ACTIONS } = require('./nowplaying/config');
const { createController, ACTIONS } = require('./nowplaying/controller');
const { Helper } = require('./nowplaying/helper');

const events = new EventEmitter();
let controller = null;

// Estado de la canción para otros módulos (overlay): null si no hay nada o no está disponible
function getState() {
  try {
    return controller ? controller.getState() : null;
  } catch {
    return null;
  }
}

const ERROR_CODES = new Set(['platform', 'unsupported', 'unavailable', 'noSession', 'rejected', 'noSeek', 'noAudio', 'noSpotify', 'badAction', 'timeout']);
function npError(code) {
  const c = ERROR_CODES.has(code) ? code : 'failed';
  const err = new Error(t(`nowplaying.err_${c}`));
  err.code = c === 'failed' ? 'unavailable' : c;
  return err;
}

// Overlay (otro módulo; puede no existir todavía)
let overlayMod;
function overlay() {
  if (overlayMod === undefined) {
    try {
      overlayMod = require('./overlay');
    } catch (err) {
      overlayMod = null;
      if (err?.code !== 'MODULE_NOT_FOUND') console.warn('[nowplaying] overlay', err?.message || err);
    }
  }
  return overlayMod && typeof overlayMod.push === 'function' ? overlayMod : null;
}
function pushOverlay(evt) {
  const o = overlay();
  if (!o) return;
  try {
    o.push(evt);
  } catch (err) {
    console.warn('[nowplaying] overlay', err?.message || err);
  }
}

function register({ app, handle, send, onQuit }) {
  const isWin = process.platform === 'win32';
  let cfg = normalizeConfig({});
  let voiceAccel = '';
  let overlayWidget = true; // overlay del juego encendido y con el widget de música (settings.overlay, módulo overlay)
  let closed = false;
  const running = new Set(); // instancias con el juego abierto (sin las partidas de prueba)
  let registered = []; // atajos propios registrados
  let shortcutItems = SHORTCUT_ACTIONS.map((action) => ({ action, accel: '', state: 'off' }));
  let spotifyCache = null;
  let settingsTimer = null;
  let startupTimer = null;

  const helper = isWin
    ? new Helper({
        spawn: (...args) => require('child_process').spawn(...args),
        command: () => require('./nowplaying/script').command({ parentPid: process.pid }),
      })
    : null;

  function spotifyInstalled() {
    if (!isWin) return false;
    const nowMs = Date.now();
    if (spotifyCache && nowMs - spotifyCache.at < 60000) return spotifyCache.value;
    let value = false;
    try {
      value = Boolean(app.getApplicationNameForProtocol('spotify://'));
    } catch {
      value = false;
    }
    if (!value) {
      const dirs = [process.env.APPDATA && path.join(process.env.APPDATA, 'Spotify', 'Spotify.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'Spotify.exe')];
      value = dirs.some((p) => {
        try {
          return Boolean(p) && fs.existsSync(p);
        } catch {
          return false;
        }
      });
    }
    spotifyCache = { at: nowMs, value };
    return value;
  }

  const fullView = (v = controller.view()) => {
    const installed = spotifyInstalled() || Boolean(v.state && v.state.source === 'spotify');
    return { ...v, shortcuts: { enabled: cfg.shortcuts.enabled, items: shortcutItems }, spotify: { installed } };
  };

  controller = createController({
    helper,
    makeError: npError,
    onChange: (v, { uiChanged, overlayChanged, state }) => {
      if (closed) return;
      if (uiChanged) send('nowplaying:update', fullView(v));
      if (overlayChanged) {
        events.emit('update', state);
        if (cfg.overlay) pushOverlay({ kind: 'music', state });
      }
    },
  });

  // ---------- Juego abierto: el ayudante queda abierto si hay overlay de música o atajos ----------
  function syncGame() {
    const needs = running.size > 0 && ((cfg.overlay && overlayWidget && Boolean(overlay())) || cfg.shortcuts.enabled);
    controller.setGameActive(needs);
  }

  let game = null;
  const onGameState = (id, st) => {
    if (closed || st?.quiet) return; // partidas de prueba (búsqueda del mod culpable)
    if (st?.state === 'running') running.add(id);
    else if (st?.state === 'stopped' || st?.state === 'crashed' || st?.state === 'idle') running.delete(id);
    syncGame();
  };
  if (isWin) {
    try {
      game = require('../core/game');
      game.events.on('state', onGameState);
      for (const [id, st] of Object.entries(game.status() || {})) if (st?.state === 'running' && !st.quiet) running.add(id);
    } catch (err) {
      console.warn('[nowplaying] juego', err?.message || err);
    }
  }

  // ---------- Atajos globales (desactivados por defecto) ----------
  function unregisterShortcuts() {
    if (!registered.length) return;
    let globalShortcut = null;
    try {
      ({ globalShortcut } = require('electron'));
    } catch {
      globalShortcut = null;
    }
    for (const accel of registered) {
      try {
        globalShortcut?.unregister(accel);
      } catch {
        /* ya no estaba */
      }
    }
    registered = [];
  }

  function applyShortcuts() {
    if (closed) return;
    unregisterShortcuts();
    const plan = planShortcuts(cfg.shortcuts, { reserved: [voiceAccel, VOICE_DEFAULT_SHORTCUT] });
    if (!isWin || !cfg.shortcuts.enabled) {
      shortcutItems = plan.map((p) => ({ action: p.action, accel: p.accel, state: p.skip === 'empty' ? 'empty' : 'off' }));
      return;
    }
    let globalShortcut = null;
    try {
      ({ globalShortcut } = require('electron'));
    } catch {
      globalShortcut = null;
    }
    shortcutItems = plan.map((p) => {
      if (p.skip) return { action: p.action, accel: p.accel, state: p.skip };
      if (!globalShortcut) return { action: p.action, accel: p.accel, state: 'inUse' };
      try {
        // Ya registrado por otra parte del launcher (Voice Chat, capturas...): no se le pisa
        if (globalShortcut.isRegistered(p.accel)) return { action: p.action, accel: p.accel, state: 'reserved' };
        const ok = globalShortcut.register(p.accel, () => runShortcut(p.action));
        if (ok) registered.push(p.accel);
        return { action: p.action, accel: p.accel, state: ok ? 'ok' : 'inUse' };
      } catch {
        return { action: p.action, accel: p.accel, state: 'invalid' };
      }
    });
  }

  async function runShortcut(action) {
    if (closed) return;
    const map = { playPause: 'toggle', next: 'next', prev: 'prev', volumeUp: 'volumeUp', volumeDown: 'volumeDown' };
    const playing = running.size > 0;
    controller.touch(30000);
    try {
      const v = await controller.control(map[action]);
      // En el juego, el overlay muestra el volumen nuevo (la canción ya la avisa el estado)
      if (playing && (action === 'volumeUp' || action === 'volumeDown') && v.volume.available) {
        const title = v.volume.muted ? t('nowplaying.alertMuted') : t('nowplaying.alertVolume', { value: Math.round((v.volume.level || 0) * 100) });
        pushOverlay({ kind: 'alert', title, icon: 'music', ttl: 1500 });
      }
    } catch (err) {
      if (playing && err?.code === 'noSession') pushOverlay({ kind: 'alert', title: t('nowplaying.err_noSession'), icon: 'music', ttl: 2500 });
      else if (err?.code !== 'noSession') console.warn('[nowplaying] atajo', action, err?.code || err?.message || err);
    }
  }

  // ---------- Ajustes ----------
  function readOthers(s) {
    voiceAccel = typeof s?.voice?.muteShortcut === 'string' ? s.voice.muteShortcut : '';
    overlayWidget = s?.overlay?.enabled !== false && s?.overlay?.widgets?.music?.enabled !== false;
  }

  function applySettings(s) {
    if (closed) return;
    const prevOverlay = cfg.overlay;
    cfg = normalizeConfig(s?.nowplaying);
    readOthers(s);
    controller.setConfig(cfg);
    applyShortcuts();
    syncGame();
    // Overlay apagado: que deje de mostrar la canción
    if (prevOverlay && !cfg.overlay) pushOverlay({ kind: 'music', state: null });
    send('nowplaying:update', fullView());
  }

  // Los atajos se registran un poco después de arrancar, cuando main.js ya registró el del Voice Chat
  settings
    .get()
    .then((s) => {
      cfg = normalizeConfig(s?.nowplaying);
      readOthers(s);
      controller.setConfig(cfg);
      syncGame();
      startupTimer = setTimeout(() => settings.get().then(applySettings).catch(() => {}), 2500);
    })
    .catch((err) => console.warn('[nowplaying] ajustes', err?.message || err));

  const offSettings = settings.onChange((s, patch) => {
    if (!patch || !('nowplaying' in patch || 'voice' in patch || 'overlay' in patch || 'language' in patch)) return;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => settings.get().then(applySettings).catch((err) => console.warn('[nowplaying] ajustes', err?.message || err)), 60);
  });

  // ---------- Canales ----------
  handle('nowplaying:state', (opts) => {
    if (opts && typeof opts === 'object' && opts.retry === true) controller.retry();
    controller.touch();
    return fullView();
  });

  handle('nowplaying:control', async (action, value) => {
    if (typeof action !== 'string' || !ACTIONS.has(action)) throw npError('badAction');
    const arg = typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
    return fullView(await controller.control(action, arg));
  });

  handle('nowplaying:setVolume', async (level) => fullView(await controller.setVolume(level)));

  handle('nowplaying:sources', () => {
    controller.touch();
    return controller.sources();
  });

  handle('nowplaying:openSpotify', async () => {
    if (!isWin) throw npError('platform');
    if (!spotifyInstalled() && controller.getState()?.source !== 'spotify') throw npError('noSpotify');
    const { shell } = require('electron');
    await shell.openExternal('spotify:');
    return true;
  });

  onQuit(async () => {
    closed = true;
    clearTimeout(settingsTimer);
    clearTimeout(startupTimer);
    offSettings();
    if (game) game.events.off('state', onGameState);
    unregisterShortcuts();
    controller.dispose();
    if (helper && helper.running) {
      const exited = new Promise((resolve) => helper.once('exit', resolve));
      helper.stop();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2500))]);
    }
  });
}

module.exports = { register, getState, events };
