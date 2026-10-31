'use strict';
// Fuentes de contenido del asistente: Modrinth (siempre) y CurseForge (solo si el usuario configuro su key).
// Busqueda, versiones compatibles, chequeo de compatibilidad, plan de instalacion con dependencias y
// descarga. Las descargas SOLO salen de cdn.modrinth.com o de *.forgecdn.net (se verifica cada URL antes de
// bajar nada) y se validan con el hash que publica la fuente.
const fsp = require('fs/promises');
const path = require('path');
const modrinth = require('../../core/modrinth');
const instances = require('../../core/instances');
const http = require('../../core/http');
const { exists } = require('../../core/util');
const { t } = require('../../core/i18n');
const { ToolError, assertDownloadUrl, assertId, assertBareFileName, insideDir, CONTENT_KINDS } = require('./guards');

let optional = () => null;
function configure({ optional: opt } = {}) {
  if (opt) optional = opt;
}

const FOLDER_BY_TYPE = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
const MOD_LOADERS_BY_NAME = { fabric: ['fabric'], quilt: ['quilt', 'fabric'], forge: ['forge'], neoforge: ['neoforge'] };
const SORTS = ['relevance', 'downloads', 'updated', 'newest', 'follows'];
const INCOMPAT_CODES = new Set(['incompatibleWithInstalled', 'incompatibleBetweenNew', 'installedIncompatibleWithNew', 'jarBreaksInstalled']);
const IRIS_ID = 'YL57xq9U';

const clip = (s, n) => {
  const v = String(s || '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

// "cf:12345" -> CurseForge; cualquier otro id o slug -> Modrinth.
function parseRef(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^cf:(\d{1,10})$/i);
  if (m) return { source: 'curseforge', id: Number(m[1]), ref: `cf:${m[1]}` };
  assertId(s, 'project_id');
  return { source: 'modrinth', id: s, ref: s };
}

async function curseforge() {
  const cf = optional('curseforge');
  if (!cf || typeof cf.available !== 'function') return null;
  try {
    return (await cf.available()) ? cf : null;
  } catch {
    return null;
  }
}

function cfLoaders(inst) {
  switch (inst?.loader) {
    case 'fabric':
    case 'legacyfabric':
      return ['fabric'];
    case 'quilt':
      return ['quilt', 'fabric'];
    case 'forge':
      return ['forge'];
    case 'neoforge':
      return inst.mcVersion === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge'];
    default:
      return [];
  }
}

function hasModLoader(inst) {
  return modrinth.modLoadersFor(inst).length > 0;
}

// ---------- Busqueda ----------
async function search({ type, query, inst, mcVersion, loader, limit, sort }) {
  const lim = Math.max(1, Math.min(20, Math.floor(Number(limit) || 8)));
  const gameVersion = inst?.mcVersion || mcVersion || undefined;
  let loaders;
  if (type === 'mod') loaders = inst ? modrinth.modLoadersFor(inst) : MOD_LOADERS_BY_NAME[loader] || undefined;
  if (type === 'shader' && inst) {
    const sl = modrinth.shaderLoadersFor(inst);
    loaders = sl.length ? sl : undefined;
  }
  const res = await modrinth.search({
    query: String(query || '').slice(0, 200),
    type,
    limit: lim,
    sort: SORTS.includes(sort) ? sort : 'relevance',
    gameVersion,
    loaders: loaders && loaders.length ? loaders : undefined,
    environment: type === 'mod' ? 'client' : undefined,
  });
  const out = {
    filters: { mc_version: gameVersion || null, loaders: loaders || null },
    total: res.total_hits,
    results: res.hits.map((h) => ({
      project_id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: clip(h.description, 160),
      downloads: h.downloads,
      categories: (h.display_categories || h.categories || []).slice(0, 6),
      ...(type === 'mod' ? { client_side: h.client_side, server_side: h.server_side } : {}),
      source: 'modrinth',
    })),
  };
  const cf = await curseforge();
  if (cf) {
    try {
      const r = await cf.search({ query: String(query || '').slice(0, 200), type, gameVersion, loader: type === 'mod' ? (inst ? cfLoaders(inst)[0] : loader) : undefined, pageSize: Math.min(lim, 10), sort: 'popularity' });
      out.curseforge = (r.hits || []).filter(Boolean).map((m) => ({
        project_id: `cf:${m.id}`,
        slug: m.slug,
        title: m.title,
        description: clip(m.description, 160),
        downloads: m.downloads,
        categories: (m.categories || []).slice(0, 6).map((c) => c.name),
        source: 'curseforge',
      }));
    } catch (err) {
      out.curseforge_error = clip(err.message, 160);
    }
  }
  return out;
}

// ---------- Versiones ----------
function shortVersions(list, mc) {
  const all = Array.isArray(list) ? list : [];
  if (mc && all.includes(mc)) return [mc];
  return all.slice(-3);
}

async function versions(ref, inst, { includeIncompatible = false } = {}) {
  if (ref.source === 'curseforge') {
    const cf = await curseforge();
    if (!cf) throw new ToolError(t('assistant.errNoCurseforge'), 'cf');
    const mod = await cf.getMod(ref.id);
    const loaders = mod.project_type === 'mod' ? cfLoaders(inst) : [];
    const res = await cf.getModFiles(mod.id, { gameVersion: includeIncompatible ? undefined : inst.mcVersion, pageSize: 50 });
    const rec = inst.curseforge?.projects?.[mod.id];
    const files = res.data.map(cf.normalizeFile).filter((f) => f && f.available !== false && !f.isServerPack);
    const compatible = (f) => (!f.gameVersions.length || f.gameVersions.includes(inst.mcVersion)) && (!loaders.length || !f.loaders.length || f.loaders.some((l) => loaders.includes(l)));
    const list = files.filter((f) => includeIncompatible || compatible(f));
    return {
      project: { project_id: `cf:${mod.id}`, title: mod.title, type: mod.project_type, source: 'curseforge' },
      installed_version_id: rec?.fileId ? String(rec.fileId) : null,
      versions: list.slice(0, 15).map((f) => ({
        version_id: String(f.id),
        version_number: clip(f.displayName, 80),
        type: f.releaseType,
        date: String(f.date || '').slice(0, 10),
        game_versions: shortVersions(f.gameVersions, inst.mcVersion),
        loaders: f.loaders,
        compatible: compatible(f),
        installed: rec?.fileId === f.id,
      })),
      total: list.length,
    };
  }
  const project = await modrinth.getProject(ref.id);
  const loaders = modrinth.loadersFor(project.project_type, inst);
  const list = await modrinth.getVersions(project.id, {
    loaders: includeIncompatible || !loaders.length ? undefined : loaders,
    gameVersions: includeIncompatible ? undefined : [inst.mcVersion],
    includeChangelog: false,
  });
  const rec = inst.modrinth?.projects?.[project.id];
  const isCompat = (v) => (v.game_versions || []).includes(inst.mcVersion) && (!loaders.length || (v.loaders || []).some((l) => loaders.includes(l)));
  return {
    project: { project_id: project.id, title: project.title, type: project.project_type, source: 'modrinth' },
    installed_version_id: rec?.versionId || null,
    versions: list.slice(0, 15).map((v) => ({
      version_id: v.id,
      version_number: v.version_number,
      type: v.version_type,
      date: String(v.date_published || '').slice(0, 10),
      game_versions: shortVersions(v.game_versions, inst.mcVersion),
      loaders: v.loaders,
      compatible: isCompat(v),
      installed: rec?.versionId === v.id,
    })),
    total: list.length,
  };
}

// ---------- Compatibilidad ----------
// Devuelve [{ project_id, title, type, status: ok|warning|error|installed, version, issues: [{ severity, code, message }], dependencies }]
async function checkCompatibility(inst, refs, { versionIds = {} } = {}) {
  const out = [];
  const mr = refs.filter((r) => r.source === 'modrinth');
  const cfRefs = refs.filter((r) => r.source === 'curseforge');
  const compat = optional('compat');
  if (mr.length && compat && typeof compat.check === 'function') {
    try {
      const r = await compat.check({ target: { kind: 'instance', id: inst.id }, items: mr.map((x) => ({ projectId: x.id, versionId: versionIds[x.ref] || undefined })) });
      const issues = [...(r.errors || []), ...(r.warnings || []), ...(r.infos || [])];
      for (const item of r.items || []) {
        const mine = issues.filter((i) => i.projectId === item.projectId || (!i.projectId && r.items.length === 1));
        out.push({
          project_id: item.requestedId || item.projectId,
          resolved_id: item.projectId,
          title: item.title,
          type: item.type,
          status: item.status,
          version: item.versionId ? { id: item.versionId, number: item.versionNumber } : null,
          issues: mine.slice(0, 8).map((i) => ({ severity: i.severity, code: i.code, message: clip(i.message, 300) })),
        });
      }
      const extra = (r.toInstall || []).filter((p) => p.reason && p.reason !== 'requested').slice(0, 15);
      if (extra.length && out.length) out[0].will_also_install = extra.map((p) => ({ project_id: p.projectId, title: p.title, version: p.versionNumber, reason: p.reason }));
      for (const x of mr) if (!out.some((o) => o.project_id === x.id || o.resolved_id === x.id)) out.push(await fallbackModrinth(inst, x, versionIds[x.ref]));
    } catch (err) {
      console.warn('[assistant] compat.check fallo, se usa el chequeo propio:', err.message);
      out.length = 0;
      for (const x of mr) out.push(await fallbackModrinth(inst, x, versionIds[x.ref]));
    }
  } else {
    for (const x of mr) out.push(await fallbackModrinth(inst, x, versionIds[x.ref]));
  }
  for (const x of cfRefs) out.push(await fallbackCurseforge(inst, x, versionIds[x.ref]));
  return out;
}

function issue(severity, code, message) {
  return { severity, code, message };
}

function statusOf(issues) {
  if (issues.some((i) => i.severity === 'error')) return 'error';
  if (issues.some((i) => i.severity === 'warning')) return 'warning';
  return 'ok';
}

async function fallbackModrinth(inst, ref, versionId) {
  let project;
  try {
    project = await modrinth.getProject(ref.id);
  } catch (err) {
    return { project_id: ref.ref, title: ref.ref, type: null, status: 'error', issues: [issue('error', 'projectNotFound', clip(err.message, 200))] };
  }
  const type = project.project_type;
  const issues = [];
  const res = { project_id: ref.ref, resolved_id: project.id, title: project.title, type, status: 'ok', version: null, issues, dependencies: [] };
  if (!['mod', 'resourcepack', 'shader'].includes(type)) {
    issues.push(issue('error', 'unsupportedType', t('assistant.errUnsupportedType', { title: project.title, type })));
    res.status = 'error';
    return res;
  }
  if (type === 'mod' && !hasModLoader(inst)) {
    issues.push(issue('error', 'noModLoader', t('assistant.errVanillaMods', { title: project.title })));
    res.status = 'error';
    return res;
  }
  const loaders = modrinth.loadersFor(type, inst);
  let version = null;
  try {
    version = versionId ? await modrinth.getVersion(versionId) : await modrinth.pickVersion(project.id, inst.mcVersion, loaders);
  } catch {
    version = null;
  }
  if (version && version.project_id !== project.id) version = null;
  if (!version) {
    issues.push(issue(type === 'mod' ? 'error' : 'warning', 'noVersion', t('assistant.errNoCompatibleVersion', { title: project.title, mc: inst.mcVersion, loader: inst.loader })));
    res.status = statusOf(issues);
    return res;
  }
  res.version = { id: version.id, number: version.version_number };
  if (!(version.game_versions || []).includes(inst.mcVersion)) issues.push(issue(type === 'mod' ? 'error' : 'warning', 'versionMismatch', t('assistant.errVersionNotForMc', { title: project.title, version: version.version_number, mc: inst.mcVersion })));
  if (type === 'mod' && loaders.length && !(version.loaders || []).some((l) => loaders.includes(l))) issues.push(issue('error', 'loaderMismatch', t('assistant.errVersionLoader', { title: project.title, loader: inst.loader })));
  const installed = inst.modrinth?.projects || {};
  if (installed[project.id]) issues.push(issue('info', 'alreadyInstalled', t('assistant.infoAlreadyInstalled', { title: project.title, version: installed[project.id].versionNumber || '?' })));
  const deps = (version.dependencies || []).filter((d) => d.project_id);
  const required = deps.filter((d) => d.dependency_type === 'required');
  const incompatible = deps.filter((d) => d.dependency_type === 'incompatible' && installed[d.project_id]);
  for (const d of incompatible) issues.push(issue('error', 'incompatibleWithInstalled', t('assistant.errIncompatible', { title: project.title, other: installed[d.project_id].title || d.project_id })));
  // Incompatibilidades declaradas por los mods ya instalados contra este
  try {
    const ids = Object.values(installed).map((r) => r?.versionId).filter(Boolean).slice(0, 200);
    const vers = ids.length ? await modrinth.getVersionsByIds(ids) : [];
    for (const v of vers) {
      if ((v.dependencies || []).some((d) => d.dependency_type === 'incompatible' && d.project_id === project.id)) {
        const other = installed[v.project_id]?.title || v.project_id;
        issues.push(issue('error', 'installedIncompatibleWithNew', t('assistant.errIncompatible', { title: other, other: project.title })));
      }
    }
  } catch {
    /* sin conexion: se omite */
  }
  if (required.length) {
    const projs = await modrinth.getProjects(required.map((d) => d.project_id)).catch(() => []);
    res.dependencies = required.map((d) => ({ project_id: d.project_id, title: projs.find((p) => p.id === d.project_id)?.title || d.project_id, installed: Boolean(installed[d.project_id]) }));
  }
  if (type === 'shader' && !modrinth.shaderLoadersFor(inst).length) issues.push(issue('warning', 'shaderNoLoader', t('assistant.warnNoShaderLoader')));
  res.status = installed[project.id] && !issues.some((i) => i.severity !== 'info') ? 'installed' : statusOf(issues);
  return res;
}

async function fallbackCurseforge(inst, ref, fileId) {
  const cf = await curseforge();
  if (!cf) return { project_id: ref.ref, title: ref.ref, type: null, status: 'error', issues: [issue('error', 'noCurseforge', t('assistant.errNoCurseforge'))] };
  try {
    const plan = await planCurseforge(inst, ref, fileId, null);
    const issues = plan.warnings.map((w) => issue('warning', 'warning', w));
    const root = plan.items[0];
    return {
      project_id: ref.ref,
      title: plan.project.title,
      type: plan.project.project_type,
      status: statusOf(issues),
      version: root ? { id: String(root.file.id), number: clip(root.file.displayName, 80) } : null,
      issues,
      dependencies: plan.items.slice(1).map((i) => ({ project_id: `cf:${i.mod.id}`, title: i.mod.title, installed: false })),
    };
  } catch (err) {
    return { project_id: ref.ref, title: ref.ref, type: null, status: 'error', issues: [issue('error', 'noVersion', clip(err.message, 300))] };
  }
}

// ---------- Plan de instalacion ----------
function assertFolder(folder) {
  if (!CONTENT_KINDS.includes(folder)) throw new ToolError(t('assistant.errKind', { kind: String(folder) }), 'kind');
  return folder;
}

// Modrinth: proyecto + dependencias requeridas (core/modrinth.resolveInstall). type = 'mod' | 'resourcepack' | 'shader'
async function planModrinth(inst, ref, versionId, type) {
  const project = await modrinth.getProject(ref.id);
  if (project.project_type !== type) throw new ToolError(t('assistant.errWrongType', { title: project.title, type: project.project_type, expected: type }), 'type');
  if (type === 'mod' && !hasModLoader(inst)) throw new ToolError(t('assistant.errVanillaMods', { title: project.title }), 'loader');
  const installed = inst.modrinth?.projects || {};
  const target = { gameVersion: inst.mcVersion, installed, loadersFor: (kind) => modrinth.loadersFor(kind, inst) };
  const warnings = [];
  let chosen = versionId || null;
  if (chosen) {
    const v = await modrinth.getVersion(chosen);
    if (v.project_id !== project.id) throw new ToolError(t('assistant.errVersionOtherProject', { title: project.title }), 'version');
    const loaders = modrinth.loadersFor(type, inst);
    const mcOk = (v.game_versions || []).includes(inst.mcVersion);
    const loaderOk = type !== 'mod' || !loaders.length || (v.loaders || []).some((l) => loaders.includes(l));
    if (type === 'mod' && (!mcOk || !loaderOk)) throw new ToolError(t('assistant.errVersionNotForMc', { title: project.title, version: v.version_number, mc: `${inst.mcVersion} (${inst.loader})` }), 'version');
    if (!mcOk) warnings.push(t('assistant.warnPackOtherVersion', { title: project.title, version: v.version_number, mc: inst.mcVersion }));
  }
  let resolved;
  try {
    resolved = await modrinth.resolveInstall(target, project.id, chosen, { type });
  } catch (err) {
    // Los resource packs y shaders suelen andar en otras versiones: se usa el mas nuevo avisando.
    if (type === 'mod' || chosen) throw new ToolError(err.message, 'version');
    const any = await modrinth.getVersions(project.id, { includeChangelog: false });
    const best = any.find((v) => v.version_type === 'release') || any[0];
    if (!best) throw new ToolError(err.message, 'version');
    warnings.push(t('assistant.warnPackOtherVersion', { title: project.title, version: best.version_number, mc: inst.mcVersion }));
    resolved = await modrinth.resolveInstall(target, project.id, best.id, { type });
  }
  const items = resolved.plan.map((p) => {
    const folder = assertFolder(modrinth.folderFor(p.type, p.version));
    const file = path.basename(String(p.file?.filename || ''));
    assertBareFileName(file);
    return {
      source: 'modrinth',
      projectId: p.project.id,
      title: p.project.title,
      icon: p.project.icon_url || null,
      type: p.type,
      versionId: p.version.id,
      versionNumber: p.version.version_number,
      folder,
      file,
      url: assertDownloadUrl(p.file.url, 'modrinth'),
      sha1: p.file.hashes?.sha1 || null,
      sha512: p.file.hashes?.sha1 ? null : p.file.hashes?.sha512 || null,
      size: p.file.size || 0,
      record: {
        title: p.project.title,
        icon: p.project.icon_url || null,
        type: p.type,
        versionId: p.version.id,
        versionNumber: p.version.version_number,
        file,
        folder,
      },
    };
  });
  return { project: { id: project.id, title: project.title, type }, items, warnings: [...warnings, ...resolved.warnings] };
}

function pickCfFile(files, inst, type) {
  const loaders = type === 'mod' ? cfLoaders(inst) : [];
  const ok = files.filter((f) => f && f.available !== false && !f.isServerPack && (!f.gameVersions.length || f.gameVersions.includes(inst.mcVersion)) && (!loaders.length || !f.loaders.length || f.loaders.some((l) => loaders.includes(l))));
  const order = { release: 0, beta: 1, alpha: 2 };
  ok.sort((a, b) => (order[a.releaseType] ?? 3) - (order[b.releaseType] ?? 3) || new Date(b.date) - new Date(a.date));
  return ok[0] || null;
}

// CurseForge: archivo + dependencias requeridas, con chequeo de version y loader. type null = el del proyecto.
async function planCurseforge(inst, ref, fileId, type) {
  const cf = await curseforge();
  if (!cf) throw new ToolError(t('assistant.errNoCurseforge'), 'cf');
  const root = await cf.getMod(ref.id);
  if (!root) throw new ToolError(t('assistant.errProjectNotFound', { id: ref.ref }), 'notfound');
  if (type && root.project_type !== type) throw new ToolError(t('assistant.errWrongType', { title: root.title, type: root.project_type, expected: type }), 'type');
  if (!FOLDER_BY_TYPE[root.project_type]) throw new ToolError(t('assistant.errUnsupportedType', { title: root.title, type: root.project_type }), 'type');
  if (root.project_type === 'mod' && !hasModLoader(inst)) throw new ToolError(t('assistant.errVanillaMods', { title: root.title }), 'loader');
  const installed = inst.curseforge?.projects || {};
  const visited = new Set();
  const items = [];
  const warnings = [];
  async function add(modId, fId, depth) {
    if (depth > 4 || visited.has(modId)) return;
    visited.add(modId);
    if (depth > 0 && installed[modId]) return;
    const mod = depth === 0 ? root : await cf.getMod(modId);
    if (!mod || !FOLDER_BY_TYPE[mod.project_type]) return;
    let file;
    if (fId) {
      const raw = (await cf.getFiles([Number(fId)]))[0];
      file = raw ? cf.normalizeFile(raw) : null;
      if (!file || file.modId !== mod.id) throw new ToolError(t('assistant.errVersionOtherProject', { title: mod.title }), 'version');
      const loaders = mod.project_type === 'mod' ? cfLoaders(inst) : [];
      const mcOk = !file.gameVersions.length || file.gameVersions.includes(inst.mcVersion);
      const loaderOk = !loaders.length || !file.loaders.length || file.loaders.some((l) => loaders.includes(l));
      if (mod.project_type === 'mod' && (!mcOk || !loaderOk)) throw new ToolError(t('assistant.errVersionNotForMc', { title: mod.title, version: file.displayName, mc: `${inst.mcVersion} (${inst.loader})` }), 'version');
    } else {
      const res = await cf.getModFiles(mod.id, { gameVersion: inst.mcVersion, pageSize: 50 });
      file = pickCfFile(res.data.map(cf.normalizeFile), inst, mod.project_type);
      if (!file) {
        if (depth === 0) throw new ToolError(t('assistant.errNoCompatibleVersion', { title: mod.title, mc: inst.mcVersion, loader: inst.loader }), 'version');
        warnings.push(t('assistant.warnDepNoVersion', { title: mod.title }));
        return;
      }
    }
    items.push({ mod, file });
    for (const dep of file.dependencies || []) {
      if (dep.type === 'incompatible' && installed[dep.modId]) warnings.push(t('assistant.errIncompatible', { title: mod.title, other: installed[dep.modId].title || dep.modId }));
      if (dep.type === 'required') await add(dep.modId, null, depth + 1);
    }
  }
  await add(root.id, fileId, 0);
  const planItems = [];
  for (const { mod, file } of items) {
    const url = file.downloadUrl || (await cf.getDownloadUrl(mod.id, file.id));
    if (!url) throw new ToolError(t('assistant.errCurseforgeManual', { title: mod.title }), 'manual');
    const name = path.basename(String(file.fileName || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    assertBareFileName(name);
    const folder = FOLDER_BY_TYPE[mod.project_type];
    planItems.push({
      source: 'curseforge',
      projectId: mod.id,
      title: mod.title,
      icon: mod.icon_url || null,
      type: mod.project_type,
      versionId: file.id,
      versionNumber: file.displayName,
      folder,
      file: name,
      url: assertDownloadUrl(url, 'curseforge'),
      sha1: file.sha1 || null,
      sha512: null,
      size: file.size || 0,
      record: { title: mod.title, icon: mod.icon_url || null, type: mod.project_type, fileId: file.id, versionNumber: file.displayName, file: name, folder },
    });
  }
  return { project: { id: root.id, title: root.title, type: root.project_type, project_type: root.project_type }, items: planItems, warnings };
}

async function plan(inst, ref, versionId, type) {
  return ref.source === 'curseforge' ? planCurseforge(inst, ref, versionId, type) : planModrinth(inst, ref, versionId, type);
}

// ---------- Ejecucion (con registro para deshacer) ----------
// Descarga los items del plan a la instancia. Antes de tocar nada guarda en la accion de deshacer las copias
// de lo que se va a reemplazar y las operaciones inversas. Devuelve los registros escritos.
async function execute(inst, items, action, { task, signal } = {}) {
  const sourceKey = items[0]?.source === 'curseforge' ? 'curseforge' : 'modrinth';
  const installed = inst[sourceKey]?.projects || {};
  const downloads = [];
  const toRemove = [];
  const recordOps = [];
  for (const it of items) {
    assertDownloadUrl(it.url, it.source); // otra vez, justo antes de descargar
    assertFolder(it.folder);
    const dest = insideDir(inst.dir, it.folder, it.file);
    action.target(`file:${it.folder}/${it.file}`, `project:${it.source}:${it.projectId}`);
    const prev = installed[it.projectId];
    if (prev?.file && prev.file !== it.file && CONTENT_KINDS.includes(prev.folder || it.folder)) {
      const prevFolder = prev.folder || it.folder;
      for (const name of [prev.file, `${prev.file}.disabled`]) {
        const full = insideDir(inst.dir, prevFolder, name);
        if (await exists(full)) {
          const backup = await action.backup(prevFolder, name);
          action.op({ type: 'restoreFile', folder: prevFolder, file: name, backup });
          action.target(`file:${prevFolder}/${name}`);
          toRemove.push(full);
        }
      }
    }
    if (await exists(dest)) {
      const backup = await action.backup(it.folder, it.file);
      action.op({ type: 'restoreFile', folder: it.folder, file: it.file, backup });
    } else {
      action.op({ type: 'removeFile', folder: it.folder, file: it.file, sha1: it.sha1 || null });
    }
    recordOps.push({ id: String(it.projectId), had: Object.prototype.hasOwnProperty.call(installed, it.projectId), value: prev ?? null });
    downloads.push({ url: it.url, path: dest, sha1: it.sha1 || undefined, sha512: it.sha512 || undefined, size: it.size || undefined });
  }
  action.op({ type: 'projects', source: sourceKey, records: recordOps });

  for (const folder of new Set(items.map((it) => it.folder))) await fsp.mkdir(insideDir(inst.dir, folder), { recursive: true });
  await http.downloadAll(downloads, {
    concurrency: 4,
    verify: 'hash',
    signal: signal || task?.signal,
    onProgress: task?.downloadProgress ? task.downloadProgress(sourceKey === 'curseforge' ? 'CurseForge' : 'Modrinth') : undefined,
  });
  for (const full of toRemove) await fsp.rm(full, { force: true });

  const fresh = await instances.get(inst.id);
  const records = {};
  for (const it of items) records[it.projectId] = { ...it.record, installedAt: Date.now() };
  await instances.update(inst.id, { [sourceKey]: { ...(fresh[sourceKey] || {}), projects: { ...(fresh[sourceKey]?.projects || {}), ...records } } });
  return records;
}

// ---------- Identificacion de archivos instalados ----------
function recordFor(projects, folder, file) {
  const base = file.replace(/\.disabled$/, '');
  for (const [pid, rec] of Object.entries(projects || {})) {
    if (rec?.file === base && (!rec.folder || String(rec.folder).replace(/\\/g, '/') === folder)) return { ...rec, projectId: pid };
  }
  return null;
}

// { archivo: { source, project_id, version_id, version_number, title } } (registros del launcher y, para el resto, Modrinth por hash)
async function identify(inst, folder, files, { network = true } = {}) {
  const out = {};
  const unknown = [];
  for (const f of files) {
    const mr = recordFor(inst.modrinth?.projects, folder, f.file);
    const cfr = mr ? null : recordFor(inst.curseforge?.projects, folder, f.file);
    if (mr) out[f.file] = { source: 'modrinth', project_id: mr.projectId, version_id: mr.versionId || null, version_number: mr.versionNumber || null, title: mr.title || null };
    else if (cfr) out[f.file] = { source: 'curseforge', project_id: `cf:${cfr.projectId}`, version_id: cfr.fileId ? String(cfr.fileId) : null, version_number: cfr.versionNumber || null, title: cfr.title || null };
    else if (!f.isDir) unknown.push(f);
  }
  if (network && unknown.length) {
    try {
      const ids = await modrinth.identify(inst.dir, unknown.slice(0, 400).map((f) => ({ file: f.file, folder, isDir: false })));
      for (const [file, info] of Object.entries(ids || {})) {
        out[file] = { source: 'modrinth', project_id: info.projectId, version_id: info.versionId, version_number: info.versionNumber, title: info.title || null, identified_by_hash: true };
      }
    } catch {
      /* sin conexion: quedan sin identificar */
    }
  }
  return out;
}

module.exports = { configure, parseRef, search, versions, checkCompatibility, plan, execute, identify, recordFor, curseforge, hasModLoader, cfLoaders, pickCfFile, INCOMPAT_CODES, FOLDER_BY_TYPE, IRIS_ID };
