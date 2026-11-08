'use strict';

const { createController, normalizeRepository } = require('./updater/controller');

function register({ app, handle, send, onQuit }) {
  const pkg = require('../../../package.json');
  const repository = normalizeRepository(pkg.venusUpdates?.githubRepository);
  const portable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE);
  let updater = null;
  if (app.isPackaged && !portable && process.platform === 'win32' && repository) {
    try { updater = require('electron-updater').autoUpdater; } catch { /* estado unavailable visible */ }
  }
  const controller = createController({
    app, updater, repository, portable,
    fetchText: (url) => require('../core/http').getText(url, { retries: 1 }),
    notify: (state) => send('updater:state', state),
    isBusy: () => Object.values(require('../core/game').status()).some((g) => !g?.quiet) || require('../core/servers').hasRunning(),
  });
  handle('updater:status', controller.status);
  handle('updater:check', controller.check);
  handle('updater:install', controller.install);

  // La búsqueda automática (al abrir y cada 4 horas) respeta privacy.autoUpdates; viene activa en instalaciones
  // nuevas y quien la desactivó conserva su elección. Los errores quedan en Actualizaciones.
  // Vale igual para la portable, que en vez de instalar avisa (features/update-notice.js).
  const autoCheck = async () => {
    const s = await require('../core/settings').get().catch(() => null);
    if (s?.privacy?.autoUpdates === true) controller.check();
  };
  let initial = null;
  let periodic = null;
  if (controller.status().status !== 'disabled') {
    initial = setTimeout(autoCheck, 10000);
    periodic = setInterval(autoCheck, 4 * 60 * 60 * 1000);
    initial.unref?.();
    periodic.unref?.();
  }
  const unsubscribe = require('../core/settings').onChange((_settings, patch) => {
    if (patch?.privacy?.autoUpdates === true) autoCheck();
  });
  onQuit(() => {
    clearTimeout(initial);
    clearInterval(periodic);
    unsubscribe();
    controller.dispose();
  });
}

module.exports = { register };
