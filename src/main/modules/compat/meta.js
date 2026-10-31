'use strict';
// Metadatos de mods, plugins y packs leídos desde el propio archivo:
// fabric.mod.json, quilt.mod.json, META-INF/(neoforge.)mods.toml, mcmod.info, plugin.yml y pack.mcmeta.
// Resultado normalizado:
//   { kind, mods: [{ id, version, name, env, provides[], depends{}, breaks{}, conflicts{}, deps[] }], pack, plugin }
//   depends/breaks/conflicts: { modId: predicado } (Fabric/Quilt)   deps: [{ modId, type, range }] (Forge/NeoForge)
const { openZip, readEntry } = require('./zip');

const FILES = ['fabric.mod.json', 'quilt.mod.json', 'META-INF/neoforge.mods.toml', 'META-INF/mods.toml', 'mcmod.info', 'pack.mcmeta', 'paper-plugin.yml', 'plugin.yml'];

// ---------- JSON tolerante (comentarios, comas finales, saltos de linea dentro de textos) ----------
function lenientJson(text) {
  const src = String(text || '').replace(/^﻿/, '');
  try {
    return JSON.parse(src);
  } catch {
    /* seguir con la limpieza */
  }
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') {
        out += c + (src[i + 1] ?? '');
        i++;
      } else if (c === '"') {
        inStr = false;
        out += c;
      } else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '';
      else if (c === '\t') out += '\\t';
      else out += c;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

// ---------- TOML (subconjunto suficiente para mods.toml) ----------
function parseToml(src) {
  const root = {};
  let table = root;
  let i = 0;
  const s = String(src || '').replace(/^﻿/, '');
  const eof = () => i >= s.length;
  const fail = () => {
    throw new Error(`TOML inválido cerca de ${i}`);
  };
  const skipWs = () => {
    while (!eof() && (s[i] === ' ' || s[i] === '\t')) i++;
  };
  const skipComment = () => {
    if (s[i] === '#') while (!eof() && s[i] !== '\n') i++;
  };
  const skipWsNl = () => {
    for (;;) {
      skipWs();
      skipComment();
      if (s[i] === '\n' || s[i] === '\r') {
        i++;
        continue;
      }
      return;
    }
  };
  const esc = () => {
    i++;
    const c = s[i++];
    switch (c) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'u': {
        const hex = s.slice(i, i + 4);
        i += 4;
        return String.fromCharCode(parseInt(hex, 16) || 63);
      }
      case 'U': {
        const hex = s.slice(i, i + 8);
        i += 8;
        try {
          return String.fromCodePoint(parseInt(hex, 16));
        } catch {
          return '?';
        }
      }
      default:
        return c ?? '';
    }
  };
  const basic = () => {
    if (s.startsWith('"""', i)) {
      i += 3;
      if (s[i] === '\r') i++;
      if (s[i] === '\n') i++;
      let out = '';
      while (!eof() && !s.startsWith('"""', i)) {
        if (s[i] === '\\') {
          if (/^\\[ \t]*\r?\n/.test(s.slice(i, i + 64))) {
            i++;
            while (!eof() && /\s/.test(s[i])) i++;
          } else out += esc();
        } else out += s[i++];
      }
      i += 3;
      while (s[i] === '"') {
        out += '"';
        i++;
      }
      return out;
    }
    i++;
    let out = '';
    while (!eof() && s[i] !== '"') {
      if (s[i] === '\n') fail();
      out += s[i] === '\\' ? esc() : s[i++];
    }
    i++;
    return out;
  };
  const literal = () => {
    if (s.startsWith("'''", i)) {
      i += 3;
      if (s[i] === '\r') i++;
      if (s[i] === '\n') i++;
      const end = s.indexOf("'''", i);
      const out = s.slice(i, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end + 3;
      return out;
    }
    i++;
    const end = s.indexOf("'", i);
    if (end < 0) fail();
    const out = s.slice(i, end);
    i = end + 1;
    return out;
  };
  const key = () => {
    const parts = [];
    for (;;) {
      skipWs();
      if (s[i] === '"') parts.push(basic());
      else if (s[i] === "'") parts.push(literal());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i, i + 256));
        if (!m) fail();
        parts.push(m[0]);
        i += m[0].length;
      }
      skipWs();
      if (s[i] === '.') {
        i++;
        continue;
      }
      return parts;
    }
  };
  const setPath = (obj, parts, value) => {
    let o = obj;
    for (let k = 0; k < parts.length - 1; k++) {
      if (!o[parts[k]] || typeof o[parts[k]] !== 'object') o[parts[k]] = {};
      o = Array.isArray(o[parts[k]]) ? o[parts[k]][o[parts[k]].length - 1] : o[parts[k]];
    }
    o[parts[parts.length - 1]] = value;
  };
  const value = () => {
    skipWs();
    const c = s[i];
    if (c === '"') return basic();
    if (c === "'") return literal();
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        skipWsNl();
        if (s[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value());
        skipWsNl();
        if (s[i] === ',') {
          i++;
          continue;
        }
        skipWsNl();
        if (s[i] === ']') {
          i++;
          return arr;
        }
        fail();
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      skipWs();
      if (s[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        const k = key();
        skipWs();
        if (s[i] !== '=') fail();
        i++;
        setPath(obj, k, value());
        skipWs();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === '}') {
          i++;
          return obj;
        }
        fail();
      }
    }
    const m = /^[^\s,\]}#]+/.exec(s.slice(i, i + 128));
    if (!m) fail();
    i += m[0].length;
    if (m[0] === 'true') return true;
    if (m[0] === 'false') return false;
    const n = Number(m[0].replace(/_/g, ''));
    return Number.isNaN(n) ? m[0] : n;
  };
  try {
    for (;;) {
      skipWsNl();
      if (eof()) break;
      if (s[i] === '[') {
        const isArr = s[i + 1] === '[';
        i += isArr ? 2 : 1;
        const parts = key();
        skipWs();
        if (isArr) {
          if (!s.startsWith(']]', i)) fail();
          i += 2;
        } else {
          if (s[i] !== ']') fail();
          i++;
        }
        let o = root;
        for (let k = 0; k < parts.length - 1; k++) {
          let next = o[parts[k]];
          if (Array.isArray(next)) next = next[next.length - 1];
          if (!next || typeof next !== 'object') next = o[parts[k]] = {};
          o = next;
        }
        const last = parts[parts.length - 1];
        if (isArr) {
          if (!Array.isArray(o[last])) o[last] = [];
          const obj = {};
          o[last].push(obj);
          table = obj;
        } else {
          if (!o[last] || typeof o[last] !== 'object' || Array.isArray(o[last])) o[last] = {};
          table = o[last];
        }
        continue;
      }
      const parts = key();
      skipWs();
      if (s[i] !== '=') fail();
      i++;
      setPath(table, parts, value());
      skipWs();
      skipComment();
    }
  } catch {
    /* devolver lo que se pudo leer */
  }
  return root;
}

// ---------- Normalizadores ----------
const str = (v) => (v === undefined || v === null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

function fabricDeps(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [id, pred] of Object.entries(obj)) out[String(id).toLowerCase()] = pred;
  return out;
}

function parseFabric(text) {
  const j = lenientJson(text);
  if (!j || !j.id) return null;
  return {
    kind: 'fabric',
    mods: [
      {
        id: String(j.id).toLowerCase(),
        version: str(j.version),
        name: str(j.name || j.id),
        env: j.environment === 'client' || j.environment === 'server' ? j.environment : '*',
        provides: arr(j.provides).map((p) => String(p).toLowerCase()),
        depends: fabricDeps(j.depends),
        breaks: fabricDeps(j.breaks),
        conflicts: fabricDeps(j.conflicts),
        deps: [],
      },
    ],
  };
}

function quiltDeps(list, { onlyRequired = false } = {}) {
  const out = {};
  for (const d of arr(list)) {
    if (typeof d === 'string') {
      out[d.split(':').pop().toLowerCase()] = '*';
      continue;
    }
    if (!d || typeof d !== 'object') continue;
    if (Array.isArray(d.any)) continue; // alternativas: no se puede afirmar nada
    if (!d.id || (onlyRequired && d.optional)) continue;
    out[String(d.id).split(':').pop().toLowerCase()] = d.versions ?? '*';
  }
  return out;
}

function parseQuilt(text) {
  const j = lenientJson(text);
  const ql = j?.quilt_loader;
  if (!ql?.id) return null;
  const env = j.minecraft?.environment;
  return {
    kind: 'quilt',
    mods: [
      {
        id: String(ql.id).toLowerCase(),
        version: str(ql.version),
        name: str(ql.metadata?.name || ql.id),
        env: env === 'client' ? 'client' : env === 'dedicated_server' ? 'server' : '*',
        provides: arr(ql.provides).map((p) => String(typeof p === 'string' ? p : p?.id || '').split(':').pop().toLowerCase()).filter(Boolean),
        depends: quiltDeps(ql.depends, { onlyRequired: true }),
        breaks: quiltDeps(ql.breaks),
        conflicts: {},
        deps: [],
      },
    ],
  };
}

function manifestVersion(text) {
  const m = /^Implementation-Version:\s*(.+)$/im.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

function parseModsToml(text, kind, manifest) {
  const doc = parseToml(text);
  const mods = arr(doc.mods).filter((m) => m && m.modId);
  if (!mods.length) return null;
  const implVersion = manifestVersion(manifest);
  const resolveVer = (v) => {
    const s = str(v);
    if (s === '${file.jarVersion}') return implVersion;
    return s.includes('${') ? '' : s;
  };
  const depsOf = (modId) =>
    arr(doc.dependencies?.[modId])
      .filter((d) => d && d.modId)
      .map((d) => {
        let type = str(d.type).toLowerCase();
        if (!type) type = d.mandatory === false ? 'optional' : 'required';
        return { modId: String(d.modId).toLowerCase(), type, range: str(d.versionRange), side: str(d.side || 'BOTH').toUpperCase() };
      });
  return {
    kind,
    mods: mods.map((m) => ({
      id: String(m.modId).toLowerCase(),
      version: resolveVer(m.version),
      name: str(m.displayName || m.modId),
      env: '*',
      provides: [],
      depends: {},
      breaks: {},
      conflicts: {},
      deps: depsOf(m.modId),
    })),
  };
}

function parseMcmod(text) {
  let j = lenientJson(text);
  if (j && !Array.isArray(j)) j = j.modList || j.modlist || [];
  const mods = arr(j).filter((m) => m && m.modid);
  if (!mods.length) return null;
  return {
    kind: 'legacyforge',
    mods: mods.map((m) => ({ id: String(m.modid).toLowerCase(), version: str(m.version), name: str(m.name || m.modid), env: '*', provides: [], depends: {}, breaks: {}, conflicts: {}, deps: [] })),
  };
}

// pack.mcmeta: formato del pack y rango soportado (1.20.2+: supported_formats; 1.21.9+: min_format/max_format)
function parsePack(text) {
  const j = lenientJson(text);
  const p = j?.pack;
  if (!p) return null;
  const major = (v) => (Array.isArray(v) ? Number(v[0]) : Number(v));
  let min = null;
  let max = null;
  const sf = p.supported_formats;
  if (Array.isArray(sf) && sf.length >= 2) [min, max] = [Number(sf[0]), Number(sf[1])];
  else if (typeof sf === 'number') min = max = sf;
  else if (sf && typeof sf === 'object') [min, max] = [Number(sf.min_inclusive), Number(sf.max_inclusive)];
  if (p.min_format !== undefined) min = major(p.min_format);
  if (p.max_format !== undefined) max = major(p.max_format);
  if (Number.isFinite(min) && Number.isFinite(max) && min > max) [min, max] = [max, min];
  const format = p.pack_format !== undefined ? Number(p.pack_format) : min;
  return { format: Number.isFinite(format) ? format : null, min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null };
}

function parsePluginYml(text) {
  const t = String(text || '');
  const name = /^name:\s*["']?([^"'\r\n#]+?)["']?\s*$/m.exec(t)?.[1]?.trim();
  if (!name) return null;
  const version = /^version:\s*["']?([^"'\r\n#]+?)["']?\s*$/m.exec(t)?.[1]?.trim() || '';
  return { name, version };
}

// Lee los metadatos de una fuente (zip.fileSource / urlSource / bufferSource).
async function readMeta(src) {
  const zip = await openZip(src);
  const has = (n) => zip.entries.has(n);
  const text = async (n) => {
    const b = await readEntry(zip, n, { maxSize: 2 * 1024 * 1024 });
    return b ? b.toString('utf8') : '';
  };
  const out = { kind: 'unknown', mods: [], pack: null, plugin: null };
  const tryParse = async (n, fn) => {
    if (!has(n)) return null;
    try {
      return fn(await text(n));
    } catch {
      return null;
    }
  };
  let parsed = (await tryParse('fabric.mod.json', parseFabric)) || (await tryParse('quilt.mod.json', parseQuilt));
  if (!parsed) {
    for (const [file, kind] of [
      ['META-INF/neoforge.mods.toml', 'neoforge'],
      ['META-INF/mods.toml', 'forge'],
    ]) {
      if (!has(file)) continue;
      let manifest = '';
      try {
        const toml = await text(file);
        if (toml.includes('${file.jarVersion}') && has('META-INF/MANIFEST.MF')) manifest = await text('META-INF/MANIFEST.MF');
        parsed = parseModsToml(toml, kind, manifest);
      } catch {
        parsed = null;
      }
      if (parsed) break;
    }
  }
  if (!parsed) parsed = await tryParse('mcmod.info', parseMcmod);
  if (parsed) Object.assign(out, parsed);
  out.pack = await tryParse('pack.mcmeta', parsePack);
  out.plugin = (await tryParse('paper-plugin.yml', parsePluginYml)) || (await tryParse('plugin.yml', parsePluginYml));
  if (out.kind === 'unknown') out.kind = out.plugin ? 'plugin' : out.pack ? 'pack' : 'unknown';
  return out;
}

module.exports = { FILES, readMeta, parseToml, lenientJson, parseFabric, parseQuilt, parseModsToml, parsePack, parsePluginYml };
