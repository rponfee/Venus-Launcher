'use strict';
// Instalacion desde CurseForge: archivos sueltos en una instancia (con sus dependencias requeridas)
// y modpacks (manifest.json + overrides) como instancia nueva. Los archivos cuyo autor no permite
// descargas desde otras apps se devuelven en "manual" con el link para bajarlos a mano.
const fsp = require('fs/promises');
const path = require('path');
const AdmZip = require('adm-zip');
const paths = require('../../core/paths');
const http = require('../../core/http');
const instances = require('../../core/instances');
const { t } = require('../../core/i18n');
const { sanitizeFileName } = require('../../core/util');
const safety = require('../packs/safety');
const cf = require('./api');

const FOLDERS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };
const RELEASE_ORDER = { release: 0, beta: 1, alpha: 2 };

function safeName(name) {
  const base = sanitizeFileName(path.basename(String(name || '')));
  return base === '.' || base === '..' ? 'archivo' : base;
}

// Ruta dentro de la instancia validada con las reglas compartidas (sin '..', unidades, nombres de
// dispositivo ni archivos internos del launcher).
function inside(root, ...parts) {
  const dest = safety.resolveInside(root, parts.map((p) => String(p).replace(/\\/g, '/')).join('/'));
  if (!dest) throw new Error(t('curseforge.errBadPath'));
  return dest;
}

function checkWorld(world) {
  if (!world) throw new Error(t('curseforge.errNeedWorld'));
  if (typeof world !== 'string' || world !== path.basename(world) || world === '.' || world === '..') throw new Error(t('curseforge.errBadWorld'));
}

// Loader de CurseForge que usa una instancia (para filtrar archivos de mods).
function loaderFor(inst) {
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

// Mejor archivo para la instancia: misma version de Minecraft, loader compatible y el canal mas estable.
function pickFile(files, inst, type) {
  const loaders = loaderFor(inst);
  const ok = files.filter((f) => f.available !== false && !f.isServerPack && (!f.gameVersions.length || f.gameVersions.includes(inst.mcVersion)) && (type !== 'mod' || !f.loaders.length || f.loaders.some((l) => loaders.includes(l))));
  ok.sort((a, b) => (RELEASE_ORDER[a.releaseType] ?? 3) - (RELEASE_ORDER[b.releaseType] ?? 3) || new Date(b.date) - new Date(a.date));
  return ok[0] || null;
}

function manualEntry(mod, file, folder) {
  return {
    modId: mod.id,
    fileId: file.id,
    title: mod.title,
    fileName: safeName(file.fileName),
    folder,
    url: cf.fileWebUrl({ id: mod.id, links: { websiteUrl: mod.links?.website } }, file.id),
  };
}

// Instala un archivo (y sus dependencias requeridas) en una instancia existente.
async function installToInstance(instanceId, modId, fileId, { world, task, dependencies = true } = {}) {
  const inst = await instances.get(instanceId);
  const installed = inst.curseforge?.projects || {};
  const visited = new Set();
  const plan = [];
  const warnings = [];

  async function add(mId, fId, depth) {
    if (depth > 4 || visited.has(mId)) return;
    visited.add(mId);
    if (depth > 0 && installed[mId]) return;
    const mod = cf.normalizeMod(await cf.getModRaw(mId));
    if (mod.project_type === 'modpack') throw new Error(t('curseforge.errModpackToInstance'));
    let file;
    if (fId) file = cf.normalizeFile(await cf.getFileRaw(mId, fId));
    else {
      const loaders = mod.project_type === 'mod' ? loaderFor(inst) : [];
      const { data } = await cf.getModFiles(mId, { gameVersion: inst.mcVersion, loader: loaders[0], pageSize: 50 });
      file = pickFile(data.map(cf.normalizeFile), inst, mod.project_type);
      if (!file) {
        warnings.push(t('curseforge.warnDepNoFile', { title: mod.title, mc: inst.mcVersion }));
        return;
      }
    }
    plan.push({ mod, file, type: mod.project_type });
    if (!dependencies) return;
    for (const dep of file.dependencies) {
      if (dep.type === 'incompatible' && installed[dep.modId]) warnings.push(t('curseforge.warnIncompatible', { title: mod.title, other: installed[dep.modId].title || dep.modId }));
      if (dep.type === 'required') await add(dep.modId, null, depth + 1);
    }
  }

  await add(Number(modId), fileId ? Number(fileId) : null, 0);

  const root = path.resolve(inst.dir);
  const items = [];
  const records = {};
  const manual = [];
  for (const p of plan) {
    let folder = FOLDERS[p.type] || 'mods';
    if (p.type === 'datapack') {
      checkWorld(world);
      folder = path.join('saves', world, 'datapacks');
    }
    const fileName = safeName(p.file.fileName);
    const dest = inside(root, folder, fileName);
    const url = p.file.downloadUrl || (await cf.getDownloadUrl(p.mod.id, p.file.id));
    if (!url) {
      manual.push(manualEntry(p.mod, p.file, folder));
      continue;
    }
    const prev = installed[p.mod.id];
    if (prev?.file && prev.file !== fileName) await fsp.rm(inside(root, prev.folder || folder, path.basename(prev.file)), { force: true }).catch(() => {});
    items.push({ url, path: dest, sha1: p.file.sha1 || undefined, size: p.file.size || undefined });
    records[p.mod.id] = {
      title: p.mod.title,
      icon: p.mod.icon_url || null,
      type: p.type,
      fileId: p.file.id,
      versionNumber: p.file.displayName,
      file: fileName,
      folder,
      installedAt: Date.now(),
    };
  }
  if (items.length) await http.downloadAll(items, { concurrency: 6, verify: 'hash', signal: task?.signal, onProgress: task?.downloadProgress('CurseForge') });
  if (Object.keys(records).length) {
    // Dentro de la cola de la instancia: otra instalacion en paralelo no pierde sus registros.
    await instances.update(instanceId, (fresh) => ({ curseforge: { ...(fresh.curseforge || {}), projects: { ...(fresh.curseforge?.projects || {}), ...records } } }));
  }
  return { installed: Object.values(records).map((r) => r.title), manual, warnings };
}

// "forge-47.2.0" -> { loader: 'forge', loaderVersion: '47.2.0' } (el instalador acepta la version corta).
function packLoader(list = []) {
  const primary = list.find((l) => l.primary) || list[0];
  const m = String(primary?.id || '').match(/^(forge|neoforge|fabric|quilt)-(.+)$/i);
  if (!m) return { loader: 'vanilla', loaderVersion: null };
  return { loader: m[1].toLowerCase(), loaderVersion: m[2] };
}

// Crea una instancia nueva a partir de un modpack de CurseForge.
async function installModpack(modId, fileId, { task, name, onCreated } = {}) {
  const mod = cf.normalizeMod(await cf.getModRaw(modId));
  if (mod.project_type !== 'modpack') throw new Error(t('curseforge.errNotModpack'));
  const file = cf.normalizeFile(await cf.getFileRaw(modId, fileId));
  const url = file.downloadUrl || (await cf.getDownloadUrl(modId, fileId));
  if (!url) {
    const entry = manualEntry(mod, file, '');
    throw Object.assign(new Error(t('curseforge.errManualPack', { title: mod.title })), { code: 'manual', url: entry.url });
  }
  task?.update({ detail: t('curseforge.stepDownloadPack'), progress: null });
  const zipPath = paths.cache('modpacks', `cf-${file.id}-${safeName(file.fileName)}`);
  await http.download({ url, path: zipPath, sha1: file.sha1 || undefined, size: file.size || undefined }, { verify: 'hash', signal: task?.signal });

  let zip;
  let manifest;
  try {
    zip = new AdmZip(zipPath);
    manifest = JSON.parse(zip.readAsText('manifest.json'));
  } catch {
    throw new Error(t('curseforge.errBadPack'));
  }
  const mc = manifest?.minecraft?.version;
  if (!mc) throw new Error(t('curseforge.errBadPack'));
  const { loader, loaderVersion } = packLoader(manifest.minecraft.modLoaders);
  const pack = { projectId: mod.id, fileId: file.id, name: manifest.name || mod.title, version: manifest.version || file.displayName };
  const inst = await instances.create({ name: name || mod.title || manifest.name, mcVersion: mc, loader, loaderVersion, icon: mod.icon_url || null });
  await instances.update(inst.id, { curseforge: { pack, projects: {} } });
  onCreated?.(inst);
  task?.update({ title: t('curseforge.taskModpack', { name: inst.name }), detail: t('curseforge.stepResolve'), progress: null });

  const entries = (manifest.files || []).filter((f) => f && f.projectID && f.fileID && f.required !== false);
  const [rawFiles, rawMods] = await Promise.all([cf.getFiles(entries.map((f) => f.fileID)), cf.getMods(entries.map((f) => f.projectID))]);
  const fileById = new Map(rawFiles.map((f) => [f.id, f]));
  const modById = new Map(rawMods.map((m) => [m.id, m]));
  const root = path.resolve(inst.dir);
  const items = [];
  const manual = [];
  const records = {};
  for (const e of entries) {
    const rawMod = modById.get(e.projectID);
    const m = cf.normalizeMod(rawMod) || { id: e.projectID, title: String(e.projectID), links: {} };
    const folder = FOLDERS[cf.typeForClass(rawMod?.classId)] || 'mods';
    const raw = fileById.get(e.fileID);
    if (!raw) {
      manual.push({ modId: e.projectID, fileId: e.fileID, title: m.title, fileName: '', folder, url: cf.fileWebUrl({ id: m.id, links: { websiteUrl: m.links?.website } }, e.fileID) });
      continue;
    }
    const f = cf.normalizeFile(raw);
    const fileName = safeName(f.fileName);
    let dest;
    try {
      dest = inside(root, folder, fileName);
    } catch {
      continue;
    }
    if (!f.downloadUrl) {
      manual.push(manualEntry(m, f, folder));
      continue;
    }
    items.push({ url: f.downloadUrl, path: dest, sha1: f.sha1 || undefined, size: f.size || undefined });
    records[m.id] = { title: m.title, icon: m.icon_url || null, type: cf.typeForClass(rawMod?.classId), fileId: f.id, versionNumber: f.displayName, file: fileName, folder, installedAt: Date.now() };
  }
  if (items.length) await http.downloadAll(items, { concurrency: 8, verify: 'hash', signal: task?.signal, onProgress: task?.downloadProgress('CurseForge') });

  // overrides: configuracion, scripts y recursos que trae el pack. Solo rutas seguras (nunca
  // venus-instance.json ni .venus/: un pack podria cambiar la ruta de Java) y con temporal + renombrado
  // (si el archivo ya existia y era un enlace duro del almacen, las otras instancias no cambian).
  const prefix = `${String(manifest.overrides || 'overrides').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/`;
  const skipped = [];
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (entry.isDirectory || !name.startsWith(prefix)) continue;
    const rel = name.slice(prefix.length);
    if (!rel) continue;
    const dest = safety.resolveInside(root, rel);
    if (!dest) {
      skipped.push(rel.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 120));
      continue;
    }
    if (task?.signal?.aborted) throw task.signal.reason || new Error(t('storage.errCancelled'));
    await safety.writeFileAtomic(dest, entry.getData());
  }
  const warnings = [];
  if (skipped.length) {
    warnings.push(t('curseforge.warnUnsafePaths', { count: skipped.length, files: skipped.slice(0, 5).join(', ') }));
    console.warn('[curseforge] modpack:', warnings[0]);
  }
  await instances.update(inst.id, { curseforge: { pack, projects: records } });
  await instances.prepare(inst.id, task);
  return { instance: await instances.get(inst.id), manual, installed: Object.values(records).map((r) => r.title), warnings };
}

module.exports = { installToInstance, installModpack, pickFile, packLoader, loaderFor };
