'use strict';
// Jugar con amigos sin abrir puertos (modulo "netplay"):
//  - Direcciones: LAN, IP pública, puerta de enlace y estimación de CGNAT / doble NAT
//  - Abrir puertos en el router: UPnP IGD, con NAT-PMP / PCP como alternativa (se cierran al salir)
//  - Túneles TCP con bore (el servidor que trae el launcher en core/app-config.js), con reconexión automática
//  - Mundos en LAN para amigos: e4mc (dominio *.e4mc.link) o túnel al puerto LAN
// Canales "netplay:*" (ver docs/arquitectura.md) y eventos netplay:upnp, netplay:tunnel, netplay:world,
// netplay:e4mcDomain (instanceId, dominio|null) y netplay:lan (instanceId, { port }|null).
const fsp = require('fs/promises');
const path = require('path');
const { t } = require('../core/i18n');
const paths = require('../core/paths');
const { readJson, writeJson, uid } = require('../core/util');
const netinfo = require('./netplay/netinfo');
const upnp = require('./netplay/upnp');
const natpmp = require('./netplay/natpmp');
const { BoreClient } = require('./netplay/bore');
const slp = require('./netplay/slp');
const e4mc = require('./netplay/e4mc');
const playit = require('./netplay/playit');

// Modulos del nucleo: se cargan al usarlos para poder probar este archivo con Node puro
const core = {
  get servers() {
    return require('../core/servers');
  },
  get game() {
    return require('../core/game');
  },
  get instances() {
    return require('../core/instances');
  },
  get modrinth() {
    return require('../core/modrinth');
  },
  get tasks() {
    return require('../core/tasks');
  },
};

const LEASE = 3600; // segundos; se renueva a la mitad
const VOICE_DEFAULT_PORT = 24454; // Simple Voice Chat (UDP)

let sendFn = () => {};
let data = { servers: {}, mappings: [] };
let dataLoaded = null;
let saveTimer = null;

// Router
let router = null; // { kind: 'upnp'|'pmp', method, igd?, pmp?, externalIp, localAddress, info }
let routerAt = 0;
let routerPending = null;
let lastUpnpError = null;
const mappings = new Map(); // 'TCP:25565' -> mapeo activo

// Tuneles y mundos en LAN
const tunnels = new Map(); // id -> { id, provider, client, serverId, instanceId, localPort, createdAt, verified, warning }
const worlds = new Map(); // instanceId -> { lanPort, domain, error, autoTunnel, tunnelId, tunnelError }
const serverStarted = new Set();
const versionCache = new Map(); // `${loader}|${mc}` -> { at, value }

const send = (ch, ...args) => {
  try {
    sendFn(ch, ...args);
  } catch {
    /* ventana cerrada */
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Datos propios (data/netplay.json) ----------

function loadData() {
  if (!dataLoaded) {
    dataLoaded = readJson(paths.data('netplay.json'), {})
      .then((d) => {
        data = { servers: d && typeof d.servers === 'object' && d.servers ? d.servers : {}, mappings: Array.isArray(d?.mappings) ? d.mappings : [] };
      })
      .catch(() => {});
  }
  return dataLoaded;
}

function persistMappings() {
  data.mappings = [...mappings.values()].map((m) => ({ port: m.port, externalPort: m.externalPort, protocol: m.protocol, method: m.method, internalClient: m.internalClient, nonce: m.nonce || null, createdAt: m.createdAt }));
}

function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeJson(paths.data('netplay.json'), data).catch((err) => console.warn('[netplay] guardar', err.message));
  }, 300);
}

async function saveNow() {
  clearTimeout(saveTimer);
  await writeJson(paths.data('netplay.json'), data).catch(() => {});
}

function validServerId(id) {
  if (typeof id !== 'string' || !/^[\w.-]{1,80}$/.test(id)) throw new Error(t('netplay.errServerId'));
  return id;
}

function serverPrefs(id) {
  return { upnp: false, voice: false, tunnelAuto: false, lastRemotePort: null, lastHost: null, customAddress: null, ...(data.servers[id] || {}) };
}

// ---------- Direcciones ----------

async function addresses(opts = {}) {
  const force = Boolean(opts?.force);
  const [primary, gw, pub] = await Promise.all([netinfo.primaryAddress(), netinfo.defaultGateway({ force }), netinfo.publicIp({ force })]);
  const interfaces = netinfo.localInterfaces();
  let routerExternalIp = null;
  try {
    // No esperar demasiado al router: si ya se descubrio, el dato esta en cache
    const r = await Promise.race([getRouter(), sleep(4000).then(() => null)]);
    routerExternalIp = r?.externalIp || null;
  } catch {
    routerExternalIp = null;
  }
  const lan = [];
  if (primary && interfaces.some((i) => i.address === primary && i.kind !== 'vpn')) lan.push(primary);
  for (const i of interfaces) if (i.kind === 'lan' && !lan.includes(i.address)) lan.push(i.address);
  if (!lan.length && primary) lan.push(primary);
  const guess = netinfo.cgnatGuess({ publicIp: pub?.ip, routerExternalIp });
  return {
    lan,
    primary: primary || lan[0] || null,
    vpn: interfaces.filter((i) => i.kind === 'vpn').map((i) => ({ name: i.name, address: i.address })),
    interfaces,
    gateway: gw?.gateway || null,
    gatewayGuessed: Boolean(gw?.guessed),
    publicIp: pub?.ip || null,
    publicIpSource: pub?.source || null,
    routerExternalIp,
    cgnat: guess.cgnat,
    cgnatReason: guess.reason,
  };
}

// ---------- Router (UPnP / NAT-PMP / PCP) ----------

function upnpSnapshot(extra = {}) {
  return {
    discovering: Boolean(routerPending),
    available: Boolean(router),
    method: router?.method || null,
    router: router ? router.info : null,
    externalIp: router?.externalIp || null,
    localAddress: router?.localAddress || null,
    mappings: [...mappings.values()].map(publicMapping),
    error: lastUpnpError,
    checkedAt: routerAt || null,
    ...extra,
  };
}

function emitUpnp() {
  send('netplay:upnp', upnpSnapshot());
}

async function getRouter({ refresh = false } = {}) {
  if (!refresh && router && Date.now() - routerAt < 10 * 60000) return router;
  // Si recien fallo, no volver a buscar en cada pedido
  if (!refresh && !router && routerAt && Date.now() - routerAt < 60000) return null;
  if (routerPending) return routerPending;
  routerPending = (async () => {
    const gw = await netinfo.defaultGateway({ force: refresh });
    let found = null;
    try {
      const igd = await upnp.findGateway({ gatewayIp: gw?.gateway || null });
      if (igd) found = { kind: 'upnp', method: 'upnp', igd, externalIp: igd.lastExternalIp || null, localAddress: igd.localAddress, info: igd.snapshot() };
    } catch (err) {
      console.warn('[netplay] UPnP', err.message);
    }
    if (!found && gw?.gateway) {
      const p = await natpmp.probe(gw.gateway).catch(() => null);
      if (p) found = { kind: 'pmp', method: p.method, pmp: p, externalIp: p.externalIp, localAddress: p.clientIp, info: { name: p.method === 'pcp' ? 'PCP' : 'NAT-PMP', manufacturer: '', model: '', host: gw.gateway } };
    }
    // Si cambio de router, los mapeos anteriores ya no sirven
    if (router && found && router.info?.host !== found.info?.host) {
      for (const m of mappings.values()) clearTimeout(m.timer);
      mappings.clear();
    }
    router = found;
    routerAt = Date.now();
    lastUpnpError = found ? null : t('netplay.errNoRouter');
    return found;
  })().finally(() => {
    routerPending = null;
    emitUpnp();
  });
  emitUpnp();
  return routerPending;
}

function publicMapping(m) {
  return {
    port: m.port,
    externalPort: m.externalPort,
    protocol: m.protocol,
    description: m.description,
    method: m.method,
    lease: m.lease,
    internalClient: m.internalClient,
    externalIp: m.externalIp || router?.externalIp || null,
    serverId: m.serverId || null,
    auto: Boolean(m.auto),
    createdAt: m.createdAt,
    renewedAt: m.renewedAt || null,
    error: m.error || null,
  };
}

function asciiDescription(s) {
  return (
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\x20-\x7e]/g, '')
      .trim()
      .slice(0, 60) || 'Venus Launcher'
  );
}

function checkPort(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(t('netplay.errPort'));
  return p;
}

// Puertos que nunca se exponen a internet desde acá (escritorio remoto, archivos compartidos, bases de datos,
// depuradores...). Los puertos de un servidor local o de un mundo en LAN detectado no pasan por este filtro.
const SENSITIVE_PORTS = new Set([135, 137, 138, 139, 445, 1433, 1434, 3306, 3389, 5432, 5900, 5901, 5985, 5986, 6379, 9222, 9229, 11211, 27017]);

function checkExposable(port) {
  const p = checkPort(port);
  if (p < 1024 || SENSITIVE_PORTS.has(p)) throw new Error(t('netplay.errSensitivePort', { port: p }));
  return p;
}

function checkProtocol(protocol) {
  const p = String(protocol || 'TCP').toUpperCase();
  if (p !== 'TCP' && p !== 'UDP') throw new Error(t('netplay.errProtocol'));
  return p;
}

// Error del router -> mensaje para el usuario
function routerError(err, port) {
  if (err?.code === 606 || err?.code === 2) return new Error(t('netplay.errNotAuthorized'));
  if (err?.code === 728 || err?.code === 4 || err?.code === 8) return new Error(t('netplay.errNoPortMaps'));
  if (err?.code === 718) return new Error(t('netplay.errConflict', { port, ip: '?' }));
  if (err?.timeout || /tiempo|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH/i.test(err?.message || '')) return new Error(t('netplay.errRouterTimeout'));
  return new Error(t('netplay.errUpnp', { detail: err?.description || err?.message || String(err) }));
}

async function upnpAdd(r, { port, protocol, description }) {
  const internalClient = r.localAddress;
  if (!internalClient) throw new Error(t('netplay.errNoLocalIp'));
  const args = { externalPort: port, internalPort: port, protocol, internalClient, description };
  let lease = LEASE;
  const add = async () => {
    try {
      await r.igd.addMapping({ ...args, lease });
    } catch (err) {
      if (err.code !== 725 || lease === 0) throw err;
      lease = 0; // el router solo acepta mapeos permanentes (se borran al cerrar)
      await r.igd.addMapping({ ...args, lease });
    }
  };
  try {
    await add();
  } catch (err) {
    if (err.code !== 718) throw routerError(err, port);
    const cur = await r.igd.getMapping({ externalPort: port, protocol }).catch(() => null);
    if (cur && cur.internalClient && cur.internalClient !== internalClient) throw new Error(t('netplay.errConflict', { port, ip: cur.internalClient }));
    // Ya apuntaba a esta PC (quedo de otra sesion): rehacerlo
    await r.igd.deleteMapping({ externalPort: port, protocol }).catch(() => {});
    try {
      await add();
    } catch (err2) {
      throw routerError(err2, port);
    }
  }
  // Algunos routers aceptan el pedido y no hacen nada: comprobar
  const check = await r.igd.getMapping({ externalPort: port, protocol }).catch(() => undefined);
  if (check === null) throw new Error(t('netplay.errIgnored'));
  return { method: 'upnp', externalPort: port, internalClient, lease, externalIp: r.externalIp || null, nonce: null };
}

async function pmpAdd(r, { port, protocol, nonce = null }) {
  try {
    const res = await natpmp.map(r.pmp, { protocol, internalPort: port, externalPort: port, lifetime: LEASE, nonce: nonce ? Buffer.from(nonce, 'hex') : undefined });
    r.method = r.pmp.method;
    return { method: r.pmp.method, externalPort: res.externalPort, internalClient: r.localAddress, lease: res.lifetime, externalIp: res.externalIp && res.externalIp !== '0.0.0.0' ? res.externalIp : r.externalIp, nonce: res.nonce ? res.nonce.toString('hex') : null };
  } catch (err) {
    throw routerError(err, port);
  }
}

function scheduleRenew(m) {
  clearTimeout(m.timer);
  if (!m.lease) return;
  m.timer = setTimeout(() => renew(m), Math.max(60, Math.floor(m.lease / 2)) * 1000);
  m.timer.unref?.();
}

async function renew(m) {
  if (mappings.get(m.key) !== m || !router) return;
  try {
    const r = router.kind === 'upnp' ? await upnpAdd(router, m) : await pmpAdd(router, m);
    Object.assign(m, r, { renewedAt: Date.now(), error: null });
  } catch (err) {
    m.error = err.message;
    m.lease = 60; // reintentar en un minuto
  }
  scheduleRenew(m);
  emitUpnp();
}

async function openPort(port, opts = {}) {
  const p = checkPort(port);
  const protocol = checkProtocol(opts?.protocol);
  const key = `${protocol}:${p}`;
  const existing = mappings.get(key);
  if (existing && !existing.error) {
    if (opts?.serverId) existing.serverId = opts.serverId;
    if (opts?.auto === false) existing.auto = false;
    return publicMapping(existing);
  }
  const r = await getRouter();
  if (!r) throw new Error(t('netplay.errNoRouter'));
  const description = asciiDescription(opts?.description || 'Venus Launcher');
  const res = r.kind === 'upnp' ? await upnpAdd(r, { port: p, protocol, description }) : await pmpAdd(r, { port: p, protocol });
  if (existing) clearTimeout(existing.timer);
  const m = { key, port: p, protocol, description, serverId: opts?.serverId || null, auto: Boolean(opts?.auto), createdAt: Date.now(), ...res };
  mappings.set(key, m);
  scheduleRenew(m);
  lastUpnpError = null;
  persistMappings();
  saveData();
  emitUpnp();
  return publicMapping(m);
}

async function removeMapping(m) {
  clearTimeout(m.timer);
  if (!router) return;
  if (router.kind === 'upnp') {
    await router.igd.deleteMapping({ externalPort: m.externalPort || m.port, protocol: m.protocol }).catch((err) => {
      if (!(err instanceof upnp.UpnpError && err.code === 714)) throw err;
    });
  } else {
    await natpmp.unmap(router.pmp, { protocol: m.protocol, internalPort: m.port, nonce: m.nonce ? Buffer.from(m.nonce, 'hex') : null });
  }
}

async function closePort(port, protocol) {
  const p = checkPort(port);
  const proto = checkProtocol(protocol);
  const key = `${proto}:${p}`;
  const m = mappings.get(key) || { key, port: p, externalPort: p, protocol: proto };
  mappings.delete(key);
  persistMappings();
  saveData();
  try {
    if (!router) await getRouter();
    await removeMapping(m);
  } catch (err) {
    emitUpnp();
    throw routerError(err, p);
  }
  emitUpnp();
  return true;
}

async function upnpStatus(opts = {}) {
  const refresh = Boolean(opts?.refresh);
  let r = null;
  try {
    r = await getRouter({ refresh });
  } catch (err) {
    lastUpnpError = err.message;
  }
  if (r?.kind === 'upnp' && (refresh || !r.externalIp)) {
    r.externalIp = (await r.igd.externalIp().catch(() => null)) || r.externalIp;
  }
  const extra = {};
  if (opts?.port && r?.kind === 'upnp') {
    const port = checkPort(opts.port);
    const entry = await r.igd.getMapping({ externalPort: port, protocol: checkProtocol(opts.protocol) }).catch(() => undefined);
    extra.entry = entry === undefined ? undefined : entry && { ...entry, mine: entry.internalClient === r.localAddress };
  }
  return upnpSnapshot(extra);
}

// ---------- Servidores locales: mapeo automatico y preferencias ----------

async function voiceChatInfo(srv) {
  let installed = false;
  try {
    const { files } = await core.servers.content(srv.id);
    installed = files.some((f) => /voicechat/i.test(f.file) && f.enabled !== false);
  } catch {
    installed = false;
  }
  if (!installed) return { installed: false, port: null };
  let port = VOICE_DEFAULT_PORT;
  for (const rel of ['config/voicechat/voicechat-server.properties', 'plugins/voicechat/voicechat-server.properties']) {
    const text = await fsp.readFile(path.join(paths.server(srv.id), rel), 'utf8').catch(() => null);
    if (!text) continue;
    const m = /^\s*port\s*=\s*(-?\d+)/m.exec(text);
    if (m) {
      const n = Number(m[1]);
      port = n === -1 ? srv.port : n > 0 && n < 65536 ? n : VOICE_DEFAULT_PORT;
    }
    break;
  }
  return { installed: true, port };
}

async function applyServerMappings(srv, prefs) {
  const out = { mapping: null, voice: null, error: null };
  try {
    out.mapping = await openPort(srv.port, { protocol: 'TCP', description: `Venus ${srv.name}`, serverId: srv.id, auto: true });
  } catch (err) {
    out.error = err.message;
    lastUpnpError = err.message;
    emitUpnp();
    return out;
  }
  if (prefs.voice) {
    const vc = await voiceChatInfo(srv);
    if (vc.installed && vc.port) {
      out.voice = await openPort(vc.port, { protocol: 'UDP', description: `Venus voz ${srv.name}`, serverId: srv.id, auto: true }).catch((err) => ({ error: err.message }));
    }
  }
  return out;
}

async function removeServerMappings(serverId) {
  const list = [...mappings.values()].filter((m) => m.serverId === serverId && m.auto);
  for (const m of list) {
    mappings.delete(m.key);
    await removeMapping(m).catch((err) => console.warn('[netplay] cerrar puerto', err.message));
  }
  if (list.length) {
    persistMappings();
    saveData();
    emitUpnp();
  }
}

async function getServerPrefs(serverId) {
  validServerId(serverId);
  await loadData();
  const srv = await core.servers.get(serverId);
  return { ...serverPrefs(serverId), port: srv.port, voiceChat: await voiceChatInfo(srv) };
}

async function setServerPrefs(serverId, patch = {}) {
  validServerId(serverId);
  await loadData();
  const next = { ...serverPrefs(serverId) };
  for (const k of ['upnp', 'voice', 'tunnelAuto']) if (patch && k in patch) next[k] = Boolean(patch[k]);
  if (patch && 'customAddress' in patch) {
    if (!patch.customAddress) next.customAddress = null;
    else {
      const n = playit.normalizeAddress(patch.customAddress);
      if (!n) throw new Error(t('netplay.errAddress'));
      next.customAddress = n.address;
    }
  }
  data.servers[serverId] = next;
  saveData();
  const srv = await core.servers.get(serverId).catch(() => null);
  const live = srv && (srv.state === 'online' || srv.state === 'starting');
  let result = { mapping: null, voice: null, error: null };
  if (srv && patch && ('upnp' in patch || 'voice' in patch)) {
    if (next.upnp && live) result = await applyServerMappings(srv, next);
    if (!next.upnp) await removeServerMappings(serverId);
    else if (!next.voice) {
      for (const m of [...mappings.values()]) if (m.serverId === serverId && m.auto && m.protocol === 'UDP') await closePort(m.port, 'UDP').catch(() => {});
    }
  }
  if (srv && live && patch?.tunnelAuto && !findTunnel({ serverId })) {
    startTunnel({ serverId, provider: 'bore' }).catch((err) => console.warn('[netplay] túnel automático', err.message));
  }
  return { prefs: { ...next, port: srv?.port ?? null }, ...result };
}

async function onServerState(id, st) {
  await loadData();
  if (st?.state === 'online') {
    // Tuneles creados mientras el servidor arrancaba: probarlos ahora
    for (const tun of tunnels.values()) if (tun.serverId === id && (tun.pendingVerify || !tun.verified)) setTimeout(() => verifyTunnel(tun), 1500);
  }
  if (st?.state === 'starting' || st?.state === 'online') {
    if (serverStarted.has(id)) return;
    serverStarted.add(id);
    const prefs = serverPrefs(id);
    if (!prefs.upnp && !prefs.tunnelAuto) return;
    const srv = await core.servers.get(id).catch(() => null);
    if (!srv) return;
    if (prefs.upnp) applyServerMappings(srv, prefs).catch(() => {});
    if (prefs.tunnelAuto && !findTunnel({ serverId: id })) startTunnel({ serverId: id, provider: 'bore' }).catch((err) => console.warn('[netplay] túnel automático', err.message));
  } else if (st?.state === 'offline') {
    serverStarted.delete(id);
    for (const tun of [...tunnels.values()]) if (tun.serverId === id) stopTunnel(tun.id);
    await removeServerMappings(id);
  }
}

// ---------- Tuneles (bore) ----------

// Servidor de tuneles: el que trae el launcher (core/app-config.js, bore.pub por defecto). No se configura desde
// la interfaz: settings.netplay.boreHost y el secreto 'netplay.boreSecret' de versiones anteriores se ignoran.
async function boreConfig() {
  const { host, secret } = require('../core/app-config').get().bore;
  return { host, secret: secret || null };
}

// Para la interfaz: solo el nombre del servidor (el secreto nunca sale del proceso principal)
async function getBoreConfig() {
  return { host: (await boreConfig()).host };
}

function tunnelSnapshot(tun) {
  return {
    id: tun.id,
    provider: tun.provider,
    serverId: tun.serverId || null,
    instanceId: tun.instanceId || null,
    createdAt: tun.createdAt,
    verified: tun.verified,
    warning: tun.warning,
    ...tun.client.snapshot(),
  };
}

function emitTunnel(tun) {
  send('netplay:tunnel', tunnelSnapshot(tun));
}

function findTunnel({ serverId, instanceId, port }) {
  for (const tun of tunnels.values()) {
    if (['stopped', 'error'].includes(tun.client.status)) continue;
    if (serverId && tun.serverId === serverId) return tun;
    if (instanceId && tun.instanceId === instanceId) return tun;
    if (port && tun.localPort === port) return tun;
  }
  return null;
}

function boreError(err, host) {
  if (err?.needsSecret) return t('netplay.errBoreSecret', { host });
  if (err?.serverError) return t('netplay.errBoreServer', { detail: err.serverError });
  if (/ENOTFOUND|EAI_AGAIN/.test(err?.code || '')) return t('netplay.errBoreDns', { host });
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH/.test(err?.code || '') || /no respondió|no se pudo conectar|cerró la conexión/.test(err?.message || '')) return t('netplay.errBoreUnreachable', { host });
  return t('netplay.errBore', { detail: err?.message || String(err) });
}

// Prueba el tunel desde afuera (Server List Ping a la direccion publica). Sin force, espera a que el servidor este en linea.
async function verifyTunnel(tun, { force = false } = {}) {
  const c = tun.client;
  if (!c.remotePort || c.status !== 'online') return tun.verified;
  if (tun.serverId && !force) {
    const srv = await core.servers.get(tun.serverId).catch(() => null);
    if (srv && srv.state !== 'online') {
      tun.pendingVerify = true;
      return tun.verified;
    }
  }
  tun.pendingVerify = false;
  // La propia prueba entra como una conexion mas: no avisar "llego un jugador" por ella
  tun.selfTestUntil = Date.now() + 12000;
  try {
    const r = await slp.ping(c.host, c.remotePort, { timeout: 9000 });
    tun.verified = { ok: true, latency: r.latency, version: r.version, players: r.players, at: Date.now() };
  } catch (err) {
    tun.verified = { ok: false, error: testError(err), at: Date.now() };
  } finally {
    tun.selfTestUntil = Date.now() + 1500;
  }
  if (tunnels.has(tun.id)) emitTunnel(tun);
  return tun.verified;
}

async function startTunnel(opts = {}) {
  const provider = opts?.provider || 'bore';
  if (provider === 'playit') throw new Error(t('netplay.errPlayitManual'));
  if (provider !== 'bore') throw new Error(t('netplay.errProvider'));
  await loadData();
  let port = opts?.port ? checkPort(opts.port) : null;
  let srv = null;
  if (opts?.serverId) {
    validServerId(opts.serverId);
    srv = await core.servers.get(opts.serverId);
    port = port || srv.port;
  }
  if (!port) throw new Error(t('netplay.errPort'));
  if (!srv) {
    // Sin servidor asociado solo se acepta el puerto LAN detectado del mundo o un puerto "seguro"
    const w = opts?.instanceId ? worldState(opts.instanceId) : null;
    if (!(w && w.lanPort === port)) checkExposable(port);
  }
  const existing = findTunnel({ port });
  if (existing && existing.provider === provider) {
    if (srv && !existing.serverId) existing.serverId = srv.id;
    if (opts?.instanceId && !existing.instanceId) existing.instanceId = opts.instanceId;
    return tunnelSnapshot(existing);
  }
  const cfg = await boreConfig();
  const prefs = srv ? serverPrefs(srv.id) : null;
  // Pedir el mismo puerto público que la vez anterior para que la dirección no cambie
  const asked = Number(opts?.remotePort);
  const remotePort = asked > 0 && asked < 65536 ? asked : prefs && prefs.lastHost === cfg.host && prefs.lastRemotePort ? prefs.lastRemotePort : 0;
  const client = new BoreClient({ host: cfg.host, secret: cfg.secret, localPort: port, remotePort });
  const tun = { id: `tun_${uid(8)}`, provider, client, serverId: srv?.id || null, instanceId: opts?.instanceId || null, localPort: port, createdAt: Date.now(), verified: null, warning: null };
  tunnels.set(tun.id, tun);
  const remember = () => {
    if (!tun.serverId || !client.remotePort) return;
    data.servers[tun.serverId] = { ...serverPrefs(tun.serverId), lastRemotePort: client.remotePort, lastHost: cfg.host };
    saveData();
  };
  client.on('state', () => {
    if (tunnels.has(tun.id)) emitTunnel(tun);
  });
  client.on('warning', (w) => {
    if (w.code === 'localUnreachable' && Date.now() < (tun.selfTestUntil || 0)) return;
    tun.warning = { ...w, at: Date.now() };
    if (tunnels.has(tun.id)) emitTunnel(tun);
  });
  client.on('address', () => {
    tun.verified = null;
    remember();
    if (tunnels.has(tun.id)) emitTunnel(tun);
    setTimeout(() => verifyTunnel(tun), 800);
  });
  try {
    await client.start();
  } catch (err) {
    tunnels.delete(tun.id);
    client.stop();
    throw new Error(boreError(err, cfg.host));
  }
  if (!tunnels.has(tun.id)) {
    // Se detuvo mientras conectaba
    client.stop();
    throw new Error(t('netplay.errStopped'));
  }
  remember();
  emitTunnel(tun);
  setTimeout(() => verifyTunnel(tun), 600);
  return tunnelSnapshot(tun);
}

function stopTunnel(id) {
  const tun = tunnels.get(id);
  if (!tun) return false;
  tunnels.delete(id);
  tun.client.stop();
  send('netplay:tunnel', { ...tunnelSnapshot(tun), status: 'stopped' });
  for (const [instanceId, w] of worlds) {
    if (w.tunnelId === id) setWorld(instanceId, { tunnelId: null });
  }
  return true;
}

// ---------- Prueba de direcciones (Server List Ping) ----------

function testError(err) {
  const code = err?.code || '';
  if (code === 'ETIMEDOUT') return t('netplay.errTestTimeout');
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return t('netplay.errTestRefused');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return t('netplay.errTestDns');
  return t('netplay.errTest', { detail: err?.message || String(err) });
}

async function testAddress(address) {
  if (!slp.parseAddress(address)) throw new Error(t('netplay.errAddress'));
  const a = await slp.resolveTarget(address);
  try {
    const r = await slp.ping(a.host, a.port, { timeout: 8000 });
    return { ok: true, host: a.host, port: a.port, srv: a.srv, ...r };
  } catch (err) {
    return { ok: false, host: a.host, port: a.port, srv: a.srv, error: testError(err) };
  }
}

// ---------- Mundos en LAN: e4mc y tunel al puerto LAN ----------

function worldState(id) {
  return worlds.get(id) || { lanPort: null, domain: null, error: null, autoTunnel: false, tunnelId: null, tunnelError: null };
}

function worldSnapshot(id) {
  const w = worldState(id);
  const tun = w.tunnelId ? tunnels.get(w.tunnelId) : null;
  let running = false;
  let activity = null;
  try {
    running = Boolean(core.game.status()[id]);
    activity = core.game.activity(id);
  } catch {
    /* juego no disponible */
  }
  return { instanceId: id, running, activity, lanPort: w.lanPort, domain: w.domain, error: w.error, autoTunnel: w.autoTunnel, tunnel: tun ? tunnelSnapshot(tun) : null, tunnelError: w.tunnelError || null };
}

function setWorld(id, patch) {
  worlds.set(id, { ...worldState(id), ...patch, updatedAt: Date.now() });
  send('netplay:world', worldSnapshot(id));
}

async function startWorldTunnel(id) {
  const w = worldState(id);
  if (!w.lanPort || !w.autoTunnel) return;
  const cur = w.tunnelId ? tunnels.get(w.tunnelId) : null;
  if (cur && cur.localPort === w.lanPort) return;
  if (cur) stopTunnel(cur.id);
  try {
    const snap = await startTunnel({ port: w.lanPort, provider: 'bore', instanceId: id, remotePort: w.lastRemotePort || 0 });
    setWorld(id, { tunnelId: snap.id, tunnelError: null, lastRemotePort: snap.remotePort || null });
  } catch (err) {
    setWorld(id, { tunnelError: err.message });
  }
}

// El mundo dejo de estar abierto (volvio al menu o se cerro el juego)
function closeWorld(id, { keepAuto = true } = {}) {
  const w = worlds.get(id);
  if (!w) return;
  if (w.tunnelId) stopTunnel(w.tunnelId);
  const hadLan = Boolean(w.lanPort);
  const hadDomain = Boolean(w.domain);
  if (keepAuto && w.autoTunnel) setWorld(id, { lanPort: null, domain: null, error: null, tunnelId: null, tunnelError: null });
  else {
    worlds.delete(id);
    send('netplay:world', worldSnapshot(id));
  }
  if (hadDomain) send('netplay:e4mcDomain', id, null);
  if (hadLan) send('netplay:lan', id, null);
}

const LOG_HINT = /Domain assigned|e4mc|Started serving on|publicly hosted/i;

function onGameLog(id, lines) {
  for (const l of lines || []) {
    const text = typeof l === 'string' ? l : l?.text;
    if (!text || text.length > 4000 || !LOG_HINT.test(text)) continue;
    const r = e4mc.parseLine(text);
    if (!r) continue;
    const w = worldState(id);
    if (r.type === 'domain' && w.domain !== r.domain) {
      setWorld(id, { domain: r.domain, error: null });
      send('netplay:e4mcDomain', id, r.domain);
    } else if (r.type === 'lan' && w.lanPort !== r.port) {
      setWorld(id, { lanPort: r.port });
      send('netplay:lan', id, { port: r.port });
      if (w.autoTunnel) startWorldTunnel(id);
    } else if (r.type === 'error') {
      setWorld(id, { error: 'e4mc' });
    } else if (r.type === 'stopped' && w.domain) {
      setWorld(id, { domain: null });
      send('netplay:e4mcDomain', id, null);
    }
  }
}

function onGameState(id, st) {
  if (st?.state === 'stopped' || st?.state === 'crashed') closeWorld(id, { keepAuto: false });
  else if (st?.state === 'running' && worlds.has(id)) send('netplay:world', worldSnapshot(id));
}

function onGameActivity(id, act, meta) {
  if (act?.quiet || meta?.quiet) return; // pruebas del buscador de mods culpables
  if (!act || act.type === 'menu') closeWorld(id, { keepAuto: true });
}

async function cachedVersion(inst, { force = false } = {}) {
  const key = `${inst.loader}|${inst.mcVersion}`;
  const hit = versionCache.get(key);
  if (!force && hit && Date.now() - hit.at < 30 * 60000) return hit.value;
  const value = await e4mc.findVersion(core.modrinth, inst);
  versionCache.set(key, { at: Date.now(), value });
  return value;
}

async function getInstance(instanceId) {
  if (typeof instanceId !== 'string' || !instanceId) throw new Error(t('netplay.errInstance'));
  try {
    return await core.instances.get(instanceId);
  } catch {
    throw new Error(t('netplay.errInstance'));
  }
}

async function e4mcStatus(instanceId) {
  const inst = await getInstance(instanceId);
  const reason = e4mc.unsupportedReason(inst);
  const out = { ...worldSnapshot(instanceId), loader: inst.loader, mcVersion: inst.mcVersion, reason, supported: !reason, installed: false, disabled: false, file: null, versionNumber: null, available: null, lookupError: null };
  if (reason) {
    out.supported = false;
    return out;
  }
  const file = await e4mc.installedFile(inst);
  if (file) {
    out.installed = file.enabled;
    out.disabled = !file.enabled;
    out.file = file.file;
    out.versionNumber = file.versionNumber;
    // Instalado (o activado) despues de abrir el juego: hace falta reiniciar Minecraft
    let run = null;
    try {
      run = core.game.status()[instanceId] || null;
    } catch {
      run = null;
    }
    if (run?.startedAt && file.enabled) {
      const fst = await fsp.stat(path.join(inst.dir, 'mods', file.file)).catch(() => null);
      out.restartNeeded = Boolean(fst && Math.max(fst.mtimeMs, fst.ctimeMs) > run.startedAt);
    }
    return out;
  }
  try {
    out.available = await cachedVersion(inst);
    if (!out.available) {
      out.supported = false;
      out.reason = 'version';
    }
  } catch (err) {
    out.lookupError = err.message;
  }
  return out;
}

async function e4mcSetup(instanceId) {
  const inst = await getInstance(instanceId);
  const reason = e4mc.unsupportedReason(inst);
  if (reason === 'vanilla') throw new Error(t('netplay.errE4mcVanilla'));
  if (reason === 'optifine') throw new Error(t('netplay.errE4mcOptifine'));
  if (reason) throw new Error(t('netplay.errE4mcLoader'));
  let restartNeeded = false;
  try {
    restartNeeded = Boolean(core.game.status()[instanceId]);
  } catch {
    restartNeeded = false;
  }
  const file = await e4mc.installedFile(inst);
  if (file) {
    if (!file.enabled) await core.instances.toggleFile(instanceId, 'mods', file.file);
    return { installed: true, alreadyInstalled: true, enabledNow: !file.enabled, versionNumber: file.versionNumber, restartNeeded: restartNeeded && !file.enabled };
  }
  const v = await cachedVersion(inst, { force: true });
  if (!v) throw new Error(t('netplay.errE4mcNoVersion', { version: inst.mcVersion, loader: inst.loader }));
  const res = await core.tasks.run(t('netplay.taskE4mc', { name: inst.name }), (task) => core.instances.installProject(instanceId, e4mc.PROJECT_ID, v.id, { task }), { instanceId });
  return { installed: true, alreadyInstalled: false, versionNumber: v.versionNumber, titles: res?.installed || [], warnings: res?.warnings || [], restartNeeded };
}

async function worldTunnel(instanceId, enabled) {
  await getInstance(instanceId);
  if (enabled) {
    setWorld(instanceId, { autoTunnel: true, tunnelError: null });
    await startWorldTunnel(instanceId);
  } else {
    const w = worldState(instanceId);
    if (w.tunnelId) stopTunnel(w.tunnelId);
    setWorld(instanceId, { autoTunnel: false, tunnelId: null, tunnelError: null });
  }
  return worldSnapshot(instanceId);
}

// ---------- Limpieza ----------

// Mapeos que quedaron abiertos si el launcher se cerro de golpe
async function cleanupStaleMappings() {
  await loadData();
  const stale = (data.mappings || []).filter((m) => m && m.port && !mappings.has(`${m.protocol}:${m.port}`));
  if (!stale.length) return;
  const r = await getRouter().catch(() => null);
  if (r) {
    for (const m of stale) {
      if (m.internalClient && r.localAddress && m.internalClient !== r.localAddress) continue;
      await removeMapping({ ...m, externalPort: m.externalPort || m.port }).catch(() => {});
    }
  }
  persistMappings();
  saveData();
}

async function shutdown() {
  for (const tun of tunnels.values()) tun.client.stop();
  tunnels.clear();
  const list = [...mappings.values()];
  mappings.clear();
  await Promise.allSettled(list.map((m) => removeMapping(m)));
  data.mappings = [];
  await saveNow();
}

function register(ctx) {
  sendFn = ctx.send || (() => {});
  const { handle } = ctx;
  loadData();

  handle('netplay:addresses', (opts) => addresses(opts));
  handle('netplay:upnpStatus', (opts) => upnpStatus(opts || {}));
  handle('netplay:upnpOpen', async (port, opts) => openPort(checkExposable(port), { ...(opts || {}), auto: false }));
  handle('netplay:upnpClose', (port, protocol) => closePort(port, protocol));
  handle('netplay:serverPrefs', (serverId) => getServerPrefs(serverId));
  handle('netplay:setServerPrefs', (serverId, patch) => setServerPrefs(serverId, patch || {}));
  handle('netplay:tunnelStart', (opts) => startTunnel(opts || {}));
  handle('netplay:tunnelStop', (id) => stopTunnel(String(id || '')));
  handle('netplay:tunnels', () => [...tunnels.values()].map(tunnelSnapshot));
  handle('netplay:tunnelVerify', async (id) => {
    const tun = tunnels.get(String(id || ''));
    return tun ? verifyTunnel(tun, { force: true }) : null;
  });
  handle('netplay:test', (address) => testAddress(address));
  handle('netplay:boreConfig', () => getBoreConfig());
  handle('netplay:playitInfo', () => ({ downloadUrl: playit.DOWNLOAD_URL, dashboardUrl: playit.DASHBOARD_URL }));
  handle('netplay:e4mcStatus', (instanceId) => e4mcStatus(instanceId));
  handle('netplay:e4mcSetup', (instanceId) => e4mcSetup(instanceId));
  handle('netplay:worldStatus', (instanceId) => worldSnapshot(String(instanceId || '')));
  handle('netplay:worldTunnel', (instanceId, enabled) => worldTunnel(instanceId, Boolean(enabled)));

  try {
    core.servers.events.on('state', (id, st) => onServerState(id, st).catch((err) => console.warn('[netplay] servidor', err.message)));
  } catch (err) {
    console.warn('[netplay] sin servidores', err.message);
  }
  try {
    const { events } = core.game;
    events.on('log', onGameLog);
    events.on('state', onGameState);
    events.on('activity', onGameActivity);
  } catch (err) {
    console.warn('[netplay] sin eventos del juego', err.message);
  }
  if (typeof ctx.onQuit === 'function') ctx.onQuit(shutdown);
  const timer = setTimeout(() => cleanupStaleMappings().catch(() => {}), 12000);
  timer.unref?.();
}

module.exports = {
  register,
  // Para otros modulos del proceso principal
  addresses,
  openPort,
  closePort,
  startTunnel,
  stopTunnel,
  testAddress,
  e4mcStatus,
  worldSnapshot,
  shutdown,
};
