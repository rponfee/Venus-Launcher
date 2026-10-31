'use strict';
// Exportar una instancia:
//  - .mrpack (Modrinth): los archivos que estan en Modrinth van al indice (se descargan al importar)
//    y todo lo demas va en overrides/.
//  - .zip con formato de instancia de Prism/MultiMC (instance.cfg + mmc-pack.json + .minecraft/):
//    lo importan Prism, MultiMC y Venus, sin descargas.
const fsp = require('fs/promises');
const path = require('path');
const instances = require('../../core/instances');
const tasks = require('../../core/tasks');
const { t } = require('../../core/i18n');
const lookup = require('./lookup');
const { ZipWriter } = require('./zip');
const { userError, packInfo, allowedUrls, readState } = require('./state');

const GROUPS = {
  mods: { dirs: ['mods'] },
  configs: { dirs: ['config', 'defaultconfigs', 'kubejs', 'scripts'] },
  resourcepacks: { dirs: ['resourcepacks'] },
  shaderpacks: { dirs: ['shaderpacks'] },
  options: { files: ['options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat'] },
};
const GROUP_KEYS = Object.keys(GROUPS);
const INDEXABLE = new Set(['mods', 'resourcepacks', 'shaderpacks']);
const MRPACK_LOADERS = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' };
const ZIP_LOADERS = new Set(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']);
const SKIP_NAMES = new Set(['session.lock', '.ds_store', 'thumbs.db', 'desktop.ini']);

function validSegment(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 255 && s !== '.' && s !== '..' && s.trim() === s && !/[\\/\x00-\x1f<>:"|?*]/.test(s);
}

function clean(v, max) {
  return typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function normalizeOpts(o) {
  const src = o && typeof o === 'object' ? o : {};
  const inc = src.include && typeof src.include === 'object' ? src.include : {};
  return {
    format: src.format === 'zip' ? 'zip' : 'mrpack',
    include: {
      mods: inc.mods !== false,
      configs: inc.configs !== false,
      resourcepacks: inc.resourcepacks !== false,
      shaderpacks: inc.shaderpacks !== false,
      options: inc.options !== false,
      disabled: inc.disabled === true,
    },
    worlds: Array.isArray(src.worlds) ? [...new Set(src.worlds.filter(validSegment))].slice(0, 100) : [],
    name: clean(src.name, 60),
    version: clean(src.version, 40),
    summary: clean(src.summary, 300),
  };
}

async function walk(abs, rel, out, opts) {
  const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (SKIP_NAMES.has(e.name.toLowerCase())) continue;
    const r = `${rel}/${e.name}`;
    const p = path.join(abs, e.name);
    if (e.isDirectory()) {
      if (opts.skipDot && e.name.startsWith('.')) continue;
      await walk(p, r, out, opts);
    } else if (e.isFile()) {
      if (/\.(tmp|part|crdownload)$/i.test(e.name)) continue;
      if (!opts.disabled && /\.disabled$/i.test(e.name)) continue;
      const st = await fsp.stat(p).catch(() => null);
      if (st) out.push({ rel: r, abs: p, size: st.size, group: opts.group });
    }
  }
}

// Archivos a exportar segun lo elegido.
async function collect(inst, o) {
  const out = [];
  for (const key of GROUP_KEYS) {
    if (!o.include[key]) continue;
    const g = GROUPS[key];
    for (const d of g.dirs || []) await walk(path.join(inst.dir, d), d, out, { group: key, skipDot: INDEXABLE.has(d), disabled: o.include.disabled });
    for (const f of g.files || []) {
      const st = await fsp.stat(path.join(inst.dir, f)).catch(() => null);
      if (st?.isFile()) out.push({ rel: f, abs: path.join(inst.dir, f), size: st.size, group: key });
    }
  }
  for (const w of o.worlds) {
    const st = await fsp.stat(path.join(inst.dir, 'saves', w, 'level.dat')).catch(() => null);
    if (st) await walk(path.join(inst.dir, 'saves', w), `saves/${w}`, out, { group: 'worlds', world: w, disabled: true });
  }
  return out;
}

function side(v) {
  return v === 'optional' || v === 'unsupported' ? v : 'required';
}

// Busca en Modrinth (por sha1) los archivos que se pueden poner en el indice del .mrpack.
// knownEnv: sha1 -> env del indice del pack instalado (mas fiel que los datos del proyecto).
async function classify(files, { signal, knownEnv = new Map() } = {}) {
  const candidates = files.filter((f) => INDEXABLE.has(f.rel.split('/')[0]) && /\.(jar|zip)$/i.test(f.rel) && f.rel.split('/').length === 2);
  for (const f of candidates) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    f.sha1 = await lookup.localSha1(f.abs);
  }
  let offline = false;
  let vmap = {};
  let projects = new Map();
  try {
    vmap = await lookup.versionsByHash(candidates.map((f) => f.sha1).filter(Boolean), { signal });
    projects = await lookup.projectsByIds(Object.values(vmap).filter(Boolean).map((v) => v.project_id));
  } catch (err) {
    if (signal?.aborted) throw err;
    offline = true;
  }
  for (const f of candidates) {
    const v = f.sha1 ? vmap[f.sha1] : null;
    const file = v?.files?.find((x) => x.hashes?.sha1 === f.sha1);
    if (!file || !allowedUrls([file.url]).length || !file.hashes?.sha512) continue;
    const p = projects.get(v.project_id);
    const known = knownEnv.get(f.sha1);
    // El archivo esta en una instancia de cliente: nunca puede quedar como "no soportado en el cliente"
    // (algunos proyectos tienen mal cargado ese dato).
    const client = side(known?.client || p?.client_side);
    f.index = {
      path: f.rel,
      hashes: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 },
      env: { client: client === 'unsupported' ? 'required' : client, server: side(known?.server || p?.server_side) },
      downloads: [file.url],
      fileSize: file.size,
    };
    f.title = p?.title || null;
  }
  return { offline };
}

// Version del loader concreta (el .mrpack no acepta "latest").
async function loaderVersionFor(inst) {
  let v = inst.loaderVersion && inst.loaderVersion !== 'latest' ? String(inst.loaderVersion) : null;
  if (!v && inst.versionId) {
    const m = /^(?:fabric|quilt)-loader-(.+)-[^-]+$/.exec(inst.versionId) || /neoforge-(.+)$/.exec(inst.versionId) || /-forge-?(.+)$/.exec(inst.versionId);
    if (m) v = m[1];
  }
  if (!v) {
    try {
      const mod = ['fabric', 'quilt'].includes(inst.loader) ? require('../../core/loaders/fabric') : require('../../core/loaders/forge');
      const list = await mod.getLoaderVersions(inst.loader, inst.mcVersion);
      const pick = list.find((l) => l.recommended) || list.find((l) => l.stable) || list[0];
      v = pick?.version || null;
    } catch {
      v = null;
    }
  }
  if (!v) throw userError('packs.errLoaderVersion');
  if ((inst.loader === 'forge' || inst.loader === 'neoforge') && v.startsWith(`${inst.mcVersion}-`)) v = v.slice(inst.mcVersion.length + 1);
  if (inst.loader === 'forge') v = v.replace(new RegExp(`-${inst.mcVersion.replace(/\./g, '\\.')}$`), '');
  return v;
}

function mmcPack(inst, lv) {
  const comps = [{ uid: 'net.minecraft', version: inst.mcVersion, important: true }];
  if (inst.loader === 'fabric') comps.push({ uid: 'net.fabricmc.intermediary', version: inst.mcVersion }, { uid: 'net.fabricmc.fabric-loader', version: lv });
  else if (inst.loader === 'quilt') comps.push({ uid: 'net.fabricmc.intermediary', version: inst.mcVersion }, { uid: 'org.quiltmc.quilt-loader', version: lv });
  else if (inst.loader === 'forge') comps.push({ uid: 'net.minecraftforge', version: lv });
  else if (inst.loader === 'neoforge') comps.push({ uid: 'net.neoforged', version: lv });
  return { components: comps, formatVersion: 1 };
}

function cfgValue(v) {
  const s = String(v ?? '').replace(/[\r\n]+/g, ' ');
  return /[,;"=\\]|^\s|\s$/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s;
}

function instanceCfg(inst, o) {
  const lines = ['InstanceType=OneSix', `name=${cfgValue(o.name || inst.name)}`, 'iconKey=default'];
  if (inst.memory?.override) lines.push('OverrideMemory=true', `MinMemAlloc=${Number(inst.memory.min) || 1024}`, `MaxMemAlloc=${Number(inst.memory.max) || 4096}`);
  const pack = packInfo(inst);
  if (pack?.projectId && pack?.versionId) {
    lines.push('ManagedPack=true', 'ManagedPackType=modrinth', `ManagedPackID=${pack.projectId}`, `ManagedPackVersionID=${pack.versionId}`, `ManagedPackName=${cfgValue(pack.name || inst.name)}`, `ManagedPackVersionName=${cfgValue(pack.version || '')}`);
  }
  return `${lines.join('\n')}\n`;
}

// env (cliente/servidor) de cada archivo segun el indice del pack instalado, por sha1.
async function knownEnvFor(inst) {
  const map = new Map();
  const st = await readState(inst.dir).catch(() => null);
  for (const f of Array.isArray(st?.index?.files) ? st.index.files : []) {
    const h = f?.hashes?.sha1;
    if (typeof h === 'string' && f.env && typeof f.env === 'object') map.set(h.toLowerCase(), f.env);
  }
  return map;
}

function defaultsFor(inst) {
  const pack = packInfo(inst);
  return { name: inst.name, version: pack?.version && !pack.projectId ? pack.version : '1.0.0' };
}

/**
 * Resumen de lo que se exportaria (tamanios por grupo y, para .mrpack, cuanto se descarga de Modrinth).
 */
async function preview(instanceId, opts) {
  const inst = await instances.get(instanceId);
  const o = normalizeOpts(opts);
  const files = await collect(inst, o);
  const groups = {};
  for (const key of [...GROUP_KEYS, 'worlds']) groups[key] = { files: 0, bytes: 0 };
  for (const f of files) {
    groups[f.group].files++;
    groups[f.group].bytes += f.size;
  }
  const warnings = [];
  let mrpack = null;
  if (o.format === 'mrpack') {
    const { offline } = await classify(files, { knownEnv: await knownEnvFor(inst) });
    const indexed = files.filter((f) => f.index);
    const over = files.filter((f) => !f.index);
    mrpack = {
      indexed: indexed.length,
      indexedBytes: indexed.reduce((a, f) => a + f.size, 0),
      overrides: over.length,
      overridesBytes: over.reduce((a, f) => a + f.size, 0),
      offline,
      // Jars que no estan en Modrinth: van adentro del pack (revisar licencias antes de compartirlo)
      foreignMods: over.filter((f) => f.rel.startsWith('mods/') && /\.jar$/i.test(f.rel)).map((f) => f.rel.slice(5)).slice(0, 30),
    };
    if (!MRPACK_LOADERS[inst.loader] && inst.loader !== 'vanilla') warnings.push({ code: 'loaderMrpack', vars: { loader: instances.LOADER_NAMES[inst.loader] || inst.loader } });
    if (offline) warnings.push({ code: 'offline', vars: {} });
  } else if (!ZIP_LOADERS.has(inst.loader)) warnings.push({ code: 'loaderZip', vars: { loader: instances.LOADER_NAMES[inst.loader] || inst.loader } });
  return {
    format: o.format,
    groups,
    total: { files: files.length, bytes: files.reduce((a, f) => a + f.size, 0) },
    mrpack,
    warnings,
    defaults: defaultsFor(inst),
    instance: { id: inst.id, name: inst.name, mcVersion: inst.mcVersion, loader: inst.loader, preset: inst.preset || null },
  };
}

/**
 * Exporta la instancia al archivo dest (como tarea). Devuelve { file, size, files, indexed, overrides }.
 */
async function exportPack(instanceId, opts, dest) {
  const inst = await instances.get(instanceId);
  const o = normalizeOpts(opts);
  const defaults = defaultsFor(inst);
  const name = o.name || defaults.name;
  const version = o.version || defaults.version;
  return tasks.run(
    t('packs.taskExport', { name: inst.name }),
    async (task) => {
      const signal = task.signal;
      task.update({ detail: t('packs.stepCollect'), progress: null });
      const files = await collect(inst, o);
      if (!files.length) throw userError('packs.errNothingToExport');
      const tmp = `${dest}.${process.pid}.venus-tmp`;
      const w = new ZipWriter(tmp);
      let indexed = 0;
      let overrides = 0;
      try {
        let toWrite = files;
        let prefix = '.minecraft/';
        if (o.format === 'mrpack') {
          task.update({ detail: t('packs.stepIdentify'), progress: null });
          await classify(files, { signal, knownEnv: await knownEnvFor(inst) });
          const deps = { minecraft: inst.mcVersion };
          if (MRPACK_LOADERS[inst.loader]) deps[MRPACK_LOADERS[inst.loader]] = await loaderVersionFor(inst);
          const index = { formatVersion: 1, game: 'minecraft', versionId: version, name, ...(o.summary ? { summary: o.summary } : {}), files: files.filter((f) => f.index).map((f) => f.index), dependencies: deps };
          await w.addBuffer('modrinth.index.json', JSON.stringify(index, null, 2));
          indexed = index.files.length;
          toWrite = files.filter((f) => !f.index);
          prefix = 'overrides/';
        } else {
          const lv = ['fabric', 'quilt', 'forge', 'neoforge'].includes(inst.loader) ? await loaderVersionFor(inst) : null;
          await w.addBuffer('instance.cfg', instanceCfg(inst, { ...o, name }));
          await w.addBuffer('mmc-pack.json', JSON.stringify(mmcPack(inst, lv), null, 2));
        }
        const total = toWrite.reduce((a, f) => a + f.size, 0);
        let done = 0;
        let last = 0;
        for (const f of toWrite) {
          if (signal.aborted) throw signal.reason || new Error('aborted');
          try {
            await w.addFile(`${prefix}${f.rel}`, f.abs, { signal });
          } catch (err) {
            if (err.code === 'ENOENT') continue;
            if (err.code === 'TOO_LARGE') throw userError('packs.errFileTooLarge', { file: f.rel });
            throw err;
          }
          overrides++;
          done += f.size;
          if (Date.now() - last > 150) {
            last = Date.now();
            task.update({ detail: t('packs.stepPacking', { done: overrides, total: toWrite.length }), progress: total ? done / total : null });
          }
        }
        const r = await w.finish();
        await fsp.rm(dest, { force: true }).catch(() => {});
        await fsp.rename(tmp, dest);
        return { file: dest, size: r.size, files: r.entries, indexed, overrides, format: o.format };
      } catch (err) {
        await w.abort();
        if (err.code === 'ENOSPC') throw userError('packs.errNoSpace');
        throw err;
      }
    },
    { instanceId: inst.id, kind: 'packs:export' },
  );
}

module.exports = { preview, exportPack, normalizeOpts, collect, classify, loaderVersionFor, mmcPack, instanceCfg, defaultsFor };
