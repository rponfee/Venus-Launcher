'use strict';
// Links venus://: parser puro, sin Electron. Todo lo que llega acá viene de afuera (un link de una página, de un
// chat, de otro programa): se valida con reglas estrictas y lo desconocido se ignora. Devuelve la acción a
// proponer o null; nunca hace nada por su cuenta. La interfaz siempre pide confirmación (features/instancelook).
//   venus://modpack/modrinth/<slug-o-id>[?version=<id>]  { kind: 'modpack', source: 'modrinth', project, version, link }
//   venus://modpack/curseforge/<id>                      { kind: 'modpack', source: 'curseforge', modId, link }
//   venus://server/<host[:puerto]>[?name=<nombre>]       { kind: 'server', host, port, address, name, lan, link }
//   venus://instance/<id>                                { kind: 'instance', id, link }
// Pruebas: node --test "src/main/modules/deeplink/test/"
const net = require('net');

const SCHEME = 'venus://';
const MAX_LINK = 512;
const MAX_NAME = 40;
// Lo único que puede tener un link después del esquema. Sin espacios, comillas, barras invertidas, @ ni #.
const LINK_CHARS = /^[A-Za-z0-9\-._~%/?=&:[\]+]+$/;
// Slug o id de Modrinth, sin puntos sueltos ni al final (nunca es una ruta).
const MODRINTH_PROJECT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/;
const MODRINTH_VERSION = /^[A-Za-z0-9]{4,16}$/;
const CURSEFORGE_ID = /^[1-9][0-9]{0,9}$/;
const MAX_CURSEFORGE_ID = 2147483647;
// Id de instancia: un solo segmento de ruta seguro (core/instances los genera con este alfabeto).
const INSTANCE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,78}[A-Za-z0-9_-])?$/;
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC = /^[0-9]+$/;
// Controles, marcas de dirección de texto (para que un nombre no se muestre al revés) y separadores invisibles.
const NAME_STRIP = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]', 'g');

function parseQuery(text) {
  const out = {};
  if (!text) return out;
  for (const part of text.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const key = i < 0 ? part : part.slice(0, i);
    if (!/^[a-z]{1,16}$/.test(key)) continue; // lo desconocido se ignora
    if (Object.prototype.hasOwnProperty.call(out, key)) return null; // un parámetro repetido no se adivina
    out[key] = i < 0 ? '' : part.slice(i + 1);
  }
  return out;
}

// Un nombre para mostrar: nunca se usa como otra cosa. Si está mal, el link sigue valiendo sin nombre.
function cleanName(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let text;
  try {
    text = decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return null;
  }
  const name = text.replace(/§./g, '').replace(NAME_STRIP, '').replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim();
  return name && Array.from(name).length <= MAX_NAME ? name : null;
}

function ipv4Parts(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!NUMERIC.test(p) || p.length > 3 || (p.length > 1 && p[0] === '0')) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

// undefined si no se puede usar; { lan } si sí (lan: dirección de una red privada, la interfaz lo avisa).
function classifyIpv4([a, b]) {
  if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) return undefined;
  return { lan: a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) };
}

function classifyIpv6(host) {
  if (host.includes('%') || net.isIP(host) !== 6) return undefined;
  const low = host.toLowerCase();
  if (low === '::' || low === '::1' || /^0*:(0*:)*0*1?$/.test(low)) return undefined; // sin especificar y loopback
  if (/^fe[89ab]/.test(low) || /^ff/.test(low)) return undefined; // enlace local y multicast
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
  if (v4) {
    const parts = ipv4Parts(v4[1]);
    return parts ? classifyIpv4(parts) : undefined;
  }
  return { lan: /^f[cd]/.test(low) };
}

// host[:puerto] -> { host, port, address, lan } o null. Reglas estrictas: nada de usuario, porcentajes, nombres de
// una sola palabra (localhost y nombres de la red), números disfrazados de IP ni direcciones del propio equipo.
function parseServer(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 262) return null;
  let host;
  let portText = null;
  let lan = false;
  if (raw[0] === '[') {
    const m = /^\[([0-9A-Fa-f:.]{2,45})\](?::([0-9]{1,5}))?$/.exec(raw);
    if (!m) return null;
    const kind = classifyIpv6(m[1]);
    if (!kind) return null;
    host = m[1].toLowerCase();
    portText = m[2] ?? null;
    lan = kind.lan;
  } else {
    const parts = raw.split(':');
    if (parts.length > 2) return null;
    host = parts[0].toLowerCase();
    portText = parts[1] ?? null;
    if (!host || host.length > 253) return null;
    const v4 = ipv4Parts(host);
    if (v4) {
      const kind = classifyIpv4(v4);
      if (!kind) return null;
      lan = kind.lan;
    } else {
      const labels = host.split('.');
      if (labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l))) return null;
      const last = labels[labels.length - 1];
      if (NUMERIC.test(last) || last === 'localhost') return null;
      lan = last === 'local' || last === 'lan';
    }
  }
  let port = null;
  if (portText !== null) {
    if (!NUMERIC.test(portText)) return null;
    port = Number(portText);
    if (port < 1 || port > 65535) return null;
  }
  const shown = host.includes(':') ? `[${host}]` : host;
  return { host, port, lan, address: port === null ? shown : `${shown}:${port}` };
}

function parseModpack(segments, query) {
  const [source, id, ...rest] = segments;
  if (rest.length) return null;
  if (source === 'modrinth') {
    if (!MODRINTH_PROJECT.test(id || '') || (id || '').includes('..')) return null;
    let version = null;
    if (query.version !== undefined) {
      if (!MODRINTH_VERSION.test(query.version)) return null;
      version = query.version;
    }
    return { kind: 'modpack', source, project: id, version, link: `${SCHEME}modpack/modrinth/${id}${version ? `?version=${version}` : ''}` };
  }
  if (source === 'curseforge') {
    if (!CURSEFORGE_ID.test(id || '')) return null;
    const modId = Number(id);
    if (modId > MAX_CURSEFORGE_ID) return null;
    return { kind: 'modpack', source, modId, link: `${SCHEME}modpack/curseforge/${modId}` };
  }
  return null;
}

function parseInstance(segments) {
  if (segments.length !== 1) return null;
  const [id] = segments;
  if (!INSTANCE_ID.test(id) || id.includes('..') || DEVICE_NAME.test(id)) return null;
  return { kind: 'instance', id, link: `${SCHEME}instance/${id}` };
}

function parseServerLink(segments, query) {
  if (segments.length !== 1) return null;
  const server = parseServer(segments[0]);
  if (!server) return null;
  const name = cleanName(query.name);
  return { kind: 'server', ...server, name, link: `${SCHEME}server/${server.address}${name ? `?name=${encodeURIComponent(name)}` : ''}` };
}

// Link -> acción o null. No usa URL(): con esquemas propios interpreta host y ruta de formas que no conviene heredar.
function parseLink(raw) {
  if (typeof raw !== 'string' || raw.length < SCHEME.length + 1 || raw.length > MAX_LINK) return null;
  if (raw.slice(0, SCHEME.length).toLowerCase() !== SCHEME) return null;
  const rest = raw.slice(SCHEME.length);
  if (!LINK_CHARS.test(rest)) return null;
  const q = rest.indexOf('?');
  const pathText = q < 0 ? rest : rest.slice(0, q);
  // Los porcentajes solo valen en el nombre: en la ruta esconderían barras o "..".
  if (pathText.includes('%') || pathText.includes('+')) return null;
  const query = parseQuery(q < 0 ? '' : rest.slice(q + 1));
  if (!query) return null;
  // Se tolera una barra final (algunos programas la agregan), no más.
  const segments = pathText.replace(/\/$/, '').split('/');
  if (segments.length < 2 || segments.some((s) => !s)) return null;
  const [kind, ...args] = segments;
  switch (kind.toLowerCase()) {
    case 'modpack':
      return parseModpack([args[0]?.toLowerCase(), ...args.slice(1)], query);
    case 'server':
      return parseServerLink(args, query);
    case 'instance':
      return parseInstance(args);
    default:
      return null;
  }
}

// De una lista de argumentos (process.argv o los de una segunda copia): la acción del primer venus:// o null.
function findLink(argv) {
  if (!Array.isArray(argv)) return null;
  const arg = argv.find((a) => typeof a === 'string' && a.slice(0, SCHEME.length).toLowerCase() === SCHEME);
  return arg ? parseLink(arg) : null;
}

module.exports = { parseLink, findLink, parseServer, cleanName, SCHEME, MAX_LINK, MAX_NAME };
