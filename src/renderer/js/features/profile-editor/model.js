// Logica pura de los perfiles de Venus (sin DOM ni imports, para probarla con Node): normalizar el perfil que
// llega en camelCase (profile_public) o crudo de la tabla profiles (snake_case), validar igual que
// profile_customize (supabase/migrations/0020_perfiles.sql), armar el patch con solo lo que cambio, el CSS del
// fade y de los banners prediseñados, y cuentas chicas para las imagenes.
// La usan social/profile-style.js, social/profile-ui.js y features/profile-editor.js.

// ---------- Catalogo (lo mismo que conoce el servidor) ----------
export const FONTS = ['default', 'pixel', 'outfit', 'serif', 'mono', 'rounded', 'condensed'];
export const EFFECTS = ['none', 'glow', 'gradient', 'shimmer', 'rainbow', 'fire'];
export const PREMIUM_EFFECTS = ['shimmer', 'rainbow', 'fire'];
export const BANNER_PRESETS = ['stars', 'sunset', 'nebula', 'forest', 'ocean', 'nether', 'end', 'aurora'];
export const FRAMES = ['pixel', 'neon', 'gold', 'venus'];
export const TITLES = ['explorer', 'builder', 'redstoner', 'legend', 'supporter'];
export const BADGE_STYLES = ['nebula', 'ice', 'gold'];
export const EQUIP_SLOTS = ['frame', 'nameEffect', 'badgeStyle', 'title'];
export const PATCH_FIELDS = ['pronouns', 'bio', 'theme', 'nameStyle', 'banner', 'favoriteServers', 'publicStats', 'featured', 'equipped'];
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
];

export const LIMITS = {
  pronouns: 24,
  bio: 200,
  displayName: 32,
  favoriteServers: 5,
  serverName: 40,
  featured: 3,
  featuredTitle: 60,
  files: 12,
  fileBytes: 4 * 1024 * 1024,
  bannerW: 1200,
  bannerH: 300,
  featuredW: 1600,
  featuredH: 900,
  mediaUrl: 400,
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
];
export const NAME_COLORS = ['#ffe6b0', '#ffc562', '#ff8a5c', '#ff7eb3', '#c58cff', '#7fb2ff', '#6fe0d0', '#9be36a', '#ffffff'];
export const DEFAULT_NAME_COLOR = '#ffe6b0';

// ---------- Ayudas ----------
const HEX = /^#[0-9a-fA-F]{6}$/;
const CONTROL_OR_TAGS = /[\u0000-\u001f<>]/;
const CONTROL = new RegExp(`[\u0000-\u001f\u007f${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const SERVER_ADDRESS = /^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/;
const MEDIA_NAME = /^[A-Za-z0-9._-]{1,80}$/;
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
  return { from: from || to, to: to || from, angle: a !== null && a >= 0 && a <= 360 ? Math.round(a) : 135 };
};

const sanitizeNameStyle = (v) => {
  const s = isObj(v) ? v : {};
  const glow = num(s.glow);
  return {
    font: FONTS.includes(s.font) ? s.font : 'default',
    effect: EFFECTS.includes(s.effect) ? s.effect : 'none',
    color: isHex(s.color) ? s.color.toLowerCase() : null,
    glow: glow !== null && glow >= 0 && glow <= 100 ? Math.round(glow) : 0,
  };
};

const sanitizeBanner = (v, opts) => {
  if (!isObj(v)) return { kind: 'none' };
  if (v.kind === 'preset' && BANNER_PRESETS.includes(v.preset)) return { kind: 'preset', preset: v.preset };
  if ((v.kind === 'image' || v.kind === 'animated') && (isProfileMediaUrl(v.url) || (opts.allowLocalMedia && isLocalMedia(v.url)))) return { kind: v.kind, url: v.url };
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
  const styleKeys = ['nameStyle', 'name_style', 'theme', 'equipped', 'banner_style', 'bannerStyle'];
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
    statusText: cleanText(pick(r, 'statusText', 'status_text'), 80),
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
  return `linear-gradient(${theme.angle}deg, ${theme.from}, ${theme.to})`;
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
// Efecto del nombre permitido: los comunes siempre; los premium con premium o con el efecto comprado
export function canUseEffect(effect, ctx) {
  if (!EFFECTS.includes(effect)) return false;
  if (!PREMIUM_EFFECTS.includes(effect) || ctx?.premium) return true;
  const owned = ownedSet(ctx);
  return itemsList(ctx).some((i) => i.kind === 'name_effect' && i.style === effect && owned.has(i.id));
}

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
      if (!isObj(v) || !onlyKeys(v, ['from', 'to', 'angle'])) return 'bad_theme';
      if ((v.from !== undefined && !isHex(v.from)) || (v.to !== undefined && !isHex(v.to))) return 'bad_theme';
      if (v.angle !== undefined && (num(v.angle) === null || v.angle < 0 || v.angle > 360)) return 'bad_theme';
      return null;
    case 'nameStyle':
      if (!isObj(v) || !onlyKeys(v, ['font', 'effect', 'color', 'glow'])) return 'bad_nameStyle';
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
      if (!isObj(v) || !onlyKeys(v, ['hours', 'sessions', 'topVersion', 'topLoader', 'since'])) return 'bad_publicStats';
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
  });
}

// Forma canonica (textos recortados, colores en minusculas, numeros redondeados, sin vacios) para comparar y enviar
export function canonical(d) {
  const out = {};
  if ('pronouns' in d) out.pronouns = typeof d.pronouns === 'string' && d.pronouns.trim() ? d.pronouns.trim() : null;
  if ('bio' in d) out.bio = typeof d.bio === 'string' && d.bio.trim() ? d.bio.trim() : null;
  if ('theme' in d) {
    const t = isObj(d.theme) ? d.theme : {};
    out.theme = isHex(t.from) && isHex(t.to) ? { from: t.from.toLowerCase(), to: t.to.toLowerCase(), angle: Math.round(Math.max(0, Math.min(360, Number(t.angle) || 0))) } : {};
  }
  if ('nameStyle' in d) {
    const s = isObj(d.nameStyle) ? d.nameStyle : {};
    const ns = {};
    if (FONTS.includes(s.font) && s.font !== 'default') ns.font = s.font;
    if (EFFECTS.includes(s.effect) && s.effect !== 'none') ns.effect = s.effect;
    if (isHex(s.color)) ns.color = s.color.toLowerCase();
    const g = Math.round(Number(s.glow) || 0);
    if (g > 0) ns.glow = Math.min(100, g);
    out.nameStyle = ns;
  }
  if ('banner' in d) {
    const b = isObj(d.banner) ? d.banner : {};
    if (b.kind === 'preset' && BANNER_PRESETS.includes(b.preset)) out.banner = { kind: 'preset', preset: b.preset };
    else if ((b.kind === 'image' || b.kind === 'animated') && typeof b.url === 'string') out.banner = { kind: b.kind, url: b.url };
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
      for (const k of ['hours', 'sessions', 'topVersion', 'topLoader', 'since']) if (d.publicStats[k] !== undefined && d.publicStats[k] !== null && d.publicStats[k] !== '') ps[k] = d.publicStats[k];
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
  return out;
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
export function publicStatsFromReport(report) {
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
