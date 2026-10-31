'use strict';
// Cuentas: Microsoft (Xbox Live -> Minecraft Services) y modo sin conexión.
// Los tokens se guardan cifrados con el almacén seguro del sistema (safeStorage).
// Todos los errores que ve el usuario salen traducidos del namespace "accounts" (src/main/i18n/<idioma>/accounts.js).
const crypto = require('crypto');
const paths = require('./paths');
const { t } = require('./i18n');
const { readJson, writeJson, offlineUUID } = require('./util');

const CLIENT_ID = '00000000402b5328';
const REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const AUTH_URL =
  `https://login.live.com/oauth20_authorize.srf?client_id=${CLIENT_ID}&response_type=code` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent(SCOPE)}&prompt=select_account`;

const MS_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_API = 'https://api.minecraftservices.com';

const OFFLINE_NAME = /^[A-Za-z0-9_]{3,16}$/;
const REFRESH_MARGIN = 10 * 60 * 1000; // se renueva si al token de Minecraft le quedan menos de 10 minutos
const MIN_USABLE = 60 * 1000; // con menos de 1 minuto de vida no se usa el token viejo
const TIMEOUT = 25000;
// Licencias que habilitan Minecraft: Java Edition (las de Bedrock o Dungeons no sirven).
const JAVA_ENTITLEMENTS = new Set(['product_minecraft', 'game_minecraft']);
// Errores de Xbox Live (XErr) con mensaje propio en el diccionario (accounts.xerr_<código>).
const XERR_CODES = new Set([2148916227, 2148916229, 2148916233, 2148916234, 2148916235, 2148916236, 2148916237, 2148916238]);

let cipher = { encrypt: (s) => s, decrypt: (s) => s };
let openLogin = null;

function configure({ encrypt, decrypt, openLoginWindow } = {}) {
  if (encrypt && decrypt) cipher = { encrypt, decrypt };
  if (openLoginWindow) openLogin = openLoginWindow;
}

// Error con mensaje traducido + código interno (para pruebas y para decidir reintentos).
function fail(key, vars) {
  const err = new Error(t(`accounts.${key}`, vars));
  err.code = key;
  return err;
}

function networkError(service, cause) {
  const err = fail('network', { service });
  err.cause = cause;
  return err;
}

// ---------- Archivo de cuentas ----------

const FILE = () => paths.data('accounts.json');

async function load() {
  const data = (await readJson(FILE(), null)) || {};
  return {
    selected: data.selected || null,
    clientId: data.clientId || crypto.randomUUID(),
    accounts: Array.isArray(data.accounts) ? data.accounts.filter((a) => a && a.id) : [],
  };
}

async function persist(data) {
  await writeJson(FILE(), data);
}

// Las escrituras se encolan: dos operaciones a la vez (renovar un token mientras se agrega otra
// cuenta) no se pisan. Las llamadas de red se hacen afuera de la cola.
let writeQueue = Promise.resolve();
function mutate(fn) {
  const run = writeQueue.then(async () => {
    const data = await load();
    const result = await fn(data);
    await persist(data);
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

function publicAccount(a) {
  return { id: a.id, type: a.type, name: a.name, uuid: a.uuid, addedAt: a.addedAt, needsLogin: a.type === 'msa' && Boolean(a.needsLogin) };
}

async function list() {
  const data = await load();
  const selected = data.accounts.some((a) => a.id === data.selected) ? data.selected : data.accounts[0]?.id || null;
  return { selected, accounts: data.accounts.map(publicAccount) };
}

async function select(id) {
  await mutate((data) => {
    if (!data.accounts.some((a) => a.id === id)) throw fail('notFound');
    data.selected = id;
  });
  return list();
}

async function remove(id) {
  await mutate((data) => {
    data.accounts = data.accounts.filter((a) => a.id !== id);
    if (data.selected === id || !data.accounts.some((a) => a.id === data.selected)) data.selected = data.accounts[0]?.id || null;
  });
  refreshing.delete(id);
  return list();
}

// Agrega (o reemplaza en su lugar) una cuenta y la deja seleccionada.
function upsert(data, account) {
  const i = data.accounts.findIndex((a) => a.id === account.id);
  if (i >= 0) data.accounts[i] = { ...account, addedAt: data.accounts[i].addedAt || account.addedAt };
  else data.accounts.push(account);
  data.selected = account.id;
}

// Como el launcher oficial: jugar sin conexión requiere una cuenta de Microsoft con Minecraft en el launcher (al
// agregarla se comprueba la compra o Game Pass con verifyOwnership). Sin ella no se agregan ni se usan cuentas sin conexión.
const hasLicensedAccount = (data) => data.accounts.some((a) => a.type === 'msa');

async function addOffline(name) {
  const clean = String(name || '').trim();
  if (!OFFLINE_NAME.test(clean)) throw fail('invalidName');
  if (!hasLicensedAccount(await load())) throw fail('offlineNeedsMicrosoft');
  const uuid = offlineUUID(clean);
  await mutate((data) => upsert(data, { id: `offline-${uuid}`, type: 'offline', name: clean, uuid, addedAt: Date.now() }));
  return list();
}

// ---------- Microsoft ----------

async function request(url, init, service) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (err) {
    throw networkError(service, err);
  }
}

async function readBody(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

async function postJson(url, body, service) {
  const res = await request(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) },
    service,
  );
  return { res, json: await readBody(res) };
}

// Traduce la respuesta de error del endpoint de tokens de Microsoft.
function msTokenError(json, status, grantType) {
  const code = json?.error || '';
  if (grantType === 'refresh_token' && ['invalid_grant', 'interaction_required', 'consent_required', 'invalid_client'].includes(code)) {
    return fail('sessionExpired', { name: 'Microsoft' });
  }
  if (code === 'access_denied') return Object.assign(fail('cancelled'), { cancelled: true });
  if (code === 'invalid_grant') return fail('codeExpired');
  if (code === 'temporarily_unavailable' || status >= 500) return fail('msUnavailable');
  return fail('msRejected', { detail: code || `HTTP ${status}` });
}

async function msToken(params) {
  const res = await request(
    MS_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPE, ...params }),
    },
    'Microsoft',
  );
  const json = await readBody(res);
  if (!res.ok || json.error || !json.access_token) throw msTokenError(json, res.status, params.grant_type);
  return json;
}

// Mensaje claro para los errores XErr de Xbox Live (cuenta de menor, país, sin perfil de Xbox...).
function xboxError(xerr, status) {
  const code = Number(xerr);
  if (XERR_CODES.has(code)) {
    const err = fail(`xerr_${code}`);
    err.xerr = code;
    return err;
  }
  return fail('xstsFailed', { code: xerr || `HTTP ${status}` });
}

// Lee los datos del JWT de Minecraft (xuid y vencimiento) sin validar la firma.
function jwtClaims(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function getEntitlements(token, kind) {
  const url = kind === 'license' ? `${MC_API}/entitlements/license?requestId=${crypto.randomUUID()}` : `${MC_API}/entitlements/mcstore`;
  let res;
  try {
    res = await request(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, 'Minecraft');
  } catch {
    return null; // sin datos: no se puede decidir
  }
  if (!res.ok) return null;
  const json = await readBody(res);
  return Array.isArray(json.items) ? json.items : null;
}

function ownsJava(items) {
  return items.some((i) => JAVA_ENTITLEMENTS.has(i?.name));
}

async function getProfile(token) {
  const res = await request(`${MC_API}/minecraft/profile`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, 'Minecraft');
  if (res.status === 404) return null;
  if (res.status === 429) throw fail('mcRateLimited');
  if (!res.ok) throw fail('profileFailed', { status: res.status });
  const profile = await readBody(res);
  if (!profile?.id || !profile?.name) return null;
  return profile;
}

// Chequeo de compra + perfil de Java. Devuelve el perfil o lanza un error que explica qué falta.
async function verifyOwnership(token) {
  const [store, profile] = await Promise.all([getEntitlements(token, 'mcstore'), getProfile(token)]);
  let owned = store ? ownsJava(store) : null;
  if (profile) {
    // Xbox Game Pass no siempre figura en las licencias, pero el perfil existe: se permite jugar.
    return { profile, entitled: owned };
  }
  if (owned !== true) {
    const license = await getEntitlements(token, 'license');
    if (license && ownsJava(license)) owned = true;
    else if (license && owned === null) owned = false;
  }
  if (owned === false) throw fail('noGame');
  if (owned === true) throw fail('noProfile');
  throw fail('noProfileOrGame');
}

// Microsoft -> Xbox Live -> XSTS -> Minecraft. Devuelve token, vencimiento, perfil y xuid.
async function minecraftFromMs(accessToken) {
  let xbl = null;
  let lastStatus = 0;
  for (const ticket of [accessToken, `d=${accessToken}`]) {
    const { res, json } = await postJson(
      XBL_URL,
      {
        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: ticket },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
      },
      'Xbox Live',
    );
    if (res.ok && json.Token) {
      xbl = json;
      break;
    }
    if (json?.XErr) throw xboxError(json.XErr, res.status);
    lastStatus = res.status;
  }
  if (!xbl) throw fail('xblFailed', { status: lastStatus });

  const { res: xr, json: xsts } = await postJson(
    XSTS_URL,
    { Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' },
    'Xbox Live',
  );
  if (!xr.ok || !xsts.Token) throw xboxError(xsts?.XErr, xr.status);
  const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs || xbl.DisplayClaims?.xui?.[0]?.uhs;

  const { res: mr, json: mc } = await postJson(`${MC_API}/authentication/login_with_xbox`, { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` }, 'Minecraft');
  if (mr.status === 429) throw fail('mcRateLimited');
  if (!mr.ok || !mc.access_token) throw fail('mcLoginFailed', { status: mr.status });

  const { profile, entitled } = await verifyOwnership(mc.access_token);
  const claims = jwtClaims(mc.access_token);
  const expiresAt = claims?.exp ? claims.exp * 1000 : Date.now() + (mc.expires_in || 86400) * 1000;
  return { token: mc.access_token, expiresAt, profile, entitled, xuid: claims?.xuid ? String(claims.xuid) : null };
}

function msaRecord(ms, mc, prev) {
  return {
    id: `msa-${mc.profile.id}`,
    type: 'msa',
    name: mc.profile.name,
    uuid: mc.profile.id,
    addedAt: prev?.addedAt || Date.now(),
    refresh: cipher.encrypt(ms.refresh_token || (prev?.refresh ? cipher.decrypt(prev.refresh) : '')),
    token: cipher.encrypt(mc.token),
    expiresAt: mc.expiresAt,
    xuid: mc.xuid || prev?.xuid || null,
    entitled: mc.entitled,
    needsLogin: false,
  };
}

async function loginMicrosoft() {
  if (!openLogin) throw fail('unavailable');
  let finalUrl;
  try {
    finalUrl = await openLogin(AUTH_URL, REDIRECT);
  } catch (err) {
    // La ventana se cerró antes de terminar (main.js rechaza con code 'cancelled'). El error que llega al
    // handler de IPC conserva code 'cancelled' (la interfaz lo reconoce en cualquier idioma, sin mirar el
    // texto) y el mensaje traducido.
    throw Object.assign(fail('cancelled'), { cancelled: true, cause: err });
  }
  let u;
  try {
    u = new URL(finalUrl);
  } catch {
    throw fail('msRejected', { detail: 'redirect' });
  }
  const code = u.searchParams.get('code');
  if (!code) {
    const error = u.searchParams.get('error');
    if (!error || error === 'access_denied') throw Object.assign(fail('cancelled'), { cancelled: true });
    throw fail('msRejected', { detail: error });
  }
  const ms = await msToken({ grant_type: 'authorization_code', code });
  const mc = await minecraftFromMs(ms.access_token);
  await mutate((data) => upsert(data, msaRecord(ms, mc, data.accounts.find((a) => a.id === `msa-${mc.profile.id}`))));
  refreshing.delete(`msa-${mc.profile.id}`);
  return list();
}

// ---------- Renovación de tokens ----------

const refreshing = new Map(); // id -> Promise (una sola renovación a la vez por cuenta)

function refreshAccount(id) {
  if (refreshing.has(id)) return refreshing.get(id);
  const run = (async () => {
    const data = await load();
    const acc = data.accounts.find((a) => a.id === id);
    if (!acc) throw fail('notFound');
    let refreshToken = '';
    try {
      refreshToken = acc.refresh ? cipher.decrypt(acc.refresh) : '';
    } catch {
      refreshToken = '';
    }
    try {
      if (!refreshToken) throw fail('sessionExpired', { name: acc.name });
      const ms = await msToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
      const mc = await minecraftFromMs(ms.access_token);
      if (mc.profile.id.replace(/-/g, '') !== String(acc.uuid).replace(/-/g, '')) throw fail('sessionExpired', { name: acc.name });
      return await mutate((d) => {
        const cur = d.accounts.find((a) => a.id === id);
        if (!cur) throw fail('notFound');
        Object.assign(cur, msaRecord({ refresh_token: ms.refresh_token || refreshToken }, mc, cur));
        return { ...cur };
      });
    } catch (err) {
      if (err.code === 'sessionExpired') {
        // Microsoft ya no acepta el token de renovación: hay que volver a iniciar sesión con esa cuenta.
        await mutate((d) => {
          const cur = d.accounts.find((a) => a.id === id);
          if (cur) cur.needsLogin = true;
        }).catch(() => {});
        throw fail('sessionExpired', { name: acc.name });
      }
      throw err;
    }
  })();
  refreshing.set(id, run);
  run.then(
    () => refreshing.delete(id),
    () => refreshing.delete(id),
  );
  return run;
}

function decryptToken(acc) {
  try {
    return acc?.token ? cipher.decrypt(acc.token) : '';
  } catch {
    return '';
  }
}

// Cuenta lista para lanzar el juego. Renueva el token de Microsoft antes de que venza.
// id es opcional: por defecto usa la cuenta seleccionada.
async function getLaunchAccount(id) {
  const data = await load();
  const acc = (id && data.accounts.find((a) => a.id === id)) || data.accounts.find((a) => a.id === data.selected) || data.accounts[0];
  if (!acc) throw fail('noAccount');
  if (acc.type !== 'msa') {
    if (!hasLicensedAccount(data)) throw fail('offlineNeedsMicrosoft');
    return { type: 'offline', name: acc.name, uuid: acc.uuid, accessToken: '0', clientId: data.clientId, xuid: '0' };
  }

  let current = acc;
  const left = (acc.expiresAt || 0) - Date.now();
  const usable = Boolean(decryptToken(acc)) && left > MIN_USABLE;
  if (left < REFRESH_MARGIN || !decryptToken(acc)) {
    if (acc.needsLogin) {
      if (!usable) throw fail('sessionExpired', { name: acc.name });
    } else {
      try {
        current = await refreshAccount(acc.id);
      } catch (err) {
        if (!usable) {
          if (err.code === 'network') throw fail('refreshFailed', { name: acc.name, detail: err.message });
          throw err;
        }
        // Falla momentánea (red, Xbox caído): el token actual todavía sirve un rato.
        console.warn('[accounts] No se pudo renovar el token, se usa el actual:', err.message);
      }
    }
  }
  const accessToken = decryptToken(current);
  if (!accessToken) throw fail('sessionExpired', { name: acc.name });
  const xuid = current.xuid || jwtClaims(accessToken)?.xuid;
  return { type: 'msa', name: current.name, uuid: current.uuid, accessToken, clientId: data.clientId, xuid: xuid ? String(xuid) : '0' };
}

module.exports = {
  configure,
  list,
  select,
  remove,
  addOffline,
  loginMicrosoft,
  getLaunchAccount,
  refreshAccount,
  REDIRECT,
  // Para pruebas
  _internal: { msTokenError, xboxError, jwtClaims, ownsJava, verifyOwnership, minecraftFromMs },
};
