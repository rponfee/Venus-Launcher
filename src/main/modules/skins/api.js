'use strict';
// Cliente de Minecraft Services para la skin y la capa de la cuenta (API oficial de Mojang) y descarga de
// texturas desde textures.minecraft.net. Sin Electron y con fetch inyectable (test/api.test.js).
// El token llega en cada llamada y solo viaja en el encabezado Authorization: nunca se guarda ni se registra.
const PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const SKINS_URL = `${PROFILE_URL}/skins`;
const ACTIVE_SKIN_URL = `${PROFILE_URL}/skins/active`;
const ACTIVE_CAPE_URL = `${PROFILE_URL}/capes/active`;
const TEXTURE_HOST = 'textures.minecraft.net';
const VARIANTS = new Set(['classic', 'slim']);
const CAPE_ID = /^[A-Za-z0-9-]{1,64}$/;

const clip = (v, max) => Array.from(String(v ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim()).slice(0, max).join('');

// Solo texturas de textures.minecraft.net (http se pasa a https). null para cualquier otra URL.
function textureUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 300) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.hostname !== TEXTURE_HOST || u.port || u.username || u.password || u.search || u.hash) return null;
  if (!/^\/texture\/[0-9a-f]{16,128}$/i.test(u.pathname)) return null;
  return `https://${TEXTURE_HOST}${u.pathname}`;
}

function cleanId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}

function parseState(v) {
  return String(v || '').toUpperCase() === 'ACTIVE' ? 'active' : 'inactive';
}

// Perfil que devuelve Minecraft Services, saneado: { id, name, skins: [...], capes: [...] } o null.
function parseProfile(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const id = typeof json.id === 'string' ? json.id.replace(/-/g, '').toLowerCase() : '';
  const name = clip(json.name, 32);
  if (!/^[0-9a-f]{32}$/.test(id) || !name) return null;
  const skins = (Array.isArray(json.skins) ? json.skins : [])
    .slice(0, 20)
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const sid = cleanId(s.id);
      if (!sid) return null;
      const variant = String(s.variant || '').toLowerCase();
      return { id: sid, state: parseState(s.state), variant: VARIANTS.has(variant) ? variant : 'classic', textureUrl: textureUrl(s.url), alias: clip(s.alias, 32) || null };
    })
    .filter(Boolean);
  const capes = (Array.isArray(json.capes) ? json.capes : [])
    .slice(0, 100)
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const cid = typeof c.id === 'string' && CAPE_ID.test(c.id) ? c.id : null;
      if (!cid) return null;
      return { id: cid, state: parseState(c.state), alias: clip(c.alias, 48) || null, textureUrl: textureUrl(c.url) };
    })
    .filter(Boolean);
  return { id, name, skins, capes };
}

function createMinecraftApi({ fetch: fetcher = (...a) => fetch(...a), fail, timeoutMs = 20000, textureTimeoutMs = 15000, maxTextureBytes = 256 * 1024, maxJsonBytes = 512 * 1024 } = {}) {
  if (typeof fail !== 'function') throw new Error('skins api: falta fail');

  // Lee el cuerpo con un tope (no baja algo enorme a la memoria).
  async function readLimited(res, max) {
    const declared = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > max) throw fail('tooLarge');
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const parts = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => {});
          throw fail('tooLarge');
        }
        parts.push(Buffer.from(value));
      }
      return Buffer.concat(parts);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw fail('tooLarge');
    return buf;
  }

  async function send(url, init, timeout) {
    try {
      return await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw fail('timeout');
      throw fail('network');
    }
  }

  // Codigo de error para cada respuesta HTTP que no sea 2xx. context: 'profile', 'upload', 'reset' o 'cape'.
  function statusError(status, context) {
    if (status === 401) return fail('sessionExpired');
    if (status === 403) return fail('forbidden');
    if (status === 429) return fail('rateLimited');
    if (status >= 500) return fail('serviceUnavailable');
    if (status === 404 && context === 'profile') return fail('noProfile');
    if (context === 'upload' && (status === 400 || status === 413 || status === 415)) return fail('skinRejected');
    if (context === 'cape' && (status === 400 || status === 404)) return fail('capeRejected');
    return fail('rejected', { status });
  }

  // Llamada autenticada que devuelve el perfil (los cambios tambien lo devuelven). Sin cuerpo valido: null.
  async function call(token, url, init, context) {
    if (typeof token !== 'string' || !token || token === '0') throw fail('sessionExpired');
    const res = await send(url, { ...init, headers: { Accept: 'application/json', ...(init.headers || {}), Authorization: `Bearer ${token}` } }, timeoutMs);
    if (!res.ok) {
      await res.body?.cancel?.().catch?.(() => {});
      throw statusError(res.status, context);
    }
    let json = null;
    try {
      const raw = await readLimited(res, maxJsonBytes);
      json = raw.length ? JSON.parse(raw.toString('utf8')) : null;
    } catch (err) {
      if (err?.code === 'skins:tooLarge') throw err;
      json = null;
    }
    const profile = parseProfile(json);
    if (context === 'profile' && !profile) throw fail('serviceUnavailable');
    return profile;
  }

  return {
    getProfile: (token) => call(token, PROFILE_URL, { method: 'GET' }, 'profile'),

    // Sube el PNG como multipart/form-data: variant ('classic' o 'slim') y file (image/png).
    uploadSkin(token, { bytes, variant, fileName = 'skin.png' }) {
      if (!VARIANTS.has(variant)) throw fail('badVariant');
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw fail('invalidPng');
      const form = new FormData();
      form.set('variant', variant);
      form.set('file', new Blob([bytes], { type: 'image/png' }), String(fileName).replace(/[^\w.-]/g, '_').slice(0, 60) || 'skin.png');
      return call(token, SKINS_URL, { method: 'POST', body: form }, 'upload');
    },

    // Vuelve a una de las skins por defecto de Minecraft.
    resetSkin: (token) => call(token, ACTIVE_SKIN_URL, { method: 'DELETE' }, 'reset'),

    showCape(token, capeId) {
      if (typeof capeId !== 'string' || !CAPE_ID.test(capeId)) throw fail('capeRejected');
      return call(token, ACTIVE_CAPE_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capeId }) }, 'cape');
    },

    hideCape: (token) => call(token, ACTIVE_CAPE_URL, { method: 'DELETE' }, 'cape'),

    // PNG de una textura (sin token: son publicas). Solo desde textures.minecraft.net.
    async fetchTexture(url) {
      const safe = textureUrl(url);
      if (!safe) throw fail('badTextureUrl');
      const res = await send(safe, { method: 'GET', headers: { Accept: 'image/png' } }, textureTimeoutMs);
      if (!res.ok) {
        await res.body?.cancel?.().catch?.(() => {});
        throw fail(res.status === 404 ? 'textureMissing' : res.status === 429 ? 'rateLimited' : 'textureUnavailable');
      }
      return readLimited(res, maxTextureBytes);
    },
  };
}

module.exports = { createMinecraftApi, parseProfile, textureUrl, PROFILE_URL, SKINS_URL, ACTIVE_SKIN_URL, ACTIVE_CAPE_URL, TEXTURE_HOST };
