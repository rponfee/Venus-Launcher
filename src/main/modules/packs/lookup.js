'use strict';
// Datos de Modrinth para comparar y exportar packs: versiones por hash (en lote y con cache),
// proyectos, saltos de version "grandes", mods de contenido y frases de riesgo en los changelogs.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const modrinth = require('../../core/modrinth');

const BATCH = 400;
const CACHE_MAX = 20000;
const versionCache = new Map(); // sha1 -> version | null
const projectCache = new Map(); // id -> proyecto

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > CACHE_MAX) map.delete(map.keys().next().value);
}

// Versiones de Modrinth para una lista de sha1 (las que no estan en Modrinth quedan en null).
async function versionsByHash(hashes, { signal } = {}) {
  const list = [...new Set((hashes || []).filter((h) => typeof h === 'string' && /^[0-9a-f]{40}$/.test(h)))];
  const missing = list.filter((h) => !versionCache.has(h));
  for (let i = 0; i < missing.length; i += BATCH) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const chunk = missing.slice(i, i + BATCH);
    const res = await modrinth.api('/version_files', { method: 'POST', body: { hashes: chunk, algorithm: 'sha1' }, signal });
    for (const h of chunk) remember(versionCache, h, res?.[h] || null);
  }
  const out = {};
  for (const h of list) out[h] = versionCache.get(h) || null;
  return out;
}

async function projectsByIds(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  const missing = list.filter((id) => !projectCache.has(id));
  if (missing.length) {
    const got = await modrinth.getProjects(missing);
    for (const p of got || []) if (p?.id) remember(projectCache, p.id, p);
  }
  const out = new Map();
  for (const id of list) if (projectCache.has(id)) out.set(id, projectCache.get(id));
  return out;
}

// sha1 de archivos locales con cache por ruta + tamanio + fecha (las comparaciones se repiten seguido).
const localCache = new Map();
async function localSha1(abs) {
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return null;
  const key = `${abs}|${st.size}|${Math.round(st.mtimeMs)}`;
  if (localCache.has(key)) return localCache.get(key);
  const h = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(abs)
      .on('error', reject)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')));
  }).catch(() => null);
  if (h) remember(localCache, key, h);
  return h;
}

// ---------- Versiones ----------

// Numeros de la version del mod sin las versiones de Minecraft que suelen llevar pegadas
// ("0.5.1.f-1.20.1" -> [0,5,1]; "mc1.21.1-6.0.0" -> [6,0,0]).
function versionCore(number, gameVersions = []) {
  const mc = new Set((gameVersions || []).map(String));
  const seqs = String(number || '').match(/\d+(?:\.\d+)*/g) || [];
  const kept = seqs.filter((s) => !mc.has(s));
  const pick = kept.find((s) => s.includes('.')) || kept[0];
  return pick ? pick.split('.').map((n) => parseInt(n, 10) || 0) : null;
}

function compareCores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// 'major' (0.5 -> 6.0, 1.x -> 2.x), 'downgrade', 'minor' o null si no se puede saber.
// zeroMinor: en versiones 0.x, subir el segundo numero tambien cuenta como grande (0.5 -> 0.6). Se usa
// solo para mods de contenido: muchas librerias viven en 0.x y suben ese numero en cada version.
function bumpKind(oldNumber, newNumber, oldGv, newGv, { zeroMinor = false } = {}) {
  const a = versionCore(oldNumber, oldGv);
  const b = versionCore(newNumber, newGv);
  if (!a || !b) return null;
  const cmp = compareCores(a, b);
  if (cmp > 0) return 'downgrade';
  if (cmp === 0) return 'minor';
  if (b[0] > a[0]) return 'major';
  if (zeroMinor && a[0] === 0 && b[0] === 0 && (b[1] || 0) > (a[1] || 0)) return 'major';
  return 'minor';
}

// Mods que agregan bloques, items o entidades: si se quitan o cambian mucho, los mundos lo notan.
const CONTENT_CATEGORIES = new Set(['technology', 'magic', 'adventure', 'decoration', 'worldgen', 'storage', 'equipment', 'food', 'mobs', 'transportation', 'economy', 'minigame']);
function isContentMod(project) {
  if (!project || project.project_type !== 'mod') return false;
  const cats = [...(project.categories || []), ...(project.additional_categories || [])];
  return cats.some((c) => CONTENT_CATEGORIES.has(c));
}

// ---------- Changelogs ----------

const RISK_RE = new RegExp(
  [
    'back ?up',
    'breaking changes?',
    "(?:not|isn't|is not|aren't|are not) (?:backwards?[- ])?compatible",
    'incompatible with (?:old|older|previous|existing) (?:worlds?|saves?|versions?)',
    'worlds? (?:will|may|might|can|could) (?:be )?(?:break|broken|corrupt\\w*|reset|lost)',
    'new world',
    'fresh world',
    'corrupt\\w* (?:your |the |existing )?(?:world|save|chunk)s?',
    'world corruption',
    'irreversib\\w*',
    'cannot be (?:reverted|undone)',
    'no going back',
    'data loss',
    'lose (?:your |all )?(?:data|items|progress|worlds?|inventor\\w*)',
    '(?:blocks?|items?|entities) (?:were |was |are |have been |has been )?removed',
    'removed? (?:the |all |some )?(?:blocks?|items?|entities)',
    '(?:save|world|chunk) format',
    'requires? a new world',
    '(?:old|existing) worlds?',
    'copia de seguridad',
    'mundo nuevo',
  ].join('|'),
  'i',
);

function cleanLine(line) {
  return String(line)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`#>~|]+/g, '')
    .replace(/^\s*[-+•]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function riskLines(text, max = 2) {
  if (!text) return [];
  const out = [];
  for (const raw of String(text).split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)) {
    const line = cleanLine(raw);
    if (line.length < 8 || !RISK_RE.test(line)) continue;
    const short = line.length > 200 ? `${line.slice(0, 197)}…` : line;
    if (!out.includes(short)) out.push(short);
    if (out.length >= max) break;
  }
  return out;
}

// Nombre legible a partir del archivo cuando no esta en Modrinth: "create-1.20.1-0.5.1.jar" -> "create"
function nameKey(file) {
  const base = path.basename(String(file)).replace(/\.disabled$/i, '').replace(/\.(jar|zip|litemod)$/i, '').toLowerCase();
  const tokens = base.split(/[-_+ ]+/).filter((tk) => tk && !/\d/.test(tk) && !['mc', 'fabric', 'forge', 'neoforge', 'quilt', 'mod', 'v'].includes(tk));
  return tokens.join('-') || base;
}

function prettyName(file) {
  const key = nameKey(file);
  return key ? key.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : path.basename(String(file));
}

module.exports = { versionsByHash, projectsByIds, localSha1, versionCore, bumpKind, isContentMod, riskLines, nameKey, prettyName, CONTENT_CATEGORIES };
