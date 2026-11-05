// Logica pura de la musica de perfil (4.6, sin DOM ni imports, para probarla con Node): valida la cancion guardada en
// cardStyle.song, arma la cancion a partir de una pista de Openverse, y las cuentas del tramo de 30 s.
// Es la copia de la interfaz de src/main/modules/profilemusic/policy.js (una prueba verifica que digan lo mismo) y de
// private.card_song_ok en supabase/migrations/0042_musica_perfil.sql. La usan model.js, social/song.js, social/logic.js
// y features/profile-editor/music.js. Lo que llega de otras personas (la cancion de un perfil) es dato no confiable:
// la direccion del audio solo se usa si pasa por aca.

export const PROVIDER = 'openverse';

// Solo licencias que permiten uso comercial. versions: las que existen de cada una.
export const LICENSES = Object.freeze({
  by: { name: 'CC BY', versions: ['1.0', '2.0', '2.5', '3.0', '4.0'], path: 'licenses/by' },
  'by-sa': { name: 'CC BY-SA', versions: ['1.0', '2.0', '2.5', '3.0', '4.0'], path: 'licenses/by-sa' },
  'by-nd': { name: 'CC BY-ND', versions: ['1.0', '2.0', '2.5', '3.0', '4.0'], path: 'licenses/by-nd' },
  cc0: { name: 'CC0', versions: ['1.0'], path: 'publicdomain/zero' },
  pdm: { name: 'PDM', versions: ['1.0'], path: 'publicdomain/mark' },
});
export const LICENSE_IDS = Object.freeze(Object.keys(LICENSES));

const SOURCES = Object.freeze({
  jamendo: {
    audio: /^https:\/\/prod-1\.storage\.jamendo\.com\/\?trackid=[0-9]{1,10}&format=mp3[12]$/,
    landing: /^https:\/\/www\.jamendo\.com\/track\/[0-9]{1,10}$/,
  },
  wikimedia: {
    audio: /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/[0-9a-f]\/[0-9a-f]{2}\/[A-Za-z0-9._%~+-]{1,200}\.(?:ogg|oga|opus|mp3)$/,
    landing: /^https:\/\/commons\.wikimedia\.org\/(?:w\/index\.php\?curid=[0-9]{1,10}|wiki\/File:[A-Za-z0-9._%~+()-]{1,200})$/,
  },
});
export const AUDIO_HOSTS = Object.freeze(['prod-1.storage.jamendo.com', 'upload.wikimedia.org']);
export const LANDING_HOSTS = Object.freeze(['www.jamendo.com', 'commons.wikimedia.org']);

export const LIMITS = Object.freeze({ title: 80, creator: 60, url: 300, landing: 120, licenseUrl: 80, seconds: 30, start: 86_400, maxTrack: 1800, songBytes: 1400 });
export const SONG_KEYS = Object.freeze(['provider', 'id', 'title', 'creator', 'license', 'licenseVersion', 'licenseUrl', 'landing', 'url', 'start', 'len']);

// Filtros de la busqueda (los mismos ids que profilemusic/query.js)
export const GENRES = Object.freeze(['electronic', 'rock', 'pop', 'jazz', 'classical', 'ambient', 'chillout', 'folk', 'metal', 'piano', 'orchestral', 'cinematic', 'chiptune', 'reggae', 'lofi']);
export const LENGTHS = Object.freeze(['any', 'short', 'medium', 'long']);
export const SOURCE_CHOICES = Object.freeze(['jamendo', 'wikimedia', 'both']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = new RegExp(`[\u0000-\u001f\u007f${String.fromCharCode(0x2028, 0x2029)}<>]`, 'g');
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export function licenseUrl(license, version) {
  const l = LICENSES[license];
  return l && l.versions.includes(version) ? `https://creativecommons.org/${l.path}/${version}/` : null;
}

// 'jamendo' | 'wikimedia' | null segun la direccion del audio
export function songSource(url) {
  if (typeof url !== 'string' || url.length > LIMITS.url) return null;
  for (const [id, s] of Object.entries(SOURCES)) if (s.audio.test(url)) return id;
  return null;
}
export const isSongAudioUrl = (url) => songSource(url) !== null;

export function isLandingUrl(url, source) {
  return typeof url === 'string' && url.length <= LIMITS.landing && Boolean(SOURCES[source]) && SOURCES[source].landing.test(url);
}

// Cancion guardada -> la misma limpia, o null si no cumple (exactamente estas claves, licencia coherente, hosts conocidos)
export function normalizeSong(v) {
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
  const source = songSource(v.url);
  if (!source || !isLandingUrl(v.landing, source)) return null;
  if (!Number.isInteger(v.start) || v.start < 0 || v.start > LIMITS.start) return null;
  if (!Number.isInteger(v.len) || v.len < 1 || v.len > LIMITS.seconds) return null;
  const out = { provider: PROVIDER, id, title, creator, license: v.license, licenseVersion: v.licenseVersion, licenseUrl: lurl, landing: v.landing, url: v.url, start: v.start, len: v.len };
  return JSON.stringify(out).length > LIMITS.songBytes ? null : out;
}

// Pista elegida (de profilemusic:search) -> cancion guardable, con el tramo pedido (se acomoda dentro de la pista)
export function songFromTrack(track, { start = 0, len = LIMITS.seconds } = {}) {
  if (!isObj(track)) return null;
  const dur = Number.isFinite(track.duration) ? Math.floor(track.duration) : LIMITS.seconds;
  const l = Math.max(1, Math.min(LIMITS.seconds, Math.floor(Number(len) || LIMITS.seconds), dur));
  const s = clampStart(start, l, dur);
  return normalizeSong({ provider: PROVIDER, id: track.id, title: track.title, creator: track.creator, license: track.license, licenseVersion: track.licenseVersion, licenseUrl: track.licenseUrl, landing: track.landing, url: track.url, start: s, len: l });
}

// Una pista de la busqueda se vuelve a mirar antes de reproducir su vista previa (la direccion sale de la API)
export const trackPlayable = (track) => isObj(track) && isSongAudioUrl(track.url) && songFromTrack(track) !== null;

// ---------- Cuentas del tramo ----------
// Largo del tramo: 30 s o lo que dure la pista
export const clipLength = (duration) => Math.max(1, Math.min(LIMITS.seconds, Math.floor(Number(duration)) || LIMITS.seconds));

// Inicio dentro de la pista: de 0 a (duracion - largo), entero
export function clampStart(start, len, duration) {
  const max = Math.max(0, Math.floor(Number(duration) || 0) - len);
  return Math.max(0, Math.min(max, Math.floor(Number(start) || 0)));
}

// Fraccion (0 a 1) del tramo que ya sono
export function clipProgress(currentTime, start, len) {
  if (!(len > 0)) return 0;
  const k = (Number(currentTime) - start) / len;
  return Number.isFinite(k) ? Math.max(0, Math.min(1, k)) : 0;
}

// Con el audio ya cargado se sabe la duracion real: si el inicio guardado no entra, se reparte desde el principio
export function playableWindow(song, mediaDuration) {
  const len = song.len;
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return { start: song.start, len };
  const real = Math.max(1, Math.min(len, Math.floor(mediaDuration)));
  const start = song.start + 1 > mediaDuration ? 0 : Math.min(song.start, Math.max(0, Math.floor(mediaDuration) - real));
  return { start, len: real };
}

// 83 -> '1:23'
export function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// "CC BY-SA 4.0", "CC0 1.0" (la i18n pone "Dominio publico" para pdm)
export function licenseLabel(license, version) {
  const l = LICENSES[license];
  return l ? `${l.name} ${version}` : '';
}

// store.running (instanceId -> { state }) -> si hay algun juego abierto o abriendose
export function gameBusy(running) {
  return Object.values(running && typeof running === 'object' ? running : {}).some((r) => r && (r.state === 'running' || r.state === 'preparing'));
}

// Error de profilemusic:search ({ error, retryAfter }) -> clave de texto de profilemusic.* y segundos de espera
export function errorInfo(res) {
  const code = typeof res?.error === 'string' ? res.error : 'network';
  const known = ['disabled', 'bad_query', 'offline', 'rate_limited', 'daily_limit', 'network', 'timeout', 'server', 'bad_response'];
  return { code: known.includes(code) ? code : 'network', retryAfter: Math.max(0, Math.min(86_400, Math.ceil(Number(res?.retryAfter) || 0))) };
}

// Espera hasta poder buscar de nuevo -> { unit: 'seconds' | 'minutes' | 'hours', n }
export function fmtWait(seconds) {
  const s = Math.max(1, Math.ceil(Number(seconds) || 1));
  if (s <= 90) return { unit: 'seconds', n: s };
  if (s <= 5400) return { unit: 'minutes', n: Math.ceil(s / 60) };
  return { unit: 'hours', n: Math.ceil(s / 3600) };
}
