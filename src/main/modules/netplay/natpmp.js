'use strict';
// NAT-PMP (RFC 6886) y PCP (RFC 6887): alternativa a UPnP para abrir puertos, por UDP 5351 a la puerta de enlace.
// PCP es el sucesor de NAT-PMP; si el router solo entiende NAT-PMP responde "version no soportada" y se usa NAT-PMP.
const dgram = require('dgram');
const crypto = require('crypto');
const netinfo = require('./netinfo');

const PORT = 5351;
const NATPMP_OP = { UDP: 1, TCP: 2 };
const PCP_PROTO = { TCP: 6, UDP: 17 };
const PCP_MAP = 1;
const PCP_ANNOUNCE = 0;

const NATPMP_RESULTS = { 1: 'UnsupportedVersion', 2: 'NotAuthorized', 3: 'NetworkFailure', 4: 'OutOfResources', 5: 'UnsupportedOpcode' };
const PCP_RESULTS = {
  1: 'UNSUPP_VERSION',
  2: 'NOT_AUTHORIZED',
  3: 'MALFORMED_REQUEST',
  4: 'UNSUPP_OPCODE',
  5: 'UNSUPP_OPTION',
  6: 'MALFORMED_OPTION',
  7: 'NETWORK_FAILURE',
  8: 'NO_RESOURCES',
  9: 'UNSUPP_PROTOCOL',
  10: 'USER_EX_QUOTA',
  11: 'CANNOT_PROVIDE_EXTERNAL',
  12: 'ADDRESS_MISMATCH',
  13: 'EXCESSIVE_REMOTE_PEERS',
};

class PortMapError extends Error {
  constructor(method, code, name) {
    super(`${method} ${code} ${name || ''}`.trim());
    this.method = method;
    this.code = code;
    this.codeName = name || '';
  }
}

// Envia `buf` a la puerta de enlace con reintentos (250 ms, 500 ms, 1 s...) hasta recibir una respuesta aceptada.
function exchange(gateway, buf, { tries = 4, initial = 250, accept = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let timer = null;
    let attempt = 0;
    let done = false;
    const finish = (err, msg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* ya cerrado */
      }
      if (err) reject(err);
      else resolve(msg);
    };
    sock.on('error', (err) => finish(err));
    sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== gateway || rinfo.port !== PORT) return;
      if (accept(msg)) finish(null, msg);
    });
    const send = () => {
      if (attempt >= tries) {
        finish(Object.assign(new Error('Sin respuesta del router (NAT-PMP/PCP)'), { timeout: true }));
        return;
      }
      sock.send(buf, PORT, gateway, () => {});
      timer = setTimeout(send, initial * 2 ** attempt);
      attempt++;
    };
    sock.bind(0, send);
  });
}

// ---------- NAT-PMP ----------

async function natpmpExternalIp(gateway, opts) {
  const msg = await exchange(gateway, Buffer.from([0, 0]), { ...opts, accept: (m) => m.length >= 8 && m[0] === 0 && m[1] === 128 });
  const result = msg.readUInt16BE(2);
  if (result !== 0) throw new PortMapError('NAT-PMP', result, NATPMP_RESULTS[result]);
  if (msg.length < 12) throw new Error('Respuesta NAT-PMP incompleta');
  return `${msg[8]}.${msg[9]}.${msg[10]}.${msg[11]}`;
}

// lifetime 0 = borrar el mapeo
async function natpmpMap(gateway, { protocol = 'TCP', internalPort, externalPort = internalPort, lifetime = 3600 }, opts) {
  const op = NATPMP_OP[protocol];
  const buf = Buffer.alloc(12);
  buf[0] = 0;
  buf[1] = op;
  buf.writeUInt16BE(internalPort, 4);
  buf.writeUInt16BE(lifetime === 0 ? 0 : externalPort, 6);
  buf.writeUInt32BE(lifetime, 8);
  const msg = await exchange(gateway, buf, { ...opts, accept: (m) => m.length >= 8 && m[0] === 0 && m[1] === 128 + op });
  const result = msg.readUInt16BE(2);
  if (result !== 0) throw new PortMapError('NAT-PMP', result, NATPMP_RESULTS[result]);
  if (msg.length < 16) throw new Error('Respuesta NAT-PMP incompleta');
  return { internalPort: msg.readUInt16BE(8), externalPort: msg.readUInt16BE(10), lifetime: msg.readUInt32BE(12) };
}

// ---------- PCP ----------

function v4mapped(ip) {
  const out = Buffer.alloc(16);
  out[10] = 0xff;
  out[11] = 0xff;
  const parts = String(ip || '0.0.0.0').split('.').map(Number);
  for (let i = 0; i < 4; i++) out[12 + i] = parts[i] || 0;
  return out;
}

function pcpHeader(opcode, lifetime, clientIp, payloadLen) {
  const buf = Buffer.alloc(24 + payloadLen);
  buf[0] = 2;
  buf[1] = opcode & 0x7f;
  buf.writeUInt32BE(lifetime >>> 0, 4);
  v4mapped(clientIp).copy(buf, 8);
  return buf;
}

// Un servidor solo NAT-PMP contesta con version 0 y codigo 1 ("version no soportada")
function isNatpmpReply(m) {
  return m.length >= 4 && m[0] === 0;
}

async function pcpAnnounce(gateway, clientIp, opts) {
  const buf = pcpHeader(PCP_ANNOUNCE, 0, clientIp, 0);
  const msg = await exchange(gateway, buf, { tries: 3, ...opts, accept: (m) => isNatpmpReply(m) || (m.length >= 24 && m[0] === 2 && m[1] === (0x80 | PCP_ANNOUNCE)) });
  if (isNatpmpReply(msg)) return { pcp: false, natpmp: true };
  return { pcp: msg[3] === 0, natpmp: false, result: msg[3] };
}

async function pcpMap(gateway, { clientIp, protocol = 'TCP', internalPort, externalPort = internalPort, lifetime = 3600, nonce }, opts) {
  const buf = pcpHeader(PCP_MAP, lifetime, clientIp, 36);
  const n = nonce || crypto.randomBytes(12);
  n.copy(buf, 24);
  buf[36] = PCP_PROTO[protocol];
  buf.writeUInt16BE(internalPort, 40);
  buf.writeUInt16BE(lifetime === 0 ? 0 : externalPort, 42);
  v4mapped('0.0.0.0').copy(buf, 44);
  const msg = await exchange(gateway, buf, {
    ...opts,
    accept: (m) => isNatpmpReply(m) || (m.length >= 60 && m[0] === 2 && m[1] === (0x80 | PCP_MAP) && m.subarray(24, 36).equals(n)),
  });
  if (isNatpmpReply(msg)) throw Object.assign(new PortMapError('PCP', 1, 'UNSUPP_VERSION'), { natpmpOnly: true });
  const result = msg[3];
  if (result !== 0) throw new PortMapError('PCP', result, PCP_RESULTS[result]);
  return {
    nonce: n,
    lifetime: msg.readUInt32BE(4),
    internalPort: msg.readUInt16BE(40),
    externalPort: msg.readUInt16BE(42),
    externalIp: `${msg[56]}.${msg[57]}.${msg[58]}.${msg[59]}`,
  };
}

// ---------- Interfaz comun ----------

// Detecta si la puerta de enlace habla PCP o NAT-PMP. Devuelve { method: 'pcp'|'natpmp', gateway, clientIp, externalIp } o null.
async function probe(gateway, { clientIp } = {}) {
  if (!netinfo.isIPv4(gateway)) return null;
  const local = clientIp || (await netinfo.localAddressFor(gateway, PORT));
  if (!local) return null;
  // NAT-PMP primero: es el mas comun y ademas devuelve la IP externa
  try {
    const externalIp = await natpmpExternalIp(gateway, { tries: 3 });
    // Algunos routers (miniupnpd) soportan ambos: preferir PCP si responde bien
    try {
      const a = await pcpAnnounce(gateway, local, { tries: 2 });
      if (a.pcp) return { method: 'pcp', gateway, clientIp: local, externalIp };
    } catch {
      /* solo NAT-PMP */
    }
    return { method: 'natpmp', gateway, clientIp: local, externalIp };
  } catch (err) {
    if (!err.timeout && !(err instanceof PortMapError)) return null;
  }
  try {
    const a = await pcpAnnounce(gateway, local, { tries: 2 });
    if (a.pcp) return { method: 'pcp', gateway, clientIp: local, externalIp: null };
  } catch {
    /* sin PCP */
  }
  return null;
}

// Abre (o renueva) un puerto. Devuelve { externalPort, lifetime, externalIp, nonce }
async function map(info, { protocol, internalPort, externalPort, lifetime = 3600, nonce }) {
  if (info.method === 'pcp') {
    try {
      const r = await pcpMap(info.gateway, { clientIp: info.clientIp, protocol, internalPort, externalPort, lifetime, nonce });
      return { externalPort: r.externalPort, lifetime: r.lifetime, externalIp: r.externalIp, nonce: r.nonce };
    } catch (err) {
      if (!err.natpmpOnly) throw err;
      info.method = 'natpmp';
    }
  }
  const r = await natpmpMap(info.gateway, { protocol, internalPort, externalPort, lifetime });
  return { externalPort: r.externalPort, lifetime: r.lifetime, externalIp: info.externalIp || null, nonce: null };
}

async function unmap(info, { protocol, internalPort, nonce }) {
  if (info.method === 'pcp' && nonce) {
    await pcpMap(info.gateway, { clientIp: info.clientIp, protocol, internalPort, externalPort: 0, lifetime: 0, nonce }, { tries: 3 });
    return;
  }
  await natpmpMap(info.gateway, { protocol, internalPort, externalPort: 0, lifetime: 0 }, { tries: 3 });
}

module.exports = { probe, map, unmap, natpmpExternalIp, natpmpMap, pcpMap, pcpAnnounce, PortMapError, PORT };
