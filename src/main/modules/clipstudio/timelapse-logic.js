'use strict';
// Timelapse de tu mundo, sin Electron (se prueba con node:test): ajustes de cada instancia, en que carpeta van las
// imagenes, cuando sacar la proxima y el tope de espacio.
const CONFIG_FILE = 'timelapse.json'; // en .venus/ de la instancia: no se exporta ni se comparte
const ROOT_DIR = 'timelapse';
const EVERY = [5, 10, 15, 30, 60, 120]; // segundos entre imagenes
const CAPS_MB = [256, 512, 1024, 2048, 5120];
const DEFAULTS = Object.freeze({ enabled: false, every: 30, capMb: 1024 });
const FRAME_ESTIMATE = 512 * 1024; // lo que se reserva para la proxima imagen (JPEG de 1080p: suele ocupar menos)
const DISK_MARGIN = 1024 * 1024 * 1024; // el juego tambien necesita lugar para guardar el mundo
const FRAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}\.\d{2}\.\d{2}(-\d+)?\.(jpg|png)$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

// Apagado por defecto. Un valor que no esta en la lista vuelve al de siempre.
function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: c.enabled === true,
    every: EVERY.includes(Number(c.every)) ? Number(c.every) : DEFAULTS.every,
    capMb: CAPS_MB.includes(Number(c.capMb)) ? Number(c.capMb) : DEFAULTS.capMb,
  };
}

// Un solo segmento de ruta seguro a partir del nombre de un mundo o de un servidor
function safeFolder(name) {
  const s = String(name ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 80);
  if (!s) return '';
  return RESERVED.test(s) ? `_${s}` : s;
}

// Lo que llega del renderer como nombre de carpeta: tiene que ser ya seguro y de un solo segmento
function validFolder(name) {
  return typeof name === 'string' && name.length > 0 && safeFolder(name) === name;
}

// Carpeta de lo que se esta jugando o null (en el menu no se saca nada; un mundo que todavia no se sabe, tampoco)
function folderForActivity(act) {
  if (!act || act.quiet) return null;
  if (act.type === 'singleplayer') return act.world ? safeFolder(act.world) || null : null;
  if (act.type === 'server') return act.address ? safeFolder(`server_${act.address}`) || null : null;
  return null;
}

/**
 * Que hacer ahora. s = { now, lastAt, everyMs, used, capBytes, free (null = no se sabe), folder, busy, focused? }
 * Devuelve { action: 'wait' | 'capture' | 'full' | 'noDisk', delay? }: wait = todavia no (o no se puede), full y noDisk
 * paran hasta el proximo juego.
 */
function decide(s) {
  if (s.busy || !s.folder) return { action: 'wait' };
  const since = s.now - (s.lastAt || 0);
  if (since < s.everyMs) return { action: 'wait', delay: s.everyMs - since };
  if (s.used + FRAME_ESTIMATE > s.capBytes) return { action: 'full' };
  if (s.free !== null && s.free !== undefined && s.free < FRAME_ESTIMATE + DISK_MARGIN) return { action: 'noDisk' };
  return { action: 'capture' };
}

// Un cuadro negro (ventana minimizada o todavia sin dibujar) pesa casi nada: no sirve para el video
function isBlankFrame(bytes, width, height) {
  const pixels = Math.max(1, Number(width) || 0) * Math.max(1, Number(height) || 0);
  return (Number(bytes) || 0) / pixels < 0.008;
}

const isFrameFile = (name) => FRAME_RE.test(String(name));

// Resumen de una carpeta a partir de sus archivos: [{ name, size }]
function summarize(folder, files) {
  const frames = files.filter((f) => isFrameFile(f.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    folder,
    count: frames.length,
    bytes: frames.reduce((n, f) => n + (f.size || 0), 0),
    first: frames[0]?.name || null,
    last: frames.at(-1)?.name || null,
  };
}

module.exports = { CONFIG_FILE, ROOT_DIR, EVERY, CAPS_MB, DEFAULTS, FRAME_ESTIMATE, DISK_MARGIN, normalizeConfig, safeFolder, validFolder, folderForActivity, decide, isBlankFrame, isFrameFile, summarize };
