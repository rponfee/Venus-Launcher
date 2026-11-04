'use strict';
// Solo para capturas de desarrollo (VENUS_DEVSHOT y sin empaquetar): deja ver la pagina del overlay y sus paneles sin
// mostrar ninguna ventana ni tomar el foco. La ventana queda oculta y las capturas salen de capturePage.
//   venus.invoke('overlay:dev', 'hold')              crea la ventana sin mostrarla
//   venus.invoke('overlay:dev', 'panel', 'recipes')  abre un panel
//   venus.invoke('overlay:dev', 'close')             lo cierra
//   venus.invoke('overlay:dev', 'event', evento)     le manda un evento a la pagina
//   venus.invoke('overlay:dev', 'notice', clave)     un aviso con el texto de esa clave
//   venus.invoke('overlay:dev', 'eval', 'codigo')    corre codigo en la pagina y devuelve el resultado
//   venus.invoke('overlay:dev', 'shot', 'nombre')    guarda <VENUS_DEVSHOT>/overlay-<nombre>.png
// Con VENUS_OVERLAY_FAKE_PID (una ventana propia hace de juego; esto si toma el foco):
//   'open' (abre un panel como su atajo), 'info' (panel, foco, ventana de adelante) y 'front' (pone una ventana adelante)
const fs = require('fs');
const path = require('path');

function register({ handle, win, hold, panel, close, deliver, layout, notice, open, info, front }) {
  // Quien gana y quien pierde el foco, con la hora (lo que importa para probar los paneles)
  const { app, BrowserWindow } = require('electron');
  const hwnd = (w) => {
    try {
      const b = w.getNativeWindowHandle();
      return b.length >= 8 ? b.readBigInt64LE(0).toString() : String(b.readInt32LE(0));
    } catch {
      return '?';
    }
  };
  const note = (what, w) => fs.appendFileSync(path.join(process.env.VENUS_DEVSHOT, 'overlay-focus.log'), `${new Date().toISOString().slice(11, 23)} ${what} ${hwnd(w)} "${w.getTitle()}"\n`);
  app.on('browser-window-focus', (e, w) => note('foco', w));
  app.on('browser-window-blur', (e, w) => note('pierde', w));
  handle('overlay:dev', async (cmd, arg) => {
    switch (cmd) {
      case 'hold':
        hold();
        // La consola de la pagina va a un archivo aparte (no se mezcla con la de la ventana principal)
        win()?.webContents.on('console-message', (e) => {
          fs.appendFileSync(path.join(process.env.VENUS_DEVSHOT, 'overlay-console.log'), `[${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})\n`);
        });
        layout();
        return true;
      case 'panel':
        panel(arg);
        return true;
      case 'close':
        close();
        return true;
      case 'open':
        return open(arg);
      case 'info':
        return { ...info(), windows: BrowserWindow.getAllWindows().map((w) => ({ hwnd: hwnd(w), title: w.getTitle(), visible: w.isVisible(), focused: w.isFocused() })) };
      case 'front':
        return front(arg);
      case 'event':
        return deliver(arg);
      case 'notice':
        notice(arg);
        return true;
      case 'eval':
        return win()?.webContents.executeJavaScript(String(arg));
      case 'shot': {
        // Oculta, la ventana solo dibuja si se lo piden: la primera captura la despierta y la segunda trae lo ultimo
        win().webContents.invalidate();
        await win().webContents.capturePage(undefined, { stayHidden: true });
        await new Promise((r) => setTimeout(r, 150));
        const img = await win().webContents.capturePage(undefined, { stayHidden: true });
        const name = String(arg || 'panel').replace(/[^\w.-]+/g, '_');
        fs.writeFileSync(path.join(process.env.VENUS_DEVSHOT, `overlay-${name}.png`), img.toPNG());
        return img.getSize();
      }
      default:
        return null;
    }
  });
}

module.exports = { register };
