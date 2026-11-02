'use strict';
// Protocolo con el ayudante (ver script.js): leer sus líneas JSON con validación y armar los comandos.
// Sin Electron ni procesos: lo usan las pruebas tal cual.

const MAX_LINE = 96 * 1024; // una línea de sesiones con varias apps y textos largos entra holgada
const MAX_TEXT = 300;
const MAX_ID = 260;
const MAX_SESSIONS = 16;
const MAX_AUDIO = 64;
const MAX_ART_CHARS = 20 * 1024;
const ART_RE = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;
const RESULT_ERRORS = new Set(['noSession', 'noAudio', 'rejected', 'badCommand', 'failed', 'timeout']);
const COMMANDS = new Set(['play', 'pause', 'toggle', 'next', 'prev', 'stop', 'seek', 'setVolume', 'setMute', 'poll', 'ping', 'quit']);
const SESSION_COMMANDS = new Set(['play', 'pause', 'toggle', 'next', 'prev', 'stop', 'seek']);

// Texto de afuera (títulos de canciones): sin caracteres de control, espacios colapsados y con largo máximo
const CONTROL_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');
function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return '';
  const s = value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const bool = (v) => v === true;
const int = (v, min = -Infinity, max = Infinity) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
function ms(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1e13 ? Math.round(n) : 0;
}

function cleanId(v) {
  const s = cleanText(v, MAX_ID);
  return s;
}

function validArt(v) {
  return typeof v === 'string' && v.length <= MAX_ART_CHARS && ART_RE.test(v) ? v : null;
}

// PowerShell 5.1 serializa una lista de un elemento como lista, pero por las dudas se acepta un objeto suelto
function asList(v, max) {
  if (Array.isArray(v)) return v.slice(0, max);
  if (v && typeof v === 'object') return [v];
  return [];
}

function normalizeSession(o) {
  if (!o || typeof o !== 'object') return null;
  const id = cleanId(o.id);
  if (!id) return null;
  const status = int(o.status, -1, 5);
  const updated = Number(o.updated);
  return {
    id,
    app: cleanId(o.app) || id,
    title: cleanText(o.title),
    artist: cleanText(o.artist),
    album: cleanText(o.album),
    key: typeof o.key === 'string' && /^[0-9a-f]{1,16}$/i.test(o.key) ? o.key.toLowerCase() : '',
    status: status === null ? -1 : status,
    position: ms(o.position),
    start: ms(o.start),
    end: ms(o.end),
    // epoch ms en que la app actualizó la posición (0 = no se sabe)
    updated: Number.isFinite(updated) && updated > 946684800000 && updated < 1e13 ? Math.round(updated) : 0,
    canPlay: bool(o.canPlay),
    canPause: bool(o.canPause),
    canToggle: bool(o.canToggle),
    canNext: bool(o.canNext),
    canPrev: bool(o.canPrev),
    canSeek: bool(o.canSeek),
  };
}

function normalizeAudio(o) {
  if (!o || typeof o !== 'object') return null;
  const pid = int(o.pid, 1, 0x7fffffff);
  if (!pid) return null;
  const volume = Number(o.volume);
  return {
    pid,
    exe: cleanText(o.exe, 120),
    pkg: cleanText(o.pkg, 160),
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0,
    muted: bool(o.muted),
    active: bool(o.active),
  };
}

// Una línea del ayudante -> mensaje validado, o null si no es un mensaje conocido
function parseLine(line) {
  if (typeof line !== 'string') return null;
  let s = line.length > MAX_LINE ? '' : line.replace(/^﻿/, '').trim();
  if (!s || s[0] !== '{') return null;
  let raw;
  try {
    raw = JSON.parse(s);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || typeof raw.t !== 'string') return null;
  s = null;
  switch (raw.t) {
    case 'ready':
      return {
        t: 'ready',
        version: int(raw.v, 0, 1000) || 0,
        smtc: bool(raw.smtc),
        audio: bool(raw.audio),
        thumbs: bool(raw.thumbs),
        error: cleanText(raw.error, 240),
      };
    case 'sessions': {
      const list = asList(raw.list, MAX_SESSIONS).map(normalizeSession).filter(Boolean);
      const system = cleanId(raw.system);
      return { t: 'sessions', system: list.some((x) => x.id === system) ? system : '', list };
    }
    case 'art': {
      const id = cleanId(raw.id);
      if (!id) return null;
      return { t: 'art', id, key: typeof raw.key === 'string' && /^[0-9a-f]{1,16}$/i.test(raw.key) ? raw.key.toLowerCase() : '', data: validArt(raw.data) };
    }
    case 'audio':
      return { t: 'audio', list: asList(raw.list, MAX_AUDIO).map(normalizeAudio).filter(Boolean) };
    case 'result': {
      const req = int(raw.req, 1, Number.MAX_SAFE_INTEGER);
      if (!req) return null;
      const ok = bool(raw.ok);
      return { t: 'result', req, ok, error: ok ? null : RESULT_ERRORS.has(raw.error) ? raw.error : 'failed' };
    }
    case 'log':
      return { t: 'log', msg: cleanText(raw.msg, 300) };
    default:
      return null;
  }
}

// Comando para el ayudante: una línea JSON terminada en \n. Lanza TypeError si el comando no es válido.
function encodeCommand(input) {
  const c = input && typeof input === 'object' ? input : {};
  if (!COMMANDS.has(c.cmd)) throw new TypeError(`comando desconocido: ${c.cmd}`);
  const out = { cmd: c.cmd };
  if (c.req !== undefined) {
    if (!Number.isInteger(c.req) || c.req < 1) throw new TypeError('req inválido');
    out.req = c.req;
  }
  if (SESSION_COMMANDS.has(c.cmd)) {
    const id = typeof c.id === 'string' ? c.id : '';
    if (!id || id.length > MAX_ID) throw new TypeError('id de sesión inválido');
    out.id = id;
  }
  if (c.cmd === 'seek') {
    const p = Number(c.position);
    if (!Number.isFinite(p) || p < 0 || p > 1e10) throw new TypeError('posición inválida');
    out.position = Math.round(p);
  }
  if (c.cmd === 'setVolume' || c.cmd === 'setMute') {
    const pids = Array.isArray(c.pids) ? [...new Set(c.pids.filter((p) => Number.isInteger(p) && p > 0 && p <= 0x7fffffff))].slice(0, MAX_AUDIO) : [];
    if (!pids.length) throw new TypeError('sin procesos');
    out.pids = pids;
    if (c.cmd === 'setVolume') {
      const v = Number(c.volume);
      if (!Number.isFinite(v)) throw new TypeError('volumen inválido');
      out.volume = Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
    } else out.muted = c.muted === true;
  }
  return `${JSON.stringify(out)}\n`;
}

// Junta los pedazos de stdout y devuelve las líneas completas (lo que sobra queda para el próximo pedazo).
// Si una línea se hace gigante sin salto (salida rota), se descarta.
function createLineSplitter(maxBuffer = MAX_LINE * 2) {
  let buf = '';
  return (chunk) => {
    buf += String(chunk);
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    if (buf.length > maxBuffer) buf = '';
    return lines;
  };
}

module.exports = { parseLine, encodeCommand, createLineSplitter, cleanText, validArt, MAX_ART_CHARS, COMMANDS, SESSION_COMMANDS };
