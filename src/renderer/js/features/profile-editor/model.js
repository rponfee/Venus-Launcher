// Logica pura de los perfiles de Venus (sin DOM ni imports, para probarla con Node): normalizar el perfil que
// llega en camelCase (profile_public) o crudo de la tabla profiles (snake_case), validar igual que
// profile_customize (supabase/migrations/0020_perfiles.sql), armar el patch con solo lo que cambio, el CSS del
// fade y de los banners prediseñados, y cuentas chicas para las imagenes.
// La usan social/profile-style.js, social/profile-ui.js y features/profile-editor.js.
import { EXTRA_FONTS } from './fonts.js';

// ---------- Catalogo (lo mismo que conoce el servidor) ----------
export const BASIC_FONTS = ['default', 'pixel', 'outfit', 'serif', 'mono', 'rounded', 'condensed'];
export const FONTS = [...BASIC_FONTS, ...EXTRA_FONTS.map((f) => f.id)];
export const EFFECTS = ['none', 'glow', 'gradient', 'shimmer', 'rainbow', 'fire', 'neon', 'ice', 'ocean', 'sakura', 'toxic', 'vapor', 'gold', 'galaxy', 'glitch', 'season1'];
export const PREMIUM_EFFECTS = ['shimmer', 'rainbow', 'fire', 'neon', 'ice', 'ocean', 'sakura', 'toxic', 'vapor', 'gold', 'galaxy', 'glitch'];
// Efectos del Venus Pass: solo con el item (Premium no los incluye)
export const PASS_EFFECTS = ['season1'];
export const BANNER_PRESETS = ['stars', 'sunset', 'nebula', 'forest', 'ocean', 'nether', 'end', 'aurora', 'cherry', 'desert', 'snow', 'deepdark', 'lush', 'mesa', 'mushroom', 'void'];
export const FRAMES = ['pixel', 'neon', 'gold', 'venus', 'ice', 'emerald', 'amethyst', 'redstone', 'fire', 'ender', 'rainbow', 'diamond', 'cosmic', 'season1', 'season1legend', 'season1free', 'max', 'pulse', 'orbit', 'halloween', 'xmas'];
export const TITLES = ['explorer', 'builder', 'redstoner', 'legend', 'supporter', 'miner', 'farmer', 'architect', 'modder', 'streamer', 'pvp', 'nightowl', 'speedrunner', 'collector', 'hardcore', 'veteran', 'vip', 'season1', 'traveler', 'pro'];
// Venus 3.1: tema de la tarjeta, burbujas de chat, efecto de entrada en voz, poses y fondos de la skin
export const CARD_THEMES = ['none', 'nether', 'end', 'ocean', 'cherry', 'space', 'aurora'];
export const BUBBLE_STYLES = ['default', 'round', 'pixel', 'sharp'];
export const ENTRY_EFFECTS = ['none', 'spark', 'nether', 'ender', 'snow'];
export const SKIN_POSES = ['stand', 'wave', 'sit', 'walk'];
export const SKIN_BGS = ['none', 'sunset', 'cave', 'end', 'snow'];
// Vencimiento del estado: minutos (null = nunca; 'today' = hasta la medianoche local)
export const STATUS_DURATIONS = ['30m', '1h', '4h', 'today', 'never'];
// Grilla de emojis del estado (60, sin librerias)
export const STATUS_EMOJIS = [
  '😀', '😄', '😂', '🤣', '😊', '😉', '😍', '😎', '🤩', '🥳', '😅', '😇', '🙂', '🤔', '😴', '😮',
  '😱', '😢', '😭', '😡', '🤯', '🥺', '😏', '🤝', '👍', '👏', '🙌', '🙏', '💪', '👋', '❤️', '🧡',
  '💛', '💚', '💙', '💜', '🔥', '✨', '⭐', '🎉', '💯', '✅', '⚔️', '🛡️', '⛏️', '🏹', '💎', '🧱',
  '🌲', '🐷', '🐺', '🧟', '💀', '👾', '🎮', '🏠', '🌙', '☀️', '🍕', '🚀',
];
export const BADGE_STYLES = ['nebula', 'ice', 'gold'];
export const EQUIP_SLOTS = ['frame', 'nameEffect', 'badgeStyle', 'title'];
export const PATCH_FIELDS = ['pronouns', 'bio', 'theme', 'nameStyle', 'banner', 'favoriteServers', 'publicStats', 'featured', 'equipped', 'cardStyle', 'links', 'showcase'];
// Rangos (solo los da un admin, admin_set_rank) y estilo de la tarjeta
export const RANKS = ['owner', 'admin', 'mod', 'helper'];
export const CARD_PATTERNS = ['none', 'dots', 'grid', 'stripes', 'stars', 'pixels', 'waves', 'hex', 'circuit'];
export const AVATAR_SHAPES = ['square', 'round', 'hex'];
export const CARD_LAYOUTS = ['classic', 'center'];
// Redes del perfil: solo estos sitios (igual que private.profile_link_ok)
export const LINK_KINDS = {
  youtube: '(youtube\\.com|youtu\\.be)',
  twitch: 'twitch\\.tv',
  kick: 'kick\\.com',
  tiktok: 'tiktok\\.com',
  x: '(x\\.com|twitter\\.com)',
  instagram: 'instagram\\.com',
  github: 'github\\.com',
  discord: '(discord\\.gg|discord\\.com)',
  modrinth: 'modrinth\\.com',
  curseforge: 'curseforge\\.com',
};
// Tipo de shop_items de cada lugar de equipped
export const SLOT_KIND = { frame: 'frame', nameEffect: 'name_effect', badgeStyle: 'badge_style', title: 'title' };

// Copia de los cosmeticos de 0021 (por si la tabla shop_items no responde): id, tipo, precio, solo premium y estilo
export const SHOP_CATALOG = [
  { id: 'frame_pixel', kind: 'frame', price: 500, premiumOnly: false, style: 'pixel' },
  { id: 'frame_neon', kind: 'frame', price: 800, premiumOnly: false, style: 'neon' },
  { id: 'frame_gold', kind: 'frame', price: 1500, premiumOnly: false, style: 'gold' },
  { id: 'frame_venus', kind: 'frame', price: 0, premiumOnly: true, style: 'venus' },
  { id: 'effect_shimmer', kind: 'name_effect', price: 1200, premiumOnly: false, style: 'shimmer' },
  { id: 'effect_rainbow', kind: 'name_effect', price: 2000, premiumOnly: false, style: 'rainbow' },
  { id: 'effect_fire', kind: 'name_effect', price: 2500, premiumOnly: false, style: 'fire' },
  { id: 'badge_nebula', kind: 'badge_style', price: 1000, premiumOnly: false, style: 'nebula' },
  { id: 'badge_ice', kind: 'badge_style', price: 1000, premiumOnly: false, style: 'ice' },
  { id: 'badge_gold', kind: 'badge_style', price: 0, premiumOnly: true, style: 'gold' },
  { id: 'title_explorer', kind: 'title', price: 300, premiumOnly: false, style: 'explorer' },
  { id: 'title_builder', kind: 'title', price: 300, premiumOnly: false, style: 'builder' },
  { id: 'title_redstoner', kind: 'title', price: 600, premiumOnly: false, style: 'redstoner' },
  { id: 'title_legend', kind: 'title', price: 3000, premiumOnly: false, style: 'legend' },
  { id: 'title_supporter', kind: 'title', price: 0, premiumOnly: true, style: 'supporter' },
  // Cosmeticos de la 3.0 (0023)
  { id: 'frame_ice', kind: 'frame', price: 900, premiumOnly: false, style: 'ice' },
  { id: 'frame_emerald', kind: 'frame', price: 1000, premiumOnly: false, style: 'emerald' },
  { id: 'frame_amethyst', kind: 'frame', price: 1000, premiumOnly: false, style: 'amethyst' },
  { id: 'frame_redstone', kind: 'frame', price: 1100, premiumOnly: false, style: 'redstone' },
  { id: 'frame_fire', kind: 'frame', price: 1400, premiumOnly: false, style: 'fire' },
  { id: 'frame_ender', kind: 'frame', price: 1600, premiumOnly: false, style: 'ender' },
  { id: 'frame_rainbow', kind: 'frame', price: 2200, premiumOnly: false, style: 'rainbow' },
  { id: 'frame_diamond', kind: 'frame', price: 3000, premiumOnly: false, style: 'diamond' },
  { id: 'frame_cosmic', kind: 'frame', price: 0, premiumOnly: true, style: 'cosmic' },
  { id: 'effect_neon', kind: 'name_effect', price: 1200, premiumOnly: false, style: 'neon' },
  { id: 'effect_ice', kind: 'name_effect', price: 1200, premiumOnly: false, style: 'ice' },
  { id: 'effect_ocean', kind: 'name_effect', price: 1200, premiumOnly: false, style: 'ocean' },
  { id: 'effect_sakura', kind: 'name_effect', price: 1300, premiumOnly: false, style: 'sakura' },
  { id: 'effect_toxic', kind: 'name_effect', price: 1400, premiumOnly: false, style: 'toxic' },
  { id: 'effect_vapor', kind: 'name_effect', price: 1500, premiumOnly: false, style: 'vapor' },
  { id: 'effect_gold', kind: 'name_effect', price: 2200, premiumOnly: false, style: 'gold' },
  { id: 'effect_galaxy', kind: 'name_effect', price: 2600, premiumOnly: false, style: 'galaxy' },
  { id: 'effect_glitch', kind: 'name_effect', price: 2800, premiumOnly: false, style: 'glitch' },
  { id: 'title_miner', kind: 'title', price: 300, premiumOnly: false, style: 'miner' },
  { id: 'title_farmer', kind: 'title', price: 300, premiumOnly: false, style: 'farmer' },
  { id: 'title_architect', kind: 'title', price: 400, premiumOnly: false, style: 'architect' },
  { id: 'title_modder', kind: 'title', price: 400, premiumOnly: false, style: 'modder' },
  { id: 'title_streamer', kind: 'title', price: 500, premiumOnly: false, style: 'streamer' },
  { id: 'title_pvp', kind: 'title', price: 500, premiumOnly: false, style: 'pvp' },
  { id: 'title_nightowl', kind: 'title', price: 700, premiumOnly: false, style: 'nightowl' },
  { id: 'title_speedrunner', kind: 'title', price: 800, premiumOnly: false, style: 'speedrunner' },
  { id: 'title_collector', kind: 'title', price: 1000, premiumOnly: false, style: 'collector' },
  { id: 'title_hardcore', kind: 'title', price: 1200, premiumOnly: false, style: 'hardcore' },
  { id: 'title_veteran', kind: 'title', price: 2000, premiumOnly: false, style: 'veteran' },
  { id: 'title_vip', kind: 'title', price: 0, premiumOnly: true, style: 'vip' },
  // Marcos de la 3.1 (0027): animados y de temporada (se venden todo el año)
  { id: 'frame_pulse', kind: 'frame', price: 1800, premiumOnly: false, style: 'pulse' },
  { id: 'frame_orbit', kind: 'frame', price: 2400, premiumOnly: false, style: 'orbit' },
  { id: 'frame_halloween', kind: 'frame', price: 1200, premiumOnly: false, style: 'halloween' },
  { id: 'frame_xmas', kind: 'frame', price: 1200, premiumOnly: false, style: 'xmas' },
];

export const LIMITS = {
  pronouns: 24,
  bio: 200,
  displayName: 32,
  favoriteServers: 5,
  serverName: 40,
  featured: 6,
  featuredTitle: 60,
  links: 5,
  linkUrl: 200,
  pinnedAchievements: 6,
  pinnedClips: 2,
  files: 12,
  fileBytes: 4 * 1024 * 1024,
  bannerW: 1200,
  bannerH: 300,
  featuredW: 1600,
  featuredH: 900,
  mediaUrl: 400,
  // 3.1
  rareBadges: 3,
  songTitle: 60,
  songBytes: 1024 * 1024,
  songSourceBytes: 20 * 1024 * 1024,
  songSeconds: 30,
  statusText: 80,
  statusBody: 70,
  guestbook: 200,
  guestbookPerDay: 5,
  giftMin: 10,
  giftMax: 500,
  giftDaily: 1000,
  reportText: 300,
};

// Pares de colores sugeridos para el fade y colores sugeridos para el nombre
export const FADE_PRESETS = [
  { from: '#f29a2e', to: '#3b1450' },
  { from: '#ff7a59', to: '#6b2a5e' },
  { from: '#2a7fd4', to: '#0e2a52' },
  { from: '#3f9a3a', to: '#12301a' },
  { from: '#a64dd6', to: '#1a1030' },
  { from: '#ff7eb3', to: '#4a1d6b' },
  { from: '#3fcfc0', to: '#173a63' },
  { from: '#d32f2f', to: '#2a0c08' },
  { from: '#ffd27a', via: '#ff7a59', to: '#3b1450' },
  { from: '#7df9ff', via: '#b06bff', to: '#ff4fd8' },
  { from: '#9be36a', via: '#3fcfc0', to: '#173a63' },
  { from: '#fff1a8', via: '#f0b429', to: '#8a5a12' },
  { from: '#c4f4ff', via: '#5aa7f0', to: '#1a1030' },
  { from: '#ff7eb3', via: '#c58cff', to: '#7fb2ff' },
];
export const NAME_COLORS = ['#ffe6b0', '#ffc562', '#ff8a5c', '#ff7eb3', '#c58cff', '#7fb2ff', '#6fe0d0', '#9be36a', '#ffffff'];
export const DEFAULT_NAME_COLOR = '#ffe6b0';

// ---------- Ayudas ----------
const HEX = /^#[0-9a-fA-F]{6}$/;
const CONTROL_OR_TAGS = /[\u0000-\u001f<>]/;
const CONTROL = new RegExp(`[\u0000-\u001f\u007f${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const SERVER_ADDRESS = /^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/;
const MEDIA_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const KLIPY_URL = /^https:\/\/static[0-9]*\.klipy\.com\/[A-Za-z0-9/._~-]+(\?[A-Za-z0-9=&._~%-]*)?$/;
const KLIPY_SLUG = /^[A-Za-z0-9_-]{1,120}$/;
const ACH_ID = /^[a-z0-9_]{2,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isHex = (v) => typeof v === 'string' && HEX.test(v);
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v : null);
const pick = (raw, ...keys) => {
  for (const k of keys) if (raw && raw[k] !== undefined) return raw[k];
  return undefined;
};
// Texto de otro usuario para mostrar: sin caracteres de control, recortado
export function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(CONTROL, '').trim().slice(0, max) : '';
}

export function isServerAddress(v) {
  return typeof v === 'string' && SERVER_ADDRESS.test(v);
}

// URL publica de profile-media (de cualquier usuario si no se pasa userId). Igual que private.own_media_url.
export function isProfileMediaUrl(url, userId = null) {
  if (typeof url !== 'string' || url.length > LIMITS.mediaUrl) return false;
  const m = /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/profile-media\/([0-9a-fA-F-]{36})\/([A-Za-z0-9._-]{1,80})$/.exec(url);
  if (!m || !UUID.test(m[1])) return false;
  return userId ? m[1].toLowerCase() === String(userId).toLowerCase() : true;
}

// Direccion de un GIF de KLIPY tal como la devuelve su API (igual que private.klipy_url)
export const isKlipyUrl = (url) => typeof url === 'string' && url.length <= 400 && KLIPY_URL.test(url);

// URL publica de la cancion del perfil en profile-audio (igual que private.profile_audio_url): <uid>/song.webm (+ ?v=)
export function isProfileAudioUrl(url, userId = null) {
  if (typeof url !== 'string' || url.length > 300) return false;
  const m = /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/profile-audio\/([0-9a-fA-F-]{36})\/song\.webm(\?v=[0-9]{1,16})?$/.exec(url);
  if (!m || !UUID.test(m[1])) return false;
  return userId ? m[1].toLowerCase() === String(userId).toLowerCase() : true;
}
// Nombre fijo del archivo en el bucket (la politica solo acepta ese) y la URL con marca para refrescar la cache
export const AUDIO_FILE = 'song.webm';
export const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/webm', 'audio/aac'];
export const AUDIO_EXTS = ['mp3', 'ogg', 'oga', 'wav', 'm4a', 'webm', 'aac'];
export const audioFileName = () => AUDIO_FILE;
export function audioUrlWithVersion(url, now = Date.now()) {
  const base = String(url || '').replace(/\?v=[0-9]+$/, '');
  return `${base}?v=${Math.floor(now)}`;
}
// Archivo de audio aceptable para la cancion (por tipo o extension) y de hasta 20 MB. Devuelve null o un codigo de error.
export function audioSourceError(file) {
  if (!file || typeof file !== 'object') return 'type';
  const name = String(file.name || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const type = String(file.type || '').toLowerCase().split(';')[0];
  if (!(AUDIO_TYPES.includes(type) || (!type && AUDIO_EXTS.includes(ext)) || (type.startsWith('audio/') && AUDIO_EXTS.includes(ext)))) return 'type';
  if (!(file.size > 0)) return 'decode';
  if (file.size > LIMITS.songSourceBytes) return 'too_big';
  return null;
}

// Red del perfil: https y uno de los sitios conocidos (igual que private.profile_link_ok)
export function isProfileLink(kind, url) {
  if (typeof url !== 'string' || url.length > LIMITS.linkUrl || !Object.hasOwn(LINK_KINDS, kind)) return false;
  return new RegExp(`^https://(www\\.)?${LINK_KINDS[kind]}/[A-Za-z0-9@._~/?=&%+-]{1,160}$`).test(url);
}

// Vista previa local (imagen todavia sin subir o datos de ejemplo de las capturas)
const isLocalMedia = (url) => typeof url === 'string' && /^(blob:|data:image\/(png|jpeg|webp|gif);base64,)/.test(url) && url.length < 4_000_000;

export function mediaPathFromUrl(url) {
  const m = /\/profile-media\/([0-9a-fA-F-]{36})\/([A-Za-z0-9._-]{1,80})$/.exec(String(url || ''));
  return m ? { userId: m[1], name: m[2], path: `${m[1]}/${m[2]}` } : null;
}

// Igualdad profunda de valores JSON
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

// 'frame_neon' o 'neon' -> 'neon' (si es conocido)
function styleFromItem(value, prefix, known) {
  if (typeof value !== 'string') return null;
  const v = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return known.includes(v) ? v : null;
}
export const frameStyle = (id) => styleFromItem(id, 'frame_', FRAMES);
export const titleStyle = (id) => styleFromItem(id, 'title_', TITLES);
export const badgeStyleId = (id) => styleFromItem(id, 'badge_', BADGE_STYLES);
export const effectFromItem = (id) => styleFromItem(id, 'effect_', PREMIUM_EFFECTS);

// ---------- Normalizar ----------
const sanitizeTheme = (v) => {
  if (!isObj(v)) return null;
  const from = isHex(v.from) ? v.from.toLowerCase() : null;
  const to = isHex(v.to) ? v.to.toLowerCase() : null;
  const a = num(v.angle);
  if (!from && !to) return null;
  const out = { from: from || to, to: to || from, angle: a !== null && a >= 0 && a <= 360 ? Math.round(a) : 135 };
  if (isHex(v.via)) out.via = v.via.toLowerCase();
  return out;
};

const sanitizeNameStyle = (v) => {
  const s = isObj(v) ? v : {};
  const glow = num(s.glow);
  return {
    font: FONTS.includes(s.font) ? s.font : 'default',
    effect: EFFECTS.includes(s.effect) ? s.effect : 'none',
    color: isHex(s.color) ? s.color.toLowerCase() : null,
    glow: glow !== null && glow >= 0 && glow <= 100 ? Math.round(glow) : 0,
    caps: s.caps === true,
    italic: s.italic === true,
    outline: s.outline === true,
  };
};

const sanitizeSong = (v) => {
  if (!isObj(v) || !isProfileAudioUrl(v.url)) return null;
  const title = cleanText(v.title, LIMITS.songTitle).replace(/[<>]/g, '');
  return title ? { url: v.url, title } : { url: v.url };
};
const sanitizeCardStyle = (v) => {
  const s = isObj(v) ? v : {};
  const theme = isObj(s.theme) ? s.theme : {};
  const bubble = isObj(s.bubble) ? s.bubble : {};
  return {
    pattern: CARD_PATTERNS.includes(s.pattern) ? s.pattern : 'none',
    avatar: AVATAR_SHAPES.includes(s.avatar) ? s.avatar : 'square',
    layout: CARD_LAYOUTS.includes(s.layout) ? s.layout : 'classic',
    accent: isHex(s.accent) ? s.accent.toLowerCase() : null,
    theme: { id: CARD_THEMES.includes(theme.id) ? theme.id : 'none', particles: theme.particles === true },
    bubble: { style: BUBBLE_STYLES.includes(bubble.style) ? bubble.style : 'default', color: isHex(bubble.color) ? bubble.color.toLowerCase() : null },
    entry: ENTRY_EFFECTS.includes(s.entry) ? s.entry : 'none',
    song: sanitizeSong(s.song),
    guestbook: s.guestbook === true,
  };
};

const sanitizeLinks = (v) =>
  (Array.isArray(v) ? v : [])
    .filter((l) => isObj(l) && isProfileLink(l.kind, l.url))
    .slice(0, LIMITS.links)
    .map((l) => ({ kind: l.kind, url: l.url }));

// Vitrina: en profile_public trae los logros y clips resueltos; en el editor, solo los ids
const sanitizeShowcase = (v) => {
  const s = isObj(v) ? v : {};
  const achievements = (Array.isArray(s.achievements) ? s.achievements : [])
    .map((a) => (typeof a === 'string' ? { id: a } : isObj(a) ? { id: a.id, at: str(a.at) } : null))
    .filter((a) => a && typeof a.id === 'string' && ACH_ID.test(a.id))
    .slice(0, LIMITS.pinnedAchievements);
  const clips = (Array.isArray(s.clips) ? s.clips : [])
    .map((c) => (typeof c === 'string' ? { id: c } : isObj(c) ? { id: c.id, url: str(c.url), title: cleanText(c.title, 120), expiresAt: str(c.expiresAt) } : null))
    .filter((c) => c && typeof c.id === 'string' && UUID.test(c.id))
    .slice(0, LIMITS.pinnedClips);
  const rareBadges = (Array.isArray(s.rareBadges) ? s.rareBadges : [])
    .map((a) => (typeof a === 'string' ? { id: a } : isObj(a) ? { id: a.id, at: str(a.at) } : null))
    .filter((a) => a && typeof a.id === 'string' && ACH_ID.test(a.id))
    .slice(0, LIMITS.rareBadges);
  return {
    achievements,
    clips,
    skin: s.skin === true,
    skinPose: SKIN_POSES.includes(s.skinPose) ? s.skinPose : 'stand',
    skinBg: SKIN_BGS.includes(s.skinBg) ? s.skinBg : 'none',
    rareBadges,
  };
};

const sanitizeBanner = (v, opts) => {
  if (!isObj(v)) return { kind: 'none' };
  if (v.kind === 'preset' && BANNER_PRESETS.includes(v.preset)) return { kind: 'preset', preset: v.preset };
  if ((v.kind === 'image' || v.kind === 'animated') && (isProfileMediaUrl(v.url) || (opts.allowLocalMedia && isLocalMedia(v.url)))) return { kind: v.kind, url: v.url };
  if (v.kind === 'klipy' && isKlipyUrl(v.url)) {
    const out = { kind: 'klipy', url: v.url };
    if (isKlipyUrl(v.still)) out.still = v.still;
    if (typeof v.slug === 'string' && KLIPY_SLUG.test(v.slug)) out.slug = v.slug;
    return out;
  }
  return { kind: 'none' };
};

const sanitizeServers = (v) =>
  (Array.isArray(v) ? v : [])
    .filter((s) => isObj(s) && isServerAddress(s.address))
    .slice(0, LIMITS.favoriteServers)
    .map((s) => {
      const name = cleanText(s.name, LIMITS.serverName).replace(/[<>]/g, '');
      return name ? { address: s.address.toLowerCase(), name } : { address: s.address.toLowerCase() };
    });

// Estadisticas de mas en la vitrina (ver publicStatsFromReport)
export const EXTRA_STATS = ['daysPlayed', 'bestStreak', 'longestHours', 'versions', 'loaders', 'instances', 'worlds', 'blocks', 'mobs', 'deaths', 'distanceKm'];
const sanitizeStats = (v) => {
  if (!isObj(v)) return null;
  const out = {};
  const hours = num(v.hours);
  const sessions = num(v.sessions);
  if (hours !== null && hours >= 0 && hours <= 1_000_000) out.hours = hours;
  if (sessions !== null && sessions >= 0 && sessions <= 10_000_000) out.sessions = Math.round(sessions);
  const tv = cleanText(v.topVersion, 32);
  const tl = cleanText(v.topLoader, 16);
  const since = cleanText(v.since, 32);
  if (tv) out.topVersion = tv;
  if (tl) out.topLoader = tl;
  if (since) out.since = since;
  for (const k of EXTRA_STATS) {
    const x = num(v[k]);
    if (x !== null && x >= 0 && x <= 1e12) out[k] = x;
  }
  if (typeof v.updatedAt === 'string') out.updatedAt = v.updatedAt.slice(0, 40);
  return Object.keys(out).length ? out : null;
};

const sanitizeFeatured = (v, opts) =>
  (Array.isArray(v) ? v : [])
    .filter((f) => isObj(f) && (isProfileMediaUrl(f.url) || (opts.allowLocalMedia && isLocalMedia(f.url))))
    .slice(0, LIMITS.featured)
    .map((f) => {
      const title = cleanText(f.title, LIMITS.featuredTitle);
      return title ? { url: f.url, title } : { url: f.url };
    });

const sanitizeEquipped = (v) => {
  const e = isObj(v) ? v : {};
  const out = {};
  for (const slot of EQUIP_SLOTS) {
    const id = typeof e[slot] === 'string' && /^[a-z0-9_-]{2,40}$/.test(e[slot]) ? e[slot] : null;
    if (id) out[slot] = id;
  }
  return out;
};

/**
 * Perfil en una sola forma, venga de profile_public (camelCase) o de la tabla profiles (snake_case).
 * `banner` en camelCase es el objeto de banner_style; en snake_case es el banner viejo (texto: preset o colores).
 * opts.allowLocalMedia: acepta blob:/data: en banner y destacadas (vista previa del editor y capturas).
 */
export function normalizeProfile(raw, opts = {}) {
  const r = isObj(raw) ? raw : {};
  const bannerRaw = pick(r, 'banner_style', 'bannerStyle');
  const legacy = typeof r.banner === 'string' ? r.banner : typeof r.legacyBanner === 'string' ? r.legacyBanner : null;
  const bannerObj = bannerRaw !== undefined ? bannerRaw : isObj(r.banner) ? r.banner : null;
  const styleKeys = ['nameStyle', 'name_style', 'theme', 'equipped', 'banner_style', 'bannerStyle', 'cardStyle', 'card_style'];
  const badges = pick(r, 'badges');
  const display = cleanText(pick(r, 'displayName', 'display_name'), LIMITS.displayName);
  const username = cleanText(pick(r, 'username'), 32);
  return {
    id: str(r.id),
    username,
    displayName: display,
    name: display || username,
    friendCode: cleanText(pick(r, 'friendCode', 'friend_code'), 16),
    mcName: cleanText(pick(r, 'mcName', 'mc_name'), 16),
    mcUuid: cleanText(pick(r, 'mcUuid', 'mc_uuid'), 36),
    bio: cleanText(r.bio, LIMITS.bio) || null,
    statusText: liveStatusText(cleanText(pick(r, 'statusText', 'status_text'), LIMITS.statusText), pick(r, 'statusUntil', 'status_until')),
    statusUntil: str(pick(r, 'statusUntil', 'status_until')),
    song: sanitizeSong(r.song),
    badges: Array.isArray(badges) ? badges.filter((b) => typeof b === 'string').slice(0, 8) : [],
    pronouns: cleanText(r.pronouns, LIMITS.pronouns).replace(/[<>]/g, '') || null,
    theme: sanitizeTheme(r.theme),
    nameStyle: sanitizeNameStyle(pick(r, 'nameStyle', 'name_style')),
    banner: sanitizeBanner(bannerObj, opts),
    legacyBanner: legacy ? legacy.slice(0, 64) : null,
    favoriteServers: sanitizeServers(pick(r, 'favoriteServers', 'favorite_servers')),
    publicStats: sanitizeStats(pick(r, 'publicStats', 'public_stats')),
    featured: sanitizeFeatured(r.featured, opts),
    equipped: sanitizeEquipped(r.equipped),
    cardStyle: sanitizeCardStyle(pick(r, 'cardStyle', 'card_style')),
    links: sanitizeLinks(r.links),
    showcase: sanitizeShowcase(r.showcase),
    rank: RANKS.includes(r.rank) ? r.rank : null,
    achievementCount: num(r.achievementCount),
    achievementTotal: num(r.achievementTotal),
    premium: r.premium === true,
    createdAt: str(pick(r, 'createdAt', 'created_at')),
    // true si el dato trae el estilo (si no, profile-style lo pide aparte: filas viejas de social)
    hasStyle: styleKeys.some((k) => r[k] !== undefined) || r.hasStyle === true,
  };
}

// Junta perfiles parciales (por ejemplo la fila de social con lo de profile_public): gana lo ultimo que trae el dato
export function mergeProfiles(...parts) {
  const raws = parts.filter(isObj);
  const merged = {};
  for (const p of raws) for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') merged[k] = v;
  return merged;
}

// ---------- Lo que se ve ----------
// Efecto que se dibuja: el del nombre o, si no tiene, el del efecto comprado y equipado
export function effectiveEffect(p) {
  const fx = p?.nameStyle?.effect;
  if (fx && fx !== 'none') return fx;
  return effectFromItem(p?.equipped?.nameEffect) || 'none';
}

export const frameOf = (p) => frameStyle(p?.equipped?.frame);
export const titleOf = (p) => titleStyle(p?.equipped?.title);
// Estilo de la insignia: el equipado o dorado para premium
export function badgeStyleOf(p) {
  const s = badgeStyleId(p?.equipped?.badgeStyle);
  if (s) return s;
  return p?.premium ? 'gold' : null;
}

// Fade del perfil: linear-gradient con los dos colores y el angulo (o '' si no tiene)
export function gradientCss(input) {
  const theme = input && isObj(input.theme) ? sanitizeTheme(input.theme) : sanitizeTheme(input);
  if (!theme) return '';
  return `linear-gradient(${theme.angle}deg, ${[theme.from, theme.via, theme.to].filter(Boolean).join(', ')})`;
}

// ---------- Color legible ----------
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbHex = (rgb) => `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
function luminance(hex) {
  const [r, g, b] = hexRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
export function mixHex(a, b, t) {
  const [x, y] = [hexRgb(a), hexRgb(b)];
  return rgbHex(x.map((c, i) => c + (y[i] - c) * t));
}
// Color del nombre que se lee bien sobre las superficies oscuras del launcher (>= 4.5:1): si no llega, se aclara
export function readableColor(hex, bg = '#1b130e', min = 4.5) {
  if (!isHex(hex)) return DEFAULT_NAME_COLOR;
  let c = hex.toLowerCase();
  for (let i = 1; i <= 20 && contrastRatio(c, bg) < min; i++) c = mixHex(hex.toLowerCase(), '#ffffff', i / 20);
  return c;
}

// Fondo aproximado de la tarjeta con fade (los dos colores bajo el velo oscuro de profile-style.css), para medir contraste
export function fadeSurface(theme) {
  if (!theme || !isHex(theme.from) || !isHex(theme.to)) return '#1b130e';
  return mixHex(mixHex(theme.from.toLowerCase(), theme.to.toLowerCase(), 0.5), '#0e0906', 0.64);
}

// Brillo del nombre (0-100) como filtro CSS (drop-shadow sigue la forma del texto, tambien con degradados)
export function glowFilter(glow, color, scale = 1) {
  const g = Math.max(0, Math.min(100, Number(glow) || 0));
  if (!g) return 'none';
  const c = isHex(color) ? color : DEFAULT_NAME_COLOR;
  const alpha = Math.round((0.25 + (g / 100) * 0.55) * 255).toString(16).padStart(2, '0');
  const r = Math.max(1, Math.round((2 + (g / 100) * 10) * scale));
  return `drop-shadow(0 0 ${r}px ${c}${alpha})`;
}

// ---------- Banners prediseñados (CSS y lienzo salen de la misma descripcion) ----------
// Capas de abajo hacia arriba: lin (degradado lineal), rad (eliptico: centro y radios en fraccion del tamaño),
// poly (silueta escalonada estilo pixel, en fraccion del tamaño) y dots (estrellas o brasas).
function rand(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
// Silueta escalonada: columnas con alturas al azar (estable por semilla). top: cuelga desde arriba
function steps(seed, { y, amp, cols, top = false }) {
  const r = rand(seed);
  const pts = [];
  for (let i = 0; i < cols; i++) {
    const hgt = +(y + (top ? 1 : -1) * r() * amp).toFixed(3);
    pts.push([+(i / cols).toFixed(4), hgt], [+((i + 1) / cols).toFixed(4), hgt]);
  }
  return top ? [[0, 0], ...pts, [1, 0]] : [[0, 1], ...pts, [1, 1]];
}
function dots(seed, n, color, [rMin, rMax], area = [0, 0, 1, 1]) {
  const r = rand(seed);
  return Array.from({ length: n }, () => ({
    x: +(area[0] + r() * (area[2] - area[0])).toFixed(3),
    y: +(area[1] + r() * (area[3] - area[1])).toFixed(3),
    r: +(rMin + r() * (rMax - rMin)).toFixed(2),
    c: color,
  }));
}
const PRESETS = {
  stars: [
    { t: 'lin', a: 180, s: [['#070b1f', 0], ['#16123a', 0.6], ['#2b1b4f', 1]] },
    { t: 'rad', x: 0.82, y: 0.2, rx: 0.32, ry: 0.9, s: [['rgba(255,214,140,0.28)', 0], ['rgba(255,214,140,0)', 1]] },
    { t: 'dots', d: dots(11, 28, 'rgba(255,255,255,0.9)', [0.6, 1.3]) },
    { t: 'dots', d: dots(23, 7, 'rgba(255,230,176,0.95)', [1.3, 2]) },
  ],
  sunset: [
    { t: 'lin', a: 180, s: [['#2b1440', 0], ['#8a2f5c', 0.38], ['#ff6a4d', 0.7], ['#ffc46b', 1]] },
    { t: 'rad', x: 0.72, y: 0.78, rx: 0.14, ry: 0.5, s: [['#fff1b8', 0], ['#ffd27a', 0.55], ['rgba(255,210,122,0)', 1]] },
    { t: 'poly', c: 'rgba(74,24,60,0.9)', p: steps(5, { y: 0.74, amp: 0.2, cols: 20 }) },
    { t: 'poly', c: '#1e0c22', p: steps(9, { y: 0.9, amp: 0.1, cols: 28 }) },
  ],
  nebula: [
    { t: 'lin', a: 135, s: [['#120a24', 0], ['#2a0f3f', 0.5], ['#0f1a3a', 1]] },
    { t: 'rad', x: 0.3, y: 0.45, rx: 0.42, ry: 1.1, s: [['rgba(214,76,180,0.55)', 0], ['rgba(214,76,180,0)', 1]] },
    { t: 'rad', x: 0.72, y: 0.6, rx: 0.4, ry: 1, s: [['rgba(90,120,255,0.45)', 0], ['rgba(90,120,255,0)', 1]] },
    { t: 'rad', x: 0.55, y: 0.3, rx: 0.22, ry: 0.7, s: [['rgba(255,170,220,0.38)', 0], ['rgba(255,170,220,0)', 1]] },
    { t: 'dots', d: dots(31, 20, 'rgba(255,255,255,0.85)', [0.5, 1.2]) },
  ],
  forest: [
    { t: 'lin', a: 180, s: [['#bfe7a0', 0], ['#86c46e', 0.45], ['#3f7d3c', 0.8], ['#1d4426', 1]] },
    { t: 'rad', x: 0.16, y: 0.22, rx: 0.16, ry: 0.6, s: [['rgba(255,250,205,0.75)', 0], ['rgba(255,250,205,0)', 1]] },
    { t: 'poly', c: '#4f8f4a', p: steps(13, { y: 0.66, amp: 0.14, cols: 16 }) },
    { t: 'poly', c: '#1f4a28', p: steps(17, { y: 0.84, amp: 0.26, cols: 26 }) },
  ],
  ocean: [
    { t: 'lin', a: 180, s: [['#a6ecff', 0], ['#3aa0e8', 0.45], ['#15528f', 0.78], ['#0b2a52', 1]] },
    { t: 'rad', x: 0.8, y: 0.24, rx: 0.14, ry: 0.5, s: [['rgba(255,255,240,0.85)', 0], ['rgba(255,255,240,0)', 1]] },
    { t: 'poly', c: 'rgba(255,255,255,0.2)', p: steps(41, { y: 0.62, amp: 0.05, cols: 30 }) },
    { t: 'poly', c: 'rgba(10,40,90,0.6)', p: steps(43, { y: 0.8, amp: 0.06, cols: 22 }) },
  ],
  nether: [
    { t: 'lin', a: 180, s: [['#3a0b07', 0], ['#7a1a0c', 0.45], ['#c2401a', 0.82], ['#ff8a3c', 1]] },
    { t: 'rad', x: 0.5, y: 1.05, rx: 0.8, ry: 0.6, s: [['rgba(255,150,50,0.65)', 0], ['rgba(255,150,50,0)', 1]] },
    { t: 'poly', c: '#2a0806', p: steps(53, { y: 0.12, amp: 0.3, cols: 18, top: true }) },
    { t: 'dots', d: dots(57, 16, 'rgba(255,180,80,0.95)', [0.8, 1.8], [0, 0.35, 1, 1]) },
  ],
  end: [
    { t: 'lin', a: 160, s: [['#0b0716', 0], ['#1d1236', 0.55], ['#3a2466', 1]] },
    { t: 'rad', x: 0.76, y: 0.32, rx: 0.3, ry: 0.9, s: [['rgba(200,170,255,0.38)', 0], ['rgba(200,170,255,0)', 1]] },
    { t: 'dots', d: dots(61, 22, 'rgba(230,220,255,0.9)', [0.5, 1.3], [0, 0, 1, 0.75]) },
    { t: 'poly', c: '#8f8a5c', p: steps(67, { y: 0.9, amp: 0.06, cols: 14 }) },
    { t: 'poly', c: '#e8e2a6', p: steps(71, { y: 0.86, amp: 0.08, cols: 14 }).map(([x, y]) => [x, y === 1 ? 0.95 : y]) },
  ],
  aurora: [
    { t: 'lin', a: 180, s: [['#04121f', 0], ['#0a2a3a', 0.6], ['#10343c', 1]] },
    { t: 'dots', d: dots(81, 18, 'rgba(255,255,255,0.85)', [0.5, 1.2], [0, 0, 1, 0.7]) },
    { t: 'rad', x: 0.3, y: 0.38, rx: 0.5, ry: 0.32, s: [['rgba(125,255,190,0.55)', 0], ['rgba(125,255,190,0)', 1]] },
    { t: 'rad', x: 0.66, y: 0.3, rx: 0.42, ry: 0.28, s: [['rgba(120,140,255,0.45)', 0], ['rgba(120,140,255,0)', 1]] },
    { t: 'rad', x: 0.5, y: 0.5, rx: 0.6, ry: 0.22, s: [['rgba(180,110,255,0.3)', 0], ['rgba(180,110,255,0)', 1]] },
    { t: 'poly', c: '#061018', p: steps(87, { y: 0.9, amp: 0.12, cols: 30 }) },
  ],
  cherry: [
    { t: 'lin', a: 180, s: [['#ffe3ef', 0], ['#ffb7d5', 0.5], ['#e77fae', 0.85], ['#7b3a66', 1]] },
    { t: 'rad', x: 0.78, y: 0.22, rx: 0.18, ry: 0.6, s: [['rgba(255,255,255,0.8)', 0], ['rgba(255,255,255,0)', 1]] },
    { t: 'dots', d: dots(91, 26, 'rgba(255,240,247,0.95)', [0.8, 1.8]) },
    { t: 'poly', c: '#c65f93', p: steps(93, { y: 0.74, amp: 0.14, cols: 18 }) },
    { t: 'poly', c: '#5b2a4d', p: steps(97, { y: 0.9, amp: 0.1, cols: 26 }) },
  ],
  desert: [
    { t: 'lin', a: 180, s: [['#8fd3ff', 0], ['#ffe9b5', 0.55], ['#f2c777', 0.8], ['#c98b3e', 1]] },
    { t: 'rad', x: 0.2, y: 0.24, rx: 0.14, ry: 0.5, s: [['rgba(255,250,210,0.95)', 0], ['rgba(255,250,210,0)', 1]] },
    { t: 'poly', c: '#e3b263', p: steps(101, { y: 0.74, amp: 0.1, cols: 12 }) },
    { t: 'poly', c: '#b97c33', p: steps(103, { y: 0.9, amp: 0.08, cols: 20 }) },
  ],
  snow: [
    { t: 'lin', a: 180, s: [['#22375f', 0], ['#5b84b8', 0.55], ['#c7e0f4', 1]] },
    { t: 'dots', d: dots(107, 30, 'rgba(255,255,255,0.95)', [0.7, 1.6]) },
    { t: 'poly', c: '#dcecf8', p: steps(109, { y: 0.72, amp: 0.2, cols: 14 }) },
    { t: 'poly', c: '#ffffff', p: steps(113, { y: 0.9, amp: 0.08, cols: 24 }) },
  ],
  deepdark: [
    { t: 'lin', a: 180, s: [['#03080d', 0], ['#06161f', 0.6], ['#0a2530', 1]] },
    { t: 'rad', x: 0.5, y: 0.82, rx: 0.5, ry: 0.5, s: [['rgba(40,220,230,0.4)', 0], ['rgba(40,220,230,0)', 1]] },
    { t: 'dots', d: dots(127, 22, 'rgba(90,240,240,0.9)', [0.6, 1.5], [0, 0.3, 1, 1]) },
    { t: 'poly', c: '#02060a', p: steps(131, { y: 0.14, amp: 0.26, cols: 22, top: true }) },
    { t: 'poly', c: '#051018', p: steps(137, { y: 0.9, amp: 0.1, cols: 26 }) },
  ],
  lush: [
    { t: 'lin', a: 180, s: [['#123a2c', 0], ['#2c7a4c', 0.55], ['#7bd16a', 1]] },
    { t: 'rad', x: 0.7, y: 0.4, rx: 0.3, ry: 0.8, s: [['rgba(255,214,110,0.5)', 0], ['rgba(255,214,110,0)', 1]] },
    { t: 'dots', d: dots(139, 16, 'rgba(255,214,110,0.95)', [0.9, 1.9]) },
    { t: 'poly', c: '#0e2c22', p: steps(149, { y: 0.16, amp: 0.3, cols: 20, top: true }) },
    { t: 'poly', c: '#1c5a3a', p: steps(151, { y: 0.88, amp: 0.12, cols: 24 }) },
  ],
  mesa: [
    { t: 'lin', a: 180, s: [['#ffd9a6', 0], ['#ff9f66', 0.55], ['#c9562f', 1]] },
    { t: 'poly', c: '#b9542c', p: steps(157, { y: 0.62, amp: 0.24, cols: 8 }) },
    { t: 'poly', c: '#e08a4a', p: steps(163, { y: 0.76, amp: 0.14, cols: 10 }) },
    { t: 'poly', c: '#7c3219', p: steps(167, { y: 0.92, amp: 0.08, cols: 18 }) },
  ],
  mushroom: [
    { t: 'lin', a: 180, s: [['#3a2a5c', 0], ['#7b4a8c', 0.6], ['#c98bb0', 1]] },
    { t: 'rad', x: 0.3, y: 0.62, rx: 0.2, ry: 0.5, s: [['rgba(255,90,90,0.6)', 0], ['rgba(255,90,90,0)', 1]] },
    { t: 'rad', x: 0.74, y: 0.68, rx: 0.18, ry: 0.45, s: [['rgba(220,170,110,0.55)', 0], ['rgba(220,170,110,0)', 1]] },
    { t: 'dots', d: dots(173, 18, 'rgba(255,240,255,0.85)', [0.6, 1.4], [0, 0, 1, 0.7]) },
    { t: 'poly', c: '#5c4470', p: steps(179, { y: 0.88, amp: 0.1, cols: 22 }) },
  ],
  void: [
    { t: 'lin', a: 180, s: [['#000000', 0], ['#050208', 0.7], ['#10061c', 1]] },
    { t: 'dots', d: dots(181, 34, 'rgba(255,255,255,0.8)', [0.4, 1.1]) },
    { t: 'rad', x: 0.5, y: 0.5, rx: 0.2, ry: 0.55, s: [['rgba(150,90,255,0.3)', 0], ['rgba(150,90,255,0)', 1]] },
  ],
};

export function presetLayers(id) {
  return PRESETS[id] || null;
}

const pct = (v) => `${+(v * 100).toFixed(2)}%`;
const stopsCss = (s) => s.map(([c, p]) => `${c} ${pct(p)}`).join(', ');
// Fondo CSS (propiedad background) de un banner prediseñado
export function presetCss(id) {
  const layers = PRESETS[id];
  if (!layers) return '';
  const out = [];
  for (const l of layers) {
    if (l.t === 'lin') out.push(`linear-gradient(${l.a}deg, ${stopsCss(l.s)})`);
    else if (l.t === 'rad') out.push(`radial-gradient(${pct(l.rx)} ${pct(l.ry)} at ${pct(l.x)} ${pct(l.y)}, ${stopsCss(l.s)})`);
    else if (l.t === 'poly') {
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'><polygon fill='${l.c}' points='${l.p.map(([x, y]) => `${+(x * 100).toFixed(2)},${+(y * 100).toFixed(2)}`).join(' ')}'/></svg>`;
      out.push(`url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / 100% 100% no-repeat`);
    } else if (l.t === 'dots') {
      for (const d of l.d) out.push(`radial-gradient(circle at ${pct(d.x)} ${pct(d.y)}, ${d.c} 0 ${d.r}px, transparent ${(d.r + 0.8).toFixed(2)}px)`);
    }
  }
  // En CSS la primera capa queda arriba
  return out.reverse().join(', ');
}

// Extremos del degradado lineal de CSS (angulo en grados) para un lienzo de w x h
export function linearPoints(angle, w, h) {
  const a = (angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = w / 2;
  const cy = h / 2;
  return [cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2];
}

// ---------- Validar (igual que profile_customize) ----------
// ctx: { userId, premium, owned: Set de ids o array, items: [{ id, kind, premiumOnly, active? }] }
function ownedSet(ctx) {
  return ctx?.owned instanceof Set ? ctx.owned : new Set(Array.isArray(ctx?.owned) ? ctx.owned : []);
}
function itemsList(ctx) {
  return Array.isArray(ctx?.items) && ctx.items.length ? ctx.items : SHOP_CATALOG;
}
// Se puede equipar: activo, del tipo del lugar y comprado (o solo premium y la cuenta es premium)
export function canEquip(slot, itemId, ctx) {
  const it = itemsList(ctx).find((i) => i.id === itemId);
  if (!it || it.active === false || it.kind !== SLOT_KIND[slot]) return false;
  return (it.premiumOnly && Boolean(ctx?.premium)) || ownedSet(ctx).has(itemId);
}
// Efecto del nombre permitido: los comunes siempre; los premium con premium o con el efecto comprado; los del
// Venus Pass solo con el item
export function canUseEffect(effect, ctx) {
  if (!EFFECTS.includes(effect)) return false;
  const owned = ownedSet(ctx);
  const ownsIt = () => itemsList(ctx).some((i) => i.kind === 'name_effect' && i.style === effect && owned.has(i.id));
  if (PASS_EFFECTS.includes(effect)) return ownsIt();
  if (!PREMIUM_EFFECTS.includes(effect) || ctx?.premium) return true;
  return ownsIt();
}
// Particulas del tema de la tarjeta: Premium (o el item extra_particles)
export const canUseParticles = (ctx) => Boolean(ctx?.premium) || ownedSet(ctx).has('extra_particles');

const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));

// null si esta bien; si no, el codigo de error del servidor ('bad_theme', 'premium_required:banner', 'not_owned:frame_gold')
export function validateField(field, v, ctx = {}) {
  switch (field) {
    case 'pronouns':
      if (v === null || (typeof v === 'string' && v.trim() === '')) return null;
      if (typeof v !== 'string' || v.trim().length > LIMITS.pronouns || CONTROL_OR_TAGS.test(v)) return 'bad_pronouns';
      return null;
    case 'bio':
      if (v === null) return null;
      if (typeof v !== 'string' || v.length > LIMITS.bio) return 'bad_bio';
      return null;
    case 'theme':
      if (!isObj(v) || !onlyKeys(v, ['from', 'via', 'to', 'angle'])) return 'bad_theme';
      if ((v.from !== undefined && !isHex(v.from)) || (v.via !== undefined && !isHex(v.via)) || (v.to !== undefined && !isHex(v.to))) return 'bad_theme';
      if (v.angle !== undefined && (num(v.angle) === null || v.angle < 0 || v.angle > 360)) return 'bad_theme';
      return null;
    case 'nameStyle':
      if (!isObj(v) || !onlyKeys(v, ['font', 'effect', 'color', 'glow', 'caps', 'italic', 'outline'])) return 'bad_nameStyle';
      for (const k of ['caps', 'italic', 'outline']) if (v[k] !== undefined && typeof v[k] !== 'boolean') return 'bad_nameStyle';
      if (v.font !== undefined && !FONTS.includes(v.font)) return 'bad_nameStyle';
      if (v.effect !== undefined && !EFFECTS.includes(v.effect)) return 'bad_nameStyle';
      if (v.color !== undefined && !isHex(v.color)) return 'bad_nameStyle';
      if (v.glow !== undefined && (num(v.glow) === null || v.glow < 0 || v.glow > 100)) return 'bad_nameStyle';
      if (v.effect !== undefined && !canUseEffect(v.effect, ctx)) return 'premium_required:nameStyle';
      return null;
    case 'banner':
      if (!isObj(v) || typeof v.kind !== 'string') return 'bad_banner';
      if (v.kind === 'none') return null;
      if (v.kind === 'preset') return BANNER_PRESETS.includes(v.preset) ? null : 'bad_banner';
      if (v.kind === 'image' || v.kind === 'animated') {
        if (!isProfileMediaUrl(v.url, ctx.userId || null)) return 'bad_banner';
        if (v.kind === 'animated' && !ctx.premium) return 'premium_required:banner';
        return null;
      }
      if (v.kind === 'klipy') {
        if (!isKlipyUrl(v.url) || (v.still !== undefined && !isKlipyUrl(v.still)) || (v.slug !== undefined && !KLIPY_SLUG.test(String(v.slug)))) return 'bad_banner';
        return null;
      }
      return 'bad_banner';
    case 'favoriteServers':
      if (!Array.isArray(v) || v.length > LIMITS.favoriteServers) return 'bad_favoriteServers';
      for (const s of v) {
        if (!isObj(s) || !isServerAddress(s.address) || !onlyKeys(s, ['address', 'name'])) return 'bad_favoriteServers';
        if (s.name !== undefined && (typeof s.name !== 'string' || s.name.length > LIMITS.serverName || CONTROL_OR_TAGS.test(s.name))) return 'bad_favoriteServers';
      }
      return null;
    case 'publicStats': {
      if (v === null) return null;
      if (!isObj(v) || !onlyKeys(v, ['hours', 'sessions', 'topVersion', 'topLoader', 'since', ...EXTRA_STATS])) return 'bad_publicStats';
      for (const k of EXTRA_STATS) if (v[k] !== undefined && (num(v[k]) === null || v[k] < 0 || v[k] > 1e12)) return 'bad_publicStats';
      const range = (x, max) => x === undefined || (num(x) !== null && x >= 0 && x <= max);
      const text = (x, max) => x === undefined || (typeof x === 'string' && x.length <= max);
      if (!range(v.hours, 1_000_000) || !range(v.sessions, 10_000_000) || !text(v.topVersion, 32) || !text(v.topLoader, 16) || !text(v.since, 32)) return 'bad_publicStats';
      return null;
    }
    case 'featured':
      if (!Array.isArray(v) || v.length > LIMITS.featured) return 'bad_featured';
      for (const f of v) {
        if (!isObj(f) || !isProfileMediaUrl(f.url, ctx.userId || null) || !onlyKeys(f, ['url', 'title'])) return 'bad_featured';
        if (f.title !== undefined && (typeof f.title !== 'string' || f.title.length > LIMITS.featuredTitle)) return 'bad_featured';
      }
      return null;
    case 'equipped':
      if (!isObj(v)) return 'bad_equipped';
      for (const [slot, id] of Object.entries(v)) {
        if (!EQUIP_SLOTS.includes(slot)) return 'bad_equipped';
        if (id === null || id === undefined) continue;
        if (!canEquip(slot, id, ctx)) return `not_owned:${id}`;
      }
      return null;
    case 'cardStyle': {
      if (!isObj(v) || !onlyKeys(v, ['pattern', 'avatar', 'layout', 'accent', 'theme', 'bubble', 'entry', 'song', 'guestbook'])) return 'bad_cardStyle';
      if ((v.pattern !== undefined && !CARD_PATTERNS.includes(v.pattern)) || (v.avatar !== undefined && !AVATAR_SHAPES.includes(v.avatar))) return 'bad_cardStyle';
      if ((v.layout !== undefined && !CARD_LAYOUTS.includes(v.layout)) || (v.accent !== undefined && !isHex(v.accent))) return 'bad_cardStyle';
      if (v.theme !== undefined) {
        if (!isObj(v.theme) || !onlyKeys(v.theme, ['id', 'particles']) || !CARD_THEMES.includes(v.theme.id)) return 'bad_cardStyle';
        if (v.theme.particles !== undefined && typeof v.theme.particles !== 'boolean') return 'bad_cardStyle';
        if (v.theme.particles === true && !canUseParticles(ctx)) return 'premium_required:cardStyle';
      }
      if (v.bubble !== undefined) {
        if (!isObj(v.bubble) || !onlyKeys(v.bubble, ['style', 'color']) || !BUBBLE_STYLES.includes(v.bubble.style)) return 'bad_cardStyle';
        if (v.bubble.color !== undefined && v.bubble.color !== null && !isHex(v.bubble.color)) return 'bad_cardStyle';
      }
      if (v.entry !== undefined && !ENTRY_EFFECTS.includes(v.entry)) return 'bad_cardStyle';
      if (v.guestbook !== undefined && typeof v.guestbook !== 'boolean') return 'bad_cardStyle';
      if (v.song !== undefined && v.song !== null) {
        if (!isObj(v.song) || !onlyKeys(v.song, ['url', 'title']) || !isProfileAudioUrl(v.song.url, ctx.userId || null)) return 'bad_cardStyle';
        if (v.song.title !== undefined && (typeof v.song.title !== 'string' || v.song.title.length > LIMITS.songTitle || CONTROL_OR_TAGS.test(v.song.title))) return 'bad_cardStyle';
      }
      return null;
    }
    case 'links':
      if (!Array.isArray(v) || v.length > LIMITS.links) return 'bad_links';
      for (const l of v) if (!isObj(l) || !onlyKeys(l, ['kind', 'url']) || !isProfileLink(l.kind, l.url)) return 'bad_links';
      return null;
    case 'showcase':
      if (!isObj(v) || !onlyKeys(v, ['achievements', 'clips', 'skin', 'skinPose', 'skinBg', 'rareBadges'])) return 'bad_showcase';
      if (v.skin !== undefined && typeof v.skin !== 'boolean') return 'bad_showcase';
      if ((v.skinPose !== undefined && !SKIN_POSES.includes(v.skinPose)) || (v.skinBg !== undefined && !SKIN_BGS.includes(v.skinBg))) return 'bad_showcase';
      if (v.rareBadges !== undefined && (!Array.isArray(v.rareBadges) || v.rareBadges.length > LIMITS.rareBadges || !v.rareBadges.every((a) => typeof a === 'string' && ACH_ID.test(a)))) return 'bad_showcase';
      if (v.achievements !== undefined && (!Array.isArray(v.achievements) || v.achievements.length > LIMITS.pinnedAchievements || !v.achievements.every((a) => typeof a === 'string' && ACH_ID.test(a)))) return 'bad_showcase';
      if (v.clips !== undefined && (!Array.isArray(v.clips) || v.clips.length > LIMITS.pinnedClips || !v.clips.every((c) => typeof c === 'string' && UUID.test(c)))) return 'bad_showcase';
      return null;
    default:
      return `bad_field:${field}`;
  }
}

// Todo el patch: { ok: true } o { ok: false, code, field }
export function validatePatch(patch, ctx = {}) {
  if (!isObj(patch)) return { ok: false, code: 'bad_request', field: null };
  for (const field of Object.keys(patch)) {
    if (!PATCH_FIELDS.includes(field)) return { ok: false, code: `bad_field:${field}`, field };
  }
  for (const field of PATCH_FIELDS) {
    if (!(field in patch)) continue;
    const code = validateField(field, patch[field], ctx);
    if (code) return { ok: false, code, field };
  }
  return { ok: true };
}

// ---------- Del perfil al formulario y del formulario al patch ----------
// Valores de lo personalizable en la forma exacta que acepta profile_customize
export function customOf(p) {
  const n = isObj(p) && 'legacyBanner' in p && 'hasStyle' in p ? p : normalizeProfile(p);
  return canonical({
    pronouns: n.pronouns,
    bio: n.bio,
    theme: n.theme ? { ...n.theme } : {},
    nameStyle: { ...n.nameStyle },
    banner: { ...n.banner },
    favoriteServers: n.favoriteServers.map((s) => ({ ...s })),
    publicStats: n.publicStats,
    featured: n.featured.map((f) => ({ ...f })),
    equipped: { ...n.equipped },
    cardStyle: { ...n.cardStyle },
    links: n.links.map((l) => ({ ...l })),
    showcase: {
      achievements: n.showcase.achievements.map((a) => a.id),
      clips: n.showcase.clips.map((c) => c.id),
      skin: n.showcase.skin,
      skinPose: n.showcase.skinPose,
      skinBg: n.showcase.skinBg,
      rareBadges: n.showcase.rareBadges.map((a) => a.id),
    },
  });
}

// Forma canonica (textos recortados, colores en minusculas, numeros redondeados, sin vacios) para comparar y enviar
export function canonical(d) {
  const out = {};
  if ('pronouns' in d) out.pronouns = typeof d.pronouns === 'string' && d.pronouns.trim() ? d.pronouns.trim() : null;
  if ('bio' in d) out.bio = typeof d.bio === 'string' && d.bio.trim() ? d.bio.trim() : null;
  if ('theme' in d) {
    const t = isObj(d.theme) ? d.theme : {};
    out.theme = isHex(t.from) && isHex(t.to) ? { from: t.from.toLowerCase(), ...(isHex(t.via) ? { via: t.via.toLowerCase() } : {}), to: t.to.toLowerCase(), angle: Math.round(Math.max(0, Math.min(360, Number(t.angle) || 0))) } : {};
  }
  if ('nameStyle' in d) {
    const s = isObj(d.nameStyle) ? d.nameStyle : {};
    const ns = {};
    if (FONTS.includes(s.font) && s.font !== 'default') ns.font = s.font;
    if (EFFECTS.includes(s.effect) && s.effect !== 'none') ns.effect = s.effect;
    if (isHex(s.color)) ns.color = s.color.toLowerCase();
    const g = Math.round(Number(s.glow) || 0);
    if (g > 0) ns.glow = Math.min(100, g);
    for (const k of ['caps', 'italic', 'outline']) if (s[k] === true) ns[k] = true;
    out.nameStyle = ns;
  }
  if ('banner' in d) {
    const b = isObj(d.banner) ? d.banner : {};
    if (b.kind === 'preset' && BANNER_PRESETS.includes(b.preset)) out.banner = { kind: 'preset', preset: b.preset };
    else if ((b.kind === 'image' || b.kind === 'animated') && typeof b.url === 'string') out.banner = { kind: b.kind, url: b.url };
    else if (b.kind === 'klipy' && typeof b.url === 'string') out.banner = { kind: 'klipy', url: b.url, ...(b.still ? { still: b.still } : {}), ...(b.slug ? { slug: b.slug } : {}) };
    else out.banner = { kind: 'none' };
  }
  if ('favoriteServers' in d) {
    out.favoriteServers = (Array.isArray(d.favoriteServers) ? d.favoriteServers : []).map((s) => {
      const address = String(s?.address || '').trim().toLowerCase();
      const name = typeof s?.name === 'string' ? s.name.trim() : '';
      return name ? { address, name } : { address };
    });
  }
  if ('publicStats' in d) {
    if (!isObj(d.publicStats)) out.publicStats = null;
    else {
      const ps = {};
      for (const k of ['hours', 'sessions', 'topVersion', 'topLoader', 'since', ...EXTRA_STATS]) if (d.publicStats[k] !== undefined && d.publicStats[k] !== null && d.publicStats[k] !== '') ps[k] = d.publicStats[k];
      out.publicStats = ps;
    }
  }
  if ('featured' in d) {
    out.featured = (Array.isArray(d.featured) ? d.featured : []).map((f) => {
      const title = typeof f?.title === 'string' ? f.title.trim() : '';
      return title ? { url: f.url, title } : { url: f.url };
    });
  }
  if ('equipped' in d) {
    const e = isObj(d.equipped) ? d.equipped : {};
    const eq = {};
    for (const slot of EQUIP_SLOTS) if (typeof e[slot] === 'string' && e[slot]) eq[slot] = e[slot];
    out.equipped = eq;
  }
  if ('cardStyle' in d) {
    const c = isObj(d.cardStyle) ? d.cardStyle : {};
    const cs = {};
    if (CARD_PATTERNS.includes(c.pattern) && c.pattern !== 'none') cs.pattern = c.pattern;
    if (AVATAR_SHAPES.includes(c.avatar) && c.avatar !== 'square') cs.avatar = c.avatar;
    if (CARD_LAYOUTS.includes(c.layout) && c.layout !== 'classic') cs.layout = c.layout;
    if (isHex(c.accent)) cs.accent = c.accent.toLowerCase();
    // 3.1: tema, burbuja, entrada en voz, cancion y libro de visitas (lo que esta en su valor por defecto no se manda)
    const th = isObj(c.theme) ? c.theme : {};
    if (CARD_THEMES.includes(th.id) && th.id !== 'none') cs.theme = th.particles === true ? { id: th.id, particles: true } : { id: th.id };
    const bu = isObj(c.bubble) ? c.bubble : {};
    if ((BUBBLE_STYLES.includes(bu.style) && bu.style !== 'default') || isHex(bu.color)) {
      cs.bubble = { style: BUBBLE_STYLES.includes(bu.style) ? bu.style : 'default' };
      if (isHex(bu.color)) cs.bubble.color = bu.color.toLowerCase();
    }
    if (ENTRY_EFFECTS.includes(c.entry) && c.entry !== 'none') cs.entry = c.entry;
    if (isObj(c.song) && typeof c.song.url === 'string' && c.song.url) {
      const title = typeof c.song.title === 'string' ? c.song.title.trim() : '';
      cs.song = title ? { url: c.song.url, title } : { url: c.song.url };
    }
    if (c.guestbook === true) cs.guestbook = true;
    out.cardStyle = cs;
  }
  if ('links' in d) {
    out.links = (Array.isArray(d.links) ? d.links : []).filter((l) => isObj(l) && l.url).map((l) => ({ kind: l.kind, url: String(l.url).trim() }));
  }
  if ('showcase' in d) {
    const s = isObj(d.showcase) ? d.showcase : {};
    const sc = {};
    if (Array.isArray(s.achievements) && s.achievements.length) sc.achievements = s.achievements.slice();
    if (Array.isArray(s.clips) && s.clips.length) sc.clips = s.clips.slice();
    if (s.skin === true) sc.skin = true;
    if (SKIN_POSES.includes(s.skinPose) && s.skinPose !== 'stand') sc.skinPose = s.skinPose;
    if (SKIN_BGS.includes(s.skinBg) && s.skinBg !== 'none') sc.skinBg = s.skinBg;
    if (Array.isArray(s.rareBadges) && s.rareBadges.length) sc.rareBadges = s.rareBadges.slice(0, LIMITS.rareBadges);
    out.showcase = sc;
  }
  return out;
}

// ---------- Estado con emoji y vencimiento (3.1) ----------
const EMOJI_RE = /^\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?){0,3}$/u;
// Un solo emoji (con variante, tono de piel o uniones), como pide profile_set_status
export function isEmoji(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 16 && EMOJI_RE.test(v);
}
// "🔥 Jugando bedwars" -> { emoji: '🔥', text: 'Jugando bedwars' } (sin emoji al principio: emoji null)
export function splitStatus(statusText) {
  const s = cleanText(statusText, LIMITS.statusText);
  if (!s) return { emoji: null, text: '' };
  const first = s.split(/\s+/)[0];
  if (isEmoji(first)) return { emoji: first, text: s.slice(first.length).trim() };
  return { emoji: null, text: s };
}
// Texto del estado que se guarda (hasta 80 caracteres); null si queda vacio
export function joinStatus(emoji, text) {
  const e = isEmoji(emoji) ? emoji : '';
  const t = cleanText(text, LIMITS.statusBody);
  const full = [e, t].filter(Boolean).join(' ');
  return full ? full.slice(0, LIMITS.statusText) : null;
}
// Vencimiento elegido -> fecha ISO (null = nunca). 'today' es hasta la medianoche local.
export function statusUntil(choice, now = Date.now()) {
  const d = new Date(now);
  switch (choice) {
    case '30m':
      return new Date(now + 30 * 60_000).toISOString();
    case '1h':
      return new Date(now + 60 * 60_000).toISOString();
    case '4h':
      return new Date(now + 4 * 60 * 60_000).toISOString();
    case 'today': {
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
      return end.toISOString();
    }
    default:
      return null;
  }
}
export function statusExpired(until, now = Date.now()) {
  if (!until) return false;
  const t = typeof until === 'number' ? until : Date.parse(until);
  return Number.isFinite(t) && t <= now;
}
// Lo que se muestra: vacio si el estado vencio
export function liveStatusText(text, until, now = Date.now()) {
  return statusExpired(until, now) ? '' : String(text || '');
}

// ---------- Regalos (3.1): las mismas reglas que gift_send ----------
// { kind: 'points' | 'item', value, balance, sentToday, item?: { id, price, premiumOnly, active }, ownedByTarget?: Set|array }
// Devuelve null o el codigo de error del servidor.
export function validateGift({ kind, value, balance = 0, sentToday = 0, item = null, ownedByTarget = [] } = {}) {
  if (kind === 'points') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < LIMITS.giftMin || n > LIMITS.giftMax) return 'bad_amount';
    if (sentToday + n > LIMITS.giftDaily) return 'daily_limit';
    if (balance < n) return 'not_enough_points';
    return null;
  }
  if (kind === 'item') {
    if (!item || item.active === false || item.id !== value) return 'bad_item';
    if (item.premiumOnly) return 'premium_item';
    const owned = ownedByTarget instanceof Set ? ownedByTarget : new Set(ownedByTarget || []);
    if (owned.has(item.id)) return 'owned';
    if (balance < (Number(item.price) || 0)) return 'not_enough_points';
    return null;
  }
  return 'bad_kind';
}
// Puntos regalados hoy segun el historial de points_me (gift_out: delta negativo)
export function giftSentToday(history, now = Date.now()) {
  const since = now - 86_400_000;
  return (Array.isArray(history) ? history : [])
    .filter((r) => r && r.reason === 'gift_out' && Number.isFinite(Date.parse(r.at)) && Date.parse(r.at) > since)
    .reduce((acc, r) => acc + Math.max(0, -Number(r.delta) || 0), 0);
}
// Quien mando un gift_in: el ref es "<uuid>:<marca>"
export function giftSenderOf(ref) {
  const m = /^([0-9a-fA-F-]{36}):/.exec(String(ref || ''));
  return m && UUID.test(m[1]) ? m[1].toLowerCase() : null;
}

// ---------- Burbujas de chat (3.1): texto claro u oscuro segun el fondo ----------
// Si ningun texto llega a 4.5:1 sobre ese color (tonos medios), el fondo se oscurece o se aclara un poco hasta que se lea
export function bubbleColors(hex) {
  if (!isHex(hex)) return null;
  const base = hex.toLowerCase();
  const dark = '#1b130e';
  const light = '#ffffff';
  const fg = contrastRatio(base, dark) >= contrastRatio(base, light) ? dark : light;
  const toward = fg === light ? '#000000' : '#ffffff';
  let bg = base;
  for (let i = 1; i <= 20 && contrastRatio(bg, fg) < 4.5; i++) bg = mixHex(base, toward, i / 20);
  return { bg, fg, border: mixHex(bg, fg, 0.25), adjusted: bg !== base };
}

// Patch con solo lo que cambio entre lo guardado (base) y el formulario (draft), en forma canonica.
// Un banner vacio se manda como { kind: 'none' } (el servidor lo guarda como {}).
export function buildPatch(base, draft) {
  const a = canonical(base || {});
  const b = canonical(draft || {});
  const patch = {};
  for (const field of PATCH_FIELDS) {
    if (!(field in b)) continue;
    if (!deepEqual(a[field] ?? null, b[field] ?? null)) patch[field] = b[field];
  }
  return patch;
}

// ---------- Errores de profile_customize ----------
// { code, kind, field, item }: kind = 'unavailable' | 'session' | 'blocked' | 'premium' | 'owned' | 'validation' | 'unknown'
export function parseCustomizeError(err) {
  const msg = String(err?.message || err || '');
  const pgCode = String(err?.code || '');
  if (pgCode === 'PGRST202' || pgCode === '42883' || pgCode === '42P01' || pgCode === '42703' || /could not find the function|does not exist|schema cache/i.test(msg)) return { code: 'unavailable', kind: 'unavailable', field: null, item: null };
  if (/\bnot_authenticated\b|jwt/i.test(msg)) return { code: 'not_authenticated', kind: 'session', field: null, item: null };
  const m = /\b(user_banned|user_muted|premium_required:[A-Za-z]+|not_owned:[a-z0-9_-]+|bad_field:[A-Za-z_]+|bad_[A-Za-z]+)\b/.exec(msg);
  if (!m) return { code: 'unknown', kind: 'unknown', field: null, item: null };
  const code = m[1];
  if (code === 'user_banned' || code === 'user_muted') return { code, kind: 'blocked', field: null, item: null };
  if (code.startsWith('premium_required:')) return { code, kind: 'premium', field: code.slice(17), item: null };
  if (code.startsWith('not_owned:')) return { code, kind: 'owned', field: 'equipped', item: code.slice(10) };
  if (code.startsWith('bad_field:')) return { code, kind: 'validation', field: code.slice(10), item: null };
  const field = code.slice(4);
  return { code, kind: 'validation', field: PATCH_FIELDS.includes(field) ? field : null, item: null };
}

// ---------- Estadisticas publicadas (de stats:report, todo local) ----------
const dayIso = (ms) => {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;
};
export function publicStatsFromReport(report, ingame = null) {
  if (!isObj(report)) return null;
  const totals = isObj(report.totals) ? report.totals : {};
  const ms = num(totals.ms) || 0;
  const out = {
    hours: Math.min(1_000_000, Math.round((ms / 3_600_000) * 10) / 10),
    sessions: Math.min(10_000_000, Math.round(num(totals.sessions) || 0)),
  };
  const top = (list, skip) => (Array.isArray(list) ? list.find((e) => e && typeof e.id === 'string' && e.id && !skip.includes(e.id) && (num(e.ms) || 0) > 0) : null);
  const v = top(report.byVersion, ['?']);
  const l = top(report.byLoader, []);
  if (v) out.topVersion = v.id.slice(0, 32);
  if (l) out.topLoader = l.id.slice(0, 16);
  const first = num(report.firstPlay) || num(report.firstUse);
  if (first && first > 0) out.since = dayIso(first);
  if (!out.since) delete out.since;
  const put = (k, v) => {
    const x = num(v);
    if (x !== null && x > 0) out[k] = Math.min(1e12, Math.round(x * 10) / 10);
  };
  put('daysPlayed', totals.daysPlayed);
  put('bestStreak', report.streak?.longest?.days);
  put('longestHours', (num(report.records?.longestSession?.ms) || 0) / 3_600_000);
  put('versions', totals.versionsPlayed);
  put('loaders', totals.loadersPlayed);
  put('instances', report.instancesCount);
  // De los mundos de esta PC (opcional: si no se pudieron leer, no se publican)
  const g = isObj(ingame?.totals) ? ingame.totals : null;
  if (g) {
    put('worlds', ingame.worldsCount);
    put('blocks', g.blocksMined);
    put('mobs', g.mobKills);
    put('deaths', g.deaths);
    put('distanceKm', (num(g.distanceCm) || 0) / 100000);
  }
  return out;
}

// ---------- Imagenes ----------
// Recorte con la proporcion pedida (ancho/alto) dentro de la imagen; focus 0..1 mueve el recorte sobre el eje que sobra
export function cropRect(srcW, srcH, aspect, focus = 0.5) {
  const f = Math.max(0, Math.min(1, Number.isFinite(focus) ? focus : 0.5));
  if (!(srcW > 0 && srcH > 0 && aspect > 0)) return { sx: 0, sy: 0, sw: 0, sh: 0 };
  if (srcW / srcH > aspect) {
    const sw = Math.round(srcH * aspect);
    return { sx: Math.round((srcW - sw) * f), sy: 0, sw, sh: srcH };
  }
  const sh = Math.round(srcW / aspect);
  return { sx: 0, sy: Math.round((srcH - sh) * f), sw: srcW, sh };
}
// Tamaño final sin agrandar: entra en maxW x maxH manteniendo la proporcion
export function fitSize(w, h, maxW, maxH) {
  if (!(w > 0 && h > 0)) return { width: 0, height: 0 };
  const k = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}
// Nombre del archivo en profile-media (lo que acepta la politica del bucket)
export function mediaFileName(kind, ext, now = Date.now(), rnd = Math.random()) {
  const e = ['png', 'jpg', 'webp', 'gif'].includes(ext) ? ext : 'webp';
  const k = kind === 'featured' ? 'featured' : 'banner';
  const name = `${k}-${Math.floor(now).toString(36)}${Math.floor(rnd * 1296).toString(36).padStart(2, '0')}.${e}`;
  return MEDIA_NAME.test(name) ? name : `${k}.${e}`;
}
// Archivos propios que ya no usa nada (para hacer lugar antes de subir): nombres que no estan en keep
export function orphanMedia(files, keepUrls) {
  const keep = new Set((keepUrls || []).map((u) => mediaPathFromUrl(u)?.name).filter(Boolean));
  return (files || []).filter((f) => f && typeof f.name === 'string' && MEDIA_NAME.test(f.name) && !keep.has(f.name)).map((f) => f.name);
}

// ---------- KLIPY ----------
// De la respuesta de KLIPY a lo que usa el editor. Se saltea lo que no es un GIF, sin reordenar nada.
// Para el banner alcanza con el tamaño md; si no esta, el mas chico que haya.
export function parseGifs(json) {
  const box = json?.data;
  const list = Array.isArray(box?.data) ? box.data : [];
  const out = [];
  for (const it of list) {
    if (!it || (it.type && it.type !== 'gif')) continue;
    const file = it.file || {};
    const pick = (fmt, sizes) => {
      for (const s of sizes) {
        const url = file[s]?.[fmt]?.url;
        if (typeof url === 'string') return url;
      }
      return null;
    };
    const url = pick('webp', ['md', 'hd', 'sm']) || pick('gif', ['md', 'hd', 'sm']);
    const thumb = pick('webp', ['sm', 'xs', 'md']) || pick('gif', ['sm', 'xs', 'md']) || url;
    const still = pick('jpg', ['md', 'sm', 'xs', 'hd']);
    if (!url) continue;
    out.push({ slug: typeof it.slug === 'string' ? it.slug : null, title: typeof it.title === 'string' ? it.title : '', url, thumb, still });
  }
  return { items: out, hasNext: box?.has_next === true };
}
