'use strict';
// Modo mini (settings.window.mini): ventana compacta de 420x640 con lo esencial (cuenta, Jugar, amigos y
// musica; la vista la dibuja features/navcustom en la interfaz con html[data-mini]).
//   window:mini(on) -> { mini, restore }: al entrar guarda el tamano actual (y si estaba maximizada), baja el
//   minimo a 420x640 y achica la ventana; al salir vuelve al tamano y al minimo de siempre (1040x680).
//   La interfaz guarda `restore` en settings.window.miniRestore: si el launcher se cierra en mini, al abrirlo
//   arranca en mini (antes de mostrarse) y al salir recupera el tamano de antes.
// La interfaz es la unica que escribe settings.window.mini; aca solo se lee al arrancar.
const MINI = { width: 420, height: 640 };
const NORMAL_MIN = { width: 1040, height: 680 };
const DEFAULT_SIZE = { width: 1300, height: 820 };

let mini = false;
let prev = null; // { width, height, maximized } de antes de entrar en mini

const num = (v, min) => Math.max(min, Math.round(Number(v)) || 0);

function sizeOf(win) {
  const [width, height] = win.getSize();
  return { width, height, maximized: win.isMaximized() };
}

function enter(win, hint) {
  if (!mini) prev = hint && Number(hint.width) > 0 && Number(hint.height) > 0 ? { width: num(hint.width, NORMAL_MIN.width), height: num(hint.height, NORMAL_MIN.height), maximized: hint.maximized === true } : sizeOf(win);
  mini = true;
  if (win.isFullScreen()) win.setFullScreen(false);
  if (win.isMaximized()) win.unmaximize();
  win.setMinimumSize(MINI.width, MINI.height);
  win.setSize(MINI.width, MINI.height, false);
  return { mini: true, restore: prev };
}

function leave(win, fallback) {
  const back = prev || (fallback && Number(fallback.width) > 0 ? fallback : null) || DEFAULT_SIZE;
  mini = false;
  prev = null;
  win.setMinimumSize(NORMAL_MIN.width, NORMAL_MIN.height);
  win.setSize(num(back.width, NORMAL_MIN.width), num(back.height, NORMAL_MIN.height), false);
  if (back.maximized === true) win.maximize();
  return { mini: false, restore: null };
}

function register({ handle, getWindow }) {
  const settings = require('../core/settings');
  const liveWindow = () => {
    const win = getWindow();
    return win && !win.isDestroyed() ? win : null;
  };

  handle('window:mini', async (on) => {
    const win = liveWindow();
    if (!win) return { mini: Boolean(on), restore: null };
    if (on) return enter(win, null);
    const s = await settings.get().catch(() => ({}));
    return leave(win, s?.window?.miniRestore);
  });

  // Al abrir: la ventana se crea despues de registrar los modulos, asi que se la espera (antes de que se muestre).
  settings
    .get()
    .then((s) => {
      if (!s?.window?.mini) return;
      const hint = s.window.miniRestore || null;
      const started = Date.now();
      const tick = () => {
        const win = liveWindow();
        if (win) {
          try {
            enter(win, hint);
          } catch (err) {
            console.warn('[miniwindow]', err?.message || err);
          }
          return;
        }
        if (Date.now() - started < 20000) setTimeout(tick, 50);
      };
      tick();
    })
    .catch(() => {});
}

module.exports = { register, isMini: () => mini, MINI, NORMAL_MIN };
