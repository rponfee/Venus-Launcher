'use strict';
// options.txt de una instancia: lectura y cambio de UNA opcion de la lista blanca, conservando el resto
// del archivo (controles, idioma, servidores...) tal cual estaba. Escritura atomica.
const fsp = require('fs/promises');
const path = require('path');
const { t } = require('../../core/i18n');
const { ToolError, insideDir } = require('./guards');

// ---------- Versiones de Minecraft ----------
// "1.20.1" -> [1, 20, 1]; "26.1" -> [26, 1]; snapshots y otros -> null (no se pueden comparar).
function parseMc(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function mcAtLeast(version, min) {
  const a = parseMc(version);
  const b = parseMc(min);
  if (!a || !b) return true; // snapshot o version rara: no bloquear
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// ---------- Lectura ----------
function parse(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return {
    eol,
    entries: lines.map((raw) => {
      const i = raw.indexOf(':');
      return i > 0 ? { raw, key: raw.slice(0, i), value: raw.slice(i + 1) } : { raw };
    }),
  };
}

function optionsPath(instanceDir) {
  return insideDir(instanceDir, 'options.txt');
}

async function read(instanceDir) {
  const text = await fsp.readFile(optionsPath(instanceDir), 'utf8').catch(() => null);
  if (text === null) return { exists: false, eol: process.platform === 'win32' ? '\r\n' : '\n', entries: [], text: null };
  return { exists: true, text, ...parse(text) };
}

function rawOf(doc, key) {
  const e = doc.entries.find((x) => x.key === key);
  return e ? e.value : null;
}

const unquote = (v) => {
  const s = String(v ?? '').trim();
  return /^".*"$/.test(s) ? s.slice(1, -1) : s;
};

// Valor legible de una opcion (para el modelo y los resumenes).
function display(key, def, raw, legacyRaw = null) {
  if (raw === null || raw === undefined) {
    if (key === 'graphicsMode' && legacyRaw !== null) return unquote(legacyRaw) === 'true' ? 'fancy' : 'fast';
    return null;
  }
  const v = unquote(raw);
  switch (def.type) {
    case 'enumInt': {
      const name = Object.entries(def.values).find(([, n]) => String(n) === v);
      return name ? name[0] : v;
    }
    case 'fov': {
      const f = Number(v);
      return Number.isFinite(f) ? String(Math.round(70 + f * 40)) : v;
    }
    case 'bool':
      if (/^\d$/.test(v)) return v !== '0' ? 'true' : 'false';
      return v;
    default:
      return v;
  }
}

// Valores actuales de todas las opciones de la lista blanca.
async function current(instanceDir, keys) {
  const doc = await read(instanceDir);
  const out = {};
  for (const [key, def] of Object.entries(keys)) {
    const v = display(key, def, rawOf(doc, key), def.legacy ? rawOf(doc, def.legacy) : null);
    if (v !== null) out[key] = v;
  }
  return { exists: doc.exists, values: out };
}

// ---------- Conversion del valor pedido al formato de options.txt ----------
function boolOf(input) {
  const s = String(input).trim().toLowerCase();
  if (['true', 'on', 'yes', '1', 'si', 'sí'].includes(s)) return true;
  if (['false', 'off', 'no', '0'].includes(s)) return false;
  return null;
}

function numberOf(input) {
  const s = String(input).trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

function rangeError(key, def) {
  return new ToolError(t('assistant.errOptionRange', { key, min: def.min, max: def.max }), 'option');
}

// Devuelve { raw, fileKey, display } o lanza ToolError.
function format(key, def, input, { mcVersion, existingRaw = null, legacyExists = false } = {}) {
  const bad = () => new ToolError(t('assistant.errOptionValue', { key, value: String(input).slice(0, 40) }), 'option');
  switch (def.type) {
    case 'int': {
      const n = numberOf(input);
      if (n === null || !Number.isInteger(n)) throw bad();
      if (n < def.min || n > def.max) throw rangeError(key, def);
      return { raw: String(n), fileKey: key, display: String(n) };
    }
    case 'float': {
      const n = numberOf(input);
      if (n === null) throw bad();
      if (n < def.min || n > def.max) throw rangeError(key, def);
      const raw = Number.isInteger(n) ? n.toFixed(1) : String(Math.round(n * 1000) / 1000);
      return { raw, fileKey: key, display: raw };
    }
    case 'fov': {
      const n = numberOf(input);
      if (n === null) throw bad();
      if (n < def.min || n > def.max) throw rangeError(key, def);
      const internal = Math.round(((n - 70) / 40) * 1000) / 1000;
      return { raw: Number.isInteger(internal) ? internal.toFixed(1) : String(internal), fileKey: key, display: String(Math.round(n)) };
    }
    case 'bool': {
      const b = boolOf(input);
      if (b === null) throw bad();
      const numeric = existingRaw !== null ? /^\d$/.test(String(existingRaw).trim()) : def.numericBefore ? !mcAtLeast(mcVersion, def.numericBefore) : false;
      return { raw: numeric ? (b ? '2' : '0') : b ? 'true' : 'false', fileKey: key, display: b ? 'true' : 'false' };
    }
    case 'enumInt': {
      const s = String(input).trim().toLowerCase();
      let n = Object.prototype.hasOwnProperty.call(def.values, s) ? def.values[s] : null;
      if (n === null && /^\d+$/.test(s) && Object.values(def.values).includes(Number(s))) n = Number(s);
      if (n === null) throw bad();
      const name = Object.entries(def.values).find(([, v]) => v === n)[0];
      // Versiones viejas: graphicsMode -> fancyGraphics:true/false
      if (def.legacy && (legacyExists || (def.since && !mcAtLeast(mcVersion, def.since))) && existingRaw === null) {
        return { raw: n >= 1 ? 'true' : 'false', fileKey: def.legacy, display: name };
      }
      return { raw: String(n), fileKey: key, display: name };
    }
    case 'enum': {
      let s = String(input).trim().toLowerCase();
      if (def.aliases && def.aliases[s]) s = def.aliases[s];
      const v = def.values.find((x) => x.toLowerCase() === s);
      if (!v) throw bad();
      const quoted = existingRaw !== null ? /^".*"$/.test(String(existingRaw).trim()) : def.quotedSince ? mcAtLeast(mcVersion, def.quotedSince) : false;
      return { raw: quoted ? `"${v}"` : v, fileKey: key, display: v };
    }
    default:
      throw bad();
  }
}

// ---------- Escritura ----------
async function writeDoc(instanceDir, doc) {
  const file = optionsPath(instanceDir);
  const out = doc.entries.length ? doc.entries.map((e) => e.raw).join(doc.eol) + doc.eol : '';
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, out, 'utf8');
  await fsp.rename(tmp, file);
}

// Cambia una clave del archivo. raw === null la borra. Devuelve el valor crudo anterior (o null).
async function setRaw(instanceDir, fileKey, raw) {
  const doc = await read(instanceDir);
  const idx = doc.entries.findIndex((e) => e.key === fileKey);
  const prev = idx >= 0 ? doc.entries[idx].value : null;
  if (raw === null) {
    if (idx < 0) return { prev, existed: doc.exists };
    doc.entries.splice(idx, 1);
  } else if (idx >= 0) {
    doc.entries[idx] = { key: fileKey, value: raw, raw: `${fileKey}:${raw}` };
  } else {
    doc.entries.push({ key: fileKey, value: raw, raw: `${fileKey}:${raw}` });
  }
  await fsp.mkdir(instanceDir, { recursive: true });
  await writeDoc(instanceDir, doc);
  return { prev, existed: doc.exists };
}

async function removeIfEmpty(instanceDir) {
  const doc = await read(instanceDir);
  if (doc.exists && !doc.entries.some((e) => e.raw && e.raw.trim())) await fsp.rm(optionsPath(instanceDir), { force: true });
}

module.exports = { parseMc, mcAtLeast, read, rawOf, current, display, format, setRaw, removeIfEmpty, parse };
