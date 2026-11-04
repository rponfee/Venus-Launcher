'use strict';
// Ventana del overlay: transparente, siempre encima (nivel 'screen-saver'), sin marco, sin foco, fuera de la
// barra de tareas y de Alt+Tab, y que deja pasar los clics al juego. En el modo edicion acepta el mouse y el
// teclado para mover los widgets. No se ve sobre un juego en pantalla completa exclusiva (ver docs/overlay.md).
const path = require('path');

function createOverlayWindow() {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({
    width: 800,
    height: 450,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    title: 'Venus Overlay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: !require('electron').app.isPackaged,
      // Sesion propia en memoria: no comparte permisos ni almacenamiento con la ventana principal.
      partition: 'venus-overlay',
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setMenu(null);
  try {
    win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
  } catch {
    /* solo macOS */
  }
  // Nunca navega ni abre ventanas: es una pagina local sin enlaces.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // La pagina no pide permisos (ni microfono, ni pantalla, ni notificaciones).
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.loadFile(path.join(__dirname, '..', '..', '..', 'renderer', 'overlay.html'));
  return win;
}

// Modo edicion: la ventana toma el mouse y el foco; al salir vuelve a dejar pasar todo.
function setInteractive(win, on) {
  if (!win || win.isDestroyed()) return;
  if (on) {
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    win.setSkipTaskbar(true); // setFocusable la vuelve a poner en la barra de tareas
    win.focus();
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    win.setSkipTaskbar(true);
    win.blur();
  }
}

// HWND de la ventana (texto, para compararlo con la ventana en primer plano que informa el ayudante).
function hwndOf(win) {
  try {
    const buf = win.getNativeWindowHandle();
    return buf.length >= 8 ? buf.readBigInt64LE(0).toString() : String(buf.readInt32LE(0));
  } catch {
    return '';
  }
}

module.exports = { createOverlayWindow, setInteractive, hwndOf };
