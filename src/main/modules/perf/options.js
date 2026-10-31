'use strict';
// options.txt: lee y mezcla solo las opciones de video que afectan al rendimiento,
// conservando el resto de las lineas (controles, idioma, servidores...) tal cual estaban.
const fsp = require('fs/promises');
const path = require('path');
const mcver = require('./mcver');

// Formato de cada opcion. since = primera version que la tiene.
const KEYS = {
  renderDistance: { type: 'int', min: 2, max: 32 },
  simulationDistance: { type: 'int', min: 5, max: 32, since: '1.18' },
  graphicsMode: { type: 'int', min: 0, max: 2, since: '1.16', legacy: 'fancyGraphics' },
  particles: { type: 'int', min: 0, max: 2 },
  entityShadows: { type: 'bool', since: '1.8' },
  maxFps: { type: 'int', min: 10, max: 260 },
  enableVsync: { type: 'bool', since: '1.8' },
  mipmapLevels: { type: 'int', min: 0, max: 4, since: '1.7' },
  biomeBlendRadius: { type: 'int', min: 0, max: 7, since: '1.13' },
  renderClouds: { type: 'enum', values: ['true', 'fast', 'false'], quotedSince: '1.19' },
  ao: { type: 'bool', numericBefore: '1.19' },
  entityDistanceScaling: { type: 'float', min: 0.5, max: 5, since: '1.16' },
};

// Valores recomendados por gama (y el modo para PCs de bajos recursos).
const PRESETS = {
  lowEnd: { renderDistance: 6, simulationDistance: 5, graphicsMode: 0, particles: 2, entityShadows: false, maxFps: 60, enableVsync: false, mipmapLevels: 0, biomeBlendRadius: 0, renderClouds: 'false', ao: false, entityDistanceScaling: 0.75 },
  low: { renderDistance: 8, simulationDistance: 6, graphicsMode: 0, particles: 1, entityShadows: false, maxFps: 120, enableVsync: false, mipmapLevels: 2, biomeBlendRadius: 1, renderClouds: 'fast', ao: true, entityDistanceScaling: 0.75 },
  mid: { renderDistance: 12, simulationDistance: 8, graphicsMode: 1, particles: 0, entityShadows: true, maxFps: 120, enableVsync: false, mipmapLevels: 4, biomeBlendRadius: 2, renderClouds: 'true', ao: true, entityDistanceScaling: 1 },
  high: { renderDistance: 16, simulationDistance: 10, graphicsMode: 1, particles: 0, entityShadows: true, maxFps: 240, enableVsync: false, mipmapLevels: 4, biomeBlendRadius: 2, renderClouds: 'true', ao: true, entityDistanceScaling: 1 },
  ultra: { renderDistance: 20, simulationDistance: 12, graphicsMode: 1, particles: 0, entityShadows: true, maxFps: 240, enableVsync: false, mipmapLevels: 4, biomeBlendRadius: 3, renderClouds: 'true', ao: true, entityDistanceScaling: 1.25 },
};

const GRAPHIC_KEYS = ['renderDistance', 'graphicsMode', 'particles', 'entityShadows', 'maxFps', 'enableVsync', 'mipmapLevels', 'biomeBlendRadius', 'renderClouds', 'ao'];
const CPU_KEYS = ['simulationDistance', 'entityDistanceScaling'];

// Opciones para una PC: lo grafico sale de la GPU y lo de simulacion de la CPU.
// fastRenderer = hay Sodium/Embeddium (se puede ver mas lejos con el mismo costo).
function recommend({ tiers = {}, tier = 'mid', lowEnd = false, fastRenderer = false, mcVersion } = {}) {
  if (lowEnd) return filterForVersion({ ...PRESETS.lowEnd }, mcVersion);
  // La GPU manda, pero una CPU o una RAM muy por debajo tambien limitan cuanto se puede ver
  const gfxTier = tiers.gpu ? lowestOf(lowestOf(tiers.gpu, bump(tiers.cpu || 'mid')), bump(tiers.ram || 'mid')) : tier;
  const gfx = PRESETS[gfxTier] || PRESETS.mid;
  const cpu = PRESETS[tiers.cpu || tier] || PRESETS.mid;
  const out = {};
  for (const k of GRAPHIC_KEYS) out[k] = gfx[k];
  for (const k of CPU_KEYS) out[k] = cpu[k];
  if (fastRenderer && out.renderDistance >= 12) out.renderDistance = Math.min(32, out.renderDistance + 4);
  else if (!fastRenderer && out.renderDistance > 12) out.renderDistance -= 2;
  if (out.simulationDistance > out.renderDistance) out.simulationDistance = out.renderDistance;
  return filterForVersion(out, mcVersion);
}

const ORDER = ['low', 'mid', 'high', 'ultra'];
function lowestOf(a, b) {
  return ORDER[Math.min(ORDER.indexOf(a), ORDER.indexOf(b))] || 'mid';
}
function bump(t) {
  return ORDER[Math.min(3, Math.max(0, ORDER.indexOf(t)) + 1)];
}

function filterForVersion(opts, mcVersion) {
  if (!mcVersion) return opts;
  const out = {};
  for (const [k, v] of Object.entries(opts)) {
    const def = KEYS[k];
    if (def.since && !mcver.atLeast(mcVersion, def.since) && !(k === 'graphicsMode' && def.legacy)) continue;
    out[k] = v;
  }
  return out;
}

// ---------- Lectura / escritura ----------
function parse(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const entries = lines.map((raw) => {
    const i = raw.indexOf(':');
    return i > 0 ? { raw, key: raw.slice(0, i), value: raw.slice(i + 1) } : { raw };
  });
  return { eol, entries };
}

function unquote(v) {
  const s = String(v ?? '').trim();
  return /^".*"$/.test(s) ? s.slice(1, -1) : s;
}

function readValue(key, raw) {
  const def = KEYS[key];
  const v = unquote(raw);
  switch (def.type) {
    case 'int':
      return Number.isFinite(Number(v)) && v !== '' ? Math.round(Number(v)) : null;
    case 'float':
      return Number.isFinite(Number(v)) && v !== '' ? Number(v) : null;
    case 'bool':
      if (key === 'ao' && /^\d$/.test(v)) return v !== '0';
      return v === 'true' ? true : v === 'false' ? false : null;
    default:
      return def.values.includes(v) ? v : null;
  }
}

function formatValue(key, value, { existingRaw = null, mcVersion } = {}) {
  const def = KEYS[key];
  const clampN = (n) => Math.min(def.max, Math.max(def.min, n));
  switch (def.type) {
    case 'int':
      return String(clampN(Math.round(Number(value))));
    case 'float': {
      const n = clampN(Number(value));
      return Number.isInteger(n) ? n.toFixed(1) : String(n);
    }
    case 'bool': {
      if (key === 'ao') {
        const numeric = existingRaw !== null ? /^\d$/.test(String(existingRaw).trim()) : !mcver.atLeast(mcVersion, def.numericBefore);
        if (numeric) return value ? '2' : '0';
      }
      return value ? 'true' : 'false';
    }
    default: {
      const v = def.values.includes(String(value)) ? String(value) : def.values[0];
      const quoted = existingRaw !== null ? /^".*"$/.test(String(existingRaw).trim()) : mcver.atLeast(mcVersion, def.quotedSince);
      return quoted ? `"${v}"` : v;
    }
  }
}

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

// Valores actuales de las opciones de rendimiento de una instancia.
async function read(instanceDir) {
  const text = await readText(path.join(instanceDir, 'options.txt'));
  if (text === null) return { exists: false, values: {} };
  const { entries } = parse(text);
  const values = {};
  for (const e of entries) {
    if (!e.key) continue;
    if (KEYS[e.key]) {
      const v = readValue(e.key, e.value);
      if (v !== null) values[e.key] = v;
    } else if (e.key === 'fancyGraphics' && values.graphicsMode === undefined) {
      values.graphicsMode = unquote(e.value) === 'true' ? 1 : 0;
    }
  }
  return { exists: true, values };
}

// Mezcla las opciones pedidas en options.txt. Devuelve { changed: [claves], created, file }.
async function merge(instanceDir, mcVersion, patch) {
  const file = path.join(instanceDir, 'options.txt');
  const text = await readText(file);
  const doc = text !== null ? parse(text) : { eol: process.platform === 'win32' ? '\r\n' : '\n', entries: [] };
  const index = new Map();
  doc.entries.forEach((e, i) => e.key && index.set(e.key, i));
  const changed = [];
  for (const [key, value] of Object.entries(patch || {})) {
    const def = KEYS[key];
    if (!def || value === undefined || value === null) continue;
    let fileKey = key;
    if (key === 'graphicsMode' && !index.has('graphicsMode') && (index.has('fancyGraphics') || !mcver.atLeast(mcVersion, def.since))) fileKey = 'fancyGraphics';
    const pos = index.get(fileKey);
    if (pos === undefined && fileKey === key && def.since && !mcver.atLeast(mcVersion, def.since)) continue; // la version no tiene esta opcion
    const raw = fileKey === 'fancyGraphics' ? (Number(value) >= 1 ? 'true' : 'false') : formatValue(key, value, { existingRaw: pos !== undefined ? doc.entries[pos].value : null, mcVersion });
    if (pos !== undefined) {
      if (doc.entries[pos].value === raw) continue;
      doc.entries[pos] = { key: fileKey, value: raw, raw: `${fileKey}:${raw}` };
    } else {
      doc.entries.push({ key: fileKey, value: raw, raw: `${fileKey}:${raw}` });
      index.set(fileKey, doc.entries.length - 1);
    }
    changed.push(key);
  }
  if (changed.length) {
    await fsp.mkdir(instanceDir, { recursive: true });
    if (text !== null) await fsp.writeFile(path.join(instanceDir, 'options.txt.venus.bak'), text, 'utf8').catch(() => {});
    const out = doc.entries.map((e) => e.raw).join(doc.eol) + doc.eol;
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, out, 'utf8');
    await fsp.rename(tmp, file);
  }
  return { changed, created: text === null && changed.length > 0, file };
}

module.exports = { KEYS, PRESETS, recommend, read, merge, parse, formatValue, readValue };
