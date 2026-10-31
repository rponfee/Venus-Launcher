'use strict';
// Jugadores del servidor: listas de operadores, lista blanca y baneos (ops.json, whitelist.json,
// banned-players.json, banned-ips.json). Con el servidor encendido se usan comandos (el servidor
// reescribe esos archivos); apagado se editan los JSON con el UUID correcto (Mojang u offline).
const net = require('net');
const path = require('path');
const http = require('../../core/http');
const { t } = require('../../core/i18n');
const { readJson, writeJson, offlineUUID, dashUUID } = require('../../core/util');

const FILES = { ops: 'ops.json', whitelist: 'whitelist.json', banned: 'banned-players.json', bannedIps: 'banned-ips.json' };
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];
const lookups = new Map(); // nombre en minusculas -> { name, uuid, time }

async function readLists(sdir) {
  const out = {};
  for (const [k, f] of Object.entries(FILES)) {
    const data = await readJson(path.join(sdir, f), []);
    out[k] = Array.isArray(data) ? data : [];
  }
  return out;
}

// Busca el UUID de una cuenta premium en la API de Mojang (con cache en memoria).
async function mojangProfile(name) {
  const k = name.toLowerCase();
  const hit = lookups.get(k);
  if (hit && Date.now() - hit.time < 6 * 3600 * 1000) return hit;
  let res;
  try {
    ({ res } = await http.request(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, { headers: { Accept: 'application/json' } }, { retries: 1 }));
  } catch (err) {
    if (err.status === 404 || err.status === 400) throw new Error(t('servers.errPlayerNotFound', { name }));
    throw new Error(t('servers.errLookup', { error: err.message }));
  }
  if (res.status === 204) throw new Error(t('servers.errPlayerNotFound', { name }));
  const data = await res.json().catch(() => null);
  if (!data?.id) throw new Error(t('servers.errPlayerNotFound', { name }));
  const out = { name: data.name, uuid: dashUUID(data.id), time: Date.now() };
  lookups.set(k, out);
  return out;
}

// { name, uuid, source: 'mojang' | 'offline' }
async function lookup(name, onlineMode) {
  const clean = String(name || '').trim();
  if (!NAME_RE.test(clean)) throw new Error(t('servers.errPlayerName'));
  if (!onlineMode) return { name: clean, uuid: dashUUID(offlineUUID(clean)), source: 'offline' };
  const p = await mojangProfile(clean);
  return { name: p.name, uuid: p.uuid, source: 'mojang' };
}

function sameName(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function validIp(ip) {
  return net.isIP(String(ip || '').trim()) !== 0;
}

/**
 * Accion sobre un jugador. action: op | deop | whitelistAdd | whitelistRemove | ban | pardon | banIp | pardonIp | kick | gamemode
 * ctx: { dir, running, onlineMode, command(cmd), stamp() }. extra: { reason, level, mode }
 */
async function act(ctx, action, target, extra = {}) {
  const value = String(target || '').trim();
  const reason = String(extra.reason || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const ipAction = action === 'banIp' || action === 'pardonIp';
  if (ipAction ? !(validIp(value) || NAME_RE.test(value)) : !NAME_RE.test(value)) throw new Error(ipAction ? t('servers.errIp') : t('servers.errPlayerName'));

  if (ctx.running) {
    const cmds = {
      op: `op ${value}`,
      deop: `deop ${value}`,
      whitelistAdd: `whitelist add ${value}`,
      whitelistRemove: `whitelist remove ${value}`,
      ban: `ban ${value}${reason ? ` ${reason}` : ''}`,
      pardon: `pardon ${value}`,
      banIp: `ban-ip ${value}${reason ? ` ${reason}` : ''}`,
      pardonIp: `pardon-ip ${value}`,
      kick: `kick ${value}${reason ? ` ${reason}` : ''}`,
      gamemode: GAMEMODES.includes(extra.mode) ? `gamemode ${extra.mode} ${value}` : null,
    };
    const cmd = cmds[action];
    if (!cmd) throw new Error(t('servers.errAction'));
    ctx.command(cmd);
    return { live: true };
  }

  if (action === 'kick' || action === 'gamemode') throw new Error(t('servers.errOffline'));
  const lists = await readLists(ctx.dir);
  const save = (k) => writeJson(path.join(ctx.dir, FILES[k]), lists[k]);

  if (action === 'deop' || action === 'whitelistRemove' || action === 'pardon') {
    const k = action === 'deop' ? 'ops' : action === 'whitelistRemove' ? 'whitelist' : 'banned';
    lists[k] = lists[k].filter((e) => !sameName(e.name, value) && e.uuid !== value);
    await save(k);
    return { live: false };
  }
  if (action === 'pardonIp') {
    lists.bannedIps = lists.bannedIps.filter((e) => e.ip !== value);
    await save('bannedIps');
    return { live: false };
  }
  if (action === 'banIp') {
    if (!validIp(value)) throw new Error(t('servers.errIp'));
    lists.bannedIps = lists.bannedIps.filter((e) => e.ip !== value);
    lists.bannedIps.push({ ip: value, created: ctx.stamp(), source: 'Venus Launcher', expires: 'forever', reason: reason || 'Banned by an operator.' });
    await save('bannedIps');
    return { live: false };
  }
  const profile = await lookup(value, ctx.onlineMode);
  const entry = { uuid: profile.uuid, name: profile.name };
  if (action === 'op') {
    const level = Math.max(1, Math.min(4, Number(extra.level) || 4));
    lists.ops = lists.ops.filter((e) => e.uuid !== entry.uuid && !sameName(e.name, entry.name));
    lists.ops.push({ ...entry, level, bypassesPlayerLimit: Boolean(extra.bypass) });
    await save('ops');
  } else if (action === 'whitelistAdd') {
    lists.whitelist = lists.whitelist.filter((e) => e.uuid !== entry.uuid && !sameName(e.name, entry.name));
    lists.whitelist.push(entry);
    await save('whitelist');
  } else if (action === 'ban') {
    lists.banned = lists.banned.filter((e) => e.uuid !== entry.uuid && !sameName(e.name, entry.name));
    lists.banned.push({ ...entry, created: ctx.stamp(), source: 'Venus Launcher', expires: 'forever', reason: reason || 'Banned by an operator.' });
    await save('banned');
  } else throw new Error(t('servers.errAction'));
  return { live: false, profile };
}

module.exports = { readLists, lookup, act, FILES, GAMEMODES };
