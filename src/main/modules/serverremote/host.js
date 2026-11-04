'use strict';
// Servidor HTTP del control remoto, uno por servidor local encendido. Sin Electron: lo que hace falta del launcher
// llega como backend (se prueba con Node puro y pedidos de verdad, ver test/host.test.js).
//   const host = createRemoteHost({ ip, backend, strings });
//   await host.start(); host.info(); host.pushLine(entrada); host.kick(ip); host.rotate(); host.stop('motivo');
// backend: snapshot() -> { name, typeName, version, state, busy, startedAt, players: [{ name, since }] },
//          action({ action, command?, device }) -> Promise (lanza un error con .code para contestar 409)
const http = require('http');
const fs = require('fs');
const path = require('path');
const sec = require('./security');

const TTL_MS = 12 * 3600 * 1000; // vencimiento automático
const MAX_BODY = 2048;
const MAX_URL = 64;
const MAX_LINES = 200;
const MAX_CLIENTS = 16;
const CLIENT_FORGET_MS = 10 * 60000;
const CONNECTED_MS = 30000;
const TOKEN_HEADER = 'x-venus-token';
const AFTER_HEADER = 'x-venus-after';

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Todas las respuestas salen con esto. Sin Access-Control-*: el navegador no deja leer nada desde otro origen.
const SAFE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': CSP,
  'Cross-Origin-Resource-Policy': 'same-origin',
  Connection: 'close',
});

// Lista cerrada: nada del pedido llega a una ruta de archivo.
const PAGE_FILES = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
});

let pageCache = null;
function loadPage() {
  if (!pageCache) {
    pageCache = {};
    for (const [route, [file, type]] of Object.entries(PAGE_FILES)) pageCache[route] = { body: fs.readFileSync(path.join(__dirname, 'page', file)), type };
  }
  return pageCache;
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) {
      reject(new sec.RemoteError('too_large', 413));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new sec.RemoteError('too_large', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createRemoteHost({ ip, port = 0, backend, strings = () => ({}), ttlMs = TTL_MS, now = Date.now, onEvent = () => {}, limits = {}, peerAllowed = sec.peerAllowed }) {
  let server = null;
  let realPort = 0;
  let token = sec.newToken();
  let expiresAt = 0;
  let expireTimer = null;
  let stopped = false;
  let rejected = 0;
  let seq = 0;
  const lines = [];
  const clients = new Map(); // ip -> { ip, device, firstSeen, lastSeen }
  const cut = new Set(); // ip que se cortaron desde el launcher, hasta apagar
  const sockets = new Set();
  const perIp = new sec.Limiter({ now, ...limits.perIp });
  const everyone = new sec.Limiter({ max: 40, windowMs: 5 * 60000, blockMs: 5 * 60000, now, ...limits.global });
  const page = loadPage();

  const send = (res, status, body, type, extra) => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
    res.writeHead(status, { ...SAFE_HEADERS, 'Content-Type': type || 'text/plain; charset=utf-8', 'Content-Length': data.length, ...extra });
    res.end(data);
  };
  const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);

  const countRejected = () => {
    rejected++;
    onEvent('rejected', { rejected });
  };

  // Token malo: cuenta para esa IP y para el total. Los dispositivos que ya entraron no sufren el bloqueo general.
  function checkToken(req, res, remote) {
    if (cut.has(remote)) {
      json(res, 403, { error: 'cut' });
      return false;
    }
    const wait = perIp.retryAfter(remote) || (clients.has(remote) ? 0 : everyone.retryAfter('*'));
    if (wait) {
      countRejected();
      json(res, 429, { error: 'too_many', retryAfter: wait }, { 'Retry-After': String(wait) });
      return false;
    }
    if (!sec.sameToken(sec.normalizeCode(req.headers[TOKEN_HEADER]) || '', token)) {
      perIp.fail(remote);
      everyone.fail('*');
      countRejected();
      json(res, 401, { error: 'bad_token' });
      return false;
    }
    return true;
  }

  function touch(req, remote) {
    const t = now();
    let c = clients.get(remote);
    if (!c) {
      if (clients.size >= MAX_CLIENTS) {
        const oldest = [...clients.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
        if (oldest) clients.delete(oldest.ip);
      }
      c = { ip: remote, device: sec.deviceInfo(req.headers['user-agent']), firstSeen: t, lastSeen: t };
      clients.set(remote, c);
      onEvent('connected', { device: c.device });
    }
    c.lastSeen = t;
    return c;
  }

  async function apiState(req, res) {
    const after = /^\d{1,12}$/.test(String(req.headers[AFTER_HEADER] ?? '')) ? Number(req.headers[AFTER_HEADER]) : 0;
    const snap = await backend.snapshot();
    json(res, 200, {
      server: { name: snap.name, type: snap.typeName, version: snap.version, state: snap.state, busy: Boolean(snap.busy), startedAt: snap.startedAt || null },
      players: (snap.players || []).map((p) => ({ name: p.name, since: p.since || null })),
      lines: lines.filter((l) => l.seq > after),
      seq,
      expiresAt,
      now: now(),
    });
  }

  async function apiAction(req, res, client) {
    if (!/^application\/json(;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new sec.RemoteError('bad_type', 415);
    const parsed = sec.parseAction(await readBody(req, MAX_BODY));
    await backend.action({ ...parsed, device: client.device });
    json(res, 200, { ok: true });
  }

  const routes = Object.freeze({
    '/api/state': { method: 'GET', run: (req, res) => apiState(req, res) },
    '/api/action': { method: 'POST', run: apiAction },
  });

  async function onRequest(req, res) {
    const remote = sec.cleanIp(req.socket.remoteAddress);
    // Host, Origin, de dónde viene y la forma del pedido se miran antes que nada, también para los archivos de la página.
    if (!peerAllowed(remote) || !sec.singleHost(req.rawHeaders) || !sec.hostAllowed(req.headers.host, ip, realPort) || !sec.originAllowed(req.headers.origin, ip, realPort)) {
      countRejected();
      return send(res, 403, 'forbidden');
    }
    const url = String(req.url ?? '');
    // El token nunca va en la URL: un pedido con query string ni se mira.
    if (url.length > MAX_URL || url.includes('?') || url.includes('#') || url.includes('%')) return send(res, 400, 'bad request');
    if (now() >= expiresAt) {
      res.once('finish', () => stop('expired'));
      send(res, 410, 'expired');
      return undefined;
    }
    if (Object.prototype.hasOwnProperty.call(routes, url)) {
      const route = routes[url];
      if (req.method !== route.method) return send(res, 405, 'method not allowed', null, { Allow: route.method });
      if (!sec.fetchSiteAllowed(req.headers['sec-fetch-site'])) return send(res, 403, 'forbidden');
      if (!checkToken(req, res, remote)) return undefined;
      const client = touch(req, remote);
      try {
        await route.run(req, res, client);
      } catch (err) {
        const status = err instanceof sec.RemoteError ? err.status : err?.code ? 409 : 500;
        if (status === 500) console.warn('[serverremote] pedido:', err?.message || err);
        json(res, status, { error: err?.code && status !== 500 ? String(err.code) : 'failed' });
        if (status === 413) res.on('finish', () => req.socket.destroy());
      }
      return undefined;
    }
    if (req.method !== 'GET') return send(res, 405, 'method not allowed', null, { Allow: 'GET' });
    if (Object.prototype.hasOwnProperty.call(page, url)) return send(res, 200, page[url].body, page[url].type);
    if (url === '/strings.json') return json(res, 200, strings());
    if (url === '/favicon.ico') return send(res, 204, '');
    return send(res, 404, 'not found');
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 1000, connectionsCheckingInterval: 2000 }, (req, res) => {
        onRequest(req, res).catch((err) => {
          console.warn('[serverremote] pedido:', err?.message || err);
          if (!res.headersSent) send(res, 500, 'failed');
          else res.destroy();
        });
      });
      server.maxConnections = 32;
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      server.on('clientError', (err, socket) => socket.destroy());
      server.once('error', reject);
      // Solo esa IP: nunca 0.0.0.0 (lo garantiza quien llama con lanAddresses, y la prueba lo verifica).
      server.listen({ host: ip, port, exclusive: true }, () => {
        server.off('error', reject);
        server.on('error', (err) => console.warn('[serverremote] servidor:', err?.message || err));
        realPort = server.address().port;
        expiresAt = now() + ttlMs;
        expireTimer = setTimeout(() => stop('expired'), ttlMs);
        expireTimer.unref?.();
        resolve(info());
      });
    });
  }

  function stop(reason = 'stopped') {
    if (stopped) return;
    stopped = true;
    clearTimeout(expireTimer);
    token = null;
    clients.clear();
    lines.length = 0;
    if (server) {
      server.close();
      server.closeAllConnections?.();
      for (const s of sockets) s.destroy();
    }
    onEvent('stopped', { reason });
  }

  // Código nuevo: quien tenía el anterior tiene que volver a escanear.
  function rotate() {
    if (stopped) return null;
    token = sec.newToken();
    clients.clear();
    perIp.clear();
    everyone.clear();
    rejected = 0;
    return info();
  }

  // Cortar: esa IP no vuelve hasta apagar y el código cambia, porque quien lo tiene podría entrar desde otra IP.
  function kick(remote) {
    if (stopped || !clients.has(remote)) return null;
    cut.add(remote);
    for (const s of sockets) if (sec.cleanIp(s.remoteAddress) === remote) s.destroy();
    return rotate();
  }

  function pushLine(entry) {
    if (stopped || !entry) return;
    seq++;
    lines.push({ seq, t: entry.t || now(), level: String(entry.level || 'INFO').slice(0, 10), text: sec.redactLine(entry.text) });
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  }

  function info() {
    const t = now();
    for (const c of clients.values()) if (t - c.lastSeen > CLIENT_FORGET_MS) clients.delete(c.ip);
    const baseUrl = stopped ? '' : `http://${ip}:${realPort}`;
    return {
      on: !stopped,
      address: ip,
      port: realPort,
      baseUrl,
      url: stopped ? '' : `${baseUrl}/#t=${token}`,
      code: stopped ? '' : sec.formatCode(token),
      expiresAt,
      rejected,
      clients: [...clients.values()].map((c) => ({ ip: c.ip, device: c.device, firstSeen: c.firstSeen, lastSeen: c.lastSeen, connected: t - c.lastSeen < CONNECTED_MS })),
    };
  }

  return { start, stop, rotate, kick, pushLine, info, isStopped: () => stopped };
}

module.exports = { createRemoteHost, TTL_MS, MAX_BODY, TOKEN_HEADER, AFTER_HEADER, SAFE_HEADERS };
