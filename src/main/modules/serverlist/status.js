'use strict';
// Interpreta la respuesta de estado de un servidor: MOTD (componente de chat -> codigos §),
// jugadores, version, favicon y la lista de mods que publican Forge / NeoForge.
const versions = require('./versions');

// ---------- Componentes de chat -> texto con codigos de seccion ----------

const COLOR_CODES = {
  black: '0',
  dark_blue: '1',
  dark_green: '2',
  dark_aqua: '3',
  dark_red: '4',
  dark_purple: '5',
  gold: '6',
  gray: '7',
  dark_gray: '8',
  blue: '9',
  green: 'a',
  aqua: 'b',
  red: 'c',
  light_purple: 'd',
  yellow: 'e',
  white: 'f',
};
const FORMATS = [
  ['obfuscated', 'k'],
  ['bold', 'l'],
  ['strikethrough', 'm'],
  ['underlined', 'n'],
  ['italic', 'o'],
];

function colorCode(color) {
  if (!color || typeof color !== 'string') return null;
  const c = color.toLowerCase();
  if (COLOR_CODES[c]) return `§${COLOR_CODES[c]}`;
  const hex = c.match(/^#([0-9a-f]{6})$/);
  if (hex) return `§x${[...hex[1]].map((ch) => `§${ch}`).join('')}`;
  return null;
}

// Recorre el arbol y devuelve segmentos { text, style } con el estilo heredado ya resuelto.
function flatten(comp, inherited, out, depth = 0) {
  if (comp === null || comp === undefined || depth > 24) return out;
  if (typeof comp === 'string' || typeof comp === 'number' || typeof comp === 'boolean') {
    out.push({ text: String(comp), style: inherited });
    return out;
  }
  if (Array.isArray(comp)) {
    // En un arreglo, el primer elemento es el padre de los demas
    if (!comp.length) return out;
    const [first, ...rest] = comp;
    return flatten(typeof first === 'object' && first !== null && !Array.isArray(first) ? { ...first, extra: [...(first.extra || []), ...rest] } : { text: first, extra: rest }, inherited, out, depth + 1);
  }
  if (typeof comp !== 'object') return out;
  const style = { ...inherited };
  if (comp.color !== undefined) style.color = comp.color === 'reset' ? null : comp.color;
  for (const [key] of FORMATS) if (typeof comp[key] === 'boolean') style[key] = comp[key];
  let text = '';
  if (typeof comp.text === 'string' || typeof comp.text === 'number') text = String(comp.text);
  else if (typeof comp.translate === 'string') text = typeof comp.fallback === 'string' ? comp.fallback : comp.translate;
  else if (typeof comp.keybind === 'string') text = comp.keybind;
  else if (typeof comp.selector === 'string') text = comp.selector;
  else if (comp.score && typeof comp.score === 'object') text = String(comp.score.value ?? '');
  if (text) out.push({ text, style });
  if (Array.isArray(comp.with) && typeof comp.translate === 'string' && typeof comp.fallback !== 'string') {
    // traducciones con argumentos: se muestran los argumentos a continuacion
    for (const w of comp.with) flatten(w, style, out, depth + 1);
  }
  if (Array.isArray(comp.extra)) for (const e of comp.extra) flatten(e, style, out, depth + 1);
  return out;
}

// Componente (o texto) -> texto con codigos § (los colores hex quedan como §x§r§r§g§g§b§b)
function chatToLegacy(comp) {
  if (typeof comp === 'string') return comp;
  const segments = flatten(comp, { color: null }, []);
  let out = '';
  let cur = { color: null };
  for (const seg of segments) {
    if (!seg.text) continue;
    const st = seg.style;
    const color = colorCode(st.color);
    const needReset = color !== colorCode(cur.color) || FORMATS.some(([k]) => cur[k] && !st[k]);
    if (needReset) {
      out += color || '§r';
      for (const [k, code] of FORMATS) if (st[k]) out += `§${code}`;
    } else {
      for (const [k, code] of FORMATS) if (st[k] && !cur[k]) out += `§${code}`;
    }
    cur = st;
    out += seg.text;
  }
  // si el texto empieza con un reset innecesario, se quita
  return out.replace(/^§r/, '');
}

function stripCodes(s) {
  return String(s || '').replace(/§[0-9a-fk-orx]/gi, '').replace(/§/g, '');
}

// ---------- Mods de Forge / NeoForge ----------

const BUILTIN_MODS = new Set(['minecraft', 'forge', 'neoforge', 'fml', 'mcp', 'javafml', 'lowcodefml', 'fabricloader', 'java']);
const isServerOnlyMarker = (v) => typeof v === 'string' && v.startsWith('OHNOES');

function readVarInt(buf, pos) {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    if (pos >= buf.length) throw new Error('varint');
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [value, pos];
    shift += 7;
  }
  throw new Error('varint');
}

function readUtf(buf, pos) {
  const [len, p] = readVarInt(buf, pos);
  if (len < 0 || p + len > buf.length) throw new Error('utf');
  return [buf.toString('utf8', p, p + len), p + len];
}

// Forge 1.19+ comprime la lista en "d": cada caracter lleva 15 bits.
function decodeOptimized(s) {
  if (typeof s !== 'string' || s.length < 2) throw new Error('d');
  const size = s.charCodeAt(0) | (s.charCodeAt(1) << 15);
  if (size > 8 * 1024 * 1024) throw new Error('d');
  const out = Buffer.alloc(size);
  let pos = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 2; i < s.length; i++) {
    while (bits >= 8) {
      if (pos < size) out[pos++] = buffer & 0xff;
      buffer >>>= 8;
      bits -= 8;
    }
    buffer |= (s.charCodeAt(i) & 0x7fff) << bits;
    bits += 15;
  }
  while (pos < size && bits > 0) {
    out[pos++] = buffer & 0xff;
    buffer >>>= 8;
    bits -= 8;
  }
  return out;
}

function parseOptimized(d) {
  const buf = decodeOptimized(d);
  let pos = 0;
  const truncated = buf[pos++] !== 0;
  const count = buf.readUInt16BE(pos);
  pos += 2;
  const mods = [];
  for (let i = 0; i < count; i++) {
    let flag;
    [flag, pos] = readVarInt(buf, pos);
    const channels = flag >>> 1;
    const serverOnly = (flag & 1) !== 0;
    let id;
    [id, pos] = readUtf(buf, pos);
    let version = null;
    if (!serverOnly) [version, pos] = readUtf(buf, pos);
    for (let c = 0; c < channels; c++) {
      [, pos] = readUtf(buf, pos);
      [, pos] = readUtf(buf, pos);
      pos += 1;
    }
    mods.push({ id, version, serverOnly });
  }
  return { truncated, mods };
}

// Devuelve { loader, loaderVersion, mods: [{ id, version }], serverOnly, truncated, modded, guessed }
function detectMods(data, versionName) {
  const result = { loader: null, loaderVersion: null, minecraft: null, mods: [], serverOnly: 0, truncated: false, modded: false, guessed: false };
  let raw = [];
  const fd = data.forgeData && typeof data.forgeData === 'object' ? data.forgeData : null;
  if (fd) {
    result.truncated = Boolean(fd.truncated);
    if (typeof fd.d === 'string' && fd.d.length) {
      try {
        const parsed = parseOptimized(fd.d);
        raw = parsed.mods;
        result.truncated = result.truncated || parsed.truncated;
      } catch {
        raw = [];
      }
    } else if (Array.isArray(fd.mods)) {
      raw = fd.mods.filter((m) => m && typeof m === 'object').map((m) => ({ id: String(m.modId || m.modid || ''), version: m.modmarker ?? m.version ?? null, serverOnly: isServerOnlyMarker(m.modmarker) }));
    }
  } else if (data.modinfo && typeof data.modinfo === 'object' && Array.isArray(data.modinfo.modList)) {
    // FML 1.7 - 1.12
    raw = data.modinfo.modList.filter((m) => m && typeof m === 'object').map((m) => ({ id: String(m.modid || m.modId || ''), version: m.version ?? null, serverOnly: false }));
  }
  // Muchas redes (CubeCraft, Pika...) mandan un "modinfo" FML vacio solo para aceptar clientes Forge:
  // sin mods en la lista no es un servidor con mods.
  if (raw.some((m) => m.id)) {
    result.modded = true;
    result.loader = 'forge';
  } else if (data.isModded === true) {
    // NeoForge 1.20.2+: avisa que tiene mods pero no publica la lista
    result.modded = true;
    result.loader = 'neoforge';
  }
  // "ANY" o vacio = el mod acepta cualquier version (no sirve para elegir una)
  const realVersion = (v) => (typeof v === 'string' && v.trim() && !/^any$/i.test(v.trim()) ? v.trim().slice(0, 80) : null);
  const loaderVersion = (v) => (typeof v === 'string' && /^\d+\.\d+/.test(v.trim()) ? v.trim() : null);
  for (const m of raw || []) {
    if (!m.id) continue;
    const low = m.id.toLowerCase();
    if (low === 'neoforge') {
      result.loader = 'neoforge';
      result.loaderVersion = loaderVersion(m.version);
      continue;
    }
    if (low === 'forge') {
      if (result.loader === 'forge') result.loaderVersion = loaderVersion(m.version);
      continue;
    }
    if (low === 'minecraft' && typeof m.version === 'string' && /^\d+\.\d+(\.\d+)?$/.test(m.version.trim())) {
      result.minecraft = m.version.trim(); // version exacta del juego (la publica Forge)
      continue;
    }
    if (BUILTIN_MODS.has(low)) continue;
    if (m.serverOnly || isServerOnlyMarker(m.version)) {
      result.serverOnly++;
      continue;
    }
    result.mods.push({ id: m.id, version: realVersion(m.version) });
  }
  if (!result.loader) {
    // Pista debil: algunos servidores lo dicen en el nombre de la version
    const name = String(versionName || '');
    if (/\bneoforge\b/i.test(name)) result.loader = 'neoforge';
    else if (/\bforge\b/i.test(name)) result.loader = 'forge';
    else if (/\bquilt\b/i.test(name)) result.loader = 'quilt';
    else if (/\bfabric\b/i.test(name)) result.loader = 'fabric';
    if (result.loader) result.guessed = true;
  }
  result.mods.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

// ---------- Respuesta completa ----------

function cleanFavicon(f) {
  if (typeof f !== 'string') return null;
  const s = f.replace(/\s+/g, '');
  if (s.length > 300000 || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(s)) return null;
  return s;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

// JSON de estado (protocolo moderno) -> datos normalizados
function parseModern(json) {
  const data = typeof json === 'string' ? JSON.parse(json.replace(/^﻿/, '')) : json;
  if (!data || typeof data !== 'object') throw Object.assign(new Error('status'), { code: 'MC_PROTOCOL' });
  const motd = chatToLegacy(data.description ?? '');
  const players = data.players && typeof data.players === 'object' ? data.players : {};
  const sample = Array.isArray(players.sample)
    ? players.sample
        .filter((p) => p && typeof p === 'object')
        .slice(0, 24)
        .map((p) => ({ name: String(p.name ?? '').slice(0, 120), id: String(p.id ?? '').slice(0, 40) }))
    : [];
  const versionRaw = String(data.version?.name ?? '').slice(0, 200);
  const version = stripCodes(versionRaw).trim();
  const protocol = Number.isInteger(data.version?.protocol) ? data.version.protocol : null;
  const mods = detectMods(data, version);
  const ver = versions.resolve({ name: version, protocol });
  return {
    motd,
    motdText: stripCodes(motd),
    players: { online: num(players.online), max: num(players.max), sample },
    version,
    versionRaw,
    protocol,
    mcVersion: mods.minecraft || ver.mcVersion,
    versionRange: ver.range,
    versionExact: Boolean(mods.minecraft) || ver.exact,
    versionPlaceholder: !mods.minecraft && ver.placeholder,
    favicon: cleanFavicon(data.favicon),
    loader: mods.loader,
    loaderVersion: mods.loaderVersion,
    loaderGuessed: mods.guessed,
    modded: mods.modded,
    mods: mods.mods,
    modsTruncated: mods.truncated,
    serverOnlyMods: mods.serverOnly,
    secureChat: typeof data.enforcesSecureChat === 'boolean' ? data.enforcesSecureChat : null,
    legacy: false,
  };
}

// Texto del ping heredado -> datos normalizados
function parseLegacy(text) {
  let protocol = null;
  let version = '';
  let motd = '';
  let online = null;
  let max = null;
  if (text.startsWith('§1\u0000')) {
    const parts = text.split('\u0000');
    protocol = Number.parseInt(parts[1], 10);
    if (!Number.isInteger(protocol)) protocol = null;
    version = parts[2] || '';
    motd = parts[3] || '';
    online = num(parts[4]);
    max = num(parts[5]);
  } else {
    const parts = text.split('§');
    if (parts.length < 3) throw Object.assign(new Error('legacy'), { code: 'MC_PROTOCOL' });
    max = num(parts.pop());
    online = num(parts.pop());
    motd = parts.join('§');
  }
  const ver = versions.resolve({ name: version, protocol, legacy: true });
  return {
    motd,
    motdText: stripCodes(motd),
    players: { online, max, sample: [] },
    version: stripCodes(version),
    versionRaw: version,
    protocol,
    mcVersion: ver.mcVersion,
    versionRange: ver.range,
    versionExact: ver.exact,
    versionPlaceholder: false,
    favicon: null,
    loader: null,
    loaderVersion: null,
    loaderGuessed: false,
    modded: false,
    mods: [],
    modsTruncated: false,
    serverOnlyMods: 0,
    secureChat: null,
    legacy: true,
  };
}

module.exports = { chatToLegacy, stripCodes, detectMods, decodeOptimized, parseOptimized, parseModern, parseLegacy };
