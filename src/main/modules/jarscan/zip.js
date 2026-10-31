'use strict';
// Lectura de jars/zips con adm-zip, pensada para archivos que pueden venir manipulados:
//  - nunca descomprime entradas que declaran más de `max` bytes (bombas zip)
//  - si el CRC no coincide (truco común para trabar escáneres) se descomprime igual a mano
//  - entradas cifradas o con métodos raros se saltean sin romper el análisis
const zlib = require('zlib');
const AdmZip = require('adm-zip');

const MAX_ENTRY = 48 * 1024 * 1024; // 48 MB por entrada
const MAX_ENTRIES = 200000;

class JarError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'JarError';
    this.code = code;
  }
}

// Abre un jar desde un Buffer. Devuelve { entries, names, has(name), entry(name), read(e, max), text(e, max) }.
function openJar(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new JarError('corrupt', 'empty or truncated file');
  let zip;
  try {
    zip = new AdmZip(buf);
  } catch (err) {
    throw new JarError('corrupt', err?.message || String(err));
  }
  let raw;
  try {
    raw = zip.getEntries();
  } catch (err) {
    throw new JarError('corrupt', err?.message || String(err));
  }
  if (raw.length > MAX_ENTRIES) throw new JarError('toobig', `too many entries (${raw.length})`);
  const entries = [];
  const byName = new Map();
  for (const e of raw) {
    if (e.isDirectory) continue;
    const name = String(e.entryName || '').replace(/\\/g, '/');
    if (!name) continue;
    const hdr = e.header || {};
    const item = { name, size: Number(hdr.size) || 0, csize: Number(hdr.compressedSize) || 0, method: hdr.method, encrypted: Boolean(hdr.encrypted), e };
    entries.push(item);
    if (!byName.has(name)) byName.set(name, item);
  }

  function entry(name) {
    return typeof name === 'string' ? byName.get(name) || null : name || null;
  }

  // Contenido de una entrada o null si no se puede (muy grande, cifrada, dañada).
  function read(nameOrEntry, max = MAX_ENTRY) {
    const it = entry(nameOrEntry);
    if (!it || it.encrypted) return null;
    if (it.size > max) return null;
    try {
      return it.e.getData();
    } catch {
      // CRC inválido o tamaños mentirosos: se intenta igual con los datos crudos.
      try {
        const comp = it.e.getCompressedData();
        if (it.method === 0) return comp.length <= max ? Buffer.from(comp) : null;
        if (it.method === 8) return zlib.inflateRawSync(comp, { maxOutputLength: Math.max(1, Math.min(max, MAX_ENTRY)) });
      } catch {
        /* entrada ilegible */
      }
      return null;
    }
  }

  function text(nameOrEntry, max = 4 * 1024 * 1024) {
    const data = read(nameOrEntry, max);
    if (!data) return null;
    let s = data.toString('utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  }

  return {
    entries,
    names: entries.map((e) => e.name),
    has: (name) => byName.has(name),
    entry,
    read,
    text,
  };
}

// JSON tolerante: sin BOM, comentarios // y /* */ ni comas colgantes (fabric.mod.json, configs de mixins).
function lenientJson(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    /* se limpia y se reintenta */
  }
  let out = '';
  let i = 0;
  const s = text.replace(/^﻿/, '');
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// MANIFEST.MF -> { clave: valor } (con líneas de continuación)
function parseManifest(text) {
  const out = {};
  if (!text) return out;
  let last = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith(' ') && last) {
      out[last] += line.slice(1);
      continue;
    }
    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (m) {
      last = m[1];
      out[last] = m[2];
    } else last = null;
  }
  return out;
}

// Jars anidados (jar-in-jar de Fabric/Quilt, jarjar de Forge/NeoForge y cualquier .jar adentro).
function nestedJars(jar) {
  return jar.entries.filter((e) => /\.jar$/i.test(e.name));
}

module.exports = { openJar, lenientJson, parseManifest, nestedJars, JarError, MAX_ENTRY };
