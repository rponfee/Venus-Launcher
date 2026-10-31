'use strict';
// compat:check — revisa lo que se va a instalar contra el destino (instancia o servidor) antes de instalarlo:
// versión y loader, si ya está instalado (por hash o por id de mod), dependencias obligatorias y opcionales,
// incompatibilidades declaradas en Modrinth y en los propios archivos (en los dos sentidos), mods solo de
// cliente o de servidor, shaders sin Iris/OptiFine y formato de resource packs.
const api = require('./api');
const inventory = require('./inventory');
const targets = require('./target');
const formats = require('./formats');
const V = require('./versions');
const { t } = require('../../core/i18n');

const IRIS = 'YL57xq9U';
const OCULUS = 'GchcoXML';
const CLIENT_ONLY = new Set(['client_only', 'singleplayer_only']);
const SERVER_ONLY = new Set(['server_only', 'dedicated_server_only']);
const BUILTIN = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'forge', 'neoforge', 'fml', 'javafml', 'mixinextras']);
const MAX_ITEMS = 50;
const MAX_SUGGESTIONS = 6;
const META_BUDGET_MS = 9000;
const isPack = (type) => type === 'resourcepack' || type === 'shader' || type === 'datapack';

// ---------- Ayudas ----------
function primaryFile(v) {
  return v?.files?.find((f) => f.primary) || v?.files?.[0] || null;
}

function pickBest(list) {
  return list.find((v) => v.version_type === 'release') || list.find((v) => v.version_type === 'beta') || list[0] || null;
}

function isCompatible(v, loaders, mc) {
  if (!v) return false;
  if (mc && !(v.game_versions || []).includes(mc)) return false;
  return !loaders?.length || (v.loaders || []).some((l) => loaders.includes(l));
}

const vInfo = (v) => ({ id: v.id, number: v.version_number, type: v.version_type, date: v.date_published, gameVersions: (v.game_versions || []).slice(-4), loaders: v.loaders || [] });

// Versiones para elegir en la interfaz. Si lo elegido no es compatible, va primero y marcado.
function altList(list, chosen) {
  const out = list.slice(0, 30).map(vInfo);
  if (chosen && !out.some((a) => a.id === chosen.id)) out.unshift({ ...vInfo(chosen), incompatible: !list.some((v) => v.id === chosen.id) });
  return out;
}

function releaseVersions(list, n) {
  return (list || []).filter((g) => /^\d+\.\d+(\.\d+)?$/.test(g)).slice(-n).reverse();
}

function slugIds(slug) {
  const s = String(slug || '').toLowerCase();
  if (!s) return [];
  const base = s.replace(/-(fabric|forge|neoforge|quilt|mod)$/, '');
  return [...new Set([s, s.replace(/-/g, '_'), base, base.replace(/-/g, '_')])];
}

function predText(pred) {
  if (Array.isArray(pred)) return targets.orList(pred.map(predText).filter(Boolean));
  if (pred && typeof pred === 'object') return predText(pred.any || pred.all || '');
  const s = String(pred ?? '').trim();
  return s && s !== '*' ? s : '';
}

const modsOf = (meta) => meta?.mods || [];
const idsOf = (mod) => [mod.id, ...(mod.provides || [])].filter(Boolean);

function fileTitle(f) {
  return f.title || modsOf(f.meta)[0]?.name || f.version?.name || f.name;
}

// Tipo de contenido segun el proyecto y el destino (un mismo proyecto puede ser mod y plugin).
function itemType(project, explicit, target) {
  if (['resourcepack', 'shader', 'datapack', 'modpack'].includes(explicit)) return explicit;
  const pt = project.project_type;
  if (['resourcepack', 'shader', 'modpack', 'datapack'].includes(pt)) return pt;
  const ls = project.loaders || [];
  const hasPlugin = ls.some((l) => targets.PLUGIN_LOADERS.includes(l) || targets.PROXY_LOADERS.includes(l));
  const hasMod = ls.some((l) => targets.MOD_LOADERS.includes(l));
  if (target.pluginServer && hasPlugin) return 'plugin';
  if (hasMod) return 'mod';
  if (hasPlugin) return 'plugin';
  if (ls.includes('datapack')) return 'datapack';
  return pt === 'plugin' ? 'plugin' : 'mod';
}

function normalizeItems(items) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const it = typeof raw === 'string' ? { projectId: raw } : raw || {};
    const projectId = typeof it.projectId === 'string' ? it.projectId.trim() : '';
    if (!/^[\w.-]{1,64}$/.test(projectId) || seen.has(projectId)) continue;
    seen.add(projectId);
    const versionId = typeof it.versionId === 'string' && /^[\w]{1,64}$/.test(it.versionId) ? it.versionId : null;
    out.push({ projectId, versionId, type: typeof it.type === 'string' ? it.type : null });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function createContext(target, inv) {
  const ctx = { target, inv, issues: [], keys: new Set(), items: [], planned: new Map(), suggestions: new Map(), replace: [], enable: [], adopt: [] };
  ctx.issue = (severity, code, vars = {}, extra = {}) => {
    const key = `${code}|${extra.projectId || ''}|${extra.relatedProjectId || ''}|${extra.file || ''}`;
    if (ctx.keys.has(key)) return;
    ctx.keys.add(key);
    ctx.issues.push({
      severity,
      code,
      message: t(`compat.${code}`, vars),
      detail: extra.detail || null,
      projectId: extra.projectId || null,
      relatedProjectId: extra.relatedProjectId || null,
      file: extra.file || null,
      actions: extra.actions || [],
      fix: extra.fix || null,
      data: extra.data || null,
    });
  };
  ctx.replaced = () => new Set(ctx.replace.map((r) => `${r.folder}/${r.file}`));
  return ctx;
}

function installedFiles(ctx, pid, project) {
  const direct = ctx.inv.byProject.get(pid) || [];
  if (direct.length) return direct;
  for (const id of slugIds(project?.slug)) {
    const files = (ctx.inv.byModId.get(id) || []).filter((f) => !f.projectId);
    if (files.length) return files;
  }
  return [];
}

function shaderSupport(ctx) {
  const tg = ctx.target;
  if (tg.kind !== 'instance') return null;
  if (tg.loader === 'optifine') return 'optifine';
  const has = (pid) => (ctx.inv.byProject.get(pid) || []).some((f) => f.enabled) || ctx.planned.has(pid);
  const hasMod = (id) => (ctx.inv.byModId.get(id) || []).some((f) => f.enabled);
  if (tg.preset === 'iris' || has(IRIS) || has(OCULUS) || hasMod('iris') || hasMod('oculus')) return 'iris';
  if (ctx.inv.files.some((f) => f.folder === 'mods' && f.enabled && /optifine/i.test(f.file))) return 'optifine';
  return null;
}

function loadersFor(ctx, type) {
  const tg = ctx.target;
  switch (type) {
    case 'mod':
      return tg.pluginServer ? [] : tg.modLoaders;
    case 'plugin':
      return tg.pluginServer ? tg.modLoaders : [];
    case 'resourcepack':
      return ['minecraft'];
    case 'datapack':
      return ['datapack'];
    case 'shader': {
      const s = shaderSupport(ctx);
      return s === 'optifine' ? ['optifine'] : s === 'iris' ? ['iris'] : ['iris', 'optifine'];
    }
    default:
      return [];
  }
}

// ---------- 1. Lo pedido: version compatible para el destino ----------
function packWarning(ctx, project, v) {
  const versions = releaseVersions(v.game_versions, 3);
  const vars = { title: project.title, mc: ctx.target.mcVersion, versions: targets.andList(versions) };
  ctx.issue('warning', versions.length ? 'packNotForVersion' : 'packNotForVersionAny', vars, { projectId: project.id, actions: ['pickVersion', 'skip'] });
}

function blocked(ctx, project, type) {
  const tg = ctx.target;
  const vars = { title: project.title, type: targets.loaderName(tg.loader) };
  const err = (code) => {
    ctx.issue('error', code, vars, { projectId: project.id, actions: ['skip'] });
    return true;
  };
  if (type === 'mod') {
    if (tg.kind === 'server') {
      if (!tg.modLoaders.length) return err('serverVanilla');
      if (tg.pluginServer) return err('modOnPluginServer');
    } else if (!tg.modLoaders.length) return err(tg.loader === 'optifine' ? 'optifineNoMods' : 'vanillaNoMods');
  }
  if (type === 'plugin') {
    if (tg.kind === 'instance') return err('pluginOnClient');
    if (!tg.modLoaders.length) return err('serverVanilla');
    if (!tg.pluginServer) return err('pluginOnModServer');
  }
  if (type === 'shader' && tg.kind === 'server') return err('shaderOnServer');
  if (type === 'resourcepack' && tg.kind === 'server') return err('resourcepackOnServer');
  return false;
}

function diagnoseNoVersion(ctx, project, loaders) {
  const tg = ctx.target;
  const pl = (project.loaders || []).filter((l) => l !== 'minecraft');
  const base = { title: project.title, mc: tg.mcVersion, loader: targets.loaderName(tg.loader) };
  const opts = { projectId: project.id, actions: ['skip'] };
  if (loaders.length && pl.length && !pl.some((l) => loaders.includes(l))) {
    ctx.issue('error', 'noVersionLoader', { ...base, loaders: targets.andList(pl.map(targets.loaderName)) }, opts);
  } else if (!(project.game_versions || []).includes(tg.mcVersion)) {
    const rel = releaseVersions(project.game_versions, 3);
    ctx.issue('error', rel.length ? 'noVersionMc' : 'noVersionMcAny', { ...base, versions: targets.andList(rel) }, opts);
  } else ctx.issue('error', 'noVersionCombo', base, opts);
}

async function resolveRequested(ctx, list, signal) {
  const tg = ctx.target;
  const mc = tg.mcVersion;
  const projs = await api.projects(list.map((i) => i.projectId), { signal });
  for (const it of list) {
    const project = projs[it.projectId];
    if (!project) {
      ctx.items.push({ projectId: it.projectId, title: it.projectId, slug: null, icon: null, type: it.type || 'mod', versionId: null, status: 'error', alternatives: [] });
      ctx.issue('error', 'projectNotFound', { id: it.projectId }, { projectId: it.projectId, actions: ['skip'] });
      continue;
    }
    const type = itemType(project, it.type, tg);
    const res = {
      projectId: project.id,
      requestedId: it.projectId,
      slug: project.slug,
      title: project.title,
      icon: project.icon_url || null,
      type,
      requestedVersionId: it.versionId,
      versionId: null,
      versionNumber: null,
      versionType: null,
      datePublished: null,
      file: null,
      status: 'ok',
      installed: null,
      alternatives: [],
    };
    ctx.items.push(res);
    if (type === 'modpack') {
      ctx.issue('info', 'modpackNoCheck', { title: project.title }, { projectId: project.id });
      continue;
    }
    if (blocked(ctx, project, type)) continue;
    let loaders = loadersFor(ctx, type);
    let compatible = await api.projectVersions(project.id, { loaders, gameVersions: [mc], signal });
    if (!compatible.length && type === 'shader') {
      loaders = ['iris', 'optifine', 'canvas', 'vanilla'];
      compatible = await api.projectVersions(project.id, { loaders, gameVersions: [mc], signal });
    }
    let chosen = null;
    let alternatives = compatible;
    if (it.versionId) {
      const v = await api.version(it.versionId, { signal });
      if (!v || v.project_id !== project.id) {
        ctx.issue('error', 'versionNotFound', { title: project.title }, { projectId: project.id, actions: compatible.length ? ['pickVersion', 'skip'] : ['skip'] });
      } else {
        chosen = v;
        if (isPack(type)) {
          if (!(v.game_versions || []).includes(mc)) packWarning(ctx, project, v);
        } else if (!isCompatible(v, loaders, mc)) {
          ctx.issue(
            'error',
            'versionMismatch',
            {
              title: project.title,
              version: v.version_number,
              versions: targets.andList(releaseVersions(v.game_versions, 3).length ? releaseVersions(v.game_versions, 3) : (v.game_versions || []).slice(-3)),
              loaders: targets.andList((v.loaders || []).map(targets.loaderName)),
              mc,
              loader: targets.loaderName(tg.loader),
            },
            { projectId: project.id, actions: compatible.length ? ['pickVersion', 'skip'] : ['skip'] },
          );
        }
      }
    }
    if (!chosen && !it.versionId) chosen = pickBest(compatible);
    if (!chosen && !it.versionId && isPack(type)) {
      // Los packs suelen funcionar en otras versiones: se usa la mas nueva avisando
      const any = await api.projectVersions(project.id, { loaders: type === 'shader' ? undefined : loaders, signal });
      chosen = pickBest(any);
      alternatives = any;
      if (chosen) packWarning(ctx, project, chosen);
    }
    res.alternatives = altList(alternatives, chosen);
    if (!chosen) {
      if (!it.versionId) diagnoseNoVersion(ctx, project, loaders);
      continue;
    }
    const file = primaryFile(chosen);
    Object.assign(res, {
      versionId: chosen.id,
      versionNumber: chosen.version_number,
      versionType: chosen.version_type,
      datePublished: chosen.date_published,
      loaders: chosen.loaders || [],
      file: file ? { filename: file.filename, size: file.size } : null,
    });
    if (chosen.version_type && chosen.version_type !== 'release') {
      const hasRelease = compatible.some((v) => v.version_type === 'release');
      ctx.issue('info', chosen.version_type === 'alpha' ? 'alphaVersion' : 'betaVersion', { title: project.title, version: chosen.version_number }, { projectId: project.id, actions: hasRelease ? ['pickVersion'] : [] });
    }
    ctx.planned.set(project.id, { project, version: chosen, type, reason: 'requested', requiredBy: new Set(), root: project.id, res, meta: null, compatible });
  }
}

// ---------- 2. Ya instalado (mismo proyecto por hash/registro o mismo id de mod) ----------
function checkInstalled(ctx) {
  for (const p of ctx.planned.values()) {
    if (p.reason !== 'requested') continue;
    const files = installedFiles(ctx, p.project.id, p.project);
    if (!files.length) continue;
    const pf = primaryFile(p.version);
    const same = files.find((f) => f.versionId === p.version.id || (pf?.hashes?.sha1 && f.sha1 === pf.hashes.sha1));
    const first = same || files[0];
    p.res.installed = { file: first.file, folder: first.folder, versionNumber: first.versionNumber || modsOf(first.meta)[0]?.version || null, enabled: first.enabled, same: Boolean(same) };
    const vars = { title: p.project.title, version: p.version.version_number };
    if (same && files.length === 1) {
      p.alreadyInstalled = true;
      ctx.issue('info', same.enabled ? 'alreadyInstalled' : 'alreadyInstalledDisabled', vars, { projectId: p.project.id, file: same.file, actions: ['skip'] });
      continue;
    }
    const others = files.filter((f) => f !== same);
    if (p.type === 'mod' || p.type === 'plugin') {
      // Los registrados los reemplaza el instalador; los agregados a mano quedarian duplicados
      const manual = others.filter((f) => !f.record);
      for (const f of manual) {
        ctx.issue('warning', 'installedManually', { ...vars, file: f.file, old: f.versionNumber || modsOf(f.meta)[0]?.version || '?' }, { projectId: p.project.id, file: f.file, actions: ['replace', 'skip'] });
        ctx.replace.push({ folder: f.folder, file: f.file, projectId: p.project.id, oldProjectId: f.projectId || null, reason: 'sameProject', title: p.project.title, icon: p.project.icon_url || null, versionNumber: f.versionNumber || modsOf(f.meta)[0]?.version || null, versionId: f.versionId });
      }
      const recorded = others.filter((f) => f.record);
      if (recorded.length) ctx.issue('info', 'replacesVersion', { ...vars, old: recorded[0].versionNumber || recorded[0].file }, { projectId: p.project.id });
    } else {
      ctx.issue('info', 'replacesVersion', { ...vars, old: others[0].versionNumber || others[0].file }, { projectId: p.project.id });
    }
  }
}

// ---------- 3. Dependencias ----------
// ¿El propio archivo del mod declara que version de la dependencia acepta? { known, accepts }
// (la version exacta que pide Modrinth suele ser muy estricta: si el archivo la acepta no hay que avisar)
async function parentAccepts(ctx, parent, files) {
  const meta = parent.meta || (await inventory.remoteMeta(primaryFile(parent.version)).catch(() => null));
  parent.meta = meta;
  if (!meta) return { known: false, accepts: false };
  for (const f of files) {
    for (const im of modsOf(f.meta)) {
      for (const nm of modsOf(meta)) {
        for (const id of idsOf(im)) {
          if (nm.depends?.[id] !== undefined) return { known: true, accepts: V.matchPredicate(im.version, nm.depends[id]) };
          const d = (nm.deps || []).find((x) => x.modId === id && (x.type === 'required' || x.type === 'optional'));
          if (d) return { known: true, accepts: V.inMavenRange(im.version, d.range) };
        }
      }
    }
  }
  return { known: false, accepts: false };
}

async function requireDep(ctx, parent, depPid, depProject, pinned, signal) {
  const tg = ctx.target;
  const title = depProject?.title || depPid;
  const rootOpts = { projectId: parent.root, relatedProjectId: depPid };
  const planned = ctx.planned.get(depPid);
  if (planned) {
    planned.requiredBy.add(parent.project.id);
    return null;
  }
  const files = installedFiles(ctx, depPid, depProject);
  if (files.length) {
    const enabled = files.filter((f) => f.enabled);
    if (!enabled.length) {
      const f = files[0];
      ctx.issue('warning', 'dependencyDisabled', { title: parent.project.title, dep: title, file: f.file }, { ...rootOpts, file: f.file, actions: ['enable'] });
      if (!ctx.enable.some((e) => e.file === f.file && e.folder === f.folder)) ctx.enable.push({ folder: f.folder, file: f.file, projectId: depPid, title });
      return null;
    }
    const f = enabled[0];
    const rec = tg.records[depPid];
    if (!f.record && (!rec || String(rec.file || '').replace(/\.disabled$/i, '') !== f.name) && !ctx.adopt.some((a) => a.projectId === depPid)) {
      ctx.adopt.push({
        projectId: depPid,
        folder: f.folder,
        file: f.name,
        versionId: f.versionId || null,
        versionNumber: f.versionNumber || modsOf(f.meta)[0]?.version || null,
        title,
        icon: depProject?.icon_url || null,
        type: f.folder === 'plugins' ? 'plugin' : 'mod',
      });
    }
    if (pinned && !enabled.some((x) => x.versionId === pinned.id) && !(await parentAccepts(ctx, parent, enabled)).known) {
      ctx.issue('warning', 'pinnedDependency', { title: parent.project.title, dep: title, wanted: pinned.version_number, installed: f.versionNumber || modsOf(f.meta)[0]?.version || f.file }, rootOpts);
    }
    return null;
  }
  if (!depProject) {
    ctx.issue('error', 'dependencyUnavailable', { title: parent.project.title, dep: depPid }, { ...rootOpts, actions: ['skip'] });
    return null;
  }
  const type = itemType(depProject, null, tg);
  const loaders = loadersFor(ctx, type);
  let v = pinned && isCompatible(pinned, loaders, tg.mcVersion) ? pinned : null;
  if (!v) v = pickBest(await api.projectVersions(depPid, { loaders, gameVersions: [tg.mcVersion], signal }));
  if (!v) {
    ctx.issue('error', 'dependencyNoVersion', { title: parent.project.title, dep: title, mc: tg.mcVersion, loader: targets.loaderName(tg.loader) }, { ...rootOpts, actions: ['skip'] });
    return null;
  }
  const entry = { project: depProject, version: v, type, reason: 'required', requiredBy: new Set([parent.project.id]), root: parent.root, meta: null };
  ctx.planned.set(depPid, entry);
  ctx.issue('info', 'willAddDependency', { dep: title, version: v.version_number, title: parent.project.title }, rootOpts);
  return entry;
}

async function suggestOptional(ctx, parent, depPid, depProject, signal) {
  if (!depProject || ctx.planned.has(depPid) || ctx.suggestions.has(depPid)) return;
  if (ctx.suggestions.size >= MAX_SUGGESTIONS) return;
  if (installedFiles(ctx, depPid, depProject).length) return;
  const type = itemType(depProject, null, ctx.target);
  if (type !== 'mod' && type !== 'plugin') return;
  const v = pickBest(await api.projectVersions(depPid, { loaders: loadersFor(ctx, type), gameVersions: [ctx.target.mcVersion], signal }));
  if (!v) return;
  ctx.suggestions.set(depPid, { project: depProject, version: v, type, reason: 'optional', requiredBy: new Set([parent.project.id]), root: parent.root, deps: [] });
  ctx.issue('info', 'optionalSuggestion', { title: parent.project.title, dep: depProject.title }, { projectId: parent.root, relatedProjectId: depPid, actions: ['addOptional'] });
}

async function resolveDependencies(ctx, signal) {
  let frontier = [...ctx.planned.values()];
  for (let depth = 0; depth < 5 && frontier.length; depth++) {
    const pinnedIds = new Set();
    const projectIds = new Set();
    for (const p of frontier) {
      for (const d of p.version.dependencies || []) {
        if (d.dependency_type !== 'required' && d.dependency_type !== 'optional') continue;
        if (d.version_id) pinnedIds.add(d.version_id);
        if (d.project_id) projectIds.add(d.project_id);
      }
    }
    const pinned = pinnedIds.size ? await api.versions([...pinnedIds], { signal }) : {};
    for (const v of Object.values(pinned)) if (v?.project_id) projectIds.add(v.project_id);
    const projs = projectIds.size ? await api.projects([...projectIds], { signal }) : {};
    const next = [];
    for (const p of frontier) {
      for (const d of p.version.dependencies || []) {
        const pin = d.version_id ? pinned[d.version_id] || null : null;
        const depPid = d.project_id || pin?.project_id || null;
        if (d.dependency_type === 'required') {
          if (!depPid) {
            if (d.file_name) ctx.issue('warning', 'externalDependency', { title: p.project.title, file: d.file_name }, { projectId: p.root });
            continue;
          }
          if (depPid === p.project.id) continue;
          const entry = await requireDep(ctx, p, depPid, projs[depPid] || null, pin, signal);
          if (entry) next.push(entry);
        } else if (d.dependency_type === 'optional' && p.reason === 'requested' && depPid && depPid !== p.project.id) {
          await suggestOptional(ctx, p, depPid, projs[depPid] || null, signal);
        }
      }
    }
    frontier = next;
  }
}

// ---------- 4. Metadatos de los archivos nuevos (sin descargarlos enteros) ----------
async function fetchRemoteMeta(ctx, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), META_BUDGET_MS);
  const sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  const queue = [...ctx.planned.values()].filter((p) => !p.meta && (p.type === 'mod' || p.type === 'plugin' || p.type === 'resourcepack' || p.type === 'datapack'));
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift();
      p.meta = await inventory.remoteMeta(primaryFile(p.version), { signal: sig }).catch(() => null);
    }
  };
  try {
    await Promise.all([worker(), worker(), worker()]);
  } finally {
    clearTimeout(timer);
  }
  if (signal?.aborted) throw signal.reason || new Error('Cancelado');
}

// ---------- 5. Mismo id de mod con otro archivo (duplicados) ----------
// Mismo id principal = duplicado real (el juego no arranca). Si uno solo "provee" el id del otro
// (por ejemplo Sodium provee "indium"), no es un duplicado: uno ya incluye lo que hace el otro.
function checkDuplicates(ctx) {
  for (const p of ctx.planned.values()) {
    if (p.alreadyInstalled) continue;
    const replaced = ctx.replaced();
    const skip = (f) => !f.enabled || f.projectId === p.project.id || replaced.has(`${f.folder}/${f.file}`) || (f.projectId && ctx.planned.has(f.projectId));
    for (const nm of modsOf(p.meta)) {
      if (!nm.id || BUILTIN.has(nm.id)) continue;
      for (const f of ctx.inv.byModId.get(nm.id) || []) {
        if (skip(f)) continue;
        if (modsOf(f.meta).some((m) => m.id === nm.id)) {
          ctx.issue('warning', 'duplicateModId', { title: p.project.title, file: f.file, modId: nm.id }, { projectId: p.root, file: f.file, actions: ['replace', 'skip'] });
          ctx.replace.push({ folder: f.folder, file: f.file, projectId: p.project.id, oldProjectId: f.projectId || null, reason: 'sameModId', title: fileTitle(f), icon: f.icon || null, versionNumber: f.versionNumber || modsOf(f.meta)[0]?.version || null, versionId: f.versionId });
          replaced.add(`${f.folder}/${f.file}`);
        } else {
          ctx.issue('info', 'alreadyProvided', { title: p.project.title, other: fileTitle(f) }, { projectId: p.root, file: f.file, actions: ['skip'] });
        }
      }
      for (const prov of nm.provides || []) {
        if (BUILTIN.has(prov)) continue;
        for (const f of ctx.inv.byModId.get(prov) || []) {
          if (skip(f) || !modsOf(f.meta).some((m) => m.id === prov)) continue;
          ctx.issue('info', 'providesInstalled', { title: p.project.title, other: fileTitle(f), file: f.file }, { projectId: p.root, file: f.file });
        }
      }
    }
    const pluginName = p.meta?.plugin?.name?.toLowerCase();
    if (pluginName) {
      for (const f of ctx.inv.byPlugin.get(pluginName) || []) {
        if (!f.enabled || f.projectId === p.project.id || replaced.has(`${f.folder}/${f.file}`)) continue;
        ctx.issue('warning', 'duplicatePlugin', { title: p.project.title, file: f.file }, { projectId: p.root, file: f.file, actions: ['replace', 'skip'] });
        ctx.replace.push({ folder: f.folder, file: f.file, projectId: p.project.id, oldProjectId: f.projectId || null, reason: 'sameModId', title: fileTitle(f), icon: f.icon || null, versionNumber: f.versionNumber || null, versionId: f.versionId });
      }
    }
  }
}

// Archivos instalados que siguen activos despues de instalar lo planeado
function activeInstalled(ctx) {
  const replaced = ctx.replaced();
  return ctx.inv.files.filter((f) => f.enabled && !replaced.has(`${f.folder}/${f.file}`) && !(f.projectId && ctx.planned.has(f.projectId)));
}

// ---------- 6. Incompatibilidades declaradas en Modrinth (en los dos sentidos) ----------
async function checkDeclaredIncompat(ctx, signal) {
  const installed = activeInstalled(ctx);
  const pinIds = new Set();
  for (const p of ctx.planned.values()) for (const d of p.version.dependencies || []) if (d.dependency_type === 'incompatible' && !d.project_id && d.version_id) pinIds.add(d.version_id);
  const pins = pinIds.size ? await api.versions([...pinIds], { signal }) : {};
  for (const p of ctx.planned.values()) {
    for (const d of p.version.dependencies || []) {
      if (d.dependency_type !== 'incompatible') continue;
      const pid = d.project_id || pins[d.version_id]?.project_id;
      if (!pid || pid === p.project.id) continue;
      for (const f of installed) {
        if (f.projectId !== pid || (d.version_id && f.versionId !== d.version_id)) continue;
        ctx.issue('error', 'incompatibleWithInstalled', { title: p.project.title, other: fileTitle(f) }, { projectId: p.root, relatedProjectId: pid, file: f.file, actions: ['skip', 'installAnyway'] });
      }
      const other = ctx.planned.get(pid);
      if (other && (!d.version_id || other.version.id === d.version_id)) {
        ctx.issue('error', 'incompatibleBetweenNew', { title: p.project.title, other: other.project.title }, { projectId: p.root, relatedProjectId: pid, actions: ['skip', 'installAnyway'] });
      }
    }
  }
  for (const f of installed) {
    for (const d of f.version?.dependencies || []) {
      if (d.dependency_type !== 'incompatible' || !d.project_id) continue;
      const p = ctx.planned.get(d.project_id);
      if (!p || (d.version_id && p.version.id !== d.version_id) || f.projectId === p.project.id) continue;
      ctx.issue('error', 'installedIncompatibleWithNew', { title: p.project.title, other: fileTitle(f) }, { projectId: p.root, relatedProjectId: f.projectId, file: f.file, actions: ['skip', 'installAnyway'] });
    }
  }
}

// ---------- 7. Incompatibilidades declaradas en los archivos (fabric.mod.json, quilt.mod.json, mods.toml) ----------
// Problemas que el mod "a" declara sobre el mod "b" (sin efectos: tambien sirve para probar versiones candidatas)
function pairProblems(a, b) {
  const out = [];
  const known = Boolean(b.version);
  for (const id of idsOf(b)) {
    if (BUILTIN.has(id)) continue;
    const brk = a.breaks?.[id];
    if (brk !== undefined) {
      if (!known && !V.isAnyPredicate(brk)) out.push({ kind: 'breaksMaybe', severity: 'warning', range: predText(brk) });
      else if (V.matchPredicate(b.version, brk)) out.push({ kind: 'breaks', severity: 'error', range: predText(brk) });
    }
    const cfl = a.conflicts?.[id];
    if (cfl !== undefined && known && V.matchPredicate(b.version, cfl)) out.push({ kind: 'conflicts', severity: 'warning', range: predText(cfl) });
    const dep = a.depends?.[id];
    if (dep !== undefined && known && !V.matchPredicate(b.version, dep)) out.push({ kind: 'needs', severity: 'error', range: predText(dep) });
    for (const d of a.deps || []) {
      if (d.modId !== id) continue;
      const inRange = V.inMavenRange(b.version, d.range);
      if (d.type === 'incompatible' && inRange) out.push({ kind: 'breaks', severity: 'error', range: V.isAnyRange(d.range) ? '' : d.range });
      else if (d.type === 'discouraged' && inRange) out.push({ kind: 'conflicts', severity: 'warning', range: V.isAnyRange(d.range) ? '' : d.range });
      else if ((d.type === 'required' || d.type === 'optional') && known && !inRange) out.push({ kind: 'needs', severity: 'error', range: d.range });
    }
  }
  return out;
}

const DECLARED = new Set(['incompatibleWithInstalled', 'installedIncompatibleWithNew', 'incompatibleBetweenNew']);
function hasDeclared(ctx, a, b) {
  if (!a || !b) return false;
  return ctx.issues.some((i) => DECLARED.has(i.code) && ((i.projectId === a && i.relatedProjectId === b) || (i.projectId === b && i.relatedProjectId === a)));
}

const KIND_CODE = { breaks: 'jarBreaks', breaksMaybe: 'jarBreaksMaybe', conflicts: 'jarConflicts', needs: 'jarNeeds' };

// dir: 'installed' (a instalado, b nuevo), 'new' (a nuevo, b instalado), 'planned' (los dos nuevos)
function pairIssues(ctx, a, b, info) {
  const sfx = info.dir === 'installed' ? 'Installed' : info.dir === 'new' ? 'New' : 'Planned';
  const declared = hasDeclared(ctx, info.projectId, info.relatedProjectId);
  for (const pr of pairProblems(a, b)) {
    if (declared && pr.kind !== 'needs') continue; // ya se aviso con la incompatibilidad de Modrinth
    const vars = { a: info.aTitle, b: info.bTitle, version: b.version || '?', range: pr.range || '*' };
    // Entre dos nuevos, lo que "rompe" se muestra en el que queda roto (es el que conviene cambiar)
    const onB = info.bRoot && pr.kind !== 'needs';
    ctx.issue(pr.severity, KIND_CODE[pr.kind] + sfx, vars, {
      projectId: onB ? info.bRoot : info.projectId,
      relatedProjectId: onB ? info.aProjectId || info.relatedProjectId : info.relatedProjectId,
      file: info.file,
      actions: pr.kind === 'needs' ? ['skip', 'pickVersion', 'installAnyway'] : ['skip', 'installAnyway'],
      detail: pr.kind === 'breaks' && pr.range ? t('compat.detailRange', { range: pr.range }) : null,
    });
  }
}

// Cantidad de errores que tendria instalar "version" (con sus metadatos) en lugar de lo elegido para "p".
function candidateErrors(ctx, p, version, meta) {
  let n = 0;
  const installed = activeInstalled(ctx).filter((f) => f.projectId !== p.project.id && modsOf(f.meta).length);
  const others = [...ctx.planned.values()].filter((q) => q.project.id !== p.project.id && !q.alreadyInstalled);
  const errs = (list) => list.filter((x) => x.severity === 'error').length;
  for (const nm of modsOf(meta)) {
    for (const f of installed) for (const im of modsOf(f.meta)) n += errs(pairProblems(im, nm)) + errs(pairProblems(nm, im));
    for (const q of others) for (const qm of modsOf(q.meta)) n += errs(pairProblems(qm, nm)) + errs(pairProblems(nm, qm));
  }
  for (const d of version.dependencies || []) {
    if (d.dependency_type !== 'incompatible' || !d.project_id) continue;
    if (installed.some((f) => f.projectId === d.project_id) || others.some((q) => q.project.id === d.project_id)) n++;
  }
  for (const f of activeInstalled(ctx)) {
    for (const d of f.version?.dependencies || []) if (d.dependency_type === 'incompatible' && d.project_id === p.project.id && (!d.version_id || d.version_id === version.id)) n++;
  }
  return n;
}

// Primera version sin errores entre las candidatas (con sus metadatos leidos por rango, con cache)
async function firstClean(ctx, p, candidates, signal, limit = 5) {
  let tried = 0;
  for (const v of candidates) {
    if (tried >= limit || signal?.aborted) break;
    const meta = await inventory.remoteMeta(primaryFile(v), { signal }).catch(() => null);
    if (!meta) continue;
    tried++;
    if (candidateErrors(ctx, p, v, meta) === 0) return v;
  }
  return null;
}

function checkJarMeta(ctx) {
  const tg = ctx.target;
  const installed = activeInstalled(ctx).filter((f) => modsOf(f.meta).length);
  const planned = [...ctx.planned.values()].filter((p) => !p.alreadyInstalled && (p.type === 'mod' || p.type === 'plugin'));
  for (const p of planned) {
    const newMods = modsOf(p.meta);
    for (const f of installed) {
      for (const im of modsOf(f.meta)) {
        if (newMods.length) {
          for (const nm of newMods) {
            pairIssues(ctx, im, nm, { dir: 'installed', aTitle: fileTitle(f), bTitle: p.project.title, projectId: p.root, relatedProjectId: f.projectId, file: f.file });
            pairIssues(ctx, nm, im, { dir: 'new', aTitle: p.project.title, bTitle: fileTitle(f), projectId: p.root, relatedProjectId: f.projectId, file: f.file });
          }
        } else {
          // Sin metadatos del archivo nuevo: comparar por el slug del proyecto
          for (const id of slugIds(p.project.slug)) {
            const brk = im.breaks?.[id];
            if (brk === undefined || hasDeclared(ctx, p.root, f.projectId)) continue;
            if (V.isAnyPredicate(brk)) ctx.issue('error', 'jarBreaksInstalled', { a: fileTitle(f), b: p.project.title, version: '?' }, { projectId: p.root, relatedProjectId: f.projectId, file: f.file, actions: ['skip', 'installAnyway'] });
            else ctx.issue('warning', 'jarBreaksMaybeInstalled', { a: fileTitle(f), b: p.project.title, range: predText(brk) }, { projectId: p.root, relatedProjectId: f.projectId, file: f.file, actions: ['skip', 'installAnyway'] });
          }
        }
      }
    }
    // Entre los que se van a instalar
    for (const q of planned) {
      if (q === p) continue;
      for (const nm of newMods) for (const qm of modsOf(q.meta)) pairIssues(ctx, nm, qm, { dir: 'planned', aTitle: p.project.title, bTitle: q.project.title, projectId: p.root, relatedProjectId: q.project.id, bRoot: q.root, aProjectId: p.project.id });
    }
    // Version de Minecraft que pide el propio archivo
    for (const nm of newMods) {
      const mcPred = nm.depends?.minecraft;
      if (mcPred !== undefined && !V.matchPredicate(tg.mcVersion, mcPred)) {
        ctx.issue('warning', 'jarMinecraft', { title: p.project.title, range: predText(mcPred), mc: tg.mcVersion }, { projectId: p.root });
      }
      const mcDep = (nm.deps || []).find((d) => d.modId === 'minecraft' && d.type !== 'incompatible' && d.type !== 'discouraged');
      if (mcDep && !V.inMavenRange(tg.mcVersion, mcDep.range)) ctx.issue('warning', 'jarMinecraft', { title: p.project.title, range: mcDep.range, mc: tg.mcVersion }, { projectId: p.root });
    }
  }
}

// Si lo elegido choca con algo, buscar otra version del mismo proyecto que no choque (primero las mas nuevas)
const CONFLICT_CODE = /^(jarBreaks|jarNeeds|incompatible|installedIncompatible)/;
async function suggestBetterVersions(ctx, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), META_BUDGET_MS);
  const sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  try {
    for (const p of ctx.planned.values()) {
      if (p.reason !== 'requested' || !p.compatible?.length || (p.type !== 'mod' && p.type !== 'plugin')) continue;
      if (!ctx.issues.some((i) => i.projectId === p.root && i.severity === 'error' && CONFLICT_CODE.test(i.code))) continue;
      const cur = Date.parse(p.version.date_published);
      const others = p.compatible.filter((v) => v.id !== p.version.id);
      const newer = others.filter((v) => Date.parse(v.date_published) > cur);
      const older = others.filter((v) => Date.parse(v.date_published) < cur && v.version_type === 'release');
      const v = await firstClean(ctx, p, [...newer, ...older], sig);
      if (!v) continue;
      const info = { id: v.id, number: v.version_number, type: v.version_type };
      p.res.suggestedVersion = info;
      ctx.issue('info', v.version_type === 'release' ? 'betterVersion' : 'betterVersionPre', { title: p.project.title, version: v.version_number }, { projectId: p.root, actions: ['useVersion'], data: { version: info } });
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 8. Cliente / servidor ----------
function sideOf(project, version) {
  const env = version?.environment;
  const penv = Array.isArray(project.environment) ? project.environment : [];
  const clientOnly = typeof env === 'string' && env ? CLIENT_ONLY.has(env) : penv.length ? penv.every((e) => CLIENT_ONLY.has(e)) : project.server_side === 'unsupported';
  const serverOnly = typeof env === 'string' && env ? SERVER_ONLY.has(env) : penv.length ? penv.every((e) => SERVER_ONLY.has(e)) : project.client_side === 'unsupported';
  return { clientOnly, serverOnly };
}

function checkSides(ctx) {
  const tg = ctx.target;
  for (const p of ctx.planned.values()) {
    if (p.reason !== 'requested' || (p.type !== 'mod' && p.type !== 'plugin')) continue;
    const { clientOnly, serverOnly } = sideOf(p.project, p.version);
    const metaEnv = modsOf(p.meta)[0]?.env;
    if (tg.side === 'server' && clientOnly) ctx.issue('warning', metaEnv === 'client' ? 'clientOnlyOnServerIgnored' : 'clientOnlyOnServer', { title: p.project.title }, { projectId: p.root, actions: ['skip'] });
    if (tg.side === 'client' && serverOnly) ctx.issue('warning', 'serverOnlyOnClient', { title: p.project.title }, { projectId: p.root, actions: ['skip'] });
  }
}

// ---------- 9. Shaders sin Iris/OptiFine ----------
async function shaderFix(ctx, signal) {
  const tg = ctx.target;
  const fixPid = ['fabric', 'quilt', 'neoforge'].includes(tg.loader) ? IRIS : tg.loader === 'forge' ? OCULUS : null;
  if (!fixPid) return null;
  if (ctx.suggestions.has(fixPid)) return ctx.suggestions.get(fixPid);
  const project = await api.project(fixPid, { signal });
  if (!project) return null;
  const list = await api.projectVersions(fixPid, { loaders: tg.modLoaders, gameVersions: [tg.mcVersion], signal });
  const best = pickBest(list);
  if (!best) return null;
  const probe = { project, version: best };
  const v = (await firstClean(ctx, probe, [best, ...list.filter((x) => x.id !== best.id)], signal, 6)) || best;
  const deps = [];
  for (const d of v.dependencies || []) {
    if (d.dependency_type !== 'required') continue;
    let dv = d.version_id ? await api.version(d.version_id, { signal }) : null;
    const pid = d.project_id || dv?.project_id;
    if (!pid || ctx.planned.has(pid) || installedFiles(ctx, pid, null).some((f) => f.enabled)) continue;
    if (!isCompatible(dv, tg.modLoaders, tg.mcVersion)) dv = pickBest(await api.projectVersions(pid, { loaders: tg.modLoaders, gameVersions: [tg.mcVersion], signal }));
    if (!dv) continue;
    const dp = await api.project(pid, { signal });
    deps.push({ projectId: pid, versionId: dv.id, versionNumber: dv.version_number, title: dp?.title || pid, icon: dp?.icon_url || null, type: 'mod', size: primaryFile(dv)?.size || 0 });
  }
  const fix = { project, version: v, type: 'mod', reason: 'fix', requiredBy: new Set(), root: null, deps };
  ctx.suggestions.set(fixPid, fix);
  return fix;
}

async function checkShaders(ctx, signal) {
  const tg = ctx.target;
  const shaders = [...ctx.planned.values()].filter((p) => p.type === 'shader' && p.reason === 'requested');
  if (!shaders.length || tg.kind !== 'instance') return;
  const support = shaderSupport(ctx);
  for (const p of shaders) {
    const vars = { title: p.project.title };
    const vl = p.version.loaders || [];
    if (!support) {
      if (vl.includes('vanilla') && !vl.includes('iris') && !vl.includes('optifine')) continue; // shaders del juego base
      if (!['fabric', 'quilt', 'neoforge', 'forge'].includes(tg.loader)) {
        ctx.issue('warning', 'shaderVanilla', { ...vars, loader: targets.loaderName(tg.loader) }, { projectId: p.root, actions: ['skip'] });
        continue;
      }
      const fix = await shaderFix(ctx, signal);
      if (fix) {
        fix.requiredBy.add(p.project.id);
        if (!fix.root) fix.root = p.root;
        ctx.issue('warning', 'shaderNoLoader', { ...vars, fix: fix.project.title }, { projectId: p.root, relatedProjectId: fix.project.id, actions: ['addFix', 'skip'], fix: fix.project.id });
      } else ctx.issue('warning', 'shaderNoLoaderNoFix', { ...vars, loader: targets.loaderName(tg.loader), mc: tg.mcVersion }, { projectId: p.root, actions: ['skip'] });
      continue;
    }
    if (support === 'optifine' && !vl.includes('optifine')) ctx.issue('warning', 'shaderLoaderMismatch', { ...vars, loaders: targets.andList(vl.map(targets.loaderName)), current: 'OptiFine' }, { projectId: p.root, actions: ['pickVersion', 'skip'] });
    if (support === 'iris' && !vl.includes('iris') && !vl.includes('optifine')) ctx.issue('warning', 'shaderLoaderMismatch', { ...vars, loaders: targets.andList(vl.map(targets.loaderName)), current: 'Iris' }, { projectId: p.root, actions: ['pickVersion', 'skip'] });
  }
}

// ---------- 10. Formato de resource packs / data packs ----------
function checkPacks(ctx) {
  const mc = ctx.target.mcVersion;
  for (const p of ctx.planned.values()) {
    if (p.reason !== 'requested' || (p.type !== 'resourcepack' && p.type !== 'datapack') || !p.meta?.pack) continue;
    const r = formats.checkPack(p.type, mc, p.meta.pack);
    if (r && !r.ok) ctx.issue('warning', 'packFormat', { title: p.project.title, format: p.meta.pack.format ?? p.meta.pack.min, expected: r.expected, mc }, { projectId: p.root, actions: ['pickVersion', 'skip'] });
  }
}

// ---------- Resultado ----------
function plannedInfo(p) {
  const f = primaryFile(p.version);
  return {
    projectId: p.project.id,
    versionId: p.version.id,
    versionNumber: p.version.version_number,
    versionType: p.version.version_type,
    title: p.project.title,
    icon: p.project.icon_url || null,
    slug: p.project.slug,
    type: p.type,
    reason: p.reason,
    requiredBy: [...(p.requiredBy || [])],
    root: p.root || null,
    size: f?.size || 0,
    filename: f?.filename || null,
    already: Boolean(p.alreadyInstalled),
    deps: p.deps || [],
  };
}

function summarize(ctx) {
  const tg = ctx.target;
  const by = (s) => ctx.issues.filter((i) => i.severity === s);
  const errors = by('error');
  const warnings = by('warning');
  const infos = by('info');
  for (const res of ctx.items) {
    const mine = ctx.issues.filter((i) => i.projectId === res.projectId);
    res.status = mine.some((i) => i.severity === 'error') ? 'error' : mine.some((i) => i.severity === 'warning') ? 'warning' : mine.some((i) => i.severity === 'info') ? 'info' : 'ok';
  }
  // Datos del archivo que va a ocupar el lugar de cada reemplazado (para el historial)
  for (const r of ctx.replace) {
    const p = ctx.planned.get(r.projectId);
    const pf = p ? primaryFile(p.version) : null;
    Object.assign(r, { newFile: pf?.filename || null, newVersionId: p?.version.id || null, newVersionNumber: p?.version.version_number || null, newTitle: p?.project.title || null });
  }
  return {
    ok: !errors.length && !warnings.length,
    target: { kind: tg.kind, id: tg.id, name: tg.name, mcVersion: tg.mcVersion, loader: tg.loader, loaderName: targets.loaderName(tg.loader), side: tg.side },
    items: ctx.items,
    toInstall: [...ctx.planned.values()].map(plannedInfo),
    suggestions: [...ctx.suggestions.values()].map(plannedInfo),
    replace: ctx.replace,
    enable: ctx.enable,
    adopt: ctx.adopt,
    errors,
    warnings,
    infos,
    checkedAt: Date.now(),
  };
}

async function check(input = {}, { signal } = {}) {
  const target = await targets.load(input.target);
  const list = normalizeItems(input.items);
  if (!list.length) throw new Error(t('compat.errNoItems'));
  const inv = await inventory.scan(target, { signal });
  const ctx = createContext(target, inv);
  await resolveRequested(ctx, list, signal);
  checkInstalled(ctx);
  await resolveDependencies(ctx, signal);
  await fetchRemoteMeta(ctx, signal);
  checkDuplicates(ctx);
  await checkDeclaredIncompat(ctx, signal);
  checkJarMeta(ctx);
  await suggestBetterVersions(ctx, signal);
  checkSides(ctx);
  await checkShaders(ctx, signal);
  checkPacks(ctx);
  inventory.flush().catch(() => {});
  return summarize(ctx);
}

module.exports = { check, pickBest, primaryFile, isCompatible, itemType, slugIds, installedFiles, sideOf, predText };
