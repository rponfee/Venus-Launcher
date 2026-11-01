'use strict';
// Venus dentro del juego: antes de cada partida activa el paquete de recursos "Venus Launcher" (pantalla de carga,
// texto del menu y frases) y, con el juego abierto, pone el icono y el titulo de Venus en la ventana.
// Ajustes (settings.ingame): pack (paquete de recursos) y window (icono y titulo). Los dos vienen prendidos.
// Las partidas de prueba (busqueda del culpable de un crash) no se tocan.
const fs = require('fs');
const path = require('path');
const paths = require('../core/paths');
const { t } = require('../core/i18n');
const pack = require('./ingame/pack');
const windowBrand = require('./ingame/window');

const DEFAULTS = { pack: true, window: true };

function prefs(settings) {
  const s = settings?.ingame && typeof settings.ingame === 'object' ? settings.ingame : {};
  return { pack: s.pack !== false && DEFAULTS.pack, window: s.window !== false && DEFAULTS.window };
}

function splashes() {
  return String(t('ingame.splashes'))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function iconPath(app) {
  const file = app?.isPackaged ? path.join(process.resourcesPath, 'venus.ico') : path.join(__dirname, '..', '..', '..', 'build', 'icon.ico');
  return fs.existsSync(file) ? file : null;
}

function register({ app, onQuit }) {
  const game = require('../core/game');
  const helpers = new Map(); // instanceId -> proceso del ayudante de la ventana

  game.addBeforeLaunch(async ({ instance, resolved, settings, quiet }) => {
    if (quiet) return null;
    try {
      await pack.apply({
        instanceDir: instance.dir,
        mcVersion: instance.mcVersion,
        jarPath: resolved?.rootId ? paths.versionJar(resolved.rootId) : null,
        enabled: prefs(settings).pack,
        description: t('ingame.packDescription'),
        splashes: splashes(),
      });
    } catch (err) {
      console.warn('[ingame] paquete de recursos', err);
    }
    return null;
  });

  game.events.on('state', async (id, payload) => {
    if (!payload || payload.quiet) return;
    if (payload.state !== 'running') {
      helpers.delete(id);
      return;
    }
    if (!payload.pid || helpers.has(id)) return;
    let s = {};
    try {
      s = await require('../core/settings').get();
    } catch {
      /* sin ajustes: valores por defecto */
    }
    if (!prefs(s).window) return;
    const child = windowBrand.brand({ pid: payload.pid, iconPath: iconPath(app) });
    if (child) {
      helpers.set(id, child);
      child.on?.('exit', () => {
        if (helpers.get(id) === child) helpers.delete(id);
      });
    }
  });

  // Si el launcher se cierra con el juego abierto, el ayudante sigue hasta que se cierra el juego (es liviano).
  onQuit?.(() => helpers.clear());
}

module.exports = { register, prefs };
