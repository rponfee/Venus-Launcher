'use strict';
// Control remoto del servidor local desde el celular: apagado por defecto y por servidor. Mientras está prendido hay un
// servidor HTTP solo en la IP de la red local, con una página propia (serverremote/page) para ver el estado, los
// jugadores y la consola, y para iniciar, detener, reiniciar y mandar comandos. Nada se guarda: al cerrar el launcher,
// a las 12 h o al apagarlo se corta, y cada encendido genera un token nuevo. Ver docs/implementacion/servidores.md.
//   serverremote:addresses()          -> [{ name, address }] IP de la red local elegibles
//   serverremote:status(id)           -> { on: false } o { on, address, port, baseUrl, url, code, expiresAt, rejected, clients, qr }
//   serverremote:start(id, { address? }) · serverremote:stop(id) · serverremote:rotate(id) · serverremote:kick(id, ip)
//   evento serverremote:changed       -> (id, { on, kind, reason?, device? }) sin el token
const servers = require('../core/servers');
const tasks = require('../core/tasks');
const { t, getLanguage } = require('../core/i18n');
const netinfo = require('./netplay/netinfo');
const sec = require('./serverremote/security');
const { createRemoteHost } = require('./serverremote/host');
const { encodeQr } = require('./serverremote/qr');

const NET_CHECK_MS = 60000;
const hosts = new Map(); // id de servidor -> host
const starting = new Map(); // id -> inicio pendiente, también se puede cancelar
let notify = () => {};
let changedServers = () => {};
let isDevLoopback = () => false;

// Textos de la página del celular (i18n del proceso principal, ns serverremote)
const PAGE_KEYS = [
  'page_loginText', 'page_codeLabel', 'page_connect', 'page_start', 'page_restart', 'page_stop', 'page_players', 'page_noPlayers', 'page_console',
  'page_commandLabel', 'page_commandPlaceholder', 'page_send', 'page_forget', 'page_cancel', 'page_badCode', 'page_badFormat', 'page_cut', 'page_denied',
  'page_tooMany', 'page_expired', 'page_offline', 'page_expiresIn', 'page_state_online', 'page_state_offline', 'page_state_starting', 'page_state_stopping',
  'page_confirmStopTitle', 'page_confirmStopText', 'page_confirmRestartTitle', 'page_confirmRestartText', 'page_confirmCommandTitle', 'page_confirmCommandText',
  'page_err_busy', 'page_err_offline', 'page_err_bad_command', 'page_err_too_large', 'page_err_failed',
];

function pageStrings() {
  const out = { lang: getLanguage() };
  // Sin variables: {minutes} y {hours} viajan tal cual y los completa la página
  for (const k of PAGE_KEYS) out[k] = t(`serverremote.${k}`);
  return out;
}

function deviceLabel(device) {
  return [device?.os, device?.browser].filter(Boolean).join(' · ') || t('serverremote.unknownDevice');
}

function coded(code, message) {
  return Object.assign(new Error(message || code), { code });
}

// Lo que el celular puede ver del servidor. Sin IP, UUID ni rutas: solo estos campos pasan.
async function snapshot(id) {
  const s = await servers.get(id);
  return {
    name: s.name,
    typeName: servers.TYPES[s.type]?.name || s.type,
    version: s.mcVersion,
    state: s.state,
    busy: Boolean(s.busy),
    startedAt: s.startedAt || null,
    players: (s.playerInfo || []).map((p) => ({ name: p.name, since: p.since || null })),
  };
}

// Las acciones que tardan (iniciar, reiniciar) corren como tarea del launcher y el celular ve el avance por el estado.
function runTask(s, titleKey, fn, logIt) {
  tasks
    .run(t(titleKey, { name: s.name }), fn, { serverId: s.id })
    .then(logIt) // después: al arrancar, core/servers vacía la consola
    .catch((err) => console.warn('[serverremote] acción:', err?.message || err))
    .finally(() => changedServers());
}

async function runAction(id, { action, command, device }) {
  const s = await servers.get(id);
  // Queda en la consola del servidor qué pidió el celular (el comando en sí lo escribe servers.command)
  const logIt = () => servers.venusLog(id, t(`serverremote.logAction_${action}`, { device: deviceLabel(device) }));
  if (action === 'start') {
    if (s.state !== 'offline' || s.busy) throw coded('busy');
    runTask(s, 'servers.taskStart', (task) => servers.start(id, task), logIt);
    return;
  }
  if (action === 'restart') {
    if (s.state !== 'online' || s.busy) throw coded(s.state === 'offline' ? 'offline' : 'busy');
    runTask(s, 'servers.taskRestart', (task) => servers.restart(id, task), logIt);
    return;
  }
  if (action === 'stop') {
    if (s.state === 'offline') throw coded('offline');
    logIt();
    if (!servers.stop(id)) throw coded('busy');
    changedServers();
    return;
  }
  if (action === 'command') {
    if (s.state === 'offline') throw coded('offline');
    logIt();
    try {
      servers.command(id, command);
    } catch {
      throw coded('offline');
    }
    return;
  }
  throw coded('failed');
}

function addresses() {
  if (isDevLoopback()) return [{ name: 'devshot', address: '127.0.0.1' }];
  return sec.lanAddresses(netinfo.localInterfaces());
}

function status(id) {
  const host = hosts.get(id);
  if (!host || host.isStopped()) return { on: false };
  const info = host.info();
  return { ...info, qr: encodeQr(info.url) };
}

async function start(id, opts = {}) {
  const pending = starting.get(id);
  if (pending) return pending.promise;
  const entry = { reason: null };
  entry.promise = startHost(id, opts, entry);
  starting.set(id, entry);
  try {
    return await entry.promise;
  } finally {
    if (starting.get(id) === entry) starting.delete(id);
  }
}

async function startHost(id, opts, pending) {
  await servers.get(id);
  if (pending.reason) return { on: false };
  const cur = hosts.get(id);
  if (cur && !cur.isStopped()) return status(id);
  const list = addresses();
  if (!list.length) throw coded('noLan', t('serverremote.errNoLan'));
  const ip = list.some((a) => a.address === opts?.address) ? opts.address : list[0].address;
  let lastRejected = 0;
  const host = createRemoteHost({
    ip,
    backend: { snapshot: () => snapshot(id), action: (a) => runAction(id, a) },
    strings: pageStrings,
    onEvent(kind, data) {
      if (kind === 'stopped') {
        if (hosts.get(id) !== host) return;
        hosts.delete(id);
        if (data.reason !== 'quit' && data.reason !== 'removed') servers.venusLog(id, t('serverremote.logOff'));
        notify('serverremote:changed', id, { on: false, kind, reason: data.reason });
      } else if (kind === 'connected') notify('serverremote:changed', id, { on: true, kind, device: deviceLabel(data.device) });
      else if (Date.now() - lastRejected > 3000) {
        // Un aluvión de pedidos rechazados no tiene que llenar de eventos a la interfaz
        lastRejected = Date.now();
        notify('serverremote:changed', id, { on: true, kind });
      }
    },
  });
  for (const entry of servers.logs(id).slice(-200)) host.pushLine(entry);
  try {
    await host.start();
  } catch (err) {
    host.stop('listen');
    console.warn('[serverremote] no se pudo escuchar:', err?.message || err);
    throw coded('listen', t('serverremote.errListen'));
  }
  if (pending.reason || host.isStopped()) {
    host.stop(pending.reason || 'stopped');
    return { on: false };
  }
  hosts.set(id, host);
  servers.venusLog(id, t('serverremote.logOn'));
  notify('serverremote:changed', id, { on: true, kind: 'started' });
  return status(id);
}

function stopFor(id, reason = 'stopped') {
  const pending = starting.get(id);
  if (pending) pending.reason = reason;
  const host = hosts.get(id);
  if (!host) return Boolean(pending);
  host.stop(reason);
  return true;
}

function stopAll(reason = 'quit') {
  for (const id of new Set([...hosts.keys(), ...starting.keys()])) stopFor(id, reason);
}

function register({ app, handle, send, onQuit }) {
  notify = (channel, ...args) => send(channel, ...args);
  changedServers = () => send('servers:changed');
  // Solo para capturas y sin empaquetar: la "red local" es 127.0.0.1, así la prueba no abre nada hacia afuera
  isDevLoopback = () => Boolean(process.env.VENUS_DEVSHOT && process.env.VENUS_REMOTE_FAKE_LAN && !app?.isPackaged);

  handle('serverremote:addresses', () => addresses());
  handle('serverremote:status', async (id) => {
    await servers.get(id);
    return status(id);
  });
  handle('serverremote:start', (id, opts) => start(id, opts || {}));
  handle('serverremote:stop', async (id) => {
    await servers.get(id);
    stopFor(id, 'stopped');
    return { on: false };
  });
  handle('serverremote:rotate', async (id) => {
    await servers.get(id);
    const host = hosts.get(id);
    if (!host || !host.rotate()) throw coded('off', t('serverremote.errOff'));
    return status(id);
  });
  handle('serverremote:kick', async (id, ip) => {
    await servers.get(id);
    const host = hosts.get(id);
    if (!host || host.isStopped()) throw coded('off', t('serverremote.errOff'));
    host.kick(String(ip ?? ''));
    return status(id);
  });

  servers.events.on('log', (id, entry) => hosts.get(id)?.pushLine(entry));

  // Si la PC cambia de red, la IP deja de ser de esta red: se apaga en lugar de quedar colgado de otra interfaz
  const netTimer = setInterval(() => {
    if (!hosts.size) return;
    const valid = new Set(addresses().map((a) => a.address));
    for (const [id, host] of hosts) if (!valid.has(host.info().address)) stopFor(id, 'network');
  }, NET_CHECK_MS);
  netTimer.unref?.();

  onQuit(() => {
    clearInterval(netTimer);
    stopAll('quit');
  });
}

module.exports = { register, status, start, stopFor, stopAll, addresses, PAGE_KEYS };
