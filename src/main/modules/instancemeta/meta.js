'use strict';
// Metadatos de presentacion de una instancia (venus-instance.json): caratula, etiquetas, favorito, notas, aspecto
// por instancia (look: fondo, color y musica) y si usa los ajustes compartidos (sharedOptions).
// Funciones puras, sin Electron: core/instances.update las usa para validar lo que llega de la interfaz
// (o de cualquier modulo) antes de escribir. Pruebas: node --test "src/main/modules/instancemeta/test/"
const TAG_MAX = 10;
const TAG_LEN = 24;
const NOTES_MAX = 20000;
const TASK_MAX = 100;
const TASK_LEN = 200;
const TASK_ID = /^[a-z0-9]{4,32}$/i;
// Solo nombres de archivo generados por el modulo (dentro de la carpeta de la instancia).
const COVER_FILE = /^cover\.(png|webp|jpe?g)$/i;
const META_KEYS = ['cover', 'coverAt', 'tags', 'favorite', 'notes', 'look', 'sharedOptions'];
// Aspecto por instancia (features/instancelook.js)
const LOOK_ACCENTS = ['venus', 'mars', 'neptune', 'jupiter', 'earth', 'saturn'];
const LOOK_HEX = /^#[0-9a-f]{6}$/i;
const LOOK_WALLPAPER = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const LOOK_IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp|mp4|webm|m4v|ogv)$/i;
const LOOK_AUDIO = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|weba)$/i;
const LOOK_PATH_MAX = 1024;

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function chars(s) {
  return Array.from(s).length;
}

function cleanLine(s) {
  return String(s ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Hasta 10 etiquetas de 1 a 24 caracteres, sin repetidas (sin distinguir mayusculas). Lo que no sirve se descarta.
function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = cleanLine(item);
    if (!tag || chars(tag) > TAG_LEN) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= TAG_MAX) break;
  }
  return out;
}

function normalizeFavorite(raw) {
  return raw === true;
}

function randomId() {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

// { text (hasta 20000 caracteres), tasks: [{ id, text (hasta 200), done }] (hasta 100) }
function normalizeNotes(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const text = typeof src.text === 'string' ? Array.from(src.text.replace(CONTROL, '')).slice(0, NOTES_MAX).join('') : '';
  const tasks = [];
  const ids = new Set();
  for (const item of Array.isArray(src.tasks) ? src.tasks : []) {
    if (!item || typeof item !== 'object') continue;
    const taskText = cleanLine(item.text);
    if (!taskText) continue;
    let id = typeof item.id === 'string' && TASK_ID.test(item.id) ? item.id : randomId();
    while (ids.has(id)) id = randomId();
    ids.add(id);
    tasks.push({ id, text: Array.from(taskText).slice(0, TASK_LEN).join(''), done: item.done === true });
    if (tasks.length >= TASK_MAX) break;
  }
  return { text, tasks };
}

// Nombre del archivo de caratula dentro de la instancia; null = sin caratula (vuelve a la generada).
// Devuelve undefined si no es valido (la clave se descarta del parche).
function normalizeCover(raw) {
  if (raw === null) return null;
  return typeof raw === 'string' && COVER_FILE.test(raw) ? raw : undefined;
}

function lookInt(raw, min, max, def) {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

// Un archivo del usuario para el fondo o la musica: ruta local absoluta con una extension conocida (sin rutas de
// red, sin direcciones). Devuelve la ruta o null.
function lookFile(raw, ext) {
  if (typeof raw !== 'string' || !raw || raw.length > LOOK_PATH_MAX || /[\x00-\x1f\x7f]/.test(raw) || !ext.test(raw)) return null;
  return /^[A-Za-z]:[\\/]/.test(raw) || /^\/(?!\/)/.test(raw) ? raw : null;
}

function normalizeLookColor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (LOOK_ACCENTS.includes(raw.accent)) return { accent: raw.accent };
  if (raw.accent === 'custom' && LOOK_HEX.test(raw.customColor || '')) return { accent: 'custom', customColor: raw.customColor.toLowerCase() };
  return null;
}

function normalizeLookBackground(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const shade = { dim: lookInt(raw.dim, 0, 90, 45), blur: lookInt(raw.blur, 0, 24, 0) };
  if (raw.type === 'stars') return { type: 'stars' };
  if (raw.type === 'wallpaper' && typeof raw.id === 'string' && LOOK_WALLPAPER.test(raw.id)) return { type: 'wallpaper', id: raw.id, ...shade };
  if (raw.type === 'image') {
    const file = lookFile(raw.file, LOOK_IMAGE);
    if (file) return { type: 'image', file, ...shade };
  }
  return null;
}

function normalizeLookMusic(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'off') return { type: 'off' };
  if (raw.type === 'file') {
    const file = lookFile(raw.file, LOOK_AUDIO);
    if (file) return { type: 'file', file, volume: lookInt(raw.volume, 0, 100, 35), pauseInGame: raw.pauseInGame !== false };
  }
  return null;
}

// { color?, background?, music? } o null si no cambia nada (la instancia se ve como el launcher).
function normalizeLook(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  const color = normalizeLookColor(raw.color);
  const background = normalizeLookBackground(raw.background);
  const music = normalizeLookMusic(raw.music);
  if (color) out.color = color;
  if (background) out.background = background;
  if (music) out.music = music;
  return Object.keys(out).length ? out : null;
}

// Normaliza en el lugar las claves de metadatos presentes en un parche de instances.update.
function applyMetaPatch(patch) {
  if (!patch || typeof patch !== 'object') return patch;
  if ('tags' in patch) patch.tags = normalizeTags(patch.tags);
  if ('favorite' in patch) patch.favorite = normalizeFavorite(patch.favorite);
  if ('notes' in patch) patch.notes = patch.notes === null ? null : normalizeNotes(patch.notes);
  if ('look' in patch) patch.look = normalizeLook(patch.look);
  if ('sharedOptions' in patch) patch.sharedOptions = patch.sharedOptions === true;
  if ('cover' in patch) {
    const cover = normalizeCover(patch.cover);
    if (cover === undefined) delete patch.cover;
    else patch.cover = cover;
  }
  if ('coverAt' in patch) {
    const at = Number(patch.coverAt);
    if (patch.coverAt === null) patch.coverAt = null;
    else if (Number.isFinite(at) && at > 0) patch.coverAt = Math.round(at);
    else delete patch.coverAt;
  }
  return patch;
}

function pendingTasks(notes) {
  return Array.isArray(notes?.tasks) ? notes.tasks.filter((x) => x && x.done !== true).length : 0;
}

module.exports = {
  TAG_MAX,
  TAG_LEN,
  NOTES_MAX,
  TASK_MAX,
  TASK_LEN,
  META_KEYS,
  normalizeTags,
  normalizeFavorite,
  normalizeNotes,
  normalizeCover,
  normalizeLook,
  applyMetaPatch,
  pendingTasks,
};
