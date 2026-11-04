'use strict';
// Modo familia: el motor que mira las partidas y aplica las reglas. Sin Electron: recibe todo lo que usa, asi se prueba
// con un juego de mentira (test/engine.test.js). Cuenta el tiempo una sola vez aunque haya dos juegos abiertos y vive en
// el proceso principal: recargar la interfaz o tener la ventana escondida no cambia nada.
//   createEngine({ game, getData, saveUsage, notify, closeGame, now, tickMs, setTimer, clearTimer })
//     -> { start, stop, reload, resetUsage, step, status, canLaunch, extend, allowServer }
const logic = require('./logic');

const SAVE_EVERY_MS = 30 * 1000;

function createEngine({ game, getData, saveUsage, notify, closeGame, now = () => Date.now(), tickMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const st = { usage: logic.createUsage(null, now()), tick: logic.createTickState(), timer: null, playing: new Set(), servers: new Map(), allowedSession: new Set(), lastSave: 0, offs: [] };

  const config = () => {
    const d = getData();
    return d?.enabled ? logic.normalizeConfig(d.config) : null;
  };

  const running = () => [...st.playing];

  function persist(force = false) {
    const t = now();
    if (!force && t - st.lastSave < SAVE_EVERY_MS) return;
    st.lastSave = t;
    const { day, usedMs, extendUntil } = st.usage;
    Promise.resolve(saveUsage({ day, usedMs: Math.round(usedMs), extendUntil })).catch((err) => console.warn('[family] guardar:', err?.message || err));
  }

  function step() {
    const cfg = config();
    const t = now();
    if (!cfg) {
      st.usage.last = t;
      return;
    }
    const playing = st.playing.size > 0;
    logic.advance(st.usage, t, playing);
    for (const ev of logic.tick(st.tick, st.usage, cfg, { now: t, playing })) {
      if (ev.type === 'close') {
        notify({ kind: 'closing', reason: ev.reason });
        for (const id of running()) closeGame(id, ev.reason);
      } else notify({ kind: ev.type, reason: ev.reason, endsAt: ev.endsAt, minutes: ev.minutes });
    }
    if (playing) persist();
  }

  function clearServer(id) {
    const s = st.servers.get(id);
    if (s) clearTimer(s.timer);
    st.servers.delete(id);
  }

  function onLog(id, lines) {
    const cfg = config();
    if (!cfg?.servers.enabled || !st.playing.has(id)) return;
    for (const line of lines || []) {
      const addr = logic.parseConnect(line?.text);
      if (!addr) continue;
      const text = addr.port === 25565 ? addr.host : `${addr.host}:${addr.port}`;
      if (logic.serverAllowed(cfg.servers.list, addr) || st.allowedSession.has(text)) {
        clearServer(id);
        continue;
      }
      if (st.servers.has(id)) continue;
      const endsAt = now() + logic.SERVER_GRACE_MS;
      const timer = setTimer(() => {
        st.servers.delete(id);
        notify({ kind: 'serverClosing', instanceId: id, address: text });
        closeGame(id, 'server');
      }, logic.SERVER_GRACE_MS);
      timer?.unref?.();
      st.servers.set(id, { timer, address: text, endsAt });
      notify({ kind: 'server', instanceId: id, address: text, endsAt });
    }
  }

  function onState(id, state) {
    if (state?.quiet) return;
    if (state?.state === 'running') {
      st.playing.add(id);
      step();
    } else if (state?.state === 'stopped' || state?.state === 'crashed') {
      st.playing.delete(id);
      clearServer(id);
      step();
      if (!st.playing.size) persist(true);
    }
  }

  return {
    start() {
      const d = getData();
      st.usage = logic.createUsage(d?.usage, now());
      game.events.on('state', onState);
      game.events.on('log', onLog);
      st.offs.push(() => game.events.off('state', onState), () => game.events.off('log', onLog));
      st.timer = setInterval(() => {
        try {
          step();
        } catch (err) {
          console.warn('[family]', err?.message || err);
        }
      }, tickMs);
      st.timer.unref?.();
    },
    stop() {
      clearInterval(st.timer);
      st.timer = null;
      for (const id of [...st.servers.keys()]) clearServer(id);
      st.offs.splice(0).forEach((off) => off());
      persist(true);
    },
    // Cambio de opciones: se revisa ya (puede haberse agotado o haberse extendido el tiempo).
    reload() {
      const cfg = config();
      if (!cfg?.servers.enabled) for (const id of [...st.servers.keys()]) clearServer(id);
      if (!cfg) {
        const was = st.tick.phase;
        st.tick = logic.createTickState();
        if (was === 'countdown') notify({ kind: 'cancelled' });
        return;
      }
      step();
    },
    resetUsage() {
      st.usage = logic.createUsage(null, now());
      persist(true);
    },
    step,
    status() {
      const cfg = config();
      const t = now();
      if (!cfg) return { playing: st.playing.size > 0, phase: 'idle' };
      logic.advance(st.usage, t, st.playing.size > 0);
      const r = logic.remaining(st.usage, cfg, t);
      const win = logic.windowInfo(cfg.schedule, t);
      return {
        playing: st.playing.size > 0,
        usedMs: Math.round(st.usage.usedMs),
        remainingMs: r.ms === Infinity ? null : r.ms,
        reason: r.reason,
        insideWindow: win.inside,
        opensAt: win.opensAt,
        extendUntil: st.usage.extendUntil > t ? st.usage.extendUntil : 0,
        phase: st.tick.phase,
        countdownEndsAt: st.tick.phase === 'countdown' ? st.tick.endsAt : 0,
        servers: [...st.servers.entries()].map(([instanceId, s]) => ({ instanceId, address: s.address, endsAt: s.endsAt })),
      };
    },
    // Chequeo antes de jugar: { ok } o { ok: false, reason, opensAt }
    canLaunch() {
      const cfg = config();
      if (!cfg) return { ok: true };
      const t = now();
      logic.advance(st.usage, t, st.playing.size > 0);
      return logic.canLaunch(st.usage, cfg, t);
    },
    extend(minutes) {
      const t = now();
      const mins = Math.max(1, Math.min(12 * 60, Math.round(Number(minutes) || 0)));
      st.usage.extendUntil = Math.max(st.usage.extendUntil, t) + mins * logic.MIN;
      persist(true);
      step();
      return st.usage.extendUntil;
    },
    // Permitir para esta sesion el servidor que se esta por cerrar
    allowServer(instanceId) {
      const s = st.servers.get(instanceId);
      if (!s) return null;
      st.allowedSession.add(s.address);
      clearServer(instanceId);
      notify({ kind: 'serverAllowed', instanceId, address: s.address });
      return s.address;
    },
  };
}

module.exports = { createEngine };
