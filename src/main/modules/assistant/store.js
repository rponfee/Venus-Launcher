'use strict';
// Conversaciones del asistente en data/assistant/conversations/<id>.json. Cada una guarda:
//   messages  historial para el modelo, SOLO se agrega al final (los bloques del asistente quedan
//             exactamente como llegaron, incluidos los bloques de "thinking" vacios con firma)
//   events    registro de la interfaz (burbujas, tarjetas de herramientas, confirmaciones, deshacer)
//   defs      hash de las definiciones (prompt + herramientas) con las que empezo: se reusan siempre
//             las mismas para que el historial siga siendo valido y el cache del modelo funcione.
//   model     ultimo modelo elegido ('haiku' | 'sonnet' | 'opus', null = el del plan) y effort su esfuerzo.
//             Puede cambiar entre preguntas: el historial no se toca (la API descarta, sin cobrarlos, los
//             bloques de razonamiento de otro modelo).
//   userId    cuenta de Venus que la empezo (null = sin sesion; sin el campo = de antes de guardarla). La pone
//             y la controla agent.js: cada cuenta ve solo las suyas.
//   engine    quien responde: 'venus' (el backend del launcher, por defecto) o un motor externo ('claude' = el
//             Claude Code del usuario, 'chatgpt' = su Codex). Fijo por conversacion: la sesion del CLI que sigue
//             la charla queda en external.sessionId (no se puede cambiar de motor a mitad de una conversacion).
// Un indice (index.json) evita leer todas las conversaciones para listarlas.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const paths = require('../../core/paths');
const { readJson, writeJson, uid } = require('../../core/util');

const VERSION = 1;
const ID_RE = /^[a-z0-9]{8,32}$/;

const base = () => paths.data('assistant');
const convDir = () => path.join(base(), 'conversations');
const defsDir = () => path.join(base(), 'defs');
const convPath = (id) => path.join(convDir(), `${id}.json`);
const indexPath = () => path.join(convDir(), 'index.json');

const chains = new Map(); // escrituras en serie por archivo
let indexCache = null;

function serial(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return next;
}

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// ---------- Definiciones (prompt + herramientas) ----------
async function saveDefs(defs) {
  const json = JSON.stringify(defs);
  const hash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 24);
  const file = path.join(defsDir(), `${hash}.json`);
  try {
    await fsp.access(file);
  } catch {
    await writeJson(file, defs);
  }
  return hash;
}

async function loadDefs(hash) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{24}$/.test(hash)) return null;
  return readJson(path.join(defsDir(), `${hash}.json`), null);
}

// ---------- Conversaciones ----------
function create({ defs, now = Date.now() } = {}) {
  return {
    version: VERSION,
    id: uid(16),
    title: '',
    createdAt: now,
    updatedAt: now,
    defs: defs || null,
    messages: [],
    events: [],
    seq: 0,
    notes: [],
    createdInstances: [],
    fullSnapshots: {},
    stripThinkingBefore: null,
    usage: { input: 0, output: 0, cacheRead: 0, requests: 0 },
    lastTurn: null,
    model: null,
    effort: null,
    engine: 'venus',
    external: null,
  };
}

async function load(id) {
  if (!validId(id)) return null;
  const data = await readJson(convPath(id), null);
  if (!data || data.id !== id || !Array.isArray(data.messages)) return null;
  return {
    ...create(),
    ...data,
    events: Array.isArray(data.events) ? data.events : [],
    notes: Array.isArray(data.notes) ? data.notes : [],
    createdInstances: Array.isArray(data.createdInstances) ? data.createdInstances : [],
    fullSnapshots: data.fullSnapshots && typeof data.fullSnapshots === 'object' ? data.fullSnapshots : {},
    engine: typeof data.engine === 'string' && data.engine ? data.engine : 'venus',
    external: data.external && typeof data.external === 'object' ? data.external : null,
  };
}

function summaryOf(conv) {
  return {
    id: conv.id,
    title: conv.title || '',
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    turns: conv.events.filter((e) => e.type === 'turn-start').length,
    model: conv.model || null,
    engine: conv.engine || 'venus',
    userId: conv.userId,
  };
}

async function readIndex() {
  if (indexCache) return indexCache;
  const data = await readJson(indexPath(), null);
  if (data && Array.isArray(data.items)) {
    indexCache = new Map(data.items.filter((i) => validId(i?.id)).map((i) => [i.id, i]));
    return indexCache;
  }
  // Sin indice (o roto): se reconstruye leyendo las conversaciones
  indexCache = new Map();
  const files = await fsp.readdir(convDir()).catch(() => []);
  for (const f of files) {
    const m = f.match(/^([a-z0-9]{8,32})\.json$/);
    if (!m) continue;
    const conv = await load(m[1]);
    if (conv) indexCache.set(conv.id, summaryOf(conv));
  }
  await writeIndex();
  return indexCache;
}

function writeIndex() {
  return serial('index', () => writeJson(indexPath(), { version: VERSION, items: [...(indexCache || new Map()).values()] }));
}

// touch: false guarda sin cambiar la fecha (por ejemplo, al anotar la cuenta de una conversacion vieja).
async function save(conv, { touch = true } = {}) {
  if (touch) conv.updatedAt = Date.now();
  await serial(conv.id, () => writeJson(convPath(conv.id), conv));
  const idx = await readIndex();
  idx.set(conv.id, summaryOf(conv));
  await writeIndex();
}

async function list() {
  const idx = await readIndex();
  return [...idx.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

async function remove(id) {
  if (!validId(id)) return false;
  await serial(id, () => fsp.rm(convPath(id), { force: true }));
  const idx = await readIndex();
  idx.delete(id);
  await writeIndex();
  return true;
}

function _reset() {
  indexCache = null;
}

module.exports = { create, load, save, list, remove, saveDefs, loadDefs, validId, summaryOf, _reset };
