'use strict';
// Análisis de seguridad de mods y plugins (módulo "analysis").
//  - security:scan({ instanceId } | { serverId }, opts) -> resultado completo (tarea con progreso)
//  - security:results(target) -> último resultado guardado (sin volver a leer los jars) o null
//  - security:quarantine(target, archivo) / security:restore(target, id) / security:quarantined(target)
//  - security:discard(target, id) -> manda a la papelera un archivo en cuarentena
//  - security:remove(target, archivo) -> manda a la papelera un mod o plugin
// Cada jar se identifica por SHA-1 (+ SHA-512 para confirmar con Modrinth) y su análisis queda en
// data/security-cache.json. Antes de jugar se avisa de los riesgos altos y se frena el inicio solo si hay
// malware confirmado (siempre con la cache: nunca demora el arranque).
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const paths = require('../core/paths');
const instances = require('../core/instances');
const tasks = require('../core/tasks');
const { t } = require('../core/i18n');
const { readJson, writeJson, exists, uid, hashFile } = require('../core/util');
const scanner = require('./jarscan/security-scan');
const { writeCompactJson } = require('./jarscan/store');
const syscheck = require('./jarscan/syscheck');

const CACHE_VERSION = 1;
const MAX_JARS = 4000;
const FILE_TTL = 120 * 24 * 3600 * 1000;
const VERIFIED_TTL = 7 * 24 * 3600 * 1000;
const UNKNOWN_TTL = 60 * 60 * 1000;
const MAX_SCAN_SIZE = 512 * 1024 * 1024;
const JAR_FILE = /\.(jar|zip)(\.disabled)?$/i;
const SEV_RANK = scanner.SEVERITY_RANK;
const HEURISTIC = new Set([
  'discord-webhook',
  'telegram-bot',
  'credential-stealer',
  'credential-paths',
  'session-exfil',
  'session-network',
  'remote-code',
  'exec-download',
  'hidden-payload',
  'hidden-strings',
  'paste-fetch',
  'ip-url',
]);

let emit = () => {};
let trashFn = null;

// ---------- Cache ----------

let cache = null;
let cacheLoading = null;
let saveTimer = null;
let saving = Promise.resolve();

const cacheFile = () => paths.data('security-cache.json');

async function loadCache() {
  if (cache) return cache;
  if (!cacheLoading) {
    cacheLoading = readJson(cacheFile(), null).then((c) => {
      cache = c && c.v === CACHE_VERSION ? c : { v: CACHE_VERSION, jars: {}, verify: {}, files: {}, targets: {} };
      for (const k of ['jars', 'verify', 'files', 'targets']) if (!cache[k] || typeof cache[k] !== 'object') cache[k] = {};
      return cache;
    });
  }
  return cacheLoading;
}

function prune(c) {
  const now = Date.now();
  for (const [k, f] of Object.entries(c.files)) if (!f || now - (f.seen || 0) > FILE_TTL) delete c.files[k];
  const jars = Object.entries(c.jars);
  if (jars.length > MAX_JARS) {
    jars.sort((a, b) => (a[1].seen || 0) - (b[1].seen || 0));
    for (const [sha1] of jars.slice(0, jars.length - MAX_JARS)) {
      delete c.jars[sha1];
      delete c.verify[sha1];
    }
  }
}

// Guarda la cache un rato después del último cambio. Todos los que esperan se liberan con la misma escritura.
let waiters = [];
function saveSoon(delay = 400) {
  clearTimeout(saveTimer);
  return new Promise((resolve) => {
    waiters.push(resolve);
    saveTimer = setTimeout(() => {
      const batch = waiters;
      waiters = [];
      saving = saving
        .then(async () => {
          if (!cache) return;
          prune(cache);
          await writeCompactJson(cacheFile(), cache);
        })
        .catch((err) => console.warn('[security] no se pudo guardar la cache', err?.message || err))
        .then(() => batch.forEach((fn) => fn()));
    }, delay);
  });
}

const fileKey = (full) => path.resolve(full).toLowerCase();

// ---------- Objetivos (instancia o servidor) ----------

async function resolveTarget(target) {
  const tg = typeof target === 'string' ? { instanceId: target } : target && typeof target === 'object' ? target : {};
  if (typeof tg.instanceId === 'string' && tg.instanceId) {
    const inst = await instances.get(tg.instanceId).catch(() => null);
    if (!inst) throw new Error(t('analysis.errTarget'));
    return { kind: 'instance', id: inst.id, key: `instance:${inst.id}`, name: inst.name, dir: inst.dir, folders: ['mods'], loader: inst.loader, mcVersion: inst.mcVersion };
  }
  if (typeof tg.serverId === 'string' && tg.serverId) {
    const servers = require('../core/servers');
    const s = await servers.get(tg.serverId).catch(() => null);
    if (!s) throw new Error(t('analysis.errTarget'));
    const info = servers.typeInfo(s.type);
    const folders = info?.folders?.length ? info.folders : ['mods', 'plugins'];
    return { kind: 'server', id: s.id, key: `server:${s.id}`, name: s.name, dir: s.dir, folders, loader: s.type, mcVersion: s.mcVersion, running: s.state && s.state !== 'offline' };
  }
  throw new Error(t('analysis.errTarget'));
}

async function listJars(tg) {
  const out = [];
  for (const folder of tg.folders) {
    const dir = path.join(tg.dir, folder);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile() || !JAR_FILE.test(e.name)) continue;
      const full = path.join(dir, e.name);
      const st = await fsp.stat(full).catch(() => null);
      if (!st) continue;
      out.push({ file: e.name, folder, full, enabled: !/\.disabled$/i.test(e.name), size: st.size, mtime: Math.round(st.mtimeMs) });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

// ---------- Verificación de origen (Modrinth + CurseForge) ----------

function curseforge() {
  try {
    const cf = require('./curseforge');
    return cf && typeof cf.available === 'function' ? cf : null;
  } catch {
    return null;
  }
}

function verifyStale(v) {
  if (!v) return true;
  const age = Date.now() - (v.at || 0);
  if (v.source) return age > VERIFIED_TTL;
  return age > UNKNOWN_TTL;
}

async function cfAvailable(cf) {
  if (!cf) return false;
  try {
    return Boolean(await cf.available());
  } catch {
    return false;
  }
}

async function verifyAll(items, c, { force = false, signal } = {}) {
  const cf = curseforge();
  const cfOk = await cfAvailable(cf);
  const pending = items.filter((it) => force || verifyStale(c.verify[it.sha1]) || (cfOk && !c.verify[it.sha1]?.source && !c.verify[it.sha1]?.curseforge));
  if (!pending.length) return { offline: false, curseforge: cfOk };
  let offline = false;
  const results = new Map(); // sha1 -> { source, project }
  // Modrinth: version_files por SHA-1 (de a 100) y confirmación con el SHA-512 del archivo de la versión.
  try {
    const modrinth = require('../core/modrinth');
    const found = {};
    for (let i = 0; i < pending.length; i += 100) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      const chunk = pending.slice(i, i + 100);
      const res = await modrinth.api('/version_files', { method: 'POST', body: { hashes: chunk.map((x) => x.sha1), algorithm: 'sha1' } });
      Object.assign(found, res || {});
    }
    const projectIds = [...new Set(Object.values(found).map((v) => v?.project_id).filter(Boolean))];
    const projects = projectIds.length ? await modrinth.getProjects(projectIds).catch(() => []) : [];
    const byId = new Map(projects.map((p) => [p.id, p]));
    for (const it of pending) {
      const v = found[it.sha1];
      if (!v) continue;
      const file = (v.files || []).find((f) => f?.hashes?.sha1 === it.sha1);
      const h512 = c.jars[it.sha1]?.h512;
      if (file?.hashes?.sha512 && h512 && file.hashes.sha512 !== h512) continue; // SHA-1 igual pero contenido distinto: no se confía
      const p = byId.get(v.project_id);
      results.set(it.sha1, {
        source: 'modrinth',
        project: {
          id: v.project_id,
          versionId: v.id,
          versionNumber: v.version_number || '',
          title: p?.title || '',
          slug: p?.slug || '',
          icon: p?.icon_url || null,
          type: p?.project_type || null,
        },
      });
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    offline = true;
    console.warn('[security] Modrinth no respondió:', err?.message || err);
  }
  // CurseForge (si el usuario configuró su API key): huellas de lo que Modrinth no conoce.
  if (cfOk) {
    const rest = pending.filter((it) => !results.has(it.sha1));
    try {
      const prints = [];
      for (const it of rest) {
        const entry = c.jars[it.sha1];
        if (entry && typeof entry.cf !== 'number') entry.cf = await cf.fingerprintFile(it.full);
        if (entry && typeof entry.cf === 'number') prints.push(entry.cf);
      }
      if (prints.length) {
        const res = await cf.fingerprintMatches(prints);
        const matches = new Map();
        for (const m of res?.exactMatches || []) if (m?.file?.fileFingerprint !== undefined) matches.set(Number(m.file.fileFingerprint), m);
        const modIds = [...new Set([...matches.values()].map((m) => m.id || m.file?.modId).filter(Boolean))];
        const mods = modIds.length ? await cf.getMods(modIds).catch(() => []) : [];
        const modById = new Map((Array.isArray(mods) ? mods : []).map((m) => [m.id, m]));
        for (const it of rest) {
          const fp = c.jars[it.sha1]?.cf;
          const m = matches.get(fp);
          if (!m) continue;
          const mod = modById.get(m.id || m.file?.modId);
          results.set(it.sha1, {
            source: 'curseforge',
            project: {
              id: String(m.id || m.file?.modId || ''),
              versionId: String(m.file?.id || ''),
              versionNumber: m.file?.displayName || '',
              title: mod?.name || m.file?.displayName || '',
              slug: mod?.slug || '',
              icon: mod?.logo?.thumbnailUrl || null,
              url: mod?.links?.websiteUrl || null,
            },
          });
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('[security] CurseForge no respondió:', err?.message || err);
    }
  }
  const now = Date.now();
  for (const it of pending) {
    const r = results.get(it.sha1);
    if (r) c.verify[it.sha1] = { at: now, ...r, curseforge: cfOk };
    else if (!offline) c.verify[it.sha1] = { at: now, source: null, curseforge: cfOk };
  }
  return { offline, curseforge: cfOk };
}

// ---------- Resultados ----------

const SEV_DOWN = { high: 'medium', medium: 'info' };

// Hallazgos efectivos: los heurísticos de un archivo verificado bajan un nivel (las firmas de malware nunca).
function effectiveFindings(findings, verified) {
  return (findings || []).map((f) => {
    if (verified && HEURISTIC.has(f.rule) && SEV_DOWN[f.severity]) return { ...f, severity: SEV_DOWN[f.severity], downgraded: true };
    return f;
  });
}

function listText(arr, prefix) {
  const words = (arr || []).map((k) => t(`analysis.${prefix}${k}`));
  if (words.length <= 1) return words[0] || '';
  return t('analysis.and', { a: words.slice(0, -1).join(', '), b: words[words.length - 1] });
}

function ruleVars(f) {
  const v = { ...(f.vars || {}) };
  if (Array.isArray(v.kinds)) v.kinds = listText(v.kinds, f.rule === 'hidden-payload' ? 'payload_' : 'kind_');
  return v;
}

function translate(f) {
  const vars = ruleVars(f);
  return {
    rule: f.rule,
    severity: f.severity,
    confirmed: Boolean(f.confirmed),
    downgraded: Boolean(f.downgraded),
    title: t(`analysis.rule_${f.rule}_title`, vars),
    text: t(`analysis.rule_${f.rule}_text`, vars),
    evidence: (f.evidence || []).slice(0, 6),
  };
}

function worst(findings) {
  let best = null;
  for (const f of findings) if (!best || SEV_RANK[f.severity] > SEV_RANK[best]) best = f.severity;
  return best;
}

function fileResult(it, c) {
  const entry = c.jars[it.sha1] || null;
  const v = c.verify[it.sha1] || null;
  const verified = Boolean(v?.source);
  const findings = effectiveFindings(entry?.findings, verified).map(translate);
  return {
    file: it.file,
    folder: it.folder,
    enabled: it.enabled,
    size: it.size,
    sha1: it.sha1,
    mod: entry?.meta || null,
    verified: verified ? { source: v.source, ...v.project } : null,
    verifyState: verified ? 'verified' : v ? 'unknown' : 'offline',
    findings,
    severity: worst(findings),
    confirmed: findings.some((f) => f.severity === 'critical' && f.confirmed),
    stats: entry?.stats || null,
  };
}

function summarize(files, system) {
  const by = { critical: 0, high: 0, medium: 0, info: 0 };
  let verified = 0;
  let unknown = 0;
  let offline = 0;
  for (const f of files) {
    if (f.severity) by[f.severity]++;
    if (f.verifyState === 'verified') verified++;
    else if (f.verifyState === 'unknown') unknown++;
    else offline++;
  }
  const systemBad = (system?.findings || []).length;
  return {
    total: files.length,
    verified,
    unknown,
    offline,
    bySeverity: by,
    system: systemBad,
    clean: !by.critical && !by.high && !by.medium && !systemBad,
  };
}

async function quarantineIndex(tg) {
  const file = path.join(tg.dir, '.venus', 'quarantine', 'index.json');
  const idx = await readJson(file, null);
  return { file, items: Array.isArray(idx?.items) ? idx.items : [] };
}

async function quarantinedList(tg, c) {
  const { items } = await quarantineIndex(tg);
  const out = [];
  for (const q of items) {
    const stored = path.join(tg.dir, '.venus', 'quarantine', q.stored);
    if (!(await exists(stored))) continue;
    const entry = c?.jars?.[q.sha1];
    const v = c?.verify?.[q.sha1];
    const findings = effectiveFindings(entry?.findings, Boolean(v?.source)).map(translate);
    out.push({ ...q, mod: entry?.meta || null, severity: worst(findings), findings });
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

async function buildResult(tg, items, c, system, extra = {}) {
  const files = items.map((it) => fileResult(it, c));
  const order = (f) => (SEV_RANK[f.severity] || 0) * 10 + (f.confirmed ? 5 : 0) + (f.verifyState === 'verified' ? 0 : 1);
  files.sort((a, b) => order(b) - order(a) || a.file.localeCompare(b.file));
  const sys = system ? { checked: Boolean(system.checked), at: system.at || null, platform: system.platform, findings: (system.findings || []).map(translate) } : null;
  return {
    target: { kind: tg.kind, id: tg.id, name: tg.name, loader: tg.loader, mcVersion: tg.mcVersion },
    scannedAt: extra.scannedAt || Date.now(),
    durationMs: extra.durationMs || 0,
    offline: Boolean(extra.offline),
    curseforge: Boolean(extra.curseforge),
    files,
    system: sys,
    summary: summarize(files, sys),
    quarantine: await quarantinedList(tg, c),
  };
}

// ---------- Escaneo ----------

const running = new Map(); // key -> promesa

function sha(buf, algo) {
  return crypto.createHash(algo).update(buf).digest('hex');
}

async function scanTarget(target, opts = {}) {
  const tg = await resolveTarget(target);
  if (running.has(tg.key)) return running.get(tg.key);
  // Sin instanceId en meta: si no, la interfaz mostraria la instancia como "instalando" y bloquearia Jugar.
  const p = tasks
    .run(t('analysis.taskSecurity', { name: tg.name }), (task) => doScan(tg, task, opts), { kind: 'analysis:security', analysisTarget: tg.key })
    .finally(() => running.delete(tg.key));
  running.set(tg.key, p);
  return p;
}

async function doScan(tg, task, { deep = false, force = false } = {}) {
  const started = Date.now();
  const c = await loadCache();
  const files = await listJars(tg);
  const items = [];
  const progress = (data) => {
    try {
      emit('security:progress', { target: tg.key, taskId: task?.id || null, ...data });
    } catch {
      /* ventana cerrada */
    }
  };
  progress({ phase: 'scan', done: 0, total: files.length });
  let done = 0;
  for (const f of files) {
    if (task?.signal?.aborted) throw task.signal.reason || new Error('aborted');
    task?.update({ detail: t('analysis.detailScanning', { file: f.file, done: done + 1, total: files.length }), progress: files.length ? (done / files.length) * 0.85 : 0 });
    progress({ phase: 'scan', done, total: files.length, file: f.file });
    if (f.size > MAX_SCAN_SIZE) {
      // Un jar de este tamaño no es un mod normal: se identifica por hash pero no se abre entero en memoria.
      const sha1 = await hashFile(f.full, 'sha1').catch(() => null);
      if (sha1) {
        const now = Date.now();
        c.files[fileKey(f.full)] = { size: f.size, mtime: f.mtime, sha1, seen: now };
        if (!c.jars[sha1]) {
          c.jars[sha1] = {
            v: scanner.RULES_VERSION,
            at: now,
            size: f.size,
            meta: { loader: null, id: '', name: '', version: '' },
            findings: [{ rule: 'unreadable', severity: 'info', confirmed: false, evidence: [{ where: f.file, value: `> ${Math.round(MAX_SCAN_SIZE / 1048576)} MB` }], vars: {} }],
            stats: null,
            error: 'toobig',
          };
        }
        c.jars[sha1].seen = now;
        items.push({ ...f, sha1 });
      }
      done++;
      continue;
    }
    let buf;
    try {
      buf = await fsp.readFile(f.full);
    } catch {
      done++;
      continue;
    }
    const sha1 = sha(buf, 'sha1');
    const now = Date.now();
    c.files[fileKey(f.full)] = { size: f.size, mtime: f.mtime, sha1, seen: now };
    let entry = c.jars[sha1];
    if (deep || !entry || entry.v !== scanner.RULES_VERSION) {
      const r = await scanner.analyzeJar(buf, { signal: task?.signal, hashes: { sha1 } });
      entry = { v: r.v, at: now, size: buf.length, h512: sha(buf, 'sha512'), meta: r.meta, findings: r.findings, stats: r.stats, error: r.error || null, cf: entry?.cf };
      c.jars[sha1] = entry;
    } else if (!entry.h512) entry.h512 = sha(buf, 'sha512');
    entry.seen = now;
    buf = null;
    items.push({ ...f, sha1 });
    done++;
  }
  progress({ phase: 'verify', done, total: files.length });
  task?.update({ detail: t('analysis.detailVerify'), progress: 0.9 });
  const ver = await verifyAll(items, c, { force, signal: task?.signal });
  progress({ phase: 'system', done, total: files.length });
  task?.update({ detail: t('analysis.detailSystem'), progress: 0.96 });
  const system = await syscheck.check().catch(() => ({ checked: false, findings: [] }));
  c.targets[tg.key] = { at: Date.now(), files: items.map(({ file, folder, enabled, size, mtime, sha1 }) => ({ file, folder, enabled, size, mtime, sha1 })), system, offline: ver.offline, curseforge: ver.curseforge };
  await saveSoon(0);
  const result = await buildResult(tg, items, c, system, { scannedAt: Date.now(), durationMs: Date.now() - started, offline: ver.offline, curseforge: ver.curseforge });
  progress({ phase: 'done', done, total: files.length });
  return result;
}

// Último resultado guardado, con las traducciones del idioma actual. changed: la carpeta cambió desde entonces.
async function lastResult(target) {
  const tg = await resolveTarget(target);
  const c = await loadCache();
  const saved = c.targets[tg.key];
  if (!saved) return null;
  const items = (saved.files || []).filter((f) => c.jars[f.sha1]);
  const result = await buildResult(tg, items, c, saved.system, { scannedAt: saved.at, offline: saved.offline, curseforge: saved.curseforge });
  const now = await listJars(tg);
  const sig = (list) => list.map((f) => `${f.folder}/${f.file}|${f.size}|${f.mtime}`).sort().join('\n');
  result.changed = sig(now) !== sig(saved.files || []);
  return result;
}

// ---------- Cuarentena ----------

function parseRel(tg, rel) {
  const raw = typeof rel === 'string' ? rel.replace(/\\/g, '/') : '';
  const parts = raw.split('/').filter(Boolean);
  let folder = tg.folders[0];
  let file = raw;
  if (parts.length === 2) [folder, file] = parts;
  else if (parts.length !== 1) throw new Error(t('analysis.errFile'));
  if (!tg.folders.includes(folder)) throw new Error(t('analysis.errFile'));
  if (!file || file !== path.basename(file) || file === '.' || file === '..' || /[<>:"|?*\x00-\x1f]/.test(file) || !JAR_FILE.test(file)) {
    throw new Error(t('analysis.errFile'));
  }
  return { folder, file };
}

function assertStopped(tg) {
  if (tg.kind === 'instance') {
    const game = require('../core/game');
    if (game.status()[tg.id]) throw new Error(t('analysis.errRunning'));
  } else if (tg.running) throw new Error(t('analysis.errServerRunning'));
}

async function writeIndex(file, items) {
  await writeJson(file, { v: 1, items });
}

async function quarantine(target, rel, safePath) {
  const tg = await resolveTarget(target);
  assertStopped(tg);
  const { folder, file } = parseRel(tg, rel);
  const src = safePath(path.join(tg.dir, folder, file));
  if (!(await exists(src))) throw new Error(t('analysis.errMissing', { file }));
  const qdir = path.join(tg.dir, '.venus', 'quarantine');
  await fsp.mkdir(qdir, { recursive: true });
  const id = uid(12);
  const stored = `${id}-${file}`;
  const dest = safePath(path.join(qdir, stored));
  const c = await loadCache();
  const rec = c.files[fileKey(src)];
  const st = await fsp.stat(src);
  let sha1 = rec && rec.size === st.size && rec.mtime === Math.round(st.mtimeMs) ? rec.sha1 : null;
  if (!sha1) sha1 = sha(await fsp.readFile(src), 'sha1');
  try {
    await fsp.rename(src, dest);
  } catch {
    await fsp.copyFile(src, dest);
    await fsp.rm(src, { force: true });
  }
  const entry = c.jars[sha1];
  const { file: indexFile, items } = await quarantineIndex(tg);
  const item = {
    id,
    file,
    folder,
    stored,
    sha1,
    size: st.size,
    at: Date.now(),
    severity: worst(effectiveFindings(entry?.findings, Boolean(c.verify[sha1]?.source))),
    rules: (entry?.findings || []).map((f) => f.rule).slice(0, 8),
  };
  items.push(item);
  await writeIndex(indexFile, items);
  emit('instances:changed');
  return item;
}

async function restore(target, id, safePath) {
  const tg = await resolveTarget(target);
  assertStopped(tg);
  const { file: indexFile, items } = await quarantineIndex(tg);
  const item = items.find((q) => q.id === id);
  if (!item) throw new Error(t('analysis.errQuarantineMissing'));
  const stored = safePath(path.join(tg.dir, '.venus', 'quarantine', item.stored));
  if (!(await exists(stored))) {
    await writeIndex(indexFile, items.filter((q) => q.id !== id));
    throw new Error(t('analysis.errQuarantineMissing'));
  }
  const { folder, file } = parseRel(tg, `${item.folder}/${item.file}`);
  const dest = safePath(path.join(tg.dir, folder, file));
  if (await exists(dest)) throw new Error(t('analysis.errRestoreExists', { file }));
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(stored, dest);
  } catch {
    await fsp.copyFile(stored, dest);
    await fsp.rm(stored, { force: true });
  }
  await writeIndex(indexFile, items.filter((q) => q.id !== id));
  emit('instances:changed');
  return { file, folder };
}

async function trash(target) {
  if (trashFn) {
    try {
      await trashFn(target);
      return;
    } catch {
      /* sin papelera: se borra */
    }
  }
  await fsp.rm(target, { force: true });
}

// Saca del registro de Modrinth de la instancia el proyecto de un archivo borrado.
async function forgetRecord(tg, folder, file) {
  if (tg.kind !== 'instance') return;
  try {
    const inst = await instances.get(tg.id);
    const projects = { ...(inst.modrinth?.projects || {}) };
    const base = file.replace(/\.disabled$/i, '');
    let changed = false;
    for (const [pid, rec] of Object.entries(projects)) {
      if (rec?.file === base && (!rec.folder || String(rec.folder).replace(/\\/g, '/') === folder)) {
        delete projects[pid];
        changed = true;
      }
    }
    if (changed) await instances.update(tg.id, { modrinth: { ...(inst.modrinth || {}), projects } });
  } catch {
    /* la instancia pudo cambiar */
  }
}

async function discard(target, id, safePath) {
  const tg = await resolveTarget(target);
  const { file: indexFile, items } = await quarantineIndex(tg);
  const item = items.find((q) => q.id === id);
  if (!item) throw new Error(t('analysis.errQuarantineMissing'));
  const stored = safePath(path.join(tg.dir, '.venus', 'quarantine', item.stored));
  if (await exists(stored)) await trash(stored);
  await writeIndex(indexFile, items.filter((q) => q.id !== id));
  await forgetRecord(tg, item.folder, item.file);
  return true;
}

async function removeFile(target, rel, safePath) {
  const tg = await resolveTarget(target);
  assertStopped(tg);
  const { folder, file } = parseRel(tg, rel);
  if (tg.kind === 'instance') {
    await instances.deleteFile(tg.id, folder, file);
  } else {
    const full = safePath(path.join(tg.dir, folder, file));
    if (!(await exists(full))) throw new Error(t('analysis.errMissing', { file }));
    await trash(full);
  }
  emit('instances:changed');
  return true;
}

// ---------- Antes de jugar ----------

async function beforeLaunch({ instance, settings: s }) {
  try {
    if ((s?.analysis || {}).launchSecurity === false) return null;
    const c = await loadCache();
    const files = (await listJars({ dir: instance.dir, folders: ['mods'] })).filter((f) => f.enabled);
    const blocks = [];
    const warnings = [];
    for (const f of files) {
      const rec = c.files[fileKey(f.full)];
      if (!rec || rec.size !== f.size || rec.mtime !== f.mtime) continue; // sin analizar: no se demora el arranque
      const entry = c.jars[rec.sha1];
      if (!entry) continue;
      const findings = effectiveFindings(entry.findings, Boolean(c.verify[rec.sha1]?.source));
      const confirmed = findings.find((x) => x.severity === 'critical' && x.confirmed);
      if (confirmed) {
        blocks.push({ file: f.file, f: confirmed });
        continue;
      }
      const risky = findings.find((x) => x.severity === 'critical' || x.severity === 'high');
      if (risky) warnings.push({ file: f.file, f: risky });
    }
    if (blocks.length) {
      const first = blocks[0];
      return { block: true, message: t('analysis.launchBlocked', { count: blocks.length, file: first.file, title: translate(first.f).title }) };
    }
    if (!warnings.length) return null;
    const out = warnings.slice(0, 2).map((w) => t('analysis.launchWarn', { file: w.file, title: translate(w.f).title }));
    if (warnings.length > 2) out.push(t('analysis.launchWarnMore', { count: warnings.length - 2 }));
    return { warnings: out };
  } catch (err) {
    console.warn('[security] chequeo previo', err?.message || err);
    return null;
  }
}

// ---------- Registro ----------

function register({ handle, send, safePath }) {
  emit = (channel, ...args) => {
    try {
      send(channel, ...args);
    } catch {
      /* ventana cerrada */
    }
  };
  try {
    const { shell } = require('electron');
    trashFn = (p) => shell.trashItem(p);
  } catch {
    trashFn = null;
  }
  handle('security:scan', (target, opts = {}) => scanTarget(target, { deep: Boolean(opts?.deep), force: Boolean(opts?.force) }));
  handle('security:results', (target) => lastResult(target));
  handle('security:quarantine', (target, file) => quarantine(target, file, safePath));
  handle('security:restore', (target, id) => restore(target, String(id || ''), safePath));
  handle('security:discard', (target, id) => discard(target, String(id || ''), safePath));
  handle('security:remove', (target, file) => removeFile(target, file, safePath));
  handle('security:quarantined', async (target) => quarantinedList(await resolveTarget(target), await loadCache()));
  handle('security:system', () => syscheck.check().then((r) => ({ ...r, findings: r.findings.map(translate) })));
  try {
    require('../core/game').addBeforeLaunch(beforeLaunch);
  } catch (err) {
    console.warn('[security] sin chequeo previo al lanzamiento', err?.message || err);
  }
}

module.exports = {
  register,
  scanTarget,
  lastResult,
  quarantine,
  restore,
  discard,
  removeFile,
  beforeLaunch,
  effectiveFindings,
  // para pruebas
  _internal: { listJars, resolveTarget, loadCache, verifyAll, buildResult, parseRel, translate, resetCache: () => ((cache = null), (cacheLoading = null)) },
};
