'use strict';
// YouTube Data API v3: videos.insert reanudable y OAuth de aplicacion de escritorio (PKCE, secreto opcional). Sin
// Electron: el fetch y la lectura del archivo se pasan de afuera (se prueba con un fetch falso).
// developers.google.com/youtube/v3/guides/using_resumable_upload_protocol · identity/protocols/oauth2/native-app
const { authUrl } = require('./oauth');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const CHUNK = 8 * 1024 * 1024; // tiene que ser multiplo de 256 KB
const MAX_RETRIES = 8;
const PRIVACY = ['private', 'unlisted', 'public'];
const CATEGORY_GAMING = '20';

function coded(code, message, extra) {
  return Object.assign(new Error(message || code), { code }, extra || {});
}

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(coded('cancelled'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(coded('cancelled'));
      },
      { once: true },
    );
  });

// YouTube no acepta < ni > en el titulo ni en la descripcion. Titulo de hasta 100 caracteres, nunca vacio.
function cleanMeta({ title, description, privacy }) {
  const strip = (s) => String(s ?? '').replace(/[<>\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
  return {
    title: strip(title).slice(0, 100),
    description: strip(description).slice(0, 4500),
    privacy: PRIVACY.includes(privacy) ? privacy : 'private',
  };
}

// Ultimo byte recibido segun "Range: bytes=0-999" (-1 si no hay nada)
function rangeEnd(res) {
  const m = /bytes=\d+-(\d+)/.exec(res.headers.get('range') || '');
  return m ? Number(m[1]) : -1;
}

async function reasonOf(res) {
  const body = await res.json().catch(() => null);
  return body?.error?.errors?.[0]?.reason || body?.error?.status || null;
}

async function failure(res) {
  const reason = await reasonOf(res);
  if (res.status === 401) return coded('session', reason);
  if (res.status === 403) {
    if (['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'uploadLimitExceeded'].includes(reason)) return coded('quota', reason);
    if (reason === 'youtubeSignupRequired') return coded('noChannel', reason);
    return coded('forbidden', reason);
  }
  if (res.status === 400) return coded('badRequest', reason);
  return coded('server', `${res.status} ${reason || ''}`);
}

function createYoutube({ fetch: doFetch, clientId, clientSecret = '', sleep = wait }) {
  async function tokenRequest(params) {
    const body = new URLSearchParams({ client_id: clientId, ...params });
    if (clientSecret) body.set('client_secret', clientSecret);
    let res;
    try {
      res = await doFetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    } catch (err) {
      throw coded('network', err?.message);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) throw coded(data?.error === 'invalid_grant' ? 'session' : 'oauth', data?.error_description || data?.error || String(res.status));
    return data;
  }

  const toTokens = (d, prev = {}) => ({ access_token: d.access_token, refresh_token: d.refresh_token || prev.refresh_token || null, expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000, scope: d.scope || prev.scope || SCOPE });

  return {
    authorizeUrl: ({ redirectUri, challenge, state }) => authUrl(AUTH_URL, { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent' }),

    async exchange({ code, verifier, redirectUri }) {
      return toTokens(await tokenRequest({ code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri }));
    },

    async refresh(tokens) {
      if (!tokens?.refresh_token) throw coded('session');
      return toTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }), tokens);
    },

    // Revocar el de renovacion corta tambien el de acceso. Si Google ya no lo conoce, igual se da por revocado.
    async revoke(tokens) {
      const token = tokens?.refresh_token || tokens?.access_token;
      if (!token) return true;
      const res = await doFetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() });
      return res.ok || res.status === 400;
    },

    /**
     * Sube un archivo. o = { getToken() -> token vigente, renewToken() -> otro token (despues de un 401), meta, size,
     * mime, read(pos, len) -> Buffer, onProgress({ sent, total }), signal }. Devuelve { id, url }.
     */
    async upload(o) {
      const meta = cleanMeta(o.meta || {});
      if (!meta.title) throw coded('badRequest', 'title');
      const { size, mime = 'video/webm', read, onProgress, signal } = o;
      let token = await o.getToken();
      let renewed = false;

      const authed = async (url, init) => {
        let res = await doFetch(url, { ...init, signal, redirect: 'manual', headers: { ...init.headers, Authorization: `Bearer ${token}` } });
        if (res.status === 401 && !renewed && o.renewToken) {
          renewed = true;
          token = await o.renewToken();
          res = await doFetch(url, { ...init, signal, redirect: 'manual', headers: { ...init.headers, Authorization: `Bearer ${token}` } });
        }
        return res;
      };

      // Paso 1: abrir la sesion; la URL de subida llega en el encabezado Location
      async function openSession() {
        const res = await authed(UPLOAD_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': mime },
          body: JSON.stringify({ snippet: { title: meta.title, description: meta.description, categoryId: CATEGORY_GAMING }, status: { privacyStatus: meta.privacy } }),
        });
        if (!res.ok) throw await failure(res);
        const uri = res.headers.get('location');
        if (!uri) throw coded('server', 'no location');
        return uri;
      }

      const done = async (res) => {
        const video = await res.json().catch(() => null);
        if (!video?.id) throw coded('server', 'no id');
        return { id: video.id, url: `https://youtu.be/${video.id}`, studio: `https://studio.youtube.com/video/${video.id}/edit`, privacy: meta.privacy };
      };

      // Cuanto recibio el servidor: PUT vacio con "bytes */total". { pos } o { result } si ya termino.
      const askStatus = async (uri) => {
        const res = await authed(uri, { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` } });
        if (res.status === 200 || res.status === 201) return { result: await done(res) };
        if (res.status === 308) return { pos: rangeEnd(res) + 1 };
        if (res.status === 404) return { expired: true };
        if ([500, 502, 503, 504].includes(res.status)) return { retry: true, after: res.headers.get('retry-after') };
        throw await failure(res);
      };

      const pause = async (attempt, after) => {
        const seconds = Number(after);
        await sleep(seconds > 0 ? seconds * 1000 : Math.min(32000, 1000 * 2 ** attempt), signal);
      };

      let uri;
      try {
        uri = await openSession();
      } catch (err) {
        if (signal?.aborted) throw coded('cancelled');
        if (err?.code) throw err;
        throw coded('network', err?.message);
      }
      let pos = 0;
      let retries = 0;
      let reopened = false;
      onProgress?.({ sent: 0, total: size });
      for (;;) {
        if (signal?.aborted) throw coded('cancelled');
        if (pos >= size) {
          // Ya recibio todo: solo falta la respuesta final
          const st = await askStatus(uri);
          if (st.result) return st.result;
          throw coded('server', 'incomplete');
        }
        const len = Math.min(CHUNK, size - pos);
        const data = await read(pos, len);
        let res;
        try {
          res = await authed(uri, { method: 'PUT', headers: { 'Content-Type': mime, 'Content-Length': String(data.length), 'Content-Range': `bytes ${pos}-${pos + data.length - 1}/${size}` }, body: data });
        } catch (err) {
          if (signal?.aborted || err?.code === 'cancelled') throw coded('cancelled');
          res = null; // conexion perdida: se pregunta hasta donde llego y se sigue
        }
        if (res && (res.status === 200 || res.status === 201)) {
          onProgress?.({ sent: size, total: size });
          return done(res);
        }
        if (res && res.status === 308) {
          pos = rangeEnd(res) + 1;
          retries = 0;
          onProgress?.({ sent: pos, total: size });
          continue;
        }
        if (res && res.status === 404) {
          // La sesion vencio: se empieza de nuevo una sola vez
          if (reopened) throw coded('server', 'session expired');
          reopened = true;
          uri = await openSession();
          pos = 0;
          continue;
        }
        if (res && ![500, 502, 503, 504].includes(res.status)) throw await failure(res);
        // Se reintenta con espera creciente, preguntando primero hasta donde llego
        for (;;) {
          if (++retries > MAX_RETRIES) throw coded(res ? 'server' : 'network', 'retries');
          await pause(retries - 1, res?.headers.get('retry-after'));
          let st;
          try {
            st = await askStatus(uri);
          } catch (err) {
            if (signal?.aborted) throw coded('cancelled');
            if (err?.code && err.code !== 'network') throw err;
            continue;
          }
          if (st.result) {
            onProgress?.({ sent: size, total: size });
            return st.result;
          }
          if (st.expired) {
            if (reopened) throw coded('server', 'session expired');
            reopened = true;
            uri = await openSession();
            pos = 0;
            break;
          }
          if (st.retry) continue;
          pos = st.pos;
          onProgress?.({ sent: pos, total: size });
          break;
        }
      }
    },
  };
}

module.exports = { createYoutube, cleanMeta, rangeEnd, CHUNK, SCOPE, UPLOAD_URL, TOKEN_URL, REVOKE_URL, AUTH_URL, PRIVACY };
