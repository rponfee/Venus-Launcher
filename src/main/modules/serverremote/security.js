'use strict';
// Control remoto del servidor local: las piezas de seguridad, sin Electron ni red (se prueban con Node puro).
const crypto = require('crypto');
const netinfo = require('../netplay/netinfo');

// Base32 de Crockford: sin I, L, O ni U para que el código se pueda dictar o escribir a mano en el celular.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TOKEN_CHARS = 28; // 28 x 5 = 140 bits
const TOKEN_RE = new RegExp(`^[${ALPHABET}]{${TOKEN_CHARS}}$`);

// Lista cerrada de acciones. Las de confirm: true exigen que la página haya pedido confirmación.
const ACTIONS = Object.freeze({
  start: { confirm: false },
  stop: { confirm: true },
  restart: { confirm: true },
  command: { confirm: true },
});
const MAX_COMMAND = 256;
// Controles y separadores de línea (U+2028 y U+2029 armados con fromCharCode: ver arquitectura, sección 8)
const CONTROL_CHARS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + ']');

class RemoteError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// 32 divide exacto a 256: tomar 5 bits de cada byte no sesga ningún carácter.
function newToken() {
  let out = '';
  for (const b of crypto.randomBytes(TOKEN_CHARS)) out += ALPHABET[b & 31];
  return out;
}

// Lo que escribe la persona: sin guiones ni espacios, en mayúsculas y con las confusiones típicas corregidas.
function normalizeCode(input) {
  const code = String(input ?? '').slice(0, 80).toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return TOKEN_RE.test(code) ? code : null;
}

const formatCode = (token) => String(token).replace(/(.{4})(?=.)/g, '$1-');

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();

// Tiempo constante: se comparan los hashes, que siempre miden lo mismo, así el largo del valor tampoco se filtra.
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return crypto.timingSafeEqual(sha(a), sha(b));
}

// DNS rebinding: un sitio ajeno que resuelve a esta IP llega con su propio nombre en Host. Solo vale la IP y el puerto reales.
function hostAllowed(host, ip, port) {
  return typeof host === 'string' && host === `${ip}:${port}`;
}

function singleHost(rawHeaders) {
  let count = 0;
  for (let i = 0; i < (rawHeaders?.length || 0); i += 2) if (String(rawHeaders[i]).toLowerCase() === 'host') count++;
  return count === 1;
}

// Sin CORS: si un pedido trae Origin, tiene que ser esta misma página.
function originAllowed(origin, ip, port) {
  return origin === undefined || origin === `http://${ip}:${port}`;
}

// Fetch Metadata (los navegadores no lo mandan siempre por HTTP): si está y dice que viene de otro sitio, se corta.
function fetchSiteAllowed(site) {
  return site === undefined || site === 'same-origin' || site === 'none';
}

// Quien pide tiene que estar en una red privada: si alguien redirige el puerto en el router, el pedido llega desde una
// IP pública y se corta igual.
const peerAllowed = (ip) => netinfo.isPrivate(ip) || netinfo.inRange(ip, '127.0.0.0', 8);

// Una IP de la red de la casa: RFC 1918, en un adaptador que no sea VPN ni virtual. Nunca 0.0.0.0, pública ni CGNAT.
function lanAddresses(interfaces, { isPrivate = netinfo.isPrivate } = {}) {
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return (Array.isArray(interfaces) ? interfaces : [])
    .filter((a) => a && a.kind === 'lan' && typeof a.address === 'string' && isPrivate(a.address))
    .map((a) => ({ name: String(a.name || ''), address: a.address }))
    .sort((a, b) => rank(a.address) - rank(b.address));
}

// Límite de intentos: pasado el tope dentro de la ventana, la clave queda bloqueada un rato. Memoria acotada.
class Limiter {
  constructor({ max = 5, windowMs = 5 * 60000, blockMs = 10 * 60000, maxKeys = 512, now = Date.now } = {}) {
    Object.assign(this, { max, windowMs, blockMs, maxKeys, now });
    this.keys = new Map(); // clave -> { count, since, until }
  }

  // Segundos que le quedan de bloqueo (0 = puede intentar)
  retryAfter(key) {
    const e = this.keys.get(key);
    if (!e?.until) return 0;
    const left = e.until - this.now();
    if (left <= 0) {
      this.keys.delete(key);
      return 0;
    }
    return Math.ceil(left / 1000);
  }

  fail(key) {
    const t = this.now();
    let e = this.keys.get(key);
    if (!e || t - e.since > this.windowMs) {
      this.keys.delete(key);
      if (this.keys.size >= this.maxKeys) this.keys.delete(this.keys.keys().next().value);
      e = { count: 0, since: t, until: 0 };
      this.keys.set(key, e);
    }
    e.count++;
    if (e.count >= this.max) e.until = t + this.blockMs;
    return e.until ? Math.ceil(this.blockMs / 1000) : 0;
  }

  clear() {
    this.keys.clear();
  }
}

// Valida el cuerpo de una acción contra la lista cerrada. Devuelve { action, command? } o lanza RemoteError.
function parseAction(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new RemoteError('bad_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RemoteError('bad_json');
  if (Object.keys(body).some((k) => !['action', 'command', 'confirm'].includes(k))) throw new RemoteError('bad_field');
  if (typeof body.action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, body.action)) throw new RemoteError('unknown_action');
  if (ACTIONS[body.action].confirm && body.confirm !== true) throw new RemoteError('confirm_required');
  if (body.action !== 'command') {
    if (body.command !== undefined) throw new RemoteError('bad_field');
    return { action: body.action };
  }
  if (typeof body.command !== 'string') throw new RemoteError('bad_command');
  const command = body.command.trim();
  if (!command || command.length > MAX_COMMAND || CONTROL_CHARS.test(command)) throw new RemoteError('bad_command');
  return { action: 'command', command };
}

// Saca las direcciones de las líneas de la consola: viajan sin cifrar por la red y las IP son de los jugadores.
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g;
const IPV6 = /\[(?=[0-9a-fA-F:.%]*(?:::|(?::[^:\]]*){3}))[0-9a-fA-F:.%\w]+\](?::\d{1,5})?/g;

function redactLine(text) {
  return String(text ?? '').slice(0, 600).replace(IPV6, '•••').replace(IPV4, '•••');
}

// Qué dispositivo es, de una lista cerrada: el User-Agent es texto ajeno y no llega crudo a la interfaz.
function deviceInfo(ua) {
  const s = String(ua ?? '').slice(0, 300);
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : null;
  const browser = /SamsungBrowser/.test(s) ? 'Samsung' : /EdgA?\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox|FxiOS/.test(s) ? 'Firefox' : /Chrome|CriOS/.test(s) ? 'Chrome' : /Safari/.test(s) ? 'Safari' : null;
  return { os, browser };
}

// ::ffff:192.168.0.5 -> 192.168.0.5
const cleanIp = (ip) => String(ip ?? '').replace(/^::ffff:/i, '');

module.exports = {
  ACTIONS,
  ALPHABET,
  MAX_COMMAND,
  RemoteError,
  TOKEN_CHARS,
  Limiter,
  cleanIp,
  deviceInfo,
  fetchSiteAllowed,
  formatCode,
  hostAllowed,
  lanAddresses,
  newToken,
  normalizeCode,
  originAllowed,
  parseAction,
  peerAllowed,
  redactLine,
  sameToken,
  singleHost,
};
