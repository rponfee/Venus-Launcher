'use strict';
// Recomendaciones de rendimiento para una version + loader (o una instancia concreta):
// memoria, recolector de Java, mods de optimizacion verificados en Modrinth y opciones de video.
const fsp = require('fs/promises');
const path = require('path');
const instances = require('../../core/instances');
const settings = require('../../core/settings');
const { t } = require('../../core/i18n');
const system = require('./system');
const memory = require('./memory');
const options = require('./options');
const availability = require('./availability');
const mcver = require('./mcver');

const MB = 1048576;

// Mods de rendimiento por loader. Cada grupo instala el primer candidato disponible.
function perfGroups({ loader, mcVersion, lowEnd }) {
  const g = (key, ...candidates) => ({ key, candidates, type: 'mod' });
  let list = [];
  if (loader === 'fabric' || loader === 'quilt') {
    list = [g('sodium', 'sodium'), g('lithium', 'lithium'), g('ferrite-core', 'ferrite-core'), g('modernfix', 'modernfix'), g('immediatelyfast', 'immediatelyfast'), g('entityculling', 'entityculling'), g('dynamic-fps', 'dynamic-fps'), g('moreculling', 'moreculling')];
  } else if (loader === 'neoforge') {
    const renderer = mcver.atLeast(mcVersion, '1.21') ? g('renderer', 'sodium', 'embeddium') : g('renderer', 'embeddium');
    list = [renderer, g('ferrite-core', 'ferrite-core'), g('modernfix', 'modernfix'), g('immediatelyfast', 'immediatelyfast'), g('entityculling', 'entityculling'), g('dynamic-fps', 'dynamic-fps')];
  } else if (loader === 'forge') {
    list = [g('renderer', 'embeddium'), g('ferrite-core', 'ferrite-core'), g('modernfix', 'modernfix'), g('immediatelyfast', 'immediatelyfast'), g('entityculling', 'entityculling'), g('dynamic-fps', 'dynamic-fps')];
  }
  if (lowEnd && list.length) {
    list.push(g('badoptimizations', 'badoptimizations'));
    if (!mcver.atLeast(mcVersion, '1.20.5')) list.push(g('memoryleakfix', 'memoryleakfix'));
  }
  return list;
}

// Reconoce por nombre de archivo los mods mas comunes (los de un modpack no figuran como proyectos).
const FILE_PATTERNS = {
  sodium: /^sodium-(fabric-|neoforge-)?(mc)?\d/i,
  embeddium: /^(embeddium|rubidium)-/i,
  lithium: /^lithium-/i,
  'ferrite-core': /^ferritecore-/i,
  modernfix: /^modernfix-/i,
  immediatelyfast: /^immediatelyfast-/i,
  entityculling: /^entityculling-/i,
  'dynamic-fps': /^dynamic-?fps-/i,
  moreculling: /^moreculling-/i,
  badoptimizations: /^badoptimizations-/i,
  memoryleakfix: /^memoryleakfix-/i,
  iris: /^iris-/i,
  oculus: /^oculus-/i,
};
const RENDERERS = ['sodium', 'embeddium', 'iris', 'oculus'];

async function modFiles(inst) {
  try {
    return (await fsp.readdir(path.join(inst.dir, 'mods'))).filter((f) => /\.(jar|zip)(\.disabled)?$/i.test(f));
  } catch {
    return [];
  }
}

// Que hay instalado en la instancia: ids de proyecto + slugs reconocidos por archivo.
async function installedInfo(inst) {
  const files = inst ? await modFiles(inst) : [];
  const enabled = files.filter((f) => !/\.disabled$/i.test(f));
  const ids = new Set(Object.keys(inst?.modrinth?.projects || {}));
  const slugs = new Set();
  for (const [slug, re] of Object.entries(FILE_PATTERNS)) if (enabled.some((f) => re.test(f))) slugs.add(slug);
  const optifine = inst?.loader === 'optifine' || enabled.some((f) => /optifine|optifabric/i.test(f));
  return { ids, slugs, optifine, hasRenderer: RENDERERS.some((s) => slugs.has(s)) };
}

function isInstalled(item, info) {
  if (!info) return false;
  if (item.projectId && info.ids.has(item.projectId)) return true;
  if (info.slugs.has(item.slug)) return true;
  if (item.key === 'renderer' && (info.slugs.has('sodium') || info.slugs.has('embeddium'))) return true;
  if (item.slug === 'sodium' && (info.slugs.has('iris') || info.slugs.has('embeddium'))) return true;
  return false;
}

function fmtGb(mb) {
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

function pickPreset({ tier, javaMajor, max, threads, lowEnd }) {
  if (!lowEnd && javaMajor >= 21 && javaMajor < 25 && max >= 8192 && threads >= 8 && (tier === 'high' || tier === 'ultra')) return 'zgc';
  return 'auto';
}

// opts: { mcVersion, loader, preset?, instanceId?, lowEnd? }
async function build(opts = {}) {
  let { mcVersion, loader, preset } = opts;
  const lowEnd = Boolean(opts.lowEnd);
  let inst = null;
  if (opts.instanceId) {
    inst = await instances.get(opts.instanceId);
    mcVersion = inst.mcVersion;
    loader = inst.loader;
    preset = inst.preset;
  }
  if (!mcVersion) throw new Error(t('perf.errNoVersion'));
  loader = loader || 'vanilla';
  const [sys, s] = await Promise.all([system.get(), settings.get()]);
  const totalMb = sys.totalMem / MB;
  const info = inst ? await installedInfo(inst) : null;
  const notes = [];

  // ---------- Mods ----------
  const supportsMods = ['fabric', 'quilt', 'forge', 'neoforge'].includes(loader);
  let mods = [];
  let modsError = null;
  if (supportsMods) {
    try {
      const groups = perfGroups({ loader, mcVersion, lowEnd });
      const loaders = availability.loadersFor({ mcVersion, loader, preset });
      const resolved = await availability.resolveGroups(groups, { mcVersion, loaders });
      for (const it of resolved) {
        if (!it.available) continue;
        // OptiFine no se lleva con Sodium/Embeddium ni con More Culling
        if (info?.optifine && (it.key === 'sodium' || it.key === 'renderer' || it.key === 'moreculling')) continue;
        mods.push({
          projectId: it.projectId,
          slug: it.slug,
          title: it.title,
          icon: it.icon,
          versionId: it.versionId,
          reason: t(`perf.mod_${it.slug}`),
          installed: isInstalled(it, info),
        });
      }
      if (info?.optifine) notes.push(t('perf.noteOptifine'));
    } catch (err) {
      modsError = t('perf.errModrinth', { error: err.message });
    }
  } else {
    notes.push(t(loader === 'optifine' ? 'perf.noteOptifineLoader' : 'perf.noteVanilla'));
  }
  const toAdd = mods.filter((m) => !m.installed);
  const fastRenderer = Boolean(info?.hasRenderer) || mods.some((m) => ['sodium', 'embeddium'].includes(m.slug));

  // ---------- Memoria ----------
  const content = inst ? await memory.inspect(inst) : { modCount: mods.length, isModpack: false, shaders: false };
  const mem = memory.compute({ totalMb, lowEnd, mcVersion, ...content, modCount: content.modCount + (inst ? toAdd.length : 0) });
  let currentMemory = null;
  if (inst) {
    if (inst.memory?.override) currentMemory = { mode: 'custom', min: inst.memory.min, max: inst.memory.max };
    else if (s.memoryMode === 'manual') currentMemory = { mode: 'global', min: s.memory?.min, max: s.memory?.max };
    else {
      const auto = memory.compute({ totalMb, mcVersion, ...content });
      currentMemory = { mode: 'auto', min: auto.min, max: auto.max };
    }
  }
  if (mem.limited && !lowEnd) notes.push(t('perf.noteLimited', { need: fmtGb(mem.need), max: fmtGb(mem.max) }));

  // ---------- Java ----------
  const javaMajor = mcver.javaMajorFor(mcVersion);
  const jvmPreset = pickPreset({ tier: sys.tier, javaMajor, max: mem.max, threads: sys.threads, lowEnd });
  const currentJvmPreset = inst?.java?.preset || s.jvmPreset || 'auto';

  // ---------- Opciones de video ----------
  const recOptions = options.recommend({ tiers: sys.tiers, tier: sys.tier, lowEnd, fastRenderer, mcVersion });
  const current = inst ? await options.read(inst.dir) : { exists: false, values: {} };

  // ---------- Motivo ----------
  const tierName = t(`perf.tier_${sys.tier}`);
  let reason;
  if (lowEnd) reason = t('perf.reasonLowEnd', { mem: fmtGb(mem.max) });
  else if (!supportsMods) reason = t('perf.reasonNoMods', { tier: tierName, mem: fmtGb(mem.max) });
  else if (modsError) reason = t('perf.reasonOffline', { tier: tierName, mem: fmtGb(mem.max) });
  else if (!toAdd.length) reason = t('perf.reasonAllInstalled', { tier: tierName, mem: fmtGb(mem.max) });
  else reason = t('perf.reasonMods', { tier: tierName, mem: fmtGb(mem.max), count: toAdd.length });

  return {
    instanceId: inst?.id || null,
    mcVersion,
    loader,
    tier: sys.tier,
    tiers: sys.tiers,
    lowEnd,
    system: { totalMem: sys.totalMem, cpuModel: sys.cpuModel, gpu: sys.gpu, gpuTier: sys.gpuTier, threads: sys.threads, cores: sys.cores, cpuScore: sys.cpuScore },
    memory: { min: mem.min, max: mem.max },
    memoryNeed: mem.need,
    currentMemory,
    jvmPreset,
    currentJvmPreset,
    javaMajor,
    reason,
    notes,
    mods,
    modsError,
    loaderSupported: supportsMods,
    suggestLoader: supportsMods ? null : 'fabric',
    options: recOptions,
    currentOptions: current.values,
    optionsFileExists: current.exists,
  };
}

module.exports = { build, perfGroups, installedInfo, isInstalled, fmtGb };
