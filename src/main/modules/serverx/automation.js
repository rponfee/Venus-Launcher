'use strict';
// Automatizacion de servidores mientras el launcher esta abierto: iniciar junto con el launcher,
// reinicio automatico si el servidor se cae, reinicios y copias programadas, y aplicar al iniciar
// las gamerules que quedaron pendientes.
const servers = require('../../core/servers');
const tasks = require('../../core/tasks');
const { t } = require('../../core/i18n');
const world = require('./world');
const gamerules = require('./gamerules');

const DEFAULTS = {
  autoRestart: false,
  autostart: false,
  restart: { mode: 'off', hours: 6, time: '05:00', warn: true },
  backup: { mode: 'off', hours: 6, time: '04:00', keep: 5 },
};
const CRASH_WINDOW = 10 * 60 * 1000;
const MAX_CRASH_RESTARTS = 3;

const crashes = new Map(); // id -> [fechas de caidas]
const done = new Map(); // "<id>:<accion>" -> dia (AAAA-MM-DD) de la ultima ejecucion diaria
const working = new Set(); // "<id>:<accion>" en curso
let timer = null;
let notify = () => {};

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  return out;
}

const config = (s) => merge(DEFAULTS, s.automation || {});
const today = () => new Date().toISOString().slice(0, 10);
const hhmm = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function startServer(s, title) {
  return tasks.run(title || t('servers.taskStart', { name: s.name }), (task) => servers.start(s.id, task), { serverId: s.id }).finally(() => notify());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function applyPending(id) {
  let s;
  try {
    s = await servers.get(id);
  } catch {
    return;
  }
  const pending = s.pendingGamerules;
  if (!pending || !Object.keys(pending).length) return;
  const cmds = gamerules.commands(pending, s.mcVersion);
  for (const c of cmds) {
    try {
      servers.command(id, c);
    } catch {
      return;
    }
  }
  await servers.patchMeta(id, { pendingGamerules: null }).catch(() => {});
  servers.venusLog(id, t('servers.logPendingRules', { count: cmds.length }));
  notify();
}

async function onState(id, st) {
  if (st.state === 'online') {
    applyPending(id).catch((err) => console.warn('[serverx] gamerules pendientes', err));
    return;
  }
  if (st.state !== 'offline' || !st.crashed) return;
  let s;
  try {
    s = await servers.get(id);
  } catch {
    return;
  }
  if (!config(s).autoRestart) return;
  const now = Date.now();
  const list = (crashes.get(id) || []).filter((ts) => now - ts < CRASH_WINDOW);
  list.push(now);
  crashes.set(id, list);
  if (list.length > MAX_CRASH_RESTARTS) {
    servers.venusLog(id, t('servers.logCrashLoop', { count: MAX_CRASH_RESTARTS }), 'ERROR');
    return;
  }
  servers.venusLog(id, t('servers.logAutoRestart', { seconds: 10 }), 'WARN');
  await sleep(10000);
  if (servers.isRunning(id)) return;
  startServer(s, t('servers.taskRestart', { name: s.name })).catch(() => {});
}

// Reinicio programado: avisa en el chat un minuto antes si hay jugadores conectados.
async function scheduledRestart(s, cfg) {
  const key = `${s.id}:restart`;
  if (working.has(key)) return;
  working.add(key);
  try {
    if (cfg.restart.warn !== false && s.players?.length) {
      servers.command(s.id, `say ${t('servers.sayRestart', { seconds: 60 })}`);
      await sleep(50000);
      if (!servers.isRunning(s.id)) return;
      servers.command(s.id, `say ${t('servers.sayRestart', { seconds: 10 })}`);
      await sleep(10000);
    }
    if (!servers.isRunning(s.id)) return;
    servers.venusLog(s.id, t('servers.logScheduledRestart'));
    await tasks.run(t('servers.taskRestart', { name: s.name }), (task) => servers.restart(s.id, task), { serverId: s.id });
  } catch (err) {
    console.warn('[serverx] reinicio programado', err);
  } finally {
    working.delete(key);
    notify();
  }
}

async function scheduledBackup(s, cfg) {
  const key = `${s.id}:backup`;
  if (working.has(key)) return;
  working.add(key);
  try {
    await tasks.run(t('servers.taskBackup', { name: s.name }), (task) => world.backup(s.id, { auto: true, task }), { serverId: s.id });
    await servers.patchMeta(s.id, { lastBackupAt: Date.now() });
    await world.pruneAuto(s.id, Math.max(1, Math.min(100, Number(cfg.backup.keep) || 5)));
  } catch (err) {
    console.warn('[serverx] copia programada', err);
  } finally {
    working.delete(key);
    notify();
  }
}

async function tick() {
  let list = [];
  try {
    list = await servers.list();
  } catch {
    return;
  }
  const now = Date.now();
  for (const s of list) {
    const cfg = config(s);
    // Reinicios: solo con el servidor en linea.
    if (s.state === 'online' && cfg.restart.mode !== 'off') {
      const hours = Math.max(1, Number(cfg.restart.hours) || 6);
      if (cfg.restart.mode === 'interval' && s.startedAt && now - s.startedAt >= hours * 3600 * 1000) scheduledRestart(s, cfg);
      if (cfg.restart.mode === 'daily' && cfg.restart.time === hhmm() && done.get(`${s.id}:restart`) !== today() && s.startedAt && now - s.startedAt > 120000) {
        done.set(`${s.id}:restart`, today());
        scheduledRestart(s, cfg);
      }
    }
    // Copias: con el servidor encendido o, si esta apagado, solo si el mundo cambio desde la ultima.
    if (cfg.backup.mode !== 'off' && (s.state === 'online' || s.state === 'offline')) {
      const last = s.lastBackupAt || 0;
      const changed = s.state === 'online' || (s.lastStopped || 0) > last;
      if (cfg.backup.mode === 'interval') {
        const hours = Math.max(1, Number(cfg.backup.hours) || 6);
        if (changed && now - Math.max(last, s.created || 0) >= hours * 3600 * 1000) scheduledBackup(s, cfg);
      } else if (cfg.backup.mode === 'daily' && cfg.backup.time === hhmm() && done.get(`${s.id}:backup`) !== today()) {
        done.set(`${s.id}:backup`, today());
        if (changed) scheduledBackup(s, cfg);
      }
    }
  }
}

async function autostart() {
  let list = [];
  try {
    list = await servers.list();
  } catch {
    return;
  }
  for (const s of list) {
    if (!config(s).autostart || s.state !== 'offline') continue;
    startServer(s).catch((err) => console.warn('[serverx] inicio automatico', err?.message || err));
  }
}

function init({ onChange } = {}) {
  if (onChange) notify = onChange;
  servers.events.on('state', (id, st) => {
    onState(id, st).catch((err) => console.warn('[serverx] automatizacion', err));
  });
  timer = setInterval(() => tick().catch(() => {}), 30000);
  setTimeout(() => autostart().catch(() => {}), 5000);
}

function shutdown() {
  clearInterval(timer);
  timer = null;
}

module.exports = { init, shutdown, DEFAULTS, config, tick, applyPending };
