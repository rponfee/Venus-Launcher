'use strict';
// Datos públicos de la aplicación de Discord del usuario (nombre, ícono y la imagen "venus"),
// para validar el Application ID y mostrar la vista previa. Endpoints públicos sin autenticación;
// se guardan 10 minutos en memoria para no pedir lo mismo seguido.
const { validClientId, ASSET_KEY } = require('./activity');

const API = 'https://discord.com/api/v10';
const CDN = 'https://cdn.discordapp.com';
const TTL = 10 * 60 * 1000;
const cache = new Map(); // clientId -> { at, value }

async function getJson(url, userAgent) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent || 'VenusLauncher', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body };
}

/**
 * { valid: true, id, name, iconUrl, assetCount, hasAsset, assetUrl }
 * { valid: false, reason: 'format' | 'unknown' }   -> el ID no existe
 * { valid: null, reason: 'network' | 'rateLimited' | 'http' } -> no se pudo comprobar ahora
 */
async function fetchAppInfo(clientId, { userAgent, force = false } = {}) {
  const id = String(clientId || '').trim();
  if (!validClientId(id)) return { valid: false, reason: 'format' };
  const hit = cache.get(id);
  if (hit && !force && Date.now() - hit.at < TTL) return hit.value;
  let r;
  try {
    r = await getJson(`${API}/applications/${id}/rpc`, userAgent);
  } catch {
    return { valid: null, reason: 'network' };
  }
  if (r.status === 429) return { valid: null, reason: 'rateLimited' };
  if (r.status === 404 || r.status === 400) {
    const value = { valid: false, reason: 'unknown' };
    cache.set(id, { at: Date.now(), value });
    return value;
  }
  if (!r.ok || !r.body?.id) return { valid: null, reason: 'http', status: r.status };
  const app = r.body;
  let assets = [];
  try {
    const a = await getJson(`${API}/oauth2/applications/${id}/assets`, userAgent);
    if (a.ok && Array.isArray(a.body)) assets = a.body;
  } catch {
    assets = [];
  }
  const venus = assets.find((x) => String(x?.name || '').toLowerCase() === ASSET_KEY);
  const value = {
    valid: true,
    id: app.id,
    name: typeof app.name === 'string' ? app.name.slice(0, 100) : '',
    iconUrl: app.icon ? `${CDN}/app-icons/${app.id}/${app.icon}.png?size=128` : null,
    assetCount: assets.length,
    hasAsset: Boolean(venus),
    assetUrl: venus ? `${CDN}/app-assets/${app.id}/${venus.id}.png?size=256` : null,
  };
  cache.set(id, { at: Date.now(), value });
  return value;
}

function cached(clientId) {
  const hit = cache.get(String(clientId || '').trim());
  return hit && Date.now() - hit.at < TTL ? hit.value : null;
}

module.exports = { fetchAppInfo, cached };
