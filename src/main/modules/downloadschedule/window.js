'use strict';
// Franja horaria de las descargas programadas (settings.downloads.schedule). Sin Electron: lo usan el modulo y
// las pruebas de downloadschedule/test/.
//   schedule: { enabled: false, from: '02:00', to: '08:00' }   (hora local; si `to` es menor que `from`, la franja
//   cruza la medianoche; si son iguales, la franja es todo el dia)

const DEFAULTS = Object.freeze({ enabled: false, from: '02:00', to: '08:00' });
const DAY = 24 * 60;

// 'HH:MM' -> minutos desde la medianoche, o null.
function parseClock(s) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}

function fmtClock(minutes) {
  const m = ((Math.round(minutes) % DAY) + DAY) % DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// settings.downloads.schedule (cualquier cosa) -> { enabled, from, to } validos.
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const from = parseClock(r.from);
  const to = parseClock(r.to);
  return {
    enabled: r.enabled === true,
    from: from === null ? DEFAULTS.from : fmtClock(from),
    to: to === null ? DEFAULTS.to : fmtClock(to),
  };
}

const minutesOfDay = (date) => date.getHours() * 60 + date.getMinutes();

// Esta el minuto `m` (0 a 1439) dentro de la franja [from, to)? Cruza la medianoche si to < from.
function inWindow(m, from, to) {
  const a = parseClock(from);
  const b = parseClock(to);
  if (a === null || b === null) return true;
  if (a === b) return true; // franja de todo el dia
  return a < b ? m >= a && m < b : m >= a || m < b;
}

// Proximo cambio de estado (entrar o salir de la franja) como Date, a partir de `date`.
function nextChange(date, from, to) {
  const a = parseClock(from);
  const b = parseClock(to);
  if (a === null || b === null || a === b) return null;
  const now = minutesOfDay(date);
  const inside = inWindow(now, from, to);
  const target = inside ? b : a;
  let delta = target - now;
  if (delta <= 0) delta += DAY;
  const out = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  out.setMinutes(now + delta);
  return out;
}

// Decision completa: { enabled, from, to, inWindow, allowed, override, nextChangeAt }.
// overrideUntil: epoch ms hasta el que "Bajar ahora" permite descargar fuera de la franja.
function decide({ now = new Date(), cfg, overrideUntil = 0 } = {}) {
  const c = normalize(cfg);
  const date = now instanceof Date ? now : new Date(now);
  const inside = c.enabled ? inWindow(minutesOfDay(date), c.from, c.to) : true;
  const override = Boolean(overrideUntil) && date.getTime() < overrideUntil;
  const next = c.enabled ? nextChange(date, c.from, c.to) : null;
  return {
    enabled: c.enabled,
    from: c.from,
    to: c.to,
    inWindow: inside,
    override,
    allowed: !c.enabled || inside || override,
    nextChangeAt: next ? next.getTime() : null,
  };
}

module.exports = { DEFAULTS, DAY, parseClock, fmtClock, normalize, minutesOfDay, inWindow, nextChange, decide };
