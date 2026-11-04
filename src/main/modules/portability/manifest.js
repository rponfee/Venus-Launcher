'use strict';
// Formato del .venusbackup (un ZIP con otra extension). Valida el manifiesto y cada entrada ANTES de escribir nada:
// un archivo con una sola ruta rara (zip-slip), tamanios absurdos o carpetas que no son del formato se rechaza entero.
//   manifest.json
//   instances/<clave>/meta.json · files/... · saves/<mundo>/... · media/...
//   servers/<clave>/meta.json · files/...
//   settings/settings.json
// Sin Electron ni disco (pruebas en test/manifest.test.js).
const safety = require('../packs/safety');
const filter = require('./filter');

const FORMAT = 'venusbackup';
const VERSION = 1;
const KEY_RE = /^[a-z][a-z0-9]{0,15}$/;
const MAX_ITEMS = 1000;
const MAX_ENTRIES = 3000000;
const MAX_TOTAL = 500 * 1024 ** 3;
const MAX_FILE = 100 * 1024 ** 3;
const MAX_MANIFEST = 16 * 1024 * 1024;
const MAX_META = 2 * 1024 * 1024;
const MAX_SETTINGS = 32 * 1024 * 1024;
// DEFLATE no comprime mas de 1032:1: una entrada que declara mas miente (bomba de descompresion)
const MAX_RATIO = 1100;
const RATIO_MIN_SIZE = 16 * 1024 * 1024;

class BackupError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const text = (v, max = 200) => (typeof v === 'string' && !filter.looksLikePath(v) ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '');
const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
const stat = (raw) => ({ files: count(raw?.files), bytes: count(raw?.bytes) });

function validInstance(raw) {
  if (!raw || !KEY_RE.test(String(raw.key))) return null;
  const worlds = (Array.isArray(raw.worlds) ? raw.worlds : [])
    .slice(0, 5000)
    .map((w) => ({ folder: safety.validSegment(w?.folder) ? w.folder : null, ...stat(w) }))
    .filter((w) => w.folder);
  return { key: raw.key, originalId: text(raw.originalId, 120), name: text(raw.name, 60), mcVersion: text(raw.mcVersion, 80), loader: text(raw.loader, 40), content: stat(raw.content), worlds, media: stat(raw.media) };
}

function validServer(raw) {
  if (!raw || !KEY_RE.test(String(raw.key))) return null;
  return { key: raw.key, name: text(raw.name, 60), type: text(raw.type, 20), mcVersion: text(raw.mcVersion, 80), content: stat(raw.content) };
}

// Solo lo conocido: lo que venga de mas en el archivo no llega a ningun lado.
function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.format !== FORMAT) throw new BackupError('notBackup');
  if (!Number.isInteger(raw.version) || raw.version < 1) throw new BackupError('badManifest');
  if (raw.version > VERSION) throw new BackupError('newerVersion');
  const instances = (Array.isArray(raw.instances) ? raw.instances : []).slice(0, MAX_ITEMS).map(validInstance);
  const servers = (Array.isArray(raw.servers) ? raw.servers : []).slice(0, MAX_ITEMS).map(validServer);
  if (instances.includes(null) || servers.includes(null)) throw new BackupError('badManifest');
  const keys = [...instances, ...servers].map((i) => i.key);
  if (new Set(keys).size !== keys.length) throw new BackupError('badManifest');
  return {
    format: FORMAT,
    version: raw.version,
    createdAt: count(raw.createdAt),
    appVersion: text(raw.appVersion, 40),
    categories: Array.isArray(raw.categories) ? raw.categories.filter((c) => ['instances', 'worlds', 'servers', 'settings', 'media'].includes(c)) : [],
    instances,
    servers,
    settings: raw.settings === true,
  };
}

/**
 * Lee una ruta de entrada y dice a que corresponde: { area: 'manifest' | 'settings' | 'meta' | 'files' | 'saves' | 'media',
 * kind: 'instance' | 'server' | null, key, rel, world } o null si la ruta no es de este formato o no es segura.
 */
function parseEntryName(name) {
  const raw = String(name);
  const isDir = raw.endsWith('/');
  const clean = safety.safeRelPath(isDir ? raw.slice(0, -1) : raw, { instance: false, maxLength: 2048, maxDepth: 128 });
  if (!clean || clean !== (isDir ? raw.slice(0, -1) : raw)) return null;
  if (clean === 'manifest.json') return isDir ? null : { area: 'manifest', kind: null };
  if (clean === 'settings/settings.json') return isDir ? null : { area: 'settings', kind: null };
  if (clean === 'settings' && isDir) return { area: 'dir', kind: null };
  const parts = clean.split('/');
  if (parts[0] !== 'instances' && parts[0] !== 'servers') return null;
  const kind = parts[0] === 'instances' ? 'instance' : 'server';
  if (parts.length === 1) return isDir ? { area: 'dir', kind } : null;
  if (!KEY_RE.test(parts[1])) return null;
  const key = parts[1];
  if (parts.length === 2) return isDir ? { area: 'dir', kind, key } : null;
  const area = parts[2];
  const rel = parts.slice(3).join('/');
  if (area === 'meta.json') return parts.length === 3 && !isDir ? { area: 'meta', kind, key } : null;
  if (parts.length === 3) return isDir && ['files', 'saves', 'media'].includes(area) ? { area: 'dir', kind, key } : null;
  if (area === 'files') {
    // Dentro de una instancia nunca venus-instance.json ni .venus/ (safety los rechaza); en un servidor, lo mismo con su meta
    if (!safety.safeRelPath(rel, { instance: kind === 'instance', maxLength: 2048, maxDepth: 128 })) return null;
    if (kind === 'server' && (rel.split('/')[0].toLowerCase() === '.venus' || rel.toLowerCase() === filter.META_SERVER)) return null;
    return { area, kind, key, rel, dir: isDir };
  }
  if (kind === 'instance' && area === 'saves') return { area, kind, key, rel, world: parts[3], dir: isDir };
  if (kind === 'instance' && area === 'media') return { area, kind, key, rel, dir: isDir };
  return null;
}

// Valida todas las entradas de un archivo. Devuelve { total, byKey, list: entradas que se pueden escribir } o lanza.
function validateEntries(entries, manifest) {
  if (!Array.isArray(entries) || !entries.length) throw new BackupError('notBackup');
  if (entries.length > MAX_ENTRIES) throw new BackupError('tooBig');
  const known = new Set([...manifest.instances.map((i) => `instance/${i.key}`), ...manifest.servers.map((s) => `server/${s.key}`)]);
  const seen = new Set();
  const list = [];
  let total = 0;
  for (const e of entries) {
    if (e.encrypted) throw new BackupError('badFile', e.name);
    const info = parseEntryName(e.name);
    if (!info) throw new BackupError('badPath', e.name);
    const low = e.name.toLowerCase();
    if (seen.has(low)) throw new BackupError('badPath', e.name);
    seen.add(low);
    if (info.area === 'dir' || e.dir) continue;
    if (info.kind && !known.has(`${info.kind}/${info.key}`)) throw new BackupError('badPath', e.name);
    if (e.method !== 0 && e.method !== 8) throw new BackupError('badFile', e.name);
    if (!Number.isSafeInteger(e.size) || e.size < 0 || !Number.isSafeInteger(e.compressedSize) || e.compressedSize < 0) throw new BackupError('badFile', e.name);
    if (e.size > MAX_FILE) throw new BackupError('tooBig', e.name);
    if (e.size >= RATIO_MIN_SIZE && e.size / Math.max(1, e.compressedSize) > MAX_RATIO) throw new BackupError('tooBig', e.name);
    if (info.area === 'manifest' && e.size > MAX_MANIFEST) throw new BackupError('tooBig', e.name);
    if (info.area === 'meta' && e.size > MAX_META) throw new BackupError('tooBig', e.name);
    if (info.area === 'settings' && e.size > MAX_SETTINGS) throw new BackupError('tooBig', e.name);
    total += e.size;
    if (total > MAX_TOTAL) throw new BackupError('tooBig');
    // Lo que nunca viaja tampoco se escribe, aunque el archivo lo traiga
    const allowed = info.area === 'files' ? (info.kind === 'instance' ? filter.keepInstanceFile(info.rel) : filter.keepServerFile(info.rel)) : info.area === 'saves' ? filter.keepWorldFile(info.rel) : info.area === 'media' ? filter.keepMediaFile(info.rel) : true;
    if (allowed) list.push({ entry: e, info });
  }
  return { total, list, dropped: entries.filter((e) => !e.dir).length - list.length };
}

module.exports = { FORMAT, VERSION, MAX_MANIFEST, MAX_META, MAX_SETTINGS, MAX_TOTAL, BackupError, validateManifest, parseEntryName, validateEntries };
