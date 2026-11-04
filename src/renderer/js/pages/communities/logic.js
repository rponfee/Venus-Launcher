// Comunidades: lógica pura de canales y mensajes, sin DOM. Los permisos son para mostrar u ocultar botones: el servidor los
// vuelve a comprobar en cada RPC (0033_clanes_comunidades.sql).
export const PAGE_SIZE = 50;
export const MUTE_OPTIONS = [10, 60, 1440, 10080];
const GROUP_WINDOW_MS = 5 * 60000;

export const isStaff = (role) => role === 'owner' || role === 'moderator';

/** ¿actor puede silenciar o expulsar a target? El dueño a cualquiera, el moderador solo a miembros, y nadie a sí mismo. */
export function canModerate(actor, target, { self = false } = {}) {
  if (self || !target || target === 'owner') return false;
  return actor === 'owner' || (actor === 'moderator' && target === 'member');
}

export const canDeleteMessage = (msg, me, role) => !!msg && !msg.deleted && !!role && (msg.authorId === me || isStaff(role));
export const canReportMessage = (msg, me) => !!msg && !msg.deleted && msg.authorId !== me;

/** Canales en el orden del servidor, separados por tipo. */
export function channelsByKind(channels) {
  const list = [...(Array.isArray(channels) ? channels : [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return { text: list.filter((c) => c.kind === 'text'), voice: list.filter((c) => c.kind === 'voice'), all: list };
}

/** El canal que corresponde abrir: el pedido si sigue existiendo y es de texto, si no el primero de texto. */
export function pickChannel(channels, wanted) {
  const { text } = channelsByKind(channels);
  return text.find((c) => c.id === wanted) || text[0] || null;
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

/** Junta mensajes por id (el que llega último manda, pero un borrado no se deshace), del más viejo al más nuevo. */
export function mergeMessages(list, incoming) {
  const map = new Map((list || []).map((m) => [m.id, m]));
  for (const m of incoming || []) {
    if (!m?.id) continue;
    const old = map.get(m.id);
    map.set(m.id, old ? { ...old, ...m, deleted: old.deleted || m.deleted, body: old.deleted || m.deleted ? '' : m.body, author: m.author || old.author } : m);
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
    communityId: row.community_id,
    authorId: row.author,
    at: row.created_at,
    deleted: row.deleted === true,
    hidden,
    body: hidden || row.deleted ? '' : String(row.body ?? ''),
    author: people?.get(row.author) || null,
  };
}

/** Bloques de mensajes seguidos de una misma cuenta (hasta 5 minutos entre uno y otro). */
export function groupMessages(list, { windowMs = GROUP_WINDOW_MS } = {}) {
  const out = [];
  for (const m of list || []) {
    const last = out[out.length - 1];
    if (last && last.authorId === m.authorId && atOf(m) - last.lastAt <= windowMs) {
      last.items.push(m);
      last.lastAt = atOf(m);
    } else {
      out.push({ authorId: m.authorId, author: m.author, at: m.at, lastAt: atOf(m), items: [m] });
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
