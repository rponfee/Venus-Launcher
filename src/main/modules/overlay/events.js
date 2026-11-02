'use strict';
// Validacion de los eventos del overlay (contrato 1 de la 2.0). Sin Electron: lo prueban las pruebas.
//   { kind: 'alert', title, body?, icon?, ttl? }
//   { kind: 'message', from, fromId?, avatar?, text, chatId? }
//   { kind: 'voice', room: { name, code } | null, self: { muted, deafened }, members: [{ id, name, avatar?, speaking, muted, deafened }] }
//   { kind: 'music', state: { title, artist, album, art, playing, position, duration, positionAt?, source, appName } | null }
//     (position y duration en ms, positionAt en epoch ms)
//   { kind: 'capture', type, path?, thumb?, duration? }
// validate(evento) devuelve una copia limpia (textos recortados y sin caracteres de control, numeros dentro de
// rango, imagenes solo https, data:image o assets/ del launcher) o lanza un Error con code 'badEvent' y field.

const KINDS = ['alert', 'message', 'voice', 'music', 'capture'];
const ALERT_ICONS = ['info', 'friend', 'server', 'points', 'achievement', 'capture', 'music', 'party'];
const CAPTURE_TYPES = ['screenshot', 'clip', 'recording-start', 'recording-stop', 'replay-saved'];
const MAX_MEMBERS = 16;
const MAX_DATA_URL = 512 * 1024;

function bad(field) {
  const err = new Error(`Evento de overlay inválido: ${field}`);
  err.code = 'badEvent';
  err.field = field;
  return err;
}

// Texto de una linea: sin caracteres de control ni separadores raros, espacios colapsados y con un largo maximo.
const CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028, 0x2029)}\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]`, 'g');
function text(v, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
const optText = (v, max) => {
  const s = text(v, max);
  return s || null;
};
const bool = (v) => v === true;
const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};

// Imagenes: https (avatares de mc-heads o del perfil), data:image chica o un recurso del launcher (assets/...).
const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
function image(v) {
  if (typeof v !== 'string' || !v) return null;
  if (v.startsWith('data:')) return v.length <= MAX_DATA_URL && DATA_IMAGE.test(v) ? v : null;
  if (/^assets\/[\w-]+(\/[\w-]+)*\.(png|webp|svg|jpg)$/.test(v)) return v;
  if (v.length > 1000 || !/^https:\/\//i.test(v)) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

// Segundos (duracion de capturas y clips). Un valor de mas de 6 horas se toma como milisegundos.
const MS_LIMIT = 21600;
function seconds(v) {
  const n = num(v, 0, 1e10);
  if (n === null) return null;
  return n > MS_LIMIT ? n / 1000 : n;
}

function alert(ev) {
  const title = text(ev.title, 120);
  if (!title) throw bad('title');
  // ttl en segundos (2 a 30); si llega en ms (mas de 60), se pasa a segundos.
  let ttl = ev.ttl === undefined || ev.ttl === null ? null : num(ev.ttl, 0, 1e7);
  if (ttl !== null) ttl = Math.min(30, Math.max(2, ttl > 60 ? ttl / 1000 : ttl));
  return {
    kind: 'alert',
    title,
    body: optText(ev.body, 280),
    icon: ALERT_ICONS.includes(ev.icon) ? ev.icon : 'info',
    ttl,
  };
}

function message(ev) {
  const from = text(ev.from, 48);
  const body = text(ev.text, 400);
  if (!from) throw bad('from');
  if (!body) throw bad('text');
  return {
    kind: 'message',
    from,
    fromId: optText(ev.fromId, 64),
    avatar: image(ev.avatar),
    text: body,
    chatId: optText(ev.chatId, 64),
  };
}

function voice(ev) {
  let room = null;
  if (ev.room !== null && ev.room !== undefined) {
    if (typeof ev.room !== 'object') throw bad('room');
    room = { name: text(ev.room.name, 64), code: text(ev.room.code, 32) };
  }
  const selfRaw = ev.self && typeof ev.self === 'object' ? ev.self : {};
  if (ev.members !== undefined && !Array.isArray(ev.members)) throw bad('members');
  const members = (ev.members || [])
    .filter((m) => m && typeof m === 'object')
    .slice(0, MAX_MEMBERS)
    .map((m, i) => ({
      id: text(m.id, 64) || `m${i}`,
      name: text(m.name, 48) || '?',
      avatar: image(m.avatar),
      speaking: bool(m.speaking),
      muted: bool(m.muted),
      deafened: bool(m.deafened),
      self: bool(m.self),
    }));
  return { kind: 'voice', room, self: { muted: bool(selfRaw.muted), deafened: bool(selfRaw.deafened) }, members: room ? members : [] };
}

function music(ev) {
  if (ev.state === null || ev.state === undefined) return { kind: 'music', state: null };
  const s = ev.state;
  if (typeof s !== 'object') throw bad('state');
  const title = text(s.title, 120);
  if (!title) return { kind: 'music', state: null };
  // Musica: position y duration llegan siempre en milisegundos (nowplaying.js); aca pasan a segundos.
  // Una duracion 0 (radio, transmision en vivo) queda en null y no hay barra de progreso.
  const rawDur = num(s.duration, 0, 1e10);
  const rawPos = num(s.position, 0, 1e10);
  const duration = rawDur ? rawDur / 1000 : null;
  let position = rawPos === null ? null : rawPos / 1000;
  if (position !== null && duration !== null) position = Math.min(position, duration);
  // positionAt: hora (epoch ms) en la que valia position; sirve para que la barra avance sola.
  const at = num(s.positionAt, 0, 1e15);
  const positionAt = at !== null && Math.abs(Date.now() - at) < 86400000 ? at : null;
  return {
    kind: 'music',
    state: {
      title,
      artist: optText(s.artist, 120),
      album: optText(s.album, 120),
      art: image(s.art),
      playing: bool(s.playing),
      position,
      positionAt,
      duration,
      source: optText(s.source, 48),
      appName: optText(s.appName, 48),
    },
  };
}

function capture(ev) {
  if (!CAPTURE_TYPES.includes(ev.type)) throw bad('type');
  const p = typeof ev.path === 'string' && ev.path.length <= 1024 ? ev.path.replace(CONTROL, '') : null;
  return { kind: 'capture', type: ev.type, path: p || null, thumb: image(ev.thumb), duration: ev.duration === undefined ? null : seconds(ev.duration) };
}

function validate(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw bad('event');
  if (!KINDS.includes(ev.kind)) throw bad('kind');
  if (ev.kind === 'alert') return alert(ev);
  if (ev.kind === 'message') return message(ev);
  if (ev.kind === 'voice') return voice(ev);
  if (ev.kind === 'music') return music(ev);
  return capture(ev);
}

// Grupo del filtro de avisos de Ajustes segun el icono.
function alertGroup(icon) {
  if (icon === 'friend' || icon === 'party') return 'friends';
  if (icon === 'server') return 'servers';
  if (icon === 'points' || icon === 'achievement') return 'rewards';
  return 'launcher';
}

module.exports = { validate, alertGroup, KINDS, ALERT_ICONS, CAPTURE_TYPES, MAX_MEMBERS, MAX_DATA_URL };
