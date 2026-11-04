'use strict';
// Links venus://: registra el protocolo en el sistema, lee el link de process.argv al arrancar y de 'venus:argv'
// (otra copia del launcher, ver main.js) o 'open-url' (macOS) después, lo valida con ./deeplink/parse.js y lo manda
// a la interfaz con send('deeplink:open', accion). Acá no se ejecuta nada: features/instancelook.js muestra un
// diálogo que dice qué va a pasar y recién entonces usa el flujo de siempre (instalar un modpack, entrar a un servidor).
// Canal: deeplink:ready() -> cantidad de links que esperaban (la interfaz avisa que ya escucha).
// Evento: deeplink:open (acción: formas en ./deeplink/parse.js).
const path = require('path');
const { parseLink, findLink } = require('./deeplink/parse');
const { createLinkQueue } = require('./deeplink/queue');

const PROTOCOL = 'venus';

// Instalada: la app. Desarrollo: Electron con la carpeta del proyecto. Portable: el .exe portable (process.execPath
// apunta a la copia temporal que se borra al cerrar) y solo si ningún otro programa ya tiene el protocolo, así no
// le saca los links a una instalada. Las capturas (VENUS_DEVSHOT) nunca lo registran: pisarían el del launcher real.
function registerProtocol(app) {
  if (process.env.VENUS_DEVSHOT) return false;
  try {
    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    if (portable) {
      if (app.isDefaultProtocolClient(PROTOCOL, portable, [])) return true;
      if (app.getApplicationNameForProtocol(`${PROTOCOL}://`)) return false;
      return app.setAsDefaultProtocolClient(PROTOCOL, portable, []);
    }
    if (process.defaultApp && process.argv.length >= 2) {
      return app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
    return app.setAsDefaultProtocolClient(PROTOCOL);
  } catch (err) {
    console.warn('[deeplink] no se pudo registrar el protocolo:', err?.message || err);
    return false;
  }
}

let toUi = () => {};
const queue = createLinkQueue((action) => toUi(action));

function preReady({ app }) {
  // macOS avisa con 'open-url', a veces antes de que la app esté lista.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    queue.push(parseLink(url));
  });
}

function register({ app, handle, send }) {
  toUi = (action) => send('deeplink:open', action);
  registerProtocol(app);
  handle('deeplink:ready', () => queue.ready());
  queue.push(findLink(process.argv));
  app.on('venus:argv', (argv) => queue.push(findLink(argv)));
}

module.exports = { preReady, register, registerProtocol };
