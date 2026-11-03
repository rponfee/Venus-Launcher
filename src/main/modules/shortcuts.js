'use strict';
// Accesos directos en el escritorio (Windows): <Escritorio>\<nombre>.lnk abre el launcher con
// --play-instance=<id>. Al arrancar con ese argumento, o cuando otra copia lo recibe (evento 'venus:argv'
// que emite main.js en 'second-instance'), se lanza esa instancia como lo hace instances:launch, una vez
// que la ventana existe y la interfaz esta lista (se espera hasta 20 s). Los errores (la instancia no
// existe, falta una cuenta, fallo el inicio) se avisan como una tarea fallida: la interfaz la muestra como
// aviso y en el panel de tareas.
// Canal: shortcuts:create(id) -> { path, name }. Errores con err.code: unsupported (no es Windows),
// notFound, writeFailed. La logica sin Electron (argumentos, nombre del .lnk, parseo) esta en ./shortcuts/args.js.
const fsp = require('fs/promises');
const path = require('path');
const { t } = require('../core/i18n');
const { parsePlayArg, buildShortcut } = require('./shortcuts/args');

const UI_WAIT = 20000;
const POLL = 250;
const APP_ID = 'com.venuslauncher.app';
const APP_NAME = 'Venus Launcher';

function codeError(message, code) {
  return Object.assign(new Error(message), { code });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Icono del launcher como lo resuelve windowsIntegration/branding.js (venus.ico empaquetado, build/icon.ico
// en desarrollo o el .exe, que ya trae el icono).
function resolveIcon(app) {
  try {
    const { nativeImage } = require('electron');
    const { createWindowBranding } = require('./windowsIntegration/branding');
    const branding = createWindowBranding({ app, nativeImage });
    const icon = branding?.taskbarDetails?.appIconPath;
    return typeof icon === 'string' && icon ? icon : process.execPath;
  } catch {
    return process.execPath;
  }
}

async function createShortcut(app, id) {
  if (process.platform !== 'win32') throw codeError('unsupported', 'unsupported');
  const instances = require('../core/instances');
  let inst;
  try {
    inst = await instances.get(id);
  } catch (err) {
    throw codeError(err?.message || 'notFound', 'notFound');
  }
  const { shell } = require('electron');
  if (typeof shell?.writeShortcutLink !== 'function') throw codeError('unsupported', 'unsupported');
  const plan = buildShortcut({
    id: inst.id,
    name: inst.name,
    desktopDir: app.getPath('desktop'),
    execPath: process.execPath,
    portableExe: process.env.PORTABLE_EXECUTABLE_FILE || '',
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    icon: resolveIcon(app),
    description: `${inst.name} — ${APP_NAME}`,
  });
  // Si ya hay un acceso directo con ese nombre que apunta a OTRA instancia, no se pisa: se agrega el id al nombre.
  let file = plan.path;
  try {
    const current = shell.readShortcutLink(file);
    const other = parsePlayArg(current?.args || '');
    if (other && other !== inst.id) file = plan.altPath;
  } catch {
    /* no existe o no se puede leer: se crea */
  }
  await fsp.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
  let written = false;
  try {
    written = shell.writeShortcutLink(file, 'create', {
      target: plan.target,
      cwd: plan.cwd,
      args: plan.args,
      description: plan.description,
      icon: plan.icon,
      iconIndex: plan.iconIndex,
      appUserModelId: APP_ID,
    });
  } catch (err) {
    throw codeError(err?.message || 'writeFailed', 'writeFailed');
  }
  if (!written) throw codeError('writeFailed', 'writeFailed');
  return { path: file, name: path.basename(file, '.lnk') };
}

// Espera a que exista la ventana y la interfaz haya dibujado algo (hasta `timeout` ms).
async function waitUiReady(getWindow, timeout = UI_WAIT) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      const wc = win.webContents;
      if (!wc.isLoading()) {
        const ready = await wc.executeJavaScript("Boolean(document.getElementById('main') && document.getElementById('main').childElementCount)", true).catch(() => false);
        if (ready) return true;
      }
    }
    await sleep(POLL);
  }
  return false;
}

// Aviso al usuario con el mecanismo del proceso principal: una tarea que falla se ve como aviso en la interfaz.
async function report(name, err) {
  const tasks = require('../core/tasks');
  await tasks
    .run(t('instances.taskPreparing', { name }), async () => {
      throw err instanceof Error ? err : new Error(String(err));
    })
    .catch(() => {});
}

async function playFromShortcut({ app, getWindow }, id) {
  await waitUiReady(getWindow);
  const game = require('../core/game');
  const instances = require('../core/instances');
  if (game.status()[id]) return; // ya esta abierta: la ventana ya se trajo al frente
  let inst = null;
  try {
    inst = await instances.get(id);
  } catch {
    inst = null;
  }
  if (!inst) {
    await report(id, new Error(t('instances.errNotFound')));
    return;
  }
  try {
    const accounts = require('../core/accounts');
    const settings = require('../core/settings');
    const account = await accounts.getLaunchAccount();
    const s = await settings.get();
    await settings.set({ selectedInstance: id });
    await game.start(id, { account, settings: s, launcherVersion: app.getVersion() });
  } catch (err) {
    await report(inst.name, err);
  }
}

function register({ app, handle, getWindow }) {
  handle('shortcuts:create', (id) => createShortcut(app, id));

  // Un pedido por vez: si llegan dos (doble clic en el acceso directo), el segundo ve la partida abierta.
  let chain = Promise.resolve();
  const queue = (argv) => {
    const id = parsePlayArg(argv);
    if (!id) return;
    chain = chain.then(() => playFromShortcut({ app, getWindow }, id)).catch((err) => console.warn('[shortcuts] jugar desde el acceso directo:', err?.message || err));
  };
  queue(process.argv);
  app.on('venus:argv', (argv) => queue(Array.isArray(argv) ? argv : []));
}

module.exports = { register, createShortcut, waitUiReady };
