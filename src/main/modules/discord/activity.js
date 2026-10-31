'use strict';
// Rich Presence: qué se muestra en Discord según lo que pasa en el launcher y los ajustes de privacidad.
// Funciones puras (sin Electron ni red): se pueden probar con Node.
const net = require('net');

const DEFAULTS = Object.freeze({
  enabled: false, // apagado hasta que el usuario lo active (Ajustes > Privacidad o el aviso de conexiones)
  clientId: '', // Public Application ID: user setting, or the launcher's bundled default.
  showIdle: true, // mostrar "En el launcher" cuando no estás jugando
  showInstance: true, // nombre de la instancia
  showWorld: true, // nombre del mundo en un jugador
  showServer: true, // dirección del servidor (las IP y los túneles privados nunca se muestran)
  buttons: [], // hasta 2 botones { label, url }
});
const CLIENT_ID_RE = /^[1-9]\d{16,20}$/;
const ASSET_KEY = 'venus';
const LOADER_NAMES = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  optifine: 'OptiFine',
  iris: 'Iris',
  legacyfabric: 'Legacy Fabric',
  babric: 'Babric',
};
// Túneles y servicios para jugar con amigos: la dirección funciona como una invitación privada
const PRIVATE_HOSTS = /(^|\.)(e4mc\.link|bore\.pub|joinmc\.link|playit\.gg|ply\.gg|ngrok\.io|ngrok\.app|ngrok-free\.app|trycloudflare\.com|localhost|local|lan|home|internal|localdomain)$/i;

function validClientId(id) {
  return typeof id === 'string' && CLIENT_ID_RE.test(id.trim());
}

function validButtonUrl(url) {
  if (typeof url !== 'string' || !url || url.length > 512) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && Boolean(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

function normalizeButtons(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const b of list) {
    if (!b || typeof b !== 'object') continue;
    const label = typeof b.label === 'string' ? b.label.replace(/\s+/g, ' ').trim() : '';
    const url = typeof b.url === 'string' ? b.url.trim() : '';
    if (!label || label.length > 32 || !validButtonUrl(url)) continue;
    out.push({ label, url });
    if (out.length === 2) break;
  }
  return out;
}

// Ajustes con valores por defecto (settings.discord)
function config(settings) {
  const raw = settings && typeof settings.discord === 'object' && settings.discord ? settings.discord : {};
  return {
    enabled: raw.enabled !== undefined ? Boolean(raw.enabled) : DEFAULTS.enabled,
    clientId: typeof raw.clientId === 'string' ? raw.clientId.trim() : '',
    showIdle: raw.showIdle !== undefined ? Boolean(raw.showIdle) : DEFAULTS.showIdle,
    showInstance: raw.showInstance !== undefined ? Boolean(raw.showInstance) : DEFAULTS.showInstance,
    showWorld: raw.showWorld !== undefined ? Boolean(raw.showWorld) : DEFAULTS.showWorld,
    showServer: raw.showServer !== undefined ? Boolean(raw.showServer) : DEFAULTS.showServer,
    buttons: normalizeButtons(raw.buttons),
  };
}

// A public Application ID identifies the application shown by Discord; it is not a bot token.
function resolveConfig(settings, bundledClientId = '') {
  const cfg = config(settings);
  const userId = validClientId(cfg.clientId) ? cfg.clientId : '';
  const bundledId = validClientId(bundledClientId) ? bundledClientId.trim() : '';
  return { ...cfg, clientId: userId || bundledId, clientIdSource: userId ? 'user' : bundledId ? 'bundled' : 'none' };
}

function validateClientIdInput(value) {
  if (typeof value !== 'string') throw new TypeError('INVALID_CLIENT_ID');
  const id = value.trim();
  if (id && !validClientId(id)) throw new TypeError('INVALID_CLIENT_ID');
  return id;
}

// Discord pide textos de 2 a 128 caracteres
function clamp(text, max = 128) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length > max) {
    const chars = [...s];
    while (chars.join('').length > max - 1) chars.pop();
    s = `${chars.join('').trimEnd()}…`;
  }
  if (s.length < 2) s = `${s}⠀`;
  return s;
}

function hostOf(address) {
  const a = String(address || '').trim().toLowerCase();
  if (a.startsWith('[')) return a.slice(1, a.indexOf(']') > 0 ? a.indexOf(']') : undefined);
  const colons = (a.match(/:/g) || []).length;
  return colons === 1 ? a.split(':')[0] : a;
}

// Las IP (pueden ser la casa de alguien), nombres de red local y túneles privados nunca se muestran
function isPrivateAddress(address) {
  const host = hostOf(address).replace(/\.$/, '');
  if (!host) return true;
  if (net.isIP(host)) return true;
  if (!host.includes('.')) return true;
  return PRIVATE_HOSTS.test(host);
}

function versionLabel(inst, t) {
  const key = inst?.preset === 'iris' ? 'iris' : inst?.loader || 'vanilla';
  const version = inst?.mcVersion || '?';
  if (key === 'vanilla') return t('discord.versionVanilla', { version });
  return t('discord.versionLoader', { loader: LOADER_NAMES[key] || key, version });
}

function stateText(session, cfg, t) {
  if (session.state === 'preparing') return t('discord.statePreparing');
  const act = session.activity;
  if (!act) return t('discord.stateStarting');
  if (act.type === 'menu') return t('discord.stateMenu');
  if (act.type === 'singleplayer') return cfg.showWorld && act.world ? t('discord.stateWorld', { world: act.world }) : t('discord.stateSingleplayer');
  if (act.type === 'server') return cfg.showServer && act.address && !isPrivateAddress(act.address) ? t('discord.stateServer', { address: act.address }) : t('discord.stateMultiplayer');
  return t('discord.stateMenu');
}

/**
 * Actividad para SET_ACTIVITY (o null si no hay nada para mostrar).
 * session: null (en el launcher) | { state: 'preparing'|'running', startedAt, instance, activity }
 * asset: clave confirmada de la imagen grande; null omite imágenes no configuradas.
 */
function buildActivity({ cfg, session, t, appVersion, launcherStartedAt, asset = ASSET_KEY }) {
  const brand = asset ? { large_image: asset, large_text: clamp(t('discord.largeText', { version: appVersion })) } : null;
  let activity;
  if (!session) {
    if (!cfg.showIdle) return null;
    activity = {
      details: clamp(t('discord.inLauncher')),
      state: clamp(t('discord.idleState')),
      timestamps: { start: launcherStartedAt },
      assets: brand,
    };
  } else {
    const inst = session.instance || {};
    const version = versionLabel(inst, t);
    const details = cfg.showInstance && inst.name ? t('discord.detailsInstance', { name: inst.name, version }) : version;
    const assets = brand ? { ...brand } : null;
    // Ícono del modpack (URL https) como imagen grande y el logo de Venus chiquito
    if (assets && cfg.showInstance && typeof inst.icon === 'string' && /^https:\/\//.test(inst.icon) && inst.icon.length <= 256) {
      assets.large_image = inst.icon;
      assets.large_text = clamp(inst.name || version);
      assets.small_image = asset;
      assets.small_text = brand.large_text;
    }
    activity = {
      details: clamp(details),
      state: clamp(stateText(session, cfg, t)),
      timestamps: { start: session.startedAt || Date.now() },
      assets,
    };
  }
  if (cfg.buttons.length) activity.buttons = cfg.buttons.map((b) => ({ label: b.label, url: b.url }));
  activity.instance = false;
  for (const k of Object.keys(activity)) if (activity[k] === null || activity[k] === undefined) delete activity[k];
  return activity;
}

// Actividad de prueba (botón "Probar")
function testActivity({ cfg, t, appVersion, asset = ASSET_KEY }) {
  const activity = {
    details: clamp(t('discord.testDetails')),
    state: clamp(t('discord.testState')),
    timestamps: { start: Date.now() },
    ...(asset ? { assets: { large_image: asset, large_text: clamp(t('discord.largeText', { version: appVersion })) } } : {}),
    instance: false,
  };
  if (cfg.buttons.length) activity.buttons = cfg.buttons.map((b) => ({ label: b.label, url: b.url }));
  return activity;
}

module.exports = { DEFAULTS, ASSET_KEY, LOADER_NAMES, validClientId, validButtonUrl, normalizeButtons, config, resolveConfig, validateClientIdInput, clamp, isPrivateAddress, buildActivity, testActivity };
