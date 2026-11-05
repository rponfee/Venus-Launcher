// Lógica pura de Soporte (sin DOM ni red, se prueba con Node): categorías con campos propios, validación, tarjeta de crédito
// pegada por error, borradores, preguntas frecuentes locales, filtros de la lista y de la cola del equipo, capturas y
// respuestas guardadas. Los límites son los mismos que aplica el servidor (migración 0045) y que repite
// src/main/modules/support/rules.js.

// Temas que ofrece el formulario ('general' y 'account' siguen existiendo en consultas viejas).
export const CATEGORIES = ['bug', 'game', 'payments', 'assistant', 'suggestion', 'other'];
export const LEGACY_CATEGORIES = ['general', 'account'];
export const ALL_CATEGORIES = [...CATEGORIES, ...LEGACY_CATEGORIES];
export const CATEGORY_ICONS = { bug: 'bug', game: 'gamepad', payments: 'card', assistant: 'sparkles', suggestion: 'spLightbulb', other: 'message', general: 'message', account: 'user' };
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

export const LIMITS = {
  subject: [3, 120],
  message: [10, 4000], // el servidor acepta desde 1; el formulario pide algo útil
  reply: [1, 4000],
  note: 2000,
  closeNote: 500,
  diagnostic: 12000,
  ratingComment: 500,
  macroTitle: 60,
  macroBody: 2000,
  search: 60,
  openTickets: 3,
  reopenDays: 14,
  reopenTimes: 3,
};
export const ATTACH = { perSend: 3, perTicket: 12, maxBytes: 4 * 1024 * 1024, mime: ['image/png', 'image/jpeg', 'image/webp'], maxSide: 1600 };

// Campos propios de cada tema. kind: select (options), text (una línea), area (varias líneas), date (AAAA-MM-DD).
const sel = (id, options, required = false) => ({ id, kind: 'select', options, required });
export const DETAIL_FIELDS = {
  bug: [sel('area', ['launcher', 'install', 'update', 'account', 'social', 'other'], true), sel('frequency', ['always', 'sometimes', 'once']), { id: 'steps', kind: 'area', max: 600 }],
  game: [{ id: 'mcVersion', kind: 'text', max: 24, required: true }, sel('loader', ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'other']), sel('moment', ['launch', 'loading', 'playing', 'closing'], true), sel('modsChanged', ['yes', 'no', 'unknown']), { id: 'steps', kind: 'area', max: 600 }],
  payments: [sel('topic', ['login', 'profile', 'sanction', 'payment', 'refund', 'other'], true), sel('method', ['mercado_pago', 'paypal', 'other']), { id: 'paidOn', kind: 'date', max: 10 }, { id: 'orderRef', kind: 'text', max: 80 }],
  assistant: [sel('plan', ['none', 'basic', 'go', 'pro', 'max']), sel('issue', ['noreply', 'limit', 'wrong', 'billing', 'other'], true)],
  suggestion: [sel('area', ['launcher', 'play', 'social', 'ai', 'other'], true), { id: 'benefit', kind: 'area', max: 400 }],
  other: [], general: [], account: [],
};
// Campos que solo corresponden si otro tiene cierto valor (por ejemplo, el medio de pago solo en pagos y reembolsos).
export function fieldVisible(category, field, details = {}) {
  if (category === 'payments' && ['method', 'paidOn', 'orderRef'].includes(field.id)) return ['payment', 'refund'].includes(details.topic);
  return true;
}

// ---------- Tarjetas pegadas por error ----------
function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
// Número de tarjeta (13 a 19 dígitos, con espacios o guiones, que pasa el control de Luhn): nunca debería viajar en una consulta.
export function looksLikeCard(text) {
  for (const m of String(text ?? '').matchAll(/(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits)) return true;
  }
  return false;
}

// ---------- Validación ----------
const CONTROL = /[\u0000-\u0008\u000b-\u001f]/;
export const len = (s) => String(s ?? '').trim().length;

// Devuelve los datos propios ya limpios (sin vacíos, sin ocultos ni inválidos).
export function cleanDetails(category, details = {}) {
  const out = {};
  for (const field of DETAIL_FIELDS[category] || []) {
    const raw = typeof details[field.id] === 'string' ? details[field.id].trim() : '';
    if (!raw || !fieldVisible(category, field, details)) continue;
    if (field.kind === 'select' && !field.options.includes(raw)) continue;
    if (field.kind !== 'select' && (raw.length > field.max || CONTROL.test(raw))) continue;
    if (field.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
    out[field.id] = raw;
  }
  return out;
}

// -> { ok, errors: { category, subject, message, diagnostic, details: { campo: codigo } }, first }
// Los códigos son claves de texto: required, short, long, card, date. `first` es el primer campo con problema, en orden de pantalla.
export function validateTicket(form = {}, { diagnosticChars = 0 } = {}) {
  const errors = { details: {} };
  const category = form.category;
  if (!CATEGORIES.includes(category)) errors.category = 'required';
  const subject = len(form.subject);
  if (subject < LIMITS.subject[0]) errors.subject = subject ? 'short' : 'required';
  else if (subject > LIMITS.subject[1]) errors.subject = 'long';
  else if (looksLikeCard(form.subject)) errors.subject = 'card';
  const message = len(form.message);
  if (message < LIMITS.message[0]) errors.message = message ? 'short' : 'required';
  else if (message > LIMITS.message[1]) errors.message = 'long';
  else if (looksLikeCard(form.message)) errors.message = 'card';
  const details = form.details || {};
  for (const field of DETAIL_FIELDS[category] || []) {
    if (!fieldVisible(category, field, details)) continue;
    const value = typeof details[field.id] === 'string' ? details[field.id].trim() : '';
    if (!value) { if (field.required) errors.details[field.id] = 'required'; continue; }
    if (field.kind === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))) errors.details[field.id] = 'date';
    else if (field.kind !== 'select' && value.length > field.max) errors.details[field.id] = 'long';
    else if (field.kind !== 'select' && looksLikeCard(value)) errors.details[field.id] = 'card';
  }
  if (diagnosticChars > LIMITS.diagnostic) errors.diagnostic = 'long';
  const order = ['category', 'subject', ...(DETAIL_FIELDS[category] || []).map((f) => `details.${f.id}`), 'message', 'diagnostic'];
  const bad = (key) => (key.startsWith('details.') ? errors.details[key.slice(8)] : errors[key]);
  const first = order.find(bad) || null;
  return { ok: !first, errors, first };
}

export function validateReply(body) {
  const n = len(body);
  if (n < LIMITS.reply[0]) return { ok: false, error: 'required' };
  if (n > LIMITS.reply[1]) return { ok: false, error: 'long' };
  if (looksLikeCard(body)) return { ok: false, error: 'card' };
  return { ok: true, error: null };
}

// Contador de caracteres: queda cuánto falta y cuándo avisar (a menos del 10 %, o pasado).
export function counter(text, max) {
  const used = String(text ?? '').trim().length;
  const left = max - used;
  return { used, left, level: left < 0 ? 'over' : left <= Math.max(10, Math.round(max * 0.1)) ? 'near' : 'ok' };
}

// ---------- Borradores ----------
export const DRAFT_VERSION = 1;
export const draftKey = (userId) => `venus.support.draft.${String(userId || 'anon').slice(0, 64)}`;
export const replyDraftKey = (userId, ticketId) => `venus.support.reply.${String(userId || 'anon').slice(0, 64)}.${String(ticketId || '').slice(0, 64)}`;

export function draftIsEmpty(d) {
  return !d || (!len(d.subject) && !len(d.message) && !Object.values(d.details || {}).some((v) => len(v)));
}
export function serializeDraft(d) {
  if (draftIsEmpty(d)) return '';
  return JSON.stringify({ v: DRAFT_VERSION, category: d.category, subject: String(d.subject ?? '').slice(0, LIMITS.subject[1]), message: String(d.message ?? '').slice(0, LIMITS.message[1]), details: d.details || {}, savedAt: d.savedAt || Date.now() });
}
export function parseDraft(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 20000) return null;
  let d;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || typeof d !== 'object' || d.v !== DRAFT_VERSION) return null;
  const category = ALL_CATEGORIES.includes(d.category) ? d.category : 'bug';
  const details = {};
  if (d.details && typeof d.details === 'object') for (const [k, v] of Object.entries(d.details)) if (typeof v === 'string' && /^\w{1,24}$/.test(k)) details[k] = v.slice(0, 600);
  const draft = { category, subject: typeof d.subject === 'string' ? d.subject.slice(0, LIMITS.subject[1]) : '', message: typeof d.message === 'string' ? d.message.slice(0, LIMITS.message[1]) : '', details, savedAt: Number(d.savedAt) || 0 };
  return draftIsEmpty(draft) ? null : draft;
}

// ---------- Preguntas frecuentes locales ----------
// Cada entrada: palabras que bastan solas (strong), palabras que suman (words) y el tema en que suele caer. Los textos de
// pregunta y respuesta están en el diccionario (faq_<id>_q / faq_<id>_a); acá solo hay palabras para comparar y el destino.
export const FAQ = [
  { id: 'signin', cats: ['payments', 'other', 'bug'], strong: ['contrasena', 'password', 'sesion', 'login', 'signin'], words: ['cuenta', 'correo', 'email', 'mail', 'verificar', 'clave', 'acceso', 'entrar', 'access', 'account', 'verify'], go: { route: 'settings/cloud/venus' } },
  { id: 'plan', cats: ['payments', 'assistant'], strong: ['plan', 'pago', 'pague', 'pagado', 'paypal', 'mercado', 'payment', 'paid', 'suscripcion'], words: ['activo', 'activar', 'acredito', 'acreditar', 'cobro', 'cobraron', 'active', 'charged', 'dinero', 'money'], go: { plans: true } },
  { id: 'limit', cats: ['assistant'], strong: ['limite', 'cupo', 'saldo', 'limit', 'quota'], words: ['asistente', 'preguntas', 'mensajes', 'tokens', 'renueva', 'assistant', 'questions', 'reset'], go: { plans: true } },
  { id: 'crash', cats: ['game', 'bug'], strong: ['crash', 'crashea', 'crasheo', 'cierra', 'cerro', 'crashed', 'crashing', 'closes'], words: ['juego', 'mundo', 'mods', 'abrir', 'iniciar', 'arranca', 'minecraft', 'game', 'world', 'launch'], go: { route: 'versions' } },
  { id: 'java', cats: ['game', 'bug'], strong: ['java', 'jvm'], words: ['version', 'instalar', 'error', 'memoria', 'ram', 'memory'], go: { route: 'versions' } },
  { id: 'slow', cats: ['game'], strong: ['fps', 'lag', 'lento', 'traba', 'trabado', 'slow', 'stutter', 'stuttering', 'rendimiento', 'performance'], words: ['juego', 'mods', 'shaders', 'memoria', 'ram'], go: { route: 'performance' } },
  { id: 'update', cats: ['bug'], strong: ['actualizacion', 'actualizar', 'update', 'updating', 'instalador'], words: ['launcher', 'version', 'falla', 'error', 'descarga', 'download'], go: { route: 'updates' } },
  { id: 'skin', cats: ['bug', 'other'], strong: ['skin', 'capa', 'cape'], words: ['aparece', 'muestra', 'cambia', 'subir', 'show', 'upload', 'mojang', 'microsoft'], go: { route: 'skins' } },
  { id: 'voice', cats: ['bug', 'other'], strong: ['voz', 'microfono', 'mic', 'voice', 'audio'], words: ['sala', 'escucho', 'oigo', 'hablar', 'speak', 'hear', 'discord'], go: { route: 'voice' } },
];

// Minúsculas, sin tildes y en palabras de 3 letras o más.
export function tokens(text) {
  return [...new Set(String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 3))];
}
const hit = (token, word) => token === word || (token.length >= 5 && word.length >= 5 && (token.startsWith(word) || word.startsWith(token)));

// -> [{ id, score }] de mayor a menor. Una palabra fuerte alcanza (3 puntos); las otras suman 1; el tema acertado suma 1.
export function matchFaq(text, category, limit = 3) {
  const toks = tokens(text);
  if (!toks.length) return [];
  return FAQ.map((entry) => {
    let score = 0;
    for (const t of toks) {
      if (entry.strong.some((w) => hit(t, w))) score += 3;
      else if (entry.words.some((w) => hit(t, w))) score += 1;
    }
    // El tema acertado solo desempata: no alcanza para mostrar una sugerencia con palabras sueltas.
    if (score >= 3 && entry.cats.includes(category)) score += 1;
    return { id: entry.id, score };
  }).filter((x) => x.score >= 3).sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------- Mis consultas ----------
export const isPending = (t) => ['open', 'in_progress'].includes(t?.status);
export const isClosed = (t) => ['closed', 'paid'].includes(t?.status);
export const MY_FILTERS = ['all', 'open', 'closed', 'unread'];

export function filterMine(list, filter = 'all') {
  const items = Array.isArray(list) ? list : [];
  if (filter === 'open') return items.filter(isPending);
  if (filter === 'closed') return items.filter(isClosed);
  if (filter === 'unread') return items.filter((t) => t.unread);
  return items;
}
export function mineCounts(list) {
  const items = Array.isArray(list) ? list : [];
  return { all: items.length, open: items.filter(isPending).length, closed: items.filter(isClosed).length, unread: items.filter((t) => t.unread).length };
}
// Se puede reabrir una consulta cerrada hasta 14 días después y hasta 3 veces (el servidor lo vuelve a comprobar).
export function canReopen(ticket, now = Date.now()) {
  if (!ticket || ticket.status !== 'closed') return false;
  if ((ticket.reopenCount || 0) >= LIMITS.reopenTimes) return false;
  const until = ticket.reopenUntil ? Date.parse(ticket.reopenUntil) : NaN;
  return Number.isFinite(until) ? until > now : false;
}
export const canRate = (ticket) => ticket?.status === 'closed';
export function normalizeRating(n) {
  const v = Number(n);
  return Number.isInteger(v) && v >= 1 && v <= 5 ? v : 0;
}

// El mensaje de cierre viejo trae "Consulta cerrada." en español: se saca para mostrar la etiqueta en el idioma de cada persona.
export function systemKind(message) {
  return ['closed', 'closed_self', 'reopened'].includes(message?.code) ? message.code : null;
}
export function messageText(message) {
  const body = String(message?.body ?? '');
  if (message?.code === 'closed' || message?.code === 'closed_self') return body.replace(/^Consulta cerrada\.\s*/, '');
  if (message?.code === 'reopened' && body === 'Consulta reabierta.') return '';
  return body;
}

// ---------- Cola del equipo ----------
export const QUEUE_STATUS = ['pending', 'waiting', 'progress', 'closed', 'all'];
export const QUEUE_ASSIGNED = ['any', 'me', 'none'];
export const QUEUE_SORT = ['priority', 'newest', 'oldest'];
export const DEFAULT_QUEUE = Object.freeze({ status: 'pending', category: '', priority: '', assigned: 'any', sort: 'priority', search: '' });

// Filtros de pantalla -> pedido al servidor (solo valores conocidos y sin lo que está en su valor por omisión).
export function buildQueueFilter(ui = {}, page = 0) {
  const out = {};
  if (QUEUE_STATUS.includes(ui.status)) out.status = ui.status;
  if (ALL_CATEGORIES.includes(ui.category)) out.category = ui.category;
  if (PRIORITIES.includes(ui.priority)) out.priority = ui.priority;
  if (QUEUE_ASSIGNED.includes(ui.assigned) && ui.assigned !== 'any') out.assigned = ui.assigned;
  if (QUEUE_SORT.includes(ui.sort)) out.sort = ui.sort;
  const search = String(ui.search ?? '').trim().slice(0, LIMITS.search);
  if (search) out.search = search;
  if (page > 0) out.page = page;
  return out;
}
// Cuántos filtros se apartan de los de siempre (para el contador del botón "Filtros" y para "Limpiar").
export function activeFilterCount(ui = {}) {
  let n = 0;
  if ((ui.status || 'pending') !== DEFAULT_QUEUE.status) n++;
  if (ui.category) n++;
  if (ui.priority) n++;
  if (ui.assigned && ui.assigned !== 'any') n++;
  if ((ui.sort || 'priority') !== DEFAULT_QUEUE.sort) n++;
  if (String(ui.search ?? '').trim()) n++;
  return n;
}
// Cuánto hace que espera la persona (para teñir la antigüedad en la cola).
export function waitLevel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'ok';
  return ms >= 72 * 3600000 ? 'bad' : ms >= 24 * 3600000 ? 'warn' : 'ok';
}
export function waitingSince(ticket, now = Date.now()) {
  if (!ticket?.waiting) return null;
  const at = Date.parse(ticket.lastUserMessageAt || ticket.createdAt);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

// Respuesta guardada con {name} (la persona que escribió).
export function fillMacro(body, vars = {}) {
  return String(body ?? '').replace(/\{(\w+)\}/g, (m, key) => (vars[key] ? String(vars[key]) : key === 'name' ? '' : m)).replace(/ {2,}/g, ' ').replace(/ ([,.;:!?])/g, '$1');
}

// ---------- Capturas ----------
export function validateAttachment({ type, size, name } = {}, current = 0) {
  if (current >= ATTACH.perSend) return 'tooMany';
  if (!ATTACH.mime.includes(type)) return 'type';
  if (!Number.isFinite(size) || size <= 0) return 'empty';
  if (size > ATTACH.maxBytes * 4) return 'big'; // antes de achicarla; después tiene que entrar en 4 MB
  if (typeof name === 'string' && name.length > 400) return 'name';
  return null;
}
// Tamaño al achicar para que el lado mayor no pase de max (nunca agranda).
export function fitSize(width, height, max = ATTACH.maxSide) {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const k = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

// ---------- Errores ----------
const ERROR_CODES = new Set(['noSession', 'noCloud', 'network', 'unavailable', 'forbidden', 'notFound', 'conflict', 'server', 'badRequest', 'bad_input', 'bad_details',
  'bad_diagnostic', 'too_many_open', 'daily_limit', 'rate_minute', 'daily_messages', 'ticket_full', 'closed', 'not_available', 'not_staff', 'banned', 'not_closed',
  'reopen_expired', 'reopen_limit', 'attach_limit', 'attach_ticket_full', 'attach_daily', 'attach_bad', 'attach_missing', 'attach_big', 'attach_denied', 'payments_moved', 'macro_limit']);
// Clave del diccionario (sin el prefijo support.) para un error del proceso principal.
export function errorKey(err) {
  const code = err?.code;
  return ERROR_CODES.has(code) ? `err_${code}` : 'err_server';
}
