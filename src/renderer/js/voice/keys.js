// Teclas del Voice Chat: tecla de "pulsar para hablar" (codigo de KeyboardEvent o boton del mouse) y
// atajo global para silenciar (acelerador de Electron, funciona tambien con el juego en primer plano).
import { t } from '../i18n.js';

const NAMED = {
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  ScrollLock: 'Scrolllock',
  Pause: 'Pause',
  PrintScreen: 'PrintScreen',
};

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']);

export function isModifierCode(code) {
  return MODIFIER_CODES.has(code);
}

// KeyboardEvent.code -> tecla de acelerador de Electron (null si no se puede usar)
function accelKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  return NAMED[code] || null;
}

// Arma el acelerador a partir de una pulsacion. { accel } o { error: 'needsModifier' } o null (solo modificadores)
export function acceleratorFromEvent(e) {
  if (isModifierCode(e.code)) return null;
  const key = accelKey(e.code);
  if (!key) return { error: 'unsupported' };
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  // Sin modificador solo se aceptan F1-F24 (si no, el atajo se "comeria" esa tecla en todo el sistema)
  if (!mods.length && !/^F\d+$/.test(key)) return { error: 'needsModifier' };
  return { accel: [...mods, key].join('+') };
}

const MOD_LABEL = { CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Control: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Win', Meta: 'Win' };

// 'CommandOrControl+Shift+M' -> ['Ctrl', 'Shift', 'M']
export function acceleratorParts(accel) {
  if (!accel) return [];
  return String(accel)
    .split('+')
    .filter(Boolean)
    .map((p) => MOD_LABEL[p] || (p === 'Space' ? t('voice.keySpace') : p.replace(/^num/, 'Num ')));
}

// Etiqueta de la tecla de pulsar para hablar
export function keyLabel(code) {
  if (!code) return t('voice.keyNone');
  const mouse = /^Mouse(\d)$/.exec(code);
  if (mouse) return t('voice.keyMouse', { n: Number(mouse[1]) + 1 });
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`;
  const named = {
    Space: t('voice.keySpace'),
    CapsLock: t('voice.keyCapsLock'),
    Tab: 'Tab',
    ControlLeft: t('voice.keyCtrlLeft'),
    ControlRight: t('voice.keyCtrlRight'),
    ShiftLeft: t('voice.keyShiftLeft'),
    ShiftRight: t('voice.keyShiftRight'),
    AltLeft: 'Alt',
    AltRight: 'Alt Gr',
    Backquote: '`',
    Backslash: '\\',
    IntlBackslash: '<',
  };
  return named[code] || code;
}

// La tecla se escribe en un campo de texto (para no activar pulsar para hablar mientras se chatea)
export function isTypingTarget(el) {
  if (!el || !(el instanceof Element)) return false;
  return Boolean(el.closest('input, textarea, select, [contenteditable="true"]'));
}
