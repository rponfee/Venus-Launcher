// Comunidades: lógica pura compartida, sin DOM (docs/wip/comunidades-46.md). La validación es para avisar antes de mandar: el que
// decide siempre es el servidor (supabase/migrations/0033_clanes_comunidades.sql y 0038_comunidades.sql).
export const COMMUNITY_LIMITS = { nameMin: 3, nameMax: 40, description: 500, members: 500, channels: 50, owned: 3, channelName: 30, message: 2000, caption: 500 };
export const REPORT_REASONS = ['spam', 'abuse', 'nsfw', 'other'];

const DEFAULT_COLOR = '#f6b45a';
const BAD_LINE = /[\u0000-\u001f\u007f<>­​-‏‪-‮⁠-⁯﻿]/;
const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;
const FOLD_FROM = 'áàäâãéèëêíìïîóòöôõúùüûñçаеорсуіхѕ013457@$';
const FOLD_TO = 'aaaaaeeeeiiiiooooouuuuncaeopcyixsoieastas';
const WORDS = /(^|[^a-z0-9])(admin|administrador|administrator|venus|staff|mod|mods|moderador|moderadora|moderator|moderacion|oficial|official|soporte|support|owner|dueno)($|[^a-z0-9])/;
const STARTS = /^(admin|venus|staff|oficial|official|moderador|moderator|moderacion|soporte|support)/;
const ENDS = /(admin|venus|staff|oficial|official)$/;
const EXACT = new Set(['mod', 'mods', 'ofi', 'ofic', 'owner', 'dueno']);

function fold(text) {
  let out = '';
  for (const ch of String(text ?? '').toLowerCase()) {
    const i = FOLD_FROM.indexOf(ch);
    out += i >= 0 ? FOLD_TO[i] : ch;
  }
  return out;
}

/** Misma regla que private.group_reserved: si cambia acá, cambia allá. */
export function isReserved(text) {
  const s = fold(text);
  const joined = s.replace(/[^a-z0-9]+/g, '');
  return WORDS.test(s) || STARTS.test(joined) || ENDS.test(joined) || EXACT.has(joined);
}

/** Texto de una línea sin caracteres peligrosos ni espacios de más; null si no sirve. */
export function cleanLine(text) {
  const s = String(text ?? '');
  return BAD_LINE.test(s) ? null : s.trim().replace(/\s+/g, ' ');
}

/** Texto de varias líneas recortado; null si tiene controles o marcas que invierten el texto. */
export function cleanText(text) {
  const s = String(text ?? '');
  return BAD_TEXT.test(s) ? null : s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
}

const fail = (error) => ({ ok: false, error, value: null });
const pass = (value) => ({ ok: true, error: null, value });

export function validateCommunityName(name) {
  const value = cleanLine(name);
  if (value === null || [...value].length < COMMUNITY_LIMITS.nameMin || [...value].length > COMMUNITY_LIMITS.nameMax) return fail('bad_name');
  return isReserved(value) ? fail('reserved_name') : pass(value);
}

export function validateDescription(text, max) {
  const value = cleanText(text);
  return value === null || [...value].length > max ? fail('bad_description') : pass(value);
}

export function validateChannelName(name) {
  const value = cleanLine(name);
  return value === null || !value || [...value].length > COMMUNITY_LIMITS.channelName ? fail('bad_channel_name') : pass(value);
}

export function validateMessage(text) {
  const value = cleanText(text);
  return value === null || !value || [...value].length > COMMUNITY_LIMITS.message ? fail('bad_body') : pass(value);
}

/** Código de invitación ('COM-ABC234', 'abc234' con espacios o guiones) en su forma final; null si no puede serlo. */
export function normalizeCode(text, prefix) {
  const raw = String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith(prefix) && raw.length === prefix.length + 6 ? raw.slice(prefix.length) : raw;
  return /^[A-Z0-9]{6}$/.test(body) ? `${prefix}-${body}` : null;
}

export const isColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value ?? ''));

/** El color viene de otras cuentas: si no es #RRGGBB se usa el de siempre. */
export const safeColor = (value) => (isColor(value) ? String(value).toLowerCase() : DEFAULT_COLOR);

// ---------- Errores ----------
const UNAVAILABLE = new Set(['PGRST202', 'PGRST205', 'PGRST204', '42883', '42P01', '42703']);

/** Código estable de un error de la API: el texto de la excepción de 0033/0038 o una clase de falla. */
export function classifyGroupError(err) {
  if (!err) return 'server';
  const code = typeof err.code === 'string' ? err.code : '';
  const msg = String(err.message ?? err ?? '').trim();
  if (UNAVAILABLE.has(code) || err.status === 404) return 'unavailable';
  if (code === 'PGRST301' || code === 'PGRST302' || err.status === 401 || /\bJWT\b/i.test(msg)) return 'noSession';
  const head = /^([a-z][a-z_]*)(?::.*)?$/.exec(msg)?.[1];
  if (head === 'not_authenticated') return 'noSession';
  if (head) return head;
  if (err.name === 'AbortError' || /failed to fetch|network|fetch failed|load failed|timed? ?out|ECONN|ENOTFOUND/i.test(msg)) return 'network';
  return 'server';
}
