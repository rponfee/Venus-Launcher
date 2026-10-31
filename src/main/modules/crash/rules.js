'use strict';
// Base de reglas de crashes: cada regla mira el contexto ya leido (crash report, log, hs_err, mods
// instalados) y devuelve hallazgos con una explicacion (clave de texto + variables) y acciones
// ejecutables. Los textos estan en src/main/i18n/<idioma>/crash.js (r_<id>_title / r_<id>_text).
const { compareSemver } = require('../../core/util');

// ---------- Datos de apoyo ----------

// id de mod -> slug de Modrinth (cuando no coinciden o para no adivinar)
const SLUGS = {
  'fabric-api': 'fabric-api', fabric: 'fabric-api', fabric_api: 'fabric-api', architectury: 'architectury-api',
  'architectury-api': 'architectury-api', 'cloth-config': 'cloth-config', 'cloth-config2': 'cloth-config',
  cloth_config: 'cloth-config', geckolib: 'geckolib', geckolib3: 'geckolib', owo: 'owo-lib', 'owo-lib': 'owo-lib',
  yet_another_config_lib_v3: 'yacl', yacl: 'yacl', forgeconfigapiport: 'forge-config-api-port', puzzleslib: 'puzzles-lib',
  'fabric-language-kotlin': 'fabric-language-kotlin', kotlinforforge: 'kotlin-for-forge', kotlinlangforge: 'kotlin-for-forge',
  balm: 'balm', iceberg: 'iceberg', resourcefullib: 'resourceful-lib', terrablender: 'terrablender', citadel: 'citadel',
  bookshelf: 'bookshelf-lib', collective: 'collective', moonlight: 'moonlight', playeranimator: 'playeranimator',
  'player-animator': 'playeranimator', trinkets: 'trinkets', curios: 'curios', 'cardinal-components': 'cardinal-components-api',
  'cardinal-components-base': 'cardinal-components-api', lithostitched: 'lithostitched', framework: 'framework',
  creativecore: 'creativecore', prism: 'prism-lib', libipn: 'libipn', azurelib: 'azurelib', blueprint: 'blueprint',
  midnightlib: 'midnightlib', patchouli: 'patchouli', jei: 'jei', emi: 'emi', roughlyenoughitems: 'rei', rei: 'rei',
  modmenu: 'modmenu', sodium: 'sodium', iris: 'iris', indium: 'indium', lithium: 'lithium', ferritecore: 'ferrite-core',
  yungsapi: 'yungs-api', jade: 'jade', cupboard: 'cupboard', zeta: 'zeta', autoreglib: 'autoreglib', placebo: 'placebo',
  fzzy_config: 'fzzy-config', supermartijn642corelib: 'supermartijn642s-core-lib', supermartijn642configlib: 'supermartijn642s-config-lib',
  resourcefulconfig: 'resourceful-config', flywheel: 'flywheel', create: 'create', kubejs: 'kubejs', rhino: 'rhino',
  connectormod: 'connector', 'forgified-fabric-api': 'forgified-fabric-api', embeddium: 'embeddium', oculus: 'oculus',
  rubidium: 'rubidium', entityculling: 'entityculling', immediatelyfast: 'immediatelyfast', continuity: 'continuity',
};

// Paquetes de librerias conocidas (para "NoClassDefFoundError": que falta instalar)
const LIB_PACKAGES = [
  ['me.shedaniel.clothconfig2', 'cloth-config', 'Cloth Config API'],
  ['me.shedaniel.autoconfig', 'cloth-config', 'Cloth Config API'],
  ['me.shedaniel.cloth', 'cloth-config', 'Cloth Config API'],
  ['dev.architectury', 'architectury', 'Architectury API'],
  ['me.shedaniel.architectury', 'architectury', 'Architectury API'],
  ['software.bernie.geckolib', 'geckolib', 'GeckoLib'],
  ['net.fabricmc.fabric', 'fabric-api', 'Fabric API'],
  ['com.terraformersmc.modmenu', 'modmenu', 'Mod Menu'],
  ['top.theillusivec4.curios', 'curios', 'Curios API'],
  ['dev.emi.trinkets', 'trinkets', 'Trinkets'],
  ['mezz.jei', 'jei', 'Just Enough Items'],
  ['dev.emi.emi', 'emi', 'EMI'],
  ['me.shedaniel.rei', 'rei', 'Roughly Enough Items'],
  ['com.teamresourceful.resourcefullib', 'resourcefullib', 'Resourceful Lib'],
  ['com.teamresourceful.resourcefulconfig', 'resourcefulconfig', 'Resourceful Config'],
  ['net.blay09.mods.balm', 'balm', 'Balm'],
  ['fuzs.puzzleslib', 'puzzleslib', 'Puzzles Lib'],
  ['fuzs.forgeconfigapiport', 'forgeconfigapiport', 'Forge Config API Port'],
  ['dev.isxander.yacl3', 'yacl', 'YetAnotherConfigLib'],
  ['dev.isxander.yacl', 'yacl', 'YetAnotherConfigLib'],
  ['io.wispforest.owo', 'owo', 'oωo (owo-lib)'],
  ['team.creative.creativecore', 'creativecore', 'CreativeCore'],
  ['com.mrcrayfish.framework', 'framework', 'Framework'],
  ['net.darkhax.bookshelf', 'bookshelf', 'Bookshelf'],
  ['com.github.alexthe666.citadel', 'citadel', 'Citadel'],
  ['mod.azure.azurelib', 'azurelib', 'AzureLib'],
  ['com.jozufozu.flywheel', 'flywheel', 'Flywheel'],
  ['dev.engine_room.flywheel', 'flywheel', 'Flywheel'],
  ['thedarkcolour.kotlinforforge', 'kotlinforforge', 'Kotlin for Forge'],
  ['net.fabricmc.language.kotlin', 'fabric-language-kotlin', 'Fabric Language Kotlin'],
  ['dev.onyxstudios.cca', 'cardinal-components', 'Cardinal Components API'],
  ['org.ladysnake.cca', 'cardinal-components', 'Cardinal Components API'],
  ['eu.midnightdust.lib', 'midnightlib', 'MidnightLib'],
  ['vazkii.patchouli', 'patchouli', 'Patchouli'],
  ['snownee.jade', 'jade', 'Jade'],
  ['dev.latvian.mods.kubejs', 'kubejs', 'KubeJS'],
  ['dev.latvian.mods.rhino', 'rhino', 'Rhino'],
  ['com.natamus.collective', 'collective', 'Collective'],
  ['net.mehvahdjukaar.moonlight', 'moonlight', 'Moonlight Lib'],
  ['com.yungnickyoung.minecraft.yungsapi', 'yungsapi', "YUNG's API"],
  ['dev.kosmx.playeranim', 'playeranimator', 'playerAnimator'],
  ['com.teamabnormals.blueprint', 'blueprint', 'Blueprint'],
  ['org.violetmoon.zeta', 'zeta', 'Zeta'],
  ['vazkii.autoreg', 'autoreglib', 'AutoRegLib'],
  ['dev.shadowsoffire.placebo', 'placebo', 'Placebo'],
  ['shadows.placebo', 'placebo', 'Placebo'],
  ['terrablender', 'terrablender', 'TerraBlender'],
  ['com.simibubi.create', 'create', 'Create'],
  ['net.irisshaders.iris', 'iris', 'Iris'],
  ['net.coderbot.iris', 'iris', 'Iris'],
  ['me.jellysquid.mods.sodium', 'sodium', 'Sodium'],
  ['net.caffeinemc.mods.sodium', 'sodium', 'Sodium'],
  ['org.anti_ad.mc.common', 'libipn', 'libIPN'],
  ['me.fallenbreath.conditionalmixin', 'conditional-mixin', 'Conditional Mixin'],
  ['com.bawnorton.mixinsquared', 'mixinsquared', 'MixinSquared'],
];

// Mods que reemplazan el motor de renderizado y no pueden convivir entre si
const RENDERERS = ['sodium', 'embeddium', 'rubidium', 'magnesium', 'canvas', 'xenon', 'vulkanmod', 'nvidium-standalone'];
// Mods que no conviven con OptiFine
const OPTIFINE_HATERS = ['sodium', 'iris', 'embeddium', 'rubidium', 'oculus', 'canvas', 'indium', 'magnesium', 'vulkanmod', 'xenon', 'nvidium'];

const DRIVER_URLS = {
  nvidia: 'https://www.nvidia.com/Download/index.aspx',
  amd: 'https://www.amd.com/en/support/download/drivers.html',
  intel: 'https://www.intel.com/content/www/us/en/support/detect.html',
};
const VENDOR_NAMES = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' };

const LOADER_NAMES = {
  fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', legacyforge: 'Forge', legacyfabric: 'Legacy Fabric',
  vanilla: 'Vanilla', optifine: 'OptiFine', fabricloader: 'Fabric Loader', quilt_loader: 'Quilt Loader',
};

const EXIT_CODES = {
  '-1073741819': 'accessViolation',
  3221225477: 'accessViolation',
  '-1073740791': 'stackBuffer',
  3221226505: 'stackBuffer',
  '-1073741571': 'stackOverflow',
  3221225725: 'stackOverflow',
  '-1073740940': 'heapCorruption',
  3221226356: 'heapCorruption',
  '-805306369': 'hang',
  3489660927: 'hang',
  137: 'killed',
  134: 'abort',
  139: 'segfault',
};

const shortVersion = (v) => String(v || '').split('+')[0].replace(/-(?:build|mc)[\w.]*$/i, '') || String(v || '');

function vendorOf(text) {
  const s = String(text || '').toLowerCase();
  if (/nvidia|geforce|quadro|rtx|gtx|nvogl|nvwgf|0x10de/.test(s)) return 'nvidia';
  if (/\bamd\b|radeon|\bati\b|atio|atig|amdx|0x1002/.test(s)) return 'amd';
  if (/intel|\big[\w]*icd|iris\(r\)|uhd graphics|hd graphics|0x8086/.test(s)) return 'intel';
  return null;
}

function gpuDllVendor(dll) {
  const d = String(dll || '').toLowerCase();
  if (/^nv(ogl|wgf|d3d|oglv|cuda)|nvidia|libnvidia/.test(d)) return 'nvidia';
  if (/^(atio|atig|ati\w+|amdx|amdvlk|amd)|radeon/.test(d)) return 'amd';
  if (/^ig\w*icd|^igd|^igxe|^igc|iris_dri|i965_dri|^intel/.test(d)) return 'intel';
  return null;
}

const OVERLAY_DLLS = /(rtsshooks|gameoverlayrenderer|discordhook|nvspcap|overlay|obs-|graphics-hook|fraps|bdcam|action_x|xsplit|reshade|dxgi\.dll)/i;

// ---------- Constructores ----------

const finding = (id, priority, confidence, vars, extra = {}) => ({
  id,
  priority,
  confidence,
  vars: vars || {},
  titleKey: extra.titleKey || `crash.r_${id}_title`,
  textKey: extra.textKey || `crash.r_${id}_text`,
  mods: (extra.mods || []).filter(Boolean),
  actions: (extra.actions || []).filter(Boolean),
  severity: extra.severity || 'bad',
});

const act = {
  install: (id, name, extra = {}) => ({ type: 'installMod', label: ['crash.a_installMod', { name }], payload: { modId: id, name, slug: SLUGS[id] || null, ...extra }, primary: true }),
  enable: (mod) => (mod ? { type: 'enableMod', label: ['crash.a_enableMod', { name: mod.name }], payload: { file: mod.file, name: mod.name }, primary: true } : null),
  disable: (mod, primary = false) => (mod?.file && mod.enabled !== false ? { type: 'disableMod', label: ['crash.a_disableMod', { name: mod.name }], payload: { file: mod.file, name: mod.name }, primary } : null),
  update: (primary = false) => ({ type: 'updateMods', label: ['crash.a_updateMods'], payload: {}, primary }),
  search: (name) => ({ type: 'searchMod', label: ['crash.a_searchMod', { name }], payload: { query: name } }),
  raiseRam: (mb, label) => ({ type: 'raiseRam', label: ['crash.a_raiseRam', { ram: label }], payload: { mb }, primary: true }),
  lowerRam: (mb, label) => ({ type: 'lowerRam', label: ['crash.a_lowerRam', { ram: label }], payload: { mb }, primary: true }),
  fixRam: (min, max) => ({ type: 'fixRam', label: ['crash.a_fixRam'], payload: { min, max }, primary: true }),
  useJava: (major) => ({ type: 'useJava', label: ['crash.a_useJava', { major }], payload: { major }, primary: true }),
  resetJava: (primary = false) => ({ type: 'resetJava', label: ['crash.a_resetJava'], payload: {}, primary }),
  removeArg: (option) => ({ type: 'removeJvmArg', label: ['crash.a_removeJvmArg', { option }], payload: { option }, primary: true }),
  resetConfig: (file) => ({ type: 'resetConfig', label: ['crash.a_resetConfig', { file: file.split('/').pop() }], payload: { file }, primary: true }),
  openFolder: (sub, key = 'crash.a_openFolder') => ({ type: 'openFolder', label: [key, { folder: sub || '.' }], payload: { sub } }),
  drivers: (vendor) =>
    vendor
      ? { type: 'openUrl', label: ['crash.a_drivers', { vendor: VENDOR_NAMES[vendor] }], payload: { url: DRIVER_URLS[vendor] }, primary: true }
      : { type: 'openUrl', label: ['crash.a_driversGeneric'], payload: { url: DRIVER_URLS.intel, chooser: true } },
  repair: (primary = true) => ({ type: 'repairInstance', label: ['crash.a_repair'], payload: {}, primary }),
  updateLoader: (loader) => ({ type: 'updateLoader', label: ['crash.a_updateLoader', { loader }], payload: {}, primary: true }),
  instanceSettings: () => ({ type: 'openInstanceSettings', label: ['crash.a_instanceSettings'], payload: {} }),
  snapshot: () => ({ type: 'restoreSnapshot', label: ['crash.a_restoreSnapshot'], payload: {} }),
  bisect: (mode = 'crash') => ({ type: 'startBisect', label: ['crash.a_startBisect'], payload: { mode } }),
  shadersOff: () => ({ type: 'disableShaders', label: ['crash.a_disableShaders'], payload: {}, primary: true }),
  settings: () => ({ type: 'openSettings', label: ['crash.a_openSettings'], payload: {} }),
};

// ---------- Reglas ----------

const RULES = [];
const rule = (id, fn) => RULES.push({ id, fn });

// Fabric/Quilt: "Incompatible mods found!" con el detalle exacto de versiones
rule('fabric_resolution', (c, h) => {
  if (!c.fabric.found) return null;
  const out = [];
  const missing = new Map();
  for (const d of c.fabric.details) {
    const mod = h.mod(d.mod.id, d.mod.name, d.mod.version);
    if (d.kind === 'missing') {
      const g = missing.get(d.dep.id) || { dep: d.dep, range: d.range, mods: [] };
      g.mods.push(mod);
      missing.set(d.dep.id, g);
      continue;
    }
    if (d.kind === 'wrongVersion') {
      out.push(h.versionProblem(mod, d.dep, d.range, d.present));
      continue;
    }
    if (d.kind === 'breaks') {
      const other = h.mod(d.dep.id, d.dep.name, d.present);
      // A quien conviene actualizar: lo dice la "solucion" de Fabric; si no, al mod marcado como incompatible
      const replace = c.fabric.solutions.filter((s) => s.type === 'replace').map((s) => s.id);
      const target = replace.includes(other.id) || !replace.includes(mod.id) ? other : mod;
      out.push(
        finding('mods_incompatible', 92, 'high', { a: mod.name, va: shortVersion(mod.version), b: other.name, vb: shortVersion(d.present || other.version), target: target.name }, {
          mods: [mod.file, other.file],
          actions: [act.update(true), act.disable(target.resolved), act.search(target.name)],
        }),
      );
    }
  }
  for (const g of missing.values()) out.push(h.missingDep(g.dep.id, g.dep.name, g.range, g.mods));
  return out;
});

// Forge/NeoForge: "Missing or unsupported mandatory dependencies"
rule('forge_dependencies', (c, h) => {
  if (!c.forgeDeps.length) return null;
  const out = [];
  const missing = new Map();
  for (const d of c.forgeDeps) {
    const mod = h.mod(d.requestedBy, null, null);
    if (d.actual === null && !['minecraft', 'forge', 'neoforge', 'java'].includes(d.modId)) {
      const g = missing.get(d.modId) || { range: d.range, mods: [] };
      g.mods.push(mod);
      missing.set(d.modId, g);
      continue;
    }
    out.push(h.versionProblem(mod, { id: d.modId, name: h.nameOf(d.modId) }, d.range, d.actual));
  }
  for (const [id, g] of missing) out.push(h.missingDep(id, h.nameOf(id), g.range, g.mods));
  return out;
});

// Mods duplicados (por el log o porque dos archivos traen el mismo mod)
rule('duplicate_mod', (c, h) => {
  const out = [];
  const groups = new Map();
  for (const d of c.duplicates) groups.set(d.id, new Set(d.files.map((f) => h.fileByName(f)).filter(Boolean)));
  for (const [id, files] of h.duplicateIds()) {
    if (!groups.has(id)) groups.set(id, new Set());
    for (const f of files) groups.get(id).add(f);
  }
  for (const [id, set] of groups) {
    const mods = [...set].map((f) => h.byFile(f)).filter(Boolean);
    if (mods.length < 2) continue;
    mods.sort((a, b) => compareSemver(b.version || '0', a.version || '0'));
    const keep = mods[0];
    const old = mods.slice(1);
    out.push(
      finding('duplicate_mod', 90, 'high', { name: keep.name || id, count: mods.length, files: old.map((m) => m.file).join(', '), keep: keep.file }, {
        mods: mods.map((m) => m.file),
        actions: old.map((m, i) => ({ type: 'disableMod', label: ['crash.a_disableFile', { file: m.file }], payload: { file: m.file, name: m.name }, primary: i === 0 })),
      }),
    );
  }
  return out;
});

// Mods de otro loader (Fabric en Forge, Forge en Fabric, Forge en NeoForge moderno)
rule('wrong_loader', (c, h) => {
  const inst = c.instance;
  const wrong = h.enabledMods().filter((m) => h.isWrongLoader(m));
  if (!wrong.length) return null;
  const instLoader = LOADER_NAMES[inst.loader] || inst.loader;
  const logMentions = /is a Fabric mod and cannot be loaded|is missing mods\.toml file|not a valid mod file|fml\.modloading\.brokenfile|Found \d+ non-fabric mod/i.test(c.all);
  const conf = logMentions ? 'high' : 'medium';
  if (wrong.length > 3) {
    return finding('wrong_loader_many', 80, conf, { count: wrong.length, mods: h.list(wrong.map((m) => m.name)), loader: instLoader }, {
      mods: wrong.map((m) => m.file),
      actions: wrong.slice(0, 3).map((m) => act.disable(m)),
    });
  }
  return wrong.map((m) =>
    finding('wrong_loader', 80, conf, { mod: m.name, modLoader: h.loaderOfMod(m), loader: instLoader }, { mods: [m.file], actions: [act.disable(m, true), act.search(m.name)] }),
  );
});

// Dos mods que reemplazan el motor grafico (Sodium + Embeddium, etc.)
rule('renderer_conflict', (c, h) => {
  const present = RENDERERS.map((id) => h.enabledById(id)).filter(Boolean);
  const unique = [...new Map(present.map((m) => [m.file, m])).values()];
  if (unique.length < 2) return null;
  const [a, b] = unique;
  return finding('renderer_conflict', 78, 'medium', { a: a.name, b: b.name }, { mods: [a.file, b.file], actions: [act.disable(b, true), act.disable(a)] });
});

// OptiFine con mods que no lo soportan
rule('optifine_conflict', (c, h) => {
  const of = h.enabledMods().find((m) => /optifine|optifabric/i.test(`${m.file} ${m.ids.join(' ')} ${m.name}`));
  const fromLog = /OptiFine|OptiFabric/i.test(c.all) && /(incompatib|conflict|crash|failed)/i.test(c.all);
  if (!of && !(c.instance.loader === 'optifine' && fromLog)) return null;
  const haters = OPTIFINE_HATERS.map((id) => h.enabledById(id)).filter(Boolean);
  if (haters.length) {
    return finding('optifine_conflict', 76, 'high', { mods: h.list(haters.map((m) => m.name)) }, {
      mods: [of?.file, ...haters.map((m) => m.file)],
      actions: [act.disable(of, true), ...haters.slice(0, 2).map((m) => act.disable(m))],
    });
  }
  if (of && /net\.optifine|optifine/i.test(c.rootText) && /NoSuchMethodError|NoSuchFieldError|ClassNotFoundException|IncompatibleClassChangeError/.test(c.rootText)) {
    return finding('optifine_version', 74, 'medium', {}, { mods: [of.file], actions: [act.disable(of, true), { type: 'openUrl', label: ['crash.a_optifineDownloads'], payload: { url: 'https://optifine.net/downloads' } }] });
  }
  return null;
});

// Mixins: un mod no pudo aplicar sus cambios al juego
rule('mixins', (c, h) => {
  const out = [];
  const seen = new Set();
  for (const f of c.mixin.failures) {
    const mod = h.modForMixin(f.config, f.modId);
    const key = mod?.file || f.config || f.modId;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(
      finding('mixin_failed', 85, mod?.file ? 'high' : 'medium', { mod: mod?.name || f.modId || f.config, mixin: f.mixin || '', target: f.target || '' }, {
        mods: [mod?.file],
        actions: [act.update(true), act.disable(mod), act.bisect()],
      }),
    );
  }
  for (const cf of c.mixin.conflicts) {
    const a = h.modForMixin(cf.a.config);
    const b = h.modForMixin(cf.b.config);
    if (!a || !b || a.file === b.file) continue;
    const key = [a.file, b.file].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    // Los conflictos de @Redirect son avisos: solo importan si el crash involucra a alguno de los dos
    const involved = h.isSuspect(a.file) || h.isSuspect(b.file);
    if (!involved && cf.kind !== 'overwrite') continue;
    out.push(finding('mixin_conflict', involved ? 83 : 50, involved ? 'medium' : 'low', { a: a.name, b: b.name }, { mods: [a.file, b.file], actions: [act.disable(a), act.disable(b), act.update()] }));
  }
  for (const cfg of c.mixin.missingConfigs) {
    const mod = h.modForMixin(cfg);
    out.push(
      finding('mixin_config_missing', 70, 'medium', { config: cfg, mod: mod?.name || '' }, {
        textKey: mod ? 'crash.r_mixin_config_missing_text' : 'crash.r_mixin_config_missing_textNoMod',
        mods: [mod?.file],
        actions: [act.disable(mod, true), act.repair(false)],
      }),
    );
  }
  return out;
});

// Un mod fallo al iniciar (entrypoint de Fabric, fase de carga de Forge)
rule('mod_init_failed', (c, h) => {
  const out = [];
  for (const e of c.entrypoints) {
    const mod = h.mod(e.modId, e.name, null);
    if (!mod.file && !c.report?.suspected?.length && ['minecraft', 'forge', 'neoforge'].includes(e.modId)) continue;
    out.push(finding('mod_init_failed', 84, 'high', { mod: mod.name, stage: e.stage }, { mods: [mod.file], actions: [act.update(true), act.disable(mod.resolved), act.bisect()] }));
  }
  return out;
});

// ---------- Memoria ----------

rule('memory', (c, h) => {
  const t = c.all;
  const cur = c.memoryMb;
  if (/OutOfMemoryError: (Java heap space|GC overhead limit exceeded|Requested array size exceeds VM limit)/.test(t)) {
    const to = h.ramUp(cur);
    if (to) return finding('oom_heap', 95, 'high', { ram: h.fmtRam(cur), suggested: h.fmtRam(to) }, { actions: [act.raiseRam(to, h.fmtRam(to))] });
    return finding('oom_heap', 95, 'high', { ram: h.fmtRam(cur) }, { textKey: 'crash.r_oom_heap_textMax', actions: [act.bisect()] });
  }
  if (/OutOfMemoryError: Metaspace|OutOfMemoryError: Compressed class space/.test(t)) {
    return finding('oom_metaspace', 90, 'high', {}, { actions: [h.hasCustomArgs() ? act.removeArg('-XX:MaxMetaspaceSize') : null, act.instanceSettings()] });
  }
  if (c.hs?.insufficientMemory || /There is insufficient memory for the Java Runtime Environment|Native memory allocation \(\w+\) failed|OutOfMemoryError: (unable to create (new )?native thread|Direct buffer memory)/.test(t)) {
    const to = h.ramDown(cur);
    return finding('oom_native', 93, 'high', { ram: h.fmtRam(cur), suggested: h.fmtRam(to) }, { actions: [to < cur ? act.lowerRam(to, h.fmtRam(to)) : null] });
  }
  if (/Could not reserve enough space for (?:\d+\w*\s+)?object heap|Unable to allocate \d+KB bitmaps|Invalid maximum heap size|The specified size exceeds the maximum representable size/i.test(t)) {
    const is32 = c.hs?.is32bit || /32-bit|x86\b|Client VM/i.test(t);
    const to = Math.min(h.ramDown(cur), is32 ? 1024 : h.ramDown(cur));
    return finding('heap_reserve', 96, 'high', { ram: h.fmtRam(cur), suggested: h.fmtRam(to) }, { actions: [act.lowerRam(to, h.fmtRam(to)), act.resetJava()] });
  }
  if (/Initial heap size set to a larger value than the maximum heap size|Incompatible minimum and maximum heap sizes specified/i.test(t)) {
    return finding('heap_invalid', 96, 'high', {}, { actions: [act.fixRam(1024, Math.max(2048, cur || 4096))] });
  }
  return null;
});

// Argumentos de Java invalidos
rule('jvm_bad_option', (c) => {
  const m = c.all.match(/Unrecognized VM option '([^']+)'/) || c.all.match(/Unrecognized option: (\S+)/) || c.all.match(/Error: (?:VM option|Option) '?([^'\s]+)'? (?:is experimental|must be enabled|requires)/);
  if (!m) return null;
  let opt = m[1].startsWith('-') ? m[1] : `-XX:${m[1]}`;
  // Mostrar el argumento tal como lo escribio el usuario (por ejemplo "-XX:+UseConcMarkSweepGC")
  const norm = (s) => String(s).replace(/^-XX:[+-]/, '-XX:').split('=')[0];
  const typed = String(c.instance.jvmArgs || '').split(/\s+/).find((tok) => tok && norm(tok) === norm(opt));
  if (typed) opt = typed;
  return finding('jvm_bad_option', 97, 'high', { option: opt }, { actions: [act.removeArg(opt), act.instanceSettings()] });
});

// ---------- Java ----------

rule('class_version', (c, h) => {
  const m = c.all.match(/UnsupportedClassVersionError: ([\w/$.]+) has been compiled by a more recent version of the Java Runtime \(class file version (\d+)(?:\.\d+)?\), this version of the Java Runtime only recognizes class file versions up to (\d+)/);
  const old = !m && c.all.match(/UnsupportedClassVersionError: ([\w/$.]+) : Unsupported major\.minor version (\d+)/);
  if (!m && !old) return null;
  const cls = (m || old)[1].replace(/\//g, '.');
  const needed = Number((m || old)[2]) - 44;
  const current = m ? Number(m[3]) - 44 : c.javaMajor || needed - 1;
  const mod = h.modForClass(cls);
  return finding('class_version', 98, 'high', { needed, current, mod: mod?.name || '' }, {
    textKey: mod ? 'crash.r_class_version_textMod' : 'crash.r_class_version_text',
    mods: [mod?.file],
    actions: [act.useJava(needed), act.disable(mod)],
  });
});

// Mod que pide una version de Java (Fabric: "requires version 21 or later of java")
// (se resuelve en versionProblem). Forge viejo con Java nuevo:
rule('java_legacy', (c, h) => {
  const legacy = /cannot be cast to (?:class )?java\.net\.URLClassLoader|java\.lang\.NoSuchFieldException: ucp|module java\.base does not "opens java\.(?:lang|util|net)"|Unable to make (?:field|method) .* accessible: module java\.base|Unsupported class file major version (\d+)/;
  const m = c.all.match(legacy);
  if (!m) return null;
  const mc = c.instance.mcVersion || '';
  const minor = Number((mc.match(/^1\.(\d+)/) || [])[1] || 99);
  if (m[1]) {
    // ASM viejo leyendo clases nuevas: un mod o el loader no soporta este Java
    const needed = minor <= 16 ? 8 : minor <= 17 ? 16 : minor <= 20 ? 17 : 21;
    return finding('java_legacy', 88, 'medium', { current: c.javaMajor || Number(m[1]) - 44, needed, mc }, { actions: [act.useJava(needed)] });
  }
  const needed = minor <= 16 ? 8 : 17;
  if (c.javaMajor && c.javaMajor <= needed) return null;
  return finding('java_legacy', 94, 'high', { current: c.javaMajor || '?', needed, mc }, { actions: [act.useJava(needed)] });
});

// Java personalizado que no existe o no arranca
rule('java_custom_broken', (c) => {
  if (!/No se pudo iniciar Java|Could not start Java|spawn .*java[w]?(?:\.exe)? ENOENT|Error: could not open `[^`]*jvm\.cfg'|Error: could not find java\.dll|Error occurred during initialization of VM/i.test(c.all)) return null;
  if (/Could not reserve enough space|Invalid maximum heap|Unrecognized/i.test(c.all)) return null;
  return finding('java_custom_broken', 96, c.instance.javaPath ? 'high' : 'medium', { path: c.instance.javaPath || '-' }, { actions: [act.resetJava(true)] });
});

// ---------- Video / drivers ----------

rule('graphics', (c, h) => {
  const t = c.all;
  const vendor = c.gpuVendor;
  if (/Pixel format not accelerated/i.test(t)) return finding('gl_pixel_format', 95, 'high', {}, { actions: [act.drivers(vendor)] });
  // "GLFW error 65542: ..." o "GLFW error during init: [0x10007]65542: ..."
  const glfw = t.match(/GLFW error (?:(?:during|before) init: )?(?:\[0x[0-9a-f]+\])?(\d{5})/i);
  if (glfw || /WGL: (?:The driver does not appear to support OpenGL|Failed to (?:create|make) OpenGL context)|Failed to create window|Could not create context|No OpenGL context found in the current thread/i.test(t)) {
    if (/(?:OpenGL|GL) (?:version )?[\d.]+ (?:is )?(?:not supported|required)|requires OpenGL|OpenGL 3\.2/i.test(t)) {
      const gl = (t.match(/OpenGL (\d\.\d)/) || [])[1] || '3.2';
      return finding('gl_version', 93, 'high', { gl }, { actions: [act.drivers(vendor)] });
    }
    return finding('gl_glfw', 92, 'high', { code: glfw ? glfw[1] : '?' }, { actions: [act.drivers(vendor)] });
  }
  if (/GL_OUT_OF_MEMORY|OpenGL Error: 1285|Out of video memory/i.test(t)) return finding('gl_out_of_memory', 80, 'medium', {}, { actions: [act.drivers(vendor), act.shadersOff()] });
  if (/(?:outdated|incompatible|known to (?:be incompatible|cause crashes)).{0,80}graphics driver|graphics driver.{0,80}(?:is outdated|known to (?:be incompatible|cause)|not compatible)/i.test(t)) {
    return finding('sodium_driver', 91, 'high', { vendor: VENDOR_NAMES[vendor] || '' }, { actions: [act.drivers(vendor)] });
  }
  return null;
});

// Crash nativo de la JVM (hs_err_pid): driver de video, overlays, LWJGL o la propia JVM
rule('native_crash', (c, h) => {
  const hs = c.hs;
  const codeName = EXIT_CODES[String(c.code)];
  if (!hs?.module && !hs?.error) return null;
  const dll = hs.module || '';
  const gpu = gpuDllVendor(dll);
  if (gpu) return finding('gpu_driver_crash', 94, 'high', { dll, vendor: VENDOR_NAMES[gpu] }, { actions: [act.drivers(gpu), act.shadersOff()] });
  if (OVERLAY_DLLS.test(dll)) return finding('overlay_crash', 90, 'high', { dll }, {});
  if (dll) return finding('native_crash', 75, 'medium', { module: dll }, { actions: [act.drivers(c.gpuVendor), act.resetJava()] });
  void codeName;
  return null;
});

// Shader pack que no compila
rule('shader_error', (c) => {
  if (!/ShaderCompileException|Failed to (?:compile|link) (?:shader|program)|Shader compilation failed|error compiling shader/i.test(c.rootText + c.all.slice(-20000))) return null;
  if (!/iris|oculus|optifine|shader/i.test(c.all)) return null;
  return finding('shader_error', 72, 'medium', {}, { actions: [act.shadersOff()] });
});

// ---------- Archivos dañados ----------

rule('config_corrupt', (c) => {
  const t = c.all;
  const forge = t.match(/Failed loading config file (\S+?) of type (\w+) for modid ([\w.-]+)/);
  if (forge) {
    const file = /[\\/]/.test(forge[1]) ? forge[1].replace(/\\/g, '/').replace(/^.*?\b(config|defaultconfigs)\//, '$1/') : `config/${forge[1]}`;
    return finding('config_corrupt', 93, 'high', { file: file.split('/').pop(), mod: forge[3] }, { actions: [act.resetConfig(file), act.openFolder('config', 'crash.a_openConfig')] });
  }
  const parseErr = /(JsonSyntaxException|MalformedJsonException|JsonParseException|com\.electronwill\.nightconfig\.core\.io\.ParsingException|ParsingException: Not enough data available|Unterminated object at|Expected (?:BEGIN_OBJECT|a name|':') but was|TomlParseException|ConfigLoadingException|JsonEOFException|Unexpected end of JSON)/;
  if (!parseErr.test(c.rootText) && !parseErr.test(c.all.slice(-30000))) return null;
  const files = c.configPaths;
  if (files.length) {
    const file = files[files.length - 1];
    return finding('config_corrupt', 88, 'medium', { file: file.split('/').pop(), mod: '' }, { textKey: 'crash.r_config_corrupt_textNoMod', actions: [act.resetConfig(file), act.openFolder('config', 'crash.a_openConfig')] });
  }
  if (/Failed to (?:load|read) options|Failed to parse option/i.test(c.all)) return finding('options_corrupt', 86, 'medium', {}, { actions: [act.resetConfig('options.txt')] });
  return finding('config_corrupt', 70, 'low', {}, { textKey: 'crash.r_config_corrupt_textUnknown', actions: [act.openFolder('config', 'crash.a_openConfig'), act.bisect()] });
});

rule('options_corrupt', (c) => {
  if (!/Failed to load options|Failed to parse option|Options\.load|Error loading options/i.test(c.all)) return null;
  if (!/NumberFormatException|JsonSyntaxException|IllegalArgumentException|ArrayIndexOutOfBounds|StringIndexOutOfBounds/.test(c.all)) return null;
  return finding('options_corrupt', 85, 'medium', {}, { actions: [act.resetConfig('options.txt')] });
});

rule('world_corrupt', (c) => {
  const t = c.all;
  if (!/Exception reading chunk|Couldn't load chunk|Failed to read chunk|Couldn't read chunk|Failed to load level\.dat|Exception reading .*level\.dat|Couldn't load level data|Failed to read level data|RegionFile|Corrupted chunk|invalid (?:distance too far back|stored block lengths|block type)|Failed to load data for (?:player|level)/i.test(t)) return null;
  if (!/chunk|level\.dat|region|saves/i.test(c.rootText + t.slice(-40000))) return null;
  return finding('world_corrupt', 82, 'medium', { world: c.report?.levelName || '' }, {
    textKey: c.report?.levelName ? 'crash.r_world_corrupt_text' : 'crash.r_world_corrupt_textNoName',
    actions: [act.snapshot(), act.openFolder('saves', 'crash.a_openSaves')],
  });
});

rule('corrupt_jar', (c, h) => {
  const m = c.all.match(/(?:ZipException|ZipError|IOException)[^\r\n]*?(?:zip END header not found|invalid LOC header|invalid CEN header|error in opening zip file|zip file is empty|Zip file is corrupted|invalid entry (?:compressed )?size|truncated ZIP)/i);
  const broken = h.enabledMods().filter((x) => x.corrupt);
  if (!m && !broken.length) return null;
  const fileMatch = c.all.match(/([\w.\-+ ()]+\.jar)[^\r\n]{0,120}(?:zip END header not found|invalid LOC header|error in opening zip file|zip file is empty)/i);
  const mod = broken[0] || (fileMatch ? h.byFile(h.fileByName(fileMatch[1])) : null);
  if (mod) return finding('corrupt_jar', 89, 'high', { file: mod.file }, { mods: [mod.file], actions: [act.disable(mod, true), act.search(mod.name)] });
  return finding('corrupt_jar', 80, 'medium', { file: fileMatch ? fileMatch[1] : '?' }, { textKey: 'crash.r_corrupt_jar_textGame', actions: [act.repair()] });
});

rule('natives_missing', (c) => {
  if (!/UnsatisfiedLinkError|no lwjgl\w* in java\.library\.path|Failed to locate library: (?:lwjgl|glfw|openal)|Can't load library: .*lwjgl/i.test(c.all)) return null;
  if (!/lwjgl|glfw|openal|jemalloc|natives/i.test(c.all)) return null;
  return finding('natives_missing', 86, 'high', {}, { actions: [act.repair()] });
});

rule('system_errors', (c) => {
  const t = c.all;
  if (/No space left on device|There is not enough space on the disk|ENOSPC/i.test(t)) return finding('disk_full', 97, 'high', {}, {});
  const denied = t.match(/AccessDeniedException: ([^\r\n]+)|Access is denied|Acceso denegado|EPERM: operation not permitted, \w+ '([^']+)'/i);
  if (denied) return finding('access_denied', 70, 'medium', { file: (denied[1] || denied[2] || '').trim().split(/[\\/]/).pop() || '?' }, { actions: [act.openFolder('')] });
  if (/being used by another process|The process cannot access the file|FileSystemException: .*used by another/i.test(t)) return finding('file_locked', 68, 'medium', {}, {});
  return null;
});

// ---------- Errores de codigo ----------

// Entidad o bloque que rompe el mundo al actualizarse
rule('ticking', (c, h) => {
  const r = c.report;
  if (!r) return null;
  const out = [];
  if (r.entity && /Ticking entity|Entity being ticked|Rendering entity/i.test(`${r.description}`)) {
    const ns = r.entity.type.split(':')[0];
    const mod = ns !== 'minecraft' ? h.mod(ns, null, null) : r.entity.cls ? h.modForClass(r.entity.cls) : null;
    out.push(
      finding('ticking_entity', 86, 'high', { entity: r.entity.type, mod: mod?.name || '' }, {
        textKey: mod?.name ? 'crash.r_ticking_entity_textMod' : 'crash.r_ticking_entity_text',
        mods: [mod?.file],
        actions: [mod?.file ? act.update(true) : null, act.snapshot(), act.disable(mod?.resolved || mod)],
      }),
    );
  }
  if (r.blockEntity && /Ticking block entity|Block entity being ticked|Rendering Block Entity/i.test(`${r.description}`)) {
    const ns = r.blockEntity.type.split(':')[0];
    const mod = ns !== 'minecraft' ? h.mod(ns, null, null) : r.blockEntity.cls ? h.modForClass(r.blockEntity.cls) : null;
    out.push(
      finding('ticking_block', 86, 'high', { block: r.blockEntity.type, mod: mod?.name || '' }, {
        textKey: mod?.name ? 'crash.r_ticking_block_textMod' : 'crash.r_ticking_block_text',
        mods: [mod?.file],
        actions: [mod?.file ? act.update(true) : null, act.snapshot(), act.disable(mod?.resolved || mod)],
      }),
    );
  }
  return out;
});

// Falta una clase: libreria conocida sin instalar, API que cambio o mod de otro loader
rule('missing_class', (c, h) => {
  const m = c.rootText.match(/(?:NoClassDefFoundError|ClassNotFoundException)(?::\s*|\s+)([\w$.\/]+)/) || c.all.match(/java\.lang\.(?:NoClassDefFoundError|ClassNotFoundException):\s*([\w$.\/]+)/);
  if (!m) return null;
  const cls = m[1].replace(/\//g, '.');
  const requester = h.topSuspect();
  const loader = c.instance.loader;
  // Clases de Forge en una instancia de Fabric (o al reves)
  if (/^net\.(minecraftforge|neoforged)\./.test(cls) && ['fabric', 'quilt', 'legacyfabric'].includes(loader)) {
    if (/ForgeConfigSpec|ModConfig|config/i.test(cls)) return finding('missing_library', 90, 'high', { lib: 'Forge Config API Port', mod: requester?.name || '' }, { textKey: requester ? 'crash.r_missing_library_text' : 'crash.r_missing_library_textNoMod', mods: [requester?.file], actions: [act.install('forgeconfigapiport', 'Forge Config API Port')] });
    return finding('wrong_loader', 88, 'high', { mod: requester?.name || '?', modLoader: 'Forge', loader: LOADER_NAMES[loader] }, { mods: [requester?.file], actions: [act.disable(requester, true)] });
  }
  if (/^net\.fabricmc\./.test(cls) && ['forge', 'neoforge'].includes(loader)) {
    return finding('wrong_loader', 88, 'high', { mod: requester?.name || '?', modLoader: 'Fabric', loader: LOADER_NAMES[loader] }, { mods: [requester?.file], actions: [act.disable(requester, true), requester ? act.search(requester.name) : null] });
  }
  if (/^kotlin\./.test(cls)) {
    const lib = ['forge', 'neoforge'].includes(loader) ? ['kotlinforforge', 'Kotlin for Forge'] : ['fabric-language-kotlin', 'Fabric Language Kotlin'];
    return finding('missing_library', 92, 'high', { lib: lib[1], mod: requester?.name || '' }, { textKey: requester ? 'crash.r_missing_library_text' : 'crash.r_missing_library_textNoMod', mods: [requester?.file], actions: [act.install(lib[0], lib[1])] });
  }
  const lib = LIB_PACKAGES.find(([p]) => cls === p || cls.startsWith(`${p}.`));
  const owner = h.modForClass(cls);
  if (lib && !owner) {
    const installed = h.enabledById(lib[1]);
    const disabled = !installed && h.disabledById(lib[1]);
    return finding('missing_library', 93, 'high', { lib: lib[2], mod: requester?.name || '' }, {
      textKey: disabled ? 'crash.r_missing_library_textDisabled' : requester ? 'crash.r_missing_library_text' : 'crash.r_missing_library_textNoMod',
      mods: [requester?.file],
      actions: [disabled ? act.enable(disabled) : act.install(lib[1], lib[2])],
    });
  }
  if (owner && requester && owner.file !== requester.file) {
    return finding('missing_class', 87, 'high', { cls: cls.split('.').pop(), mod: requester.name, owner: owner.name }, {
      textKey: 'crash.r_missing_class_textOwner',
      mods: [requester.file, owner.file],
      actions: [act.update(true), act.disable(requester)],
    });
  }
  return finding('missing_class', 74, requester ? 'medium' : 'low', { cls: cls.split('.').pop(), full: cls, mod: requester?.name || '' }, {
    textKey: requester ? 'crash.r_missing_class_textMod' : 'crash.r_missing_class_text',
    mods: [requester?.file],
    actions: [act.update(true), act.disable(requester), act.bisect()],
  });
});

// API distinta a la esperada (mod para otra version del juego o de una libreria)
rule('api_mismatch', (c, h) => {
  const m = c.rootText.match(/(NoSuchMethodError|NoSuchFieldError|AbstractMethodError|IncompatibleClassChangeError|VerifyError)(?::\s*([^\r\n]*))?/);
  if (!m) return null;
  const mod = h.topSuspect();
  const member = (m[2] || '').replace(/^'|'$/g, '').trim().slice(0, 140);
  return finding('api_mismatch', 80, mod ? 'medium' : 'low', { mod: mod?.name || '', member: member || m[1] }, {
    textKey: mod ? 'crash.r_api_mismatch_textMod' : 'crash.r_api_mismatch_text',
    mods: [mod?.file],
    actions: [act.update(true), act.disable(mod), act.bisect()],
  });
});

rule('class_cast', (c, h) => {
  const m = c.rootText.match(/ClassCastException:\s*(?:class\s+)?([\w$.]+) cannot be cast to (?:class\s+)?([\w$.]+)/);
  if (!m) return null;
  const a = h.modForClass(m[1]);
  const b = h.modForClass(m[2]);
  if (a && b && a.file !== b.file) return finding('class_cast', 79, 'medium', { a: a.name, b: b.name }, { textKey: 'crash.r_class_cast_textPair', mods: [a.file, b.file], actions: [act.update(true), act.disable(a), act.disable(b)] });
  const mod = a || b || h.topSuspect();
  if (!mod) return null;
  return finding('class_cast', 72, 'medium', { mod: mod.name }, { mods: [mod.file], actions: [act.update(true), act.disable(mod), act.bisect()] });
});

rule('concurrent_mod', (c, h) => {
  if (!/ConcurrentModificationException/.test(c.rootText)) return null;
  const mod = h.topSuspect();
  return finding('concurrent_mod', 76, mod ? 'medium' : 'low', { mod: mod?.name || '' }, {
    textKey: mod ? 'crash.r_concurrent_mod_textMod' : 'crash.r_concurrent_mod_text',
    mods: [mod?.file],
    actions: [act.update(true), act.disable(mod), act.bisect()],
  });
});

rule('stack_overflow', (c, h) => {
  if (!/StackOverflowError/.test(c.rootText) && EXIT_CODES[String(c.code)] !== 'stackOverflow') return null;
  const mod = h.topSuspect();
  return finding('stack_overflow', 77, mod ? 'medium' : 'low', { mod: mod?.name || '' }, {
    textKey: mod ? 'crash.r_stack_overflow_textMod' : 'crash.r_stack_overflow_text',
    mods: [mod?.file],
    actions: [act.update(true), act.disable(mod), act.bisect()],
  });
});

// Codigo de salida conocido sin otra explicacion
rule('exit_code', (c) => {
  const kind = EXIT_CODES[String(c.code)];
  if (!kind || kind === 'stackOverflow') return null;
  return finding('exit_code', 40, 'low', { code: c.code, meaning: { $t: `crash.exit_${kind}` } }, { actions: [kind === 'killed' ? null : act.drivers(c.gpuVendor)] });
});

module.exports = { RULES, SLUGS, LIB_PACKAGES, RENDERERS, LOADER_NAMES, DRIVER_URLS, VENDOR_NAMES, EXIT_CODES, finding, act, shortVersion, vendorOf, gpuDllVendor };
