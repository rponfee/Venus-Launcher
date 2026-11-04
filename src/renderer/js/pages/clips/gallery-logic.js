// Galeria publica de clips, sin DOM (se prueba con node:test): que se acepta de lo que manda el servidor y como se
// muestran los errores de las RPC de 0032_galeria_clips.sql.

export const SORTS = ['recent', 'week'];
export const VIEWS = ['recent', 'week', 'mine'];
export const REPORT_REASONS = ['offensive', 'spam', 'stolen', 'other'];
export const PAGE_SIZE = 24;
export const TITLE_MAX = 80;
export const THUMB_MAX = 32000; // el servidor acepta hasta 32768 caracteres
export const SOON_MS = 14 * 86400000;

// Titulo como lo guarda el servidor: sin espacios de mas ni caracteres de control
export function cleanTitle(s) {
  return String(s ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX);
}

// Solo links firmados de los clips del Storage del proyecto del launcher: un clip nunca hace cargar otra direccion
export function safeClipUrl(raw, projectUrl) {
  try {
    const u = new URL(String(raw || ''));
    const base = new URL(String(projectUrl || ''));
    if (u.protocol !== 'https:' || u.host !== base.host || u.username || u.password || u.hash) return null;
    if (!/^\/storage\/v1\/object\/sign\/clips\/[^/]+\/[^/]+$/.test(u.pathname)) return null;
    return u.href.length <= 2000 ? u.href : null;
  } catch {
    return null;
  }
}

// Miniatura propia del clip: solo una imagen embebida
export const safeThumb = (raw) => (typeof raw === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(raw) && raw.length <= 32768 ? raw : null);

const count = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// De lo que llega de gallery_list o gallery_mine a lo que dibuja la tarjeta. null si no se puede mostrar sin peligro.
export function normalizeClip(raw, projectUrl) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const url = raw.url ? safeClipUrl(raw.url, projectUrl) : null;
  const expiresAt = Date.parse(raw.expiresAt) || 0;
  const at = Date.parse(raw.at) || 0;
  const a = raw.author && typeof raw.author === 'object' ? raw.author : {};
  return {
    id: raw.id,
    mediaId: typeof raw.mediaId === 'string' ? raw.mediaId : null,
    title: cleanTitle(raw.title),
    url,
    thumb: safeThumb(raw.thumb),
    at,
    expiresAt,
    expired: raw.expired === true,
    hidden: raw.hidden === true,
    hiddenReason: typeof raw.hiddenReason === 'string' ? raw.hiddenReason.slice(0, 200) : '',
    likes: count(raw.likes),
    likesWeek: count(raw.likesWeek),
    liked: raw.liked === true,
    mine: raw.mine === true,
    author: { id: typeof a.id === 'string' ? a.id : null, name: cleanTitle(a.displayName || a.username || ''), mc: typeof a.mcName === 'string' ? a.mcName : null },
  };
}

// Lo que se puede reproducir de una lista (lo publico sin link valido no se muestra, salvo en "mias", para dar el aviso)
export const visibleClips = (rows, projectUrl) => (Array.isArray(rows) ? rows : []).map((r) => normalizeClip(r, projectUrl)).filter((c) => c && c.url);
export const ownClips = (rows, projectUrl) => (Array.isArray(rows) ? rows : []).map((r) => normalizeClip(r, projectUrl)).filter(Boolean);

export const expiresSoon = (clip, now = Date.now()) => Boolean(clip.expiresAt) && clip.expiresAt - now < SOON_MS && clip.expiresAt > now;

// Estado de un clip propio: 'hidden', 'expired' o 'live'
export function ownState(clip, now = Date.now()) {
  if (clip.hidden) return 'hidden';
  if (clip.expired || (clip.expiresAt && clip.expiresAt <= now)) return 'expired';
  return 'live';
}

// Like optimista: como queda la tarjeta antes de que conteste el servidor
export function toggledLike(clip) {
  const liked = !clip.liked;
  const delta = liked ? 1 : -1;
  return { ...clip, liked, likes: Math.max(0, clip.likes + delta), likesWeek: Math.max(0, clip.likesWeek + delta) };
}

// Codigo estable de un error de las RPC. 'unavailable': falta la migracion o el servicio no contesta.
const KNOWN = new Set(['not_authenticated', 'user_banned', 'user_muted', 'bad_title', 'bad_thumb', 'not_shared', 'bad_link', 'expired', 'already_published', 'hidden_by_admin', 'too_many_today', 'not_found', 'own_clip', 'bad_reason', 'bad_text', 'admin_only']);
export function errorCode(err) {
  const msg = String(err?.message || err || '');
  for (const k of KNOWN) if (msg.includes(k)) return k;
  if (err?.code === 'PGRST202' || err?.code === '42883' || err?.code === '42P01' || /schema cache|does not exist/i.test(msg)) return 'unavailable';
  if (/failed to fetch|network|timeout/i.test(msg)) return 'network';
  return 'unavailable';
}
