'use strict';
// Lógica pura de Música: nombre y tipo de cada app, qué sesión se controla, qué sesiones del mezclador de
// Windows son de esa app y el estado que ven la interfaz y el overlay. Sin Electron (la usan las pruebas).

const STATUS = ['closed', 'opened', 'changing', 'stopped', 'playing', 'paused'];

// AppUserModelId (o parte) -> nombre visible y tipo. Las de la Tienda llegan como "Paquete_hash!App".
const KNOWN_APPS = [
  { re: /spotify/i, name: 'Spotify', source: 'spotify', exes: ['spotify.exe'] },
  { re: /^AppleInc\.AppleMusic/i, name: 'Apple Music', source: 'apple-music', exes: ['applemusic.exe', 'amplibraryagent.exe'] },
  { re: /itunes/i, name: 'iTunes', source: 'apple-music', exes: ['itunes.exe'] },
  { re: /youtube[-_. ]?music/i, name: 'YouTube Music', source: 'youtube-music', exes: ['youtube music.exe', 'youtube-music.exe'] },
  { re: /^Microsoft\.ZuneMusic/i, name: 'Media Player', source: 'media-player', exes: ['microsoft.media.player.exe', 'music.ui.exe'] },
  { re: /^Microsoft\.ZuneVideo/i, name: 'Movies & TV', source: 'media-player', exes: ['video.ui.exe'] },
  { re: /^(chrome|chrome\.exe)$/i, name: 'Google Chrome', source: 'browser', exes: ['chrome.exe'] },
  { re: /^(msedge|msedge\.exe|MicrosoftEdge)/i, name: 'Microsoft Edge', source: 'browser', exes: ['msedge.exe'] },
  { re: /firefox/i, name: 'Firefox', source: 'browser', exes: ['firefox.exe'] },
  // Firefox se identifica con un hash de 16 dígitos de su carpeta de instalación
  { re: /^[0-9A-F]{16}$/, name: 'Firefox', source: 'browser', exes: ['firefox.exe'] },
  { re: /^(opera|opera\.exe)$/i, name: 'Opera', source: 'browser', exes: ['opera.exe'] },
  { re: /opera ?gx/i, name: 'Opera GX', source: 'browser', exes: ['opera.exe'] },
  { re: /^(brave|brave\.exe)$/i, name: 'Brave', source: 'browser', exes: ['brave.exe'] },
  { re: /^(vivaldi|vivaldi\.exe)$/i, name: 'Vivaldi', source: 'browser', exes: ['vivaldi.exe'] },
  { re: /^(vlc|vlc\.exe)$/i, name: 'VLC', source: 'media-player', exes: ['vlc.exe'] },
  { re: /deezer/i, name: 'Deezer', source: 'other', exes: ['deezer.exe'] },
  { re: /tidal/i, name: 'TIDAL', source: 'other', exes: ['tidal.exe'] },
  { re: /amazon ?music/i, name: 'Amazon Music', source: 'other', exes: ['amazon music.exe'] },
  { re: /foobar2000/i, name: 'foobar2000', source: 'media-player', exes: ['foobar2000.exe'] },
  { re: /musicbee/i, name: 'MusicBee', source: 'media-player', exes: ['musicbee.exe'] },
  { re: /^(discord|discord\.exe)$/i, name: 'Discord', source: 'other', exes: ['discord.exe'] },
];

function known(appId) {
  const id = String(appId || '');
  return KNOWN_APPS.find((k) => k.re.test(id)) || null;
}

// "Paquete_hash!App" -> "Paquete" · "C:\...\app.exe" o "app.exe" -> "app"
function baseName(appId) {
  let s = String(appId || '').replace(/#\d+$/, '');
  if (s.includes('!')) s = s.split('!')[0];
  s = s.split(/[\\/]/).pop();
  if (/_[a-z0-9]{13}$/i.test(s)) s = s.replace(/_[a-z0-9]{13}$/i, '');
  return s.replace(/\.exe$/i, '');
}

function prettify(name) {
  const last = name.includes('.') && !/\s/.test(name) ? name.split('.').pop() : name;
  const spaced = last.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : '';
}

function appInfo(appId) {
  const k = known(appId);
  if (k) return { appName: k.name, source: k.source };
  const name = prettify(baseName(appId));
  return { appName: name || 'Windows', source: 'other' };
}

const isSpotify = (s) => Boolean(s) && /spotify/i.test(s.app || s.id || '');
const isPlaying = (s) => Boolean(s) && s.status === 4;

// Qué sesión se controla.
//  choice: 'auto' (Spotify si está sonando o si no suena otra cosa; si no, lo que suena, empezando por la que
//          elige Windows), 'system' (la que elige Windows) o el id de una app (si no está abierta, como 'auto').
//  prevId: la elegida antes; ante un empate se mantiene, para que no salte entre dos apps.
function chooseSession(list, { choice = 'auto', systemId = '', prevId = '' } = {}) {
  const sessions = Array.isArray(list) ? list.filter((s) => s && s.id) : [];
  if (!sessions.length) return null;
  const byId = (id) => (id ? sessions.find((s) => s.id === id) || null : null);
  if (choice && choice !== 'auto' && choice !== 'system') {
    const pinned = byId(choice) || sessions.find((s) => s.app === choice) || null;
    if (pinned) return pinned;
  }
  if (choice === 'system') {
    const sys = byId(systemId);
    if (sys) return sys;
  }
  const playing = sessions.filter(isPlaying);
  if (playing.length) {
    return playing.find(isSpotify) || playing.find((s) => s.id === prevId) || playing.find((s) => s.id === systemId) || playing[0];
  }
  return sessions.find(isSpotify) || byId(prevId) || byId(systemId) || sessions[0];
}

// Sesiones del mezclador de Windows que son de la app (puede haber varias: un proceso por salida de audio o
// varios procesos, como en los navegadores).
function matchAudio(appId, audioList) {
  const list = Array.isArray(audioList) ? audioList : [];
  const id = String(appId || '').replace(/#\d+$/, '');
  if (!id || !list.length) return [];
  const lower = id.toLowerCase();
  const exeOf = (a) => String(a.exe || '').toLowerCase();
  let out = [];
  if (lower.includes('!')) {
    // Paquete de la Tienda: "Nombre_hashEditor!App" contra "Nombre_1.2.3.0_x64__hashEditor"
    const family = lower.split('!')[0];
    const cut = family.lastIndexOf('_');
    const name = cut > 0 ? family.slice(0, cut) : family;
    const publisher = cut > 0 ? family.slice(cut + 1) : '';
    out = list.filter((a) => {
      const pkg = String(a.pkg || '').toLowerCase();
      return pkg && pkg.startsWith(`${name}_`) && (!publisher || pkg.endsWith(`_${publisher}`));
    });
  }
  if (!out.length && lower.endsWith('.exe')) {
    const exe = lower.split(/[\\/]/).pop();
    out = list.filter((a) => exeOf(a) === exe);
  }
  if (!out.length) {
    const k = known(id);
    if (k && k.exes.length) out = list.filter((a) => k.exes.includes(exeOf(a)));
  }
  if (!out.length) {
    const base = baseName(id).toLowerCase();
    if (base) out = list.filter((a) => exeOf(a).replace(/\.exe$/, '') === base);
  }
  return out;
}

// Volumen de la app a partir de sus sesiones del mezclador: el de la que está sonando (o la primera)
function audioSummary(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return { available: false, level: null, muted: false, pids: [] };
  const main = list.find((a) => a.active) || list[0];
  return {
    available: true,
    level: Math.round(main.volume * 100) / 100,
    muted: list.every((a) => a.muted),
    pids: [...new Set(list.map((a) => a.pid))],
  };
}

// Posición actual (ms desde el principio de la canción) y duración. La app informa la posición en el momento
// `updated`; si está sonando se le suma lo que pasó desde entonces.
function trackTiming(session, now = Date.now(), receivedAt = now) {
  if (!session) return { position: 0, duration: 0 };
  const start = session.start || 0;
  const duration = Math.max(0, (session.end || 0) - start);
  let position = Math.max(0, (session.position || 0) - start);
  if (isPlaying(session)) {
    const base = session.updated > 0 && session.updated <= now + 5000 ? session.updated : receivedAt;
    position += Math.max(0, now - base);
  }
  if (duration > 0) position = Math.min(position, duration);
  return { position: Math.round(position), duration: Math.round(duration) };
}

// Estado de la canción (contrato del overlay, docs/arquitectura.md): { title, artist, album, art, playing,
// position, duration, source, appName } + extras: appId, status, positionAt (epoch ms de `position`) y canSeek.
// position y duration en milisegundos.
function buildState(session, { art = null, now = Date.now(), receivedAt = now } = {}) {
  if (!session) return null;
  const { appName, source } = appInfo(session.app || session.id);
  const { position, duration } = trackTiming(session, now, receivedAt);
  return {
    title: session.title || '',
    artist: session.artist || '',
    album: session.album || '',
    art: art || null,
    playing: isPlaying(session),
    position,
    duration,
    source,
    appName,
    appId: session.id,
    status: STATUS[session.status] || 'unknown',
    positionAt: now,
    canSeek: Boolean(session.canSeek) && duration > 0,
  };
}

// Posición de un estado ya armado, llevada al momento `now`
function positionNow(state, now = Date.now()) {
  if (!state) return 0;
  let p = state.position || 0;
  if (state.playing && state.positionAt) p += Math.max(0, now - state.positionAt);
  return state.duration > 0 ? Math.min(p, state.duration) : p;
}

// ¿Cambió algo que el overlay tenga que mostrar? (canción, play/pausa, portada, salto de posición, duración)
function stateChanged(prev, next, now = Date.now()) {
  if (!prev || !next) return prev !== next;
  if (prev.appId !== next.appId || prev.title !== next.title || prev.artist !== next.artist || prev.album !== next.album) return true;
  if (prev.playing !== next.playing || prev.art !== next.art || prev.source !== next.source) return true;
  if (Math.abs((prev.duration || 0) - (next.duration || 0)) > 1500) return true;
  return Math.abs(positionNow(prev, now) - positionNow(next, now)) > 2500;
}

// Lista para elegir la fuente en Ajustes
function sourcesList(list, { selectedId = '', systemId = '' } = {}) {
  return (Array.isArray(list) ? list : []).map((s) => {
    const { appName, source } = appInfo(s.app || s.id);
    return { id: s.id, appName, source, title: s.title || '', artist: s.artist || '', playing: isPlaying(s), system: s.id === systemId, selected: s.id === selectedId };
  });
}

module.exports = { appInfo, chooseSession, matchAudio, audioSummary, trackTiming, buildState, positionNow, stateChanged, sourcesList, isSpotify, isPlaying, STATUS };
