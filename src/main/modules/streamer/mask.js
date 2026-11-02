'use strict';
// Modo streamer: que esconder mientras se graba o transmite. Logica pura (sin Electron), probada con node:test.
// La interfaz tiene una copia de las mismas reglas de texto en src/renderer/js/features/streamer/mask.js
// (la pagina no puede cargar modulos CommonJS): si se cambia algo aca, cambiarlo alla tambien.
//
// maskText(texto): tapa codigos de amigo y de pack (VENUS-XXXXXX, PACK-XXXXXX), IPs y direcciones de servidor.
// maskEvent(evento, t): version para el overlay de un evento ya validado (overlay/events.js): los mensajes
// pierden quien los manda y el texto, el Voice Chat pierde el codigo y los nombres, y los avisos de amigos
// pierden el cuerpo.

const DOT = '•';
const CODE_MASK = DOT.repeat(6);

// Extensiones de archivo que parecen un dominio ("sodium-0.5.8+mc1.20.1.jar") y no se tapan.
const FILE_EXT = new Set(['jar', 'zip', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'toml', 'cfg', 'conf', 'js', 'ts', 'exe', 'mrpack', 'log', 'md', 'yml', 'yaml', 'dat', 'nbt', 'mca', 'tar', 'gz', 'mp4', 'webm', 'mp3', 'ogg', 'wav', 'properties', 'lock', 'bak', 'old', 'tmp', 'html', 'css', 'svg', 'ico', 'dll', 'so', 'sh', 'bat', 'ps1', 'py', 'java', 'class', 'xml', 'csv', 'pdf']);

const RULES = [
  // Codigos de amigo (VENUS-XXXXXX) y de pack (PACK-XXXXXX)
  [/\b(VENUS|PACK)-[A-Z0-9]{6}\b/gi, (m, p) => `${p.toUpperCase()}-${CODE_MASK}`],
  // IPv4 (con puerto opcional) que no parecen numeros de version (1.20.1.2 dentro de un nombre de archivo no se toca)
  [/(?<![\w.:-])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{2,5})?(?![\w.-]|\.\d)/g, `${DOT.repeat(3)}.${DOT.repeat(3)}.${DOT.repeat(3)}.${DOT.repeat(3)}`],
  // IPv6 completas o comprimidas con ::
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/gi, `${DOT.repeat(4)}:${DOT.repeat(4)}`],
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4}(?![\w:])/gi, `${DOT.repeat(4)}:${DOT.repeat(4)}`],
  // Dominios con o sin puerto (mc.ejemplo.net, play.ejemplo.com:25565, abc.tunel.app), sin rutas ni archivos.
  // Largo fijo: el largo del nombre tambien dice algo.
  [
    /(?<![\w.@/-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+)([a-z]{2,24})(:\d{2,5})?(?![\w.@/-])/gi,
    (m, labels, tld, port) => (FILE_EXT.has(tld.toLowerCase()) || !/[a-z]/i.test(labels) ? m : `${DOT.repeat(8)}.${tld.toLowerCase()}${port || ''}`),
  ],
];

function maskText(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

// Nombres genericos y estables para los miembros del Voice Chat mientras dura la sesion del launcher.
const voiceAliases = new Map(); // id -> numero
function voiceAlias(id, t) {
  const key = String(id || '');
  if (!voiceAliases.has(key)) voiceAliases.set(key, voiceAliases.size + 1);
  return t('overlay.streamerFriendN', { n: voiceAliases.get(key) });
}

function maskEvent(ev, t) {
  if (!ev || typeof ev !== 'object') return ev;
  switch (ev.kind) {
    case 'message':
      return { ...ev, from: t('overlay.streamerFriend'), fromId: null, avatar: null, text: t('overlay.streamerMessage') };
    case 'voice': {
      const room = ev.room ? { ...ev.room, name: t('overlay.streamerRoom'), code: CODE_MASK } : ev.room;
      const members = Array.isArray(ev.members)
        ? ev.members.map((m) => ({ ...m, avatar: null, name: m.self ? t('overlay.streamerYou') : voiceAlias(m.id, t) }))
        : ev.members;
      return { ...ev, room, members };
    }
    case 'alert': {
      // Un amigo: solicitud, invitacion a voz, entro a un servidor o a un mundo. El titulo lleva su nombre.
      if (ev.icon === 'friend' || ev.icon === 'party') return { ...ev, title: t('overlay.streamerFriendAlert'), body: undefined };
      return { ...ev, title: maskText(ev.title), body: ev.body ? maskText(ev.body) : ev.body };
    }
    default:
      return ev;
  }
}

function resetAliases() {
  voiceAliases.clear();
}

module.exports = { maskText, maskEvent, resetAliases, CODE_MASK };
