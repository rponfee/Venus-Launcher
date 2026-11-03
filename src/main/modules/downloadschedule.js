'use strict';
// Descargas programadas (3.1): fuera de la franja horaria elegida las descargas quedan en pausa (core/http
// pause/resume) y adentro se reanudan solas. "Bajar ahora" levanta la pausa por 2 horas. Se revisa cada minuto y
// al cambiar el ajuste. Ajustes en settings.downloads.schedule (downloadschedule/window.js).
//   downloads:scheduleStatus()  -> { enabled, from, to, inWindow, allowed, override, nextChangeAt, pausedBySchedule,
//                                    overrideUntil, paused }
//   downloads:scheduleNow()     -> status (permite bajar durante 2 horas aunque sea fuera de la franja)
//   downloads:scheduleReset()   -> status (vuelve a respetar la franja)
// Evento downloads:schedule (el mismo estado) cada vez que cambia.
// Una pausa que puso el usuario desde Descargas no se toca; si el usuario reanuda a mano fuera de la franja, vale
// como "Bajar ahora".
const win = require('./downloadschedule/window');

const OVERRIDE_MS = 2 * 60 * 60 * 1000;
const CHECK_MS = 60 * 1000;

const st = { ctx: null, cfg: win.normalize(null), pausedBySchedule: false, overrideUntil: 0, timer: null, lastEmitted: '' };

function http() {
  return require('../core/http');
}

function status() {
  const d = win.decide({ cfg: st.cfg, overrideUntil: st.overrideUntil });
  return { ...d, pausedBySchedule: st.pausedBySchedule, overrideUntil: st.overrideUntil || null, paused: http().isPaused() };
}

function emit() {
  const s = status();
  const key = JSON.stringify(s);
  if (key === st.lastEmitted) return;
  st.lastEmitted = key;
  st.ctx?.send?.('downloads:schedule', s);
}

// Corazon del modulo: con la hora, la franja y la pausa actual decide si pausar o reanudar.
function check() {
  const h = http();
  if (st.overrideUntil && Date.now() >= st.overrideUntil) st.overrideUntil = 0;
  const d = win.decide({ cfg: st.cfg, overrideUntil: st.overrideUntil });
  if (d.allowed) {
    if (st.pausedBySchedule) {
      st.pausedBySchedule = false;
      if (h.isPaused()) h.resume();
    }
  } else if (st.pausedBySchedule) {
    if (!h.isPaused()) {
      // El usuario reanudo a mano desde Descargas: vale como "Bajar ahora".
      st.pausedBySchedule = false;
      st.overrideUntil = Date.now() + OVERRIDE_MS;
    }
  } else if (!h.isPaused()) {
    h.pause();
    st.pausedBySchedule = true;
  }
  emit();
}

function downloadNow() {
  st.overrideUntil = Date.now() + OVERRIDE_MS;
  check();
  return status();
}

function reset() {
  st.overrideUntil = 0;
  check();
  return status();
}

function register({ handle, send, onQuit }) {
  st.ctx = { send };
  const settings = require('../core/settings');
  settings
    .get()
    .then((s) => {
      st.cfg = win.normalize(s?.downloads?.schedule);
      check();
    })
    .catch((err) => console.warn('[downloadschedule] ajustes', err?.message || err));
  settings.onChange((s, patch) => {
    if (!patch?.downloads || !('schedule' in patch.downloads)) return;
    st.cfg = win.normalize(s?.downloads?.schedule);
    check();
  });
  // Si el usuario reanuda desde Descargas mientras la franja esta cerrada, se entera enseguida.
  try {
    http().events?.on('stats', (s) => {
      if (st.pausedBySchedule && s && !s.paused) check();
    });
  } catch {
    /* sin descargas: nada que programar */
  }
  st.timer = setInterval(check, CHECK_MS);
  st.timer.unref?.();

  handle('downloads:scheduleStatus', () => status());
  handle('downloads:scheduleNow', () => downloadNow());
  handle('downloads:scheduleReset', () => reset());

  onQuit?.(() => {
    clearInterval(st.timer);
    st.timer = null;
  });
}

module.exports = { register, status, check, downloadNow, reset, OVERRIDE_MS, CHECK_MS };
