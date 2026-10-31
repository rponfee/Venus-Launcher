'use strict';
// "Servidor espejo con un clic": crea un servidor con el mismo loader y version que una instancia,
// copia los mods que funcionan en servidor (excluye los de solo cliente segun Modrinth o los metadatos
// del jar), la configuracion y, si se pide, un mundo.
const fsp = require('fs/promises');
const path = require('path');
const servers = require('../../core/servers');
const instances = require('../../core/instances');
const modrinth = require('../../core/modrinth');
const { t } = require('../../core/i18n');
const { exists } = require('../../core/util');
const safety = require('../packs/safety');

const LOADER_TYPES = { fabric: 'fabric', quilt: 'quilt', forge: 'forge', neoforge: 'neoforge' };
const VANILLA_LIKE = new Set(['vanilla', 'optifine']);
const VANILLA_CHOICES = new Set(['paper', 'vanilla', 'purpur']);
// Carpetas de configuracion y scripts que tambien usa el servidor (modpacks).
const EXTRA_FOLDERS = ['config', 'defaultconfigs', 'kubejs', 'scripts'];

function typeFor(inst, wanted) {
  if (LOADER_TYPES[inst.loader]) return LOADER_TYPES[inst.loader];
  if (VANILLA_LIKE.has(inst.loader)) return VANILLA_CHOICES.has(wanted) ? wanted : 'paper';
  throw new Error(t('servers.errMirrorLoader', { loader: inst.loader }));
}

// Lado (cliente/servidor) segun los metadatos del jar cuando Modrinth no lo conoce.
function localSide(jarPath) {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(jarPath);
    const fabric = zip.getEntry('fabric.mod.json');
    if (fabric) {
      const env = JSON.parse(zip.readAsText(fabric).replace(/^﻿/, '')).environment;
      if (env === 'client') return 'client';
      if (env === 'server') return 'server';
      return env === '*' ? 'both' : null;
    }
    const quilt = zip.getEntry('quilt.mod.json');
    if (quilt) {
      const env = JSON.parse(zip.readAsText(quilt).replace(/^﻿/, ''))?.quilt_loader?.minecraft?.environment;
      if (env === 'client') return 'client';
      if (env === 'dedicated_server') return 'server';
      return env === '*' ? 'both' : null;
    }
    for (const name of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
      const e = zip.getEntry(name);
      if (!e) continue;
      const toml = zip.readAsText(e);
      if (/^\s*clientSideOnly\s*=\s*true/m.test(toml)) return 'client';
      return null;
    }
  } catch {
    /* jar ilegible */
  }
  return null;
}

// Analiza la instancia: que tipo de servidor corresponde, que mods se copian y cuales no.
async function analyze(instanceId, opts = {}) {
  if (typeof instanceId !== 'string' || !/^[\w.-]+$/.test(instanceId) || /^\.+$/.test(instanceId)) throw new Error(t('servers.errMirrorLoader', { loader: '?' }));
  const inst = await instances.get(instanceId);
  const type = typeFor(inst, opts.type);
  const files = (await modrinth.listFolder(inst.dir, 'mods')).filter((f) => f.enabled && !f.isDir && /\.jar$/i.test(f.file));
  let ids = {};
  let projects = [];
  if (files.length && LOADER_TYPES[inst.loader]) {
    try {
      ids = await modrinth.identify(inst.dir, files);
      const pids = [...new Set(Object.values(ids).map((i) => i.projectId))];
      projects = pids.length ? await modrinth.getProjects(pids) : [];
    } catch (err) {
      console.warn('[serverx] espejo: Modrinth no disponible', err?.message || err);
    }
  }
  const byId = new Map(projects.map((p) => [p.id, p]));
  const mods = [];
  for (const f of LOADER_TYPES[inst.loader] ? files : []) {
    const id = ids[f.file];
    const p = id ? byId.get(id.projectId) : null;
    let side = null;
    let source = 'unknown';
    if (p) {
      source = 'modrinth';
      side = p.server_side === 'unsupported' ? 'client' : p.client_side === 'unsupported' ? 'server' : 'both';
    } else {
      side = localSide(path.join(inst.dir, 'mods', f.file));
      if (side) source = 'metadata';
    }
    mods.push({ file: f.file, title: id?.title || p?.title || f.file.replace(/\.jar$/i, ''), icon: id?.icon || p?.icon_url || null, size: f.size, side: side || 'unknown', source, include: side !== 'client' });
  }
  const extras = [];
  for (const folder of EXTRA_FOLDERS) if (await exists(path.join(inst.dir, folder))) extras.push(folder);
  let worlds = [];
  try {
    worlds = (await instances.content(instanceId, 'saves')).map((w) => ({ name: w.name, lastPlayed: w.lastPlayed }));
  } catch {
    worlds = [];
  }
  return {
    instance: { id: inst.id, name: inst.name, mcVersion: inst.mcVersion, loader: inst.loader, loaderVersion: inst.loaderVersion },
    type,
    vanillaChoice: VANILLA_LIKE.has(inst.loader),
    mods,
    extras,
    worlds,
  };
}

/**
 * opts: { name, type (instancias vanilla: paper | vanilla | purpur), port, memory, onlineMode, eula, op, motd,
 *         world (carpeta de saves o null), include: [archivos de mods] (si se omite, se usa el analisis),
 *         extras: [carpetas] (si se omite, todas) }
 */
async function create(instanceId, opts = {}, task) {
  task?.update({ detail: t('servers.detailMirrorAnalyze'), progress: null });
  const plan = await analyze(instanceId, opts);
  const inst = await instances.get(instanceId);
  const include = Array.isArray(opts.include) ? new Set(opts.include) : new Set(plan.mods.filter((m) => m.include).map((m) => m.file));
  const extras = Array.isArray(opts.extras) ? plan.extras.filter((e) => opts.extras.includes(e)) : plan.extras;
  const s = await servers.create({
    ...opts,
    name: opts.name || t('servers.mirrorName', { name: inst.name }),
    type: plan.type,
    mcVersion: inst.mcVersion,
    loaderVersion: LOADER_TYPES[inst.loader] ? inst.loaderVersion || 'latest' : 'latest',
    mirror: { instanceId: inst.id, instanceName: inst.name },
  });
  const sdir = servers.dir(s.id);
  const copied = [];
  const excluded = [];
  const mods = plan.mods.filter((m) => include.has(m.file));
  if (mods.length) await fsp.mkdir(path.join(sdir, 'mods'), { recursive: true });
  let i = 0;
  for (const m of plan.mods) {
    if (!include.has(m.file)) {
      excluded.push(m.title);
      continue;
    }
    task?.update({ detail: t('servers.detailMirrorCopy', { name: m.title }), progress: mods.length ? i / mods.length : null });
    // Copia por temporal + renombrado: si ya hubiera un archivo con ese nombre (por ejemplo un enlace duro
    // del almacen), se reemplaza en vez de escribirle encima.
    await safety.copyFileAtomic(path.join(inst.dir, 'mods', m.file), path.join(sdir, 'mods', m.file));
    copied.push(m.title);
    i++;
  }
  for (const folder of extras) {
    task?.update({ detail: t('servers.detailMirrorCopy', { name: folder }), progress: null });
    await fsp.cp(path.join(inst.dir, folder), path.join(sdir, folder), { recursive: true });
  }
  let world = null;
  if (opts.world) {
    const folder = String(opts.world);
    if (/[\\/]|^\.\.?$/.test(folder)) throw new Error(t('servers.errWorldName'));
    const src = path.join(inst.dir, 'saves', folder);
    if (!(await exists(path.join(src, 'level.dat')))) throw new Error(t('servers.errNoWorld'));
    task?.update({ detail: t('servers.detailMirrorWorld', { name: folder }), progress: null });
    await fsp.cp(src, path.join(sdir, 'world'), { recursive: true, filter: (p) => !/[\\/]session\.lock$/i.test(p) });
    world = folder;
  }
  return servers.patchMeta(s.id, {
    mirror: { instanceId: inst.id, instanceName: inst.name, copied: copied.length, excluded, extras, world, created: Date.now() },
  });
}

module.exports = { analyze, create, localSide, typeFor };
