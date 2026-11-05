// Cliente MQTT 3.1.1 minimo sobre WebSocket para el camino de respaldo del Voice Chat (voice/backup.js).
// Solo lo que hace falta: CONNECT, SUBSCRIBE, PUBLISH con QoS 0, PINGREQ y DISCONNECT. Sin retencion, sin sesion
// persistente, sin usuario ni clave: los brokers publicos gratuitos solo transportan bytes ya cifrados y firmados
// (voice/seal.js), asi que no hace falta mas. Sin dependencias: el constructor de WebSocket se puede inyectar para las
// pruebas.
const enc = new TextEncoder();
const dec = new TextDecoder();

export const T = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, SUBSCRIBE: 8, SUBACK: 9, UNSUBSCRIBE: 10, UNSUBACK: 11, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };
export const MAX_PACKET = 1 << 20; // un paquete mas grande que esto no es de nuestro canal: se corta la conexion
const CONNACK_TEXT = ['', 'protocol', 'client id', 'unavailable', 'credentials', 'not authorized'];

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Largo restante: 1 a 4 bytes, 7 bits cada uno (el octavo avisa que sigue otro)
export function encodeLength(n) {
  if (!Number.isInteger(n) || n < 0 || n > 268435455) throw new RangeError('mqtt length');
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Uint8Array.from(out);
}

// Cadena UTF-8 con prefijo de 2 bytes
export function str(s) {
  const b = enc.encode(String(s));
  if (b.length > 65535) throw new RangeError('mqtt string');
  return concat(Uint8Array.of(b.length >> 8, b.length & 0xff), b);
}

export function packet(type, flags, body = new Uint8Array(0)) {
  return concat(Uint8Array.of((type << 4) | (flags & 0x0f)), encodeLength(body.length), body);
}

// username/password: solo para brokers publicos que piden credenciales abiertas (por ejemplo "public"/"public")
export function connectPacket({ clientId, keepAlive = 30, username, password }) {
  const flags = 0x02 | (username ? 0x80 : 0) | (username && password ? 0x40 : 0);
  const body = concat(str('MQTT'), Uint8Array.of(4, flags, keepAlive >> 8, keepAlive & 0xff), str(clientId), username ? str(username) : new Uint8Array(0), username && password ? str(password) : new Uint8Array(0));
  return packet(T.CONNECT, 0, body);
}

export function subscribePacket(id, topics) {
  return packet(T.SUBSCRIBE, 2, concat(Uint8Array.of(id >> 8, id & 0xff), ...topics.map((t) => concat(str(t), Uint8Array.of(0)))));
}

export function unsubscribePacket(id, topics) {
  return packet(T.UNSUBSCRIBE, 2, concat(Uint8Array.of(id >> 8, id & 0xff), ...topics.map((t) => str(t))));
}

export function publishPacket(topic, payload) {
  return packet(T.PUBLISH, 0, concat(str(topic), payload));
}

export const PINGREQ = packet(T.PINGREQ, 0);
export const DISCONNECT = packet(T.DISCONNECT, 0);

// Junta los trozos que llegan por el socket y entrega paquetes completos { type, flags, body }
export class PacketReader {
  constructor(max = MAX_PACKET) {
    this.max = max;
    this.buf = new Uint8Array(0);
  }

  push(bytes) {
    this.buf = this.buf.length ? concat(this.buf, bytes) : bytes;
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let len = 0;
      let mul = 1;
      let i = 1;
      let done = false;
      for (; i < 5 && i < this.buf.length; i++) {
        len += (this.buf[i] & 0x7f) * mul;
        mul *= 128;
        if (!(this.buf[i] & 0x80)) {
          done = true;
          i++;
          break;
        }
      }
      if (!done) {
        if (i >= 5) throw new Error('mqtt malformed length');
        break; // falta parte del largo
      }
      if (len > this.max) throw new Error('mqtt packet too large');
      if (this.buf.length < i + len) break;
      out.push({ type: this.buf[0] >> 4, flags: this.buf[0] & 0x0f, body: this.buf.slice(i, i + len) });
      this.buf = this.buf.slice(i + len);
    }
    return out;
  }
}

// PUBLISH entrante -> { topic, payload, qos, id }
export function parsePublish(p) {
  const b = p.body;
  if (b.length < 2) throw new Error('mqtt malformed publish');
  const tl = (b[0] << 8) | b[1];
  if (b.length < 2 + tl) throw new Error('mqtt malformed publish');
  const topic = dec.decode(b.subarray(2, 2 + tl));
  const qos = (p.flags >> 1) & 3;
  let at = 2 + tl;
  let id = null;
  if (qos > 0) {
    if (b.length < at + 2) throw new Error('mqtt malformed publish');
    id = (b[at] << 8) | b[at + 1];
    at += 2;
  }
  return { topic, payload: b.slice(at), qos, id };
}

export class MqttError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// Una conexion a un broker. connect() -> Promise (CONNACK aceptado); subscribe(topic) -> Promise (SUBACK);
// publish(topic, bytes) -> boolean (false si el socket no esta abierto). Avisos: onMessage(topic, bytes), onClose(error|null).
export class MqttClient {
  constructor({ url, clientId, keepAlive = 30, connectTimeout = 6000, username, password, WebSocketCtor = globalThis.WebSocket, timers = globalThis, now = () => Date.now() }) {
    this.url = url;
    this.username = username;
    this.password = password;
    this.clientId = clientId;
    this.keepAlive = keepAlive;
    this.connectTimeout = connectTimeout;
    this.WS = WebSocketCtor;
    this.timers = timers;
    this.now = now;
    this.onMessage = null;
    this.onClose = null;
    this.ws = null;
    this.reader = new PacketReader();
    this.state = 'idle'; // idle | connecting | open | closed
    this.nextId = 1;
    this.waits = new Map(); // id de SUBSCRIBE -> { resolve, reject }
    this.connectWait = null;
    this.lastRx = 0;
    this.lastTx = 0;
    this.pingTimer = null;
  }

  connect() {
    if (this.state !== 'idle') return Promise.reject(new MqttError('state'));
    if (typeof this.WS !== 'function') return Promise.reject(new MqttError('nowebsocket'));
    this.state = 'connecting';
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => this.fail(new MqttError('timeout', 'connect timeout')), this.connectTimeout);
      this.connectWait = {
        resolve: () => {
          this.timers.clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          this.timers.clearTimeout(timer);
          reject(err);
        },
      };
      let ws;
      try {
        ws = new this.WS(this.url, ['mqtt']);
      } catch (err) {
        this.fail(new MqttError('socket', err?.message));
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.lastRx = this.now();
        this.write(connectPacket({ clientId: this.clientId, keepAlive: this.keepAlive, username: this.username, password: this.password }));
      };
      ws.onmessage = (e) => {
        if (this.ws !== ws) return;
        if (!(e.data instanceof ArrayBuffer) && !ArrayBuffer.isView(e.data)) return; // los textos no son MQTT
        this.lastRx = this.now();
        try {
          const bytes = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
          for (const p of this.reader.push(bytes)) this.handle(p);
        } catch (err) {
          this.fail(new MqttError('protocol', err?.message));
        }
      };
      ws.onerror = () => {
        if (this.ws === ws) this.fail(new MqttError('socket', 'websocket error'));
      };
      ws.onclose = () => {
        if (this.ws === ws) this.fail(new MqttError('closed', 'websocket closed'));
      };
    });
  }

  write(bytes) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(bytes);
      this.lastTx = this.now();
      return true;
    } catch {
      return false;
    }
  }

  handle(p) {
    if (p.type === T.CONNACK) {
      const code = p.body[1];
      if (code === 0) {
        this.state = 'open';
        this.startPing();
        this.connectWait?.resolve();
      } else this.fail(new MqttError('refused', `connack ${CONNACK_TEXT[code] || code}`));
      this.connectWait = null;
    } else if (p.type === T.SUBACK) {
      const id = (p.body[0] << 8) | p.body[1];
      const w = this.waits.get(id);
      if (!w) return;
      this.waits.delete(id);
      if (p.body[2] === 0x80 || p.body.length < 3) w.reject(new MqttError('refused', 'suback refused'));
      else w.resolve();
    } else if (p.type === T.PUBLISH) {
      const m = parsePublish(p);
      if (m.qos === 1) this.write(packet(T.PUBACK, 0, Uint8Array.of(m.id >> 8, m.id & 0xff)));
      // QoS 2 no se pide nunca (se suscribe con QoS 0): un broker que lo manda igual se ignora
      if (m.qos < 2) this.onMessage?.(m.topic, m.payload);
    }
    // PINGRESP, UNSUBACK y lo demas solo cuentan como señal de vida (lastRx)
  }

  startPing() {
    const every = Math.max(1000, this.keepAlive * 750);
    this.pingTimer = this.timers.setInterval(() => {
      if (this.state !== 'open') return;
      if (this.now() - this.lastRx > this.keepAlive * 1500) {
        this.fail(new MqttError('timeout', 'keepalive'));
        return;
      }
      if (this.now() - this.lastTx >= every) this.write(PINGREQ);
    }, Math.min(every, 5000));
  }

  subscribe(topic) {
    if (this.state !== 'open') return Promise.reject(new MqttError('state'));
    const id = this.nextId++ & 0xffff || 1;
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.waits.delete(id);
        reject(new MqttError('timeout', 'subscribe timeout'));
      }, this.connectTimeout);
      this.waits.set(id, {
        resolve: () => {
          this.timers.clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          this.timers.clearTimeout(timer);
          reject(err);
        },
      });
      if (!this.write(subscribePacket(id, [topic]))) {
        this.timers.clearTimeout(timer);
        this.waits.delete(id);
        reject(new MqttError('state'));
      }
    });
  }

  publish(topic, payload) {
    if (this.state !== 'open') return false;
    return this.write(publishPacket(topic, payload));
  }

  get open() {
    return this.state === 'open';
  }

  // Cierre propio: no avisa por onClose
  close() {
    if (this.state === 'closed') return;
    if (this.state === 'open') this.write(DISCONNECT);
    this.teardown(null, false);
  }

  fail(err) {
    if (this.state === 'closed') return;
    this.teardown(err, true);
  }

  teardown(err, notify) {
    this.state = 'closed';
    this.timers.clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ya cerrado */
      }
    }
    const failure = err || new MqttError('closed');
    this.connectWait?.reject(failure);
    this.connectWait = null;
    for (const w of this.waits.values()) w.reject(failure);
    this.waits.clear();
    if (notify) this.onClose?.(failure);
  }
}
