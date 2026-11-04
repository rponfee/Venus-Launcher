// Clanes y comunidades: lógica pura compartida, sin DOM (docs/implementacion/clanes-comunidades.md). La validación es para avisar antes
// de mandar: el que decide siempre es el servidor (0033_clanes_comunidades.sql).
export const CLAN_LIMITS = { nameMin: 3, nameMax: 30, tagMin: 2, tagMax: 5, description: 300, members: 50 };
export const COMMUNITY_LIMITS = { nameMin: 3, nameMax: 40, description: 500, members: 500, channels: 20, owned: 3, channelName: 30, message: 2000 };
export const EMBLEMS = ['shield', 'swords', 'crown', 'flame', 'skull', 'star', 'pickaxe', 'mountain', 'moon', 'zap', 'heart', 'trophy'];
export const COLORS = ['#7c5cff', '#e5484d', '#f5a524', '#30a46c', '#0ea5e9', '#e93d82', '#94a3b8', '#14b8a6'];
export const REPORT_REASONS = ['spam', 'abuse', 'nsfw', 'other'];
export const INVITE_DAYS = 7;

const DEFAULT_COLOR = COLORS[0];
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

function validName(name, min, max) {
  const value = cleanLine(name);
  if (value === null || [...value].length < min || [...value].length > max) return fail('bad_name');
  return isReserved(value) ? fail('reserved_name') : pass(value);
}

export const validateClanName = (name) => validName(name, CLAN_LIMITS.nameMin, CLAN_LIMITS.nameMax);
export const validateCommunityName = (name) => validName(name, COMMUNITY_LIMITS.nameMin, COMMUNITY_LIMITS.nameMax);

export function validateTag(tag) {
  const value = String(tag ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,5}$/.test(value)) return fail('bad_tag');
  return isReserved(value) ? fail('reserved_tag') : pass(value);
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

export function validateClanForm({ name, tag, description, color, emblem } = {}) {
  for (const check of [validateClanName(name), validateTag(tag), validateDescription(description, CLAN_LIMITS.description)]) {
    if (!check.ok) return check;
  }
  if (!isColor(color)) return fail('bad_color');
  return EMBLEMS.includes(emblem) ? pass(null) : fail('bad_emblem');
}

/** Código de invitación ('CLAN-ABC234', 'abc234' con espacios o guiones) en su forma final; null si no puede serlo. */
export function normalizeCode(text, prefix) {
  const raw = String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith(prefix) && raw.length === prefix.length + 6 ? raw.slice(prefix.length) : raw;
  return /^[A-Z0-9]{6}$/.test(body) ? `${prefix}-${body}` : null;
}

export const isColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value ?? ''));

/** El color y el emblema vienen de otras cuentas: si no son de la lista fija se usa lo de siempre. */
export const safeColor = (value) => (isColor(value) ? String(value).toLowerCase() : DEFAULT_COLOR);
export const safeEmblem = (value) => (EMBLEMS.includes(value) ? value : EMBLEMS[0]);

/** Letra que se lee sobre ese color de fondo. */
export function readableInk(hex) {
  const c = safeColor(hex);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.179 ? '#000000' : '#ffffff';
}

// ---------- Roles de un clan ----------
const CLAN_ORDER = { leader: 0, officer: 1, member: 2 };
export const isClanStaff = (role) => role === 'leader' || role === 'officer';
export const canKickFromClan = (actor, target) => (actor === 'leader' && target !== 'leader' && !!target) || (actor === 'officer' && target === 'member');
export const canSetClanRole = (actor, target) => actor === 'leader' && (target === 'officer' || target === 'member');
export const canTransferClan = (actor, target) => actor === 'leader' && target !== 'leader' && !!target;

export function sortClanMembers(members) {
  return [...(Array.isArray(members) ? members : [])].filter(Boolean).sort((a, b) => (CLAN_ORDER[a.role] ?? 9) - (CLAN_ORDER[b.role] ?? 9) || String(a.joinedAt ?? '').localeCompare(String(b.joinedAt ?? '')));
}

// ---------- Ranking y logros ----------
/** Minutos a horas con un decimal (sin ",0" de más al mostrarlo se encarga fmtHours). */
export const minutesToHours = (minutes) => Math.round((Math.max(0, Number(minutes) || 0) / 60) * 10) / 10;

export function achievementView(a) {
  const goal = Math.max(1, Number(a?.goal) || 1);
  const value = Math.max(0, Number(a?.value) || 0);
  const hours = a?.kind === 'minutes';
  return {
    id: String(a?.id ?? ''),
    kind: a?.kind,
    unlocked: a?.unlocked === true,
    pct: Math.min(100, Math.floor((value / goal) * 100)),
    value: hours ? Math.floor(value / 60) : value,
    goal: hours ? goal / 60 : goal,
  };
}

/** Hacen falta 2 miembros compartiendo: con uno solo el servidor da cero para no dejar ver las horas de una sola persona. */
export const MIN_SHARING = 2;

/** Por qué el ranking está en cero, para explicarlo: 'unavailable' (sin datos de Competir), 'nobody' (ningún clan llega a 2 compartiendo) o null. */
export function rankingNotice(view) {
  if (!view || view.available === false) return 'unavailable';
  const rows = Array.isArray(view.rows) ? view.rows : [];
  return rows.some((r) => Number(r.sharing) >= MIN_SHARING) ? null : 'nobody';
}

// ---------- Errores ----------
const UNAVAILABLE = new Set(['PGRST202', 'PGRST205', 'PGRST204', '42883', '42P01', '42703']);

/** Código estable de un error de la API: el texto de la excepción de 0033 o una clase de falla. */
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

// ---------- Semanas (de lunes a domingo, UTC, como la 0031) ----------
export function weekOf(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

export function shiftWeek(key, weeks) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + weeks * 7 * 86400000).toISOString().slice(0, 10);
}
