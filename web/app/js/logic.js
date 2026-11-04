// Lógica pura de la app: presencia, listas, mensajes, rutas y errores. Sin DOM ni red; se prueba con Node (test/).

export const STALE_MS = 150_000; // como en el launcher: sin latido en 2,5 minutos se considera desconectado
export const MAX_MESSAGE = 2000;
export const PAGE = 40;

export const ts = (v) => (v ? Date.parse(v) || 0 : 0);
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_RE = /^venus-?[a-z0-9]{6}$/i;
const USER_RE = /^@?[A-Za-z0-9_]{3,20}$/;

// ---------- Nombres ----------
export function displayName(profile) {
  const d = typeof profile?.display_name === 'string' ? profile.display_name.trim() : '';
  return d || profile?.username || '';
}

// Primera letra (o emoji) para el avatar
export function initialOf(name) {
  const first = [...String(name || '').trim()][0] || '?';
  return first.toUpperCase();
}

// Color estable de cada persona dentro de la paleta cálida
export function avatarTone(id) {
  let hash = 0;
  for (const ch of String(id || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 6;
}

// ---------- Presencia y actividad ----------
export const isOnline = (p) => p === 'online' || p === 'away' || p === 'busy';

// Solo direcciones útiles para un amigo (misma regla que el launcher)
export function publicAddress(addr) {
  const a = String(addr || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(a)) return null;
  const host = a.replace(/:\d+$/, '');
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
  if (/\.(local|lan|home|internal|localdomain|localhost|test|invalid)$/.test(host)) return null;
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip) {
    const [x, y] = [Number(ip[1]), Number(ip[2])];
    if ([ip[1], ip[2], ip[3], ip[4]].some((n) => Number(n) > 255)) return null;
    if (x === 0 || x === 10 || x === 127 || x >= 224) return null;
    if ((x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127)) return null;
  }
  return a;
}

const LOADERS = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', optifine: 'OptiFine', iris: 'Iris', legacyfabric: 'Legacy Fabric', babric: 'Babric' };
const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\p{Zl}\p{Zp}]/gu, '').trim().slice(0, max) : '');

export function sanitizeActivity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!['menu', 'singleplayer', 'server'].includes(raw.type)) return null;
  const out = {
    type: raw.type,
    mcVersion: /^[\w.\- ]{1,24}$/.test(raw.mcVersion || '') ? raw.mcVersion : '',
    loader: Object.hasOwn(LOADERS, raw.loader) ? raw.loader : '',
  };
  if (raw.type === 'server') out.address = publicAddress(raw.address);
  if (raw.type === 'singleplayer') out.world = cleanText(raw.world, 48);
  return out;
}

export function presenceOf(row, nowMs) {
  if (!row) return { presence: 'offline', activity: null };
  if (row.status === 'offline' || nowMs - ts(row.updated_at) > STALE_MS) return { presence: 'offline', activity: null };
  return { presence: isOnline(row.status) ? row.status : 'online', activity: sanitizeActivity(row.activity) };
}

// "Jugando 1.21.1 · mc.hypixel.net". tr(clave, datos).
export function activityLine(act, tr) {
  if (!act) return '';
  const base = act.mcVersion || 'Minecraft';
  const version = act.loader ? `${base} ${LOADERS[act.loader]}` : base;
  if (act.type === 'server') return act.address ? tr('act_server', { version, address: act.address }) : tr('act_multiplayer', { version });
  if (act.type === 'singleplayer') return act.world ? tr('act_world', { version, world: act.world }) : tr('act_singleplayer', { version });
  return tr('act_menu', { version });
}

// ---------- Amigos y conversaciones ----------
export function validFriendQuery(query, myCode = '') {
  const q = String(query || '').trim();
  if (!CODE_RE.test(q) && !USER_RE.test(q)) return { ok: false, error: 'invalid_query' };
  if (myCode && q.replace(/-/g, '').toUpperCase() === myCode.replace(/-/g, '').toUpperCase()) return { ok: false, error: 'cannot_add_self' };
  return { ok: true, query: q };
}

/**
 * Arma las listas de la pantalla de Amigos. friendships: filas de la tabla; profiles y activity: Map por usuario;
 * chatFor(usuario) -> conversación o null.
 */
export function buildLists({ friendships, profiles, activity, chatFor, me, nowMs, someone }) {
  const friends = [];
  const incoming = [];
  const outgoing = [];
  for (const r of friendships) {
    const otherId = r.requester === me ? r.addressee : r.requester;
    const profile = profiles.get(otherId) || { id: otherId, username: '' };
    const name = displayName(profile) || someone;
    if (r.status === 'accepted') {
      const chat = chatFor(otherId);
      friends.push({
        id: otherId,
        name,
        profile,
        ...presenceOf(activity.get(otherId), nowMs),
        statusText: statusTextOf(profile, nowMs),
        chatId: chat?.id || null,
        unread: chat?.unread || 0,
        lastAt: chat?.lastMessage?.at || chat?.lastMessageAt || null,
      });
    } else if (r.status === 'pending') {
      (r.requester === me ? outgoing : incoming).push({ id: otherId, name, profile, at: r.created_at });
    }
  }
  friends.sort((a, b) => {
    const ga = isOnline(a.presence) ? 0 : 1;
    const gb = isOnline(b.presence) ? 0 : 1;
    if (ga !== gb) return ga - gb;
    return ts(b.lastAt) - ts(a.lastAt) || a.name.localeCompare(b.name);
  });
  const byDate = (a, b) => ts(b.at) - ts(a.at);
  return { friends, incoming: incoming.sort(byDate), outgoing: outgoing.sort(byDate) };
}

// El estado escrito puede tener vencimiento (0027)
export function statusTextOf(profile, nowMs) {
  const text = cleanText(profile?.status_text, 120);
  if (!text) return '';
  const until = profile?.status_until ? Date.parse(profile.status_until) : null;
  return Number.isFinite(until) && until <= nowMs ? '' : text;
}

// Resumen de la fila de social_conversations
export function lastFromConversation(c) {
  if (!c?.last_id) return null;
  return { id: c.last_id, senderId: c.last_sender, body: c.last_deleted ? '' : String(c.last_body || ''), deleted: Boolean(c.last_deleted), at: c.last_created_at };
}

export function summary(row) {
  if (!row) return null;
  return { id: row.id, senderId: row.sender_id, body: row.deleted ? '' : String(row.body || '').slice(0, 200), deleted: Boolean(row.deleted), at: row.created_at, local: Boolean(row._local) };
}

// Lo que se lee en la lista de conversaciones
export function previewText(last, { me, base, media, tr }) {
  if (!last) return '';
  if (last.deleted) return tr('msg_deleted_short');
  if (media.stickerOf(last.body, last.senderId, base)) return tr('preview_sticker');
  const text = media.gifOf(last.body) ? tr('preview_gif') : String(last.body || '').replace(/\s+/g, ' ');
  return last.senderId === me ? tr('msg_you', { text }) : text;
}

// Inserta o reemplaza por id y deja todo ordenado. La copia local nunca pisa a la del servidor.
export function upsertMessage(list, row) {
  const i = list.findIndex((m) => m.id === row.id);
  let next;
  if (i >= 0) {
    if (row._local && !list[i]._local) return list;
    next = [...list];
    next[i] = row._local ? { ...next[i], ...row } : { ...row };
  } else {
    next = [...list, { ...row }];
  }
  return next.sort((a, b) => ts(a.created_at) - ts(b.created_at) || (a.id < b.id ? -1 : 1));
}

export function cleanBody(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim();
}

// ---------- Links dentro del texto ----------
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?'"»)\]}]$/;

function trimUrl(url) {
  let out = url;
  while (TRAILING.test(out)) {
    if (out.endsWith(')') && (out.match(/\(/g) || []).length >= (out.match(/\)/g) || []).length) break;
    out = out.slice(0, -1);
  }
  return out;
}

// [{ text }, { url }, ...]: se dibuja con nodos de texto y <a> con href http o https.
export function splitLinks(text) {
  const s = String(text ?? '');
  const out = [];
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (url.length < 10) continue;
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ url });
    last = m.index + url.length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

// ---------- Fechas y tamaños ----------
export function timeLabel(iso, lang) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
}

export function dayKey(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dateLabel(iso, lang, nowMs = Date.now()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date(nowMs);
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(lang, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

// Hora si es de hoy, fecha si no
export function shortStamp(iso, lang, nowMs = Date.now()) {
  return dayKey(iso) === dayKey(new Date(nowMs).toISOString()) ? timeLabel(iso, lang) : dateLabel(iso, lang, nowMs);
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '';
  if (v < 1024 * 1024) return `${Math.max(1, Math.round(v / 1024))} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- Rutas ----------
const CLIP_TABS = new Set(['received', 'mine', 'gallery']);

export function parseRoute(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  const [page, arg] = parts;
  if (page === 'messages') return arg && UUID_RE.test(arg) ? { page: 'chat', userId: arg } : { page: 'messages' };
  if (page === 'clips') return { page: 'clips', tab: CLIP_TABS.has(arg) ? arg : 'received' };
  if (page === 'inbox' || page === 'account') return { page };
  return { page: 'friends' };
}

// El cliente falso solo existe en esta PC: localhost y con el parámetro. En producción no se carga.
export function fakeAllowed(loc) {
  const local = loc?.hostname === 'localhost' || loc?.hostname === '127.0.0.1';
  return local && new URLSearchParams(loc?.search || '').get('fake') === '1';
}

// ---------- Errores ----------
const KNOWN_ERRORS = new Set([
  'user_not_found', 'cannot_add_self', 'user_blocked', 'too_many_requests', 'request_not_found', 'not_friends', 'invalid_query',
  'not_authenticated', 'conversation_not_found', 'rate_limited', 'user_muted', 'user_banned',
]);
const MISSING_CODES = new Set(['PGRST202', 'PGRST205', '42P01', '42883']);

export const isMissing = (err) => MISSING_CODES.has(String(err?.code || '')) || /could not find the (function|table)/i.test(String(err?.message || ''));
export const isNetwork = (err) => err?.status === 0 || /failed to fetch|networkerror|fetch failed|network request failed|load failed|timed? ?out/i.test(String(err?.message || ''));

// Clave de texto para un error de la API
export function errorKey(err) {
  const raw = String(err?.message || '').trim();
  if (KNOWN_ERRORS.has(raw)) return `err_${raw}`;
  if (isMissing(err)) return 'err_service';
  if (isNetwork(err)) return 'err_network';
  const code = String(err?.code || '');
  if (code === '42501' || /row-level security/i.test(raw)) return 'err_not_friends';
  if (code === '23514' || code === '22001' || code === '22023') return 'err_invalid';
  return 'err_generic';
}

// Lo mismo para los errores de la cuenta (como en Ajustes del launcher)
export function authErrorKey(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || err || '');
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'auth_credentials';
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) return 'auth_not_confirmed';
  if (['user_already_exists', 'email_exists'].includes(code) || /already registered|already exists/i.test(msg)) return 'auth_exists';
  if (code === 'same_password' || /different from the old/i.test(msg)) return 'auth_same_password';
  if (code === 'weak_password' || /password should|password is too|weak password/i.test(msg)) return 'auth_weak';
  if (code === 'otp_expired' || /token has expired|invalid otp|otp.*(invalid|expired)|token.*(invalid|expired)/i.test(msg)) return 'auth_code';
  if (/rate_limit/.test(code) || err?.status === 429 || /rate limit|security purposes/i.test(msg)) return 'auth_rate';
  if (code === 'signup_disabled' || /signups? not allowed|signup.*disabled/i.test(msg)) return 'auth_signup_disabled';
  if (code === 'email_address_invalid' || /invalid.*email|email.*invalid/i.test(msg)) return 'auth_email';
  if (err?.name === 'AuthRetryableFetchError' || /failed to fetch|fetch failed|network|load failed/i.test(msg)) return 'err_network';
  return 'err_generic';
}

// ---------- Avisos push ----------
export function urlB64ToBytes(text) {
  const clean = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function sameKeyBytes(a, b) {
  if (!a || !b) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export const isIos = (ua = '', platform = '', touchPoints = 0) => /iphone|ipad|ipod/i.test(ua) || (platform === 'MacIntel' && touchPoints > 1);

// 'ok' | 'ios_install' (iPhone: hay que agregarla a la pantalla de inicio) | 'ios_old' | 'unsupported'
export function pushSupport({ hasSW, hasPush, hasNotification, standalone, ua = '', platform = '', touchPoints = 0 }) {
  if (hasSW && hasPush && hasNotification) return 'ok';
  if (isIos(ua, platform, touchPoints)) {
    if (standalone) return 'ios_old'; // instalada y sin Web Push: iOS anterior a 16.4
    return 'ios_install';
  }
  return 'unsupported';
}

// Lo que se guarda como etiqueta del celular
export function deviceLabel(ua = '') {
  if (/iphone/i.test(ua)) return 'iPhone';
  if (/ipad/i.test(ua)) return 'iPad';
  if (/android/i.test(ua)) return 'Android';
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac os/i.test(ua)) return 'Mac';
  return 'Navegador';
}

// ---------- Clips ----------
export function normalizeMine(row) {
  return {
    id: row.id,
    kind: row.kind === 'clip' ? 'clip' : 'screenshot',
    name: cleanText(row.file_name, 200) || row.id,
    place: cleanText(row.world, 120) || cleanText(row.instance_name, 120),
    size: Number(row.size_bytes) || 0,
    at: row.taken_at || row.created_at,
    url: row.url || null,
    expired: Boolean(row.expires_at && Date.parse(row.expires_at) <= Date.now()),
    bucket: row.bucket,
    path: row.path,
  };
}

export function normalizeReceived(row) {
  return { id: row.id, kind: row.kind === 'clip' ? 'clip' : 'screenshot', name: cleanText(row.name, 120) || row.id, from: cleanText(row.from, 40), userId: row.userId, at: row.at, url: row.url || null, seen: Boolean(row.seen) };
}

// La galería pública (gallery_list, migración 0032): siempre clips, con el autor como { name } o texto.
export function normalizeGallery(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
  return list
    .filter((r) => r && typeof r === 'object' && r.id != null)
    .map((r) => {
      const author = r.author && typeof r.author === 'object' ? r.author.displayName || r.author.name || r.author.username : r.author;
      return { id: String(r.id), kind: 'clip', name: cleanText(r.title, 80) || String(r.id), from: cleanText(author, 40), at: r.at ?? null, url: r.url ?? null };
    });
}
