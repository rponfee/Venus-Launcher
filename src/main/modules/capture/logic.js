'use strict';
// Logica de capturas sin Electron (se prueba con node:test): ajustes con sus valores por defecto (y la migracion
// de los viejos), atajos, calidad (resolucion, fps, bitrate y codec), espacio en disco, presets, que hacer si la PC
// no llega, nombres de archivo y carpetas, y que juego capturar cuando hay mas de uno abierto.
const path = require('path');

// Donde se guarda cada cosa, dentro de la carpeta de la instancia: asi las capturas quedan junto a las del juego
// (F2 de Minecraft) y los clips y grabaciones los ve tambien la pagina de Mundos (worlds/media.js ya lista
// screenshots/, clips/ y recordings/) y la linea de tiempo de cada mundo.
const KIND_DIR = { screenshot: 'screenshots', clip: 'clips', recording: 'recordings' };
const KIND_TAG = { screenshot: 'venus', clip: 'replay', recording: 'rec' };

// Resolucion: tope de la captura (nunca se agranda). 1440p y 2K son lo mismo (2560x1440): una sola opcion.
const QUALITIES = ['720p', '1080p', '1440p', '2160p', 'native'];
const QUALITY_ALIASES = { '720': '720p', '1080': '1080p', '1440': '1440p', '2k': '1440p', qhd: '1440p', '2160': '2160p', '4k': '2160p', uhd: '2160p' };
const BOXES = { '720p': { width: 1280, height: 720 }, '1080p': { width: 1920, height: 1080 }, '1440p': { width: 2560, height: 1440 }, '2160p': { width: 3840, height: 2160 } };
const NATIVE_MAX = BOXES['2160p']; // "nativa" = el tamanio de la ventana, con tope en 4K
const FPS = [30, 45, 60, 80, 120];
const LEVELS = ['low', 'medium', 'high']; // calidad de imagen (bitrate): Baja, Media, Alta
const REPLAY_LENGTHS = [30, 60, 120, 300, 600, 900, 1800]; // segundos de la repeticion instantanea (para todos)
const RECORD_LIMITS = [0, 15, 30, 60, 120, 240]; // minutos de una grabacion (0 = sin limite: hasta que el disco alcance)
const ACTIONS = ['replay', 'record', 'screenshot'];
const KEYFRAME_MS = 2000; // un cuadro clave cada 2 s: la repeticion y la grabacion arrancan en uno de ellos
const RING_SEGMENT_SECONDS = 10; // el buffer en disco rota de a estos segundos (y guarda hasta uno de mas)
const DISK_MARGIN = 1024 * 1024 * 1024; // sin este lugar libre ademas de lo que se va a escribir, no se graba
const AUDIO_BPS = 128000;

// Clips automaticos: motivos, de menor a mayor importancia (el mas importante manda si caen dos juntos)
const AUTO_REASONS = ['advancement', 'death', 'boss'];
const AUTO_SECONDS = [30, 60, 120, 300];
const AUTO_COOLDOWN = { min: 5, max: 600, fallback: 30 };
const AUTO_LIMIT = { min: 1, max: 200, fallback: 20 };

const DEFAULTS = Object.freeze({
  replay: false, // la repeticion instantanea usa CPU y disco: apagada hasta que el usuario la prende
  replaySeconds: 60,
  quality: '1080p',
  fps: 30,
  level: 'medium',
  recordLimit: 0,
  audio: true, // sonido del equipo (en Windows es todo el audio de la PC, no solo el del juego)
  notify: true,
  copyTo: '', // carpeta extra donde dejar una copia de lo guardado ('' = ninguna)
  shortcuts: Object.freeze({ replay: 'Alt+Shift+F8', record: 'Alt+Shift+F9', screenshot: 'Alt+Shift+F12' }), // Alt+F9/F10 los usa NVIDIA
  // Clips automaticos: apagados hasta que el usuario los prende. seconds = largo de cada clip (5 minutos de video
  // por cada muerte llenarian el disco); cooldown en segundos; maxPerSession por partida.
  auto: Object.freeze({ enabled: false, death: true, advancement: true, boss: true, cooldown: AUTO_COOLDOWN.fallback, maxPerSession: AUTO_LIMIT.fallback, seconds: 60 }),
});

// ---------- Plataforma ----------

/**
 * UNICO lugar que decide si la grabacion anda en esta plataforma. capture.js no registra nada si capture es false
 * (los canales responden 'unavailable' y Ajustes lo dice). Probado solo en Windows (Windows Graphics Capture y el
 * audio "loopback" del equipo). macOS: desktopCapturer necesita el permiso de Grabacion de pantalla y no hay audio
 * del equipo; el port lo prende aca cuando este probado. Linux: sin probar.
 */
function platformSupport(platform = process.platform) {
  if (platform === 'win32') return { capture: true, audio: true };
  return { capture: false, audio: false };
}

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

const intBetween = (v, { min, max, fallback }) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v !== null && v !== '' ? Math.min(max, Math.max(min, n)) : fallback;
};

// El valor de la lista mas cercano a v (los de antes o fuera de rango se corrigen solos); fallback si no es un numero
function nearest(list, v, fallback) {
  const n = Number(v);
  if (v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(n)) return fallback;
  let best = list[0];
  for (const x of list) if (Math.abs(x - n) < Math.abs(best - n)) best = x;
  return best;
}

// '4k' -> '2160p', '2K' -> '1440p'... (un valor desconocido queda en el de por defecto)
function normalizeQuality(q) {
  const s = String(q ?? '').trim().toLowerCase();
  if (QUALITIES.includes(s)) return s;
  return QUALITY_ALIASES[s] || DEFAULTS.quality;
}

// settings.capture.auto completo
function normalizeAuto(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: a.enabled === true,
    death: a.death !== false,
    advancement: a.advancement !== false,
    boss: a.boss !== false,
    cooldown: intBetween(a.cooldown, AUTO_COOLDOWN),
    maxPerSession: intBetween(a.maxPerSession, AUTO_LIMIT),
    seconds: AUTO_SECONDS.includes(Number(a.seconds)) ? Number(a.seconds) : DEFAULTS.auto.seconds,
  };
}

/**
 * settings.capture completo con sus valores por defecto. Lo guardado por versiones anteriores sigue valiendo:
 * quality '720p' | '1080p' | 'native' y fps 30 | 60 son valores de hoy; sin replaySeconds (antes eran 60 s fijos,
 * 5 minutos con Premium) queda en 60; un numero que no esta en la lista va al mas cercano (fps 50 -> 45, 240 -> 120).
 */
function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const limit = Number(s.recordLimit);
  return {
    replay: s.replay === true,
    replaySeconds: nearest(REPLAY_LENGTHS, s.replaySeconds, DEFAULTS.replaySeconds),
    quality: normalizeQuality(s.quality),
    fps: nearest(FPS, s.fps, DEFAULTS.fps),
    level: LEVELS.includes(s.level) ? s.level : DEFAULTS.level,
    recordLimit: Number.isFinite(limit) && limit > 0 ? nearest(RECORD_LIMITS.slice(1), limit, 0) : 0,
    audio: s.audio === undefined ? DEFAULTS.audio : s.audio === true,
    notify: s.notify !== false,
    copyTo: cleanFolder(s.copyTo),
    shortcuts: normalizeShortcuts(s.shortcuts),
    auto: normalizeAuto(s.auto),
  };
}

// Largo de un clip automatico: el elegido, sin pasarse de lo que guarda la repeticion
function autoSeconds(auto, replaySeconds = DEFAULTS.replaySeconds) {
  return Math.min(normalizeAuto(auto).seconds, Math.max(1, Number(replaySeconds) || DEFAULTS.replaySeconds));
}

// ---------- Calidad ----------

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * Tope de tamanio de la captura (se achica manteniendo la proporcion, nunca se agranda). display = { width, height }
 * en pixeles reales de la pantalla: "nativa" es ese tamanio con tope en 4K (sin saberlo, el tope de 4K).
 */
function qualityBox(quality, display = null) {
  const q = normalizeQuality(quality);
  if (BOXES[q]) return { ...BOXES[q] };
  if (display?.width > 0 && display?.height > 0) return fitBox(display.width, display.height, NATIVE_MAX);
  return { ...NATIVE_MAX };
}

// w x h achicado (sin agrandar) para entrar en box, con lados pares
function fitBox(w, h, box) {
  const W = Math.max(2, Math.round(Number(w) || 0));
  const H = Math.max(2, Math.round(Number(h) || 0));
  const k = Math.min(1, box.width / W, box.height / H);
  return { width: even(W * k), height: even(H * k) };
}

// Tamanio final de un video de w x h dentro de la caja de la calidad (sin agrandar; lados pares para el codec)
function fitSize(w, h, quality, display = null) {
  return fitBox(w, h, qualityBox(quality, display));
}

/**
 * Bitrate: bits por pixel de cada cuadro "equivalente" a 30 fps segun la calidad elegida. Los fps no cuestan
 * lineal: 30 * (fps/30)^0,7 (60 fps = 1,6 veces 30; 120 fps = 2,6 veces), porque a mas cuadros por segundo menos
 * cambia cada uno. Con Media, 1080p60 da ~10 Mbps, 1440p60 ~18 y 4K60 ~40 en VP9: entre lo que recomienda YouTube
 * para subir (12, 24 y 53 Mbps en H.264) y algo menos, porque se graba en tiempo real para guardar en disco.
 * Cada codec tiene su factor para la misma imagen (H.264 ~35 % mas que VP9; AV1 ~20 % menos; VP8 ~25 % mas).
 *
 * Medido en Electron 44 (RTX 4070 SUPER, ver docs/clips.md): los codificadores por hardware (AV1 y H.264 de la GPU)
 * respetan el bitrate en proporcion pero gastan ~2,5 veces lo pedido a 60 fps, ~1,4 a 30 y ~4 a 120 (casi lo mismo
 * por cuadro). Por eso a esos se les pide lo que corresponde dividido por HW_OVERSHOOT: asi el
 * archivo pesa lo que dice la tabla. Los de software (VP9 y VP8) van cerca de lo pedido (hasta 1,45 y 1,15 veces con
 * una imagen que cambia toda, el peor caso): eso se suma solo a la cuenta del disco.
 * La grabadora (renderer/js/recorder/bitrate.js) hace esta misma cuenta al tamanio real de la ventana; logic.test.js
 * comprueba que den igual.
 */
const BPP = { low: 0.06, medium: 0.1, high: 0.15 };
const FPS_EXP = 0.7;
const CODEC_FACTOR = { vp9: 1, av1: 0.8, h264: 1.35, vp8: 1.25 };
const HW_OVERSHOOT = { k: 2.5, exp: 0.75 }; // gasto real / pedido por hardware = k * (fps/60)^exp
const SW_OVERSHOOT = { vp9: 1.45, vp8: 1.15 };
const WORST_FACTOR = 1.45; // codec todavia desconocido: el que mas gasta respecto de VP9 (VP9 o VP8 por software)
const MIN_BPS = 1500000;
const MAX_BPS = 100000000;

function bitrateModel(level = DEFAULTS.level) {
  return { bpp: BPP[level] || BPP.medium, fpsExp: FPS_EXP, min: MIN_BPS, max: MAX_BPS, factors: { ...CODEC_FACTOR }, hw: { ...HW_OVERSHOOT } };
}

// Lo que tiene que pesar el video (bits por segundo) para ese tamanio, fps, calidad y codec
function targetBitrate(width, height, fps, level = DEFAULTS.level, codec = 'vp9') {
  const pixels = Math.max(1, Number(width) || 0) * Math.max(1, Number(height) || 0);
  const f = Math.max(1, Number(fps) || 30);
  const eff = 30 * Math.pow(f / 30, FPS_EXP);
  return Math.round(Math.min(MAX_BPS, Math.max(MIN_BPS, pixels * eff * (BPP[level] || BPP.medium) * (CODEC_FACTOR[codec] || 1))));
}

// Cuanto gasta de mas un codificador por hardware a esos fps
function hwOvershoot(fps) {
  return HW_OVERSHOOT.k * Math.pow(Math.max(1, Number(fps) || 30) / 60, HW_OVERSHOOT.exp);
}

// Lo que se le pide a MediaRecorder (videoBitsPerSecond): el objetivo, compensado si el codec va por hardware
function bitrateFor(width, height, fps, level = DEFAULTS.level, codec = 'vp9', hardware = false) {
  const target = targetBitrate(width, height, fps, level, codec);
  return hardware ? Math.max(Math.round(MIN_BPS / 2), Math.round(target / hwOvershoot(fps))) : target;
}

// Bits por segundo que se espera que ocupe de verdad (para el disco). Sin saber el codec, el peor caso.
function expectedBitrate(width, height, fps, level = DEFAULTS.level, codec = null, hardware = false) {
  if (!codec) return Math.round(targetBitrate(width, height, fps, level, 'vp9') * WORST_FACTOR);
  const target = targetBitrate(width, height, fps, level, codec);
  return Math.round(hardware ? target : target * (SW_OVERSHOOT[codec] || WORST_FACTOR));
}

/**
 * Codecs, medido en Electron 44 con la ventana de prueba (docs/clips.md, "Calidad y codec"):
 * - Por hardware (se elige si WebCodecs dice que la GPU lo codifica): AV1 primero (60 fps a 4K con <10 % de CPU y
 *   el archivo mas chico), despues H.264. VP9 por hardware solo en las GPU que lo tengan.
 * - Por software: VP9 no llega a 1080p60 (39 fps con 35 % de CPU) pero comprime mejor: solo hasta 1080p a 30 fps.
 *   Mas arriba VP8 (1080p60 a 60 fps con 14 % de CPU; 4K60 da ~30 fps). H.264 por software (OpenH264) no respeta
 *   el cuadro clave cada 2 s (sale todo cuadro clave, ~100 Mbps): nunca.
 * Todo va en WebM. MediaRecorder prueba en este orden y usa el primero que arranque.
 */
const HW_CODECS = ['av1', 'h264', 'vp9'];
function codecOrder(plan) {
  return load(plan) <= 1920 * 1080 * 30 ? ['vp9', 'vp8'] : ['vp8', 'vp9'];
}

// ---------- Lo que de verdad se graba ----------

/**
 * Tamanio, fps y bitrate efectivos de la captura con estos ajustes y este equipo, y avisos de por que puede salir
 * distinto de lo pedido. env = { display: { width, height, hz }, window: { width, height } | null (tamanio real, si
 * ya se esta capturando), codec, hardware (lo que eligio la grabadora, si ya arranco) } ->
 * { width, height, fps, codec, hardware, bitrate (pedido), expected (lo que se espera que ocupe), notes: [] }. notes:
 *   'window'  la ventana del juego es mas chica que la resolucion elegida: se graba a su tamanio (no se agranda)
 *   'monitor' se piden mas fps que los Hz de la pantalla: la captura de una ventana da los cuadros que el juego
 *             muestra. Con el juego sin limite de fps (VSync apagado) se midieron 120 fps en una pantalla de 60 Hz;
 *             con VSync, el juego no pasa de los Hz y el video tampoco.
 */
function effective(settings, env = {}) {
  const s = normalizeSettings(settings);
  // La pantalla principal solo sirve de estimacion para "nativa" mientras no se conoce la ventana (puede estar en otra)
  const hasWin = env.window?.width > 0 && env.window?.height > 0;
  const box = qualityBox(s.quality, hasWin ? null : env.display);
  const notes = [];
  let size = box;
  if (env.window?.width > 0 && env.window?.height > 0) {
    const win = { width: Math.round(env.window.width), height: Math.round(env.window.height) };
    size = fitBox(win.width, win.height, box);
    if (s.quality !== 'native' && win.width < box.width && win.height < box.height) notes.push('window');
  }
  const fps = s.fps;
  const hz = Math.round(Number(env.display?.hz) || 0);
  if (hz >= 24 && fps > hz) notes.push('monitor');
  const codec = env.codec || null;
  const hardware = codec ? env.hardware === true : null;
  return {
    width: size.width,
    height: size.height,
    fps,
    codec,
    hardware,
    bitrate: bitrateFor(size.width, size.height, fps, s.level, codec || 'vp9', hardware === true),
    expected: expectedBitrate(size.width, size.height, fps, s.level, codec, hardware === true),
    notes,
  };
}

// Bytes que ocupan `seconds` de video con ese plan (video + audio). Es un tope: con imagen quieta se usa menos.
function estimateBytes(seconds, plan, audio = true) {
  const bps = (Number(plan?.expected ?? plan?.bitrate) || 0) + (audio ? AUDIO_BPS : 0);
  return Math.round((Math.max(0, Number(seconds) || 0) * bps) / 8);
}

/**
 * Disco que ocupa el buffer de la repeticion (para mostrarlo en Ajustes y decidir si arranca): bytes. Cuenta el
 * segmento de mas que guarda hasta poder descartar el mas viejo.
 */
function replayDisk(seconds, plan, audio = true) {
  return estimateBytes(Number(seconds) + RING_SEGMENT_SECONDS, plan, audio);
}

// Hay lugar para escribir need bytes y que queden DISK_MARGIN libres? (free = bytes libres; null = no se sabe y se deja pasar)
function hasDiskRoom(free, need) {
  return free === null || free === undefined || free >= need + DISK_MARGIN;
}

/**
 * Tope duro de bytes del buffer en disco: una vez y media lo estimado (con video quieto rota menos), al menos 512 MB
 * y nunca tanto que deje el disco con menos de DISK_MARGIN libres (si se sabe cuanto hay).
 */
function ringMaxBytes(need, free = null) {
  let max = Math.max(512 * 1024 * 1024, Math.round((Number(need) || 0) * 1.5));
  if (Number.isFinite(free) && free !== null) max = Math.min(max, Math.max(Number(need) || 0, free - DISK_MARGIN));
  return Math.max(64 * 1024 * 1024, max);
}

// ---------- Presets ----------

const PRESET_IDS = ['light', 'balanced', 'max'];

/**
 * Los tres ajustes de un clic. "Maximo" depende de la pantalla: 4K a 60 fps si es 4K o mas grande; si no,
 * 1440p (2K) a 120 fps (con una pantalla de 60 Hz eso queda en 60: lo dice effective()).
 */
function presetValues(id, display = null) {
  if (id === 'light') return { quality: '720p', fps: 30, level: 'medium' };
  if (id === 'balanced') return { quality: '1080p', fps: 60, level: 'medium' };
  if (id === 'max') {
    const big = display?.width >= 3840 && display?.height >= 2160;
    return big ? { quality: '2160p', fps: 60, level: 'high' } : { quality: '1440p', fps: 120, level: 'high' };
  }
  return null;
}

// Que preset coincide con los ajustes ('custom' si ninguno)
function activePreset(settings, display = null) {
  const s = normalizeSettings(settings);
  return PRESET_IDS.find((id) => {
    const p = presetValues(id, display);
    return p.quality === s.quality && p.fps === s.fps && p.level === s.level;
  }) || 'custom';
}

// Pixeles por segundo que hay que capturar y codificar (para comparar con "Equilibrado" en una PC modesta)
function load(plan) {
  return Math.max(0, Number(plan?.width) || 0) * Math.max(0, Number(plan?.height) || 0) * Math.max(0, Number(plan?.fps) || 0);
}
const BALANCED_LOAD = 1920 * 1080 * 60;

// ---------- Cuando la PC no llega ----------

/**
 * Compara lo que se pidio con lo que sale codificado (cuadros por segundo de los ultimos segundos) y dice si hay que
 * bajar: 'ok', 'source' (salen menos cuadros porque el juego o la pantalla dan menos; bajar no ayuda) o 'encoder'
 * (la PC no da abasto: hay que bajar). Medido en Electron 44: cuando el codificador por software no llega, Chromium
 * frena la captura y las estadisticas de la pista (delivered) bajan igual que lo codificado, asi que no sirven para
 * separar un caso del otro. Por eso decide el tipo de codificador: los de la GPU dieron 60 fps a 4K y ~100 fps a 1440p
 * con menos del 12 % de CPU (si salen menos, es el juego o la pantalla); con uno por software, que salgan menos es
 * que la PC no llega (y bajar tambien le deja mas CPU al juego). delivered solo cuenta si muestra cuadros perdidos.
 */
function assessRate({ target, delivered = null, encoded, hardware = false }) {
  const want = Number(target) || 0;
  const enc = Number(encoded) || 0;
  if (!want || enc >= want * 0.85) return 'ok';
  const got = delivered === null || delivered === undefined ? NaN : Number(delivered);
  if (Number.isFinite(got) && got > 0 && enc < got * 0.75) return 'encoder';
  // Que no lleguen cuadros (ventana minimizada, pantalla de carga) no es un codificador lento
  if (enc <= 0 || got === 0) return 'source';
  return hardware ? 'source' : 'encoder';
}

/**
 * Un paso hacia abajo cuando el codificador no da abasto: primero los fps (120 -> 80 -> 60 -> 45 -> 30), despues la
 * resolucion (4K -> 1440p -> 1080p -> 720p). height = alto real que se esta grabando (0 = no se sabe): con una
 * ventana mas chica que la calidad elegida se saltean las cajas que no la achicarian. null = no hay nada mas abajo.
 */
function stepDown({ quality, fps }, height = 0) {
  const f = nearest(FPS, fps, DEFAULTS.fps);
  const i = FPS.indexOf(f);
  if (f > 60) return { quality, fps: FPS[i - 1] };
  const q = normalizeQuality(quality);
  const real = Number(height) > 0 ? Number(height) : 0;
  const h = q === 'native' ? real || NATIVE_MAX.height : Math.min(BOXES[q].height, real || BOXES[q].height);
  const lower = ['2160p', '1440p', '1080p', '720p'].find((x) => BOXES[x].height < h);
  if (lower) return { quality: lower, fps: f };
  if (f > 30) return { quality: q, fps: FPS[i - 1] };
  return null;
}

// ---------- Archivos ----------

const pad = (n) => String(n).padStart(2, '0');

// Fecha local en el formato de Minecraft ("2026-11-01_18.03.11"), que tambien entiende worlds/media.js
function stamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

// reason = motivo de un clip automatico: queda en el nombre ("..._auto-death.webm") y de ahi lo lee la pagina de
// Clips, asi el motivo sigue al archivo sin otra lista ni otro registro (lo mismo que la fecha)
function fileName(kind, date = new Date(), reason = null) {
  if (!KIND_DIR[kind]) throw new Error(`kind ${kind}`);
  const tag = kind === 'clip' && AUTO_REASONS.includes(reason) ? `auto-${reason}` : KIND_TAG[kind];
  return `${stamp(date)}_${tag}.${kind === 'screenshot' ? 'png' : 'webm'}`;
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
  LEVELS,
  REPLAY_LENGTHS,
  RECORD_LIMITS,
  ACTIONS,
  DEFAULTS,
  KEYFRAME_MS,
  RING_SEGMENT_SECONDS,
  DISK_MARGIN,
  AUTO_REASONS,
  AUTO_SECONDS,
  BPP,
  MIN_BPS,
  MAX_BPS,
  HW_CODECS,
  PRESET_IDS,
  BALANCED_LOAD,
  platformSupport,
  normalizeAccelerator,
  normalizeShortcuts,
  normalizeSettings,
  normalizeQuality,
  normalizeAuto,
  cleanFolder,
  autoSeconds,
  qualityBox,
  fitSize,
  bitrateModel,
  targetBitrate,
  hwOvershoot,
  bitrateFor,
  expectedBitrate,
  codecOrder,
  effective,
  estimateBytes,
  replayDisk,
  hasDiskRoom,
  ringMaxBytes,
  presetValues,
  activePreset,
  load,
  assessRate,
  stepDown,
  stamp,
  fileName,
  folderFor,
  uniqueName,
  exportName,
  screenshotPath,
  pickGame,
};
