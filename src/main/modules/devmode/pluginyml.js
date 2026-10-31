'use strict';
// Descriptor del plugin (plugin.yml o paper-plugin.yml) leído de un .jar o de src/main/resources.
// Incluye un lector de zip que solo lee las entradas pedidas (sin cargar el jar entero en memoria)
// y un analizador YAML mínimo pensado para estos archivos: claves de primer nivel, listas en bloque
// o [a, b], textos multilínea y los nombres de los comandos. Node puro: se puede probar sin Electron.
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

// paper-plugin.yml tiene prioridad: si un jar trae los dos, Paper lo carga como "plugin de Paper".
const DESCRIPTORS = ['paper-plugin.yml', 'plugin.yml'];
// Otros descriptores conocidos: sirven para avisar "esto es un mod o un plugin de proxy".
const OTHER_KINDS = [
  ['velocity-plugin.json', 'velocity'],
  ['bungee.yml', 'bungee'],
  ['fabric.mod.json', 'fabric'],
  ['quilt.mod.json', 'quilt'],
  ['META-INF/neoforge.mods.toml', 'neoforge'],
  ['META-INF/mods.toml', 'forge'],
];
const MAX_ENTRY = 4 * 1024 * 1024;

// ---------- Zip ----------

function badZip() {
  return Object.assign(new Error('badZip'), { code: 'badZip' });
}

// Lee solo las entradas pedidas de un zip/jar. Devuelve { found: Set(nombres presentes), data: { nombre: Buffer } }.
async function readZipEntries(file, wanted, { read = [] } = {}) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw badZip();
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw badZip();
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    // ZIP64 (jars con mas de 65535 entradas)
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const z64Offset = Number(tail.readBigUInt64LE(loc + 8));
        const z64 = Buffer.alloc(56);
        await fh.read(z64, 0, 56, z64Offset);
        if (z64.readUInt32LE(0) !== 0x06064b50) throw badZip();
        count = Number(z64.readBigUInt64LE(32));
        cdSize = Number(z64.readBigUInt64LE(40));
        cdOffset = Number(z64.readBigUInt64LE(48));
      }
    }
    if (cdOffset + cdSize > size || cdSize > 256 * 1024 * 1024) throw badZip();
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const want = new Set(wanted);
    const toRead = new Set(read);
    const found = new Set();
    const entries = new Map();
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (want.has(name)) {
        found.add(name);
        if (toRead.has(name)) entries.set(name, { method, compSize, uncompSize, localOffset });
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    const data = {};
    for (const [name, e] of entries) {
      if (e.uncompSize > MAX_ENTRY || e.compSize > MAX_ENTRY) continue;
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, e.localOffset);
      if (lh.readUInt32LE(0) !== 0x04034b50) continue;
      const start = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const comp = Buffer.alloc(e.compSize);
      await fh.read(comp, 0, e.compSize, start);
      if (e.method === 0) data[name] = comp;
      else if (e.method === 8) data[name] = zlib.inflateRawSync(comp, { maxOutputLength: MAX_ENTRY });
    }
    return { found, data };
  } finally {
    await fh.close().catch(() => {});
  }
}

// Respaldo con adm-zip (por si el jar tiene algo que el lector simple no entiende).
function readZipEntriesAdm(file, wanted, { read = [] } = {}) {
  const AdmZip = require('adm-zip');
  let zip;
  try {
    zip = new AdmZip(file);
  } catch {
    throw badZip();
  }
  const found = new Set();
  const data = {};
  for (const name of wanted) {
    const e = zip.getEntry(name);
    if (!e || e.isDirectory) continue;
    found.add(name);
    if (read.includes(name)) data[name] = e.getData();
  }
  return { found, data };
}

// ---------- YAML minimo ----------

const OPENERS = new Set([' ', '\t', '[', ',', '{']);

// Quita un comentario " # ..." que no este dentro de comillas.
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) {
        if (quote === "'" && line[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || OPENERS.has(line[i - 1]))) {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) return line.slice(0, i).replace(/\s+$/, '');
  }
  return line.replace(/\s+$/, '');
}

function unquote(v) {
  const s = String(v ?? '').trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, c) => {
      if (c.length === 5 && c[0] === 'u') return String.fromCharCode(parseInt(c.slice(1), 16));
      return { n: '\n', t: '\t', r: '\r', 0: '\0' }[c] ?? c;
    });
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s.replace(/^!!\w+\s+/, '');
}

function splitFlow(inner) {
  const out = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  for (const c of inner) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => unquote(x)).filter((x) => x !== '');
}

function parseValue(raw) {
  const v = String(raw).trim();
  if (v.startsWith('[') && v.endsWith(']')) return splitFlow(v.slice(1, -1));
  if (v === '~' || v === 'null') return null;
  return unquote(v);
}

const indentOf = (line) => line.match(/^[ \t]*/)[0].length;
const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#'"-][^:]*?|-[^\s:][^:]*?)\s*:(?:[ \t]+(.*))?$/;
const CHILD_KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#\s][^:]*?)\s*:(?:[ \t]|$)/;

// Devuelve { values: { clave: texto | lista | {} }, children: { clave: [nombres de hijos] }, raw: { clave: texto original } }
function parseYaml(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const values = {};
  const children = {};
  const raw = {};
  let i = 0;
  while (i < lines.length) {
    const line = stripComment(lines[i]);
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---' || trimmed === '...' || /^[ \t]/.test(line) || /^-([ \t]|$)/.test(line)) {
      i++;
      continue;
    }
    const m = line.match(KEY_RE);
    if (!m) {
      i++;
      continue;
    }
    const key = unquote(m[1]);
    const rest = (m[2] ?? '').trim();
    i++;
    if (/^[|>][+-]?\d*$/.test(rest)) {
      // Texto multilinea (| conserva saltos, > los pliega)
      const block = [];
      while (i < lines.length && (!lines[i].trim() || /^[ \t]/.test(lines[i]))) block.push(lines[i++]);
      const content = block.filter((l) => l.trim());
      const ind = content.length ? Math.min(...content.map(indentOf)) : 0;
      const body = block.map((l) => (l.trim() ? l.slice(ind) : ''));
      while (body.length && !body[body.length - 1]) body.pop();
      values[key] = rest[0] === '|' ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?!\n)/g, '$1 ').trim();
      raw[key] = values[key];
      continue;
    }
    if (rest !== '') {
      // Valor en la misma linea; un texto sin comillas puede seguir en lineas mas indentadas.
      let value = rest;
      if (!/^["'[{]/.test(value)) {
        while (i < lines.length && /^[ \t]+\S/.test(lines[i])) {
          const next = stripComment(lines[i]).trim();
          if (!next || /^-([ \t]|$)/.test(next) || CHILD_KEY_RE.test(next)) break;
          value += ` ${next}`;
          i++;
        }
      }
      raw[key] = value;
      values[key] = parseValue(value);
      continue;
    }
    // Bloque: lista o mapa anidado (commands, permissions, dependencies...)
    const block = [];
    while (i < lines.length && (!lines[i].trim() || /^[ \t]/.test(lines[i]) || /^-([ \t]|$)/.test(lines[i]))) block.push(stripComment(lines[i++]));
    const content = block.filter((l) => l.trim());
    if (!content.length) {
      values[key] = null;
      continue;
    }
    const ind = Math.min(...content.map(indentOf));
    const top = content.filter((l) => indentOf(l) === ind);
    if (/^-([ \t]|$)/.test(top[0].trim())) {
      values[key] = top
        .filter((l) => /^[ \t]*-([ \t]|$)/.test(l))
        .map((l) => parseValue(l.trim().replace(/^-[ \t]*/, '')))
        .filter((v) => v !== null && v !== '');
    } else {
      const names = [];
      for (const l of top) {
        const km = l.trim().match(CHILD_KEY_RE);
        if (km) names.push(unquote(km[1]));
      }
      values[key] = {};
      children[key] = names;
    }
  }
  return { values, children, raw };
}

// ---------- Descriptor ----------

const TEMPLATE = /\$\{[^}]*\}|@[\w.-]+@/;
// true si el valor todavia tiene variables del build (${version}, @version@): datos de las fuentes sin procesar.
const isTemplated = (v) => typeof v === 'string' && TEMPLATE.test(v);
const str =(v) => (v === null || v === undefined || typeof v === 'object' ? null : String(v).trim() || null);
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []).map((x) => String(x).trim()).filter(Boolean);

function describe(parsed, descriptor) {
  const { values: v, children, raw } = parsed;
  const info = {
    kind: 'plugin',
    descriptor,
    paper: descriptor === 'paper-plugin.yml',
    name: str(v.name),
    version: str(v.version),
    main: str(v.main),
    apiVersion: str(v['api-version']),
    description: str(v.description),
    authors: [...new Set([...list(v.author), ...list(v.authors)])].slice(0, 12),
    website: str(v.website),
    load: str(v.load),
    depend: list(v.depend).slice(0, 30),
    softdepend: list(v.softdepend).slice(0, 30),
    commands: (children.commands || []).slice(0, 60),
    foliaSupported: String(v['folia-supported'] ?? '').trim().toLowerCase() === 'true',
    bootstrapper: str(v.bootstrapper),
    templated: [v.name, v.version, v.main, v['api-version']].some((x) => typeof x === 'string' && TEMPLATE.test(x)),
    warnings: [],
  };
  if (!info.name) info.warnings.push('noName');
  if (!info.main) info.warnings.push('noMain');
  // "api-version: 1.20" sin comillas: SnakeYAML lo lee como el numero 1.2 y Paper rechaza el plugin.
  const rawApi = String(raw['api-version'] ?? '').trim();
  if (/^\d+\.\d*0$/.test(rawApi)) info.warnings.push('apiVersionUnquoted');
  return info;
}

function parseDescriptor(text, descriptor = 'plugin.yml') {
  return describe(parseYaml(text), descriptor);
}

// Lee el descriptor de un jar: { kind: 'plugin', ...info } | { kind: 'velocity'|'fabric'|..., descriptor } | { kind: null }
async function readJar(jarPath) {
  const wanted = [...DESCRIPTORS, ...OTHER_KINDS.map(([n]) => n)];
  let res;
  try {
    res = await readZipEntries(jarPath, wanted, { read: DESCRIPTORS });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EBUSY') throw err;
    res = readZipEntriesAdm(jarPath, wanted, { read: DESCRIPTORS });
  }
  for (const name of DESCRIPTORS) {
    if (res.data[name]) return parseDescriptor(res.data[name].toString('utf8'), name);
  }
  for (const [name, kind] of OTHER_KINDS) if (res.found.has(name)) return { kind, descriptor: name };
  return { kind: null, descriptor: null };
}

// Descriptor de las fuentes (antes del primer build). bases: carpetas de modulos a revisar.
async function readSources(bases) {
  for (const base of bases) {
    for (const name of DESCRIPTORS) {
      const file = path.join(base, 'src', 'main', 'resources', name);
      let text;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch {
        continue;
      }
      return { ...parseDescriptor(text, name), source: file };
    }
  }
  return null;
}

module.exports = { DESCRIPTORS, readJar, readSources, parseYaml, parseDescriptor, readZipEntries, isTemplated };
