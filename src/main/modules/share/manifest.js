'use strict';
// Manifiesto de un modpack compartido: que mods/packs lleva (por hash de Modrinth o CurseForge),
// cuales hay que conseguir a mano y las configs de texto. Los manifiestos que llegan de la nube no son
// confiables: normalizeManifest() valida cada campo, cada ruta y cada URL antes de usarlos.
const zlib = require('zlib');
const modrinth = require('../../core/modrinth');
const instances = require('../../core/instances');
const { t } = require('../../core/i18n');
const files = require('./files');

const FORMAT = 1;
const MAX_ENTRIES = 3000;
const MAX_ENCODED = 3 * 1024 * 1024; // limite de la columna manifest (0004_share.sql)
const SHA1_RE = /^[0-9a-f]{40}$/;
const MR_ID = /^[A-Za-z0-9]{8}$/;
const VERSION_RE = /^[\w .+-]{1,100}$/;
const HOSTS = {
  modrinth: new Set(['cdn.modrinth.com']),
  curseforge: new Set(['edge.forgecdn.net', 'mediafilez.forgecdn.net', 'media.forgecdn.net']),
};
const ICON_HOSTS = new Set(['cdn.modrinth.com', 'media.forgecdn.net', 'edge.forgecdn.net', 'mediafilez.forgecdn.net']);
const LOOKUP_TTL = 30 * 60 * 1000;

const lookupCache = new Map(); // sha1 -> { at, value }

function cleanText(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
}

function httpsUrl(v, max = 600) {
  if (typeof v !== 'string' || v.length > max) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// Iconos solo de los CDN de Modrinth/CurseForge (una URL cualquiera serviria para rastrear a quien abre la vista previa).
function iconUrl(v) {
  const href = httpsUrl(v, 600);
  if (!href) return null;
  try {
    return ICON_HOSTS.has(new URL(href).hostname) ? href : null;
  } catch {
    return null;
  }
}

function allowedDownload(source, url) {
  const href = httpsUrl(url, 1000);
  if (!href) return null;
  try {
    return HOSTS[source]?.has(new URL(href).hostname) ? href : null;
  } catch {
    return null;
  }
}

function sizeOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 4 * 1024 * 1024 * 1024 ? Math.floor(n) : 0;
}

// ---------- Busqueda de hashes en Modrinth (en lote, con cache en memoria) ----------

/**
 * sha1[] -> Map(sha1 -> { projectId, versionId, versionNumber, url, filename, size, title, icon, projectType } | null)
 * Lanza el error de Modrinth si la API no responde (salvo soft: true, que devuelve lo que haya en cache).
 */
async function lookupHashes(hashes, { signal, soft = false } = {}) {
  const out = new Map();
  const now = Date.now();
  const need = [];
  for (const h of new Set(hashes.filter((x) => SHA1_RE.test(x || '')))) {
    const c = lookupCache.get(h);
    if (c && now - c.at < LOOKUP_TTL) out.set(h, c.value);
    else need.push(h);
  }
  if (!need.length) return out;
  try {
    const versions = {};
    for (let i = 0; i < need.length; i += 500) {
      const res = await modrinth.api('/version_files', { method: 'POST', body: { hashes: need.slice(i, i + 500), algorithm: 'sha1' }, signal });
      Object.assign(versions, res || {});
    }
    const projectIds = [...new Set(Object.values(versions).map((v) => v?.project_id).filter(Boolean))];
    const projects = projectIds.length ? await modrinth.getProjects(projectIds).catch(() => []) : [];
    const byId = new Map(projects.map((p) => [p.id, p]));
    for (const h of need) {
      const v = versions[h];
      let value = null;
      if (v?.project_id) {
        const file = (v.files || []).find((f) => f?.hashes?.sha1 === h) || null;
        const p = byId.get(v.project_id);
        value = {
          projectId: v.project_id,
          versionId: v.id,
          versionNumber: v.version_number || null,
          url: file?.url || null,
          filename: file?.filename || null,
          size: file?.size || 0,
          title: p?.title || null,
          icon: p?.icon_url || null,
          projectType: p?.project_type || null,
        };
      }
      lookupCache.set(h, { at: now, value });
      out.set(h, value);
    }
  } catch (err) {
    if (!soft) throw err;
  }
  return out;
}

// ---------- CurseForge (opcional: solo si el usuario configuro su API key) ----------

async function identifyCurseforge(instDir, candidates) {
  let cf = null;
  try {
    cf = require('../curseforge');
  } catch {
    return new Map();
  }
  if (typeof cf?.available !== 'function' || typeof cf.fingerprintMatches !== 'function' || typeof cf.fingerprintFile !== 'function') return new Map();
  try {
    if (!(await cf.available())) return new Map();
  } catch {
    return new Map();
  }
  const byPrint = new Map();
  for (const f of candidates) {
    try {
      const print = await cf.fingerprintFile(files.insideInstance(instDir, `${f.folder}/${f.file}`));
      if (Number.isInteger(print)) byPrint.set(print, f);
    } catch {
      /* archivo ilegible */
    }
  }
  if (!byPrint.size) return new Map();
  const out = new Map();
  try {
    const res = await cf.fingerprintMatches([...byPrint.keys()]);
    const mods = new Map();
    const matches = res?.exactMatches || [];
    try {
      const list = await cf.getMods([...new Set(matches.map((m) => m.id).filter(Boolean))]);
      for (const m of list || []) mods.set(m.id, m);
    } catch {
      /* sin nombres */
    }
    for (const m of matches) {
      const file = m?.file;
      const local = byPrint.get(Number(file?.fileFingerprint));
      if (!local || !file) continue;
      const sha1 = (file.hashes || []).find((x) => Number(x.algo) === 1)?.value?.toLowerCase();
      const url = allowedDownload('curseforge', file.downloadUrl);
      if (!url || sha1 !== local.sha1) continue; // sin permiso de distribucion o hash distinto: queda manual
      out.set(local.path, {
        cfProjectId: Number(m.id) || Number(file.modId),
        cfFileId: Number(file.id),
        url,
        title: cleanText(mods.get(m.id)?.name || file.displayName, 120),
        icon: iconUrl(mods.get(m.id)?.logo?.thumbnailUrl),
        versionNumber: cleanText(file.displayName, 60),
      });
    }
  } catch (err) {
    console.warn('[share] CurseForge:', err?.message || err);
  }
  return out;
}

// ---------- Construir ----------

/**
 * Manifiesto de una instancia.
 * opts: { includeConfigs = true, includeOptions = false, folders = ['mods','resourcepacks','shaderpacks'], signal }
 */
async function buildManifest(instanceId, opts = {}) {
  const inst = await instances.get(instanceId);
  const folders = Array.isArray(opts.folders) && opts.folders.length ? opts.folders.filter((f) => files.CONTENT_FOLDERS.includes(f)) : files.CONTENT_FOLDERS;
  const local = (await files.scanContent(inst.dir, { hash: true, signal: opts.signal })).filter((f) => folders.includes(f.folder));
  const hashed = local.filter((f) => !f.dir && f.sha1);
  let found;
  try {
    found = await lookupHashes(hashed.map((f) => f.sha1), { signal: opts.signal });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new Error(t('share.errModrinth', { error: err?.message || String(err) }));
  }
  const records = Object.values(inst.modrinth?.projects || {});
  const recordTitle = (f) => records.find((r) => r?.file === f.base && (!r.folder || r.folder.replace(/\\/g, '/') === f.folder))?.title || null;

  const entries = [];
  const manual = [];
  for (const f of hashed) {
    const info = found.get(f.sha1);
    const url = info ? allowedDownload('modrinth', info.url) : null;
    if (info && url && MR_ID.test(info.projectId) && MR_ID.test(info.versionId)) {
      entries.push({
        path: f.path,
        source: 'modrinth',
        projectId: info.projectId,
        versionId: info.versionId,
        versionNumber: cleanText(info.versionNumber, 60),
        sha1: f.sha1,
        size: f.size,
        url,
        title: cleanText(info.title, 120) || f.base,
        icon: iconUrl(info.icon),
        enabled: f.enabled,
      });
    } else {
      manual.push({ path: f.path, sha1: f.sha1, size: f.size, title: cleanText(recordTitle(f), 120) || f.base, enabled: f.enabled, file: f.file, folder: f.folder });
    }
  }
  // Los que no estan en Modrinth pueden estar en CurseForge (si el usuario tiene API key).
  const cfFound = manual.length ? await identifyCurseforge(inst.dir, manual) : new Map();
  const stillManual = [];
  for (const m of manual) {
    const cf = cfFound.get(m.path);
    if (cf) {
      entries.push({ path: m.path, source: 'curseforge', cfProjectId: cf.cfProjectId, cfFileId: cf.cfFileId, versionNumber: cf.versionNumber, sha1: m.sha1, size: m.size, url: cf.url, title: cf.title || m.title, icon: cf.icon, enabled: m.enabled });
    } else {
      stillManual.push({ path: m.path, sha1: m.sha1, size: m.size, title: m.title, enabled: m.enabled });
    }
  }
  for (const d of local.filter((f) => f.dir)) stillManual.push({ path: d.path, dir: true, title: d.base, enabled: true });

  let configs = [];
  let skipped = { large: 0, binary: 0, secret: 0, limit: 0 };
  let configBytes = 0;
  if (opts.includeConfigs !== false || opts.includeOptions) {
    const res = await files.collectConfigs(inst.dir, { includeOptions: Boolean(opts.includeOptions) });
    configs = opts.includeConfigs === false ? res.configs.filter((c) => files.OPTION_FILES.includes(c.path)) : res.configs;
    skipped = res.skipped;
    configBytes = configs.reduce((a, c) => a + Buffer.byteLength(c.content, 'utf8'), 0);
  }

  return {
    format: FORMAT,
    name: cleanText(inst.name, 60) || 'Modpack',
    mcVersion: inst.mcVersion,
    loader: inst.loader,
    loaderVersion: inst.loader === 'vanilla' ? null : inst.loaderVersion || null,
    preset: inst.preset === 'iris' ? 'iris' : null,
    icon: iconUrl(inst.icon),
    files: entries.sort((a, b) => a.path.localeCompare(b.path)),
    manual: stillManual.sort((a, b) => a.path.localeCompare(b.path)),
    configs,
    createdAt: Date.now(),
    generator: 'venus-launcher',
    skipped,
    configBytes,
  };
}

// ---------- Normalizar (manifiestos que vienen de afuera) ----------

function normalizeFile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = files.parseContentPath(raw.path);
  if (!parsed || !SHA1_RE.test(raw.sha1 || '')) return null;
  const source = raw.source === 'curseforge' ? 'curseforge' : 'modrinth';
  const url = allowedDownload(source, raw.url);
  const base = {
    path: `${parsed.folder}/${parsed.base}`,
    source,
    sha1: raw.sha1,
    size: sizeOf(raw.size),
    url,
    title: cleanText(raw.title, 120) || parsed.base,
    icon: iconUrl(raw.icon),
    versionNumber: cleanText(raw.versionNumber, 60),
    enabled: raw.enabled !== false,
  };
  if (source === 'modrinth') {
    if (!MR_ID.test(raw.projectId || '')) return null;
    return { ...base, projectId: raw.projectId, versionId: MR_ID.test(raw.versionId || '') ? raw.versionId : null, key: `mr:${raw.projectId}` };
  }
  const cfProjectId = Number(raw.cfProjectId);
  const cfFileId = Number(raw.cfFileId);
  if (!Number.isInteger(cfProjectId) || cfProjectId <= 0 || !url) return null;
  return { ...base, cfProjectId, cfFileId: Number.isInteger(cfFileId) && cfFileId > 0 ? cfFileId : null, key: `cf:${cfProjectId}` };
}

function normalizeManual(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.dir) {
    const parts = typeof raw.path === 'string' ? raw.path.replace(/\\/g, '/').split('/') : [];
    if (parts.length !== 2 || !['resourcepacks', 'shaderpacks'].includes(parts[0]) || !files.validSegment(parts[1])) return null;
    return { path: parts.join('/'), dir: true, title: cleanText(raw.title, 120) || parts[1], enabled: true };
  }
  const parsed = files.parseContentPath(raw.path);
  if (!parsed) return null;
  return {
    path: `${parsed.folder}/${parsed.base}`,
    sha1: SHA1_RE.test(raw.sha1 || '') ? raw.sha1 : null,
    size: sizeOf(raw.size),
    title: cleanText(raw.title, 120) || parsed.base,
    enabled: raw.enabled !== false,
  };
}

function decodeConfigs(b64) {
  if (typeof b64 !== 'string' || b64.length > MAX_ENCODED * 2) throw new Error(t('share.errBadManifest'));
  try {
    const raw = zlib.gunzipSync(Buffer.from(b64, 'base64'), { maxOutputLength: files.CONFIG_MAX_TOTAL * 3 });
    const list = JSON.parse(raw.toString('utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    throw new Error(t('share.errBadManifest'));
  }
}

function normalizeConfigs(list) {
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    if (out.length >= files.CONFIG_MAX_FILES) break;
    if (!raw || typeof raw !== 'object' || typeof raw.content !== 'string') continue;
    const parsed = files.parseConfigPath(raw.path);
    if (!parsed || seen.has(parsed.path.toLowerCase())) continue;
    const size = Buffer.byteLength(raw.content, 'utf8');
    if (size > files.CONFIG_MAX_FILE || total + size > files.CONFIG_MAX_TOTAL || raw.content.includes('\u0000')) continue;
    seen.add(parsed.path.toLowerCase());
    total += size;
    out.push({ path: parsed.path, content: raw.content });
  }
  return out;
}

/** Valida y limpia un manifiesto (acepta la forma comprimida con configsGz). Lanza si no sirve. */
function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t('share.errBadManifest'));
  if (raw.format !== undefined && Number(raw.format) > FORMAT) throw new Error(t('share.errNewerFormat'));
  const mcVersion = typeof raw.mcVersion === 'string' ? raw.mcVersion.trim() : '';
  if (!VERSION_RE.test(mcVersion) || mcVersion === '.' || mcVersion === '..') throw new Error(t('share.errBadManifest'));
  const loader = instances.LOADER_KINDS.includes(raw.loader) ? raw.loader : null;
  if (!loader) throw new Error(t('share.errBadManifest'));
  const loaderVersion = typeof raw.loaderVersion === 'string' && VERSION_RE.test(raw.loaderVersion.trim()) ? raw.loaderVersion.trim() : null;

  const seenPath = new Set();
  const seenKey = new Set();
  const outFiles = [];
  for (const f of (Array.isArray(raw.files) ? raw.files : []).slice(0, MAX_ENTRIES)) {
    const n = normalizeFile(f);
    if (!n || seenPath.has(n.path.toLowerCase()) || seenKey.has(`${n.path.split('/')[0]}|${n.key}`)) continue;
    seenPath.add(n.path.toLowerCase());
    seenKey.add(`${n.path.split('/')[0]}|${n.key}`);
    outFiles.push(n);
  }
  const outManual = [];
  for (const f of (Array.isArray(raw.manual) ? raw.manual : []).slice(0, MAX_ENTRIES)) {
    const n = normalizeManual(f);
    if (!n || seenPath.has(n.path.toLowerCase())) continue;
    seenPath.add(n.path.toLowerCase());
    outManual.push(n);
  }
  const configs = normalizeConfigs(raw.configsGz ? decodeConfigs(raw.configsGz) : raw.configs);
  return {
    format: FORMAT,
    name: cleanText(raw.name, 60) || 'Modpack',
    mcVersion,
    loader,
    loaderVersion: loader === 'vanilla' ? null : loaderVersion,
    preset: raw.preset === 'iris' ? 'iris' : null,
    icon: iconUrl(raw.icon),
    files: outFiles,
    manual: outManual,
    configs,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : null,
  };
}

/** Forma compacta para guardar en la nube: las configs van comprimidas (gzip + base64). */
function encodeManifest(raw) {
  const m = normalizeManifest(raw);
  const { configs, ...rest } = m;
  const out = { ...rest, files: m.files.map(({ key: _k, ...f }) => f) };
  if (configs.length) out.configsGz = zlib.gzipSync(Buffer.from(JSON.stringify(configs), 'utf8'), { level: 9 }).toString('base64');
  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  if (bytes > MAX_ENCODED) throw new Error(t('share.errTooLarge'));
  return { manifest: out, bytes };
}

module.exports = {
  FORMAT,
  MAX_ENCODED,
  lookupHashes,
  buildManifest,
  normalizeManifest,
  encodeManifest,
  decodeConfigs,
  allowedDownload,
  cleanText,
  httpsUrl,
  iconUrl,
};
