'use strict';
// Actualizaciones de mods, resource packs y shaders de una instancia: qué hay de nuevo para su versión y
// loader, changelog resumido de las versiones intermedias, tamaño y pistas de riesgo. Al aplicarlas se
// descargan primero (verificadas), después se reemplazan y lo viejo queda en el historial para volver atrás.
const path = require('path');
const fsp = require('fs/promises');
const http = require('../../core/http');
const { exists } = require('../../core/util');
const { t } = require('../../core/i18n');
const api = require('./api');
const inventory = require('./inventory');
const targets = require('./target');
const history = require('./history');
const V = require('./versions');
const { pickBest, primaryFile, isCompatible } = require('./check');

const IRIS = 'YL57xq9U';
const OCULUS = 'GchcoXML';
const MAX_CHANGELOG_VERSIONS = 8;
const MAX_CHANGELOG_CHARS = 2400;
const TYPE_BY_FOLDER = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader' };
const LEVEL = { high: 3, medium: 2, low: 1, info: 0 };

const RISK_PATTERNS = [
  {
    code: 'newWorld',
    level: 'high',
    re: /\b(requires?|needs?)\s+(a\s+)?(new|fresh)\s+worlds?\b|\b(new|fresh)\s+worlds?\s+(is\s+|are\s+)?(required|needed|recommended)\b|\b(reset|regenerate|delete)\s+(your\s+)?(worlds?|chunks)\b|\bnot\s+compatible\s+with\s+(old|existing|previous)\s+worlds?\b|\bworld\s+corruption\b/i,
  },
  { code: 'breaking', level: 'high', re: /\bbreaking\b|\bincompatib\w*/i },
  { code: 'migration', level: 'medium', re: /\bmigrat\w*/i },
  // "world" solo cuenta si la linea no habla de rendimiento o de como se dibuja el mundo
  { code: 'world', level: 'low', re: /\bworlds?\b/i, exclude: /render|fps|frame|perform|cull|lighting|shader|stutter|latency|\blag/i },
];

// Primera linea del texto que coincide con el patron (y no con su exclusion): { index, line }
function findLine(text, pat) {
  const src = String(text || '');
  let offset = 0;
  for (const line of src.split('\n')) {
    const m = pat.re.exec(line);
    if (m && !(pat.exclude && pat.exclude.test(line))) return { index: offset + m.index, src };
    offset += line.length + 1;
  }
  return null;
}

function snippet(text, pat) {
  const hit = findLine(text, pat);
  if (!hit) return null;
  const { src } = hit;
  const start = src.lastIndexOf('\n', hit.index) + 1;
  const endNl = src.indexOf('\n', hit.index);
  let line = src.slice(start, endNl < 0 ? src.length : endNl);
  const rel = hit.index - start;
  line = line.replace(/!\[[^\]]*]\([^)]*\)/g, '').replace(/\[([^\]]*)]\([^)]*\)/g, '$1');
  line = line.replace(/^[\s>*#+-]+/, '').replace(/[*_`~]/g, '').trim();
  if (line.length > 180) {
    const from = Math.max(0, Math.min(rel, line.length) - 70);
    line = `${from > 0 ? '…' : ''}${line.slice(from, from + 170).trim()}…`;
  }
  return line || null;
}

function trimChangelog(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (s.length <= MAX_CHANGELOG_CHARS) return { body: s, truncated: false };
  const cut = s.lastIndexOf('\n', MAX_CHANGELOG_CHARS);
  return { body: s.slice(0, cut > MAX_CHANGELOG_CHARS * 0.6 ? cut : MAX_CHANGELOG_CHARS).trim(), truncated: true };
}

async function pool(items, size, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

// Loaders que se usan para buscar actualizaciones de cada carpeta
function loadersByFolder(target, inv) {
  const has = (pid, modId) => (inv.byProject.get(pid) || []).some((f) => f.enabled) || (inv.byModId.get(modId) || []).some((f) => f.enabled);
  let shader = ['iris', 'optifine'];
  if (target.loader === 'optifine' || inv.files.some((f) => f.folder === 'mods' && f.enabled && /optifine/i.test(f.file))) shader = ['optifine'];
  else if (target.preset === 'iris' || has(IRIS, 'iris') || has(OCULUS, 'oculus')) shader = ['iris'];
  return { mods: target.modLoaders, resourcepacks: ['minecraft'], shaderpacks: shader };
}

function computeRisks(f, target, between, installedIds) {
  const risks = [];
  const gv = [...new Set([...(f.version.game_versions || []), ...(target.game_versions || [])])];
  const from = V.versionCore(f.version.version_number, gv);
  const to = V.versionCore(target.version_number, gv);
  if (V.isMajorBump(from, to)) risks.push({ code: 'major', level: 'medium', from, to });
  if (target.version_type === 'alpha') risks.push({ code: 'alpha', level: 'medium' });
  else if (target.version_type === 'beta') risks.push({ code: 'beta', level: 'low' });
  for (const pat of RISK_PATTERNS) {
    if (pat.code === 'world' && risks.some((r) => r.code === 'newWorld')) continue;
    const hits = between.filter((v) => findLine(v.changelog, pat));
    if (hits.length) risks.push({ code: pat.code, level: pat.level, versions: hits.map((v) => v.version_number).slice(0, 3), snippet: snippet(hits[0].changelog, pat) });
  }
  const req = (v) => new Set((v.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id).map((d) => d.project_id));
  const before = req(f.version);
  const after = req(target);
  const added = [...after].filter((p) => !before.has(p) && !installedIds.has(p));
  const removed = [...before].filter((p) => !after.has(p));
  if (added.length) risks.push({ code: 'newDependency', level: 'low', projects: added });
  if (removed.length) risks.push({ code: 'removedDependency', level: 'info', projects: removed });
  const inc = (target.dependencies || []).filter((d) => d.dependency_type === 'incompatible' && d.project_id && installedIds.has(d.project_id));
  if (inc.length) risks.push({ code: 'conflict', level: 'high', projects: inc.map((d) => d.project_id) });
  return risks;
}

// opts: { includeBeta, onProgress({ phase, done, total }), signal }
async function listUpdates(instanceId, { includeBeta = false, onProgress, signal } = {}) {
  const target = await targets.load({ kind: 'instance', id: instanceId });
  const inv = await inventory.scan(target, { meta: false, signal, onProgress: (done, total) => onProgress?.({ phase: 'hash', done, total }) });
  const mc = target.mcVersion;
  const byFolder = loadersByFolder(target, inv);
  const identified = inv.files.filter((f) => f.version && f.sha1 && TYPE_BY_FOLDER[f.folder]);
  onProgress?.({ phase: 'check', done: 0, total: identified.length });
  const latest = {};
  for (const [folder, loaders] of Object.entries(byFolder)) {
    const hashes = identified.filter((f) => f.folder === folder).map((f) => f.sha1);
    if (!hashes.length || (folder === 'mods' && !loaders.length)) continue;
    Object.assign(latest, await api.latestByHash(hashes, { loaders, gameVersions: [mc], signal }));
  }
  const candidates = identified.filter((f) => {
    const l = latest[f.sha1];
    return l && l.id !== f.version.id && Date.parse(l.date_published) > Date.parse(f.version.date_published);
  });
  const pids = [...new Set(candidates.map((f) => f.projectId))];
  const versionsBy = new Map();
  let done = 0;
  await pool(pids, 4, async (pid) => {
    const f = candidates.find((c) => c.projectId === pid);
    const loaders = byFolder[f.folder];
    versionsBy.set(pid, await api.projectVersions(pid, { loaders: loaders?.length ? loaders : undefined, gameVersions: [mc], signal }).catch(() => []));
    onProgress?.({ phase: 'changelog', done: ++done, total: pids.length });
  });
  const installedIds = new Set(inv.files.filter((f) => f.enabled && f.projectId).map((f) => f.projectId));
  const items = [];
  let prereleaseHidden = 0;
  for (const f of candidates) {
    const all = versionsBy.get(f.projectId) || [];
    const curDate = Date.parse(f.version.date_published);
    const newer = all.filter((v) => v.id !== f.version.id && Date.parse(v.date_published) > curDate);
    let pick = newer;
    if (!includeBeta) {
      if (f.version.version_type === 'release') pick = newer.filter((v) => v.version_type === 'release');
      else if (f.version.version_type === 'beta') pick = newer.filter((v) => v.version_type !== 'alpha');
    }
    const next = pick[0];
    if (!next) {
      if (newer.length) prereleaseHidden++;
      continue;
    }
    const between = newer.filter((v) => Date.parse(v.date_published) <= Date.parse(next.date_published));
    const pf = primaryFile(next);
    const risks = computeRisks(f, next, between, installedIds);
    const riskLevel = risks.reduce((max, r) => (LEVEL[r.level] > LEVEL[max || 'info'] ? r.level : max), null);
    items.push({
      key: `${f.folder}/${f.file}`,
      folder: f.folder,
      file: f.file,
      disabled: !f.enabled,
      type: TYPE_BY_FOLDER[f.folder],
      projectId: f.projectId,
      title: f.title || null,
      icon: f.icon || null,
      slug: null,
      current: { versionId: f.version.id, versionNumber: f.version.version_number, type: f.version.version_type, date: f.version.date_published },
      latest: { versionId: next.id, versionNumber: next.version_number, type: next.version_type, date: next.date_published, filename: pf?.filename || null, size: pf?.size || 0 },
      changelog: between.slice(0, MAX_CHANGELOG_VERSIONS).map((v) => ({ id: v.id, number: v.version_number, type: v.version_type, date: v.date_published, ...trimChangelog(v.changelog) })),
      moreVersions: Math.max(0, between.length - MAX_CHANGELOG_VERSIONS),
      risks,
      riskLevel: riskLevel === 'info' ? null : riskLevel,
    });
  }
  // Nombres e iconos de los proyectos y de las dependencias mencionadas en los riesgos
  const depIds = items.flatMap((i) => i.risks.flatMap((r) => r.projects || []));
  const projects = await api.projects([...new Set([...items.map((i) => i.projectId), ...depIds])], { signal }).catch(() => ({}));
  for (const it of items) {
    const p = projects[it.projectId];
    if (p) {
      it.title = p.title || it.title;
      it.icon = p.icon_url || it.icon;
      it.slug = p.slug;
    }
    it.title = it.title || it.file;
    for (const r of it.risks) if (r.projects) r.names = r.projects.map((id) => projects[id]?.title || id);
  }
  items.sort((a, b) => (LEVEL[b.riskLevel] || 0) - (LEVEL[a.riskLevel] || 0) || a.title.localeCompare(b.title));
  inventory.flush().catch(() => {});
  return {
    instance: { id: target.id, name: target.name, mcVersion: mc, loader: target.loader },
    checkedAt: Date.now(),
    items,
    total: inv.files.length,
    identified: identified.length,
    unknown: inv.files.length - identified.length,
    prereleaseHidden,
    includeBeta,
  };
}

// ---------- Aplicar ----------
async function trySnapshot(instanceId) {
  let mod = null;
  try {
    mod = require('../snapshots');
  } catch {
    return null;
  }
  if (typeof mod?.create !== 'function') return null;
  try {
    return await mod.create(instanceId, { reason: t('compat.snapshotReason'), worlds: 'none' });
  } catch (err) {
    console.warn('[compat] No se pudo crear la instantánea:', err?.message || err);
    return null;
  }
}

// Dependencias obligatorias nuevas que no estan instaladas (hasta 2 niveles)
async function missingDeps(target, inv, versions, signal) {
  const need = new Map();
  const planned = new Set(versions.map((v) => v.project_id));
  let frontier = versions;
  for (let depth = 0; depth < 2 && frontier.length; depth++) {
    const next = [];
    for (const v of frontier) {
      for (const d of v.dependencies || []) {
        if (d.dependency_type !== 'required') continue;
        let pinned = d.version_id ? await api.version(d.version_id, { signal }) : null;
        const pid = d.project_id || pinned?.project_id;
        if (!pid || planned.has(pid) || need.has(pid)) continue;
        if ((inv.byProject.get(pid) || []).some((f) => f.enabled)) continue;
        if (!isCompatible(pinned, target.modLoaders, target.mcVersion)) pinned = pickBest(await api.projectVersions(pid, { loaders: target.modLoaders, gameVersions: [target.mcVersion], signal }));
        if (!pinned) continue;
        const file = primaryFile(pinned);
        if (!file) continue;
        need.set(pid, { projectId: pid, version: pinned, file, folder: 'mods' });
        next.push(pinned);
      }
    }
    frontier = next;
  }
  return [...need.values()];
}

function normalizeSelection(items) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const folder = it?.folder;
    const file = it?.file;
    const versionId = it?.versionId || it?.latest?.versionId;
    if (!TYPE_BY_FOLDER[folder] || !history.isSafeName(file) || typeof versionId !== 'string' || !/^\w{1,64}$/.test(versionId)) continue;
    const key = `${folder}/${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ folder, file, versionId });
  }
  return out;
}

// items: [{ folder, file, versionId }] (o los items que devuelve listUpdates)
async function applyUpdates(instanceId, items, { task } = {}) {
  const signal = task?.signal;
  const target = await targets.load({ kind: 'instance', id: instanceId });
  const sel = normalizeSelection(items);
  if (!sel.length) throw new Error(t('compat.errNothingSelected'));
  task?.update({ detail: t('compat.stepSnapshot'), progress: null });
  await trySnapshot(instanceId);
  task?.update({ detail: t('compat.stepResolve'), progress: 0.02 });
  const inv = await inventory.scan(target, { meta: false, signal });
  const vmap = await api.versions(sel.map((s) => s.versionId), { signal });
  const plans = [];
  const failed = [];
  for (const s of sel) {
    const f = inv.files.find((x) => x.folder === s.folder && x.file === s.file);
    const v = vmap[s.versionId];
    const pf = primaryFile(v);
    if (!f) failed.push({ file: s.file, error: t('compat.errFileGone') });
    else if (!v || !pf || (f.projectId && v.project_id !== f.projectId)) failed.push({ file: s.file, error: t('compat.errVersionGone') });
    else if (pf.hashes?.sha1 && pf.hashes.sha1 === f.sha1) continue;
    else plans.push({ f, v, pf });
  }
  const deps = await missingDeps(target, inv, plans.filter((p) => p.f.folder === 'mods').map((p) => p.v), signal);
  const projects = await api.projects([...plans.map((p) => p.v.project_id), ...deps.map((d) => d.projectId)], { signal }).catch(() => ({}));
  if (!plans.length && !deps.length) {
    if (failed.length) throw new Error(failed[0].error);
    return { updated: 0, added: 0, failed, batch: null };
  }

  // 1) Descargar todo a una carpeta temporal (si algo falla, la instancia queda como estaba)
  const batch = history.createBatch(target.dir, 'update');
  const staging = path.join(target.dir, '.venus', 'compat-staging', batch.id);
  const downloads = [
    ...plans.map((p) => ({ url: p.pf.url, path: path.join(staging, p.f.folder, p.pf.filename), sha1: p.pf.hashes?.sha1, sha512: p.pf.hashes?.sha1 ? undefined : p.pf.hashes?.sha512, size: p.pf.size })),
    ...deps.map((d) => ({ url: d.file.url, path: path.join(staging, d.folder, d.file.filename), sha1: d.file.hashes?.sha1, size: d.file.size })),
  ];
  try {
    await http.downloadAll(downloads, {
      concurrency: 4,
      verify: 'hash',
      signal,
      onProgress: task ? task.downloadProgress(t('compat.stepDownload'), 0.05, 0.85) : undefined,
    });

    // 2) Reemplazar: lo viejo va al historial, lo nuevo a su carpeta
    task?.update({ detail: t('compat.stepReplace'), progress: 0.9 });
    const applied = [];
    try {
      for (const p of plans) {
        const title = projects[p.v.project_id]?.title || p.f.title || p.f.name;
        const icon = projects[p.v.project_id]?.icon_url || p.f.icon || null;
        const entry = {
          id: history.nextEntryId(batch),
          kind: 'update',
          title,
          icon,
          folder: p.f.folder,
          old: { projectId: p.f.projectId, file: p.f.name, storedAs: null, versionId: p.f.versionId, versionNumber: p.f.versionNumber, disabled: !p.f.enabled, title },
          new: { projectId: p.v.project_id, file: p.pf.filename, versionId: p.v.id, versionNumber: p.v.version_number, disabled: !p.f.enabled, title },
          rolledBack: null,
        };
        batch.index.entries.push(entry);
        entry.old.storedAs = await history.stash(batch, p.f.folder, p.f.file);
        const destName = p.pf.filename + (p.f.enabled ? '' : '.disabled');
        if (await exists(path.join(target.dir, p.f.folder, destName))) {
          const storedAs = await history.stash(batch, p.f.folder, destName);
          batch.index.entries.push({ id: history.nextEntryId(batch), kind: 'replace', title: destName, icon: null, folder: p.f.folder, old: { projectId: null, file: history.strip(destName), storedAs, disabled: /\.disabled$/i.test(destName) }, new: null, rolledBack: null });
        }
        await history.moveFile(path.join(staging, p.f.folder, p.pf.filename), path.join(target.dir, p.f.folder, destName));
        entry.placed = true;
        applied.push(entry);
      }
      for (const d of deps) {
        const dest = path.join(target.dir, d.folder, d.file.filename);
        if (await exists(dest)) continue;
        const title = projects[d.projectId]?.title || d.file.filename;
        const entry = {
          id: history.nextEntryId(batch),
          kind: 'add',
          title,
          icon: projects[d.projectId]?.icon_url || null,
          folder: d.folder,
          old: null,
          new: { projectId: d.projectId, file: d.file.filename, versionId: d.version.id, versionNumber: d.version.version_number, disabled: false, title },
          rolledBack: null,
        };
        batch.index.entries.push(entry);
        await history.moveFile(path.join(staging, d.folder, d.file.filename), dest);
        entry.placed = true;
        applied.push(entry);
      }
    } catch (err) {
      await history.undoEntries(batch, batch.index.entries);
      throw err;
    }
    await history.saveBatch(batch);
    await history.applyRecords(target, batch.index.entries);
    return { updated: plans.length, added: applied.filter((e) => e.kind === 'add').length, failed, batch: batch.id };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fsp.rmdir(path.dirname(staging)).catch(() => {});
  }
}

module.exports = { listUpdates, applyUpdates, computeRisks, snippet, trySnapshot };
