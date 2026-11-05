import { cleanLine, cleanText } from '../../features/communities/logic.js';
// Comunidades: lógica pura de canales y mensajes, sin DOM. Los permisos son para mostrar u ocultar botones: el servidor los
// vuelve a comprobar en cada RPC (0033_clanes_comunidades.sql y 0038_comunidades.sql).
export const PAGE_SIZE = 50;
export const MUTE_OPTIONS = [10, 60, 1440, 10080];
const GROUP_WINDOW_MS = 5 * 60000;

export const isStaff = (role) => role === 'owner' || role === 'moderator';

/** ¿actor puede silenciar o expulsar a target? El dueño a cualquiera, el moderador solo a miembros, y nadie a sí mismo. */
export function canModerate(actor, target, { self = false } = {}) {
  if (self || !target || target === 'owner') return false;
  return actor === 'owner' || (actor === 'moderator' && target === 'member');
}

/** Roles propios: los asigna el equipo y solo a miembros comunes (dueño y moderadores ya saltean los permisos). */
export const canAssignRole = (actor, target) => isStaff(actor) && target === 'member';

// Los avisos de bienvenida y despedida los borra solo el equipo.
export const canDeleteMessage = (msg, me, role) => !!msg && !msg.deleted && !!role && ((msg.authorId === me && !msg.system) || isStaff(role));
export const canReportMessage = (msg, me) => !!msg && !msg.deleted && !msg.system && msg.authorId !== me;

/** Canales en el orden del servidor, separados por tipo. */
export function channelsByKind(channels) {
  const list = [...(Array.isArray(channels) ? channels : [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return { text: list.filter((c) => c.kind === 'text'), voice: list.filter((c) => c.kind === 'voice'), all: list };
}

/** El canal que corresponde abrir: el pedido si sigue existiendo y admite mensajes o temas, si no el primero disponible. */
export function pickChannel(channels, wanted) {
  const list = channelsByKind(channels).all.filter((ch) => ['text', 'announcement', 'forum'].includes(ch.kind));
  return list.find((c) => c.id === wanted) || list[0] || null;
}

/** Orden nuevo de todos los canales al mover uno; null si no se puede mover para ese lado. */
export function moveChannel(ids, id, delta) {
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const out = [...ids];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

const atOf = (m) => Date.parse(m?.at) || 0;

/** Un GIF subido que llega por Realtime trae solo el id: no pisa al que ya tiene la ruta. Un borrado se lleva el GIF. */
function mergeMedia(old, next, gone) {
  if (gone) return null;
  if (next?.kind === 'upload' && !next.path && old?.kind === 'upload' && old.id === next.id) return old;
  return next ?? old ?? null;
}

/** Junta mensajes por id (el que llega último manda, pero un borrado no se deshace), del más viejo al más nuevo. */
export function mergeMessages(list, incoming) {
  const map = new Map((list || []).map((m) => [m.id, m]));
  for (const m of incoming || []) {
    if (!m?.id) continue;
    const old = map.get(m.id);
    const gone = !!(old?.deleted || m.deleted);
    map.set(m.id, old ? { ...old, ...m, deleted: gone, body: gone ? '' : m.body, media: mergeMedia(old.media, m.media, gone), reactions: gone ? [] : m.reactions || old.reactions || [], author: m.author || old.author } : m);
  }
  return [...map.values()].sort((a, b) => atOf(a) - atOf(b) || String(a.id).localeCompare(String(b.id)));
}

/** Fila de Realtime (columnas de la tabla) a mensaje de la interfaz. people: userId -> persona conocida. */
export function messageFromRow(row, { people, isBlocked } = {}) {
  if (!row?.id || !row.author) return null;
  const hidden = !!isBlocked?.(row.author);
  return {
    id: row.id,
    channelId: row.channel_id,
    parentId: row.parent_id || null,
    title: hidden || row.deleted ? null : row.title || null,
    communityId: row.community_id,
    authorId: row.author,
    at: row.created_at,
    deleted: row.deleted === true,
    hidden,
    system: row.system === 'join' || row.system === 'leave' ? row.system : null,
    // Las reacciones no viajan por Realtime: se actualizan con la consulta periódica y con la propia acción.
    media: hidden || row.deleted || !row.media || typeof row.media !== 'object' ? null : row.media,
    body: hidden || row.deleted ? '' : String(row.body ?? ''),
    author: people?.get(row.author) || null,
  };
}

/** Bloques de mensajes seguidos de una misma cuenta (hasta 5 minutos entre uno y otro). Los avisos del sistema van solos. */
export function groupMessages(list, { windowMs = GROUP_WINDOW_MS } = {}) {
  const out = [];
  for (const m of list || []) {
    const last = out[out.length - 1];
    if (!m.system && last && !last.system && last.authorId === m.authorId && atOf(m) - last.lastAt <= windowMs) {
      last.items.push(m);
      last.lastAt = atOf(m);
    } else {
      out.push({ authorId: m.authorId, author: m.author, at: m.at, lastAt: atOf(m), system: m.system || null, items: [m] });
    }
  }
  return out;
}

/** El cursor para pedir mensajes más viejos. */
export const oldestAt = (list) => (list?.length ? list[0].at : null);

export const personName = (p) => String(p?.displayName || p?.username || '').trim();

/** ¿Sigue silenciado? */
export const isMuted = (until, now = Date.now()) => !!until && Date.parse(until) > now;

/** Lleva la cuenta de quién está en cada canal de voz sin repetir a nadie. */
export function voiceSummary(people, max = 8) {
  const list = Array.isArray(people) ? people.filter(Boolean) : [];
  return { count: list.length, full: list.length >= max, shown: list.slice(0, 4), extra: Math.max(0, list.length - 4) };
}

export const CHANNEL_KINDS = ['text', 'voice', 'announcement', 'forum'];
export const COMMUNITY_ICONS = ['users', 'gamepad', 'star', 'heart', 'shield', 'flame', 'mountain', 'moon', 'zap', 'book', 'message-circle', 'headphones', 'megaphone', 'hash'];
export const COMMUNITY_BANNERS = ['none', 'aurora', 'sunset', 'forest', 'ocean', 'stars'];
export const COMMUNITY_THEMES = ['default', 'cozy', 'compact'];
export const CATEGORY_LIMIT = 20;
export const TOPIC_PAGE_SIZE = 30;
export const safeCommunityIcon = (value, fallback = 'users') => COMMUNITY_ICONS.includes(value) ? value : fallback;
export const iconGlyph = (value) => ({ book: 'file', 'message-circle': 'message', megaphone: 'volume' }[value] || value);
export const channelIcon = (ch) => iconGlyph(safeCommunityIcon(ch?.icon, { text: 'hash', voice: 'headphones', announcement: 'megaphone', forum: 'message-circle' }[ch?.kind] || 'hash'));
export const safeBanner = (value) => COMMUNITY_BANNERS.includes(value) ? value : 'none';
export const safeTheme = (value) => COMMUNITY_THEMES.includes(value) ? value : 'default';
// El servidor ya entrega solo los canales que esa cuenta puede ver (dueño, moderadores y roles con "ver" en un canal privado).
export const visibleChannels = (community) => community?.channels || [];
/** Categorías vacías también se ven para poder agregar su primer canal. */
export function categoryGroups(community) {
  const categories = [...(community?.categories || [])].sort((a, b) => a.position - b.position);
  const ids = new Set(categories.map((c) => c.id));
  const channels = channelsByKind(visibleChannels(community)).all;
  return [...categories.map((c) => ({ ...c, channels: channels.filter((ch) => ch.categoryId === c.id) })),
    { id: null, name: '', channels: channels.filter((ch) => !ids.has(ch.categoryId)) }];
}
/** RPC recibe el orden global completo; las flechas mueven dentro de la categoría. */
export function moveWithinCategory(channels, id, delta) {
  const all = channelsByKind(channels).all;
  const channel = all.find((ch) => ch.id === id);
  if (!channel) return null;
  const same = (ch) => (ch.categoryId || null) === (channel.categoryId || null);
  const moved = moveChannel(all.filter(same).map((ch) => ch.id), id, delta);
  if (!moved) return null;
  let at = 0;
  return all.map((ch) => same(ch) ? moved[at++] : ch.id);
}
export function canPostIn(community, channel) {
  if (!community?.myRole || isMuted(community.mutedUntil) || !channel || channel.kind === 'voice') return false;
  // canPost trae los permisos por canal y por rol; sin él (datos viejos) rige solo el canal.
  if (typeof channel.canPost === 'boolean') return channel.canPost;
  return !((channel.isPrivate || channel.kind === 'announcement' || channel.postingRole === 'staff') && !isStaff(community.myRole));
}
/** Enlaces y GIFs: además de escribir, el canal tiene que permitirlos. */
export const canEmbedIn = (community, channel) => canPostIn(community, channel) && channel?.canEmbed !== false;
export const canReactIn = (community, channel) => !!community?.myRole && !!channel && channel.kind !== 'voice' && !isMuted(community.mutedUntil) && channel.canReact !== false;
/** Misma heurística que private.community_has_link: el servidor decide, esto solo avisa antes de mandar. */
export const hasLink = (text) => /(https?:\/\/|www\.|discord\.gg\/|discord(app)?\.com\/invite)/i.test(String(text ?? ''));
export const REACTIONS = ['like', 'love', 'laugh', 'wow', 'sad', 'party', 'fire', 'eyes'];
export const REACTION_GLYPHS = { like: '👍', love: '❤️', laugh: '😂', wow: '😮', sad: '😢', party: '🎉', fire: '🔥', eyes: '👀' };
export const safeReactions = (list) => (Array.isArray(list) ? list : []).filter((r) => REACTIONS.includes(r?.emoji) && Number(r.count) > 0).map((r) => ({ emoji: r.emoji, count: Number(r.count), mine: r.mine === true }));
export function waitSeconds(community, channel, now = Date.now()) {
  return isStaff(community?.myRole) ? 0 : Math.max(0, Math.ceil(((Date.parse(channel?.nextPostAt) || 0) - now) / 1000));
}
/** El reloj del servidor persiste al recargar; el envío actualiza la espera sin perder el borrador. */
export function afterPost(community, channel, at = new Date().toISOString()) {
  if (isStaff(community?.myRole) || !channel?.slowmodeSeconds) return channel;
  const next = (Date.parse(at) || Date.now()) + channel.slowmodeSeconds * 1000;
  return { ...channel, nextPostAt: new Date(Math.max(Date.parse(channel.nextPostAt) || 0, next)).toISOString() };
}
const checkedText = (value, min, max, error, line = false) => {
  const clean = line ? cleanLine(value) : cleanText(value);
  return clean === null || [...clean].length < min || [...clean].length > max
    ? { ok: false, error } : { ok: true, value: clean };
};
export const validateCategoryName = (value) => checkedText(value, 1, 40, 'bad_category_name', true);
export const validateTopicTitle = (value) => checkedText(value, 3, 120, 'bad_title', true);
export function validateChannelSettings(value, categories = []) {
  const name = checkedText(value.name, 1, 30, 'bad_channel_name', true);
  const topic = checkedText(value.topic, 0, 500, 'bad_topic');
  if (!name.ok) return name;
  if (!topic.ok) return topic;
  if (!CHANNEL_KINDS.includes(value.kind)) return { ok: false, error: 'bad_kind' };
  if (!COMMUNITY_ICONS.includes(value.icon)) return { ok: false, error: 'bad_icon' };
  if (value.categoryId && !categories.some((c) => c.id === value.categoryId)) return { ok: false, error: 'bad_category' };
  const seconds = Number(value.slowmodeSeconds);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) return { ok: false, error: 'bad_slowmode' };
  if (!['members', 'staff'].includes(value.postingRole)) return { ok: false, error: 'bad_posting_role' };
  return { ok: true, value: {
    name: name.value, topic: topic.value, icon: value.icon, categoryId: value.categoryId || null,
    slowmodeSeconds: value.kind === 'voice' ? 0 : seconds,
    postingRole: value.kind === 'announcement' ? 'staff' : value.kind === 'voice' ? 'members' : value.postingRole,
    isPrivate: value.isPrivate === true,
  } };
}
export function validateAppearance(value) {
  for (const [key, allowed] of [['theme', COMMUNITY_THEMES], ['icon', COMMUNITY_ICONS], ['banner', COMMUNITY_BANNERS]]) {
    if (!allowed.includes(value[key])) return { ok: false, error: 'bad_' + key };
  }
  if (!/^#[0-9a-f]{6}$/i.test(value.color)) return { ok: false, error: 'bad_color' };
  const welcome = checkedText(value.welcome, 0, 2000, 'bad_welcome');
  const rules = checkedText(value.rules, 0, 4000, 'bad_rules');
  if (!welcome.ok) return welcome;
  if (!rules.ok) return rules;
  return { ok: true, value: { theme: value.theme, color: value.color, icon: value.icon, banner: value.banner, welcome: welcome.value, rules: rules.value } };
}

export const communityColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value.toLowerCase() : '#f6b45a';

/** Una respuesta antigua no acorta la espera; cambiar la configuración sí la sustituye. */
export function mergeChannelState(current, next) {
  if (!next) return current;
  const keep = next.slowmodeSeconds > 0 && next.slowmodeSeconds === current.slowmodeSeconds && Date.parse(current.nextPostAt) > (Date.parse(next.nextPostAt) || 0);
  return { ...next, nextPostAt: keep ? current.nextPostAt : next.nextPostAt };
}
