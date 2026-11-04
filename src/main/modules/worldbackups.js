'use strict';
// Copias automaticas de mundos (settings.backups.schedule, cuentas en worldbackups/plan.js). Usa la misma copia que el
// boton Respaldar (worlds/backups.create) con la marca .auto y rota solo esas. Nunca copia con el juego abierto en esa
// instancia: lo que toca mientras se juega se hace al cerrar. La fecha de la ultima copia sale de los archivos, asi que
// una copia perdida con el launcher cerrado se hace al abrir, sin guardar nada mas.
//   worldbackups:status()  -> { config, running, queued, failed: [{ instanceId, folder, name, error, at }] }
//   worldbackups:runNow()  -> { queued }: copia ya lo que cambio desde la ultima copia automatica
// Evento worldbackups:done { copied: [{ instanceId, folder, name, size }], failed: [{ name, error }] } al vaciarse la cola.
const fsp = require('fs/promises');
const path = require('path');
const settings = require('../core/settings');
const instances = require('../core/instances');
const game = require('../core/game');
const tasks = require('../core/tasks');
const { t } = require('../core/i18n');
const backups = require('./worlds/backups');
const level = require('./worlds/level');
const plan = require('./worldbackups/plan');

const CHECK_MS = 10 * 60 * 1000;
const FIRST_MS = 45 * 1000; // al abrir, despues de que arranque todo lo demas
const SETTLE_MS = 5 * 1000; // al cerrar el juego, un momento para que termine de escribir
const RETRY_MS = 60 * 60 * 1000; // un mundo que fallo no se reintenta en cada revision
const PART_MAX_AGE = 24 * 60 * 60 * 1000;

const st = { ctx: null, cfg: plan.normalize(null), queue: [], busy: false, task: null, timers: new Set(), failures: new Map(), copied: [], failed: [] };

const keyOf = (instanceId, folder) => `${instanceId}/${folder}`;

function later(fn, ms) {
  const timer = setTimeout(() => {
    st.timers.delete(timer);
    fn();
  }, ms);
  timer.unref?.();
  st.timers.add(timer);
}

// Otro modulo tiene ocupada la instancia: se vuelve a mirar en la proxima revision.
function instanceBusy(id) {
  for (const [mod, fn] of [['./crash', 'isBisecting'], ['./cloudsync', 'isBusy']]) {
    try {
      if (require(mod)[fn]?.(id)) return true;
    } catch {
      /* sin ese modulo no hay nada que esperar */
    }
  }
  return false;
}

async function lastAutoAt(instanceId, folder) {
  const list = await backups.list(instanceId, folder);
  return list.find((b) => b.auto)?.time || 0;
}

async function modifiedAt(inst, folder) {
  const stat = await fsp.stat(path.join(inst.dir, 'saves', folder, 'level.dat')).catch(() => null);
  return stat?.mtimeMs || 0;
}

// Revisa los mundos de las instancias elegidas y encola los que toca copiar.
async function sweep({ instanceId = null, reason = 'schedule', force = false } = {}) {
  const cfg = st.cfg;
  if (!cfg.enabled && !force) return 0;
  const all = await instances.list().catch(() => []);
  const now = Date.now();
  let added = 0;
  for (const inst of all) {
    if (instanceId && inst.id !== instanceId) continue;
    if (!plan.wants(cfg, inst.id) || game.status()[inst.id]) continue;
    for (const folder of await level.folders(inst.dir).catch(() => [])) {
      const key = keyOf(inst.id, folder);
      if (st.queue.some((j) => j.key === key) || st.task?.key === key) continue;
      if (!force && now - (st.failures.get(key) || 0) < RETRY_MS) continue;
      const lastAt = await lastAutoAt(inst.id, folder).catch(() => 0);
      const changed = await modifiedAt(inst, folder);
      if (!changed) continue; // no es un mundo: no tiene level.dat
      if (!plan.needsCopy({ cfg: force ? { ...cfg, enabled: true, onGameClose: true } : cfg, reason: force ? 'close' : reason, lastAt, modifiedAt: changed, now })) continue;
      st.queue.push({ key, instanceId: inst.id, folder, name: inst.name });
      added++;
    }
  }
  if (added) drain();
  return added;
}

async function rotate(instanceId, folder, keep) {
  const list = await backups.list(instanceId, folder);
  // Borrado directo y no a la papelera: son copias que el usuario pidio tener solo N veces, y la papelera se llenaria
  // de archivos grandes sin que nadie lo note. Las manuales no entran nunca en esta lista.
  for (const b of plan.rotationVictims(list, keep)) await backups.remove(b.path).catch((err) => console.warn('[worldbackups] rotacion:', err?.message || err));
}

async function runJob(job) {
  const inst = await instances.get(job.instanceId).catch(() => null);
  if (!inst || !(await modifiedAt(inst, job.folder))) return;
  if (game.status()[inst.id] || instanceBusy(inst.id)) return;
  const lv = await level.readLevel(path.join(inst.dir, 'saves', job.folder)).catch(() => null);
  const name = lv?.levelName || job.folder;
  try {
    // withStoppedInstance: el juego no puede abrirse a mitad de la copia. La tarea lleva instanceId, asi que mientras
    // tanto Jugar se ve ocupado, y se puede cancelar desde el panel.
    const res = await game.withStoppedInstance(inst.id, () =>
      tasks.run(
        t('datatools.taskAutoBackup', { name }),
        (task) => {
          st.task = { key: job.key, task };
          return backups.create(inst, job.folder, { task, auto: true });
        },
        { instanceId: inst.id, kind: 'worldbackups' },
      ),
    );
    await rotate(inst.id, job.folder, st.cfg.keep);
    st.failures.delete(job.key);
    st.copied.push({ instanceId: inst.id, folder: job.folder, name, size: res.size });
    st.ctx?.send?.('worlds:updated', { kind: 'backups', instanceId: inst.id, world: job.folder });
  } catch (err) {
    if (err?.code === 'alreadyRunning' || err?.code === 'instanceBusy') return; // se hara al cerrar
    st.failures.set(job.key, Date.now());
    const cancelled = st.task?.task?.signal?.aborted;
    if (!cancelled) {
      console.warn('[worldbackups]', job.key, err?.message || err);
      st.failed.push({ instanceId: inst.id, folder: job.folder, name, error: err?.message || String(err), at: Date.now() });
    }
  } finally {
    st.task = null;
  }
}

// Una copia a la vez: un mundo grande no tiene por que competir con otro por el disco.
async function drain() {
  if (st.busy) return;
  st.busy = true;
  try {
    while (st.queue.length) await runJob(st.queue.shift());
  } finally {
    st.busy = false;
  }
  if (st.copied.length || st.failed.length) {
    st.ctx?.send?.('worldbackups:done', { copied: st.copied, failed: st.failed });
    st.copied = [];
    if (st.failed.length) st.lastFailed = st.failed;
    st.failed = [];
  }
}

// Un .part de mas de un dia es de una copia que se corto de golpe (la que esta en curso nunca es tan vieja).
async function cleanParts() {
  const root = backups.root();
  for (const d of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const dir = path.join(root, d.name);
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (!name.endsWith('.part')) continue;
      const file = path.join(dir, name);
      const stat = await fsp.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > PART_MAX_AGE) await fsp.rm(file, { force: true }).catch(() => {});
    }
  }
}

function status() {
  return { config: st.cfg, running: Boolean(st.busy), queued: st.queue.length, failed: st.lastFailed || [] };
}

function register({ handle, send, onQuit }) {
  st.ctx = { send };
  const safeSweep = (opts) => sweep(opts).catch((err) => console.warn('[worldbackups]', err?.message || err));
  settings
    .get()
    .then((s) => {
      st.cfg = plan.normalize(s?.backups?.schedule);
    })
    .catch(() => {});
  settings.onChange((s, patch) => {
    if (!patch?.backups) return;
    const was = st.cfg.enabled;
    st.cfg = plan.normalize(s?.backups?.schedule);
    if (st.cfg.enabled && !was) later(() => safeSweep(), SETTLE_MS);
  });
  // Las pruebas de la busqueda del culpable (quiet) no son partidas: ni copia al cerrar ni nada.
  game.events.on('state', (id, state) => {
    if (state?.quiet || (state?.state !== 'stopped' && state?.state !== 'crashed')) return;
    later(() => safeSweep({ instanceId: id, reason: 'close' }), SETTLE_MS);
  });
  later(() => {
    cleanParts().catch(() => {});
    safeSweep();
  }, FIRST_MS);
  const timer = setInterval(() => safeSweep(), CHECK_MS);
  timer.unref?.();

  handle('worldbackups:status', () => status());
  handle('worldbackups:runNow', async () => ({ queued: await sweep({ force: true }) }));

  onQuit?.(() => {
    clearInterval(timer);
    for (const x of st.timers) clearTimeout(x);
    st.timers.clear();
    st.queue.length = 0;
    st.task?.task?.cancel(); // el .part se borra solo; la copia se vuelve a hacer al abrir
  });
}

module.exports = { register, status, sweep };
