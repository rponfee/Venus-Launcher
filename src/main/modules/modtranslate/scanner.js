'use strict';
// Escaneo de mods y paquetes de recursos: metadatos (nombre, version, icono) y archivos de idioma por
// namespace, incluidos los jars anidados (Jar-in-Jar de Fabric/Quilt y jarjar de Forge/NeoForge).
// El resultado de cada jar se guarda en memoria segun ruta + tamanio + fecha, asi volver a escanear es instantaneo.
const fsp = require('fs/promises');
const path = require('path');
const { ZipReader } = require('./zip');
const lang = require('./lang');
const { legacyCode } = require('./locales');

const LANG_ENTRY = /^assets\/([^/]+)\/lang\/([^/]+)\.(json|lang)$/;
const NS_OK = /^[a-z0-9_.-]{1,80}$/;
const MOD_FILE = /\.(jar|zip)(\.disabled)?$/i;
const NESTED_DIRS = ['META-INF/jars/', 'META-INF/jarjar/'];
const MAX_NESTED = 80;
const MAX_NESTED_BYTES = 48 * 1024 * 1024; // por jar
const MAX_ICON_BYTES = 48 * 1024;
const CACHE_MAX = 1500;
const SOURCE = 'en_us';

const jarCache = new Map();
const packCache = new Map();

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_MAX) map.delete(map.keys().next().value);
  return value;
}

function recall(map, key) {
  if (!map.has(key)) return undefined;
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}

const str = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// ---------- Metadatos ----------

// Icono de fabric.mod.json: texto o { "16": "...", "128": "..." } (se elige el mas cercano a 64 px).
function pickIcon(icon) {
  if (typeof icon === 'string') return icon;
  if (!icon || typeof icon !== 'object') return null;
  const sizes = Object.keys(icon)
    .map((k) => [Number(k), icon[k]])
    .filter(([n, p]) => Number.isFinite(n) && typeof p === 'string');
  if (!sizes.length) return null;
  sizes.sort((a, b) => Math.abs(a[0] - 64) - Math.abs(b[0] - 64));
  return sizes[0][1];
}

// TOML minimo para mods.toml: solo el primer bloque [[mods]] y logoFile.
function parseModsToml(text) {
  const top = {};
  const mod = {};
  let section = '';
  let modsSeen = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    if (line[0] === '[') {
      const m = /^\[\[?\s*([^\]]+?)\s*\]\]?/.exec(line);
      section = m ? m[1] : '';
      if (/^\[\[\s*mods\s*\]\]/.test(line)) modsSeen++;
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(line);
    if (!kv) continue;
    const val = kv[2] !== undefined ? kv[2].replace(/\\(.)/g, '$1') : kv[3];
    if (!section) top[kv[1]] = val;
    else if (section === 'mods' && modsSeen === 1 && mod[kv[1]] === undefined) mod[kv[1]] = val;
  }
  return { modId: mod.modId, name: mod.displayName, version: mod.version, icon: mod.logoFile || top.logoFile };
}

async function readEntry(zip, name) {
  const e = zip.get(name);
  if (!e) return null;
  try {
    return await zip.read(e);
  } catch {
    return null;
  }
}

async function readMeta(zip) {
  const out = { modId: null, name: null, version: null, iconPath: null };
  const fabric = await readEntry(zip, 'fabric.mod.json');
  if (fabric) {
    try {
      const j = lang.parseJsonLenient(fabric);
      out.modId = str(j.id, 80);
      out.name = str(j.name);
      out.version = str(j.version, 60);
      out.iconPath = pickIcon(j.icon);
    } catch {
      /* fabric.mod.json roto */
    }
  }
  if (!out.modId) {
    const quilt = await readEntry(zip, 'quilt.mod.json');
    if (quilt) {
      try {
        const q = lang.parseJsonLenient(quilt)?.quilt_loader || {};
        out.modId = str(q.id, 80);
        out.version = str(q.version, 60);
        out.name = str(q.metadata?.name);
        out.iconPath = pickIcon(q.metadata?.icon);
      } catch {
        /* quilt.mod.json roto */
      }
    }
  }
  for (const tomlName of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
    if (out.modId) break;
    const toml = await readEntry(zip, tomlName);
    if (!toml) continue;
    const m = parseModsToml(toml.toString('utf8'));
    out.modId = str(m.modId, 80);
    out.name = str(m.name);
    out.version = str(m.version, 60);
    out.iconPath = str(m.icon, 200);
  }
  if (!out.modId) {
    const info = await readEntry(zip, 'mcmod.info');
    if (info) {
      try {
        const j = lang.parseJsonLenient(info);
        const first = Array.isArray(j) ? j[0] : Array.isArray(j?.modList) ? j.modList[0] : null;
        if (first) {
          out.modId = str(first.modid, 80);
          out.name = str(first.name);
          out.version = str(first.version, 60);
          out.iconPath = str(first.logoFile, 200);
        }
      } catch {
        /* mcmod.info roto */
      }
    }
  }
  if (!out.version || out.version.includes('${')) {
    const mf = await readEntry(zip, 'META-INF/MANIFEST.MF');
    const m = mf && /^Implementation-Version:\s*(.+)$/m.exec(mf.toString('utf8'));
    out.version = m ? m[1].trim().slice(0, 60) : out.version && out.version.includes('${') ? null : out.version;
  }
  return out;
}

async function readIcon(zip, iconPath) {
  if (!iconPath) return null;
  const e = zip.get(String(iconPath).replace(/^\/+/, ''));
  if (!e || e.size > MAX_ICON_BYTES) return null;
  try {
    const buf = await zip.read(e);
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// ---------- Archivos de idioma ----------

/**
 * Nombre de archivo -> codigo de idioma segun el estilo de la version:
 *   json   -> exactamente "es_es.json" (el juego distingue mayusculas)
 *   lang   -> "es_es.lang" (se aceptan mayusculas)
 *   legacy -> "es_ES.lang" (se aceptan minusculas)
 */
function codeFor(base, ext, style) {
  if (style === 'json') return ext === 'json' && base === base.toLowerCase() ? base : null;
  return ext === 'lang' ? base.toLowerCase() : null;
}

function isExact(base, code, style) {
  return style === 'legacy' ? base === legacyCode(code) : base === code;
}

// Junta los archivos de idioma pedidos de un zip: Map(ns -> { source, escapes, targets: Map(code -> Map) })
async function readLangs(zip, { style, locales }) {
  const want = new Set([SOURCE, ...locales]);
  const found = new Map();
  for (const e of zip.entries) {
    if (e.dir) continue;
    const m = LANG_ENTRY.exec(e.name);
    if (!m || !NS_OK.test(m[1])) continue;
    const code = codeFor(m[2], m[3], style);
    if (!code || !want.has(code)) continue;
    let byCode = found.get(m[1]);
    if (!byCode) found.set(m[1], (byCode = new Map()));
    const exact = isExact(m[2], code, style);
    const prev = byCode.get(code);
    if (!prev || (exact && !prev.exact)) byCode.set(code, { entry: e, exact, ext: m[3] });
  }
  const out = new Map();
  for (const [ns, byCode] of found) {
    const rec = { source: null, escapes: false, targets: new Map() };
    for (const [code, { entry, ext }] of byCode) {
      try {
        const parsed = lang.parseLang(await zip.read(entry), ext);
        if (code === SOURCE) {
          rec.source = parsed.map;
          rec.escapes = parsed.escapes;
        } else rec.targets.set(code, parsed.map);
      } catch {
        /* archivo de idioma roto: el juego tampoco lo carga */
      }
    }
    if (rec.source?.size || rec.targets.size) out.set(ns, rec);
  }
  return out;
}

async function scanZip(zip, opts, depth) {
  const meta = await readMeta(zip);
  const unit = {
    path: null,
    modId: meta.modId,
    name: meta.name,
    version: meta.version,
    icon: opts.icons ? await readIcon(zip, meta.iconPath) : null,
    namespaces: await readLangs(zip, opts),
    nested: [],
  };
  if (depth <= 0) return unit;
  let budget = MAX_NESTED_BYTES;
  for (const e of zip.entries) {
    if (unit.nested.length >= MAX_NESTED) break;
    if (e.dir || !/\.jar$/i.test(e.name)) continue;
    const dir = NESTED_DIRS.find((d) => e.name.startsWith(d));
    if (!dir || e.name.slice(dir.length).includes('/') || e.size > budget) continue;
    budget -= e.size;
    try {
      const inner = await ZipReader.fromBuffer(await zip.read(e));
      const child = await scanZip(inner, { ...opts, icons: false }, depth - 1);
      child.path = e.name;
      if (child.namespaces.size) unit.nested.push(child);
    } catch {
      /* jar anidado ilegible: se ignora */
    }
  }
  return unit;
}

/**
 * Escanea un jar de mods. opts: { style, locales: ['es_es', ...] }
 * Devuelve { file, size, mtime, modId, name, version, icon, namespaces, nested: [unidad...] }
 */
async function scanJar(file, { style, locales }) {
  const st = await fsp.stat(file);
  const key = [file, st.size, Math.round(st.mtimeMs), style, [...locales].sort().join(',')].join('|');
  const hit = recall(jarCache, key);
  if (hit) return hit;
  let zip = null;
  let unit;
  try {
    zip = await ZipReader.open(file);
    unit = await scanZip(zip, { style, locales, icons: true }, 1);
  } catch {
    unit = { path: null, modId: null, name: null, version: null, icon: null, namespaces: new Map(), nested: [], broken: true };
  } finally {
    if (zip) await zip.close();
  }
  return remember(jarCache, key, { ...unit, file, size: st.size, mtime: st.mtimeMs });
}

// Archivos de la carpeta mods (activos y desactivados), ordenados por nombre.
async function listModFiles(modsDir) {
  let entries = [];
  try {
    entries = await fsp.readdir(modsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !MOD_FILE.test(e.name)) continue;
    const st = await fsp.stat(path.join(modsDir, e.name)).catch(() => null);
    if (st) out.push({ file: e.name, path: path.join(modsDir, e.name), size: st.size, mtime: st.mtimeMs, enabled: !/\.disabled$/i.test(e.name) });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

// ---------- Paquetes de recursos (zip o carpeta) ----------

async function folderLangs(dir, opts) {
  const out = new Map();
  const want = new Set([SOURCE, ...opts.locales]);
  const assets = path.join(dir, 'assets');
  const nsList = await fsp.readdir(assets, { withFileTypes: true }).catch(() => []);
  for (const nsEnt of nsList) {
    if (!nsEnt.isDirectory() || !NS_OK.test(nsEnt.name)) continue;
    const langDir = path.join(assets, nsEnt.name, 'lang');
    const files = await fsp.readdir(langDir).catch(() => []);
    const rec = { source: null, escapes: false, targets: new Map() };
    for (const f of files) {
      const m = /^(.+)\.(json|lang)$/.exec(f);
      if (!m) continue;
      const code = codeFor(m[1], m[2], opts.style);
      if (!code || !want.has(code) || code === SOURCE) continue;
      try {
        const parsed = lang.parseLang(await fsp.readFile(path.join(langDir, f)), m[2]);
        rec.targets.set(code, parsed.map);
      } catch {
        /* archivo roto */
      }
    }
    if (rec.targets.size) out.set(nsEnt.name, rec);
  }
  return out;
}

// Firma barata de una carpeta de paquete: fechas y tamanios de sus archivos de idioma.
async function folderSignature(dir) {
  const parts = [];
  const assets = path.join(dir, 'assets');
  for (const ns of await fsp.readdir(assets).catch(() => [])) {
    const langDir = path.join(assets, ns, 'lang');
    for (const f of await fsp.readdir(langDir).catch(() => [])) {
      const st = await fsp.stat(path.join(langDir, f)).catch(() => null);
      if (st) parts.push(`${ns}/${f}:${st.size}:${Math.round(st.mtimeMs)}`);
    }
  }
  return parts.sort().join('|');
}

async function scanPack(full, { style, locales }) {
  const st = await fsp.stat(full).catch(() => null);
  if (!st) return null;
  const sig = st.isDirectory() ? await folderSignature(full) : `${st.size}:${Math.round(st.mtimeMs)}`;
  const key = [full, sig, style, [...locales].sort().join(',')].join('|');
  const hit = recall(packCache, key);
  if (hit) return hit;
  let namespaces = new Map();
  if (st.isDirectory()) namespaces = await folderLangs(full, { style, locales });
  else {
    let zip = null;
    try {
      zip = await ZipReader.open(full);
      namespaces = await readLangs(zip, { style, locales });
    } catch {
      namespaces = new Map();
    } finally {
      if (zip) await zip.close();
    }
  }
  return remember(packCache, key, { path: full, namespaces });
}

function clearCaches() {
  jarCache.clear();
  packCache.clear();
}

module.exports = { scanJar, scanPack, listModFiles, parseModsToml, pickIcon, clearCaches, SOURCE, NS_OK };
