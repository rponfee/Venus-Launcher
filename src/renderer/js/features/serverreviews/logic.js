// Reseñas y votos de servidores destacados: lógica sin DOM (se prueba con Node puro). Lo que devuelve la base viene de
// otros usuarios: acá se normaliza y se recorta, y la interfaz siempre lo muestra como texto.
export const MAX_BODY = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Códigos de error de 0029_resenas_servidores.sql (el mensaje del error es el código)
export const SERVER_CODES = new Set(['not_authenticated', 'user_banned', 'user_muted', 'bad_server', 'bad_stars', 'bad_body', 'too_many_today', 'too_fast', 'bad_review', 'own_review', 'bad_reason', 'bad_text', 'not_found', 'admin_only', 'bad_filter']);

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// Solo los destacados de la nube tienen reseñas: los de la lista incluida con el launcher no tienen fila en la base
export const canReview = (server) => isUuid(server?.id) && (server?.source === 'cloud' || server?.source === 'cache');

const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

// Sin controles (salvo saltos de línea y tabulaciones) y con el largo que admite la base
export function cleanBody(text, max = MAX_BODY) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || (c >= 32 && c !== 127)) out += ch;
    if (out.length >= max * 2) break;
  }
  return out.trim().slice(0, max);
}

export const bodyLength = (text) => [...String(text ?? '').trim()].length;

export function normalizeStats(raw) {
  const avg = raw?.avg === null || raw?.avg === undefined || raw?.avg === '' ? null : Number(raw.avg);
  return { avg: Number.isFinite(avg) && avg > 0 ? Math.min(5, avg) : null, count: count(raw?.count), votes: count(raw?.votes) };
}

export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || !isUuid(raw.id)) return null;
  const at = Date.parse(raw.at);
  const updatedAt = Date.parse(raw.updatedAt);
  return {
    id: raw.id,
    stars: Math.max(1, Math.min(5, count(raw.stars) || 1)),
    body: cleanBody(raw.body),
    at: Number.isFinite(at) ? at : null,
    edited: Number.isFinite(at) && Number.isFinite(updatedAt) && updatedAt - at > 60000,
    mine: raw.mine === true,
    hidden: raw.hidden === true,
    author: { name: cleanBody(raw.author?.displayName || raw.author?.username || '', 32), mcName: /^[A-Za-z0-9_]{1,16}$/.test(raw.author?.mcName || '') ? raw.author.mcName : null },
  };
}

export function normalizeList(raw) {
  const nextAt = raw?.vote?.nextAt ? Date.parse(raw.vote.nextAt) : NaN;
  return {
    ...normalizeStats(raw),
    mine: normalizeEntry(raw?.mine),
    vote: raw?.vote ? { total: count(raw.vote.total), nextAt: Number.isFinite(nextAt) ? nextAt : null } : null,
    items: (Array.isArray(raw?.items) ? raw.items : []).map(normalizeEntry).filter(Boolean),
    next: typeof raw?.next === 'string' && raw.next ? raw.next : null,
  };
}

// Puede votar si nunca votó o ya pasaron las 24 h
export const canVoteAt = (vote, now = Date.now()) => !vote?.nextAt || vote.nextAt <= now;

// Horas enteras que faltan para volver a votar (al menos 1 mientras falte algo)
export function hoursLeft(vote, now = Date.now()) {
  if (canVoteAt(vote, now)) return 0;
  return Math.max(1, Math.ceil((vote.nextAt - now) / 3600000));
}

// Cuántas estrellas se pintan para un promedio
export const filledStars = (avg) => (avg ? Math.max(0, Math.min(5, Math.round(avg))) : 0);

// De cualquier error (PostgREST, red o ya clasificado) a un código para los textos
export function classifyError(err) {
  if (err?.reviewsCode) return err.reviewsCode;
  const message = String(err?.message ?? '').trim();
  if (SERVER_CODES.has(message)) return message;
  const code = String(err?.code ?? '');
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42883' || code === '42P01' || code === '404' || err?.status === 404) return 'unavailable';
  if (err?.name === 'TypeError' || /fetch|network|abort|timeout/i.test(message)) return 'network';
  return 'server';
}
