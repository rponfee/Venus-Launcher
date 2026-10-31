'use strict';
// options.txt de Minecraft: activar el paquete de traducciones en "resourcePacks" (sin tocar el resto
// de las lineas ni el orden de los paquetes que ya tenia el jugador) y, si se pide, el idioma del juego.
// En la lista, el ultimo paquete es el de mayor prioridad. El nuestro va con la prioridad mas baja entre
// los paquetes del jugador: si despues agrega una traduccion hecha por personas, esa gana.

function parse(text) {
  const src = String(text ?? '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return {
    eol,
    lines: lines.map((raw) => {
      const i = raw.indexOf(':');
      return i > 0 ? { raw, key: raw.slice(0, i), value: raw.slice(i + 1) } : { raw };
    }),
  };
}

function serialize(doc) {
  return doc.lines.map((l) => (l.key !== undefined ? `${l.key}:${l.value}` : l.raw)).join(doc.eol) + doc.eol;
}

function get(doc, key) {
  const line = doc.lines.find((l) => l.key === key);
  return line ? line.value : undefined;
}

function set(doc, key, value) {
  const line = doc.lines.find((l) => l.key === key);
  if (line) line.value = value;
  else doc.lines.push({ key, value });
}

// '["vanilla","file/x.zip"]' -> ['vanilla', 'file/x.zip']. Tolera listas mal formadas.
function parseList(value) {
  if (value === undefined || value === null) return [];
  const s = String(value).trim();
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string');
  } catch {
    /* formato viejo o roto: se interpreta a mano */
  }
  return s
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((x) => x.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function formatList(arr) {
  return JSON.stringify(arr);
}

// Donde va nuestro paquete: despues de los integrados (vanilla, fabric, mod_resources...) y antes de
// cualquier paquete del jugador ("file/..."). En 1.12 y anteriores no hay integrados en la lista.
function insertIndex(list, legacy) {
  if (legacy) return 0;
  const firstFile = list.findIndex((x) => x.startsWith('file/'));
  return firstFile < 0 ? list.length : firstFile;
}

/**
 * Activa o desactiva el paquete.
 * opts: { id, enable, legacy, incompatible (tambien en incompatibleResourcePacks), lang }
 * Devuelve { text, changed }.
 */
function mergePack(text, { id, enable = true, legacy = false, incompatible = false, lang = null } = {}) {
  const exists = typeof text === 'string' && text.length > 0;
  if (!exists && !enable && !lang) return { text: '', changed: false };
  const doc = parse(exists ? text : '');
  const before = serialize(doc);
  const list = parseList(get(doc, 'resourcePacks'));
  const has = list.includes(id);
  if (enable && !has) {
    if (!legacy && !list.length) list.push('vanilla');
    list.splice(insertIndex(list, legacy), 0, id);
  } else if (!enable && has) {
    list.splice(list.indexOf(id), 1);
  }
  if (enable || has || get(doc, 'resourcePacks') !== undefined) set(doc, 'resourcePacks', formatList(list));
  const incList = parseList(get(doc, 'incompatibleResourcePacks'));
  if (enable && incompatible && !incList.includes(id)) {
    incList.push(id);
    set(doc, 'incompatibleResourcePacks', formatList(incList));
  } else if (!enable && incList.includes(id)) {
    incList.splice(incList.indexOf(id), 1);
    set(doc, 'incompatibleResourcePacks', formatList(incList));
  }
  if (lang) set(doc, 'lang', lang);
  const out = serialize(doc);
  return { text: out, changed: out !== before || !exists };
}

// Cambia solo el idioma del juego (crea options.txt si no existe).
function setLang(text, lang) {
  const exists = typeof text === 'string' && text.length > 0;
  const doc = parse(exists ? text : '');
  const before = exists ? serialize(doc) : '';
  set(doc, 'lang', lang);
  const out = serialize(doc);
  return { text: out, changed: out !== before };
}

// Estado del paquete y del idioma segun options.txt (null si todavia no existe el archivo).
function readState(text, id) {
  if (typeof text !== 'string') return { exists: false, enabled: false, lang: null, packs: [] };
  const doc = parse(text);
  const packs = parseList(get(doc, 'resourcePacks'));
  const lang = get(doc, 'lang');
  return { exists: true, enabled: packs.includes(id), lang: lang ? lang.trim() : null, packs };
}

module.exports = { parse, serialize, get, set, parseList, formatList, mergePack, setLang, readState, insertIndex };
