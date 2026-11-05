'use strict';
// Venus dentro del juego: antes de cada partida activa el paquete de recursos "Venus Launcher" (pantalla de carga,
// texto del menu y frases) y, con el juego abierto, pone el icono y el titulo de Venus en la ventana.
// Ajustes (settings.ingame): pack (paquete de recursos) y window (icono y titulo), los dos prendidos por defecto, y
// badge (insignia de Venus junto al nombre, ver ingame/badge.js e ingame/badgemod.js), apagada hasta que el jugador
// la activa: instala el mod "Venus Badge" en las instancias compatibles y anota la cuenta de Minecraft.
// (La 4.6 retiro las capas de Venus: el ajuste capes ya no existe y el mod 1.3.0 no las dibuja. Ver docs/wip/capas-retiro-46.md.)
// Las partidas de prueba (busqueda del culpable de un crash) no se tocan.
const fs = require('fs');
const path = require('path');
const paths = require('../core/paths');
const secure = require('../core/secure');
const { t } = require('../core/i18n');
const pack = require('./ingame/pack');
const windowBrand = require('./ingame/window');
const badgeMod = require('./ingame/badgemod');
const { createBadgeClient } = require('./ingame/badge');

const DEFAULTS = { pack: true, window: true, badge: false };
const SESSION_KEY = 'ui:sb.venus-auth';

function prefs(settings) {
  const s = settings?.ingame && typeof settings.ingame === 'object' ? settings.ingame : {};
  return { pack: s.pack !== false && DEFAULTS.pack, window: s.window !== false && DEFAULTS.window, badge: s.badge === true };
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

// ---------- Insignia: sesion de Venus y estado para la interfaz ----------
let sendToUi = () => {};

async function storedSession() {
  try {
    const raw = await secure.get(SESSION_KEY);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}
const fresh = (s) => s?.access_token && (!s.expires_at || s.expires_at * 1000 - Date.now() > 60000);

// Token de la cuenta de Venus; si vencio, le pide a la interfaz que la renueve (como support.js). null sin sesion.
async function venusToken() {
  const s = await storedSession();
  if (!s?.access_token) return null;
  if (fresh(s)) return s.access_token;
  sendToUi('cloud:refreshSession');
  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const next = await storedSession();
    if (!next?.access_token) return null;
    if (fresh(next)) return next.access_token;
  }
  return null;
}

let client = null;
function badgeClient() {
  return (client ||= createBadgeClient({
    fetch: (...args) => fetch(...args),
    cloudConfig: () => require('../core/cloud-defaults').config(),
    accessToken: venusToken,
  }));
}

// Lo que muestra Ajustes debajo del interruptor. state: idle | working | ok | removed | error
let badgeState = { state: 'idle', code: null, account: null, at: 0 };
function setBadgeState(next) {
  badgeState = { ...badgeState, code: null, ...next, at: Date.now() };
  sendToUi('ingame:badgeStatus', badgeState);
}

async function badgeStatus() {
  let s = {};
  try {
    s = await require('../core/settings').get();
  } catch {
    /* valores por defecto */
  }
  return {
    ...badgeState,
    enabled: prefs(s).badge,
    signedIn: Boolean((await storedSession())?.access_token),
    bundled: await badgeMod.bundled(),
    versions: badgeMod.supportedVersions(),
  };
}

const markEnrolled = (v) => require('../core/settings').set({ ingame: { badgeEnrolled: v } }).catch(() => {});

let syncing = Promise.resolve();
// Anota la cuenta de Minecraft (la de la partida o la seleccionada). Nunca lanza: deja el resultado en el estado.
function syncBadge(account) {
  syncing = syncing.then(async () => {
    try {
      const acc = account || (await require('../core/accounts').getLaunchAccount());
      setBadgeState({ state: 'working', account: acc?.name || null });
      await badgeClient().ensure(acc);
      await markEnrolled(true);
      setBadgeState({ state: 'ok', account: acc.name });
    } catch (err) {
      if (err?.code === 'network' || err?.code === 'server') console.warn('[ingame] insignia', err.message);
      setBadgeState({ state: 'error', code: err?.code || 'server' });
    }
  });
  return syncing;
}

// Borra del servidor todas las cuentas de esta cuenta de Venus.
function removeBadge() {
  syncing = syncing.then(async () => {
    try {
      setBadgeState({ state: 'working', account: null });
      await badgeClient().remove(null);
      await markEnrolled(false);
      setBadgeState({ state: 'removed' });
    } catch (err) {
      setBadgeState({ state: 'error', code: err?.code || 'server' });
    }
  });
  return syncing;
}

function register({ app, handle, send, onQuit }) {
  const game = require('../core/game');
  const settingsStore = require('../core/settings');
  const helpers = new Map(); // instanceId -> proceso del ayudante de la ventana
  if (typeof send === 'function') sendToUi = send;

  game.addBeforeLaunch(async ({ instance, resolved, settings, quiet, account }) => {
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
    const badge = prefs(settings).badge;
    try {
      const cfg = require('../core/cloud-defaults').config();
      await badgeMod.apply({
        instanceDir: instance.dir,
        loader: instance.loader,
        loaderVersion: instance.loaderVersion,
        mcVersion: instance.mcVersion,
        enabled: badge,
        server: cfg.configured ? { url: cfg.url, anonKey: cfg.anonKey } : null,
      });
    } catch (err) {
      console.warn('[ingame] mod de la insignia', err);
    }
    // En segundo plano: la partida no espera al servidor ni a Mojang.
    if (badge && account?.type === 'msa') syncBadge(account);
    else if (!badge && settings?.ingame?.badgeEnrolled) removeBadge();
    return null;
  });

  // El interruptor de Ajustes anota la cuenta seleccionada o borra todo al momento.
  settingsStore.onChange((s, patch) => {
    if (!patch?.ingame || !('badge' in patch.ingame)) return;
    if (patch.ingame.badge === true) syncBadge(null);
    else if (s?.ingame?.badgeEnrolled !== false) removeBadge();
  });

  handle('ingame:badgeStatus', () => badgeStatus());

  game.events.on('state', async (id, payload) => {
    if (!payload || payload.quiet) return;
    if (payload.state !== 'running') {
      helpers.delete(id);
      return;
    }
    if (!payload.pid || helpers.has(id)) return;
    let s = {};
    try {
      s = await settingsStore.get();
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

// venusToken y badgeClient los usa también modules/rewards.js (verificar la cuenta de Minecraft para las invitaciones).
module.exports = { register, prefs, venusToken, badgeClient };
