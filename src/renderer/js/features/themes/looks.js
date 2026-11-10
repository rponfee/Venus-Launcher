// Looks guardados (Ajustes → Apariencia → Mis looks): lógica pura, sin DOM ni Electron, con pruebas en
// test/looks.test.js. Un look es { id, name, appearance, branding, createdAt } con la apariencia completa
// (colores, fondo, interfaz, música, botón Jugar...) y la marca (nombre, logo, servidor). Se guardan en
// settings.looks (hasta MAX_LOOKS). El código para compartir es "VENUS-LOOK:" + base64 del JSON, sin rutas
// de la PC (la imagen propia pasa a estrellas y la música se apaga) y con el logo limitado a LOGO_MAX.
import { APPEARANCE_DEFAULTS, normalizeAppearance, normalizeBranding } from '../../a11y/appearance-logic.js';

export const PREFIX = 'VENUS-LOOK:';
export const MAX_LOOKS = 20;
export const NAME_MAX = 40;
export const LOGO_MAX = 200 * 1024; // bytes del data: del logo
export const MAX_CODE = 400000; // un código más largo que esto no es un look
// Lo que no viaja con un look: el modo liviano es del equipo, la copia de la temporada es interna y la página de
// inicio y los extras de la barra de título (6.1) son costumbres, no parte del aspecto. El estilo de la interfaz
// (letra, tamaño del texto, tarjetas, esquinas, densidad y menú lateral) sí viaja; un look o código anterior a la 6.1
// no los trae y quedan los de fábrica.
export const SKIP_KEYS = ['lite', 'liteOverlay', 'seasonalBackup', 'startPage', 'titlebar'];

export function newLookId() {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `look-${Date.now().toString(36)}${rnd}`;
}

export function cleanLookName(name) {
  const v = String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
  return v ? v.slice(0, NAME_MAX) : null;
}

// Solo las claves conocidas de la apariencia, normalizadas, sin las que no viajan
export function pickAppearance(raw) {
  const full = normalizeAppearance(raw);
  const out = {};
  for (const k of Object.keys(APPEARANCE_DEFAULTS)) if (!SKIP_KEYS.includes(k)) out[k] = full[k];
  return out;
}

export function pickBranding(raw) {
  const b = normalizeBranding(raw);
  if (b.logo.length > LOGO_MAX) {
    b.logo = '';
    b.logoName = '';
    b.logoPixel = false;
  }
  return b;
}

// Un look válido a partir de cualquier cosa (null si no tiene nombre)
export function normalizeLook(raw, { now = Date.now() } = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const name = cleanLookName(r.name);
  if (!name) return null;
  const createdAt = Number.isFinite(Number(r.createdAt)) && Number(r.createdAt) > 0 ? Number(r.createdAt) : now;
  return {
    id: typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(r.id) ? r.id : newLookId(),
    name,
    appearance: pickAppearance(r.appearance),
    branding: pickBranding(r.branding),
    createdAt,
  };
}

// La lista de settings.looks, limpia: looks válidos, ids únicos y como mucho MAX_LOOKS
export function normalizeLooks(list) {
  const out = [];
  const ids = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const look = normalizeLook(raw);
    if (!look || ids.has(look.id)) continue;
    ids.add(look.id);
    out.push(look);
    if (out.length >= MAX_LOOKS) break;
  }
  return out;
}

// Un look nuevo con lo que hay ahora en Apariencia
export function lookFromSettings({ appearance, branding }, name, { now = Date.now() } = {}) {
  return normalizeLook({ id: newLookId(), name, appearance, branding, createdAt: now }, { now });
}

// Lo que se comparte: sin rutas de la PC
export function shareableLook(look) {
  const l = normalizeLook(look);
  if (!l) return null;
  const ap = { ...l.appearance, bgFile: '', music: { ...l.appearance.music, enabled: false, file: '' } };
  if (ap.background === 'image') ap.background = 'stars';
  return { v: 1, name: l.name, appearance: ap, branding: { ...l.branding } };
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeLook(look) {
  const data = shareableLook(look);
  if (!data) throw Object.assign(new Error('bad_look'), { code: 'invalid' });
  return PREFIX + toBase64(JSON.stringify(data));
}

/**
 * Lee un código pegado. Acepta espacios y saltos de línea, el prefijo en mayúsculas o minúsculas y base64
 * estándar o para URL. Devuelve { ok: true, look } (sin id ni fecha definitivos: se asignan al guardar) o
 * { ok: false, code } con 'empty', 'notLook', 'damaged' o 'invalid'.
 */
export function decodeLook(text) {
  const raw = String(text ?? '').replace(/\s+/g, '');
  if (!raw) return { ok: false, code: 'empty' };
  if (raw.length > MAX_CODE || raw.slice(0, PREFIX.length).toUpperCase() !== PREFIX) return { ok: false, code: 'notLook' };
  let b64 = raw.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  if (!b64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { ok: false, code: 'damaged' };
  b64 = b64.replace(/=+$/, '');
  if (b64.length % 4 === 1) return { ok: false, code: 'damaged' };
  b64 += '='.repeat((4 - (b64.length % 4)) % 4);
  let data;
  try {
    data = JSON.parse(fromBase64(b64));
  } catch {
    return { ok: false, code: 'damaged' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.appearance || typeof data.appearance !== 'object') return { ok: false, code: 'invalid' };
  const look = normalizeLook({ name: data.name, appearance: data.appearance, branding: data.branding });
  if (!look) return { ok: false, code: 'invalid' };
  // lo que llega de afuera nunca trae rutas, aunque alguien las haya puesto a mano en el código
  look.appearance.bgFile = '';
  look.appearance.music = { ...look.appearance.music, enabled: false, file: '' };
  if (look.appearance.background === 'image') look.appearance.background = 'stars';
  return { ok: true, look };
}
