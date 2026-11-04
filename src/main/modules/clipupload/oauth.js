'use strict';
// OAuth de aplicacion de escritorio: PKCE y servidor de retorno en loopback (127.0.0.1, puerto al azar). Sin Electron:
// se prueba con node:test. El navegador lo abre clipupload.js.
const crypto = require('crypto');
const http = require('http');

const CONNECT_TIMEOUT_MS = 5 * 60000;

const base64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// 64 caracteres del conjunto sin reservar (el estandar pide de 43 a 128)
const randomVerifier = () => base64url(crypto.randomBytes(48));
const randomState = () => base64url(crypto.randomBytes(24));

// El de siempre (RFC 7636, Google): base64url del SHA-256
const challengeS256 = (verifier) => base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
// TikTok para escritorio pide el SHA-256 en hexadecimal (developers.tiktok.com/doc/login-kit-desktop)
const challengeHex = (verifier) => crypto.createHash('sha256').update(verifier, 'ascii').digest('hex');

function authUrl(endpoint, params) {
  const u = new URL(endpoint);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.href;
}

/**
 * Levanta el servidor de retorno y espera la vuelta del navegador. Devuelve { redirectUri, port, result, close }:
 * result se resuelve con el code (o rechaza con err.code = 'denied', 'timeout' o 'cancelled').
 * Solo se acepta una vuelta con el state correcto; lo demas se contesta 400 y se sigue esperando.
 */
function startLoopback({ path = '/', state, page, timeoutMs = CONNECT_TIMEOUT_MS }) {
  return new Promise((resolveStart, rejectStart) => {
    let settle = null;
    let server = null;
    let timer = null;
    const result = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    result.catch(() => {});
    const close = () => {
      clearTimeout(timer);
      server?.close();
      server?.closeAllConnections?.();
      server = null;
    };
    const finish = (err, code) => {
      close();
      if (err) settle.reject(err);
      else settle.resolve(code);
    };
    server = http.createServer((req, res) => {
      const reply = (status, html) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", Connection: 'close' });
        res.end(html);
      };
      let url;
      try {
        url = new URL(req.url, 'http://127.0.0.1');
      } catch {
        return reply(400, '');
      }
      if (req.method !== 'GET' || url.pathname !== path) return reply(404, '');
      // Un pedido que no trae nuestro state no vino de esta autorizacion
      if (url.searchParams.get('state') !== state) return reply(400, '');
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code) {
        reply(200, page?.(false) || '');
        return finish(Object.assign(new Error(error || 'denied'), { code: 'denied' }));
      }
      reply(200, page?.(true) || '');
      return finish(null, code);
    });
    server.on('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      timer = setTimeout(() => finish(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs);
      timer.unref?.();
      resolveStart({
        port,
        redirectUri: `http://127.0.0.1:${port}${path}`,
        result,
        close: () => finish(Object.assign(new Error('cancelled'), { code: 'cancelled' })),
      });
    });
  });
}

module.exports = { CONNECT_TIMEOUT_MS, base64url, randomVerifier, randomState, challengeS256, challengeHex, authUrl, startLoopback };
