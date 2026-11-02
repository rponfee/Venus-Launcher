'use strict';
// Logica de capturas sin Electron (se prueba con node:test): ajustes con sus valores por defecto, atajos, calidad
// y bitrate, nombres de archivo y carpetas, y que juego capturar cuando hay mas de uno abierto.
const path = require('path');

// Donde se guarda cada cosa, dentro de la carpeta de la instancia: asi las capturas quedan junto a las del juego
// (F2 de Minecraft) y los clips y grabaciones los ve tambien la pagina de Mundos (worlds/media.js ya lista
// screenshots/, clips/ y recordings/) y la linea de tiempo de cada mundo.
const KIND_DIR = { screenshot: 'screenshots', clip: 'clips', recording: 'recordings' };
const KIND_TAG = { screenshot: 'venus', clip: 'replay', recording: 'rec' };

const QUALITIES = ['720p', '1080p', 'native'];
const FPS = [30, 60];
const ACTIONS = ['replay', 'record', 'screenshot'];
const REPLAY_SECONDS = 30;
const REPLAY_SECONDS_PREMIUM = 120;
const KEYFRAME_MS = 2000; // un cuadro clave cada 2 s: la repeticion y la grabacion arrancan en uno de ellos

const DEFAULTS = Object.freeze({
  replay: false, // la repeticion instantanea usa CPU y memoria: apagada hasta que el usuario la prende
  quality: '1080p',
  fps: 30,
  audio: true, // sonido del equipo (en Windows es todo el audio de la PC, no solo el del juego)
  notify: true,
  copyTo: '', // carpeta extra donde dejar una copia de lo guardado ('' = ninguna)
  shortcuts: Object.freeze({ replay: 'Alt+Shift+F8', record: 'Alt+Shift+F9', screenshot: 'Alt+Shift+F12' }), // Alt+F9/F10 los usa NVIDIA
});

// ---------- Atajos (formato de acelerador de Electron) ----------

const MODIFIERS = new Map([
  ['ctrl', 'Ctrl'],
  ['control', 'Ctrl'],
  ['cmdorctrl', 'CmdOrCtrl'],
  ['commandorcontrol', 'CmdOrCtrl'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['altgr', 'AltGr'],
  ['shift', 'Shift'],
  ['super', 'Super'],
  ['meta', 'Super'],
  ['win', 'Super'],
]);
const MOD_ORDER = ['CmdOrCtrl', 'Ctrl', 'Alt', 'AltGr', 'Shift', 'Super'];
const NAMED_KEYS = new Map(
  ['Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'PrintScreen', 'Plus', 'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9', 'numadd', 'numsub', 'nummult', 'numdiv', 'numdec'].map((k) => [k.toLowerCase(), k]),
);
NAMED_KEYS.set('return', 'Enter');
const PUNCT = new Set([')', '!', '@', '#', '$', '%', '^', '&', '*', '(', ':', ';', '<', '=', '>', '?', '_', '-', ',', '.', '/', '`', '~', '[', '{', ']', '}', '\\', '|', "'", '"']);

/**
 * Acelerador valido y normalizado ("alt+shift+f10" -> "Alt+Shift+F10") o null. Tiene que llevar al menos un
 * modificador, salvo F13 a F24 (sin modificador, una tecla comun dejaria de llegarle al juego).
 */
function normalizeAccelerator(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 60) return null;
  const parts = s === '+' ? ['+'] : s.split('+').map((p) => p.trim());
  // "Ctrl++" deja una parte vacia al final: la tecla es "Plus"
  if (parts.length > 1 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') parts.splice(-2, 2, 'Plus');
  if (parts.some((p) => !p)) return null;
  const mods = new Set();
  let key = null;
  for (const p of parts) {
    const low = p.toLowerCase();
    if (MODIFIERS.has(low)) {
      mods.add(MODIFIERS.get(low));
      continue;
    }
    if (key) return null; // dos teclas comunes
    if (/^f([1-9]|1\d|2[0-4])$/i.test(p)) key = p.toUpperCase();
    else if (/^[a-z0-9]$/i.test(p)) key = p.toUpperCase();
    else if (NAMED_KEYS.has(low)) key = NAMED_KEYS.get(low);
    else if (p.length === 1 && PUNCT.has(p)) key = p;
    else return null;
  }
  if (!key) return null;
  if (!mods.size && !/^F(1[3-9]|2[0-4])$/.test(key)) return null;
  const ordered = MOD_ORDER.filter((m) => mods.has(m));
  return [...ordered, key].join('+');
}

// Atajos de los ajustes: los invalidos o repetidos quedan en '' (sin atajo)
function normalizeShortcuts(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  const seen = new Set();
  for (const a of ACTIONS) {
    const value = Object.prototype.hasOwnProperty.call(src, a) ? src[a] : DEFAULTS.shortcuts[a];
    const acc = value === '' || value === null ? '' : normalizeAccelerator(value) || '';
    const key = acc.toLowerCase();
    if (acc && seen.has(key)) out[a] = '';
    else {
      out[a] = acc;
      if (acc) seen.add(key);
    }
  }
  return out;
}

// ---------- Ajustes ----------

function cleanFolder(p) {
  if (typeof p !== 'string') return '';
  const s = p.trim();
  if (!s || s.length > 400 || !path.isAbsolute(s) || /[\0]/.test(s)) return '';
  return path.normalize(s);
}

// settings.capture completo con sus valores por defecto
function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    replay: s.replay === true,
    quality: QUALITIES.includes(s.quality) ? s.quality : DEFAULTS.quality,
    fps: FPS.includes(Number(s.fps)) ? Number(s.fps) : DEFAULTS.fps,
    audio: s.audio === undefined ? DEFAULTS.audio : s.audio === true,
    notify: s.notify !== false,
    copyTo: cleanFolder(s.copyTo),
    shortcuts: normalizeShortcuts(s.shortcuts),
  };
}

// Largo de la repeticion instantanea: 30 s, o 120 s con Venus Premium
function replaySeconds(premium) {
  return premium ? REPLAY_SECONDS_PREMIUM : REPLAY_SECONDS;
}

// ---------- Calidad ----------

// Tope de tamanio de la captura (se achica manteniendo la proporcion). null = nativa (con tope en 4K)
function qualityBox(quality) {
  if (quality === '720p') return { width: 1280, height: 720 };
  if (quality === '1080p') return { width: 1920, height: 1080 };
  return { width: 3840, height: 2160 };
}

// Tamanio final de un video de w x h dentro de la caja de la calidad (sin agrandar; lados pares para el codec)
function fitSize(w, h, quality) {
  const box = qualityBox(quality);
  const W = Math.max(2, Math.round(Number(w) || 0));
  const H = Math.max(2, Math.round(Number(h) || 0));
  const k = Math.min(1, box.width / W, box.height / H);
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  return { width: even(W * k), height: even(H * k) };
}

const BPP = 0.11; // bits por pixel por cuadro a 30 fps (VP9/VP8 en tiempo real, contenido de juego)
const MIN_BPS = 2_000_000;
const MAX_BPS = 25_000_000;

// Bitrate de video para ese tamanio y esos cuadros por segundo (60 fps no cuesta el doble: ~1,5 veces)
function bitrateFor(width, height, fps) {
  const pixels = Math.max(1, Number(width) || 0) * Math.max(1, Number(height) || 0);
  const rate = Number(fps) >= 60 ? 30 * 1.5 : 30;
  return Math.round(Math.min(MAX_BPS, Math.max(MIN_BPS, pixels * rate * BPP)));
}

// Memoria aproximada de la repeticion (para mostrarla en Ajustes): bytes
function replayMemory(seconds, quality, fps) {
  const box = qualityBox(quality === 'native' ? '1080p' : quality);
  const factor = quality === 'native' ? 1.8 : 1;
  return Math.round((seconds * (bitrateFor(box.width, box.height, fps) * factor + 128000)) / 8);
}

// ---------- Archivos ----------

const pad = (n) => String(n).padStart(2, '0');

// Fecha local en el formato de Minecraft ("2026-11-01_18.03.11"), que tambien entiende worlds/media.js
function stamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

function fileName(kind, date = new Date()) {
  if (!KIND_DIR[kind]) throw new Error(`kind ${kind}`);
  return `${stamp(date)}_${KIND_TAG[kind]}.${kind === 'screenshot' ? 'png' : 'webm'}`;
}

function folderFor(instanceDir, kind) {
  if (!KIND_DIR[kind]) throw new Error(`kind ${kind}`);
  return path.join(instanceDir, KIND_DIR[kind]);
}

// "x.webm" -> "x-2.webm", "x-3.webm"... hasta que exists(nombre) sea false
async function uniqueName(dir, name, exists) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; await exists(path.join(dir, candidate)); i++) {
    if (i > 999) throw new Error('too many');
    candidate = `${base}-${i}${ext}`;
  }
  return candidate;
}

// Nombre del clip que exporta el editor: "<original>_vertical.webm" o "<original>_edit.webm"
function exportName(sourceFile, mode) {
  const base = path.basename(String(sourceFile || 'clip')).replace(/\.[^.]+$/, '').replace(/_(vertical|edit)(-\d+)?$/, '');
  const clean = base.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 80) || 'clip';
  return `${clean}_${mode === 'vertical' ? 'vertical' : 'edit'}.webm`;
}

// Ruta absoluta de una captura dentro de <instancias>/<id>/screenshots/ (png, jpg o webp) o null
function screenshotPath(p, instancesRoot) {
  if (typeof p !== 'string' || !p || !path.isAbsolute(p) || /\0/.test(p)) return null;
  const full = path.resolve(p);
  const base = path.resolve(instancesRoot);
  if (!full.startsWith(base + path.sep)) return null;
  const rel = full.slice(base.length + 1).split(path.sep);
  if (rel.length !== 3 || rel[1] !== 'screenshots' || !/^[\w.-]+$/.test(rel[0]) || !/\.(png|jpe?g|webp)$/i.test(rel[2])) return null;
  return full;
}

// ---------- Juego ----------

/**
 * Juego a capturar: el abierto mas reciente que no sea una partida de prueba. status = game.status()
 * ({ id: { state, pid, startedAt, quiet? } }). Devuelve { instanceId, pid, startedAt } o null.
 */
function pickGame(status) {
  let best = null;
  for (const [id, g] of Object.entries(status || {})) {
    if (!g || g.quiet || g.state !== 'running' || !Number.isInteger(g.pid)) continue;
    if (!best || (g.startedAt || 0) > best.startedAt) best = { instanceId: id, pid: g.pid, startedAt: g.startedAt || 0 };
  }
  return best;
}

module.exports = {
  KIND_DIR,
  QUALITIES,
  FPS,
  ACTIONS,
  DEFAULTS,
  KEYFRAME_MS,
  REPLAY_SECONDS,
  REPLAY_SECONDS_PREMIUM,
  BPP,
  MIN_BPS,
  MAX_BPS,
  normalizeAccelerator,
  normalizeShortcuts,
  normalizeSettings,
  cleanFolder,
  replaySeconds,
  qualityBox,
  fitSize,
  bitrateFor,
  replayMemory,
  stamp,
  fileName,
  folderFor,
  uniqueName,
  exportName,
  screenshotPath,
  pickGame,
};
