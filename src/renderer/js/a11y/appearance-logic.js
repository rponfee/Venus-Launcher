// Lógica pura de Apariencia (sin DOM ni Electron, con pruebas en a11y/test/appearance-logic.test.js):
// valores por defecto y normalización de settings.appearance y settings.branding, temporadas automáticas,
// horario del tema claro, rotación de fondos y legibilidad del editor de colores. appearance.js la usa y
// reexporta PRESETS, APPEARANCE_DEFAULTS y BRANDING_DEFAULTS (contrato de docs/arquitectura.md).
import { WALLPAPERS, getWallpaper } from '../wallpapers.js';
import { parseColor, toHex, toOklch, fromOklch, contrast } from './color.js';

export const PRESETS = [
  { id: 'venus', color: '#f29a2e' },
  { id: 'mars', color: '#f0603c' },
  { id: 'neptune', color: '#3fa2ff' },
  { id: 'jupiter', color: '#f2c14e' },
  { id: 'earth', color: '#58c27d' },
  { id: 'saturn', color: '#a879f2' },
];

export const PALETTE_KEYS = ['bg', 'surface', 'text', 'border', 'accent'];
export const SCHEMES = ['dark', 'light', 'auto'];
export const PLAY_ANIMATIONS = ['none', 'pulse', 'shine'];
export const PLAY_SOUNDS = ['none', 'click', 'whoosh', 'bell'];
export const PLAY_LABEL_MAX = 16;
export const ROTATION_MAX = 40;
export const ROTATION_PRESETS = [5, 15, 30, 60, 120];
export const MIN_CONTRAST = 4.5;

// Temporadas: rango [desde, hasta] inclusive como [mes, día]; la primera de la lista gana si se superponen
// (Año Nuevo pisa a Navidad). Cada una trae su acento y un fondo recomendado de la galería.
export const SEASONS = [
  { id: 'newyear', from: [12, 31], to: [1, 2], accent: '#ffd34d', wallpaper: 'wallpaper-37' },
  { id: 'christmas', from: [12, 15], to: [1, 6], accent: '#e24b4b', wallpaper: 'wallpaper-05' },
  { id: 'halloween', from: [10, 24], to: [11, 1], accent: '#ff7a1a', wallpaper: 'wallpaper-28' },
];

export const APPEARANCE_DEFAULTS = {
  accent: 'venus', // id de PRESETS o 'custom'
  customColor: '#f29a2e',
  tint: true, // teñir fondos y textos con el tono del acento
  background: 'stars', // 'stars' | 'wallpaper' | 'image'
  // la primera imagen (los animados van primero en la galería, pero gastan más al elegir "Galería" sin mirar)
  wallpaperId: (WALLPAPERS.find((w) => !w.video) || WALLPAPERS[0])?.id || '',
  bgFile: '',
  bgDim: 45, // 0-90 %
  bgBlur: 0, // 0-24 px
  // Interfaz (3.0): bordes, densidad, menu lateral y tipografia de todo el launcher
  uiRadius: 'normal', // 'sharp' | 'normal' | 'round'
  uiDensity: 'normal', // 'compact' | 'normal' | 'spacious'
  uiSidebar: 'full', // 'full' | 'icons'
  uiFont: 'outfit', // 'outfit' | 'system' | 'rounded' | 'mono'
  uiGlass: 100, // 40-100: opacidad de las tarjetas (deja ver el fondo)
  lite: false, // modo liviano: sin fondos animados, animaciones ni desenfoques, y con el overlay apagado
  liteOverlay: false, // el overlay estaba prendido al activar el modo liviano (vuelve a prenderse al salir)
  music: { enabled: false, file: '', volume: 35, pauseInGame: true },
  // 3.1: editor de colores (hex o null = el de Venus), tema claro, temporadas, fondos rotativos y botón Jugar
  palette: { bg: null, surface: null, text: null, border: null, accent: null },
  scheme: 'dark', // 'dark' | 'light' | 'auto' (claro entre autoLightFrom y autoLightTo, hora local)
  autoLightFrom: '07:00',
  autoLightTo: '19:00',
  seasonal: false, // acento y fondo de temporada (Halloween, Navidad, Año Nuevo)
  seasonalBackup: null, // { season, accent, customColor, background, wallpaperId }: lo que había antes de la temporada
  rotation: { enabled: false, ids: [], everyMin: 30, onLaunch: true },
  playButton: { color: 'accent', label: '', animation: 'none', sound: 'none' },
};

export const BRANDING_DEFAULTS = {
  name: '', // vacio = Venus Launcher
  subtitle: 'LAUNCHER',
  logo: '', // imagen en data: (PNG reducido) para que no dependa del archivo original
  logoName: '',
  logoPixel: false,
  server: '', // "Tu servidor" (host[:puerto]), lo usa Inicio
};

export const NAME_MAX = 24;

// ---------- Ayudantes ----------
export function intIn(v, min, max, def) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export function isHex(s) {
  return /^#[0-9a-f]{6}$/i.test(String(s || ''));
}

export function str(v, max = 4096) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

const hexOrNull = (v) => (isHex(v) ? String(v).toLowerCase() : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// 'HH:MM' -> minutos desde las 0:00, o null si no es una hora válida
export function parseTime(s) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

export function formatTime(minutes) {
  const m = intIn(minutes, 0, 1439, 0);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function normalizeTime(v, def) {
  const m = parseTime(v);
  return m === null ? def : formatTime(m);
}

// ---------- Normalización ----------
export function normalizePalette(raw) {
  const r = obj(raw);
  const out = {};
  for (const k of PALETTE_KEYS) out[k] = hexOrNull(r[k]);
  return out;
}

export const paletteActive = (p) => PALETTE_KEYS.some((k) => p && p[k]);

export function normalizeRotation(raw) {
  const r = obj(raw);
  const ids = [];
  for (const id of Array.isArray(r.ids) ? r.ids : []) {
    if (typeof id === 'string' && getWallpaper(id) && !ids.includes(id) && ids.length < ROTATION_MAX) ids.push(id);
  }
  return {
    enabled: Boolean(r.enabled),
    ids,
    everyMin: intIn(r.everyMin, 1, 720, 30),
    onLaunch: r.onLaunch == null ? true : Boolean(r.onLaunch),
  };
}

export function cleanLabel(v, max = PLAY_LABEL_MAX) {
  return str(v, 200).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

export function normalizePlayButton(raw) {
  const r = obj(raw);
  return {
    color: hexOrNull(r.color) || 'accent',
    label: cleanLabel(r.label),
    animation: PLAY_ANIMATIONS.includes(r.animation) ? r.animation : 'none',
    sound: PLAY_SOUNDS.includes(r.sound) ? r.sound : 'none',
  };
}

export function normalizeSeasonalBackup(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!r || !SEASONS.some((s) => s.id === r.season)) return null;
  const accent = r.accent === 'custom' || PRESETS.some((p) => p.id === r.accent) ? r.accent : 'venus';
  return {
    season: r.season,
    accent,
    customColor: hexOrNull(r.customColor) || APPEARANCE_DEFAULTS.customColor,
    background: ['image', 'wallpaper'].includes(r.background) ? r.background : 'stars',
    wallpaperId: getWallpaper(r.wallpaperId)?.id || APPEARANCE_DEFAULTS.wallpaperId,
  };
}

export function normalizeAppearance(raw = {}) {
  const r = obj(raw);
  const m = obj(r.music);
  const out = { ...APPEARANCE_DEFAULTS, ...r, music: { ...APPEARANCE_DEFAULTS.music, ...m } };
  if (out.accent !== 'custom' && !PRESETS.some((p) => p.id === out.accent)) out.accent = 'venus';
  out.customColor = isHex(out.customColor) ? out.customColor.toLowerCase() : APPEARANCE_DEFAULTS.customColor;
  out.tint = out.tint !== false;
  out.background = ['image', 'wallpaper'].includes(out.background) ? out.background : 'stars';
  out.wallpaperId = getWallpaper(out.wallpaperId)?.id || APPEARANCE_DEFAULTS.wallpaperId;
  if (out.background === 'wallpaper' && !out.wallpaperId) out.background = 'stars';
  out.bgFile = str(out.bgFile);
  out.bgDim = intIn(out.bgDim, 0, 90, 45);
  out.bgBlur = intIn(out.bgBlur, 0, 24, 0);
  out.uiRadius = ['sharp', 'round'].includes(out.uiRadius) ? out.uiRadius : 'normal';
  out.uiDensity = ['compact', 'spacious'].includes(out.uiDensity) ? out.uiDensity : 'normal';
  out.uiSidebar = out.uiSidebar === 'icons' ? 'icons' : 'full';
  out.uiFont = ['system', 'rounded', 'mono'].includes(out.uiFont) ? out.uiFont : 'outfit';
  out.uiGlass = intIn(out.uiGlass, 40, 100, 100);
  out.lite = Boolean(out.lite);
  out.liteOverlay = Boolean(out.liteOverlay);
  out.music = {
    enabled: Boolean(out.music.enabled),
    file: str(out.music.file),
    volume: intIn(out.music.volume, 0, 100, 35),
    pauseInGame: out.music.pauseInGame !== false,
  };
  out.palette = normalizePalette(out.palette);
  out.scheme = SCHEMES.includes(out.scheme) ? out.scheme : 'dark';
  out.autoLightFrom = normalizeTime(out.autoLightFrom, APPEARANCE_DEFAULTS.autoLightFrom);
  out.autoLightTo = normalizeTime(out.autoLightTo, APPEARANCE_DEFAULTS.autoLightTo);
  out.seasonal = Boolean(out.seasonal);
  out.seasonalBackup = normalizeSeasonalBackup(out.seasonalBackup);
  out.rotation = normalizeRotation(out.rotation);
  out.playButton = normalizePlayButton(out.playButton);
  return out;
}

export function normalizeBranding(raw = {}) {
  const r = obj(raw);
  const out = { ...BRANDING_DEFAULTS, ...r };
  out.name = str(out.name, NAME_MAX);
  out.subtitle = typeof out.subtitle === 'string' ? out.subtitle.slice(0, NAME_MAX) : BRANDING_DEFAULTS.subtitle;
  out.logo = /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(out.logo || '') ? out.logo : '';
  out.logoName = str(out.logoName, 200);
  out.logoPixel = Boolean(out.logoPixel);
  out.server = str(out.server, 260).trim();
  return out;
}

// Copia nueva de los valores por defecto (los objetos anidados no se comparten)
export function appearanceDefaults() {
  return normalizeAppearance({});
}

export function accentColor(a) {
  if (a.accent === 'custom') return a.customColor;
  return PRESETS.find((p) => p.id === a.accent)?.color || PRESETS[0].color;
}

// ---------- Tema claro ----------
// ¿Es de día? [from, to) en hora local; un rango que cruza la medianoche (21:00 a 07:00) también vale.
export function lightNow(now, from, to) {
  const f = parseTime(from);
  const tt = parseTime(to);
  if (f === null || tt === null || f === tt) return false;
  const m = now instanceof Date ? now.getHours() * 60 + now.getMinutes() : parseTime(now);
  if (m === null) return false;
  return f < tt ? m >= f && m < tt : m >= f || m < tt;
}

// 'dark' | 'light' según el ajuste (auto mira la hora local)
export function effectiveScheme(ap, now = new Date()) {
  if (ap.scheme === 'light') return 'light';
  if (ap.scheme === 'auto') return lightNow(now, ap.autoLightFrom, ap.autoLightTo) ? 'light' : 'dark';
  return 'dark';
}

// ---------- Temporadas ----------
function inSeason(md, [fm, fd], [tm, td]) {
  const from = fm * 100 + fd;
  const to = tm * 100 + td;
  return from <= to ? md >= from && md <= to : md >= from || md <= to;
}

// id de la temporada vigente en esa fecha (hora local) o null
export function seasonFor(date = new Date()) {
  const md = (date.getMonth() + 1) * 100 + date.getDate();
  for (const s of SEASONS) if (inSeason(md, s.from, s.to)) return s.id;
  return null;
}

export const seasonById = (id) => SEASONS.find((s) => s.id === id) || null;

// ---------- Fondos rotativos ----------
// El que sigue al actual en la lista (vuelve al principio); el primero si el actual no está. null sin fondos.
export function nextRotation(ids, current) {
  const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  if (!list.length) return null;
  const i = list.indexOf(current);
  return list[(i + 1) % list.length];
}

// ---------- Editor de colores ----------
// Texto que se lee sobre ese fondo: si el contraste WCAG baja de 4.5 se aclara u oscurece (según el fondo)
// conservando el tono. Devuelve el hex aplicado (igual al pedido si ya se leía bien).
export function legibleText(textHex, bgHex, min = MIN_CONTRAST) {
  const text = parseColor(textHex);
  const bg = parseColor(bgHex);
  if (!text || !bg) return isHex(textHex) ? String(textHex).toLowerCase() : null;
  if (contrast(text, bg) >= min) return toHex(text);
  const lch = toOklch(text);
  const darkBg = toOklch(bg).l < 0.5;
  let best = null;
  for (let i = 1; i <= 40; i++) {
    const l = darkBg ? lch.l + (1 - lch.l) * (i / 40) : lch.l * (1 - i / 40);
    // se comprueba el hex ya redondeado: es lo que se va a aplicar
    best = toHex(fromOklch({ l, c: lch.c, h: lch.h }));
    if (contrast(parseColor(best), bg) >= min) break;
  }
  return best;
}

// Paleta lista para aplicar: el texto corregido contra el fondo elegido (o el del esquema).
// Devuelve { palette, adjustedText } donde adjustedText es el hex corregido o null si no hizo falta.
export function legiblePalette(palette, defaultBg) {
  const p = normalizePalette(palette);
  const bg = p.bg || (isHex(defaultBg) ? defaultBg : null);
  if (!p.text || !bg) return { palette: p, adjustedText: null };
  const fixed = legibleText(p.text, bg);
  if (!fixed || fixed === p.text) return { palette: p, adjustedText: null };
  return { palette: { ...p, text: fixed }, adjustedText: fixed };
}
