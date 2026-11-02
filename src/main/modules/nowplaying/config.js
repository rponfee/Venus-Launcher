'use strict';
// Ajustes de Música (settings.nowplaying) y atajos globales: valores por defecto, normalización y qué atajos se
// pueden registrar. Sin Electron (la usan las pruebas).
//
// settings.nowplaying = { source: 'auto' | 'system' | '<id de app>', overlay: true,
//   shortcuts: { enabled: false, playPause, next, prev, volumeUp, volumeDown } }   (aceleradores de Electron; '' = sin atajo)
// La clave vieja `music` es de una versión anterior y no se usa.

const SHORTCUT_ACTIONS = ['playPause', 'next', 'prev', 'volumeUp', 'volumeDown'];
const DEFAULT_SHORTCUTS = {
  playPause: 'CommandOrControl+Alt+Space',
  next: 'CommandOrControl+Alt+Right',
  prev: 'CommandOrControl+Alt+Left',
  volumeUp: 'CommandOrControl+Alt+Up',
  volumeDown: 'CommandOrControl+Alt+Down',
};
const DEFAULTS = { source: 'auto', overlay: true, shortcuts: { enabled: false, ...DEFAULT_SHORTCUTS } };
// El atajo por defecto del Voice Chat (renderer/js/voice.js): nunca se le pisa, aunque todavía no esté guardado
const VOICE_DEFAULT_SHORTCUT = 'CommandOrControl+Shift+M';

const VOLUME_STEP = 0.05; // atajos y botones de volumen
const SEEK_STEP = 10000; // adelantar / retroceder (ms)

const MODIFIERS = {
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  control: 'CommandOrControl',
  ctrl: 'CommandOrControl',
  command: 'CommandOrControl',
  cmd: 'CommandOrControl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
};
const MOD_ORDER = ['CommandOrControl', 'Alt', 'AltGr', 'Shift', 'Super'];
const NAMED_KEYS = [
  'Plus', 'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'PrintScreen', 'Pause',
  'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9', 'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
];
const NAMED = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));
const PUNCTUATION = new Set(['-', '=', '[', ']', ';', "'", ',', '.', '/', '\\', '`']);

// Acelerador -> forma canónica ('CommandOrControl+Alt+P') o '' si no es válido. Exige un modificador, salvo F1-F24
// (si no, el atajo se "comería" esa tecla en todo el sistema).
function normalizeAccel(accel) {
  if (typeof accel !== 'string') return '';
  const raw = accel.trim();
  if (!raw || raw.length > 60) return '';
  const parts = raw.split('+').map((p) => p.trim());
  if (parts.some((p) => !p)) return '';
  const keyPart = parts.pop();
  const mods = new Set();
  for (const p of parts) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m || mods.has(m)) return '';
    mods.add(m);
  }
  let key = '';
  if (/^[a-z0-9]$/i.test(keyPart)) key = keyPart.toUpperCase();
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(keyPart)) key = keyPart.toUpperCase();
  else if (NAMED.has(keyPart.toLowerCase())) key = NAMED.get(keyPart.toLowerCase());
  else if (PUNCTUATION.has(keyPart)) key = keyPart;
  if (!key || MODIFIERS[keyPart.toLowerCase()]) return '';
  if (key === 'Enter') key = 'Return';
  if (key === 'Esc') key = 'Escape';
  if (!mods.size && !/^F\d+$/.test(key)) return '';
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const sc = r.shortcuts && typeof r.shortcuts === 'object' ? r.shortcuts : {};
  const source = typeof r.source === 'string' && r.source.trim() && r.source.length <= 260 ? r.source.trim() : DEFAULTS.source;
  const shortcuts = { enabled: sc.enabled === true };
  for (const action of SHORTCUT_ACTIONS) {
    // undefined = el de fábrica; '' = el usuario lo quitó
    if (sc[action] === undefined || sc[action] === null) shortcuts[action] = DEFAULT_SHORTCUTS[action];
    else shortcuts[action] = typeof sc[action] === 'string' ? sc[action].trim().slice(0, 60) : '';
  }
  return { source, overlay: r.overlay !== false, shortcuts };
}

// Qué atajos se intentan registrar: [{ action, accel, skip }] con skip = null (registrar), 'empty', 'invalid',
// 'reserved' (lo usa el Voice Chat u otra parte del launcher) o 'duplicate' (repetido: gana el primero).
function planShortcuts(shortcuts, { reserved = [] } = {}) {
  const sc = shortcuts && typeof shortcuts === 'object' ? shortcuts : {};
  const taken = new Set(reserved.map(normalizeAccel).filter(Boolean));
  const used = new Set();
  return SHORTCUT_ACTIONS.map((action) => {
    const value = typeof sc[action] === 'string' ? sc[action].trim() : '';
    if (!value) return { action, accel: '', skip: 'empty' };
    const accel = normalizeAccel(value);
    if (!accel) return { action, accel: value, skip: 'invalid' };
    if (taken.has(accel)) return { action, accel, skip: 'reserved' };
    if (used.has(accel)) return { action, accel, skip: 'duplicate' };
    used.add(accel);
    return { action, accel, skip: null };
  });
}

module.exports = { normalizeConfig, normalizeAccel, planShortcuts, DEFAULTS, DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, VOICE_DEFAULT_SHORTCUT, VOLUME_STEP, SEEK_STEP };
