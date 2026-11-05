'use strict';
// Reglas de la musica de perfil (4.6): que se acepta de Openverse y como queda guardado en cardStyle.song.
// Sin Electron: lo usan el modulo, el cliente de la API y las pruebas. La interfaz tiene su copia en
// src/renderer/js/features/profile-editor/music-logic.js (una prueba verifica que las dos digan lo mismo) y el
// servidor, la suya en private.card_song_ok (supabase/migrations/0042_musica_perfil.sql).
//
// Todo lo que viene de la API es dato no confiable: se valida campo por campo y lo que no encaja se descarta.
// Nunca se descarga ni se ejecuta nada: la interfaz solo reproduce la URL con un <audio>.

const PROVIDER = 'openverse';

// Licencias que permiten uso comercial. Quedan afuera todas las NC, "sampling+" y "nc-sampling+".
//   url: como queda guardada la direccion de la licencia (siempre la forma canonica, sin /deed.xx)
const LICENSES = Object.freeze({
  by: { name: 'CC BY', versions: ['1.0', '2.0', '2.5', '3.0', '4.0'], path: 'licenses/by' },
  'by-sa': { name: 'CC BY-SA', versions: ['1.0', '2.0', '2.5', '3.0', '4.0'], path: 'licenses/by-sa' },
  'by-nd': { name: 'CC BY-ND', versions: ['1.0', '2.0', '2.5', '3.0', '4.0'], path: 'licenses/by-nd' },
  cc0: { name: 'CC0', versions: ['1.0'], path: 'publicdomain/zero' },
  pdm: { name: 'Dominio público', versions: ['1.0'], path: 'publicdomain/mark' },
});
const LICENSE_IDS = Object.freeze(Object.keys(LICENSES));

// Fuentes de Openverse que se usan (valores de ?source=). Freesound queda afuera: casi todo son efectos y muestras
// de 1 a 40 s sin categoria "music", y solo ofrece vistas previas recodificadas.
const SOURCES = Object.freeze({
  jamendo: {
    api: 'jamendo',
    audio: /^https:\/\/prod-1\.storage\.jamendo\.com\/\?trackid=[0-9]{1,10}&format=mp3[12]$/,
    landing: /^https:\/\/www\.jamendo\.com\/track\/[0-9]{1,10}$/,
  },
  wikimedia: {
    api: 'wikimedia_audio',
    audio: /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/[0-9a-f]\/[0-9a-f]{2}\/[A-Za-z0-9._%~+-]{1,200}\.(?:ogg|oga|opus|mp3)$/,
    landing: /^https:\/\/commons\.wikimedia\.org\/(?:w\/index\.php\?curid=[0-9]{1,10}|wiki\/File:[A-Za-z0-9._%~+()-]{1,200})$/,
  },
});
const SOURCE_BY_API = Object.freeze(Object.fromEntries(Object.entries(SOURCES).map(([id, s]) => [s.api, id])));

// Hosts desde donde se reproduce el audio (la CSP de index.html los repite en media-src) y paginas de origen
const AUDIO_HOSTS = Object.freeze(['prod-1.storage.jamendo.com', 'upload.wikimedia.org']);
const LANDING_HOSTS = Object.freeze(['www.jamendo.com', 'commons.wikimedia.org']);

const LIMITS = Object.freeze({
  title: 80,
  creator: 60,
  url: 300,
  landing: 120,
  licenseUrl: 80,
  seconds: 30, // largo del tramo que suena en el perfil
  start: 86_400,
  maxTrack: 1800, // pistas de hasta 30 minutos
  songBytes: 1400, // tope del JSON de la cancion (el card_style entero queda debajo de 2 KB)
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = new RegExp(`[\u0000-\u001f\u007f${String.fromCharCode(0x2028, 0x2029)}<>]`, 'g');
const SONG_KEYS = Object.freeze(['provider', 'id', 'title', 'creator', 'license', 'licenseVersion', 'licenseUrl', 'landing', 'url', 'start', 'len']);

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Texto de otra persona para mostrar: sin caracteres de control ni < >, espacios juntos y recortado
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function licenseUrl(license, version) {
  const l = LICENSES[license];
  if (!l || !l.versions.includes(version)) return null;
  return `https://creativecommons.org/${l.path}/${version}/`;
}

// 'jamendo' | 'wikimedia' segun el host del audio, o null si no es una URL aceptada
function sourceOfAudio(url) {
  if (typeof url !== 'string' || url.length > LIMITS.url) return null;
  for (const [id, s] of Object.entries(SOURCES)) if (s.audio.test(url)) return id;
  return null;
}
const audioUrlOk = (url) => sourceOfAudio(url) !== null;

function landingOk(landing, source) {
  return typeof landing === 'string' && landing.length <= LIMITS.landing && Boolean(SOURCES[source]) && SOURCES[source].landing.test(landing);
}

// Un resultado de /v1/audio/ -> pista para mostrar y elegir, o null si no cumple (licencia, host, campos).
function trackFromResult(raw) {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.toLowerCase() : '';
  if (!UUID.test(id)) return null;
  if (raw.mature === true || (Array.isArray(raw.unstable__sensitivity) && raw.unstable__sensitivity.length)) return null;
  const apiSource = SOURCE_BY_API[raw.source];
  if (!apiSource) return null;
  const license = typeof raw.license === 'string' ? raw.license.toLowerCase() : '';
  const version = typeof raw.license_version === 'string' ? raw.license_version : '';
  const lurl = licenseUrl(license, version);
  if (!lurl) return null;
  // La licencia debe ser la de creativecommons.org (nada de paginas ajenas con el mismo nombre)
  if (typeof raw.license_url === 'string' && !/^https:\/\/creativecommons\.org\//.test(raw.license_url)) return null;
  const url = raw.url;
  if (sourceOfAudio(url) !== apiSource) return null;
  const landing = raw.foreign_landing_url;
  if (!landingOk(landing, apiSource)) return null;
  const title = cleanText(raw.title, LIMITS.title);
  if (!title) return null;
  const ms = typeof raw.duration === 'number' && Number.isFinite(raw.duration) ? raw.duration : 0;
  const duration = Math.round(ms / 1000);
  if (duration < 1 || duration > LIMITS.maxTrack) return null;
  const genres = (Array.isArray(raw.genres) ? raw.genres : [])
    .filter((g) => typeof g === 'string' && /^[a-z0-9 &-]{1,24}$/i.test(g))
    .slice(0, 3)
    .map((g) => g.toLowerCase());
  return {
    provider: PROVIDER,
    id,
    source: apiSource,
    title,
    creator: cleanText(raw.creator, LIMITS.creator),
    license,
    licenseVersion: version,
    licenseUrl: lurl,
    landing,
    url,
    duration,
    genres,
  };
}

// Una pista ya armada por trackFromResult (por ejemplo, leida de la cache en disco) -> la misma, vuelta a validar
function normalizeTrack(t) {
  if (!isObj(t)) return null;
  const source = sourceOfAudio(t.url);
  if (!source || t.source !== source || !landingOk(t.landing, source)) return null;
  const song = normalizeSong({ provider: t.provider, id: t.id, title: t.title, creator: t.creator, license: t.license, licenseVersion: t.licenseVersion, licenseUrl: t.licenseUrl, landing: t.landing, url: t.url, start: 0, len: 1 });
  if (!song) return null;
  const duration = Number.isInteger(t.duration) ? t.duration : 0;
  if (duration < 1 || duration > LIMITS.maxTrack) return null;
  const genres = (Array.isArray(t.genres) ? t.genres : []).filter((g) => typeof g === 'string' && /^[a-z0-9 &-]{1,24}$/.test(g)).slice(0, 3);
  return { provider: PROVIDER, id: song.id, source, title: song.title, creator: song.creator, license: song.license, licenseVersion: song.licenseVersion, licenseUrl: song.licenseUrl, landing: song.landing, url: song.url, duration, genres };
}

// Pista elegida + tramo -> lo que se guarda en cardStyle.song
function songFromTrack(track, { start = 0, len = LIMITS.seconds } = {}) {
  if (!isObj(track)) return null;
  const dur = Number.isFinite(track.duration) ? Math.floor(track.duration) : LIMITS.seconds;
  const l = Math.max(1, Math.min(LIMITS.seconds, Math.floor(Number(len) || LIMITS.seconds), dur));
  const s = Math.max(0, Math.min(Math.max(0, dur - l), Math.floor(Number(start) || 0)));
  return normalizeSong({
    provider: PROVIDER,
    id: track.id,
    title: track.title,
    creator: track.creator,
    license: track.license,
    licenseVersion: track.licenseVersion,
    licenseUrl: track.licenseUrl,
    landing: track.landing,
    url: track.url,
    start: s,
    len: l,
  });
}

// Valida una cancion ya guardada (cardStyle.song, tal como la valida el servidor): exactamente estas claves, la
// licencia coincide con su version y su direccion, y el audio y la pagina de origen son de la misma fuente.
// Devuelve la cancion limpia o null.
function normalizeSong(v) {
  if (!isObj(v)) return null;
  if (Object.keys(v).some((k) => !SONG_KEYS.includes(k))) return null;
  if (v.provider !== PROVIDER) return null;
  const id = typeof v.id === 'string' ? v.id.toLowerCase() : '';
  if (!UUID.test(id)) return null;
  const title = cleanText(v.title, LIMITS.title);
  if (!title) return null;
  if (typeof v.creator !== 'string' || v.creator.length > LIMITS.creator) return null;
  const creator = cleanText(v.creator, LIMITS.creator);
  if (!LICENSE_IDS.includes(v.license) || typeof v.licenseVersion !== 'string') return null;
  const lurl = licenseUrl(v.license, v.licenseVersion);
  if (!lurl || v.licenseUrl !== lurl) return null;
  const source = sourceOfAudio(v.url);
  if (!source || !landingOk(v.landing, source)) return null;
  if (!Number.isInteger(v.start) || v.start < 0 || v.start > LIMITS.start) return null;
  if (!Number.isInteger(v.len) || v.len < 1 || v.len > LIMITS.seconds) return null;
  const out = { provider: PROVIDER, id, title, creator, license: v.license, licenseVersion: v.licenseVersion, licenseUrl: lurl, landing: v.landing, url: v.url, start: v.start, len: v.len };
  if (JSON.stringify(out).length > LIMITS.songBytes) return null;
  return out;
}

module.exports = {
  PROVIDER,
  LICENSES,
  LICENSE_IDS,
  SOURCES,
  SOURCE_BY_API,
  AUDIO_HOSTS,
  LANDING_HOSTS,
  LIMITS,
  SONG_KEYS,
  cleanText,
  licenseUrl,
  sourceOfAudio,
  audioUrlOk,
  landingOk,
  trackFromResult,
  normalizeTrack,
  songFromTrack,
  normalizeSong,
};
