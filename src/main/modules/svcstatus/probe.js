'use strict';
// Estado de los servicios: una consulta con tiempo límite. Sin Electron (fetch y reloj inyectables).
//  - Cualquier respuesta HTTP que no sea 5xx cuenta como "responde" (un 404 o un 301 también: el servidor contestó).
//    El 501 ("no implementado") tampoco cuenta como caído: es el servidor diciendo que no acepta HEAD.
//  - Más de slowMs hasta recibir la respuesta = lento.
//  - Error de red, tiempo agotado o 5xx = no responde.
// No se siguen redirecciones (redirect: 'manual') ni se lee el cuerpo: solo importa que conteste.
const { safeHeaders } = require('./services');

const DNS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA']);
const TIMEOUT = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const RESET = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const UNREACHABLE = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL']);
const TLS = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|HANDSHAKE/;
const CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

// Código del error de red (undici lo deja en cause; con IPv4 + IPv6 a veces en cause.errors[]).
function errCode(err) {
  const seen = new Set();
  const queue = [err];
  while (queue.length) {
    const e = queue.shift();
    if (!e || typeof e !== 'object' || seen.has(e)) continue;
    seen.add(e);
    if (typeof e.code === 'string' && CODE.test(e.code)) return e.code;
    if (e.cause) queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...e.errors.slice(0, 4));
  }
  const text = String((err && err.message) || '');
  const m = text.match(/\b(E[A-Z]{3,}|[A-Z]+(?:_[A-Z]+){1,6})\b/);
  return m && CODE.test(m[1]) ? m[1] : '';
}

// Motivo para explicarle al usuario: dns, timeout, refused, reset, unreachable, tls o network.
function reasonOf(code, err) {
  if (DNS.has(code)) return 'dns';
  if (TIMEOUT.has(code) || (err && err.name === 'TimeoutError')) return 'timeout';
  if (code === 'ECONNREFUSED') return 'refused';
  if (RESET.has(code)) return 'reset';
  if (UNREACHABLE.has(code)) return 'unreachable';
  if (code && TLS.test(code)) return 'tls';
  return 'network';
}

// Un pedido. Devuelve { state, ms, httpStatus?, reason?, detail? } y nunca lanza.
async function probeRequest(req, { fetch, now = Date.now, timeoutMs = 6000, slowMs = 2500 } = {}) {
  const ctrl = new AbortController();
  const timeoutErr = Object.assign(new Error('timeout'), { code: 'SVC_TIMEOUT' });
  const timer = setTimeout(() => ctrl.abort(timeoutErr), timeoutMs);
  const started = now();
  try {
    const res = await fetch(req.url, { method: req.method === 'GET' ? 'GET' : 'HEAD', headers: safeHeaders(req), redirect: 'manual', signal: ctrl.signal });
    const ms = Math.max(0, now() - started);
    try {
      // Sin leer el cuerpo: se cancela para liberar la conexión.
      const pending = res && res.body && typeof res.body.cancel === 'function' ? res.body.cancel() : null;
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      /* nada */
    }
    const status = Number(res && res.status) || 0;
    if (status >= 500 && status !== 501) return { state: 'down', ms, httpStatus: status, reason: 'http', detail: `HTTP ${status}` };
    return { state: ms > slowMs ? 'slow' : 'ok', ms, httpStatus: status || null };
  } catch (err) {
    const ms = Math.max(0, now() - started);
    if (ctrl.signal.aborted && ctrl.signal.reason === timeoutErr) return { state: 'down', ms: Math.max(ms, timeoutMs), reason: 'timeout', detail: 'timeout' };
    const code = errCode(err);
    const reason = reasonOf(code, err);
    return { state: 'down', ms: reason === 'timeout' ? Math.max(ms, timeoutMs) : ms, reason, detail: code || 'network' };
  } finally {
    clearTimeout(timer);
  }
}

const RANK = { ok: 0, slow: 1, down: 2 };

// Un servicio (uno o más pedidos en paralelo): vale el que mejor contestó. En la prueba de conexión se nota
// además si falla solo el DNS (por nombre no anda y por IP sí). Con def.anyAnswer (la prueba de conexión), un
// 5xx también cuenta como "responde": el servidor contestó, así que internet anda aunque ese servidor esté mal.
async function probeService(def, ctx) {
  if (def.skip) return { id: def.id, group: def.group, state: 'skipped', ms: null, reason: def.skip };
  if (!Array.isArray(def.requests) || !def.requests.length) return { id: def.id, group: def.group, state: 'skipped', ms: null, reason: 'notConfigured' };
  const slowMs = ctx && Number.isFinite(ctx.slowMs) ? ctx.slowMs : 2500;
  const outs = (await Promise.all(def.requests.map((r) => probeRequest(r, ctx)))).map((o) =>
    def.anyAnswer && o.state === 'down' && Number(o.httpStatus) > 0 ? { state: o.ms > slowMs ? 'slow' : 'ok', ms: o.ms, httpStatus: o.httpStatus } : o,
  );
  // Si fallan todos, el motivo que se muestra es el que no es de DNS (si por IP tampoco hay camino, el problema
  // es la red y no el DNS); a igualdad, el primero.
  const dnsRank = (o) => (o.reason === 'dns' ? 1 : 0);
  const best = outs
    .map((o, i) => ({ o, i }))
    .sort((a, b) => RANK[a.o.state] - RANK[b.o.state] || (a.o.state === 'down' ? dnsRank(a.o) - dnsRank(b.o) || a.i - b.i : a.o.ms - b.o.ms))[0].o;
  const out = { id: def.id, group: def.group, ...best };
  const byName = outs.filter((o, i) => (def.requests[i].via || 'name') === 'name');
  const byIp = outs.filter((o, i) => def.requests[i].via === 'ip');
  if (byIp.length && byName.length) out.dns = byName.every((o) => o.state === 'down' && o.reason === 'dns') && byIp.some((o) => o.state !== 'down') ? 'down' : 'ok';
  return out;
}

module.exports = { probeRequest, probeService, errCode, reasonOf };
