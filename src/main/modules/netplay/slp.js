'use strict';
// Server List Ping de Minecraft (1.7+): sirve para comprobar que una dirección pública (túnel o puerto abierto)
// llega de verdad al servidor. Devuelve versión, jugadores, MOTD y latencia.
const net = require('net');
const dns = require('dns');

function writeVarInt(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return Buffer.from(out);
}

// { value, size } o null si faltan bytes
function readVarInt(buf, offset = 0) {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= buf.length) return null;
    const byte = buf[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if (size > 5) throw new Error('VarInt demasiado largo');
    if ((byte & 0x80) === 0) break;
  }
  return { value, size };
}

function packet(id, ...parts) {
  const body = Buffer.concat([writeVarInt(id), ...parts]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function mcString(s) {
  const b = Buffer.from(String(s), 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

// Texto plano de un componente de chat (MOTD)
function flatten(c) {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c.replace(/§./g, '');
  if (Array.isArray(c)) return c.map(flatten).join('');
  return `${flatten(c.text ?? '')}${(c.extra || []).map(flatten).join('')}`;
}

function parseAddress(address, defaultPort = 25565) {
  const s = String(address || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const m = /^\[?([^\]]+?)\]?(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  const host = m[1];
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!host || !(port > 0 && port < 65536)) return null;
  return { host, port, explicitPort: Boolean(m[2]) };
}

// Como el cliente de Minecraft: sin puerto explicito se busca el registro SRV _minecraft._tcp.<host>
// (lo usan playit.gg y muchos dominios de servidores).
async function resolveTarget(address) {
  const a = typeof address === 'string' ? parseAddress(address) : address;
  if (!a) return null;
  if (!a.explicitPort && !net.isIP(a.host)) {
    try {
      const recs = await dns.promises.resolveSrv(`_minecraft._tcp.${a.host}`);
      if (recs?.length) {
        recs.sort((x, y) => x.priority - y.priority || y.weight - x.weight);
        return { host: recs[0].name.replace(/\.$/, ''), port: recs[0].port, srv: true, original: a.host };
      }
    } catch {
      /* sin registro SRV */
    }
  }
  return { host: a.host, port: a.port, srv: false, original: a.host };
}

function ping(host, port = 25565, { timeout = 7000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let done = false;
    let sentAt = 0;
    const finish = (err, data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(data);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeout);
    sock.on('error', (err) => finish(err));
    sock.on('close', () => finish(Object.assign(new Error('closed'), { code: 'ECONNRESET' })));
    sock.on('connect', () => {
      sock.setNoDelay(true);
      sentAt = Date.now();
      sock.write(Buffer.concat([packet(0x00, writeVarInt(-1), mcString(host), u16(port), writeVarInt(1)), packet(0x00)]));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 1024 * 1024) return finish(new Error('Respuesta demasiado grande'));
      try {
        const len = readVarInt(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        const body = buf.subarray(len.size, len.size + len.value);
        const id = readVarInt(body, 0);
        if (!id || id.value !== 0) return finish(new Error('Respuesta inesperada'));
        const strLen = readVarInt(body, id.size);
        const start = id.size + strLen.size;
        const json = JSON.parse(body.subarray(start, start + strLen.value).toString('utf8'));
        finish(null, {
          latency: Date.now() - (sentAt || started),
          version: json.version?.name || null,
          protocol: json.version?.protocol ?? null,
          players: { online: json.players?.online ?? 0, max: json.players?.max ?? 0 },
          motd: flatten(json.description).trim().slice(0, 200),
        });
      } catch (err) {
        finish(err);
      }
    });
  });
}

module.exports = { ping, parseAddress, resolveTarget, writeVarInt, readVarInt, packet, mcString };
