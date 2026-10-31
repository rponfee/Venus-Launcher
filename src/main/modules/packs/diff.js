'use strict';
// Que cambia al actualizar un modpack de Modrinth: mods agregados, quitados y actualizados (con la version
// vieja y la nueva), cambios en los overrides (configuracion), version de Minecraft y loader, y avisos de lo
// que puede romper la partida (saltos grandes de version, mods de contenido que se van, frases de riesgo en
// los changelogs, mundos que se actualizan sin vuelta atras).
const fsp = require('fs/promises');
const path = require('path');
const instances = require('../../core/instances');
const modrinth = require('../../core/modrinth');
const lookup = require('./lookup');
const { userError, clientFiles, readState, writeState, packInfo, resolveInside, allowedUrls, hostOf } = require('./state');
const { readPack, fetchVersion } = require('./mrpack');
const { rootOf } = require('../snapshots/scan');

const TYPE_BY_FOLDER = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader', datapacks: 'datapack' };
const USER_FOLDERS = ['mods', 'resourcepacks', 'shaderpacks'];
const LOADER_NAMES = instances.LOADER_NAMES;
const LIST_CAP = 300;

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

function typeOf(rel, project) {
  if (project?.project_type === 'shader') return 'shader';
  if (project?.project_type === 'resourcepack') return 'resourcepack';
  if (project?.project_type === 'datapack' || rel.includes('/datapacks/')) return 'datapack';
  return TYPE_BY_FOLDER[rel.split('/')[0]] || 'file';
}

function shortLoaderVersion(mc, loader, version) {
  if (!version) return null;
  let v = String(version);
  if (mc && v.startsWith(`${mc}-`)) v = v.slice(mc.length + 1);
  return v;
}

// Estado instalado: el guardado al instalar/actualizar o, si falta, reconstruido desde el .mrpack de la version.
async function installedState(inst, { signal, persist = true } = {}) {
  const pack = packInfo(inst);
  const state = await readState(inst.dir);
  if (state && pack?.versionId && state.meta.versionId === pack.versionId) return { ...state, source: state.meta.reconstructed ? 'reconstructed' : 'saved' };
  if (pack?.versionId) {
    let fetched;
    try {
      fetched = await fetchVersion(pack.versionId, signal);
    } catch (err) {
      // La version instalada ya no esta en Modrinth: se compara con los archivos locales.
      if (err?.code === 'notfound' || err?.code === 'gone' || err?.status === 404 || err?.status === 410) return { meta: null, index: null, overrides: null, files: null, source: 'unknown' };
      throw err;
    }
    const { file, version } = fetched;
    const { index, overrides } = await readPack(file);
    const files = {};
    for (const f of clientFiles(index).values()) {
      const p = resolveInside(inst.dir, f.path);
      if (p && ((await exists(p)) || (await exists(`${p}.disabled`)))) files[f.path] = { sha1: f.sha1, src: 'index' };
    }
    for (const [rel, sha1] of Object.entries(overrides)) {
      const p = resolveInside(inst.dir, rel);
      if (p && (await exists(p))) files[rel] = { sha1, src: 'override' };
    }
    const meta = { projectId: pack.projectId, versionId: pack.versionId, versionNumber: version.version_number, reconstructed: true, installedAt: null };
    if (persist) await writeState(inst.dir, { meta, index, overrides, files }).catch(() => {});
    return { meta, index, overrides, files, source: 'reconstructed' };
  }
  return { meta: null, index: null, overrides: null, files: null, source: 'unknown' };
}

// ---------- Overrides que son del jugador ----------
// Lo que entra en la instantanea (config, opciones, mods, packs) sigue la regla de tres vias: si el pack lo
// cambio, se reemplaza y lo del jugador queda en la instantanea. Lo que la instantanea no puede devolver
// (mundos, servers.dat, datos de minimapas...) no se pisa nunca si el jugador lo tiene cambiado.

// Mundo (carpeta dentro de saves/) de una ruta de override, o null.
function worldOf(rel) {
  const m = /^saves\/([^/]+)\//.exec(rel);
  return m ? m[1] : null;
}

function inSnapshot(rel) {
  const root = rootOf(rel);
  return Boolean(root) && !root.startsWith('saves/');
}

// Mundos del jugador: ya existen y no estan como los dejo el pack (el juego reescribe level.dat cada vez que
// guarda, asi que si cambio, se jugo; tampoco si no venian en la version instalada o no se sabe cual es).
// La actualizacion no les toca nada: ni reemplaza, ni agrega, ni borra archivos.
async function playerWorlds(instDir, oldO, rels) {
  const out = new Set();
  for (const w of new Set(rels.map(worldOf).filter(Boolean))) {
    const dir = resolveInside(instDir, `saves/${w}`);
    if (!dir || !(await exists(dir))) continue;
    const level = `saves/${w}/level.dat`;
    if (!oldO?.[level] || (await lookup.localSha1(path.join(dir, 'level.dat'))) !== oldO[level]) out.add(w);
  }
  return out;
}

// true si al actualizar se conserva el archivo del jugador en lugar del que trae el pack (rel: un override que
// el pack agrega o cambia; worlds: los de playerWorlds).
async function keepsLocal(rel, abs, oldO, worlds) {
  const w = worldOf(rel);
  if (w && worlds.has(w)) return true;
  if (!w && inSnapshot(rel)) return false;
  if (!(await exists(abs))) return false;
  // Cambiado por el jugador (o no se sabe: version instalada desconocida o archivo que el pack no traia)
  return !oldO || oldO[rel] === undefined || (await lookup.localSha1(abs)) !== oldO[rel];
}

// Archivos del usuario (no los maneja el pack) en mods/resourcepacks/shaderpacks.
async function userFiles(instDir, managed) {
  const out = [];
  for (const folder of USER_FOLDERS) {
    const entries = await fsp.readdir(path.join(instDir, folder), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue;
      const rel = `${folder}/${e.name}`;
      const base = rel.replace(/\.disabled$/i, '');
      if (managed.has(base)) continue;
      out.push({ rel, base, abs: path.join(instDir, folder, e.name), disabled: /\.disabled$/i.test(e.name) });
    }
  }
  return out;
}

function describe(f, vmap, projects) {
  const v = f.sha1 ? vmap[f.sha1] : null;
  const p = v ? projects.get(v.project_id) : null;
  return {
    path: f.path,
    file: path.basename(f.path),
    type: typeOf(f.path, p),
    projectId: v?.project_id || null,
    versionId: v?.id || null,
    versionNumber: v?.version_number || null,
    versionType: v?.version_type || null,
    date: v?.date_published || null,
    gameVersions: v?.game_versions || [],
    title: p?.title || lookup.prettyName(f.path),
    icon: p?.icon_url || null,
    slug: p?.slug || null,
    content: lookup.isContentMod(p),
    size: f.size || 0,
    changelog: v?.changelog || '',
  };
}

function pairKey(d) {
  return d.projectId ? `p:${d.projectId}` : `n:${d.type}:${lookup.nameKey(d.file)}`;
}

/**
 * Empareja los archivos de dos indices. Devuelve { added, removed, updated, unchanged, pairs }
 * pairs: Map rutaNueva -> rutaVieja (para pasar el estado desactivado al actualizar).
 * keepUnpaired: modo "version instalada desconocida" (lo viejo sin pareja no se quita).
 */
function matchFiles(oldMap, newMap, vmap, projects, { keepUnpaired = false } = {}) {
  const oldDesc = new Map([...oldMap].map(([p, f]) => [p, describe(f, vmap, projects)]));
  const newDesc = new Map([...newMap].map(([p, f]) => [p, describe(f, vmap, projects)]));
  const added = [];
  const removed = [];
  const updated = [];
  const pairs = new Map();
  let unchanged = 0;
  const restOld = new Map(oldDesc);
  const restNew = new Map(newDesc);
  const sameFile = (a, b) => (a.sha1 && b.sha1 ? a.sha1 === b.sha1 : Boolean(a.sha512 && a.sha512 === b.sha512));
  const upd = (o, n) => ({
    ...n,
    oldPath: o.path,
    oldFile: o.file,
    from: o.versionNumber,
    to: n.versionNumber,
    oldDate: o.date,
    bump: lookup.bumpKind(o.versionNumber, n.versionNumber, o.gameVersions, n.gameVersions, { zeroMinor: n.content || o.content }),
    content: n.content || o.content,
  });
  for (const [p, n] of newDesc) {
    const o = oldDesc.get(p);
    if (!o) continue;
    restOld.delete(p);
    restNew.delete(p);
    pairs.set(p, p);
    if (sameFile(oldMap.get(p), newMap.get(p))) unchanged++;
    else updated.push(upd(o, n));
  }
  const byKey = new Map();
  for (const o of restOld.values()) {
    const k = pairKey(o);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(o);
  }
  for (const n of restNew.values()) {
    const list = byKey.get(pairKey(n));
    if (list?.length) {
      const o = list.shift();
      restOld.delete(o.path);
      pairs.set(n.path, o.path);
      if (sameFile(oldMap.get(o.path), newMap.get(n.path))) unchanged++;
      else updated.push(upd(o, n));
    } else added.push(n);
  }
  if (!keepUnpaired) for (const o of restOld.values()) removed.push(o);
  return { added, removed, updated, unchanged, pairs, oldDesc, newDesc };
}

function overrideChanges(oldO, newO) {
  const next = newO || {};
  if (!oldO) return { known: false, added: Object.keys(next).sort(), changed: [], removed: [] };
  const added = [];
  const changed = [];
  const removed = [];
  for (const [rel, h] of Object.entries(next)) {
    if (!(rel in oldO)) added.push(rel);
    else if (oldO[rel] !== h) changed.push(rel);
  }
  for (const rel of Object.keys(oldO)) if (!(rel in next)) removed.push(rel);
  return { known: true, added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

// Frases de riesgo en versiones intermedias de los mods que mas cambian (pocos pedidos: como mucho 20).
async function intermediateRisks(updated, loaders, gameVersions, signal) {
  const candidates = updated
    .filter((u) => u.projectId && (u.bump === 'major' || u.content) && u.oldDate && u.date)
    .sort((a, b) => Number(b.bump === 'major') - Number(a.bump === 'major') || Number(b.content) - Number(a.content))
    .slice(0, 20);
  await pool(candidates, 4, async (u) => {
    if (signal?.aborted) return;
    try {
      const list = await modrinth.getVersions(u.projectId, { loaders, gameVersions });
      const from = Date.parse(u.oldDate);
      const to = Date.parse(u.date);
      for (const v of list || []) {
        const d = Date.parse(v.date_published);
        if (!(d > from && d < to)) continue;
        for (const line of lookup.riskLines(v.changelog, 2)) if (!u.lines.includes(line) && u.lines.length < 3) u.lines.push(line);
      }
    } catch {
      /* sin changelogs intermedios: alcanza con el de la version nueva */
    }
  });
}

function slimVersion(v, installedId) {
  return {
    id: v.id,
    number: v.version_number,
    name: v.name,
    date: v.date_published,
    type: v.version_type,
    mc: v.game_versions || [],
    loaders: v.loaders || [],
    installed: v.id === installedId,
  };
}

/**
 * Compara la version instalada del modpack con otra (por defecto, la mas nueva).
 */
async function diff(instanceId, versionId, { signal } = {}) {
  const inst = await instances.get(instanceId);
  const pack = packInfo(inst);
  if (!pack?.projectId) throw userError('packs.errNotModrinthPack');
  // Lista sin changelogs (hay packs con cientos de versiones); los que hacen falta se piden despues en lote.
  const [project, versions] = await Promise.all([modrinth.getProject(pack.projectId), modrinth.getVersions(pack.projectId, { includeChangelog: false })]);
  const sorted = [...(versions || [])].sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published));
  if (!sorted.length) throw userError('packs.errNoVersions');
  const installedVersion = pack.versionId ? sorted.find((v) => v.id === pack.versionId) || (await modrinth.getVersion(pack.versionId).catch(() => null)) : null;
  // Por defecto: la release mas nueva para la MISMA version de Minecraft (no cambia el formato de los mundos);
  // si no hay, la release mas nueva; si ya tenes algo mas nuevo (ej. una beta), la mas nueva de todas.
  let target = null;
  if (versionId) target = sorted.find((v) => v.id === versionId) || (await modrinth.getVersion(versionId).catch(() => null));
  else {
    const instDate0 = installedVersion ? Date.parse(installedVersion.date_published) : 0;
    const mc = installedVersion?.game_versions?.length ? installedVersion.game_versions : [inst.mcVersion];
    const sameMc = sorted.find((v) => v.version_type === 'release' && Date.parse(v.date_published) > instDate0 && (v.game_versions || []).some((g) => mc.includes(g)));
    target = sameMc || sorted.find((v) => v.version_type === 'release') || sorted[0];
    if (installedVersion && Date.parse(target.date_published) < instDate0) target = sorted[0];
  }
  if (!target || target.project_id !== pack.projectId) throw userError('packs.errWrongVersion');

  const base = {
    instance: { id: inst.id, name: inst.name, mcVersion: inst.mcVersion, loader: inst.loader, loaderVersion: inst.loaderVersion || null },
    pack: { projectId: project.id, title: project.title, icon: project.icon_url || null, slug: project.slug },
    installed: installedVersion
      ? { versionId: installedVersion.id, number: installedVersion.version_number, name: installedVersion.name, date: installedVersion.date_published, type: installedVersion.version_type }
      : { versionId: pack.versionId || null, number: pack.version || null, name: pack.name || null, date: null, type: null },
    target: { versionId: target.id, number: target.version_number, name: target.name, date: target.date_published, type: target.version_type, mc: target.game_versions || [], loaders: target.loaders || [] },
    versions: sorted.map((v) => slimVersion(v, pack.versionId)),
    upToDate: Boolean(installedVersion && installedVersion.id === target.id),
  };
  if (base.upToDate) {
    return { ...base, changes: null, warnings: [], deps: null, summary: null, packChangelogs: [], download: { files: 0, bytes: 0 } };
  }

  const old = await installedState(inst, { signal });
  const { file: targetFile } = await fetchVersion(target.id, signal);
  const next = await readPack(targetFile);

  const oldMap = old.index ? clientFiles(old.index) : new Map();
  const newMap = clientFiles(next.index);
  const unknown = !old.index;

  // Sin version instalada conocida: se comparan los archivos locales (se identifican por hash).
  const localAsOld = new Map();
  if (unknown) {
    for (const folder of USER_FOLDERS) {
      const entries = await fsp.readdir(path.join(inst.dir, folder), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isFile() || /\.disabled$/i.test(e.name)) continue;
        const rel = `${folder}/${e.name}`;
        const sha1 = await lookup.localSha1(path.join(inst.dir, folder, e.name));
        if (sha1) localAsOld.set(rel, { path: rel, sha1, sha512: null, size: 0 });
      }
    }
  }
  const oldFiles = unknown ? localAsOld : oldMap;

  // Usuario: archivos agregados a mano (se conservan) y duplicados de mods que trae el pack nuevo.
  const managed = new Set([...oldMap.keys(), ...Object.keys(old.overrides || {}), ...Object.keys(old.files || {})]);
  const users = unknown ? [] : (await userFiles(inst.dir, managed)).filter((u) => !newMap.has(u.base));
  const userHashes = {};
  for (const u of users) if (!u.disabled) userHashes[u.rel] = await lookup.localSha1(u.abs);

  const allHashes = [...[...oldFiles.values()].map((f) => f.sha1), ...[...newMap.values()].map((f) => f.sha1), ...Object.values(userHashes)].filter(Boolean);
  const vmap = await lookup.versionsByHash(allHashes, { signal }).catch(() => ({}));
  const projectIds = Object.values(vmap)
    .filter(Boolean)
    .map((v) => v.project_id);
  const projects = await lookup.projectsByIds(projectIds).catch(() => new Map());

  const m = matchFiles(oldFiles, newMap, vmap, projects, { keepUnpaired: unknown });
  for (const u of m.updated) u.lines = lookup.riskLines(u.changelog, 2);

  // Dependencias (Minecraft y loader)
  const od = old.index?.dependencies || null;
  const nd = next.index.dependencies || {};
  const ol = od ? modrinth.packLoader(od) : { loader: inst.loader, loaderVersion: inst.loaderVersion };
  const nl = modrinth.packLoader(nd);
  const fromMc = od?.minecraft || inst.mcVersion;
  const deps = {
    minecraft: { from: fromMc, to: nd.minecraft, changed: fromMc !== nd.minecraft },
    loader: {
      from: { loader: ol.loader, version: shortLoaderVersion(fromMc, ol.loader, ol.loaderVersion) },
      to: { loader: nl.loader, version: shortLoaderVersion(nd.minecraft, nl.loader, nl.loaderVersion) },
      kindChanged: ol.loader !== nl.loader,
    },
  };
  deps.loader.versionChanged = !deps.loader.kindChanged && deps.loader.from.version !== deps.loader.to.version;

  await intermediateRisks(m.updated, modrinth.modLoadersFor({ loader: nl.loader, mcVersion: nd.minecraft }), [nd.minecraft], signal);

  // Overrides: lo que cambia y lo que el usuario toco (se reemplaza; queda en la instantanea), y lo que se
  // conserva porque la instantanea no lo guarda (mundos del jugador y otros archivos que cambio)
  const ov = overrideChanges(old.overrides, next.overrides);
  const worldsKept = await playerWorlds(inst.dir, old.overrides, [...ov.added, ...ov.changed, ...ov.removed]);
  const keptWorlds = [...worldsKept].sort();
  const keptFiles = [];
  for (const rel of [...ov.added, ...ov.changed]) {
    const p = resolveInside(inst.dir, rel);
    if (p && !worldOf(rel) && (await keepsLocal(rel, p, old.overrides, worldsKept))) keptFiles.push(rel);
  }
  const userModified = [];
  if (ov.known) {
    for (const rel of [...ov.changed, ...ov.removed]) {
      if (!inSnapshot(rel)) continue; // mundos y archivos fuera de la instantanea: no se reemplazan
      const p = resolveInside(inst.dir, rel);
      if (!p || !(await exists(p))) continue;
      const h = await lookup.localSha1(p);
      if (h && h !== old.overrides[rel]) userModified.push(rel);
    }
  }

  // Duplicados: mods agregados a mano que son el mismo proyecto que uno del pack nuevo.
  const newProjects = new Map([...m.newDesc.values()].filter((d) => d.projectId).map((d) => [d.projectId, d]));
  const duplicates = [];
  for (const u of users) {
    const v = userHashes[u.rel] ? vmap[userHashes[u.rel]] : null;
    const n = v ? newProjects.get(v.project_id) : null;
    if (n && n.path !== u.base) duplicates.push({ file: u.rel, title: n.title, packFile: n.file });
  }

  // Archivos con origen no permitido (no se pueden descargar)
  const blocked = [...newMap.values()].filter((f) => !allowedUrls(f.downloads).length || (!f.sha1 && !f.sha512)).map((f) => `${f.path} (${hostOf(f.downloads)})`);

  // Changelogs del pack entre la version instalada y la elegida
  const instDate = installedVersion ? Date.parse(installedVersion.date_published) : null;
  const tgtDate = Date.parse(target.date_published);
  // Solo la misma rama de Minecraft que la version elegida (los packs publican varias ramas en paralelo).
  const tgtMc = new Set(target.game_versions || []);
  const between = sorted.filter((v) => {
    const d = Date.parse(v.date_published);
    if (v.id !== target.id && tgtMc.size && !(v.game_versions || []).some((g) => tgtMc.has(g))) return false;
    return (instDate === null ? v.id === target.id : d > instDate) && d <= tgtDate;
  });
  // Changelogs en un solo pedido (los 60 mas nuevos alcanzan para buscar avisos; se muestran 12)
  const logs = new Map();
  try {
    for (const v of await modrinth.getVersionsByIds(between.slice(0, 60).map((v) => v.id))) logs.set(v.id, v.changelog || '');
  } catch {
    /* sin changelogs: la comparacion sigue igual */
  }
  const packChangelogs = between.slice(0, 12).map((v) => ({ id: v.id, number: v.version_number, date: v.date_published, changelog: String(logs.get(v.id) ?? v.changelog ?? '').slice(0, 6000) }));
  const packLines = [];
  for (const v of between) for (const line of lookup.riskLines(logs.get(v.id) ?? v.changelog, 3)) if (packLines.length < 4 && !packLines.includes(line)) packLines.push(line);

  // ---------- Avisos ----------
  const warnings = [];
  if (deps.minecraft.changed) warnings.push({ level: 'high', code: 'mcChange', vars: { from: deps.minecraft.from, to: deps.minecraft.to } });
  if (deps.loader.kindChanged) warnings.push({ level: 'high', code: 'loaderChange', vars: { from: LOADER_NAMES[ol.loader] || ol.loader, to: LOADER_NAMES[nl.loader] || nl.loader } });
  else if (deps.loader.versionChanged && nl.loader !== 'vanilla') warnings.push({ level: 'info', code: 'loaderUpdate', vars: { loader: LOADER_NAMES[nl.loader] || nl.loader, from: deps.loader.from.version || '?', to: deps.loader.to.version || '?' } });
  if (instDate !== null && tgtDate < instDate) warnings.push({ level: 'medium', code: 'packDowngrade', vars: { from: base.installed.number, to: target.version_number } });
  const removedContent = m.removed.filter((d) => d.content);
  if (removedContent.length) warnings.push({ level: 'high', code: 'removedContent', vars: { count: removedContent.length }, items: removedContent.map((d) => ({ title: d.title })) });
  const majors = m.updated.filter((u) => u.bump === 'major').sort((a, b) => Number(b.content) - Number(a.content));
  // Saltos grandes: en mods de contenido pueden cambiar bloques y el formato del mundo; en el resto es informativo.
  const contentMajors = majors.filter((u) => u.content);
  const otherMajors = majors.filter((u) => !u.content);
  if (contentMajors.length) warnings.push({ level: 'high', code: 'majorContent', vars: { count: contentMajors.length }, items: contentMajors.map((u) => ({ title: u.title, from: u.from, to: u.to, content: true })) });
  if (otherMajors.length) warnings.push({ level: 'info', code: 'majorUpdates', vars: { count: otherMajors.length }, items: otherMajors.map((u) => ({ title: u.title, from: u.from, to: u.to })) });
  const downs = m.updated.filter((u) => u.bump === 'downgrade');
  if (downs.length) warnings.push({ level: 'medium', code: 'downgrades', vars: { count: downs.length }, items: downs.map((u) => ({ title: u.title, from: u.from, to: u.to })) });
  const risky = m.updated.filter((u) => u.lines.length).map((u) => ({ title: u.title, from: u.from, to: u.to, lines: u.lines }));
  if (packLines.length) risky.unshift({ title: project.title, from: base.installed.number, to: target.version_number, lines: packLines, pack: true });
  if (risky.length) warnings.push({ level: 'medium', code: 'changelogRisk', vars: { count: risky.length }, items: risky });
  if (blocked.length) warnings.push({ level: 'high', code: 'blocked', vars: { count: blocked.length }, items: blocked.slice(0, 10).map((f) => ({ title: f })) });
  if (keptWorlds.length) warnings.push({ level: 'medium', code: 'worldOverrides', vars: { count: keptWorlds.length }, items: keptWorlds.slice(0, 10).map((w) => ({ title: w })) });
  if (keptFiles.length) warnings.push({ level: 'info', code: 'keptFiles', vars: { count: keptFiles.length }, items: keptFiles.slice(0, 10).map((f) => ({ title: f })) });
  if (userModified.length) warnings.push({ level: 'info', code: 'userConfig', vars: { count: userModified.length }, items: userModified.slice(0, 10).map((f) => ({ title: f })) });
  if (duplicates.length) warnings.push({ level: 'info', code: 'duplicates', vars: { count: duplicates.length }, items: duplicates.map((d) => ({ title: d.file, extra: d.title })) });
  if (unknown) warnings.push({ level: 'info', code: 'unknownInstalled', vars: {} });
  const rank = { high: 0, medium: 1, info: 2 };
  warnings.sort((a, b) => rank[a.level] - rank[b.level]);

  // ---------- Resumen ----------
  const strip = (d) => {
    const { changelog, gameVersions, ...rest } = d;
    return rest;
  };
  const byType = {};
  const bump = (type, key) => {
    byType[type] = byType[type] || { added: 0, removed: 0, updated: 0 };
    byType[type][key]++;
  };
  m.added.forEach((d) => bump(d.type, 'added'));
  m.removed.forEach((d) => bump(d.type, 'removed'));
  m.updated.forEach((d) => bump(d.type, 'updated'));
  const sortT = (a, b) => a.title.localeCompare(b.title);
  const downloadList = [...m.added, ...m.updated];

  return {
    ...base,
    installedSource: old.source,
    deps,
    changes: {
      added: m.added.sort(sortT).slice(0, LIST_CAP).map(strip),
      removed: m.removed.sort(sortT).slice(0, LIST_CAP).map(strip),
      updated: m.updated
        .sort((a, b) => Number(b.bump === 'major') - Number(a.bump === 'major') || sortT(a, b))
        .slice(0, LIST_CAP)
        .map((u) => ({ ...strip(u), changelog: String(u.changelog || '').slice(0, 1500) })),
      unchanged: m.unchanged,
      overrides: { known: ov.known, added: ov.added.slice(0, LIST_CAP), changed: ov.changed.slice(0, LIST_CAP), removed: ov.removed.slice(0, LIST_CAP), counts: { added: ov.added.length, changed: ov.changed.length, removed: ov.removed.length }, userModified, kept: keptFiles.slice(0, LIST_CAP), keptWorlds },
      userFiles: users.length,
      duplicates,
    },
    summary: { added: m.added.length, removed: m.removed.length, updated: m.updated.length, unchanged: m.unchanged, byType },
    warnings,
    packChangelogs,
    download: { files: downloadList.length, bytes: downloadList.reduce((a, d) => a + (d.size || 0), 0) },
  };
}

module.exports = { diff, installedState, matchFiles, overrideChanges, userFiles, describe, shortLoaderVersion, worldOf, playerWorlds, keepsLocal };
