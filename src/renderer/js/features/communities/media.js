// Comunidades: galería de la comunidad (GIF, WebP, PNG y JPEG subidos por el equipo, y GIFs de KLIPY), lógica pura sin DOM. El archivo
// se revisa acá antes de subir (tipo real por la cabecera, tamaño y dimensiones) para avisar rápido; después lo vuelve a comprobar el
// servidor (tamaño y tipo salen de Storage) y, sobre todo, lo revisa a mano un administrador de Venus: hasta que lo aprueba, nadie más
// que quien lo subió, el dueño y los administradores lo ven (bucket privado community-media, supabase/migrations/0038_comunidades.sql).
// Un GIF de KLIPY no sube ningún archivo, pero también nace pendiente (el servidor no puede saber si es apto). Cuántos elementos entran
// en la galería, cuántos esperan revisión y si un GIF puede ser fondo lo decide el plan de la comunidad (community_plan_get, ver
// features/communities/looks.js), no una constante de acá.
export const MEDIA_LIMITS = { bytes: 2097152, min: 16, max: 1024, name: 40 };
export const MEDIA_TYPES = { 'image/gif': 'gif', 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' };
export const MEDIA_ACCEPT = Object.keys(MEDIA_TYPES).join(',');
export const MEDIA_STATUSES = ['pending', 'approved', 'rejected', 'removed'];
export const MEDIA_SOURCES = ['upload', 'klipy'];
// Un JPEG puede traer antes de su cabecera de medidas (SOF) los datos EXIF, un perfil de color y una miniatura: se leen hasta 128 KB.
export const HEAD_BYTES = 131072;
// Tope del recorrido de marcadores de un JPEG: uno normal tiene unos 10 (APPn, DQT, DHT) antes del SOF. Más que esto es un archivo raro.
export const JPEG_MAX_SEGMENTS = 64;

const ascii = (bytes, from, to) => String.fromCharCode(...bytes.slice(from, to));
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/**
 * Medidas de un JPEG: recorre los marcadores hasta un SOF0, SOF1 o SOF2 (baseline, extendido y progresivo). Devuelve
 * { width, height }, null si no es un JPEG, o { width: 0, height: 0 } si lo parece pero no se llegó al SOF (cabecera demasiado larga
 * o más de JPEG_MAX_SEGMENTS marcadores): quien llama lo trata como medidas inválidas.
 */
function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff || b[3] < 0xc0) return null;
  let i = 2;
  for (let steps = 0; steps < JPEG_MAX_SEGMENTS && i + 3 < b.length; steps++) {
    if (b[i] !== 0xff) return { width: 0, height: 0 }; // perdió el hilo: no es un JPEG bien formado
    while (b[i + 1] === 0xff && i + 2 < b.length) i++; // bytes de relleno antes del marcador
    const marker = b[i + 1];
    i += 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // marcadores sin cuerpo
    if (marker === 0xd9 || marker === 0xda) break; // fin de imagen o comienzo de datos: ya no hay SOF
    if (i + 1 >= b.length) break;
    const length = u16be(b, i);
    if (length < 2) break;
    if (marker >= 0xc0 && marker <= 0xc2) {
      if (length < 8 || i + 6 >= b.length) break;
      return { height: u16be(b, i + 3), width: u16be(b, i + 5) };
    }
    i += length;
  }
  return { width: 0, height: 0 };
}

/** Tipo y medidas reales según los primeros bytes del archivo (no según lo que diga el nombre). null si no es GIF, WebP, PNG ni JPEG. */
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length >= 10 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) {
    return { mime: 'image/gif', width: u16le(b, 6), height: u16le(b, 8) };
  }
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a && ascii(b, 12, 16) === 'IHDR') {
    return { mime: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  const jpeg = jpegSize(b);
  if (jpeg) return { mime: 'image/jpeg', ...jpeg };
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') {
    const chunk = ascii(b, 12, 16);
    if (chunk === 'VP8X') return { mime: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { mime: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = u32le(b, 21);
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/**
 * Revisa un archivo elegido: { type, size } del File y sus primeros bytes (HEAD_BYTES). Devuelve { ok, value: { mime, ext, width, height } }
 * o { ok: false, error } con un código de communities.err_<error> (o communityplans.galleryErr_<error>).
 */
export function validateMediaFile(file, head) {
  const size = Number(file?.size) || 0;
  if (size < 1) return { ok: false, error: 'media_empty' };
  if (size > MEDIA_LIMITS.bytes) return { ok: false, error: 'too_big' };
  const seen = sniffImage(head);
  if (!seen || !MEDIA_TYPES[seen.mime] || (file?.type && file.type !== seen.mime)) return { ok: false, error: 'bad_type' };
  if (!seen.width || !seen.height || seen.width < MEDIA_LIMITS.min || seen.height < MEDIA_LIMITS.min || seen.width > MEDIA_LIMITS.max || seen.height > MEDIA_LIMITS.max) {
    return { ok: false, error: 'bad_dimensions' };
  }
  return { ok: true, value: { mime: seen.mime, ext: MEDIA_TYPES[seen.mime], width: seen.width, height: seen.height } };
}

/** Nombre sugerido a partir del nombre del archivo: sin extensión, en una línea y de hasta 40 caracteres. */
export function suggestMediaName(fileName) {
  const base = String(fileName ?? '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\u0000-\u001f\u007f<>_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...base].slice(0, MEDIA_LIMITS.name).join('');
}

/** Nombre para un GIF de KLIPY: su título, limpio y recortado; si no tiene, el texto de reemplazo que pasa quien llama. */
export function suggestKlipyName(gif, fallback = '') {
  return suggestMediaName(`${gif?.title ?? ''}.x`) || suggestMediaName(`${fallback}.x`);
}

/**
 * Argumentos de community_media_add_klipy para el GIF que devolvió el selector de KLIPY ({ url, still, slug, title }). La URL se valida
 * con isKlipyUrl (el servidor repite la regla); still y slug son opcionales y se descartan si no sirven.
 */
export function klipyAddArgs(communityId, gif, isKlipyUrl, fallbackName = '') {
  if (!isKlipyUrl?.(gif?.url)) return { ok: false, error: 'bad_media' };
  const name = suggestKlipyName(gif, fallbackName);
  if (!name) return { ok: false, error: 'bad_media_name' };
  return { ok: true, value: {
    p_community: communityId, p_name: name, p_url: gif.url,
    p_still: isKlipyUrl(gif.still) ? gif.still : null,
    p_slug: typeof gif.slug === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(gif.slug) ? gif.slug : null,
  } };
}

export const mediaPath = (communityId, mediaId, ext) => `${communityId}/${mediaId}.${ext}`;
export const isMediaId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? ''));
export const newMediaId = () => globalThis.crypto.randomUUID();

/** Estado en la interfaz: pendiente, aprobado, rechazado o retirado (cualquier otra cosa se trata como pendiente). */
export const safeStatus = (value) => (MEDIA_STATUSES.includes(value) ? value : 'pending');

/** Origen de un elemento de la galería: 'klipy' o 'upload' (cualquier otra cosa, como un archivo subido). */
export const safeSource = (value) => (value === 'klipy' ? 'klipy' : 'upload');

/** ¿Es animado? Lo dice el servidor; si falta, un GIF subido o uno de KLIPY (un WebP animado cuenta como fijo, límite conocido). */
export const itemAnimated = (item) => (typeof item?.animated === 'boolean' ? item.animated : safeSource(item?.source) === 'klipy' || item?.mime === 'image/gif');

/** Un GIF de un mensaje, a lo que dibuja la interfaz: { kind: 'klipy', url } | { kind: 'upload', path, name } | { kind: 'gone' }. */
export function viewMedia(media, isKlipyUrl) {
  if (!media || typeof media !== 'object') return null;
  if (media.kind === 'klipy') return isKlipyUrl(media.url) ? { kind: 'klipy', url: media.url, still: isKlipyUrl(media.still) ? media.still : null } : { kind: 'gone' };
  if (media.kind === 'upload') return !media.unavailable && typeof media.path === 'string' ? { kind: 'upload', id: media.id, path: media.path, name: String(media.name || ''), width: media.width, height: media.height } : { kind: 'gone' };
  return { kind: 'gone' };
}

/** Un elemento de community_media_list a lo que dibuja media-view.js (mediaImage); null si no hay nada que mostrar todavía. */
export function itemMedia(item) {
  if (!item || typeof item !== 'object') return null;
  if (safeSource(item.source) === 'klipy') return typeof item.url === 'string' ? { kind: 'klipy', url: item.url, still: item.still || null } : null;
  return typeof item.path === 'string' ? { kind: 'upload', id: item.id, path: item.path, name: item.name, width: item.width, height: item.height } : null;
}

/** ¿Quién ve el motivo y la ruta? El dueño y quien lo subió; el resto solo lo aprobado. */
export const canSeeDetails = (item, role) => item?.mine === true || role === 'owner';

/** Texto corto del tamaño de un elemento ("320×240 · 468 KB"); vacío si el servidor no lo sabe (un GIF de KLIPY no tiene medidas ni peso). */
export function itemSize(item) {
  const parts = [];
  if (item?.width > 0 && item?.height > 0) parts.push(`${item.width}×${item.height}`);
  if (item?.bytes > 0) parts.push(`${Math.max(1, Math.round(item.bytes / 1024))} KB`);
  return parts.join(' · ');
}
