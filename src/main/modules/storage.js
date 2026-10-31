'use strict';
// Almacenamiento y descargas:
//  - downloads:*  estado en vivo (y evento downloads:stats cada segundo mientras hay descargas), pausa global,
//                 limite de velocidad, descargas simultaneas y modo sin conexion (el motor esta en core/http.js).
//  - storage:*    uso del disco por categoria, archivos repetidos entre instancias y servidores (enlaces duros
//                 a <datos>/store), unificacion automatica y limpieza con vista previa.
const paths = require('../core/paths');
const settings = require('../core/settings');
const tasks = require('../core/tasks');
const http = require('../core/http');
const { readJson, writeJson } = require('../core/util');
const { t } = require('../core/i18n');
const dedupe = require('./storage/dedupe');
const usage = require('./storage/usage');
const cleanup = require('./storage/cleanup');
const { createAuto } = require('./storage/auto');

const STATUS_FILE = () => paths.data('storage.json');

let send = () => {};
let busyOp = null;
let lastScan = null;

// Una sola operacion de almacenamiento a la vez (analizar, unificar, limpiar).
async function exclusive(name, fn) {
  if (busyOp) throw new Error(t('storage.errBusy'));
  busyOp = name;
  try {
    return await fn();
  } finally {
    busyOp = null;
  }
}

function runningTasks() {
  return tasks.list().filter((x) => x.state === 'running');
}

function gamesOrServersRunning() {
  try {
    if (Object.keys(require('../core/game').status()).length) return true;
  } catch {
    /* sin juego */
  }
  try {
    if (require('../core/servers').hasRunning()) return true;
  } catch {
    /* sin servidores */
  }
  return false;
}

async function readStatus() {
  const s = await readJson(STATUS_FILE(), {});
  return s && typeof s === 'object' ? s : {};
}

async function writeStatus(patch) {
  const cur = await readStatus();
  await writeJson(STATUS_FILE(), { ...cur, ...patch }).catch(() => {});
}

function publicDedupe(r) {
  return { linked: r.linked, freed: r.freed, groups: r.groups, unsupported: r.unsupported, skipped: r.skipped, errors: r.errors, at: Date.now() };
}

async function afterDedupe(r, mode) {
  const out = publicDedupe(r);
  lastScan = null;
  usage.invalidate();
  await writeStatus(mode === 'auto' ? { autoLastRun: out } : { lastDedupe: out });
  send('storage:changed', { reason: mode === 'auto' ? 'auto' : 'dedupe', result: out });
  return out;
}

// ---------- Duplicados ----------
// Si ya hay un analisis en curso (por ejemplo, dos paneles abiertos), se comparte su resultado.
let scanInflight = null;
async function scan({ cached = false } = {}) {
  if (cached && lastScan) return lastScan;
  if (!scanInflight) {
    scanInflight = exclusive('scan', async () => {
      const { summary } = await dedupe.analyze({});
      lastScan = summary;
      return summary;
    }).finally(() => {
      scanInflight = null;
    });
  }
  return scanInflight;
}

async function runDedupe() {
  if (runningTasks().length) throw new Error(t('storage.errTasksRunning'));
  return exclusive('dedupe', () =>
    tasks.run(t('storage.taskDedupe'), async (task) => {
      const r = await dedupe.run({
        signal: task.signal,
        onPhase: (phase) => task.update({ detail: t(phase === 'scan' ? 'storage.taskScanning' : 'storage.taskLinking'), progress: phase === 'scan' ? 0 : undefined }),
        onProgress: (p) => task.update({ progress: p }),
      });
      return afterDedupe(r, 'manual');
    }),
  );
}

// ---------- Limpieza ----------
async function clean(opts = {}) {
  const activeParts = http.activeParts();
  // La vista previa solo lee: puede correr junto a un analisis.
  if (opts && opts.dryRun) return cleanup.publicPlan(await cleanup.plan({ activeParts }));
  const chosen = cleanup.KINDS.filter((k) => opts && opts[k] === true);
  if (!chosen.length) throw new Error(t('storage.errNothingChosen'));
  if (runningTasks().length) throw new Error(t('storage.errTasksRunning'));
  if ((opts.unusedVersions || opts.unusedRuntimes) && gamesOrServersRunning()) throw new Error(t('storage.errGameRunning'));
  return exclusive('clean', () =>
    tasks.run(t('storage.taskClean'), async (task) => {
      task.update({ detail: t('storage.taskCleaning'), progress: null });
      const r = await cleanup.run(opts, { signal: task.signal, activeParts });
      usage.invalidate();
      lastScan = null;
      const out = { ...r, at: Date.now() };
      await writeStatus({ lastClean: out });
      send('storage:changed', { reason: 'clean', result: out });
      return out;
    }),
  );
}

// ---------- Unificacion automatica ----------
const auto = createAuto({
  run: () => exclusive('auto', () => dedupe.run({})),
  canRun: () => {
    if (busyOp || runningTasks().length) return false;
    const st = http.stats();
    return st.active === 0 && st.queued === 0;
  },
  onResult: (r) => {
    afterDedupe(r, 'auto').catch(() => {});
  },
});

async function autoState() {
  const st = await readStatus();
  return { enabled: auto.isEnabled(), running: auto.isRunning(), lastRun: st.autoLastRun || null };
}

// Resumen del ultimo analisis sin la lista de grupos (para el estado).
function lightScan(s) {
  if (!s) return null;
  const { groups: _groups, ...rest } = s;
  return rest;
}

// ---------- Registro ----------
async function register({ handle, send: sendEvent, onQuit }) {
  send = sendEvent;
  await http.loadSettings();

  // Descargas
  handle('downloads:status', () => http.stats());
  handle('downloads:pause', () => {
    http.pause();
    return http.stats();
  });
  handle('downloads:resume', () => {
    http.resume();
    return http.stats();
  });
  handle('downloads:setLimit', async (kbps) => {
    const cfg = http.configure({ maxKBps: kbps });
    await settings.set({ downloads: { maxKBps: cfg.maxKBps } });
    return http.stats();
  });
  handle('downloads:setConcurrency', async (n) => {
    const cfg = http.configure({ concurrency: n });
    await settings.set({ downloads: { concurrency: cfg.concurrency } });
    return http.stats();
  });
  handle('downloads:setOffline', async (on) => {
    const cfg = http.configure({ offline: on === true });
    await settings.set({ downloads: { offline: cfg.offline } });
    return http.stats();
  });
  http.events.on('stats', (s) => send('downloads:stats', s));

  // Almacenamiento
  handle('storage:usage', (opts = {}) => usage.get({ force: Boolean(opts && opts.force), activeParts: http.activeParts() }));
  handle('storage:scan', (opts = {}) => scan({ cached: Boolean(opts && opts.cached) }));
  handle('storage:dedupe', () => runDedupe());
  handle('storage:autoDedupe', async (enabled) => {
    if (typeof enabled === 'boolean') {
      await settings.set({ storage: { autoDedupe: enabled } });
      auto.setEnabled(enabled);
    }
    return autoState();
  });
  handle('storage:clean', (opts = {}) => clean(opts || {}));
  handle('storage:status', async () => {
    const st = await readStatus();
    return {
      busy: busyOp,
      autoDedupe: await autoState(),
      lastScan: lightScan(lastScan),
      lastDedupe: st.lastDedupe || null,
      lastClean: st.lastClean || null,
      storeDir: dedupe.storeDir(),
    };
  });

  const s = await settings.get();
  auto.setEnabled(s.storage?.autoDedupe === true, { startup: true });
  settings.onChange((all) => auto.setEnabled(all?.storage?.autoDedupe === true));
  onQuit(() => auto.stop());
}

module.exports = { register, scan, runDedupe, clean };
