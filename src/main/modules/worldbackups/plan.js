'use strict';
// Copias automaticas de mundos: cuentas sin Electron ni disco (pruebas en test/plan.test.js).
//   normalize(raw)          -> ajustes validos de settings.backups.schedule
//   intervalMs(cfg)         -> cada cuanto toca una copia
//   wants(cfg, instanceId)  -> ¿esta instancia entra en las copias automaticas?
//   needsCopy({ cfg, reason, lastAt, modifiedAt, now }) -> ¿hay que copiar este mundo ahora?
//   rotationVictims(list, keep) -> copias automaticas que sobran (una manual nunca esta en esta lista)
const HOUR = 60 * 60 * 1000;
const FREQUENCIES = ['hours', 'daily', 'weekly'];
const DEFAULTS = Object.freeze({ enabled: false, frequency: 'daily', everyHours: 6, keep: 5, instances: 'all', onGameClose: false });
const EVERY_MIN = 1;
const EVERY_MAX = 168;
const KEEP_MIN = 1;
const KEEP_MAX = 100;

const clampInt = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

function normalize(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(r.instances) ? [...new Set(r.instances.filter((i) => typeof i === 'string' && i))].slice(0, 500) : 'all';
  return {
    enabled: r.enabled === true,
    frequency: FREQUENCIES.includes(r.frequency) ? r.frequency : DEFAULTS.frequency,
    everyHours: clampInt(r.everyHours, EVERY_MIN, EVERY_MAX, DEFAULTS.everyHours),
    keep: clampInt(r.keep, KEEP_MIN, KEEP_MAX, DEFAULTS.keep),
    instances: list,
    onGameClose: r.onGameClose === true,
  };
}

function intervalMs(cfg) {
  if (cfg.frequency === 'hours') return cfg.everyHours * HOUR;
  return (cfg.frequency === 'weekly' ? 7 * 24 : 24) * HOUR;
}

const wants = (cfg, instanceId) => cfg.instances === 'all' || cfg.instances.includes(instanceId);

// Fecha en la que toca la proxima copia de un mundo cuya ultima copia automatica es lastAt (0 = ya, nunca se copio).
const nextDueAt = (cfg, lastAt) => (lastAt > 0 ? lastAt + intervalMs(cfg) : 0);

/**
 * reason: 'schedule' (por la hora) o 'close' (se acaba de cerrar el juego).
 * Un mundo que no cambio desde su ultima copia automatica no se copia: varias copias iguales empujarian afuera, por la
 * rotacion, a las viejas que sirven de verdad. Al cerrar el juego tambien vale lo programado que quedo esperando.
 */
function needsCopy({ cfg, reason = 'schedule', lastAt = 0, modifiedAt = 0, now = Date.now() }) {
  if (!cfg.enabled) return false;
  if (lastAt > 0 && modifiedAt <= lastAt) return false;
  if (reason === 'close' && cfg.onGameClose) return true;
  return now >= nextDueAt(cfg, lastAt);
}

// list: copias de UN mundo, de cualquier tipo. Quedan las `keep` automaticas mas nuevas.
function rotationVictims(list, keep) {
  const autos = (Array.isArray(list) ? list : []).filter((b) => b && b.auto === true).sort((a, b) => b.time - a.time);
  return autos.slice(Math.max(KEEP_MIN, keep));
}

module.exports = { DEFAULTS, FREQUENCIES, EVERY_MIN, EVERY_MAX, KEEP_MIN, KEEP_MAX, normalize, intervalMs, wants, nextDueAt, needsCopy, rotationVictims };
