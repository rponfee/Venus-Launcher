'use strict';
// Red local: direcciones de la PC, puerta de enlace, IP pública y detección de CGNAT / doble NAT.
// Sin dependencias de Electron (se puede probar con Node puro).
const os = require('os');
const dgram = require('dgram');
const fsp = require('fs/promises');
const { execFile } = require('child_process');

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipToInt(ip) {
  const m = IPV4.exec(String(ip || '').trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function inRange(ip, base, bits) {
  const a = ipToInt(ip);
  const b = ipToInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

const isIPv4 = (ip) => ipToInt(ip) !== null;
const isPrivate = (ip) => inRange(ip, '10.0.0.0', 8) || inRange(ip, '172.16.0.0', 12) || inRange(ip, '192.168.0.0', 16);
const isCgnatRange = (ip) => inRange(ip, '100.64.0.0', 10);
const isLinkLocal = (ip) => inRange(ip, '169.254.0.0', 16);
const isLoopback = (ip) => inRange(ip, '127.0.0.0', 8);

function isPublic(ip) {
  return isIPv4(ip) && !isPrivate(ip) && !isCgnatRange(ip) && !isLinkLocal(ip) && !isLoopback(ip) && !inRange(ip, '0.0.0.0', 8) && !inRange(ip, '224.0.0.0', 3);
}

// Adaptadores que no son la red de la casa: VPN para jugar (Radmin, Hamachi, ZeroTier, Tailscale...) o virtuales.
const VPN_RE = /hamachi|radmin|zerotier|tailscale|wireguard|openvpn|nordlynx|proton|mullvad|wintun|tap-windows|\bvpn\b/i;
const VIRTUAL_RE = /virtualbox|vbox|vmware|vmnet|hyper-v|vethernet|\bwsl\b|docker|default switch|npcap|bluetooth|loopback|\bveth|\bbr-|virbr/i;

function interfaceKind(name, address) {
  if (VPN_RE.test(name) || inRange(address, '25.0.0.0', 8) || inRange(address, '26.0.0.0', 8) || isCgnatRange(address)) return 'vpn';
  if (VIRTUAL_RE.test(name)) return 'virtual';
  return 'lan';
}

// Interfaces IPv4 utiles (sin loopback ni link-local).
function localInterfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || isLinkLocal(a.address) || isLoopback(a.address)) continue;
      out.push({ name, address: a.address, netmask: a.netmask, kind: interfaceKind(name, a.address) });
    }
  }
  return out;
}

// Direccion local que el sistema usaria para llegar a `remote` (no manda paquetes: UDP connect solo elige la ruta).
function localAddressFor(remote, port = 9) {
  return new Promise((resolve) => {
    let sock;
    const done = (v) => {
      try {
        sock.close();
      } catch {
        /* ya cerrado */
      }
      resolve(v);
    };
    try {
      sock = dgram.createSocket('udp4');
      sock.on('error', () => done(null));
      sock.connect(port, remote, () => {
        try {
          const a = sock.address().address;
          done(isIPv4(a) && a !== '0.0.0.0' ? a : null);
        } catch {
          done(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout, encoding: 'latin1', maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
  });
}

// "route print -4 0.0.0.0" (los encabezados cambian con el idioma de Windows, los numeros no)
function parseWindowsRoute(text) {
  let best = null;
  const re = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)/gm;
  let m;
  while ((m = re.exec(text))) {
    const metric = Number(m[3]);
    if (!best || metric < best.metric) best = { gateway: m[1], interface: m[2], metric };
  }
  return best;
}

// /proc/net/route (Linux): destino 00000000 = ruta por defecto; direcciones en hexadecimal little-endian
function parseProcRoute(text) {
  let best = null;
  for (const line of String(text).split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8 || cols[1] !== '00000000' || cols[7] !== '00000000') continue;
    const hex = cols[2];
    if (!/^[0-9a-f]{8}$/i.test(hex)) continue;
    const bytes = Buffer.from(hex, 'hex');
    const gateway = `${bytes[3]}.${bytes[2]}.${bytes[1]}.${bytes[0]}`;
    const metric = Number(cols[6]) || 0;
    if (gateway !== '0.0.0.0' && (!best || metric < best.metric)) best = { gateway, iface: cols[0], metric };
  }
  return best;
}

let gwCache = null;

// Puerta de enlace por defecto: { gateway, interface, guessed }
async function defaultGateway({ force = false } = {}) {
  if (!force && gwCache && Date.now() - gwCache.at < 60000) return gwCache.value;
  let found = null;
  try {
    if (process.platform === 'win32') found = parseWindowsRoute(await run('route', ['print', '-4', '0.0.0.0']));
    else if (process.platform === 'linux') {
      const r = parseProcRoute(await fsp.readFile('/proc/net/route', 'utf8'));
      if (r) {
        const ifaceAddr = (os.networkInterfaces()[r.iface] || []).find((a) => a.family === 'IPv4' || a.family === 4)?.address || null;
        found = { gateway: r.gateway, interface: ifaceAddr };
      }
    } else if (process.platform === 'darwin') {
      const m = /gateway:\s*(\d{1,3}(?:\.\d{1,3}){3})/.exec(await run('route', ['-n', 'get', 'default']));
      if (m) found = { gateway: m[1], interface: null };
    }
  } catch {
    found = null;
  }
  let value = null;
  if (found && isIPv4(found.gateway)) value = { gateway: found.gateway, interface: found.interface || null, guessed: false };
  else {
    // Sin tabla de rutas: suponer x.y.z.1 de la red principal
    const primary = await primaryAddress();
    if (primary) value = { gateway: primary.replace(/\.\d+$/, '.1'), interface: primary, guessed: true };
  }
  gwCache = { at: Date.now(), value };
  return value;
}

// IP local principal (la que sale a internet).
async function primaryAddress() {
  const viaRoute = await localAddressFor('1.1.1.1', 53);
  if (viaRoute) return viaRoute;
  const lan = localInterfaces().find((i) => i.kind === 'lan');
  return lan ? lan.address : null;
}

// ---------- IP publica ----------
const PUBLIC_IP_SOURCES = [
  { url: 'https://api.ipify.org?format=json', json: true },
  { url: 'https://ipv4.icanhazip.com', json: false },
  { url: 'https://checkip.amazonaws.com', json: false },
];
let pubCache = null;
let pubPending = null;

function userAgent() {
  try {
    return require('../../core/http').getUserAgent();
  } catch {
    return 'VenusLauncher';
  }
}

async function fetchPublicIp() {
  for (const src of PUBLIC_IP_SOURCES) {
    try {
      const res = await fetch(src.url, { headers: { 'User-Agent': userAgent(), Accept: src.json ? 'application/json' : 'text/plain' }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const ip = src.json ? (await res.json())?.ip : (await res.text()).trim();
      if (isIPv4(ip)) return { ip, source: new URL(src.url).hostname };
    } catch {
      /* probar la siguiente fuente */
    }
  }
  return null;
}

async function publicIp({ force = false } = {}) {
  if (!force && pubCache && Date.now() - pubCache.at < 5 * 60000) return pubCache.value;
  if (!pubPending) {
    pubPending = fetchPublicIp()
      .then((value) => {
        // Si falla, recordar el fallo poco tiempo para no insistir en cada pedido
        pubCache = { at: value ? Date.now() : Date.now() - 4 * 60000, value };
        return value;
      })
      .finally(() => {
        pubPending = null;
      });
  }
  return pubPending;
}

// Estimacion de CGNAT / doble NAT. Devuelve { cgnat: true|false|null, reason }
//  - IP externa del router en 100.64.0.0/10 -> CGNAT del proveedor
//  - IP externa del router privada -> doble NAT (router detras de otro router/modem)
//  - IP externa del router distinta de la IP publica -> hay otro NAT en el medio
function cgnatGuess({ publicIp: pub = null, routerExternalIp = null } = {}) {
  if (routerExternalIp && isIPv4(routerExternalIp)) {
    if (isCgnatRange(routerExternalIp)) return { cgnat: true, reason: 'cgnatRange' };
    if (isPrivate(routerExternalIp)) return { cgnat: true, reason: 'doubleNat' };
    if (pub && isIPv4(pub) && pub !== routerExternalIp) return { cgnat: true, reason: 'mismatch' };
    if (routerExternalIp === '0.0.0.0') return { cgnat: null, reason: 'unknown' };
    return { cgnat: false, reason: 'match' };
  }
  if (pub && isCgnatRange(pub)) return { cgnat: true, reason: 'cgnatRange' };
  return { cgnat: null, reason: 'unknown' };
}

module.exports = {
  ipToInt,
  inRange,
  isIPv4,
  isPrivate,
  isCgnatRange,
  isLinkLocal,
  isPublic,
  interfaceKind,
  localInterfaces,
  localAddressFor,
  primaryAddress,
  defaultGateway,
  parseWindowsRoute,
  parseProcRoute,
  publicIp,
  cgnatGuess,
};
