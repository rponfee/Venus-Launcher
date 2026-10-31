'use strict';
// Multijugador: ping de servidores (Server List Ping), destacados, servidores guardados de cada
// instancia (servers.dat), eleccion de la instancia ideal para entrar y armado de instancias a partir
// de los mods que publica un servidor.
//
// Uso desde otros modulos del proceso principal:
//   const serverlist = require('./serverlist');
//   const info = await serverlist.ping('mc.hypixel.net');          // { online, latency, players, motd, ... }
//   const inst = await serverlist.pickInstance('play.server.net');  // instancia ideal o null
const path = require('path');
const { t } = require('../core/i18n');
const settings = require('../core/settings');
const instances = require('../core/instances');
const tasks = require('../core/tasks');
const slp = require('./serverlist/slp');
const versions = require('./serverlist/versions');
const serversdat = require('./serverlist/serversdat');
const featuredMod = require('./serverlist/featured');
const builder = require('./serverlist/builder');
const state = require('./serverlist/state');
const { parseAddress } = require('./serverlist/address');

let safePathFn = (p) => p;

function checkAddress(address) {
  if (typeof address !== 'string' || address.length > 300) throw new Error(t('serverlist.errInvalidAddress'));
  const addr = parseAddress(address);
  if (!addr) throw new Error(t('serverlist.errInvalidAddress'));
  return addr;
}

function checkInstanceId(id) {
  if (typeof id !== 'string' || !/^[\w.-]{1,120}$/.test(id) || id === '.' || id === '..') throw new Error(t('serverlist.errNoInstance'));
  return id;
}

async function getInstance(id) {
  checkInstanceId(id);
  try {
    return await instances.get(id);
  } catch {
    throw new Error(t('serverlist.errNoInstance'));
  }
}

function datFile(instanceId) {
  return safePathFn(path.join(instances.dir(checkInstanceId(instanceId)), 'servers.dat'));
}

// ---------- Ping ----------

async function ping(address, opts = {}) {
  const addr = checkAddress(address);
  // La tabla de protocolos se completa (una vez, en segundo plano) recién cuando el usuario consulta un servidor.
  versions.refresh().catch(() => {});
  const result = await slp.ping(addr.display, { force: Boolean(opts.force) });
  if (opts.remember) state.remember(addr.display, { kind: 'lookup' }).catch(() => {});
  if (!result.online) return { ...result, errorText: t(`serverlist.err_${result.error}`) };
  return result;
}

// ---------- Servidores guardados ----------

async function saved(instanceId) {
  const all = await instances.list();
  const targets = instanceId ? all.filter((i) => i.id === instanceId) : all;
  if (instanceId && !targets.length) throw new Error(t('serverlist.errNoInstance'));
  const merged = new Map();
  for (const inst of targets) {
    let entries = [];
    try {
      entries = await serversdat.list(datFile(inst.id));
    } catch (err) {
      console.warn(`[serverlist] servers.dat de ${inst.id}:`, err.message);
      continue;
    }
    const ref = { id: inst.id, name: inst.name, mcVersion: inst.mcVersion, loader: inst.loader, preset: inst.preset || null };
    for (const e of entries) {
      const cur = merged.get(e.key);
      if (cur) {
        if (!cur.instances.some((r) => r.id === inst.id)) cur.instances.push(ref);
        if (!cur.icon && e.icon) cur.icon = e.icon;
      } else {
        merged.set(e.key, { key: e.key, name: e.name || e.ip, ip: e.ip, icon: e.icon, acceptTextures: e.acceptTextures, instances: [ref] });
      }
    }
  }
  return [...merged.values()];
}

const idList = (v) => [...new Set((Array.isArray(v) ? v : [v]).filter(Boolean))];

// Errores de lectura/escritura de servers.dat con un mensaje entendible
async function datOp(inst, fn) {
  try {
    return await fn(datFile(inst.id));
  } catch (err) {
    console.warn(`[serverlist] servers.dat de ${inst.id}:`, err.message);
    throw new Error(t('serverlist.errServersDat', { name: inst.name }));
  }
}

async function addSaved(instanceId, entry = {}) {
  const addr = checkAddress(String(entry.ip || ''));
  const ids = idList(instanceId);
  if (!ids.length) throw new Error(t('serverlist.errNoInstance'));
  const out = {};
  for (const id of ids) {
    const inst = await getInstance(id);
    out[id] = await datOp(inst, (file) => serversdat.add(file, { name: String(entry.name || '').trim() || addr.display, ip: addr.display }));
  }
  return out;
}

async function updateSaved(instanceId, oldIp, entry = {}) {
  if (typeof oldIp !== 'string' || !oldIp.trim()) throw new Error(t('serverlist.errInvalidAddress'));
  const addr = entry.ip !== undefined ? checkAddress(String(entry.ip)) : null;
  const out = {};
  for (const id of idList(instanceId)) {
    const inst = await getInstance(id);
    out[id] = await datOp(inst, (file) => serversdat.update(file, oldIp, { name: entry.name, ip: addr ? addr.display : undefined }));
  }
  return out;
}

async function removeSaved(instanceId, ip) {
  if (typeof ip !== 'string' || !ip.trim()) throw new Error(t('serverlist.errInvalidAddress'));
  let removed = 0;
  for (const id of idList(instanceId)) {
    const inst = await getInstance(id);
    removed += await datOp(inst, (file) => serversdat.remove(file, ip));
  }
  return removed;
}

// ---------- Instancia ideal para un servidor ----------

const MODDED = new Set(['forge', 'neoforge']);

function loaderMatches(instLoader, serverLoader, mcVersion) {
  if (instLoader === serverLoader) return true;
  // NeoForge 1.20.1 es un fork de Forge 47 y acepta los mismos mods
  return mcVersion === '1.20.1' && MODDED.has(instLoader) && MODDED.has(serverLoader);
}

/**
 * Elige la instancia mas adecuada para entrar a un servidor.
 * Por defecto devuelve { id, name, mcVersion, loader } o null. Con { details: true } devuelve
 * { address, server, best, preferred, ambiguous, candidates: [{ id, name, mcVersion, loader, compatible, score, reason }] }.
 */
async function pickInstance(address, { details = false } = {}) {
  const addr = checkAddress(address);
  versions.refresh().catch(() => 0);
  const [info, list, preferred] = await Promise.all([slp.ping(addr.display), instances.list(), state.preferred(addr.display)]);
  const modded = info.online && info.modded && MODDED.has(info.loader);
  const serverProto = info.online && !info.versionPlaceholder ? info.protocol : null;
  const range = info.online ? info.versionRange : null;
  const sameAsServer = (inst, proto) => inst.mcVersion === info.mcVersion || Boolean(proto && serverProto && proto === serverProto);

  // Proxies multi-version: lo que entra en el rango que anuncian se da por bueno; el resto se prueba
  // de a una conexion (de la version mas jugada a la menos) y se corta si el servidor empieza a rechazar.
  const probeResults = new Map();
  if (info.online && !modded) {
    const pending = [];
    for (const inst of list) {
      const p = versions.protocolOf(inst.mcVersion);
      if (!p || sameAsServer(inst, p) || (range && versions.inRange(inst.mcVersion, range)) || pending.includes(p)) continue;
      pending.push(p);
    }
    for (const [i, p] of pending.slice(0, 4).entries()) {
      if (i) await new Promise((r) => setTimeout(r, 250));
      const ok = await slp.probe(addr.display, p);
      probeResults.set(p, ok);
      if (ok === null) break;
    }
  }

  const now = Date.now();
  const candidates = list.map((inst) => {
    const proto = versions.protocolOf(inst.mcVersion);
    let compatible = null;
    let reason = 'unknown';
    if (info.online) {
      const sameVersion = sameAsServer(inst, proto);
      if (modded) {
        if (!sameVersion) [compatible, reason] = [false, 'version'];
        else if (!loaderMatches(inst.loader, info.loader, inst.mcVersion)) [compatible, reason] = [false, 'loader'];
        else [compatible, reason] = [true, 'modded'];
      } else if (sameVersion) [compatible, reason] = [true, 'version'];
      else if (range && proto && versions.inRange(inst.mcVersion, range)) [compatible, reason] = [true, 'range'];
      else if (proto && probeResults.get(proto) === true) [compatible, reason] = [true, 'range'];
      else if (proto && probeResults.get(proto) === false) [compatible, reason] = [false, 'version'];
      else if (!proto && !range && serverProto && inst.mcVersion && info.mcVersion) [compatible, reason] = [false, 'version'];
      else [compatible, reason] = [null, 'unknown'];
    }
    let score = compatible === true ? 100 : compatible === false ? -100 : 0;
    const isPreferred = inst.id === preferred;
    const built = inst.serverlist?.key === addr.key;
    if (isPreferred) score += 60;
    if (built) score += 40;
    if (info.online && inst.mcVersion === info.mcVersion) score += 15;
    if (modded && compatible) score += 20;
    if (!modded && MODDED.has(inst.loader)) score -= 5;
    if (inst.lastPlayed) score += Math.max(0, 10 - (now - inst.lastPlayed) / (7 * 86400000));
    return {
      id: inst.id,
      name: inst.name,
      mcVersion: inst.mcVersion,
      loader: inst.loader,
      preset: inst.preset || null,
      icon: inst.icon || null,
      installed: Boolean(inst.installed),
      lastPlayed: inst.lastPlayed || 0,
      compatible,
      reason,
      preferred: isPreferred,
      built,
      score: Math.round(score * 10) / 10,
    };
  });
  candidates.sort((a, b) => b.score - a.score);
  const usable = candidates.filter((c) => c.compatible !== false);
  const best = info.online ? candidates.find((c) => c.compatible === true) || null : usable[0] || null;
  if (!details) return best ? { id: best.id, name: best.name, mcVersion: best.mcVersion, loader: best.loader } : null;
  const compatibleCount = candidates.filter((c) => c.compatible === true).length;
  return {
    address: addr.display,
    server: {
      online: info.online,
      error: info.error || null,
      errorText: info.online ? null : t(`serverlist.err_${info.error}`),
      mcVersion: info.mcVersion || null,
      version: info.version || null,
      versionRange: info.versionRange || null,
      protocol: info.protocol ?? null,
      loader: info.loader || null,
      modded: Boolean(modded),
      mods: info.mods?.length || 0,
      motd: info.motd || '',
      favicon: info.favicon || null,
    },
    best: best ? best.id : null,
    preferred: preferred && candidates.some((c) => c.id === preferred) ? preferred : null,
    ambiguous: Boolean(best) && compatibleCount > 1 && !best.preferred && !best.built,
    candidates,
  };
}

// ---------- Entrar ----------

/**
 * Prepara (y opcionalmente lanza) la entrada a un servidor.
 * opts: { instanceId?, remember?: bool (recordar la instancia para este servidor), launch?: bool }
 * -> { instanceId, address, quickPlay: { server, port } }
 */
async function join(address, opts = {}, ctx = {}) {
  const addr = checkAddress(address);
  let instanceId = opts.instanceId || null;
  if (instanceId) await getInstance(instanceId);
  else instanceId = (await pickInstance(addr.display))?.id || null;
  if (opts.remember && instanceId) await state.setPreferred(addr.display, instanceId);
  await state.remember(addr.display, { kind: 'join', name: opts.name });
  const quickPlay = { server: addr.ipVersion === 6 ? `[${addr.host}]` : addr.host, port: addr.port };
  if (opts.launch && instanceId) {
    // Igual que instances:launch (para quien llame desde el proceso principal, p. ej. invitaciones)
    const accounts = require('../core/accounts');
    const game = require('../core/game');
    const account = await accounts.getLaunchAccount();
    const s = await settings.get();
    await settings.set({ selectedInstance: instanceId });
    await game.start(instanceId, { account, settings: s, quickPlay, launcherVersion: ctx.app?.getVersion?.() });
  }
  return { instanceId, address: addr.display, quickPlay };
}

// ---------- Armar instancia desde un servidor ----------

function buildInstance(address, opts = {}, ctx = {}) {
  const addr = checkAddress(address);
  const send = ctx.send || (() => {});
  const startPrepare = (inst) => {
    tasks
      .run(t('serverlist.taskPrepare', { name: inst.name }), (task) => instances.prepare(inst.id, task), { instanceId: inst.id })
      .then(() => send('instances:changed'))
      .catch(() => send('instances:changed'));
  };
  const token = typeof opts.token === 'string' ? opts.token.slice(0, 64) : null;
  return tasks.run(t('serverlist.taskBuild', { server: addr.display }), (task) => builder.build(addr.display, opts, { task, send, startPrepare }), { serverlistBuild: token });
}

// ---------- Registro ----------

function register(ctx) {
  const { handle } = ctx;
  if (typeof ctx.safePath === 'function') safePathFn = ctx.safePath;
  handle('serverlist:ping', (address, opts) => ping(address, opts || {}));
  handle('serverlist:featured', (opts) => featuredMod.featured(opts || {}));
  handle('serverlist:saved', (instanceId) => saved(instanceId || null));
  handle('serverlist:addSaved', (instanceId, entry) => addSaved(instanceId, entry || {}));
  handle('serverlist:updateSaved', (instanceId, oldIp, entry) => updateSaved(instanceId, oldIp, entry || {}));
  handle('serverlist:removeSaved', (instanceId, ip) => removeSaved(instanceId, ip));
  handle('serverlist:pickInstance', (address, opts) => pickInstance(address, opts || {}));
  handle('serverlist:join', (address, opts) => join(address, opts || {}, ctx));
  handle('serverlist:buildInstance', (address, opts) => buildInstance(address, opts || {}, ctx));
  handle('serverlist:versionOptions', async (address) => {
    const addr = checkAddress(address);
    return builder.versionOptions(addr.display, await slp.ping(addr.display));
  });
  handle('serverlist:history', () => state.history());
  handle('serverlist:clearHistory', () => state.clearHistory());
  handle('serverlist:setPreferred', (address, instanceId) => {
    checkAddress(address);
    if (instanceId) checkInstanceId(instanceId);
    return state.setPreferred(address, instanceId || null);
  });
}

module.exports = {
  register,
  ping,
  pickInstance,
  join,
  saved,
  addSaved,
  updateSaved,
  removeSaved,
  featured: (opts) => featuredMod.featured(opts || {}),
  parseAddress,
};
