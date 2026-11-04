'use strict';
// TikTok Content Posting API: sube el video a la bandeja de la cuenta (scope video.upload, FILE_UPLOAD). El dueño de la
// cuenta lo termina de publicar desde la app. Publicar directo pide otra auditoria de TikTok, asi que no se usa.
// Sin Electron: el fetch y la lectura del archivo se pasan de afuera (se prueba con un fetch falso).
// TikTok manda hacer el intercambio de tokens desde un servidor con el client_secret (nunca en el cliente), asi que esas
// tres llamadas pasan por la Edge Function tiktok-token (deps.broker). El client_key si va en el launcher.
//   developers.tiktok.com/doc/content-posting-api-reference-upload-video · doc/content-posting-api-media-transfer-guide
//   doc/login-kit-desktop · doc/oauth-user-access-token-management
const { authUrl } = require('./oauth');

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const SCOPE = 'video.upload';
const MIB = 1024 * 1024;
const MIN_CHUNK = 5 * MIB;
const MAX_CHUNK = 64 * MIB;
const PREFERRED_CHUNK = 10 * MIB;
const MAX_CHUNKS = 1000;
const MAX_RETRIES = 4;
const STATUS_TRIES = 8;
const STATUS_WAIT_MS = 4000;
const LOOPBACK_PATH = '/callback/';

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

/**
 * Como partir el archivo segun las reglas de TikTok: hasta 5 MB entero; pedazos de 5 a 64 MB; la cantidad es el tamanio
 * dividido el pedazo, redondeado para abajo, y el ultimo se lleva lo que sobra (hasta 128 MB). De 1 a 1000 pedazos.
 * Devuelve { chunkSize, count, ranges: [{ start, end }] } (end incluido).
 */
function planChunks(size) {
  const total = Math.max(0, Math.floor(Number(size) || 0));
  if (!total) throw coded('badRequest', 'empty');
  if (total < PREFERRED_CHUNK) return { chunkSize: total, count: 1, ranges: [{ start: 0, end: total - 1 }] };
  let chunkSize = PREFERRED_CHUNK;
  if (Math.floor(total / chunkSize) > MAX_CHUNKS) chunkSize = Math.ceil(total / MAX_CHUNKS);
  if (chunkSize > MAX_CHUNK) throw coded('tooBig', 'tiktok');
  const count = Math.floor(total / chunkSize);
  const ranges = [];
  for (let i = 0; i < count; i++) ranges.push({ start: i * chunkSize, end: i === count - 1 ? total - 1 : (i + 1) * chunkSize - 1 });
  return { chunkSize, count, ranges };
}

function apiError(res, body) {
  const code = body?.error?.code;
  if (res.status === 401 || code === 'access_token_invalid') return coded('session', code);
  if (code === 'spam_risk_too_many_pending_share' || code === 'spam_risk_user_banned_from_posting' || code === 'rate_limit_exceeded' || res.status === 429) return coded('quota', code);
  if (code === 'scope_not_authorized' || code === 'scope_permission_missed') return coded('forbidden', code);
  return coded('server', `${res.status} ${code || ''}`);
}

function createTiktok({ fetch: doFetch, clientKey, broker, sleep = wait }) {
  const toTokens = (d, prev = {}) => ({
    access_token: d.access_token,
    refresh_token: d.refresh_token || prev.refresh_token || null,
    open_id: d.open_id || prev.open_id || null,
    expires_at: Date.now() + (Number(d.expires_in) || 7200) * 1000,
    refresh_expires_at: d.refresh_expires_in ? Date.now() + Number(d.refresh_expires_in) * 1000 : prev.refresh_expires_at || null,
    scope: d.scope || prev.scope || SCOPE,
  });

  return {
    loopbackPath: LOOPBACK_PATH,

    // challenge: el SHA-256 en hexadecimal, como pide TikTok para escritorio (oauth.challengeHex)
    authorizeUrl: ({ redirectUri, challenge, state }) => authUrl(AUTH_URL, { client_key: clientKey, scope: SCOPE, redirect_uri: redirectUri, state, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' }),

    async exchange({ code, verifier, redirectUri }) {
      return toTokens(await broker('exchange', { code, codeVerifier: verifier, redirectUri }));
    },

    // Cada renovacion trae otro token de renovacion y el anterior deja de servir: hay que guardarlo siempre
    async refresh(tokens) {
      if (!tokens?.refresh_token) throw coded('session');
      return toTokens(await broker('refresh', { refreshToken: tokens.refresh_token }), tokens);
    },

    async revoke(tokens) {
      if (!tokens?.access_token) return true;
      await broker('revoke', { token: tokens.access_token });
      return true;
    },

    /**
     * Sube un archivo. o = { getToken(), renewToken(), size, mime, read(pos, len) -> Buffer, onProgress, signal }.
     * Devuelve { publishId, status }: status 'inbox' (ya esta en la bandeja), 'processing' o lanza si fallo.
     */
    async upload(o) {
      const { size, mime = 'video/webm', read, onProgress, signal } = o;
      const plan = planChunks(size);
      let token = await o.getToken();
      const post = async (url, body) => {
        for (let renewed = false; ; renewed = true) {
          let res;
          try {
            res = await doFetch(url, { method: 'POST', signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body) });
          } catch (err) {
            if (signal?.aborted) throw coded('cancelled');
            throw coded('network', err?.message);
          }
          const data = await res.json().catch(() => null);
          if (res.ok && data?.error?.code === 'ok') return data.data || {};
          const err = apiError(res, data);
          if (err.code === 'session' && !renewed && o.renewToken) {
            token = await o.renewToken();
            continue;
          }
          throw err;
        }
      };

      const init = await post(INIT_URL, { source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.count } });
      if (!init.upload_url || !init.publish_id) throw coded('server', 'no upload_url');
      onProgress?.({ sent: 0, total: size });

      for (const { start, end } of plan.ranges) {
        const data = await read(start, end - start + 1);
        for (let attempt = 0; ; attempt++) {
          if (signal?.aborted) throw coded('cancelled');
          let res = null;
          try {
            res = await doFetch(init.upload_url, { method: 'PUT', signal, headers: { 'Content-Type': mime, 'Content-Length': String(data.length), 'Content-Range': `bytes ${start}-${end}/${size}` }, body: data });
          } catch (err) {
            if (signal?.aborted) throw coded('cancelled');
            res = null;
          }
          if (res && (res.status === 201 || res.status === 206 || res.status === 200)) break;
          if (res && res.status < 500 && res.status !== 429) throw coded('server', `${res.status}`);
          if (attempt >= MAX_RETRIES) throw coded(res ? 'server' : 'network', 'retries');
          await sleep(1000 * 2 ** attempt, signal);
        }
        onProgress?.({ sent: end + 1, total: size });
      }

      // TikTok lo procesa y lo deja en la bandeja de la cuenta
      for (let i = 0; i < STATUS_TRIES; i++) {
        const st = await post(STATUS_URL, { publish_id: init.publish_id }).catch((err) => {
          if (err?.code === 'cancelled') throw err;
          return null;
        });
        if (st?.status === 'FAILED') throw coded('rejected', st.fail_reason || 'failed');
        if (st?.status === 'SEND_TO_USER_INBOX' || st?.status === 'PUBLISH_COMPLETE') return { publishId: init.publish_id, status: 'inbox' };
        await sleep(STATUS_WAIT_MS, signal);
      }
      return { publishId: init.publish_id, status: 'processing' };
    },
  };
}

module.exports = { createTiktok, planChunks, SCOPE, INIT_URL, STATUS_URL, AUTH_URL, MIN_CHUNK, MAX_CHUNK, LOOPBACK_PATH };
