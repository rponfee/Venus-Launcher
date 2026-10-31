'use strict';
// Nube: copias de mundos y configuraciones (opciones, controles, servidores y configs de mods) en Supabase
// Storage, con detección de conflictos entre PCs. La interfaz pasa en cada operación el token de la sesión
// (auth = { accessToken }); la URL y la anon key salen de los ajustes. La lógica está en ./cloudsync/*.
//
// Canales:
//   cloudsync:status(instanceId, auth)                    -> mundos con estado local/nube, configs, uso y otras copias
//                                                             (o { unavailable: 'no_cloud'|'auth'|'schema'|..., message })
//   cloudsync:upload(instanceId, world|'@config', auth, { force })   -> { ok, version } o { conflict: true, remote }
//   cloudsync:download(instanceId, world|'@config', auth, { force }) -> { ok, version, movedTo } o { conflict: true, remote }
//   cloudsync:remove(instanceId, world|'@config', auth)   -> borra la copia de la nube
//   cloudsync:autoSync(instanceId, auth, { direction: 'up'|'down'|'both', since }) -> { uploaded, downloaded, conflicts, errors }
//   cloudsync:settings(instanceId?, patch?)               -> { key, auto, configs } (sin instancia: todas + dispositivo)
const { t } = require('../core/i18n');
const sync = require('./cloudsync/sync');
const { CloudError } = require('./cloudsync/supa');

const SOFT = new Set(['no_cloud', 'auth', 'schema', 'network', 'server', 'denied']);

function register({ handle, send }) {
  const notify = (channel, ...args) => {
    try {
      send(channel, ...args);
    } catch {
      /* ventana cerrada */
    }
  };

  handle('cloudsync:status', async (instanceId, auth) => {
    try {
      return await sync.status(instanceId, auth, notify);
    } catch (err) {
      if (err instanceof CloudError && SOFT.has(err.code)) return { unavailable: err.code, message: err.message };
      throw err;
    }
  });
  handle('cloudsync:upload', (instanceId, world, auth, opts) => sync.upload(instanceId, String(world || ''), auth, { force: Boolean(opts?.force) }, notify));
  handle('cloudsync:download', (instanceId, world, auth, opts) => sync.download(instanceId, String(world || ''), auth, { force: Boolean(opts?.force) }, notify));
  handle('cloudsync:remove', (instanceId, world, auth) => sync.remove(instanceId, String(world || ''), auth, notify));
  handle('cloudsync:autoSync', async (instanceId, auth, opts) => {
    try {
      return await sync.autoSync(instanceId, auth, opts || {}, notify);
    } catch (err) {
      if (err instanceof CloudError && SOFT.has(err.code)) return { uploaded: [], downloaded: [], conflicts: [], errors: [], unavailable: err.code, message: err.message };
      throw err;
    }
  });
  handle('cloudsync:settings', (instanceId, patch) => sync.getSettings(instanceId || null, patch || null));

  // No dejar jugar mientras se sube o se baja un mundo de esta instancia (quedaría a medio copiar).
  try {
    require('../core/game').addBeforeLaunch(async ({ id }) => (sync.isBusy(id) ? { block: true, message: t('cloudsync.errBusyLaunch') } : null));
  } catch (err) {
    console.warn('[cloudsync] beforeLaunch:', err?.message || err);
  }
}

module.exports = {
  register,
  status: sync.status,
  upload: sync.upload,
  download: sync.download,
  autoSync: sync.autoSync,
  isBusy: sync.isBusy,
};
