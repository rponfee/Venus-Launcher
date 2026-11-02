// Temas compartibles: lógica pura (sin DOM ni Electron, con pruebas en test/codec.test.js).
// Un tema es solo apariencia, con la forma exacta de supabase/migrations/0022_temas.sql:
//   { accent, customColor, tint (0-100), background ('stars' | 'wallpaper'), wallpaper (id de la galería), bgDim, bgBlur }
// Nunca lleva rutas de la PC ni imágenes propias. El código para compartir es "VENUS-THEME:" + base64 del JSON.

export const PREFIX = 'VENUS-THEME:';
export const ACCENTS = ['venus', 'mars', 'neptune', 'jupiter', 'earth', 'saturn', 'custom'];
export const THEME_KEYS = ['accent', 'customColor', 'tint', 'background', 'wallpaper', 'bgDim', 'bgBlur'];
export const NAME_MIN = 2;
export const NAME_MAX = 40;
const MAX_JSON = 2047; // el servidor exige pg_column_size(data) < 2048
const MAX_CODE = 4096; // un código pegado más largo que esto no es un tema
const HEX = /^#[0-9a-fA-F]{6}$/;
const WALLPAPER_ID = /^[A-Za-z0-9._-]{1,80}$/;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, min, max) => isNum(v) && v >= min && v <= max;
const clampInt = (v, min, max, def) => (isNum(v) ? Math.min(max, Math.max(min, Math.round(v))) : def);

// Misma regla que private.theme_valid() del servidor. Devuelve el motivo del rechazo o null si es válido.
export function themeProblem(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'notObject';
  for (const k of Object.keys(d)) if (!THEME_KEYS.includes(k)) return 'unknownKey';
  if ('accent' in d && !ACCENTS.includes(d.accent)) return 'accent';
  if ('customColor' in d && !(typeof d.customColor === 'string' && HEX.test(d.customColor))) return 'customColor';
  if ('tint' in d && !inRange(d.tint, 0, 100)) return 'tint';
  if ('background' in d && !['stars', 'wallpaper'].includes(d.background)) return 'background';
  if ('wallpaper' in d && !(typeof d.wallpaper === 'string' && WALLPAPER_ID.test(d.wallpaper))) return 'wallpaper';
  if ('bgDim' in d && !inRange(d.bgDim, 0, 100)) return 'bgDim';
  if ('bgBlur' in d && !inRange(d.bgBlur, 0, 100)) return 'bgBlur';
  if (JSON.stringify(d).length > MAX_JSON) return 'tooBig';
  return null;
}

export const validTheme = (d) => themeProblem(d) === null;

// Nombre para publicar: igual que theme_publish (2 a 40 caracteres, sin caracteres de control ni < >).
export function cleanThemeName(name) {
  const v = String(name ?? '').trim();
  if (v.length < NAME_MIN || v.length > NAME_MAX) return null;
  if (/[\u0000-\u001f<>]/.test(v)) return null;
  return v;
}

/**
 * Tema a partir de los ajustes de Apariencia (settings.appearance, ya normalizados por appearance.js).
 * isWallpaper(id) dice si el id existe en la galería de Venus. Devuelve { theme, usedStars } donde usedStars
 * avisa que el fondo propio era una imagen o un video de la PC (o un fondo que ya no existe) y se cambió por
 * las estrellas: el archivo nunca sale de la PC.
 */
export function themeFromAppearance(ap = {}, { isWallpaper = () => true } = {}) {
  const a = ap && typeof ap === 'object' ? ap : {};
  const theme = {
    accent: ACCENTS.includes(a.accent) ? a.accent : 'venus',
    customColor: typeof a.customColor === 'string' && HEX.test(a.customColor) ? a.customColor.toLowerCase() : '#f29a2e',
    tint: a.tint === false ? 0 : 100,
    background: 'stars',
    bgDim: clampInt(a.bgDim, 0, 100, 45),
    bgBlur: clampInt(a.bgBlur, 0, 100, 0),
  };
  let usedStars = false;
  if (a.background === 'wallpaper') {
    const id = typeof a.wallpaperId === 'string' ? a.wallpaperId : '';
    if (WALLPAPER_ID.test(id) && isWallpaper(id)) {
      theme.background = 'wallpaper';
      theme.wallpaper = id;
    } else usedStars = true;
  } else if (a.background === 'image') usedStars = true;
  return { theme, usedStars };
}

/**
 * Cambios para settings.appearance a partir de un tema válido. Los rangos del launcher son más chicos que los
 * del servidor (oscurecer 0-90 %, desenfoque 0-24 px): se recortan. Un fondo de la galería que esta versión no
 * tiene pasa a estrellas con missingWallpaper: true. No toca la música ni la imagen propia guardada.
 */
export function appearanceFromTheme(theme, { isWallpaper = () => true } = {}) {
  const d = theme && typeof theme === 'object' ? theme : {};
  const patch = {
    accent: ACCENTS.includes(d.accent) ? d.accent : 'venus',
    tint: isNum(d.tint) ? d.tint > 0 : true,
    background: 'stars',
    bgDim: clampInt(d.bgDim, 0, 90, 45),
    bgBlur: clampInt(d.bgBlur, 0, 24, 0),
  };
  if (typeof d.customColor === 'string' && HEX.test(d.customColor)) patch.customColor = d.customColor.toLowerCase();
  else if (patch.accent === 'custom') patch.accent = 'venus';
  let missingWallpaper = false;
  if (d.background === 'wallpaper') {
    if (typeof d.wallpaper === 'string' && WALLPAPER_ID.test(d.wallpaper) && isWallpaper(d.wallpaper)) {
      patch.background = 'wallpaper';
      patch.wallpaperId = d.wallpaper;
    } else missingWallpaper = true;
  }
  return { patch, missingWallpaper };
}

// Solo las claves permitidas, en un orden fijo (el mismo tema da siempre el mismo código).
export function pickTheme(d) {
  const out = {};
  for (const k of THEME_KEYS) if (d && d[k] !== undefined) out[k] = d[k];
  return out;
}

function toBase64(text) {
  if (typeof btoa === 'function') return btoa(text);
  return Buffer.from(text, 'latin1').toString('base64');
}

function fromBase64(b64) {
  if (typeof atob === 'function') return atob(b64);
  return Buffer.from(b64, 'base64').toString('latin1');
}

// El JSON de un tema válido es ASCII (colores hex, ids de la galería y números).
export function encodeTheme(theme) {
  const d = pickTheme(theme);
  if (!validTheme(d)) throw Object.assign(new Error('bad_theme'), { code: 'invalid' });
  return PREFIX + toBase64(JSON.stringify(d));
}

/**
 * Lee un código pegado. Acepta espacios y saltos de línea, el prefijo en mayúsculas o minúsculas y base64
 * estándar o para URL, con o sin relleno. Devuelve { ok: true, theme } o { ok: false, code } con code:
 *   'empty' (no hay nada), 'notTheme' (no es un código de tema de Venus), 'damaged' (base64 o JSON roto),
 *   'invalid' (tiene claves o valores que el servidor rechazaría).
 */
export function decodeTheme(text) {
  const raw = String(text ?? '').replace(/\s+/g, '');
  if (!raw) return { ok: false, code: 'empty' };
  if (raw.length > MAX_CODE || raw.slice(0, PREFIX.length).toUpperCase() !== PREFIX) return { ok: false, code: 'notTheme' };
  let b64 = raw.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  if (!b64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { ok: false, code: 'damaged' };
  b64 = b64.replace(/=+$/, '');
  if (b64.length % 4 === 1) return { ok: false, code: 'damaged' };
  b64 += '='.repeat((4 - (b64.length % 4)) % 4);
  let data;
  try {
    data = JSON.parse(fromBase64(b64));
  } catch {
    return { ok: false, code: 'damaged' };
  }
  if (themeProblem(data)) return { ok: false, code: 'invalid' };
  return { ok: true, theme: pickTheme(data) };
}

// Dos temas son iguales si dan el mismo código.
export function sameTheme(a, b) {
  try {
    return JSON.stringify(pickTheme(a)) === JSON.stringify(pickTheme(b));
  } catch {
    return false;
  }
}

// Código de error del servidor (mensaje de la excepción de theme_publish/theme_delete) a una clave de texto.
export function serverErrorKey(err) {
  const msg = String(err?.message || err || '');
  for (const k of ['bad_name', 'bad_theme', 'too_many_themes', 'user_banned', 'user_muted', 'not_authenticated']) if (msg.includes(k)) return k;
  return null;
}

// Falta la migración 0022 (función o tabla inexistente) o el servicio no la conoce todavía.
export function isMissingSchema(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  return ['PGRST202', 'PGRST205', '42P01', '42883'].includes(code) || /schema cache|does not exist|Could not find the (function|table)/i.test(msg);
}
