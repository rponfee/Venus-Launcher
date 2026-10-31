'use strict';

// No requiere Electron: el controlador se prueba con un proveedor y reloj simulados.
function normalizeRepository(value) {
  const repository = String(value || '').trim();
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_.-]{1,100}$/.test(repository)) return null;
  if (/^(?:TU_USUARIO_GITHUB|YOUR[_-]GITHUB[_-]USER|OWNER)\//i.test(repository) || repository.includes('..')) return null;
  return repository;
}

function createController({ app, updater, repository, portable = false, platform = process.platform, notify = () => {}, isBusy = () => false, now = Date.now }) {
  repository = normalizeRepository(repository);
  let disabledReason = null;
  if (!app.isPackaged) disabledReason = 'development';
  else if (portable) disabledReason = 'portable';
  else if (platform !== 'win32') disabledReason = 'platform';
  else if (!repository) disabledReason = 'unconfigured';
  else if (!updater) disabledReason = 'unavailable';

  let state = {
    status: disabledReason ? 'disabled' : 'idle',
    disabledReason,
    currentVersion: app.getVersion(),
    version: null,
    percent: null,
    lastChecked: null,
    repository,
    releasesUrl: repository ? `https://github.com/${repository}/releases` : null,
    error: null,
  };
  let checking = null;
  let disposed = false;
  const subscriptions = [];
  const snapshot = () => ({ ...state });
  const change = (patch) => {
    if (disposed) return;
    state = { ...state, ...patch };
    notify(snapshot());
  };
  function listen(name, fn) {
    updater.on(name, fn);
    subscriptions.push([name, fn]);
  }
  function fail() {
    // Los errores de red pueden contener URLs y cabeceras: no se exponen al renderer.
    change({ status: 'error', error: 'No se pudo buscar o descargar la actualización. Probá de nuevo más tarde.' });
  }

  if (!disabledReason) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.autoRunAppAfterInstall = true;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.disableWebInstaller = true;
    listen('checking-for-update', () => change({ status: 'checking', error: null, percent: null }));
    listen('update-available', (info) => change({ status: 'downloading', version: info.version, percent: 0, lastChecked: now(), error: null }));
    listen('update-not-available', () => change({ status: 'current', lastChecked: now(), error: null }));
    listen('download-progress', (progress) => change({ status: 'downloading', percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)) }));
    listen('update-downloaded', (info) => change({ status: 'ready', version: info.version, percent: 100, error: null }));
    listen('error', fail);
  }

  function check() {
    if (disabledReason || disposed || ['downloading', 'ready', 'installing'].includes(state.status)) return Promise.resolve(snapshot());
    if (checking) return checking;
    change({ status: 'checking', error: null });
    checking = Promise.resolve().then(() => updater.checkForUpdates()).then((result) => {
      // La promesa de descarga se resuelve después de la búsqueda; siempre consumir sus errores.
      result?.downloadPromise?.catch(fail);
      return snapshot();
    }, () => { fail(); return snapshot(); }).finally(() => { checking = null; });
    return checking;
  }

  function install() {
    if (state.status !== 'ready') throw new Error('La actualización todavía no está lista.');
    if (isBusy()) throw new Error('Cerrá las partidas y los servidores antes de instalar la actualización.');
    change({ status: 'installing' });
    // app.quit conserva la limpieza del launcher; electron-updater instala en el evento quit.
    app.quit();
    return snapshot();
  }

  return {
    status: snapshot,
    check,
    install,
    dispose() {
      disposed = true;
      for (const [name, fn] of subscriptions) updater.removeListener(name, fn);
    },
  };
}

module.exports = { normalizeRepository, createController };
