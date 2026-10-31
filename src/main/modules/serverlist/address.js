'use strict';
// Direcciones de servidores: "host", "host:puerto", "1.2.3.4", "[2001:db8::1]:25565" o IPv6 sin corchetes.
// Devuelve { host, port, explicitPort, ipVersion, key, display } o null si no es valida.
const net = require('net');
const { domainToASCII } = require('url');

const DEFAULT_PORT = 25565;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

function parseAddress(input) {
  let s = String(input ?? '').trim();
  s = s.replace(/^minecraft:\/\//i, '').replace(/\/+$/, '').trim();
  if (!s || s.length > 300 || /\s/.test(s)) return null;
  let host;
  let port = null;
  const bracket = s.match(/^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/);
  if (bracket) {
    host = bracket[1];
    if (bracket[2]) port = Number(bracket[2]);
  } else if ((s.match(/:/g) || []).length > 1) {
    host = s; // IPv6 sin corchetes: no puede llevar puerto
  } else {
    const i = s.lastIndexOf(':');
    if (i >= 0) {
      const p = s.slice(i + 1);
      if (!/^\d{1,5}$/.test(p)) return null;
      host = s.slice(0, i);
      port = Number(p);
    } else {
      host = s;
    }
  }
  host = host.replace(/\.$/, '');
  if (!host) return null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  const ipVersion = net.isIP(host);
  if (!ipVersion) {
    const ascii = domainToASCII(host.toLowerCase());
    if (!ascii || !HOST_RE.test(ascii)) return null;
    host = ascii;
  } else if (ipVersion === 6) {
    host = host.toLowerCase();
  }
  const finalPort = port ?? DEFAULT_PORT;
  const hostPart = ipVersion === 6 ? `[${host}]` : host;
  return {
    host,
    port: finalPort,
    explicitPort: port !== null,
    ipVersion,
    key: `${hostPart}:${finalPort}`,
    display: finalPort === DEFAULT_PORT ? host : `${hostPart}:${finalPort}`,
  };
}

// Clave para comparar direcciones guardadas ("Play.Server.net" == "play.server.net:25565")
function addressKey(input) {
  const a = parseAddress(input);
  return a ? a.key : String(input || '').trim().toLowerCase();
}

module.exports = { parseAddress, addressKey, DEFAULT_PORT };
