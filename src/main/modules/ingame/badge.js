'use strict';
// Insignia de Venus en el servidor (migracion 0019_insignia.sql, Edge Function "badge", guia docs/insignia.md).
// Anotar una cuenta de Minecraft:
//   1. badge_challenge (con la sesion de Venus) devuelve un desafio de un solo uso.
//   2. El launcher "entra" al servidor de sesiones de Mojang con ese desafio, con el token de Minecraft de la cuenta
//      (lo mismo que hace el juego al entrar a un servidor premium). El token va solo a Mojang.
//   3. La Edge Function "badge" le pregunta a Mojang si esa cuenta entro con ese desafio y, si si, la anota.
// Asi nadie puede anotar la cuenta de Minecraft de otro. Borrarse (badge_remove) y ver las propias (badge_mine)
// solo piden la sesion de Venus. Sin Electron: ingame.js le pasa fetch, el proyecto y el token de la sesion.

const MOJANG_JOIN = 'https://sessionserver.mojang.com/session/minecraft/join';
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const TIMEOUT = 15000;

function coded(code, detail) {
  return Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
}

// Con guiones y en minusculas (como los guarda la base), o null.
function normalizeUuid(raw) {
  if (typeof raw !== 'string' || !UUID.test(raw)) return null;
  const h = raw.replace(/-/g, '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * deps: { fetch, cloudConfig: () => { url, anonKey, configured }, accessToken: () => Promise<token de Venus> }
 * Errores con .code: noCloud, noSession, network, unavailable (falta 0019 o la funcion), multiplayerDisabled,
 * mojang, notVerified, tooManyAccounts, banned, rateLimited, server.
 */
function createBadgeClient({ fetch, cloudConfig, accessToken }) {
  async function request(url, init) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    } catch (err) {
      throw coded('network', err?.message);
    }
  }

  async function supa() {
    const cfg = await cloudConfig();
    if (!cfg?.configured) throw coded('noCloud');
    const token = await accessToken();
    if (!token) throw coded('noSession');
    return { cfg, headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey, Authorization: `Bearer ${token}` } };
  }

  async function rpc(name, body = {}) {
    const { cfg, headers } = await supa();
    const res = await request(`${cfg.url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (res.ok) return data;
    const msg = String(data?.message || '');
    if (res.status === 401 || /not_authenticated|JWT/i.test(msg)) throw coded('noSession');
    if (res.status === 404 || ['PGRST202', '42883', '42P01'].includes(data?.code)) throw coded('unavailable', name);
    if (/user_banned/.test(msg)) throw coded('banned');
    if (data?.code === '54000' || /too_many_requests/.test(msg)) throw coded('rateLimited');
    throw coded('server', `${name} ${res.status} ${data?.code || ''}`);
  }

  async function mojangJoin(account, serverId) {
    const res = await request(MOJANG_JOIN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: account.accessToken, selectedProfile: account.uuid.replace(/-/g, ''), serverId }),
    });
    if (res.status === 204 || res.ok) return;
    const data = await res.json().catch(() => null);
    // Cuentas sin multijugador (menores o con la privacidad de Xbox que lo bloquea): Mojang no deja "entrar".
    if (res.status === 403 && /InsufficientPrivileges|multiplayer/i.test(`${data?.error || ''} ${data?.errorMessage || ''}`)) {
      throw coded('multiplayerDisabled');
    }
    if (res.status === 401 || res.status === 403) throw coded('mojangSession');
    throw coded('mojang', String(res.status));
  }

  // account: la de getLaunchAccount ({ type: 'msa', uuid, name, accessToken }). Devuelve el UUID anotado.
  // fn: la Edge Function que recibe la verificación: 'badge' (anota la insignia) o 'mcverify' (solo verifica la cuenta,
  // para las invitaciones de Venus Points; ver modules/rewards.js). Con mcverify devuelve { uuid, rewarded }.
  async function enroll(account, { fn = 'badge' } = {}) {
    if (fn !== 'badge' && fn !== 'mcverify') throw coded('server', `fn ${fn}`);
    const uuid = normalizeUuid(account?.uuid);
    if (account?.type !== 'msa' || !uuid || !account.accessToken) throw coded('offlineAccount');
    const serverId = await rpc('badge_challenge');
    if (typeof serverId !== 'string' || !/^[0-9a-f]{40}$/.test(serverId)) throw coded('server', 'challenge');
    await mojangJoin(account, serverId);
    const { cfg, headers } = await supa();
    const res = await request(`${cfg.url}/functions/v1/${fn}`, { method: 'POST', headers, body: JSON.stringify({ uuid, name: account.name, serverId }) });
    const data = await res.json().catch(() => null);
    if (res.ok && normalizeUuid(data?.uuid) === uuid) return fn === 'badge' ? uuid : { uuid, rewarded: data?.rewarded === true };
    const code = data?.error?.code;
    if (res.status === 404) throw coded('unavailable', fn);
    if (res.status === 401 || code === 'unauthorized') throw coded('noSession');
    if (code === 'not_verified') throw coded('notVerified');
    if (code === 'too_many_accounts') throw coded('tooManyAccounts');
    if (code === 'user_banned') throw coded('banned');
    if (code === 'mojang_unavailable') throw coded('mojang', 'hasJoined');
    throw coded('server', `badge ${res.status} ${code || ''}`);
  }

  async function mine() {
    const rows = await rpc('badge_mine');
    return Array.isArray(rows) ? rows.map(normalizeUuid).filter(Boolean) : [];
  }

  // Sin uuid borra todas las cuentas de quien llama. Devuelve cuantas borro.
  async function remove(uuid = null) {
    const n = await rpc('badge_remove', { p_uuid: uuid ? normalizeUuid(uuid) : null });
    return Number(n) || 0;
  }

  // Anota la cuenta si todavia no estaba (una consulta barata en cada partida; Mojang solo la primera vez).
  async function ensure(account) {
    const uuid = normalizeUuid(account?.uuid);
    if (account?.type !== 'msa' || !uuid) throw coded('offlineAccount');
    if ((await mine()).includes(uuid)) return { uuid, enrolled: false };
    return { uuid: await enroll(account), enrolled: true };
  }

  return { enroll, ensure, mine, remove };
}

module.exports = { createBadgeClient, normalizeUuid, MOJANG_JOIN };
