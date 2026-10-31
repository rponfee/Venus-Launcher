'use strict';
// Compatibilidad: revisión antes de instalar (compat:check + compat:prepare), actualizaciones de mods con
// changelog y pistas de riesgo (compat:updates / compat:applyUpdates) e historial con vuelta atrás por mod
// (compat:history / compat:rollback / compat:clearHistory). La lógica está en ./compat/*.
const { t } = require('../core/i18n');
const tasks = require('../core/tasks');
const settings = require('../core/settings');
const check = require('./compat/check');
const prepareMod = require('./compat/prepare');
const updates = require('./compat/updates');
const history = require('./compat/history');
const targets = require('./compat/target');
const inventory = require('./compat/inventory');

// Una operación de archivos a la vez por instancia/servidor
const chains = new Map();
function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return next;
}

// compat:history / compat:rollback aceptan el id de una instancia o { kind: 'server', id }
function targetDesc(arg) {
  return typeof arg === 'string' ? { kind: 'instance', id: arg } : arg;
}

async function assertIdle(target) {
  if (target.kind === 'instance') {
    // Mientras se busca el mod culpable de un crash, la carpeta mods es de esa búsqueda
    require('./crash').assertNotBisecting(target.id);
    let running = false;
    try {
      running = Boolean(require('../core/game').status()[target.id]);
    } catch {
      running = false;
    }
    if (running) throw new Error(t('compat.errGameRunning'));
    return;
  }
  let state = 'offline';
  try {
    state = (await require('../core/servers').get(target.id)).state || 'offline';
  } catch {
    state = 'offline';
  }
  if (state !== 'offline') throw new Error(t('compat.errServerRunning'));
}

async function compatSettings() {
  return { includeBeta: false, ...((await settings.get()).compat || {}) };
}

function register({ handle, send, safePath, onQuit }) {
  const trash = (p) => require('electron').shell.trashItem(p);

  handle('compat:check', async (input) => check.check(input || {}));

  handle('compat:prepare', async (input = {}) => {
    const target = await targets.load(input.target);
    safePath(target.dir);
    const moves = (input.replace?.length || 0) + (input.enable?.length || 0);
    if (moves) await assertIdle(target);
    const run = (task) => prepareMod.prepare(input, { task, safePath });
    const meta = target.kind === 'instance' ? { instanceId: target.id, kind: 'compat:prepare' } : { serverId: target.id, kind: 'compat:prepare' };
    return withLock(`${target.kind}:${target.id}`, () => (input.install?.length ? tasks.run(t('compat.taskPrepare', { name: target.name }), run, meta) : run(null)));
  });

  handle('compat:updates', async (instanceId, opts = {}) => {
    const cfg = await compatSettings();
    const includeBeta = typeof opts?.includeBeta === 'boolean' ? opts.includeBeta : Boolean(cfg.includeBeta);
    let last = 0;
    return updates.listUpdates(instanceId, {
      includeBeta,
      onProgress: (p) => {
        const now = Date.now();
        if (now - last < 120 && p.done !== p.total) return;
        last = now;
        send('compat:progress', { instanceId, ...p });
      },
    });
  });

  handle('compat:applyUpdates', async (instanceId, items) => {
    const target = await targets.load({ kind: 'instance', id: instanceId });
    safePath(target.dir);
    await assertIdle(target);
    return withLock(`instance:${target.id}`, () =>
      tasks.run(t('compat.taskUpdate', { name: target.name }), (task) => updates.applyUpdates(target.id, items, { task }), { instanceId: target.id, kind: 'compat:update' }),
    );
  });

  handle('compat:history', async (arg) => {
    const target = await targets.load(targetDesc(arg));
    return history.list(target.dir);
  });

  handle('compat:rollback', async (arg, entryId) => {
    const target = await targets.load(targetDesc(arg));
    safePath(target.dir);
    await assertIdle(target);
    return withLock(`${target.kind}:${target.id}`, async () => {
      // los registros pueden haber cambiado mientras se esperaba el turno
      const fresh = await targets.load(targetDesc(arg));
      return history.rollback(fresh, entryId);
    });
  });

  handle('compat:clearHistory', async (arg) => {
    const target = await targets.load(targetDesc(arg));
    safePath(history.historyDir(target.dir));
    return withLock(`${target.kind}:${target.id}`, () => history.clear(target.dir, trash));
  });

  handle('compat:settings', async (patch) => {
    if (patch && typeof patch === 'object') {
      const next = {};
      if (typeof patch.includeBeta === 'boolean') next.includeBeta = patch.includeBeta;
      if (Object.keys(next).length) await settings.set({ compat: { ...(await compatSettings()), ...next } });
    }
    return compatSettings();
  });

  onQuit(() => inventory.flush());
}

module.exports = {
  register,
  // Para otros módulos del proceso principal
  check: (input) => check.check(input || {}),
  listUpdates: (instanceId, opts) => updates.listUpdates(instanceId, opts),
  history: (instanceId) => targets.load(targetDesc(instanceId)).then((tg) => history.list(tg.dir)),
};
