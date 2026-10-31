'use strict';
// Transporte Streamable HTTP del servidor MCP: escucha SOLO en 127.0.0.1 y atiende POST en /mcp/<secreto>.
// Lo usan el puente stdio (Claude Desktop / Claude Code) y, a traves del tunel opcional, ChatGPT y claude.ai.
//   - Host: 127.0.0.1/localhost con el puerto propio, o el host del tunel activo. Cualquier otro -> 403
//     (protege contra DNS rebinding).
//   - Origin (si viene): solo origenes locales, el del tunel y los de claude.ai / chatgpt.com. Si no -> 403.
//   - Ruta: /mcp/<secreto> comparado en tiempo constante. Si no coincide -> 404 sin pistas.
//   - Solo POST (GET y DELETE -> 405: no hay flujo GET ni sesiones). Cuerpo JSON de hasta 1 MB.
//   - Respuestas JSON; con progressToken en tools/call y sin tunel, un flujo SSE con notificaciones de
//     progreso (mantiene viva la llamada mientras se espera una confirmacion o una descarga larga). El tunel
//     rapido de Cloudflare no admite SSE: por el tunel siempre se responde JSON.
// Si el cliente corta la conexion (o manda notifications/cancelled), la herramienta en curso se cancela.
const http = require('http');
const crypto = require('crypto');
const { errorResponse, ERR } = require('./protocol');

const MAX_BODY = 1024 * 1024;
const HEARTBEAT_MS = 15000;
const AI_ORIGINS = new Set(['https://claude.ai', 'https://chatgpt.com', 'https://chat.openai.com']);
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const SECRET_PATH = /^\/mcp\/([A-Za-z0-9_-]{16,200})\/?$/;

function sameSecret(given, secret) {
  if (typeof given !== 'string' || typeof secret !== 'string' || !secret) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b) && given.length === secret.length;
}

function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// Nombre del cliente para el registro de actividad: el que manda el puente o uno deducido del User-Agent.
function clientFromHeaders(req, remote) {
  const bridged = header(req, 'x-venus-bridge') === '1';
  const declared = String(header(req, 'x-venus-client') || '').replace(/[^\w .:@/()+-]/g, '').trim().slice(0, 60);
  const ua = String(header(req, 'user-agent') || '').slice(0, 200);
  let name = declared || '';
  if (!name) {
    if (/openai|chatgpt/i.test(ua)) name = 'openai-mcp';
    else if (/claude|anthropic/i.test(ua)) name = 'claude-ai';
  }
  return { name: name || null, via: bridged ? 'bridge' : 'http', source: remote ? 'remote' : 'local' };
}

function createHttpServer({ protocol, getSecret, getTunnelHost = () => null, log = () => {}, heartbeatMs = HEARTBEAT_MS, maxBody = MAX_BODY } = {}) {
  let server = null;
  let port = null;
  const sockets = new Set();
  const inflight = new Map(); // id JSON-RPC -> Set<AbortController> (para notifications/cancelled)

  const key = (id) => `${typeof id}:${String(id)}`;
  function track(id, controller) {
    if (id === undefined || id === null) return () => {};
    const k = key(id);
    if (!inflight.has(k)) inflight.set(k, new Set());
    inflight.get(k).add(controller);
    return () => {
      const set = inflight.get(k);
      if (!set) return;
      set.delete(controller);
      if (!set.size) inflight.delete(k);
    };
  }
  // Sin sesiones no se sabe de que cliente es cada id: solo se cancela si hay un unico pedido con ese id.
  function cancelById(id) {
    const set = inflight.get(key(id));
    if (set && set.size === 1) [...set][0].abort(new Error('cancelled'));
  }

  function hostKind(req) {
    const host = String(header(req, 'host') || '').toLowerCase();
    const tunnel = getTunnelHost();
    if (LOCAL_HOSTS.some((h) => host === `${h}:${port}`)) {
      // Por si cloudflared reescribiera el Host: lo que llega por Cloudflare se trata como remoto (sin SSE)
      const viaCloudflare = Boolean(header(req, 'cf-ray') || header(req, 'cf-connecting-ip') || /cloudflare/i.test(String(header(req, 'cdn-loop') || '')));
      return tunnel && viaCloudflare ? 'remote' : 'local';
    }
    if (tunnel && host === String(tunnel).toLowerCase()) return 'remote';
    return null;
  }

  function originAllowed(origin) {
    if (origin === undefined) return true;
    let u;
    try {
      u = new URL(origin);
    } catch {
      return false;
    }
    if (u.origin !== origin) return false;
    if ((u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return true;
    const tunnel = getTunnelHost();
    if (tunnel && origin === `https://${String(tunnel).toLowerCase()}`) return true;
    return AI_ORIGINS.has(origin);
  }

  function baseHeaders(origin) {
    const h = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (origin) {
      h['Access-Control-Allow-Origin'] = origin;
      h.Vary = 'Origin';
    }
    return h;
  }

  function send(res, status, body, origin, extra = {}) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (body === null || body === undefined) {
      res.writeHead(status, { ...baseHeaders(origin), ...extra });
      res.end();
      return;
    }
    const json = JSON.stringify(body);
    res.writeHead(status, { ...baseHeaders(origin), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json), ...extra });
    res.end(json);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let done = false;
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > maxBody) {
          done = true;
          reject(Object.assign(new Error('too large'), { status: 413 }));
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!done) {
          done = true;
          resolve(Buffer.concat(chunks, size).toString('utf8'));
        }
      });
      req.on('error', (err) => {
        if (!done) {
          done = true;
          reject(err);
        }
      });
    });
  }

  async function onRequest(req, res) {
    const kind = hostKind(req);
    const origin = header(req, 'origin');
    if (!kind) return send(res, 403, errorResponse(null, ERR.INVALID_REQUEST, 'Forbidden host'));
    if (!originAllowed(origin)) return send(res, 403, errorResponse(null, ERR.INVALID_REQUEST, 'Forbidden origin'));
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      pathname = '';
    }
    const m = SECRET_PATH.exec(pathname);
    if (!m || !sameSecret(m[1], getSecret())) return send(res, 404, null, origin);

    if (req.method === 'OPTIONS') {
      return send(res, 204, null, origin, {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID, Authorization',
        'Access-Control-Max-Age': '600',
      });
    }
    if (req.method !== 'POST') return send(res, 405, errorResponse(null, ERR.INVALID_REQUEST, 'Method not allowed'), origin, { Allow: 'POST, OPTIONS' });
    const ctype = String(header(req, 'content-type') || '').toLowerCase();
    if (ctype && !ctype.startsWith('application/json')) return send(res, 415, errorResponse(null, ERR.INVALID_REQUEST, 'Content-Type must be application/json'), origin);

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      return send(res, err.status === 413 ? 413 : 400, errorResponse(null, ERR.INVALID_REQUEST, err.status === 413 ? 'Request body too large' : 'Bad request body'), origin);
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return send(res, 400, errorResponse(null, ERR.PARSE, 'Parse error'), origin);
    }

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(new Error('disconnected'));
    });
    const ctx = {
      transport: 'http',
      headers: { protocolVersion: header(req, 'mcp-protocol-version'), method: header(req, 'mcp-method'), name: header(req, 'mcp-name') },
      client: clientFromHeaders(req, kind === 'remote'),
      signal: controller.signal,
      onCancel: cancelById,
      progress: () => {},
    };

    // Lote (clientes 2025-03-26): sin flujo, todo junto
    if (Array.isArray(payload)) {
      const r = await protocol.handlePayload(payload, ctx);
      return send(res, r.status, r.body, origin);
    }

    const p = protocol.prepare(payload, ctx);
    if (p.kind === 'reply') return send(res, p.status, p.body, origin);

    const untrack = track(payload.id, controller);
    try {
      const accept = String(header(req, 'accept') || '');
      const token = payload?.params?._meta?.progressToken;
      const stream = p.streamable && kind === 'local' && accept.includes('text/event-stream') && (typeof token === 'string' || typeof token === 'number');
      if (!stream) {
        const body = await p.run(ctx);
        if (controller.signal.aborted && res.destroyed) return;
        return send(res, p.status, body, origin);
      }
      // Flujo SSE: notificaciones de progreso y al final la respuesta
      res.writeHead(200, { ...baseHeaders(origin), 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
      res.write(': venus\n\n');
      let step = 0;
      const event = (msg) => {
        if (!res.writableEnded && !res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
      };
      const progress = (message) => event({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++step, ...(message ? { message: String(message).slice(0, 300) } : {}) } });
      const beat = setInterval(() => progress(), heartbeatMs);
      beat.unref?.();
      try {
        const body = await p.run({ ...ctx, progress });
        event(body);
      } finally {
        clearInterval(beat);
        if (!res.writableEnded) res.end();
      }
    } catch (err) {
      log('warn', `Pedido MCP: ${err?.message || err}`);
      if (!res.headersSent) send(res, 500, errorResponse(payload?.id, ERR.INTERNAL, 'Internal error'), origin);
      else if (!res.writableEnded) res.end();
    } finally {
      untrack();
    }
  }

  function listen({ port: wanted = 18765, host = '127.0.0.1', tries = 10 } = {}) {
    if (server) return Promise.resolve(port);
    const base = Number.isInteger(wanted) && wanted > 0 && wanted < 65536 ? wanted : 18765;
    const attempt = (p, left) =>
      new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => {
          onRequest(req, res).catch((err) => {
            log('error', `Error del servidor MCP: ${err?.message || err}`);
            try {
              if (!res.headersSent) send(res, 500, errorResponse(null, ERR.INTERNAL, 'Internal error'));
              else res.end();
            } catch {
              /* conexion cerrada */
            }
          });
        });
        s.keepAliveTimeout = 5000;
        s.headersTimeout = 30000;
        s.requestTimeout = 120000;
        s.on('connection', (sock) => {
          sockets.add(sock);
          sock.on('close', () => sockets.delete(sock));
        });
        s.once('error', (err) => {
          s.close();
          if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && left > 1 && p < 65535) resolve(attempt(p + 1, left - 1));
          else reject(err);
        });
        s.listen(p, host, () => {
          server = s;
          port = s.address().port;
          resolve(port);
        });
      });
    return attempt(base, Math.max(1, tries));
  }

  function close() {
    if (!server) return Promise.resolve();
    const s = server;
    server = null;
    port = null;
    for (const set of inflight.values()) for (const c of set) c.abort(new Error('closing'));
    inflight.clear();
    return new Promise((resolve) => {
      s.close(() => resolve());
      for (const sock of sockets) sock.destroy();
      sockets.clear();
      setTimeout(resolve, 1500).unref?.();
    });
  }

  return {
    listen,
    close,
    get port() {
      return port;
    },
    get running() {
      return Boolean(server);
    },
    inflightCount: () => [...inflight.values()].reduce((a, s) => a + s.size, 0),
  };
}

module.exports = { createHttpServer, sameSecret, clientFromHeaders, AI_ORIGINS, MAX_BODY };
