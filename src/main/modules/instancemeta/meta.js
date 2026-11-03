'use strict';
// Metadatos de presentacion de una instancia (venus-instance.json): caratula, etiquetas, favorito y notas.
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
const META_KEYS = ['cover', 'coverAt', 'tags', 'favorite', 'notes'];

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

// Normaliza en el lugar las claves de metadatos presentes en un parche de instances.update.
function applyMetaPatch(patch) {
  if (!patch || typeof patch !== 'object') return patch;
  if ('tags' in patch) patch.tags = normalizeTags(patch.tags);
  if ('favorite' in patch) patch.favorite = normalizeFavorite(patch.favorite);
  if ('notes' in patch) patch.notes = patch.notes === null ? null : normalizeNotes(patch.notes);
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
  applyMetaPatch,
  pendingTasks,
};
