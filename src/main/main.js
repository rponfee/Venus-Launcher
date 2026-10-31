'use strict';
// Proceso principal de Venus Launcher.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, shell, session, safeStorage, globalShortcut, desktopCapturer, nativeImage } = require('electron');
const paths = require('./core/paths');
const http = require('./core/http');
const settings = require('./core/settings');
const accounts = require('./core/accounts');
const instances = require('./core/instances');
const servers = require('./core/servers');
const game = require('./core/game');
const secure = require('./core/secure');
const i18n = require('./core/i18n');
const ipc = require('./ipc');
const modulesLoader = require('./modules-loader');
const { APP_ID, createWindowBranding, applyTaskbarBranding } = require('./modules/windowsIntegration/branding');

let mainWindow = null;
let hiddenForGame = false;
const quitHooks = [];

app.setAppUserModelId(APP_ID);

function windowBranding() {
  return createWindowBranding({ app, nativeImage });
}

// Capturas de desarrollo (scripts/devshot.js): perfil temporal propio para poder correr varias a la vez.
const DEVSHOT = Boolean(process.env.VENUS_DEVSHOT);
if (DEVSHOT) app.setPath('userData', path.join(os.tmpdir(), `venus-devshot-${process.pid}`));

function resolveDataDir() {
  if (process.env.VENUS_DATA_DIR) return process.env.VENUS_DATA_DIR;
  // Version portable (electron-builder "portable"): los datos viajan junto al .exe
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'VenusData');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'venus-location.json'), 'utf8'));
    if (cfg.dataDir) return cfg.dataDir;
  } catch {
    /* ubicacion por defecto */
  }
  return path.join(app.getPath('appData'), '.venuslauncher');
}

function openLoginWindow(url, redirectPrefix) {
  return new Promise((resolve, reject) => {
    const w = new BrowserWindow({
      width: 520,
      height: 720,
      parent: mainWindow || undefined,
      modal: Boolean(mainWindow),
      title: i18n.t('core.loginWindowTitle'),
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      icon: windowBranding().icon,
      webPreferences: { partition: `msa-${Date.now()}`, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // La particion propia del login no hereda los permisos de la ventana principal: se niegan todos.
    w.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(false));
    w.webContents.session.setPermissionCheckHandler(() => false);
    let done = false;
    const check = (a, b) => {
      const u = typeof a?.url === 'string' ? a.url : typeof b === 'string' ? b : '';
      if (!done && u.startsWith(redirectPrefix)) {
        done = true;
        resolve(u);
        setImmediate(() => !w.isDestroyed() && w.close());
      }
    };
    w.webContents.on('will-redirect', check);
    w.webContents.on('will-navigate', check);
    w.webContents.on('did-navigate', check);
    w.webContents.on('did-redirect-navigation', check);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.on('closed', () => {
      if (done) return;
      // Codigo estable: la interfaz detecta la cancelacion por err.code, no por el texto traducido.
      const err = new Error(i18n.t('accounts.cancelled'));
      err.code = 'cancelled';
      reject(err);
    });
    w.loadURL(url);
  });
}

function createWindow() {
  const branding = windowBranding();
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    frame: false,
    show: false,
    title: 'Venus Launcher',
    backgroundColor: '#100906',
    icon: branding.icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  applyTaskbarBranding(mainWindow, branding);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  // En capturas de desarrollo la ventana no roba el foco (el usuario puede estar usando la PC)
  // y los clics reales la atraviesan, para que no cambien de pagina durante las capturas.
  mainWindow.once('ready-to-show', () => (DEVSHOT ? mainWindow.showInactive() : mainWindow.show()));
  if (DEVSHOT && !process.env.VENUS_DEVSHOT_KEEP) mainWindow.setIgnoreMouseEvents(true);
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false));

  // Links externos al navegador del sistema; nunca navegar fuera de la app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.VENUS_DEVSHOT) {
    try {
      require(path.join(__dirname, '../../scripts/devshot.js'))(mainWindow, process.env.VENUS_DEVSHOT);
    } catch (err) {
      console.error('devshot', err);
    }
  }
}

// Atajo global para silenciar el Voice Chat. Solo se desregistra el atajo propio anterior (no los de
// otros modulos). Devuelve true si quedo registrado (o si se quito), false si es invalido o lo usa otra app.
let muteAccel = null;
function registerShortcut(accel) {
  if (muteAccel) {
    try {
      globalShortcut.unregister(muteAccel);
    } catch {
      /* ya no estaba registrado */
    }
    muteAccel = null;
  }
  const value = typeof accel === 'string' ? accel.trim() : '';
  if (!value) return true;
  try {
    const ok = globalShortcut.register(value, () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('voice:toggle-mute');
    });
    if (ok) muteAccel = value;
    return Boolean(ok);
  } catch {
    return false; // atajo invalido
  }
}

// Que no cuenten las partidas de prueba (quiet) al decidir si quedan juegos abiertos.
function realGamesRunning() {
  return Object.values(game.status()).some((g) => !g?.quiet);
}

const cipher = {
  encrypt: (s) => (safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(s).toString('base64')}` : `raw:${Buffer.from(s).toString('base64')}`),
  decrypt: (s) => {
    if (!s) return '';
    if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
    if (s.startsWith('raw:')) return Buffer.from(s.slice(4), 'base64').toString();
    return s;
  },
};

modulesLoader.preReady({ app });

if (!DEVSHOT && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    paths.setRoot(resolveDataDir());
    http.setUserAgent(`VenusLauncher/${app.getVersion()} (venus-launcher; Electron ${process.versions.electron})`);

    accounts.configure({ ...cipher, openLoginWindow });
    secure.configure(cipher);
    instances.setTrash((p) => shell.trashItem(p));
    servers.setTrash((p) => shell.trashItem(p));

    // Microfono para el Voice Chat; el resto de permisos se deniega.
    const allowed = new Set(['media', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'display-capture']);
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission)));
    session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.has(permission));
    // Compartir pantalla en el Voice Chat: la pantalla principal (Electron no muestra selector propio salvo
    // el del sistema en macOS) y, en Windows, el sonido del equipo si la pagina pide audio (loopback).
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        let answered = false;
        const reply = (streams) => {
          if (answered) return;
          answered = true;
          try {
            callback(streams);
          } catch (err) {
            console.warn('[main] compartir pantalla:', err?.message || err);
          }
        };
        desktopCapturer
          .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            let primaryId = '';
            try {
              primaryId = String(require('electron').screen.getPrimaryDisplay().id);
            } catch {
              /* sin datos de pantallas */
            }
            const screens = sources.filter((s) => String(s.id).startsWith('screen:'));
            const video = screens.find((s) => primaryId && String(s.display_id) === primaryId) || screens[0] || sources[0];
            if (!video) return reply(null);
            const streams = { video };
            if (process.platform === 'win32' && request?.audioRequested) streams.audio = 'loopback';
            reply(streams);
          })
          .catch(() => reply(null));
      },
      { useSystemPicker: true },
    );

    const s = await settings.get();
    i18n.setLanguage(s.language || 'es');
    const { send, handle, safePath } = ipc.register({ getWindow: () => mainWindow });
    await ipc.registerModules({
      app,
      handle,
      send,
      safePath,
      getWindow: () => mainWindow,
      onQuit: (fn) => quitHooks.push(fn),
    });
    registerShortcut(s.voice?.muteShortcut);
    // Devuelve si el atajo quedo registrado (false: invalido o en uso por otra aplicacion).
    handle('voice:setShortcut', (accel) => registerShortcut(accel));

    // Al iniciar/cerrar el juego: minimizar u ocultar segun los ajustes.
    game.events.on('state', async (id, st) => {
      // Partidas de prueba (por ejemplo, la busqueda del culpable de un crash): no se toca la ventana.
      if (!st || st.quiet) return;
      const cfg = await settings.get();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (st.state === 'running') {
        if (cfg.afterLaunch === 'minimize') mainWindow.minimize();
        else if (cfg.afterLaunch === 'hide') {
          hiddenForGame = true;
          mainWindow.hide();
        }
      } else if ((st.state === 'stopped' || st.state === 'crashed') && !realGamesRunning()) {
        if (hiddenForGame || st.state === 'crashed') {
          hiddenForGame = false;
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Al salir: limpieza de los modulos (tuneles, UPnP, Discord...) y despues detener los servidores
  // con "stop" (guardan el mundo) antes de cerrar.
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    (async () => {
      const hooks = quitHooks.map((fn) => Promise.resolve().then(fn).catch((err) => console.error('[quit]', err)));
      await Promise.race([Promise.allSettled(hooks), new Promise((r) => setTimeout(r, 4000))]);
      if (servers.hasRunning()) {
        servers.stopAll();
        const started = Date.now();
        while (servers.hasRunning() && Date.now() - started < 40000) await new Promise((r) => setTimeout(r, 500));
        servers.killAll();
      }
      app.quit();
    })();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
