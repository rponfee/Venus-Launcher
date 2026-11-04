'use strict';
// Marcadores del Mapa del mundo: validacion, archivo y codigos para compartir. Sin Electron: lo prueba test/markers.test.js.
//   Archivo: <mundo>/venus-markers.json = { v: 1, markers: [{ id, name, color, icon, dimension, x, y, z, createdAt }] }
//   (el juego no mira archivos que no conoce, asi que no le molesta; una copia del mundo lo lleva con ella)
//   Codigo: VENUS-MARKERS:<base64url del JSON { v: 1, m: [[nombre, color, icono, dimension, x, y, z], ...] }>
// Un codigo viene de otra persona: el nombre es texto no confiable (se limpia aca y la interfaz lo dibuja como texto,
// nunca como HTML) y todo lo demas se valida contra listas y rangos. Lo que no cumple se descarta.
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { readJson, writeJson } = require('../../core/util');

const FILE = 'venus-markers.json';
const CODE_PREFIX = 'VENUS-MARKERS:';
const MAX_MARKERS = 1000;
const MAX_NAME = 48;
const MAX_CODE = 12000; // lo que se acepta al pegar
const MAX_IN_CODE = 200;
const MESSAGE_MAX = 2000; // tope de un mensaje en Mensajes (social.js): un codigo mas largo se copia, no se manda
const MAX_COORD = 30000000; // el borde del mundo de Minecraft
const MIN_Y = -2048;
const MAX_Y = 4096;
const MAX_FILE = 2 * 1024 * 1024;
const COLORS = ['#f29a2e', '#e5544b', '#ec6fb4', '#a374f0', '#4f8df7', '#3cc4c8', '#54c26a', '#e8c547', '#f4efe6'];
const ICONS = ['pin', 'home', 'star', 'flag', 'skull', 'gem', 'pickaxe', 'castle', 'tree', 'portal'];
const DIMENSION = /^(?:folder:DIM-?\d{1,9}|[a-z0-9_.-]{1,64}:[a-z0-9_./-]{1,128})$/;

function coded(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

// Nombre de una linea: sin caracteres de control ni marcas de direccion (para que no se pueda dar vuelta el texto)
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${String.fromCharCode(0x2028, 0x2029)}${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200f)}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]`, 'g');
function cleanName(v) {
  if (typeof v !== 'string') return '';
  const s = v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, MAX_NAME).join('').trim();
}

const coord = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean' || Array.isArray(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= MAX_COORD ? Math.round(n) : null;
};

const height = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean' || Array.isArray(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= MIN_Y && n <= MAX_Y ? Math.round(n) : null;
};

function cleanColor(v) {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return /^#[0-9a-f]{6}$/.test(s) ? s : COLORS[0];
}

const cleanIcon = (v) => (ICONS.includes(v) ? v : ICONS[0]);
const cleanDimension = (v) => (typeof v === 'string' && !v.includes('..') && DIMENSION.test(v) ? v : null);

// Cualquier cosa -> marcador valido o null. Sin id propio se le pone uno.
function normalizeMarker(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = cleanName(raw.name);
  const x = coord(raw.x);
  const z = coord(raw.z);
  const dimension = cleanDimension(raw.dimension);
  if (!name || x === null || z === null || !dimension) return null;
  const id = typeof raw.id === 'string' && /^m[a-z0-9]{6,24}$/.test(raw.id) ? raw.id : newId();
  const createdAt = Number.isFinite(raw.createdAt) && raw.createdAt > 0 ? Math.floor(raw.createdAt) : Date.now();
  return { id, name, color: cleanColor(raw.color), icon: cleanIcon(raw.icon), dimension, x, y: height(raw.y), z, createdAt };
}

function newId() {
  return `m${crypto.randomBytes(6).toString('hex')}`;
}

// ---------- Archivo ----------
async function read(dir) {
  const file = path.join(dir, FILE);
  const st = await fsp.stat(file).catch(() => null);
  if (!st?.isFile() || st.size > MAX_FILE) return [];
  const data = await readJson(file, null);
  const list = Array.isArray(data?.markers) ? data.markers : [];
  const seen = new Set();
  const out = [];
  for (const raw of list.slice(0, MAX_MARKERS)) {
    const m = normalizeMarker(raw);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

// Escrituras de a una por mundo: leer, cambiar y guardar no se pueden pisar entre si
const chains = new Map();
function update(dir, fn) {
  const key = path.resolve(dir);
  const run = (chains.get(key) || Promise.resolve()).then(async () => {
    const list = await read(dir);
    const out = await fn(list);
    await writeJson(path.join(dir, FILE), { v: 1, markers: out.markers });
    return out;
  });
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

// Crea (sin id conocido) o cambia un marcador
function save(dir, raw) {
  return update(dir, (list) => {
    const m = normalizeMarker(raw);
    if (!m) throw coded('badMarker');
    const i = list.findIndex((x) => x.id === m.id);
    if (i >= 0) list[i] = { ...m, createdAt: list[i].createdAt };
    else {
      if (list.length >= MAX_MARKERS) throw coded('limit');
      list.push(m);
    }
    return { markers: list, marker: i >= 0 ? list[i] : m };
  });
}

function remove(dir, id) {
  return update(dir, (list) => ({ markers: list.filter((m) => m.id !== id) }));
}

const sameSpot = (a, b) => a.dimension === b.dimension && a.x === b.x && a.z === b.z && a.name === b.name;

// Suma los marcadores de un codigo; los que ya estan (mismo nombre, dimension y lugar) no se repiten
function addAll(dir, incoming) {
  return update(dir, (list) => {
    let added = 0;
    let skipped = 0;
    for (const raw of incoming) {
      const m = normalizeMarker({ ...raw, id: undefined, createdAt: undefined });
      if (!m) continue;
      if (list.some((x) => sameSpot(x, m)) || list.length >= MAX_MARKERS) skipped++;
      else {
        list.push(m);
        added++;
      }
    }
    return { markers: list, added, skipped };
  });
}

// ---------- Codigos para compartir ----------
function encodeCode(markers) {
  const list = (Array.isArray(markers) ? markers : []).map(normalizeMarker).filter(Boolean);
  if (!list.length) throw coded('badMarker');
  if (list.length > MAX_IN_CODE) throw coded('tooLong');
  const json = JSON.stringify({ v: 1, m: list.map((k) => [k.name, k.color, k.icon, k.dimension, k.x, k.y, k.z]) });
  const code = CODE_PREFIX + Buffer.from(json, 'utf8').toString('base64url');
  if (code.length > MAX_CODE) throw coded('tooLong');
  return { code, count: list.length, length: code.length, fitsMessage: code.length <= MESSAGE_MAX };
}

// Texto pegado (puede venir con mas palabras alrededor) -> { markers, dropped }. Lanza err.code 'badCode'.
function decodeCode(text) {
  if (typeof text !== 'string' || text.length > MAX_CODE * 2) throw coded(typeof text === 'string' ? 'tooLong' : 'badCode');
  const found = /VENUS-MARKERS:([A-Za-z0-9_-]+)/.exec(text);
  if (!found) throw coded('badCode');
  if (found[0].length > MAX_CODE) throw coded('tooLong');
  let data;
  try {
    data = JSON.parse(Buffer.from(found[1], 'base64url').toString('utf8'));
  } catch {
    throw coded('badCode');
  }
  if (!data || data.v !== 1 || !Array.isArray(data.m)) throw coded('badCode');
  const markers = [];
  let dropped = Math.max(0, data.m.length - MAX_IN_CODE);
  for (const row of data.m.slice(0, MAX_IN_CODE)) {
    const m = Array.isArray(row) ? normalizeMarker({ name: row[0], color: row[1], icon: row[2], dimension: row[3], x: row[4], y: row[5], z: row[6] }) : null;
    if (m) markers.push({ name: m.name, color: m.color, icon: m.icon, dimension: m.dimension, x: m.x, y: m.y, z: m.z });
    else dropped++;
  }
  if (!markers.length) throw coded('badCode');
  return { markers, dropped };
}

module.exports = { read, save, remove, addAll, normalizeMarker, encodeCode, decodeCode, cleanName, FILE, CODE_PREFIX, COLORS, ICONS, MAX_MARKERS, MAX_CODE, MAX_NAME, MAX_IN_CODE, MESSAGE_MAX };
