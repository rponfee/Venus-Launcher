// Logica pura de lo social de la 3.1 (sin DOM ni imports, para probarla con Node): bandeja de regalos, quien entro a
// una sala de voz, libro de visitas y el reproductor de la cancion del perfil.
// La usan social/gifts.js, social/guestbook.js, social/song.js y voice/ui-room.js.

export const ENTRY_EFFECT_MS = 1500;
export const GUESTBOOK_PAGE = 10;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const timeOf = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

// ---------- Regalos ----------
// Regalos de gifts_received que todavia no se mostraron (mas nuevos que lastSeen), del mas viejo al mas nuevo
export function newGifts(list, lastSeen = null) {
  const since = timeOf(lastSeen) ?? 0;
  return (Array.isArray(list) ? list : [])
    .filter((g) => isObj(g) && (g.kind === 'points' || g.kind === 'item') && timeOf(g.at) !== null && timeOf(g.at) > since)
    .sort((a, b) => timeOf(a.at) - timeOf(b.at));
}
// La marca mas nueva de una lista de regalos (ISO) o lastSeen si no hay nada mas nuevo
export function latestGiftAt(list, lastSeen = null) {
  let best = timeOf(lastSeen) ?? 0;
  for (const g of Array.isArray(list) ? list : []) {
    const t = timeOf(g?.at);
    if (t !== null && t > best) best = t;
  }
  return best ? new Date(best).toISOString() : null;
}
// Hay un gift_in en el historial de points_me mas nuevo que lastSeen (dispara la consulta a gifts_received)
export function hasNewGiftIn(history, lastSeen = null) {
  const since = timeOf(lastSeen) ?? 0;
  return (Array.isArray(history) ? history : []).some((r) => r && r.reason === 'gift_in' && (timeOf(r.at) ?? 0) > since);
}

// ---------- Salas de voz ----------
// Ids que entraron (estan en next y no en prev), sin el propio. En la primera lista nadie "entra".
export function joinedMembers(prev, next, { selfId = null, initial = false } = {}) {
  if (initial) return [];
  const before = new Set((Array.isArray(prev) ? prev : []).map((m) => m?.userId).filter(Boolean));
  return (Array.isArray(next) ? next : []).map((m) => m?.userId).filter((id) => id && !before.has(id) && id !== selfId && !(next.find((m) => m.userId === id)?.self));
}

// ---------- Libro de visitas ----------
export function canPostGuestbook({ isOwner = false, isFriend = false, enabled = false, blocked = false, moderation = null } = {}) {
  if (!enabled || blocked) return false;
  if (moderation && (moderation.banned || moderation.muted)) return false;
  return Boolean(isOwner || isFriend);
}
// Junta paginas del libro sin repetir y del mas nuevo al mas viejo
export function mergeGuestbook(current, more) {
  const seen = new Set();
  const out = [];
  for (const e of [...(Array.isArray(current) ? current : []), ...(Array.isArray(more) ? more : [])]) {
    if (!isObj(e) || !e.id || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out.sort((a, b) => (timeOf(b.at) ?? 0) - (timeOf(a.at) ?? 0));
}
// Fecha para pedir "ver mas": la mas vieja de lo que ya hay
export function oldestGuestbookAt(entries) {
  let oldest = null;
  for (const e of Array.isArray(entries) ? entries : []) {
    const t = timeOf(e?.at);
    if (t !== null && (oldest === null || t < oldest)) oldest = t;
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}

// ---------- Cancion del perfil ----------
// Si arranca sola al abrir la tarjeta: solo para amigos (o el dueño), con el ajuste prendido y nunca en vista previa
export function shouldAutoplaySong({ song = null, allowed = true, preview = false, self = false, friend = false } = {}) {
  return Boolean(song && song.url) && allowed !== false && !preview && (self || friend);
}
export function volumeStep(v, dir) {
  const cur = Number.isFinite(v) ? v : 0.6;
  return Math.max(0, Math.min(1, Math.round((cur + dir * 0.1) * 10) / 10));
}
