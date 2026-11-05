// Cliente MQTT del respaldo: bytes exactos del protocolo, paquetes partidos o pegados, y el cliente contra
// (1) un broker en memoria y (2) un broker de mentira real por un socket local, escrito aparte (sin usar mqtt.js)
// para que un error de codificacion no pase por estar de los dos lados.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { encodeLength, str, connectPacket, subscribePacket, publishPacket, PINGREQ, DISCONNECT, PacketReader, parsePublish, packet, T, MqttClient, MAX_PACKET } from '../mqtt.js';
import { FakeBrokers, manualClock, settle } from './fake-net.js';

const hex = (b) => Buffer.from(b).toString('hex');
const u8 = (...a) => Uint8Array.from(a);

test('largo restante: limites de 1 a 4 bytes', () => {
  assert.equal(hex(encodeLength(0)), '00');
  assert.equal(hex(encodeLength(127)), '7f');
  assert.equal(hex(encodeLength(128)), '8001');
  assert.equal(hex(encodeLength(16383)), 'ff7f');
  assert.equal(hex(encodeLength(16384)), '808001');
  assert.equal(hex(encodeLength(2097151)), 'ffff7f');
  assert.equal(hex(encodeLength(2097152)), '80808001');
  assert.equal(hex(encodeLength(268435455)), 'ffffff7f');
  assert.throws(() => encodeLength(268435456), RangeError);
  assert.throws(() => encodeLength(-1), RangeError);
});

test('bytes exactos de CONNECT, SUBSCRIBE, PUBLISH, PINGREQ y DISCONNECT (MQTT 3.1.1)', () => {
  // CONNECT con clientId "a", clean session, keepalive 30 s
  assert.equal(hex(connectPacket({ clientId: 'a', keepAlive: 30 })), '100d00044d5154540402001e000161');
  // Con usuario y clave (flags 0xC2): lo que piden los brokers con credenciales abiertas
  assert.equal(hex(connectPacket({ clientId: 'a', keepAlive: 30, username: 'u', password: 'p' })), '101300044d51545404c2001e000161000175000170');
  // SUBSCRIBE id 1, tema "t", QoS 0: el tipo 8 lleva los flags 0010
  assert.equal(hex(subscribePacket(1, ['t'])), '8206000100017400');
  // PUBLISH QoS 0 sin retencion: tema "t" y payload 0x01 0x02
  assert.equal(hex(publishPacket('t', u8(1, 2))), '300500017401' + '02');
  assert.equal(hex(PINGREQ), 'c000');
  assert.equal(hex(DISCONNECT), 'e000');
  assert.equal(hex(str('é')), '0002c3a9'); // UTF-8, largo en bytes
});

test('PacketReader: paquetes pegados, partidos en cualquier punto y largo de varios bytes', () => {
  const big = new Uint8Array(300).fill(9);
  const wire = Buffer.concat([publishPacket('a/b', u8(1, 2, 3)), PINGREQ, publishPacket('tema', big)]);
  for (const cut of [1, 2, 3, 7, 50, wire.length - 1]) {
    const r = new PacketReader();
    const got = [...r.push(wire.subarray(0, cut)), ...r.push(wire.subarray(cut))];
    assert.equal(got.length, 3, `cortado en ${cut}`);
    assert.equal(parsePublish(got[0]).topic, 'a/b');
    assert.deepEqual([...parsePublish(got[0]).payload], [1, 2, 3]);
    assert.equal(got[1].type, T.PINGREQ);
    assert.equal(parsePublish(got[2]).payload.length, 300);
  }
  // byte por byte
  const slow = new PacketReader();
  let n = 0;
  for (const b of wire) n += slow.push(Uint8Array.of(b)).length;
  assert.equal(n, 3);
});

test('PacketReader: rechaza lo malformado o demasiado grande', () => {
  assert.throws(() => new PacketReader().push(u8(0x30, 0x80, 0x80, 0x80, 0x80, 0x01)), /malformed/);
  assert.throws(() => new PacketReader(100).push(Uint8Array.of(0x30, ...encodeLength(101))), /too large/);
  assert.ok(MAX_PACKET >= 256 * 1024);
  assert.throws(() => parsePublish({ flags: 0, body: u8(0, 9, 1) }), /malformed/);
  // un PUBLISH QoS 1 trae id de paquete
  const q1 = parsePublish({ flags: 2, body: Uint8Array.of(0, 1, 0x74, 0x12, 0x34, 0xaa) });
  assert.deepEqual({ ...q1, payload: [...q1.payload] }, { topic: 't', payload: [0xaa], qos: 1, id: 0x1234 });
});

test('cliente contra el broker en memoria: conectar, suscribir, publicar y recibir', async () => {
  const brokers = new FakeBrokers();
  const url = 'wss://uno.test/mqtt';
  const a = new MqttClient({ url, clientId: 'a', WebSocketCtor: brokers.WebSocket });
  const b = new MqttClient({ url, clientId: 'b', WebSocketCtor: brokers.WebSocket });
  await a.connect();
  await b.connect();
  await a.subscribe('sala/1');
  const got = [];
  a.onMessage = (topic, bytes) => got.push([topic, [...bytes]]);
  assert.equal(b.publish('sala/1', u8(5, 6, 7)), true);
  assert.equal(b.publish('otra', u8(9)), true); // a no esta suscripto
  await settle();
  assert.deepEqual(got, [['sala/1', [5, 6, 7]]]);
  a.close();
  b.close();
  assert.equal(a.publish('sala/1', u8(1)), false); // cerrado: no publica
});

test('un payload de 100 KB viaja entero', async () => {
  const brokers = new FakeBrokers();
  const a = new MqttClient({ url: 'wss://x.test', clientId: 'a', WebSocketCtor: brokers.WebSocket });
  await a.connect();
  await a.subscribe('t');
  const got = new Promise((res) => (a.onMessage = (_t, bytes) => res(bytes)));
  const payload = crypto.randomBytes(100 * 1024);
  a.publish('t', payload);
  assert.deepEqual(Buffer.from(await got), payload);
  a.close();
});

test('un broker caido o que corta la conexion se nota (onClose y promesas rechazadas)', async () => {
  const brokers = new FakeBrokers();
  brokers.mode('wss://caido.test', 'down');
  const c = new MqttClient({ url: 'wss://caido.test', clientId: 'c', WebSocketCtor: brokers.WebSocket });
  await assert.rejects(c.connect(), (e) => e.code === 'socket' || e.code === 'closed');

  const a = new MqttClient({ url: 'wss://ok.test', clientId: 'a', WebSocketCtor: brokers.WebSocket });
  let closed = null;
  a.onClose = (err) => (closed = err);
  await a.connect();
  brokers.cut('wss://ok.test');
  await settle();
  assert.ok(closed, 'avisa el cierre');
  assert.equal(a.open, false);
  await assert.rejects(a.subscribe('t'), (e) => e.code === 'state');
});

test('tiempo de espera de conexion y de keepalive', async () => {
  const clock = manualClock();
  // Un WebSocket que nunca abre
  class Mudo {
    constructor() {
      this.readyState = 0;
    }
    send() {}
    close() {}
  }
  const c = new MqttClient({ url: 'wss://mudo.test', clientId: 'c', WebSocketCtor: Mudo, timers: clock, now: clock.now, connectTimeout: 5000 });
  const p = c.connect();
  p.catch(() => {});
  await clock.advance(5200);
  await assert.rejects(p, (e) => e.code === 'timeout');

  // Conectado pero el broker deja de contestar: despues de 1,5 x keepalive se corta
  const brokers = new FakeBrokers();
  const a = new MqttClient({ url: 'wss://k.test', clientId: 'a', keepAlive: 10, WebSocketCtor: brokers.WebSocket, timers: clock, now: clock.now });
  let closed = null;
  a.onClose = (err) => (closed = err);
  const pa = a.connect();
  await clock.advance(200);
  await pa;
  brokers.mode('wss://k.test', 'deaf'); // sigue conectado pero ya no contesta nada (ni el PINGRESP)
  await clock.advance(20000);
  assert.ok(closed && closed.code === 'timeout', 'keepalive vencido');
});

test('CONNACK rechazado: el cliente lo informa', async () => {
  class Rechaza {
    constructor() {
      this.readyState = 0;
      setImmediate(() => {
        this.readyState = 1;
        this.onopen?.({});
      });
    }
    send() {
      setImmediate(() => this.onmessage?.({ data: packet(T.CONNACK, 0, Uint8Array.of(0, 5)).buffer }));
    }
    close() {}
  }
  const c = new MqttClient({ url: 'wss://r.test', clientId: 'c', WebSocketCtor: Rechaza });
  await assert.rejects(c.connect(), (e) => e.code === 'refused');
});

// ---------- Broker de mentira real, escrito aparte ----------
// Servidor HTTP con upgrade a WebSocket (RFC 6455) y un MQTT minimo parseado a mano. El cliente es el WebSocket global
// de Node, el mismo tipo de objeto que usa el launcher.
function miniBroker() {
  const subs = new Map(); // tema -> Set(socket)
  const seen = { protocols: [], connects: [], publishes: 0 };
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    seen.protocols.push(req.headers['sec-websocket-protocol']);
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: mqtt\r\n\r\n`);
    let buf = Buffer.alloc(0);
    let mqtt = Buffer.alloc(0);
    const sendWs = (payload) => {
      const head = payload.length < 126 ? Buffer.from([0x82, payload.length]) : payload.length < 65536 ? Buffer.from([0x82, 126, payload.length >> 8, payload.length & 255]) : (() => {
        const h = Buffer.alloc(10);
        h[0] = 0x82;
        h[1] = 127;
        h.writeBigUInt64BE(BigInt(payload.length), 2);
        return h;
      })();
      socket.write(Buffer.concat([head, payload]));
    };
    const handleMqtt = (pkt) => {
      const type = pkt[0] >> 4;
      if (type === 1) {
        // CONNECT: saltear largo, protocolo y buscar el clientId
        let i = 1;
        while (pkt[i] & 0x80) i++;
        i++;
        const nameLen = pkt.readUInt16BE(i);
        const level = pkt[i + 2 + nameLen];
        const flags = pkt[i + 3 + nameLen];
        const idAt = i + 2 + nameLen + 1 + 1 + 2;
        const idLen = pkt.readUInt16BE(idAt);
        seen.connects.push({ level, flags, clientId: pkt.subarray(idAt + 2, idAt + 2 + idLen).toString() });
        sendWs(Buffer.from([0x20, 2, 0, 0]));
      } else if (type === 8) {
        let i = 1;
        while (pkt[i] & 0x80) i++;
        i++;
        const id = pkt.subarray(i, i + 2);
        i += 2;
        const len = pkt.readUInt16BE(i);
        const topic = pkt.subarray(i + 2, i + 2 + len).toString();
        if (!subs.has(topic)) subs.set(topic, new Set());
        subs.get(topic).add(sendWs);
        sendWs(Buffer.from([0x90, 3, id[0], id[1], 0]));
      } else if (type === 3) {
        seen.publishes++;
        let i = 1;
        while (pkt[i] & 0x80) i++;
        i++;
        const len = pkt.readUInt16BE(i);
        const topic = pkt.subarray(i + 2, i + 2 + len).toString();
        for (const to of subs.get(topic) || []) to(pkt);
      } else if (type === 12) sendWs(Buffer.from([0xd0, 0]));
    };
    const takeMqtt = () => {
      for (;;) {
        if (mqtt.length < 2) return;
        let len = 0;
        let mul = 1;
        let i = 1;
        while (i < mqtt.length) {
          len += (mqtt[i] & 0x7f) * mul;
          mul *= 128;
          if (!(mqtt[i++] & 0x80)) break;
        }
        if (mqtt.length < i + len) return;
        handleMqtt(mqtt.subarray(0, i + len));
        mqtt = mqtt.subarray(i + len);
      }
    };
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let at = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          at = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          at = 10;
        }
        const masked = Boolean(buf[1] & 0x80);
        if (buf.length < at + (masked ? 4 : 0) + len) return;
        const mask = masked ? buf.subarray(at, at + 4) : null;
        const body = Buffer.from(buf.subarray(at + (masked ? 4 : 0), at + (masked ? 4 : 0) + len));
        if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        buf = buf.subarray(at + (masked ? 4 : 0) + len);
        if (op === 8) return socket.end();
        if (op === 2) {
          mqtt = Buffer.concat([mqtt, body]);
          takeMqtt();
        }
      }
    });
    socket.on('close', () => {
      for (const set of subs.values()) set.delete(sendWs);
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

test('contra un broker real por un socket local: subprotocolo mqtt, CONNECT, SUBSCRIBE y PUBLISH de 70 KB', async (t) => {
  assert.equal(typeof WebSocket, 'function', 'este Node trae WebSocket');
  const { server, port, seen } = await miniBroker();
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${port}/mqtt`;
  const a = new MqttClient({ url, clientId: 'vv-prueba-a', username: 'public', password: 'public' });
  const b = new MqttClient({ url, clientId: 'vv-prueba-b' });
  await a.connect();
  await b.connect();
  await a.subscribe('vv1/abc');
  const got = new Promise((res) => (a.onMessage = (topic, bytes) => res({ topic, bytes })));
  const payload = crypto.randomBytes(70 * 1024); // obliga a usar el largo de 2 bytes del marco WebSocket
  assert.equal(b.publish('vv1/abc', payload), true);
  const r = await got;
  assert.equal(r.topic, 'vv1/abc');
  assert.deepEqual(Buffer.from(r.bytes), payload);
  assert.deepEqual(seen.protocols, ['mqtt', 'mqtt']);
  assert.equal(seen.connects[0].level, 4, 'MQTT 3.1.1');
  assert.equal(seen.connects[0].flags, 0xc2, 'usuario, clave y clean session');
  assert.equal(seen.connects[1].flags, 0x02);
  assert.match(seen.connects[0].clientId, /^vv-prueba-a$/);
  a.close();
  b.close();
});
