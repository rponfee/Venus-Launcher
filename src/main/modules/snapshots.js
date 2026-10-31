'use strict';
// Instantaneas de instancias ("volver atras con un clic"): antes de actualizar mods o el modpack se guarda
// el estado de la instancia (y de los mundos que se elijan) y se puede restaurar despues.
// La logica vive en ./snapshots/ (sin Electron): store.js (almacen por contenido), scan.js (que se guarda)
// y engine.js (crear, comparar, restaurar, retencion).
//
// Para otros modulos del proceso principal:
//   const snapshots = require('./snapshots');
//   await snapshots.create(instanceId, { reason, worlds: 'none'|'all'|[carpetas], label, kind })  -> { id, ... }
//   await snapshots.list(instanceId)                                                          -> [resumen]
//   await snapshots.restore(instanceId, snapshotId, { worlds })
const settings = require('../core/settings');
const game = require('../core/game');
const engine = require('./snapshots/engine');
const { t } = require('../core/i18n');

const BEFORE_PLAY_WAIT = 8000; // como mucho se demora el inicio del juego; despues sigue en segundo plano

function cleanOpts(o) {
  const src = o && typeof o === 'object' ? o : {};
  const out = {};
  if (typeof src.reason === 'string') out.reason = src.reason.slice(0, 120);
  if (typeof src.reasonCode === 'string') out.reasonCode = src.reasonCode;
  if (typeof src.label === 'string') out.label = src.label.slice(0, 80);
  if (src.kind === 'manual' || src.kind === 'auto') out.kind = src.kind;
  if (src.worlds === 'all' || src.worlds === 'none') out.worlds = src.worlds;
  else if (Array.isArray(src.worlds)) out.worlds = src.worlds.filter((w) => typeof w === 'string').slice(0, 500);
  if (typeof src.pinned === 'boolean') out.pinned = src.pinned;
  return out;
}

function snapId(v) {
  if (typeof v !== 'string') throw new Error(t('snapshots.errNotFound'));
  return v;
}

function instanceId(v) {
  if (typeof v !== 'string' || !v) throw new Error(t('snapshots.errNoInstance'));
  return v;
}

// Instantanea automatica antes de jugar: solo mods y configuracion, sin repetir si no cambio nada y
// con un intervalo minimo cuando solo cambio la configuracion (los mods la reescriben al iniciar).
async function beforePlay({ id, settings: s }) {
  const cfg = engine.normalizeSettings(s?.snapshots);
  if (!cfg.autoBeforePlay) return null;
  const job = engine
    .create(id, { kind: 'auto', reasonCode: 'beforePlay', worlds: 'none', skipIfUnchanged: true, throttleMs: cfg.autoIntervalHours * 3600 * 1000, quiet: true })
    .catch((err) => console.warn('[snapshots] Instantánea antes de jugar:', err?.message || err));
  let timer;
  await Promise.race([job, new Promise((r) => (timer = setTimeout(r, BEFORE_PLAY_WAIT)))]);
  clearTimeout(timer);
  return null;
}

function register({ handle, send }) {
  engine.setNotifier((id, extra = {}) => {
    engine.invalidateUsage();
    try {
      send('snapshots:changed', id);
      if (extra.instances) send('instances:changed');
    } catch {
      /* ventana cerrada */
    }
  });

  handle('snapshots:create', (id, opts) => engine.create(instanceId(id), cleanOpts(opts)));
  handle('snapshots:list', async (id) => {
    const items = await engine.list(instanceId(id));
    return { items, running: engine.isRunning(id), settings: await engine.getSettings() };
  });
  handle('snapshots:compare', (id, snap) => engine.compare(instanceId(id), snapId(snap)));
  handle('snapshots:restore', (id, snap, opts) => {
    const o = cleanOpts(opts);
    return engine.restore(instanceId(id), snapId(snap), { worlds: o.worlds || 'none' });
  });
  handle('snapshots:delete', (id, snap) => engine.remove(instanceId(id), snapId(snap)));
  handle('snapshots:update', (id, snap, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    return engine.update(instanceId(id), snapId(snap), { label: typeof p.label === 'string' ? p.label : undefined, pinned: typeof p.pinned === 'boolean' ? p.pinned : undefined });
  });
  handle('snapshots:prune', (id) => engine.prune(typeof id === 'string' && id ? id : null));
  handle('snapshots:usage', (id) => engine.usage(typeof id === 'string' && id ? id : null));
  handle('snapshots:gc', () => engine.gcNow());
  handle('snapshots:cleanOrphans', () => engine.cleanOrphans());
  handle('snapshots:worlds', (id) => engine.worlds(instanceId(id)));
  handle('snapshots:settings', () => engine.getSettings());

  game.addBeforeLaunch(beforePlay);

  // Si se achica la retencion, se aplica enseguida.
  let pruneTimer = null;
  settings.onChange((s, patch) => {
    if (!patch || !patch.snapshots) return;
    clearTimeout(pruneTimer);
    pruneTimer = setTimeout(() => engine.prune(null).catch((err) => console.warn('[snapshots] prune', err?.message || err)), 1500);
  });
}

module.exports = {
  register,
  create: engine.create,
  list: engine.list,
  compare: engine.compare,
  restore: engine.restore,
  remove: engine.remove,
  prune: engine.prune,
  usage: engine.usage,
  getSettings: engine.getSettings,
};
