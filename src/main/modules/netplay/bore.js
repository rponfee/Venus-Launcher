'use strict';
// Cliente de bore (github.com/ekzhang/bore) en Node puro: publica un puerto TCP local como
// <servidor>:<puerto> (por ejemplo bore.pub:43125) sin abrir puertos en el router.
//
// Protocolo (src/shared.rs, client.rs, auth.rs de bore): mensajes JSON terminados en un byte nulo
// sobre una conexion TCP al puerto de control 7835.
//   cliente -> servidor: {"Hello":<puerto o 0>} | {"Accept":"<uuid>"} | {"Authenticate":"<hmac hex>"}
//   servidor -> cliente: {"Hello":<puerto publico>} | "Heartbeat" | {"Connection":"<uuid>"} | {"Challenge":"<uuid>"} | {"Error":"<texto>"}
// Por cada jugador que entra, el servidor manda Connection(id): se abre otra conexion de control,
// se manda Accept(id) y desde ahi esa conexion transporta los bytes hacia localhost:<puerto>.
// Autenticacion opcional: clave HMAC-SHA256 = SHA256(secreto), mensaje = los 16 bytes del UUID del desafio.
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const CONTROL_PORT = 7835;
const MAX_FRAME = 256; // limite de bore para cada mensaje JSON
const CONNECT_TIMEOUT = 6000;
const HANDSHAKE_TIMEOUT = 8000;
const HEARTBEAT_TIMEOUT = 15000; // el servidor manda Heartbeat cada 500 ms
const MAX_PROXIES = 64;
const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];

function encode(msg) {
  return Buffer.concat([Buffer.from(JSON.stringify(msg), 'utf8'), Buffer.from([0])]);
}

// Separa los mensajes terminados en \0. Devuelve [mensajes] y deja en this.buf lo que sobra.
class FrameReader {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const i = this.buf.indexOf(0);
      if (i < 0) {
        if (this.buf.length > MAX_FRAME * 4) throw new Error('bore: mensaje demasiado largo');
        break;
      }
      const raw = this.buf.subarray(0, i).toString('utf8');
      this.buf = this.buf.subarray(i + 1);
      if (!raw) continue;
      out.push(JSON.parse(raw));
    }
    return out;
  }
}

function authAnswer(secret, challenge) {
  const key = crypto.createHash('sha256').update(String(secret), 'utf8').digest();
  const bytes = Buffer.from(String(challenge).replace(/-/g, ''), 'hex');
  return crypto.createHmac('sha256', key).update(bytes).digest('hex');
}

function connect(host, port, timeout = CONNECT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    // Un 'error' sin oyentes tiraria abajo el proceso: los errores se manejan con 'close'
    sock.on('error', () => {});
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error(`bore: no se pudo conectar a ${host}:${port}`), { code: 'ETIMEDOUT' }));
    }, timeout);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.setNoDelay(true);
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    });
  });
}

// Lee el primer mensaje de un socket. Devuelve { msg, rest } y deja el socket pausado.
function readMessage(sock, timeout = HANDSHAKE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const reader = new FrameReader();
    const cleanup = () => {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onError);
      sock.removeListener('close', onClose);
      sock.pause();
    };
    const onData = (chunk) => {
      let msgs;
      try {
        msgs = reader.push(chunk);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (!msgs.length) return;
      cleanup();
      // Si llegaron mas mensajes juntos, devolverlos como bytes sobrantes
      const extra = msgs.slice(1).map(encode);
      resolve({ msg: msgs[0], rest: Buffer.concat([...extra, reader.buf]) });
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('bore: el servidor cerró la conexión'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('bore: el servidor no respondió a tiempo'), { code: 'ETIMEDOUT' }));
    }, timeout);
    sock.on('data', onData);
    sock.once('error', onError);
    sock.once('close', onClose);
  });
}

const kindOf = (msg) => (typeof msg === 'string' ? msg : msg && typeof msg === 'object' ? Object.keys(msg)[0] : null);

class BoreClient extends EventEmitter {
  /**
   * opts: { host = 'bore.pub', localHost = '127.0.0.1', localPort, remotePort = 0, secret = null, controlPort = 7835 }
   * Eventos: 'state' (snapshot), 'warning' ({ code }), 'address' ({ previous, current })
   */
  constructor(opts = {}) {
    super();
    this.host = opts.host || 'bore.pub';
    this.controlPort = opts.controlPort || CONTROL_PORT;
    this.localHost = opts.localHost || '127.0.0.1';
    this.localPort = Number(opts.localPort);
    this.requestedPort = Number(opts.remotePort) || 0;
    this.secret = opts.secret || null;
    this.remotePort = null;
    this.status = 'idle'; // idle | connecting | online | reconnecting | error | stopped
    this.error = null;
    this.control = null;
    this.proxies = new Set();
    this.connections = 0;
    this.totalConnections = 0;
    this.lastConnectionAt = null;
    this.startedAt = null;
    this.stopped = false;
    this.retry = 0;
    this.retryTimer = null;
    this.watchdog = null;
    this.lastSeen = 0;
    this.lastLocalWarning = 0;
  }

  get publicAddress() {
    return this.remotePort ? `${this.host}:${this.remotePort}` : null;
  }

  snapshot() {
    return {
      status: this.status,
      error: this.error,
      host: this.host,
      localPort: this.localPort,
      remotePort: this.remotePort,
      publicAddress: this.publicAddress,
      connections: this.connections,
      totalConnections: this.totalConnections,
      lastConnectionAt: this.lastConnectionAt,
      startedAt: this.startedAt,
    };
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.emit('state', this.snapshot());
  }

  // Conecta y espera el puerto publico. Reintenta una vez si la primera conexion falla.
  async start() {
    if (!(this.localPort > 0 && this.localPort < 65536)) throw new Error('bore: puerto local inválido');
    this.stopped = false;
    this.setStatus('connecting');
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.openControl();
        this.startedAt = this.startedAt || Date.now();
        this.retry = 0;
        this.setStatus('online');
        return this.snapshot();
      } catch (err) {
        lastErr = err;
        if (this.stopped || err.fatal) break;
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    if (!this.stopped) this.setStatus('error', lastErr?.message || String(lastErr));
    throw lastErr;
  }

  async openControl() {
    const sock = await connect(this.host, this.controlPort);
    if (this.stopped) {
      sock.destroy();
      throw new Error('bore: detenido');
    }
    sock.setKeepAlive(true, 15000);
    try {
      let rest = Buffer.alloc(0);
      if (this.secret) {
        const first = await readMessage(sock);
        if (kindOf(first.msg) !== 'Challenge') throw Object.assign(new Error('bore: el servidor no pidió autenticación'), { fatal: true });
        sock.write(encode({ Authenticate: authAnswer(this.secret, first.msg.Challenge) }));
        rest = first.rest;
      }
      sock.write(encode({ Hello: this.requestedPort }));
      let reply;
      if (rest.length) {
        // Respuesta que ya habia llegado junto con el desafio
        const reader = new FrameReader();
        const msgs = reader.push(rest);
        reply = msgs.length ? { msg: msgs[0], rest: reader.buf } : await readMessage(sock);
      } else reply = await readMessage(sock);
      const kind = kindOf(reply.msg);
      if (kind === 'Error') {
        const text = String(reply.msg.Error || '');
        if (this.requestedPort && /port|range/i.test(text)) {
          sock.destroy();
          // El servidor libera el puerto anterior recien en su proximo heartbeat (500 ms): reintentar una vez
          if (/in use/i.test(text) && !this.samePortRetried) {
            this.samePortRetried = true;
            await new Promise((r) => setTimeout(r, 1500));
            if (this.stopped) throw new Error('bore: detenido');
            return this.openControl();
          }
          // El puerto anterior ya no esta disponible: pedir uno nuevo
          this.requestedPort = 0;
          return this.openControl();
        }
        throw Object.assign(new Error(`bore: ${text}`), { serverError: text });
      }
      if (kind === 'Challenge') throw Object.assign(new Error('bore: el servidor requiere una clave secreta'), { fatal: true, needsSecret: true });
      if (kind !== 'Hello') throw new Error('bore: respuesta inesperada del servidor');
      const port = Number(reply.msg.Hello);
      if (!(port > 0 && port < 65536)) throw new Error('bore: puerto público inválido');
      const previous = this.publicAddress;
      this.samePortRetried = false;
      this.remotePort = port;
      this.requestedPort = port; // al reconectar se pide el mismo puerto para mantener la direccion
      if (previous && previous !== this.publicAddress) this.emit('address', { previous, current: this.publicAddress });
      this.attachControl(sock, reply.rest);
    } catch (err) {
      sock.destroy();
      throw err;
    }
  }

  attachControl(sock, rest) {
    this.control = sock;
    this.lastSeen = Date.now();
    const reader = new FrameReader();
    const onMessages = (msgs) => {
      for (const msg of msgs) {
        const kind = kindOf(msg);
        if (kind === 'Connection') this.handleConnection(String(msg.Connection));
        else if (kind === 'Error') this.emit('warning', { code: 'serverError', message: String(msg.Error || '') });
      }
    };
    sock.on('data', (chunk) => {
      this.lastSeen = Date.now();
      try {
        onMessages(reader.push(chunk));
      } catch (err) {
        sock.destroy(err);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.control !== sock) return;
      this.control = null;
      clearInterval(this.watchdog);
      this.watchdog = null;
      if (!this.stopped) this.scheduleReconnect();
    });
    sock.resume();
    if (rest?.length) {
      try {
        onMessages(reader.push(rest));
      } catch {
        /* basura al final del saludo */
      }
    }
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastSeen > HEARTBEAT_TIMEOUT) sock.destroy(new Error('bore: sin heartbeat'));
    }, 5000);
  }

  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const delay = BACKOFF[Math.min(this.retry, BACKOFF.length - 1)];
    this.retry++;
    this.setStatus('reconnecting', this.error);
    this.retryTimer = setTimeout(async () => {
      if (this.stopped) return;
      try {
        await this.openControl();
        this.retry = 0;
        this.setStatus('online');
      } catch (err) {
        if (this.stopped) return;
        if (err.fatal) {
          this.setStatus('error', err.message);
          return;
        }
        this.error = err.message;
        this.scheduleReconnect();
      }
    }, delay);
  }

  async handleConnection(id) {
    if (this.stopped || !/^[0-9a-f-]{32,36}$/i.test(id)) return;
    if (this.proxies.size >= MAX_PROXIES * 2) return;
    let remote = null;
    let local = null;
    const pair = { remote: null, local: null };
    this.proxies.add(pair);
    const close = () => {
      if (!this.proxies.has(pair)) return;
      this.proxies.delete(pair);
      remote?.destroy();
      local?.destroy();
      if (pair.counted) {
        this.connections = Math.max(0, this.connections - 1);
        this.emit('state', this.snapshot());
      }
    };
    try {
      remote = pair.remote = await connect(this.host, this.controlPort);
      let rest = Buffer.alloc(0);
      if (this.secret) {
        const first = await readMessage(remote);
        if (kindOf(first.msg) !== 'Challenge') throw new Error('bore: desafío esperado');
        remote.write(encode({ Authenticate: authAnswer(this.secret, first.msg.Challenge) }));
        rest = first.rest;
      }
      remote.write(encode({ Accept: id }));
      try {
        local = pair.local = await connect(this.localHost, this.localPort, 4000);
      } catch (err) {
        // Llego un jugador pero el servidor local no responde (apagado o puerto distinto)
        if (Date.now() - this.lastLocalWarning > 10000) {
          this.lastLocalWarning = Date.now();
          this.emit('warning', { code: 'localUnreachable', port: this.localPort });
        }
        throw err;
      }
      if (this.stopped) throw new Error('bore: detenido');
      if (this.proxies.size > MAX_PROXIES) throw new Error('bore: demasiadas conexiones');
      pair.counted = true;
      this.connections++;
      this.totalConnections++;
      this.lastConnectionAt = Date.now();
      this.emit('state', this.snapshot());
      if (rest.length) local.write(rest);
      for (const s of [remote, local]) {
        s.on('error', close);
        s.on('close', close);
      }
      remote.pipe(local);
      local.pipe(remote);
    } catch {
      close();
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.control) {
      const c = this.control;
      this.control = null;
      c.destroy();
    }
    for (const p of [...this.proxies]) {
      p.remote?.destroy();
      p.local?.destroy();
    }
    this.proxies.clear();
    this.connections = 0;
    this.setStatus('stopped');
  }
}

module.exports = { BoreClient, FrameReader, encode, authAnswer, CONTROL_PORT };
