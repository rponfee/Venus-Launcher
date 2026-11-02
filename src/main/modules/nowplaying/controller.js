'use strict';
// Estado de Música en el proceso principal: junta lo que manda el ayudante (sesiones, portadas y mezclador),
// elige la sesión que se controla, arma la vista para la interfaz y el estado para el overlay, y decide cuándo
// tiene que estar abierto el ayudante (la interfaz lo pidió hace poco o hay un juego con overlay o atajos).
// Sin Electron: el ayudante, el reloj y los temporizadores se inyectan (las pruebas usan uno falso).
const { chooseSession, matchAudio, audioSummary, buildState, stateChanged, sourcesList, trackTiming } = require('./sessions');
const { normalizeConfig, VOLUME_STEP, SEEK_STEP } = require('./config');

const ACTIONS = new Set(['toggle', 'play', 'pause', 'next', 'prev', 'stop', 'seek', 'forward', 'back', 'mute', 'volumeUp', 'volumeDown']);
const VOLUME_ACTIONS = new Set(['mute', 'volumeUp', 'volumeDown']);

function defaultError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function createController({ helper = null, now = Date.now, timers = { setTimeout, clearTimeout }, makeError = defaultError, onChange = () => {}, uiLeaseMs = 45000, readyWaitMs = 9000, emitDelayMs = 120, log = (...a) => console.warn('[nowplaying]', ...a) } = {}) {
  let cfg = normalizeConfig({});
  let sessions = [];
  let systemId = '';
  let receivedAt = 0;
  let loaded = false; // llegó al menos una lista de sesiones desde que se abrió el ayudante
  const arts = new Map(); // id de sesión -> { key, data }
  let audio = [];
  let selected = null;
  let leaseUntil = 0;
  let gameActive = false;
  let demandTimer = null;
  let emitTimer = null;
  let disposed = false;
  let lastSig = '';
  let lastUiState = null;
  let lastOverlay = null;
  const waiters = new Set();

  const select = () => {
    selected = chooseSession(sessions, { choice: cfg.source, systemId, prevId: selected?.id || '' });
  };

  // Portada de la canción actual (la de la canción anterior no se muestra mientras llega la nueva)
  function artFor(s) {
    const a = s ? arts.get(s.id) : null;
    if (!a) return null;
    return !a.key || !s.key || a.key === s.key ? a.data : null;
  }

  function getState() {
    return selected ? buildState(selected, { art: artFor(selected), now: now(), receivedAt }) : null;
  }

  const audioOfSelected = () => audioSummary(selected ? matchAudio(selected.app || selected.id, audio) : []);

  const pinnedMissing = () => cfg.source !== 'auto' && cfg.source !== 'system' && loaded && !sessions.some((s) => s.id === cfg.source || s.app === cfg.source);

  function view() {
    const info = helper ? helper.info() : { status: 'idle', retryAt: 0 };
    const unsupported = info.status === 'unsupported';
    const state = getState();
    const vol = audioOfSelected();
    const s = selected;
    return {
      available: Boolean(helper) && !unsupported,
      reason: !helper ? 'platform' : unsupported ? 'unsupported' : null,
      status: info.status,
      retryAt: info.retryAt || 0,
      loaded,
      state,
      can: {
        play: Boolean(s?.canPlay),
        pause: Boolean(s?.canPause),
        toggle: Boolean(s && (s.canToggle || s.canPlay || s.canPause)),
        next: Boolean(s?.canNext),
        prev: Boolean(s?.canPrev),
        seek: Boolean(state?.canSeek),
      },
      volume: { available: vol.available, level: vol.level, muted: vol.muted },
      source: { choice: cfg.source, id: s?.id || null, missing: pinnedMissing() },
      sessions: sessions.length,
      overlay: cfg.overlay,
    };
  }

  // Firma de la vista sin la posición (que avanza sola): solo se avisa si cambió algo más o la posición saltó
  const signature = (v) => JSON.stringify({ ...v, state: v.state ? { ...v.state, position: 0, positionAt: 0 } : null });

  function changed() {
    if (disposed || emitTimer) return;
    emitTimer = timers.setTimeout(() => {
      emitTimer = null;
      if (disposed) return;
      const v = view();
      const t = now();
      const sig = signature(v);
      const uiChanged = sig !== lastSig || stateChanged(lastUiState, v.state, t);
      const overlayChanged = stateChanged(lastOverlay, v.state, t);
      if (uiChanged) {
        lastSig = sig;
        lastUiState = v.state;
      }
      if (overlayChanged) lastOverlay = v.state;
      if (!uiChanged && !overlayChanged) return;
      try {
        onChange(v, { uiChanged, overlayChanged, state: v.state });
      } catch (err) {
        log('aviso', err?.message || err);
      }
    }, emitDelayMs);
  }

  function settle(kind, err) {
    for (const w of [...waiters]) {
      if (!err && w.kind !== kind) continue;
      waiters.delete(w);
      timers.clearTimeout(w.timer);
      if (err) w.reject(err);
      else w.resolve();
    }
  }

  function clearData() {
    sessions = [];
    systemId = '';
    audio = [];
    arts.clear();
    loaded = false;
    selected = null;
  }

  function onMessage(msg) {
    if (msg.t === 'sessions') {
      sessions = msg.list;
      systemId = msg.system;
      receivedAt = now();
      loaded = true;
      for (const id of [...arts.keys()]) if (!sessions.some((s) => s.id === id)) arts.delete(id);
      select();
      settle('loaded');
      changed();
    } else if (msg.t === 'art') {
      arts.set(msg.id, { key: msg.key, data: msg.data });
      if (selected && msg.id === selected.id) changed();
    } else if (msg.t === 'audio') {
      audio = msg.list;
      changed();
    } else if (msg.t === 'log') {
      log('ayudante:', msg.msg);
    }
  }

  const onStatus = (status) => {
    if (status === 'unsupported') settle(null, makeError('unsupported'));
    changed();
  };
  const onExit = () => {
    clearData();
    changed();
  };

  if (helper) {
    helper.on('message', onMessage);
    helper.on('status', onStatus);
    helper.on('exit', onExit);
  }

  // ---------- Cuándo tiene que estar abierto el ayudante ----------
  function evaluate() {
    if (!helper || disposed) return;
    if (demandTimer) timers.clearTimeout(demandTimer);
    demandTimer = null;
    const left = leaseUntil - now();
    if (gameActive || left > 0) {
      helper.start();
      if (!gameActive) demandTimer = timers.setTimeout(evaluate, left + 50);
    } else if (helper.running || helper.status === 'retrying') {
      helper.stop();
    }
  }

  // La interfaz (o un atajo) lo necesita durante los próximos `ms`
  function touch(ms = uiLeaseMs) {
    leaseUntil = Math.max(leaseUntil, now() + ms);
    evaluate();
  }

  function setGameActive(active) {
    const next = Boolean(active);
    if (next === gameActive) return;
    gameActive = next;
    evaluate();
  }

  function setConfig(raw) {
    const prev = cfg;
    cfg = normalizeConfig(raw);
    if (prev.source !== cfg.source) select();
    changed();
  }

  // Espera a que el ayudante esté listo y haya mandado las sesiones (la primera vez tarda 1 o 2 segundos)
  function ready() {
    if (!helper) return Promise.reject(makeError('platform'));
    if (helper.status === 'unsupported') return Promise.reject(makeError('unsupported'));
    if (helper.status === 'ready' && loaded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { kind: 'loaded', resolve, reject, timer: null };
      w.timer = timers.setTimeout(() => {
        waiters.delete(w);
        reject(makeError('unavailable'));
      }, readyWaitMs);
      waiters.add(w);
    });
  }

  async function run(cmd, args) {
    let res;
    try {
      res = await helper.request(cmd, args);
    } catch (err) {
      throw makeError(err?.code === 'timeout' ? 'timeout' : 'unavailable');
    }
    if (!res.ok) throw makeError(['noSession', 'noAudio', 'timeout'].includes(res.error) ? res.error : 'rejected');
    return res;
  }

  // Cambios locales mientras llega lo que confirma el ayudante (así la interfaz responde enseguida)
  function patchSession(id, patch) {
    sessions = sessions.map((s) => (s.id === id ? { ...s, ...patch } : s));
    if (selected?.id === id) selected = sessions.find((s) => s.id === id) || selected;
    changed();
  }
  function patchAudio(pids, patch) {
    const set = new Set(pids);
    audio = audio.map((a) => (set.has(a.pid) ? { ...a, ...patch } : a));
    changed();
  }

  async function applyVolume(target, vol) {
    const level = Math.round(clamp01(target) * 100) / 100;
    await run('setVolume', { pids: vol.pids, volume: level });
    patchAudio(vol.pids, { volume: level });
    // Como el mezclador de Windows: subir el volumen de una app silenciada le saca el silencio
    if (vol.muted && level > 0) {
      await run('setMute', { pids: vol.pids, muted: false });
      patchAudio(vol.pids, { muted: false });
    }
  }

  async function control(action, value) {
    if (!ACTIONS.has(action)) throw makeError('badAction');
    if (!helper) throw makeError('platform');
    touch();
    await ready();
    const s = selected;
    if (!s) throw makeError('noSession');
    if (VOLUME_ACTIONS.has(action)) {
      const vol = audioOfSelected();
      if (!vol.available) throw makeError('noAudio');
      if (action === 'mute') {
        const muted = typeof value === 'boolean' ? value : !vol.muted;
        await run('setMute', { pids: vol.pids, muted });
        patchAudio(vol.pids, { muted });
      } else {
        const step = Number(value) > 0 && Number(value) <= 1 ? Number(value) : VOLUME_STEP;
        await applyVolume((vol.level ?? 0) + (action === 'volumeUp' ? step : -step), vol);
      }
      return view();
    }
    if (action === 'seek' || action === 'forward' || action === 'back') {
      const { position, duration } = trackTiming(s, now(), receivedAt);
      if (!s.canSeek || duration <= 0) throw makeError('noSeek');
      const step = Number(value) > 0 ? Number(value) : SEEK_STEP;
      let target = action === 'seek' ? Number(value) : position + (action === 'forward' ? step : -step);
      if (!Number.isFinite(target)) throw makeError('badAction');
      // Hasta medio segundo antes del final (llegar justo al final salta a la siguiente en algunas apps)
      target = Math.max(0, Math.min(Math.max(0, duration - 500), Math.round(target)));
      const absolute = (s.start || 0) + target;
      await run('seek', { id: s.id, position: absolute });
      patchSession(s.id, { position: absolute, updated: now() });
      return view();
    }
    let cmd = action;
    // Si la app no ofrece "alternar", se manda play o pausa según cómo está
    if (action === 'toggle' && !s.canToggle) cmd = s.status === 4 ? 'pause' : 'play';
    await run(cmd, { id: s.id });
    if (cmd === 'play' || cmd === 'pause') patchSession(s.id, { status: cmd === 'play' ? 4 : 5, position: s.start + trackTiming(s, now(), receivedAt).position, updated: now() });
    return view();
  }

  async function setVolume(level) {
    const v = Number(level);
    if (!Number.isFinite(v)) throw makeError('badAction');
    if (!helper) throw makeError('platform');
    touch();
    await ready();
    if (!selected) throw makeError('noSession');
    const vol = audioOfSelected();
    if (!vol.available) throw makeError('noAudio');
    await applyVolume(v, vol);
    return view();
  }

  function sources() {
    return { choice: cfg.source, loaded, list: sourcesList(sessions, { selectedId: selected?.id || '', systemId }) };
  }

  function retry() {
    if (!helper) return false;
    touch();
    return helper.retryNow();
  }

  function dispose() {
    disposed = true;
    if (demandTimer) timers.clearTimeout(demandTimer);
    if (emitTimer) timers.clearTimeout(emitTimer);
    demandTimer = null;
    emitTimer = null;
    settle(null, makeError('unavailable'));
    if (helper) {
      helper.off('message', onMessage);
      helper.off('status', onStatus);
      helper.off('exit', onExit);
    }
  }

  return { view, getState, control, setVolume, sources, touch, setGameActive, setConfig, retry, dispose, get config() { return cfg; } };
}

module.exports = { createController, ACTIONS };
