'use strict';
// Server List Ping de Minecraft con Node puro (net + dns):
//  - protocolo moderno (1.7+): handshake + status + ping/pong, con tramas VarInt
//  - ping heredado 0xFE 0x01 para servidores 1.4 - 1.6
//  - registros SRV (_minecraft._tcp), IPv6, tiempos de espera, cache de 20 s y limite de conexiones simultaneas
const net = require('net');
const dns = require('dns');
const { parseAddress, DEFAULT_PORT } = require('./address');
const status = require('./status');
const versions = require('./versions');

const CONNECT_TIMEOUT = 5000;
const READ_TIMEOUT = 7000;
const PONG_TIMEOUT = 2500;
const CACHE_TTL = 20000;
const MAX_PACKET = 4 * 1024 * 1024;
const MAX_CONCURRENT = 8;

// ---------- Utilidades binarias ----------

function varInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf, pos) {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    if (pos >= buf.length) return null; // incompleto
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [value | 0, pos];
    shift += 7;
  }
  throw protoError('VarInt demasiado largo');
}

function mcString(s) {
  const data = Buffer.from(String(s), 'utf8');
  return Buffer.concat([varInt(data.length), data]);
}

function packet(id, ...fields) {
  const body = Buffer.concat([varInt(id), ...fields]);
  return Buffer.concat([varInt(body.length), body]);
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function utf16be(s) {
  return Buffer.from(String(s), 'utf16le').swap16();
}

function protoError(msg, code = 'MC_PROTOCOL') {
  return Object.assign(new Error(msg), { code });
}

// ---------- Conexion ----------

function openSocket(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 300 });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, CONNECT_TIMEOUT);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      socket.on('error', () => {}); // los errores tardios se manejan donde se lee
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

// Lee paquetes completos (largo VarInt + id + datos) del socket.
class PacketStream {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.total = 0;
    this.waiter = null;
    this.ended = null;
    socket.on('data', (chunk) => {
      this.total += chunk.length;
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this.flush();
    });
    const end = (err) => {
      if (this.ended) return;
      this.ended = err || protoError('El servidor cerró la conexión', this.total ? 'MC_PROTOCOL' : 'MC_CLOSED');
      this.flush();
    };
    socket.on('end', () => end());
    socket.on('close', () => end());
    socket.on('error', (err) => end(err));
  }

  // Un servidor viejo contesta con un "kick" heredado: 0xFF + largo (short) + texto UTF-16BE.
  // (Una respuesta moderna tambien puede empezar con 0xFF como primer byte del VarInt, por eso se mira mas.)
  get legacyKick() {
    const b = this.buf;
    if (this.total !== b.length || b.length < 5 || b[0] !== 0xff) return false;
    const printable = (c) => (c >= 0x20 && c < 0x7f) || c === 0xa7;
    return b.readUInt16BE(1) <= 4096 && b[3] === 0x00 && printable(b[4]);
  }

  tryParse() {
    if (this.legacyKick) throw protoError('Servidor heredado', 'MC_LEGACY');
    const head = readVarInt(this.buf, 0);
    if (!head) return null;
    const [len, start] = head;
    if (len <= 0 || len > MAX_PACKET) throw protoError('Paquete inválido');
    if (this.buf.length < start + len) return null;
    const body = this.buf.subarray(start, start + len);
    this.buf = this.buf.subarray(start + len);
    const idv = readVarInt(body, 0);
    if (!idv) throw protoError('Paquete inválido');
    return { id: idv[0], data: body.subarray(idv[1]) };
  }

  flush() {
    if (!this.waiter) return;
    const w = this.waiter;
    try {
      const p = this.tryParse();
      if (p) {
        this.waiter = null;
        clearTimeout(w.timer);
        w.resolve(p);
        return;
      }
    } catch (err) {
      this.waiter = null;
      clearTimeout(w.timer);
      w.reject(err);
      return;
    }
    if (this.ended) {
      this.waiter = null;
      clearTimeout(w.timer);
      w.reject(this.ended);
    }
  }

  next(timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
      }, timeout);
      this.waiter = { resolve, reject, timer };
      this.flush();
    });
  }
}

// Handshake + status (+ ping/pong para medir la latencia)
async function statusModern(target, handshakeHost, handshakePort, protocol, { withPing = true } = {}) {
  const socket = await openSocket(target.host, target.port);
  const stream = new PacketStream(socket);
  try {
    const host = String(handshakeHost).slice(0, 255);
    const hs = packet(0x00, varInt(protocol), mcString(host), u16(handshakePort), varInt(1));
    const tReq = performance.now();
    socket.write(Buffer.concat([hs, packet(0x00)]));
    const resp = await stream.next(READ_TIMEOUT);
    if (resp.id !== 0x00) throw protoError('Respuesta inesperada');
    const strHead = readVarInt(resp.data, 0);
    if (!strHead || strHead[1] + strHead[0] > resp.data.length) throw protoError('Respuesta incompleta');
    const json = resp.data.toString('utf8', strHead[1], strHead[1] + strHead[0]);
    const statusMs = performance.now() - tReq;
    let latency = null;
    if (withPing && !stream.ended) {
      const payload = Buffer.alloc(8);
      payload.writeBigInt64BE(BigInt(Date.now()));
      const tPing = performance.now();
      socket.write(packet(0x01, payload));
      try {
        const pong = await stream.next(PONG_TIMEOUT);
        if (pong.id === 0x01) latency = performance.now() - tPing;
      } catch {
        /* algunos servidores no contestan el ping: se usa el tiempo del estado */
      }
    }
    return { json, latency: Math.max(1, Math.round(latency ?? statusMs)), ip: socket.remoteAddress || null };
  } finally {
    socket.destroy();
  }
}

// Ping heredado (1.4 a 1.6; los servidores nuevos tambien lo entienden)
async function statusLegacy(target, handshakeHost, handshakePort) {
  const socket = await openSocket(target.host, target.port);
  try {
    const tag = 'MC|PingHost';
    const host = String(handshakeHost).slice(0, 255);
    const hostBuf = utf16be(host);
    const rest = Buffer.alloc(1 + 2 + hostBuf.length + 4);
    rest.writeUInt8(78, 0);
    rest.writeUInt16BE(host.length, 1);
    hostBuf.copy(rest, 3);
    rest.writeInt32BE(handshakePort, 3 + hostBuf.length);
    const msg = Buffer.concat([Buffer.from([0xfe, 0x01, 0xfa]), u16(tag.length), utf16be(tag), u16(rest.length), rest]);
    const t0 = performance.now();
    const text = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), READ_TIMEOUT);
      const done = (fn, v) => {
        clearTimeout(timer);
        fn(v);
      };
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf[0] !== 0xff) return done(reject, protoError('Respuesta heredada inválida'));
        if (buf.length < 3) return undefined;
        const chars = buf.readUInt16BE(1);
        if (buf.length < 3 + chars * 2) return undefined;
        const raw = Buffer.from(buf.subarray(3, 3 + chars * 2)).swap16();
        return done(resolve, raw.toString('utf16le'));
      });
      socket.once('close', () => done(reject, protoError('El servidor cerró la conexión', buf.length ? 'MC_PROTOCOL' : 'MC_CLOSED')));
      socket.once('error', (err) => done(reject, err));
      socket.write(msg);
    });
    return { text, latency: Math.max(1, Math.round(performance.now() - t0)), ip: socket.remoteAddress || null };
  } finally {
    socket.destroy();
  }
}

// ---------- SRV ----------

// Muchos dominios (2b2t.org, blocksmc.com...) apuntan su registro A a la pagina web y el juego
// entra por el SRV, asi que hay que resolverlo si o si. Orden: DNS del sistema -> DNS publicos
// (UDP) -> DNS sobre HTTPS. Si el DNS del sistema falla, se saltea por 5 minutos.
const NO_RECORD = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);
const SRV_TTL = 5 * 60 * 1000;
const SRV_NEG_TTL = 2 * 60 * 1000;
const srvCache = new Map(); // host -> { at, ttl, record }
let systemBrokenUntil = 0;
let systemResolver = null;
let publicResolver = null;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms))]);
}

function pickSrv(records) {
  const list = (records || []).filter((r) => r && r.name && r.port > 0);
  if (!list.length) return null;
  const r = [...list].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
  return { host: String(r.name).replace(/\.$/, '').toLowerCase(), port: Number(r.port) };
}

async function srvUdp(resolver, name) {
  try {
    return { ok: true, record: pickSrv(await withTimeout(resolver.resolveSrv(name), 3000)) };
  } catch (err) {
    if (NO_RECORD.has(err?.code)) return { ok: true, record: null };
    return { ok: false };
  }
}

async function srvDoh(url) {
  try {
    const res = await withTimeout(fetch(url, { headers: { accept: 'application/dns-json' } }), 3500);
    if (!res.ok) return { ok: false };
    const data = await res.json();
    if (data.Status === 3) return { ok: true, record: null };
    if (data.Status !== 0) return { ok: false };
    const records = (data.Answer || [])
      .filter((a) => a.type === 33 && typeof a.data === 'string')
      .map((a) => {
        const [priority, weight, port, name] = a.data.trim().split(/\s+/);
        return { priority: Number(priority), weight: Number(weight), port: Number(port), name };
      });
    return { ok: true, record: pickSrv(records) };
  } catch {
    return { ok: false };
  }
}

async function lookupSrv(host) {
  const hit = srvCache.get(host);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.record;
  const name = `_minecraft._tcp.${host}`;
  let r = { ok: false };
  if (Date.now() > systemBrokenUntil) {
    if (!systemResolver) systemResolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
    r = await srvUdp(systemResolver, name);
    if (!r.ok) systemBrokenUntil = Date.now() + 5 * 60 * 1000;
  }
  if (!r.ok) {
    if (!publicResolver) {
      publicResolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
      publicResolver.setServers(['1.1.1.1', '8.8.8.8', '9.9.9.9']);
    }
    r = await srvUdp(publicResolver, name);
  }
  if (!r.ok) r = await srvDoh(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=SRV`);
  if (!r.ok) r = await srvDoh(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=SRV`);
  const record = r.ok ? r.record : null;
  srvCache.set(host, { at: Date.now(), ttl: record ? SRV_TTL : SRV_NEG_TTL, record });
  if (srvCache.size > 500) srvCache.delete(srvCache.keys().next().value);
  return record;
}

async function resolveTarget(addr) {
  // Igual que el juego: el SRV solo se consulta para dominios con el puerto por defecto.
  if (addr.ipVersion || addr.port !== DEFAULT_PORT || !addr.host.includes('.')) return { host: addr.host, port: addr.port, srv: false };
  const rec = await lookupSrv(addr.host);
  if (rec) return { host: rec.host, port: rec.port, srv: true };
  return { host: addr.host, port: addr.port, srv: false };
}

// ---------- Errores ----------

function errorCode(err) {
  const c = err?.code || '';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'EAI_NODATA' || c === 'EAI_NONAME') return 'notfound';
  if (c === 'ECONNREFUSED') return 'refused';
  if (c === 'ETIMEDOUT') return 'timeout';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'EADDRNOTAVAIL' || c === 'ENETDOWN') return 'unreachable';
  if (c === 'ECONNRESET' || c === 'EPIPE' || c === 'MC_CLOSED') return 'closed';
  if (c === 'MC_PROTOCOL' || c === 'MC_LEGACY' || err instanceof SyntaxError) return 'protocol';
  return 'unknown';
}

const retryable = (err) => ['MC_CLOSED', 'MC_PROTOCOL', 'MC_LEGACY', 'ECONNRESET'].includes(err?.code) || err instanceof SyntaxError;

// ---------- Ping completo ----------

async function doPing(addr, protocol) {
  const target = await resolveTarget(addr);
  const base = { address: addr.display, key: addr.key, host: addr.host, port: addr.port, target, checkedAt: Date.now() };
  try {
    let parsed;
    let net1;
    try {
      net1 = await statusModern(target, addr.host, addr.port, protocol);
      parsed = status.parseModern(net1.json);
    } catch (err) {
      if (!retryable(err)) throw err;
      let modernErr = err;
      // Algunos proxies cortan los handshakes con protocolo -1: se reintenta con uno real.
      if (err.code === 'MC_CLOSED' && protocol === -1) {
        try {
          net1 = await statusModern(target, addr.host, addr.port, versions.LATEST_PROTOCOL);
          parsed = status.parseModern(net1.json);
          modernErr = null;
        } catch (err2) {
          modernErr = err2;
          if (!retryable(err2)) throw err2;
        }
      }
      if (modernErr) {
        const legacy = await statusLegacy(target, addr.host, addr.port);
        net1 = legacy;
        parsed = status.parseLegacy(legacy.text);
      }
    }
    return { ...base, online: true, latency: net1.latency, ip: net1.ip, ...parsed };
  } catch (err) {
    return { ...base, online: false, error: errorCode(err), detail: err?.message || String(err) };
  }
}

// Limite de conexiones simultaneas
let active = 0;
const queue = [];
function limit(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          const next = queue.shift();
          if (next) next();
        });
    };
    if (active < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

const cache = new Map(); // clave -> { at, result }
const inflight = new Map(); // clave -> Promise

function prune() {
  if (cache.size < 400) return;
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_TTL) cache.delete(k);
  while (cache.size > 300) cache.delete(cache.keys().next().value);
}

/**
 * Consulta un servidor. opts: { force, protocol (-1 = el que prefiera el servidor), ttl }
 * Lanza un Error con code 'INVALID_ADDRESS' si la direccion no es valida.
 */
async function ping(input, { force = false, protocol = -1, ttl = CACHE_TTL } = {}) {
  const addr = parseAddress(input);
  if (!addr) throw Object.assign(new Error('Dirección inválida'), { code: 'INVALID_ADDRESS' });
  const key = `${addr.key}#${protocol}`;
  if (!force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return { ...hit.result, cached: true };
    if (inflight.has(key)) return inflight.get(key);
  }
  const p = limit(() => doPing(addr, protocol))
    .then((result) => {
      cache.set(key, { at: Date.now(), result });
      prune();
      return { ...result, cached: false };
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function clearCache() {
  cache.clear();
  probes.clear();
}

// ¿El servidor acepta clientes de este protocolo? Los proxies multi-version (ViaVersion, Velocity...)
// devuelven el mismo protocolo que mando el cliente cuando lo soportan. -> true | false | null (sin respuesta)
// Ojo: muchas redes tienen anti-bots que cortan todas las conexiones si llegan varias seguidas;
// un corte no significa "no soportado", por eso devuelve null (no se sabe) y quien llama no insiste.
const probes = new Map(); // clave -> { at, ok }
async function probe(input, protocol) {
  const addr = parseAddress(input);
  if (!addr || !Number.isInteger(protocol) || protocol <= 0) return null;
  const key = `${addr.key}#${protocol}`;
  const hit = probes.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.ok;
  const ok = await limit(async () => {
    try {
      const target = await resolveTarget(addr);
      const r = await statusModern(target, addr.host, addr.port, protocol, { withPing: false });
      const data = JSON.parse(r.json);
      return data?.version?.protocol === protocol;
    } catch {
      return null;
    }
  });
  if (ok !== null) {
    probes.set(key, { at: Date.now(), ok });
    if (probes.size > 500) probes.delete(probes.keys().next().value);
  }
  return ok;
}

module.exports = { ping, probe, clearCache, errorCode, resolveTarget, statusModern, statusLegacy, varInt, readVarInt, CACHE_TTL };
