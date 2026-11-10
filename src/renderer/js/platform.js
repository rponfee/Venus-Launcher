// Detalles de la plataforma en la interfaz. En macOS Cmd hace lo mismo que Ctrl en los atajos del launcher (Ctrl+K,
// Ctrl+J, Ctrl+M...) y los atajos se muestran como en el resto de las apps de Mac ("⌘K"). Las funciones que no existen
// en una plataforma llegan en store.info.capabilities (core/platform.js en el proceso principal).
// Contrato: isMac(), modKey(e), keyLabel(texto), supports(funcion).

const CMD = String.fromCharCode(0x2318);
const SHIFT = String.fromCharCode(0x21e7);
const KEY_RE = /\bCtrl(\s?)\+\s?(?:(?:Shift|Mayús)\s?\+\s?)?(Enter\b|[A-Z0-9](?![\p{L}\p{N}]))/gu;

function detectMac() {
  try {
    const nav = globalThis.navigator;
    return /^Mac/i.test(String(nav?.platform || '')) || /Macintosh/.test(String(nav?.userAgent || ''));
  } catch {
    return false;
  }
}

let mac = detectMac();
let caps = null;

// app.js lo llama con store.info (app:info) apenas lo tiene: desde ahí manda lo que dice el proceso principal.
export function setInfo(info) {
  if (!info || typeof info !== 'object') return;
  if (typeof info.platform === 'string') mac = info.platform === 'darwin';
  if (info.capabilities && typeof info.capabilities === 'object') caps = info.capabilities;
}

export function isMac() {
  return mac;
}

// Las que dependen de una API de Windows (misma lista que WINDOWS_ONLY en core/platform.js). Se usa solo mientras
// no llegó app:info.
const WINDOWS_ONLY = ['overlay', 'nowplaying', 'gameWindowBranding', 'windowsIntegration', 'desktopShortcuts', 'capture', 'autoInstallUpdates', 'systemAudioShare'];

// La función existe en esta plataforma.
export function supports(feature) {
  if (caps) return caps[feature] !== false;
  return !mac || !WINDOWS_ONLY.includes(feature);
}

// Tecla de atajo apretada sola: Ctrl en Windows; Cmd o Ctrl (no las dos juntas) en macOS.
export function modKey(e, isMacOs = mac) {
  if (!e) return false;
  return isMacOs ? Boolean(e.metaKey) !== Boolean(e.ctrlKey) : Boolean(e.ctrlKey) && !e.metaKey;
}

// Nombre de una tecla suelta para un <kbd>: en macOS Ctrl -> ⌘ (Cmd), Shift -> ⇧, Alt -> ⌥.
export function keyName(k, isMacOs = mac) {
  if (!isMacOs) return k;
  return { Ctrl: CMD, Shift: SHIFT, Alt: String.fromCharCode(0x2325) }[k] || k;
}

// "Ctrl+K" -> "⌘K", "Ctrl+Shift+R" -> "⇧⌘R", "Ctrl + Enter" -> "⌘ + Enter" en macOS. "Ctrl izquierdo" o "Ctrl+Alt"
// (teclas físicas) quedan como están. Misma regla que keyLabel de core/platform.js.
export function keyLabel(text, isMacOs = mac) {
  if (!isMacOs || typeof text !== 'string' || !text.includes('Ctrl')) return text;
  return text.replace(KEY_RE, (m, space, key) => {
    const shift = /Shift|Mayús/.test(m) ? SHIFT : '';
    return space ? `${shift}${CMD} + ${key}` : `${shift}${CMD}${key}`;
  });
}
