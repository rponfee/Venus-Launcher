'use strict';
// Importar modpacks desde un archivo:
//  - .mrpack de Modrinth (si el archivo esta publicado en Modrinth, la instancia queda lista para actualizarse)
//  - .zip de CurseForge (manifest.json): necesita la API key de CurseForge (modulo curseforge)
//  - .zip de instancia de Prism Launcher / MultiMC (instance.cfg + mmc-pack.json + .minecraft/)
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const instances = require('../../core/instances');
const modrinth = require('../../core/modrinth');
const tasks = require('../../core/tasks');
const { t } = require('../../core/i18n');
const { rmrf, sanitizeFileName } = require('../../core/util');
const { openZip } = require('./zip');
const { userError, safePackRel, resolveInside, clientFiles, allowedUrls } = require('./state');
const { parseIndex, installPack, runDownloads } = require('./mrpack');

const SKIP_GAME = /^(logs|crash-reports|natives|\.fabric|\.mixin\.out|\.cache)(\/|$)/i;
const MR_ID = /^[A-Za-z0-9]{6,16}$/;
const busy = new Set();

function cfModule() {
  try {
    const cf = require('../curseforge');
    return typeof cf?.getFiles === 'function' && typeof cf?.getMods === 'function' ? cf : null;
  } catch {
    return null;
  }
}

async function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}

// instance.cfg (INI de Qt): clave=valor, con valores entre comillas opcionales.
function parseCfg(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('[') || line.startsWith(';') || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let v = line.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(["\\])/g, '$1');
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

function mmcLoader(components, cfg) {
  const list = Array.isArray(components) ? components : [];
  const get = (uid) => list.find((c) => c?.uid === uid);
  const mc = get('net.minecraft')?.version || cfg.IntendedVersion || null;
  const pick = (loader, uid) => ({ mc, loader, loaderVersion: get(uid)?.version || null });
  if (get('net.neoforged')) return pick('neoforge', 'net.neoforged');
  if (get('net.minecraftforge')) return pick('forge', 'net.minecraftforge');
  if (get('org.quiltmc.quilt-loader')) return pick('quilt', 'org.quiltmc.quilt-loader');
  if (get('net.fabricmc.fabric-loader')) return pick('fabric', 'net.fabricmc.fabric-loader');
  if (!list.length && cfg.ForgeVersion) return { mc, loader: 'forge', loaderVersion: cfg.ForgeVersion };
  const unsupported = list.find((c) => /liteloader|legacyfabric|optifine/i.test(c?.uid || ''));
  return { mc, loader: 'vanilla', loaderVersion: null, unsupported: unsupported?.cachedName || unsupported?.uid || null };
}

// "forge-47.2.0" -> { loader: 'forge', loaderVersion: '47.2.0' }
function cfLoader(list) {
  const arr = Array.isArray(list) ? list : [];
  const primary = arr.find((l) => l?.primary) || arr[0];
  const m = String(primary?.id || '').match(/^(forge|neoforge|fabric|quilt)-(.+)$/i);
  return m ? { loader: m[1].toLowerCase(), loaderVersion: m[2] } : { loader: 'vanilla', loaderVersion: null };
}

async function detect(zip) {
  if (zip.get('modrinth.index.json')) return { type: 'mrpack' };
  if (zip.get('manifest.json')) {
    try {
      const m = JSON.parse(await zip.readText('manifest.json'));
      if (m?.minecraft?.version && Array.isArray(m.files)) return { type: 'curseforge', manifest: m };
    } catch {
      /* no es un manifest de CurseForge */
    }
  }
  const cfg = zip.entries.filter((e) => !e.isDir && /^(?:[^/]+\/)?instance\.cfg$/.test(e.name)).sort((a, b) => a.name.length - b.name.length)[0];
  if (cfg) {
    const prefix = cfg.name.slice(0, -'instance.cfg'.length);
    const game = zip.entries.some((e) => e.name.startsWith(`${prefix}.minecraft/`)) ? `${prefix}.minecraft/` : `${prefix}minecraft/`;
    return { type: 'multimc', prefix, game };
  }
  return null;
}

async function identifyMrpack(file) {
  try {
    const sha1 = await sha1File(file);
    const v = await modrinth.api(`/version_file/${sha1}?algorithm=sha1`);
    if (!v?.project_id) return null;
    const p = await modrinth.getProject(v.project_id).catch(() => null);
    if (p && p.project_type !== 'modpack') return null;
    return { projectId: v.project_id, versionId: v.id, versionNumber: v.version_number, title: p?.title || null, icon: p?.icon_url || null };
  } catch {
    return null; // no esta publicado en Modrinth (o sin conexion)
  }
}

async function checkFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.(mrpack|zip)$/i.test(file)) throw userError('packs.errFileType');
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw userError('packs.errFileMissing');
  return st;
}

/**
 * Mira un archivo de modpack sin instalar nada. Devuelve tipo, nombre, version, Minecraft, loader y conteos.
 */
async function inspect(file) {
  const st = await checkFile(file);
  let zip;
  try {
    zip = await openZip(file);
  } catch (err) {
    if (err.code === 'BAD_ZIP') throw userError('packs.errNotZip');
    throw err;
  }
  try {
    const kind = await detect(zip);
    if (!kind) throw userError('packs.errUnknownFormat');
    const base = { file, fileName: path.basename(file), size: st.size, type: kind.type, warnings: [] };
    if (kind.type === 'mrpack') {
      const index = parseIndex(await zip.readText('modrinth.index.json'));
      const { loader, loaderVersion } = modrinth.packLoader(index.dependencies || {});
      const files = [...clientFiles(index).values()];
      const blocked = files.filter((f) => !allowedUrls(f.downloads).length || (!f.sha1 && !f.sha512));
      const overrides = zip.entries.filter((e) => !e.isDir && (e.name.startsWith('overrides/') || e.name.startsWith('client-overrides/'))).length;
      const mr = await identifyMrpack(file);
      if (blocked.length) base.warnings.push({ code: 'blocked', vars: { count: blocked.length } });
      return {
        ...base,
        name: String(index.name || path.basename(file, path.extname(file))).slice(0, 60),
        version: index.versionId || null,
        summary: index.summary || '',
        mcVersion: index.dependencies.minecraft,
        loader,
        loaderVersion,
        files: files.length,
        downloadBytes: files.reduce((a, f) => a + (f.size || 0), 0),
        overrides,
        modrinth: mr,
      };
    }
    if (kind.type === 'curseforge') {
      const m = kind.manifest;
      const { loader, loaderVersion } = cfLoader(m.minecraft.modLoaders);
      const cf = cfModule();
      const available = cf ? await Promise.resolve(cf.available()).catch(() => false) : false;
      const prefix = `${String(m.overrides || 'overrides').replace(/^\/+|\/+$/g, '')}/`;
      return {
        ...base,
        name: String(m.name || path.basename(file, path.extname(file))).slice(0, 60),
        version: m.version || null,
        author: m.author || '',
        mcVersion: m.minecraft.version,
        loader,
        loaderVersion,
        files: m.files.filter((f) => f?.required !== false).length,
        overrides: zip.entries.filter((e) => !e.isDir && e.name.startsWith(prefix)).length,
        cfModule: Boolean(cf),
        needsKey: !available,
      };
    }
    // Prism / MultiMC
    const cfg = parseCfg(await zip.readText(`${kind.prefix}instance.cfg`));
    let comps = [];
    const pj = await zip.readText(`${kind.prefix}mmc-pack.json`);
    if (pj) {
      try {
        comps = JSON.parse(pj).components || [];
      } catch {
        comps = [];
      }
    }
    const l = mmcLoader(comps, cfg);
    if (!l.mc) throw userError('packs.errNoMcVersion');
    if (l.unsupported) base.warnings.push({ code: 'loaderUnsupported', vars: { loader: l.unsupported } });
    const gameEntries = zip.entries.filter((e) => !e.isDir && e.name.startsWith(kind.game) && !SKIP_GAME.test(e.name.slice(kind.game.length)) && safePackRel(e.name.slice(kind.game.length)));
    const managed = cfg.ManagedPack === 'true' && cfg.ManagedPackType === 'modrinth' && MR_ID.test(cfg.ManagedPackID || '') && MR_ID.test(cfg.ManagedPackVersionID || '');
    return {
      ...base,
      name: String(cfg.name || path.basename(file, path.extname(file))).slice(0, 60),
      version: managed ? cfg.ManagedPackVersionName || null : null,
      mcVersion: l.mc,
      loader: l.loader,
      loaderVersion: l.loaderVersion,
      files: gameEntries.length,
      gameBytes: gameEntries.reduce((a, e) => a + e.size, 0),
      worlds: new Set(gameEntries.filter((e) => e.name.slice(kind.game.length).startsWith('saves/')).map((e) => e.name.slice(kind.game.length).split('/')[1])).size,
      modrinth: managed ? { projectId: cfg.ManagedPackID, versionId: cfg.ManagedPackVersionID, title: cfg.ManagedPackName || null, icon: null } : null,
      memory: cfg.OverrideMemory === 'true' ? { min: Number(cfg.MinMemAlloc) || 1024, max: Number(cfg.MaxMemAlloc) || 4096 } : null,
    };
  } finally {
    await zip.close().catch(() => {});
  }
}

async function extractTree(zip, entries, cut, instDir, task, signal, from, to) {
  const total = entries.reduce((a, e) => a + e.size, 0) || 1;
  let done = 0;
  let last = 0;
  let n = 0;
  for (const e of entries) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const rel = safePackRel(e.name.slice(cut));
    const dest = rel ? resolveInside(instDir, rel) : null;
    if (!dest) continue;
    await zip.extract(e, dest, { signal });
    done += e.size;
    n++;
    if (Date.now() - last > 150) {
      last = Date.now();
      task?.update({ detail: t('packs.stepExtract', { done: n, total: entries.length }), progress: from + (to - from) * (done / total) });
    }
  }
  return n;
}

const FOLDER_BY_TYPE = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };

async function importCurseForge(zip, manifest, inst, task, signal, out) {
  const cf = cfModule();
  if (!cf || !(await Promise.resolve(cf.available()).catch(() => false))) throw userError('packs.errCurseForgeKey');
  const classFolder = {};
  for (const [type, id] of Object.entries(cf.CLASS_IDS || {})) if (FOLDER_BY_TYPE[type]) classFolder[id] = FOLDER_BY_TYPE[type];
  const entries = manifest.files.filter((f) => f && Number.isInteger(Number(f.projectID)) && Number.isInteger(Number(f.fileID)) && f.required !== false);
  task?.update({ detail: t('packs.stepResolveCf'), progress: 0.05 });
  const [rawFiles, rawMods] = await Promise.all([cf.getFiles(entries.map((f) => Number(f.fileID))), cf.getMods(entries.map((f) => Number(f.projectID)))]);
  const fileById = new Map((rawFiles || []).map((f) => [f.id, f]));
  const modById = new Map((rawMods || []).map((m) => [m.id, m]));
  const items = [];
  const records = {};
  const webUrl = (rawMod, fileId) => (rawMod?.links?.websiteUrl ? `${String(rawMod.links.websiteUrl).replace(/\/+$/, '')}/files/${fileId}` : `https://www.curseforge.com/projects/${rawMod?.id || ''}`);
  for (const e of entries) {
    const rawMod = modById.get(Number(e.projectID));
    const mod = cf.normalizeMod(rawMod) || { id: Number(e.projectID), title: String(e.projectID) };
    const folder = classFolder[rawMod?.classId] || 'mods';
    const raw = fileById.get(Number(e.fileID));
    if (!raw) {
      out.manual.push({ title: mod.title, file: '', url: webUrl(rawMod, e.fileID) });
      continue;
    }
    const f = cf.normalizeFile(raw);
    const fileName = sanitizeFileName(path.basename(String(f.fileName || '')));
    const rel = safePackRel(`${folder}/${fileName}`);
    const dest = rel ? resolveInside(inst.dir, rel) : null;
    if (!dest) continue;
    let url = f.downloadUrl || null;
    if (!url && typeof cf.getDownloadUrl === 'function') url = await cf.getDownloadUrl(mod.id, f.id).catch(() => null);
    if (!url || !/^https:\/\//i.test(url)) {
      out.manual.push({ title: mod.title, file: fileName, folder, url: webUrl(rawMod, f.id) });
      continue;
    }
    items.push({ url, path: dest, sha1: f.sha1 || undefined, size: f.size || undefined, file: { path: rel } });
    records[mod.id] = { title: mod.title, icon: mod.icon_url || null, type: Object.keys(FOLDER_BY_TYPE).find((k) => FOLDER_BY_TYPE[k] === folder) || 'mod', fileId: f.id, versionNumber: f.displayName, file: fileName, folder, installedAt: Date.now() };
  }
  await runDownloads(items, task, signal, 0.1, 0.6);
  const prefix = `${String(manifest.overrides || 'overrides').replace(/^\/+|\/+$/g, '')}/`;
  const over = zip.entries.filter((e) => !e.isDir && e.name.startsWith(prefix));
  await extractTree(zip, over, prefix.length, inst.dir, task, signal, 0.6, 0.7);
  await instances.update(inst.id, (fresh) => ({
    curseforge: { ...(fresh.curseforge || {}), pack: { projectId: null, fileId: null, name: manifest.name || inst.name, version: manifest.version || null }, projects: records },
  }));
  out.files = items.length;
}

/**
 * Importa un modpack como instancia nueva (tarea). opts: { name }. hooks: { onCreated, onChanged }
 */
async function importPack(file, opts = {}, hooks = {}) {
  const info = await inspect(file);
  if (info.type === 'curseforge' && (!info.cfModule || info.needsKey)) throw userError('packs.errCurseForgeKey');
  const key = path.resolve(file).toLowerCase();
  if (busy.has(key)) throw userError('packs.errBusyImport');
  const name = (typeof opts?.name === 'string' && opts.name.replace(/\s+/g, ' ').trim().slice(0, 60)) || info.name;
  busy.add(key);
  try {
    return await tasks.run(
      t('packs.taskImport', { name }),
      async (task) => {
        const signal = task.signal;
        const out = { manual: [], warnings: [...info.warnings], files: 0 };
        let inst = null;
        let zip = null;
        try {
          const packMeta = info.modrinth ? { projectId: info.modrinth.projectId, versionId: info.modrinth.versionId, name: info.name, version: info.version || info.modrinth.versionNumber || null } : info.type === 'mrpack' ? { projectId: null, versionId: null, name: info.name, version: info.version } : null;
          inst = await instances.create({
            name,
            mcVersion: info.mcVersion,
            loader: info.loader,
            loaderVersion: info.loaderVersion || 'latest',
            icon: info.modrinth?.icon || null,
            pack: packMeta,
          });
          hooks.onCreated?.(inst);
          if (info.type === 'mrpack') {
            const r = await installPack(file, inst.dir, { task, signal, meta: { projectId: info.modrinth?.projectId || null, versionId: info.modrinth?.versionId || null, versionNumber: info.version }, from: 0, to: 0.7 });
            out.warnings.push(...r.warnings);
            out.files = r.files;
          } else {
            zip = await openZip(file);
            const kind = await detect(zip);
            if (info.type === 'curseforge') await importCurseForge(zip, kind.manifest, inst, task, signal, out);
            else {
              const entries = zip.entries.filter((e) => !e.isDir && e.name.startsWith(kind.game) && !SKIP_GAME.test(e.name.slice(kind.game.length)));
              out.files = await extractTree(zip, entries, kind.game.length, inst.dir, task, signal, 0, 0.7);
              if (info.memory) await instances.update(inst.id, { memory: { override: true, min: info.memory.min, max: info.memory.max } });
            }
          }
        } catch (err) {
          if (zip) await zip.close().catch(() => {});
          zip = null;
          if (inst) {
            await rmrf(inst.dir).catch(() => {});
            hooks.onChanged?.();
          }
          throw err;
        } finally {
          if (zip) await zip.close().catch(() => {});
        }
        hooks.onChanged?.();
        // Loader y Minecraft: si falla (sin internet, cancelado) la instancia queda y se prepara al jugar.
        let prepareError = null;
        if (opts.prepare !== false) {
          try {
            await instances.prepare(inst.id, task);
          } catch (err) {
            prepareError = signal.aborted ? t('packs.prepareCancelled') : err?.message || String(err);
          }
        }
        hooks.onChanged?.();
        return { instance: { id: inst.id, name: inst.name }, type: info.type, manual: out.manual, warnings: out.warnings, files: out.files, prepareError, updatable: Boolean(info.modrinth?.projectId) };
      },
      { kind: 'packs:import' },
    );
  } finally {
    busy.delete(key);
  }
}

module.exports = { inspect, importPack, parseCfg, mmcLoader, cfLoader, detect, checkFile };
