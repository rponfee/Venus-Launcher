'use strict';
// Herramientas del asistente: validacion + ejecucion. Cada herramienta tiene:
//   minLevel: nivel minimo (la configuracion puede subirlo, nunca bajarlo)
//   prepare(input, ctx) -> { scope, instanceId, confirm?, ... }   (valida todo antes de tocar nada)
//   run(prep, ctx) -> { data, summary, warnings?, noChange? }       (hace el cambio; ctx.action registra el deshacer)
// Restricciones aplicadas aca, en codigo: solo instancias por id, archivos "pelados" dentro de mods/,
// resourcepacks/ o shaderpacks/ de esa instancia, descargas solo de Modrinth/CurseForge, nada de mundos,
// comandos, .jar, cuentas, tokens ni planes.
const os = require('os');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../../core/paths');
const instances = require('../../core/instances');
const settings = require('../../core/settings');
const modrinth = require('../../core/modrinth');
const minecraft = require('../../core/minecraft');
const java = require('../../core/java');
const http = require('../../core/http');
const { exists, readJson } = require('../../core/util');
const { t } = require('../../core/i18n');
const config = require('./config');
const sources = require('./sources');
const options = require('./options');
const system = require('./system');
const crash = require('./crash');
const undo = require('./undo');
const { ToolError, existingContent, assertKind, assertDownloadUrl, assertBareFileName, insideDir } = require('./guards');

const MB = 1048576;
const LOADERS = ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'];
const LEGACY_JAVA8 = ['forge', 'optifine', 'legacyfabric'];
const GC_SELECTOR = /^-XX:\+Use(G1|Z|Shenandoah|Parallel|Serial|ConcMarkSweep)GC$/;

const deps = {
  optional: () => null,
  isRunning: () => false,
  gameStatus: () => ({}),
  startInstall: () => {},
  installServer: () => {}, // instala en segundo plano el software de un servidor recien creado
  runTask: async (title, fn) => fn(null), // (titulo, fn(task), instanceId, signal, meta)
  trash: null,
  send: () => {},
  // Esperas de las herramientas de servidores (ms); las pruebas las bajan a 0
  startWaitMs: 25000,
  stopWaitMs: 60000,
  commandWaitMs: 1200,
};

function configure(d = {}) {
  Object.assign(deps, Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)));
}

// ---------- Ayudas ----------
async function getInstance(id) {
  if (typeof id !== 'string' || !id) throw new ToolError(t('assistant.errNoInstanceId'), 'instance');
  try {
    // Solo el id exacto (el nombre real de la carpeta): en Windows "Survival" o "SURVIVAL" abren la carpeta
    // "survival" y saltearian los controles que comparan ids (juego abierto, instalacion masiva, Deshacer).
    if (!(await fsp.readdir(paths.instances())).includes(id)) throw new Error('alias');
    return await instances.get(id);
  } catch {
    throw new ToolError(t('assistant.errNoInstance', { id: String(id).slice(0, 80) }), 'instance');
  }
}

function assertNotRunning(inst) {
  if (deps.isRunning(inst.id)) throw new ToolError(t('assistant.errGameRunningName', { name: inst.name }), 'running');
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

async function countContent(dir, kind) {
  const entries = await fsp.readdir(path.join(dir, kind), { withFileTypes: true }).catch(() => []);
  let enabled = 0;
  let disabled = 0;
  for (const e of entries) {
    if (kind === 'mods' ? !(e.isFile() && /\.(jar|zip|litemod)(\.disabled)?$/i.test(e.name)) : !(e.isDirectory() || /\.zip(\.disabled)?$/i.test(e.name))) continue;
    if (e.name.endsWith('.disabled')) disabled++;
    else enabled++;
  }
  return { enabled, disabled };
}

function loaderLabel(l) {
  return instances.LOADER_NAMES?.[l] || l;
}

// Version de Minecraft valida y soportada por el loader (y version del loader si se indico).
async function validateVersion(mc, loader, loaderVersion) {
  if (!LOADERS.includes(loader)) throw new ToolError(t('assistant.errLoader', { loader: String(loader) }), 'loader');
  if (!minecraft.validVersionId(mc)) throw new ToolError(t('assistant.errMcVersion', { version: String(mc).slice(0, 40) }), 'version');
  let manifest;
  try {
    manifest = await minecraft.getManifest();
  } catch {
    throw new ToolError(t('assistant.errOffline'), 'network');
  }
  const idx = (manifest.versions || []).findIndex((v) => v.id === mc);
  if (idx < 0) throw new ToolError(t('assistant.errMcVersion', { version: mc }), 'version');
  if (loader !== 'vanilla') {
    let supported = [];
    try {
      if (loader === 'fabric' || loader === 'quilt') supported = (await require('../../core/loaders/fabric').getGameVersions(loader)).map((v) => v.version);
      else supported = await require('../../core/loaders/forge').getGameVersions(loader);
    } catch {
      throw new ToolError(t('assistant.errOffline'), 'network');
    }
    if (!supported.includes(mc)) throw new ToolError(t('assistant.errLoaderNoVersion', { loader: loaderLabel(loader), version: mc }), 'version');
    if (loaderVersion) {
      let list = [];
      try {
        list = loader === 'fabric' || loader === 'quilt' ? await require('../../core/loaders/fabric').getLoaderVersions(loader, mc) : await require('../../core/loaders/forge').getLoaderVersions(loader, mc);
      } catch {
        list = [];
      }
      const hit = list.find((l) => l.version === loaderVersion || l.label === loaderVersion);
      if (!hit) throw new ToolError(t('assistant.errLoaderVersion', { loader: loaderLabel(loader), version: loaderVersion, mc }), 'version');
      return { index: idx, manifest, loaderVersion: hit.version };
    }
  }
  return { index: idx, manifest, loaderVersion: loader === 'vanilla' ? null : 'latest' };
}

// Java de la instancia sin ejecutar nada: runtime de Venus (marcador) o el que pide la version.
async function javaInfo(inst) {
  const required = java.majorForMinecraft(inst.mcVersion);
  const p = inst.java?.path;
  if (!p) return { mode: 'auto', major: required, required };
  let major = null;
  const runtimeRoot = path.resolve(paths.runtime());
  const full = path.resolve(p);
  if (full.startsWith(runtimeRoot + path.sep)) {
    const comp = full.slice(runtimeRoot.length + 1).split(path.sep)[0];
    const marker = await readJson(path.join(runtimeRoot, comp, '.venus-runtime.json'), null);
    major = marker?.major || java.COMPONENT_MAJOR[comp] || null;
  }
  return { mode: 'custom', major, required, venus_runtime: major !== null };
}

function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function joinArgs(tokens) {
  return tokens.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ');
}

// Ids de la lista blanca que la instancia tiene aplicados hoy.
function appliedFlags(inst, flags = config.jvmFlags()) {
  const tokens = new Set(splitArgs(inst.java?.args || ''));
  const ids = [];
  for (const f of flags) {
    if (f.group === 'gc' ? inst.java?.preset === f.preset : f.args.every((a) => tokens.has(a))) ids.push(f.id);
  }
  const whitelisted = new Set(flags.flatMap((f) => f.args));
  return { ids, custom: [...tokens].filter((x) => !whitelisted.has(x)).length };
}

function confirmPayload(kind, title, message, extra = {}) {
  return { kind, title, message, danger: kind === 'destructive' || kind === 'downgrade', ...extra };
}

function noChange(summary, data = {}) {
  return { noChange: true, summary, data: { changed: false, ...data } };
}

// ---------- Herramientas de lectura ----------
const listInstances = {
  minLevel: 'read',
  async prepare() {
    return {};
  },
  async run(_p, ctx) {
    const list = (await instances.list()).slice(0, 100);
    const status = deps.gameStatus();
    const selected = (await settings.get()).selectedInstance;
    const out = [];
    for (const i of list) {
      out.push({
        id: i.id,
        name: i.name,
        mc_version: i.mcVersion,
        loader: i.loader,
        loader_version: i.loaderVersion || null,
        ...(i.preset ? { preset: i.preset } : {}),
        mods: (await countContent(i.dir, 'mods')).enabled,
        running: Boolean(status[i.id]),
        selected: i.id === selected,
        last_played: iso(i.lastPlayed),
        ...(ctx.conv?.createdInstances?.includes(i.id) ? { created_in_this_chat: true } : {}),
      });
    }
    return { data: { count: out.length, instances: out }, summary: t('assistant.sumInstances', { count: out.length }) };
  },
};

const getInstanceInfo = {
  minLevel: 'read',
  async prepare(input) {
    return { inst: await getInstance(input.instance_id) };
  },
  async run({ inst }) {
    const s = await settings.get();
    const [mods, rps, shaders, worlds, opts, jv] = await Promise.all([
      countContent(inst.dir, 'mods'),
      countContent(inst.dir, 'resourcepacks'),
      countContent(inst.dir, 'shaderpacks'),
      undo.countWorlds(inst.dir),
      options.current(inst.dir, config.optionKeys()),
      javaInfo(inst),
    ]);
    const mem = inst.memory?.override
      ? { mode: 'instance', min_mb: inst.memory.min, max_mb: inst.memory.max }
      : s.memoryMode === 'manual'
        ? { mode: 'global', max_mb: s.memory?.max }
        : { mode: 'auto', note: 'The launcher computes RAM automatically before each launch (system RAM and instance size).', global_max_mb: s.memory?.max };
    const flags = appliedFlags(inst);
    return {
      data: {
        id: inst.id,
        name: inst.name,
        mc_version: inst.mcVersion,
        loader: inst.loader,
        loader_version: inst.loaderVersion || null,
        ...(inst.preset ? { preset: inst.preset } : {}),
        installed: Boolean(inst.installed),
        running: deps.isRunning(inst.id),
        ram: mem,
        system_ram_total_mb: Math.round(os.totalmem() / MB),
        java: jv,
        jvm: { gc_preset: inst.java?.preset || `global (${s.jvmPreset || 'auto'})`, whitelisted_flags: flags.ids, custom_args: flags.custom },
        content: {
          mods_enabled: mods.enabled,
          mods_disabled: mods.disabled,
          resource_packs: rps.enabled + rps.disabled,
          shader_packs: shaders.enabled + shaders.disabled,
          shader_loader: modrinth.shaderLoadersFor(inst),
        },
        worlds,
        options: opts.exists ? opts.values : { note: 'options.txt does not exist yet (the game was never opened).' },
        last_played: iso(inst.lastPlayed),
      },
      summary: t('assistant.sumInstanceInfo', { name: inst.name, version: inst.mcVersion, loader: loaderLabel(inst.loader), mods: mods.enabled }),
    };
  },
};

const PAGE = 150;
const listMods = {
  minLevel: 'read',
  async prepare(input) {
    const offset = Number.isInteger(input.offset) && input.offset > 0 ? input.offset : 0;
    return { inst: await getInstance(input.instance_id), kind: assertKind(input.kind || 'mods'), query: String(input.query || '').trim().toLowerCase(), offset };
  },
  async run({ inst, kind, query, offset }) {
    const all = await modrinth.listFolder(inst.dir, kind);
    // Con filtro se identifica todo (por titulo); sin filtro, solo la pagina pedida
    const ids = await sources.identify(inst, kind, query ? all.slice(0, 600) : all.slice(offset, offset + PAGE));
    const matches = query ? all.filter((f) => f.file.toLowerCase().includes(query) || String(ids[f.file]?.title || '').toLowerCase().includes(query)) : all;
    const page = matches.slice(offset, offset + PAGE);
    const list = page.map((f) => {
      const id = ids[f.file];
      return {
        file: f.file,
        enabled: f.enabled,
        ...(f.isDir ? { folder: true } : {}),
        ...(id ? { title: id.title, project_id: id.project_id, version: id.version_number } : {}),
      };
    });
    const next = offset + PAGE < matches.length ? offset + PAGE : null;
    return {
      data: { kind, total: matches.length, offset, count: list.length, ...(next !== null ? { next_offset: next } : {}), enabled_count: all.filter((f) => f.enabled).length, disabled_count: all.filter((f) => !f.enabled).length, files: list },
      summary: t('assistant.sumMods', { count: matches.length, kind: t(`assistant.kind_${kind}`) }),
    };
  },
};

const getSystemSpecs = {
  minLevel: 'read',
  async prepare() {
    return {};
  },
  async run() {
    const s = await system.specs();
    return { data: s, summary: t('assistant.sumSpecs', { cpu: s.cpu, ram: s.ram_total_gb, gpu: s.gpu || '?' }) };
  },
};

const runBenchmark = {
  minLevel: 'read',
  async prepare() {
    return {};
  },
  async run() {
    const r = await system.benchmark();
    return { data: r, summary: t('assistant.sumBenchmark', { cpu: r.cpu_tier || '?', gpu: r.gpu_tier || '?', tier: r.overall_tier || '?' }) };
  },
};

function searchTool(type) {
  return {
    minLevel: 'read',
    async prepare(input) {
      const inst = input.instance_id ? await getInstance(input.instance_id) : null;
      if (!String(input.query || '').trim()) throw new ToolError(t('assistant.errEmptyQuery'), 'input');
      return { inst, input };
    },
    async run({ inst, input }) {
      const r = await sources.search({ type, query: input.query, inst, mcVersion: input.mc_version, loader: input.loader, limit: input.limit, sort: input.sort });
      if (inst && type === 'mod' && !sources.hasModLoader(inst)) r.note = 'This instance is vanilla: mods need Fabric, Forge, NeoForge or Quilt.';
      if (inst && type === 'shader') {
        r.instance_shader_loader = modrinth.shaderLoadersFor(inst);
        if (!r.instance_shader_loader.length) r.note = 'This instance has no shader loader: install Iris (Fabric/Quilt) or use OptiFine before shaders will work.';
      }
      const count = r.results.length + (r.curseforge?.length || 0);
      return { data: r, summary: t('assistant.sumSearch', { count, query: String(input.query).slice(0, 60) }) };
    },
  };
}

const getModVersions = {
  minLevel: 'read',
  async prepare(input) {
    return { inst: await getInstance(input.instance_id), ref: sources.parseRef(input.project_id), all: Boolean(input.include_incompatible) };
  },
  async run({ inst, ref, all }) {
    const r = await sources.versions(ref, inst, { includeIncompatible: all });
    return { data: r, summary: t('assistant.sumVersions', { count: r.total, title: r.project.title }) };
  },
};

const checkCompatibility = {
  minLevel: 'read',
  async prepare(input) {
    const inst = await getInstance(input.instance_id);
    const list = (Array.isArray(input.project_ids) ? input.project_ids : []).slice(0, 20);
    if (!list.length) throw new ToolError(t('assistant.errNoProjects'), 'input');
    return { inst, refs: list.map((p) => sources.parseRef(p)) };
  },
  async run({ inst, refs }) {
    const results = await sources.checkCompatibility(inst, refs);
    const bad = results.filter((r) => r.status === 'error').length;
    return {
      data: { instance: { id: inst.id, mc_version: inst.mcVersion, loader: inst.loader }, results },
      summary: t('assistant.sumCompat', { ok: results.length - bad, bad }),
    };
  },
};

const readCrashSummary = {
  minLevel: 'read',
  async prepare(input) {
    return { inst: await getInstance(input.instance_id) };
  },
  async run({ inst }) {
    let external = null;
    const mod = deps.optional('crash');
    for (const fn of ['analyzeInstance', 'crashSummary', 'summary']) {
      if (mod && typeof mod[fn] === 'function') {
        try {
          external = await Promise.race([mod[fn](inst.id), new Promise((r) => setTimeout(() => r(null), 20000))]);
        } catch (err) {
          console.warn('[assistant] Analisis de crash del modulo crash:', err.message);
        }
        break;
      }
    }
    const own = await crash.summarize(inst);
    const data = { instance: { id: inst.id, mc_version: inst.mcVersion, loader: inst.loader }, ...own };
    if (external) data.launcher_analysis = compactJson(external, 2500);
    const when = own.crash_report?.time || own.jvm_crash?.time || own.latest_log?.time || null;
    const what = own.crash_report?.exception || own.crash_report?.description || own.jvm_crash?.error || own.latest_log?.errors?.at(-1) || null;
    let date = '?';
    try {
      if (when) date = new Intl.DateTimeFormat(require('../../core/i18n').getLanguage(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(when));
    } catch {
      date = String(when).slice(0, 16).replace('T', ' ');
    }
    return {
      data,
      summary: own.found ? t('assistant.sumCrash', { date, what: (what || '?').slice(0, 90) }) : t('assistant.sumNoCrash'),
    };
  },
};

// JSON compacto con tope de tamaño (para datos de otros modulos de forma desconocida).
function compactJson(value, max) {
  let s;
  try {
    s = JSON.stringify(value, (k, v) => (typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}…` : v));
  } catch {
    return null;
  }
  if (!s) return null;
  if (s.length <= max) return JSON.parse(s);
  return `${s.slice(0, max)}…`;
}

// ---------- Herramientas de cambios (reversibles) ----------
const createInstance = {
  minLevel: 'reversible',
  async prepare(input) {
    const name = String(input.name || '').replace(/[\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const v = await validateVersion(String(input.mc_version || '').trim(), input.loader, input.loader_version ? String(input.loader_version).trim() : null);
    return { scope: 'create', name, mcVersion: String(input.mc_version).trim(), loader: input.loader, loaderVersion: v.loaderVersion };
  },
  async run(p, ctx) {
    const inst = await instances.create({ name: p.name, mcVersion: p.mcVersion, loader: p.loader, loaderVersion: p.loaderVersion || undefined });
    ctx.action.entry.instanceId = inst.id;
    ctx.action.target('instance:create');
    ctx.action.op({ type: 'removeInstance', instanceId: inst.id });
    if (ctx.conv && !ctx.conv.createdInstances.includes(inst.id)) ctx.conv.createdInstances.push(inst.id);
    deps.send('instances:changed');
    deps.startInstall(inst.id, inst.name);
    return {
      data: { instance_id: inst.id, name: inst.name, mc_version: inst.mcVersion, loader: inst.loader, loader_version: inst.loaderVersion, status: 'Created. The game and loader are installing in the background; you can install mods now.' },
      summary: t('assistant.sumCreated', { name: inst.name, version: inst.mcVersion, loader: loaderLabel(inst.loader) }),
    };
  },
};

function installTool(type) {
  return {
    minLevel: 'reversible',
    async prepare(input) {
      const inst = await getInstance(input.instance_id);
      assertNotRunning(inst);
      const ref = sources.parseRef(input.project_id);
      return { scope: 'instance', instanceId: inst.id, inst, ref, versionId: input.version_id ? String(input.version_id).trim() : null, accept: input.accept_known_incompatibility === true };
    },
    async run(p, ctx) {
      const { inst, ref } = p;
      // Ya instalado con esa version: nada que hacer (los slugs de Modrinth se resuelven a su id)
      const recs = ref.source === 'curseforge' ? inst.curseforge?.projects || {} : inst.modrinth?.projects || {};
      let recKey = ref.source === 'curseforge' ? String(ref.id) : ref.id;
      if (ref.source === 'modrinth' && !recs[recKey]) recKey = (await modrinth.getProject(ref.id).catch(() => null))?.id || recKey;
      if (recKey && recs[recKey]?.file) {
        const rec = recs[recKey];
        const folder = rec.folder || sources.FOLDER_BY_TYPE[type];
        const same = !p.versionId || p.versionId === String(rec.versionId || rec.fileId || '');
        if (same && (await exists(insideDir(inst.dir, folder, rec.file)))) {
          return noChange(t('assistant.sumAlready', { title: rec.title || ref.ref, version: rec.versionNumber || '?' }), { already_installed: true, title: rec.title, version: rec.versionNumber, file: rec.file });
        }
        // Instalado pero desactivado: se avisa en lugar de dejar dos copias
        if (await exists(insideDir(inst.dir, folder, `${rec.file}.disabled`))) {
          return noChange(t('assistant.sumAlreadyDisabled', { file: rec.file }), { already_installed: true, disabled: true, file: `${rec.file}.disabled`, hint: 'Use toggle_mod to enable it, or update_mod to change its version.' });
        }
      }
      // Verificacion de compatibilidad antes de instalar
      const [check] = await sources.checkCompatibility(inst, [ref], { versionIds: p.versionId ? { [ref.ref]: p.versionId } : {} });
      const blocking = (check?.issues || []).filter((i) => i.severity === 'error' && !(p.accept && sources.INCOMPAT_CODES.has(i.code)));
      if (blocking.length) {
        const err = new ToolError(t('assistant.errNotCompatible', { reasons: blocking.map((i) => i.message).join(' ') }), 'compat');
        err.data = { compatibility: check };
        throw err;
      }
      const chosen = p.versionId || (ref.source === 'modrinth' && check?.version?.id ? check.version.id : null);
      const plan = await sources.plan(inst, ref, chosen, type);
      const warnings = [...plan.warnings, ...(check?.issues || []).filter((i) => i.severity === 'warning').map((i) => i.message)];
      if (p.accept) warnings.push(...(check?.issues || []).filter((i) => i.severity === 'error').map((i) => i.message));
      if (type === 'shader' && !modrinth.shaderLoadersFor(inst).length && !warnings.some((w) => w === t('assistant.warnNoShaderLoader'))) warnings.push(t('assistant.warnNoShaderLoader'));
      const root = plan.items[0];
      await deps.runTask(t('assistant.taskInstall', { title: root.title, name: inst.name }), (task) => sources.execute(inst, plan.items, ctx.action, { task, signal: ctx.signal }), inst.id, ctx.signal);
      deps.send('instances:changed');
      const depsAdded = plan.items.slice(1);
      return {
        data: {
          installed: plan.items.map((i) => ({ title: i.title, project_id: i.source === 'curseforge' ? `cf:${i.projectId}` : i.projectId, version: i.versionNumber, file: i.file, folder: i.folder })),
          dependencies_added: depsAdded.length,
          warnings: [...new Set(warnings)].slice(0, 8),
        },
        warnings: [...new Set(warnings)].slice(0, 8),
        summary: depsAdded.length
          ? t('assistant.sumInstalledDeps', { title: root.title, version: root.versionNumber, count: depsAdded.length, name: inst.name })
          : t('assistant.sumInstalled', { title: root.title, version: root.versionNumber, name: inst.name }),
      };
    },
  };
}

const updateMod = {
  minLevel: 'reversible',
  async prepare(input) {
    const inst = await getInstance(input.instance_id);
    assertNotRunning(inst);
    const file = await existingContent(inst.dir, 'mods', input.file);
    return { scope: 'instance', instanceId: inst.id, inst, file, versionId: input.version_id ? String(input.version_id).trim() : null };
  },
  async run(p, ctx) {
    const { inst, file } = p;
    const ids = await sources.identify(inst, 'mods', [{ file: file.name }]);
    const info = ids[file.name];
    if (!info) throw new ToolError(t('assistant.errNotIdentified', { file: file.name }), 'identify');
    const disabled = file.name.endsWith('.disabled');
    let target;
    if (info.source === 'curseforge') {
      const ref = sources.parseRef(info.project_id);
      const cf = await sources.curseforge();
      if (!cf) throw new ToolError(t('assistant.errNoCurseforge'), 'cf');
      const plan = await sources.plan(inst, ref, p.versionId, 'mod');
      const it = plan.items[0];
      if (String(it.versionId) === String(info.version_id)) return noChange(t('assistant.sumUpToDate', { title: it.title, version: it.versionNumber }), { version: it.versionNumber });
      target = { ...it };
    } else {
      const project = await modrinth.getProject(info.project_id);
      const loaders = modrinth.modLoadersFor(inst);
      let v;
      if (p.versionId) {
        v = await modrinth.getVersion(p.versionId);
        if (v.project_id !== project.id) throw new ToolError(t('assistant.errVersionOtherProject', { title: project.title }), 'version');
        if (!(v.game_versions || []).includes(inst.mcVersion) || (loaders.length && !(v.loaders || []).some((l) => loaders.includes(l)))) {
          throw new ToolError(t('assistant.errVersionNotForMc', { title: project.title, version: v.version_number, mc: `${inst.mcVersion} (${inst.loader})` }), 'version');
        }
      } else {
        const list = await modrinth.getVersions(project.id, { loaders: loaders.length ? loaders : undefined, gameVersions: [inst.mcVersion], includeChangelog: false });
        v = list.find((x) => x.version_type === 'release') || list[0];
        if (!v) throw new ToolError(t('assistant.errNoCompatibleVersion', { title: project.title, mc: inst.mcVersion, loader: inst.loader }), 'version');
      }
      if (v.id === info.version_id) return noChange(t('assistant.sumUpToDate', { title: project.title, version: v.version_number }), { version: v.version_number });
      const pf = modrinth.primaryFile(v);
      const name = path.basename(String(pf?.filename || ''));
      assertBareFileName(name);
      let direction = 'change';
      try {
        const cur = info.version_id ? await modrinth.getVersion(info.version_id) : null;
        if (cur?.date_published && v.date_published) direction = new Date(v.date_published) > new Date(cur.date_published) ? 'upgrade' : 'downgrade';
      } catch {
        direction = 'change';
      }
      const missing = (v.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id && !inst.modrinth?.projects?.[d.project_id]).map((d) => d.project_id);
      target = {
        source: 'modrinth',
        projectId: project.id,
        title: project.title,
        versionId: v.id,
        versionNumber: v.version_number,
        file: name,
        url: assertDownloadUrl(pf.url, 'modrinth'),
        sha1: pf.hashes?.sha1 || null,
        size: pf.size || 0,
        direction,
        missing,
        record: { title: project.title, icon: project.icon_url || null, type: 'mod', versionId: v.id, versionNumber: v.version_number, file: name, folder: 'mods' },
      };
    }
    const newName = disabled ? `${target.file}.disabled` : target.file;
    const sourceKey = target.source === 'curseforge' ? 'curseforge' : 'modrinth';
    const recKey = String(target.projectId);
    const prevRec = inst[sourceKey]?.projects?.[recKey];
    // Registro para deshacer: copia del archivo actual, quitar el nuevo y restaurar el registro
    const backup = await ctx.action.backup('mods', file.name);
    if (newName !== file.name) ctx.action.op({ type: 'removeFile', folder: 'mods', file: newName, sha1: target.sha1 });
    ctx.action.op({ type: 'restoreFile', folder: 'mods', file: file.name, backup });
    ctx.action.op({ type: 'projects', source: sourceKey, records: [{ id: recKey, had: Boolean(prevRec), value: prevRec || null }] });
    ctx.action.target(`file:mods/${file.name.replace(/\.disabled$/, '')}`, `file:mods/${target.file}`, `project:${sourceKey}:${recKey}`);
    if (newName !== file.name && (await exists(insideDir(inst.dir, 'mods', newName)))) throw new ToolError(t('assistant.errFileExists', { file: newName }), 'exists');

    await deps.runTask(
      t('assistant.taskUpdate', { title: target.title, name: inst.name }),
      (task) =>
        http.downloadAll([{ url: assertDownloadUrl(target.url, target.source), path: insideDir(inst.dir, 'mods', newName), sha1: target.sha1 || undefined, size: target.size || undefined }], {
          concurrency: 1,
          verify: 'hash',
          signal: ctx.signal || task?.signal,
          onProgress: task?.downloadProgress ? task.downloadProgress(sourceKey === 'curseforge' ? 'CurseForge' : 'Modrinth') : undefined,
        }),
      inst.id,
      ctx.signal,
    );
    if (newName !== file.name) await fsp.rm(file.full, { force: true });
    const fresh = await instances.get(inst.id);
    await instances.update(inst.id, { [sourceKey]: { ...(fresh[sourceKey] || {}), projects: { ...(fresh[sourceKey]?.projects || {}), [recKey]: { ...(prevRec || {}), ...target.record, installedAt: Date.now() } } } });
    deps.send('instances:changed');
    const warnings = target.missing?.length ? [t('assistant.warnMissingDeps', { list: target.missing.join(', ') })] : [];
    return {
      data: { file_before: file.name, file_after: newName, version_before: info.version_number, version_after: target.versionNumber, direction: target.direction || 'change', missing_required_dependencies: target.missing || [], warnings },
      warnings,
      summary: t('assistant.sumUpdated', { title: target.title, from: info.version_number || '?', to: target.versionNumber }),
    };
  },
};

const toggleMod = {
  minLevel: 'reversible',
  async prepare(input) {
    const inst = await getInstance(input.instance_id);
    assertNotRunning(inst);
    assertBareFileName(String(input.file || ''));
    const base = String(input.file).replace(/\.disabled$/i, '');
    const want = input.enabled === true;
    const enabledName = base;
    const disabledName = `${base}.disabled`;
    const hasEnabled = await exists(insideDir(inst.dir, 'mods', enabledName));
    const hasDisabled = await exists(insideDir(inst.dir, 'mods', disabledName));
    if (!hasEnabled && !hasDisabled) await existingContent(inst.dir, 'mods', input.file); // lanza el error de archivo inexistente
    return { scope: 'instance', instanceId: inst.id, inst, base, want, hasEnabled, hasDisabled };
  },
  async run(p, ctx) {
    const { inst, base, want, hasEnabled, hasDisabled } = p;
    if (want && hasEnabled) return noChange(t('assistant.sumAlreadyEnabled', { file: base }), { file: base, enabled: true });
    if (!want && hasDisabled && !hasEnabled) return noChange(t('assistant.sumAlreadyDisabled', { file: base }), { file: `${base}.disabled`, enabled: false });
    if (hasEnabled && hasDisabled) throw new ToolError(t('assistant.errFileExists', { file: `${base}.disabled` }), 'exists');
    const from = want ? `${base}.disabled` : base;
    await existingContent(inst.dir, 'mods', from);
    ctx.action.target(`file:mods/${base}`);
    const to = await instances.toggleFile(inst.id, 'mods', from);
    ctx.action.op({ type: 'rename', folder: 'mods', from: to, to: from });
    deps.send('instances:changed');
    return { data: { file: to, enabled: want }, summary: t(want ? 'assistant.sumEnabled' : 'assistant.sumDisabled', { file: base }) };
  },
};

const setRam = {
  minLevel: 'reversible',
  async prepare(input) {
    const max = Number(input.max_mb);
    const totalMb = Math.floor(os.totalmem() / MB);
    const limit = Math.floor((totalMb * 0.75) / 128) * 128;
    if (!Number.isInteger(max) || max < 512) throw new ToolError(t('assistant.errRamMin'), 'ram');
    if (max > limit) throw new ToolError(t('assistant.errRamMax', { max, limit, total: totalMb }), 'ram');
    if (input.scope === 'instance') {
      const inst = await getInstance(input.instance_id);
      return { scope: 'instance', instanceId: inst.id, inst, max };
    }
    if (input.scope !== 'global') throw new ToolError(t('assistant.errRamScope'), 'ram');
    return { scope: 'global', instanceId: null, max };
  },
  async run(p, ctx) {
    const warnings = [];
    const freeMb = Math.floor(os.freemem() / MB);
    if (p.max > freeMb) warnings.push(t('assistant.warnLowFreeRam', { free: freeMb }));
    if (p.scope === 'instance') {
      const prev = p.inst.memory || { override: false, min: 1024, max: 4096 };
      if (prev.override && prev.max === p.max) return noChange(t('assistant.sumRamSame', { max: p.max }), { max_mb: p.max });
      const min = Math.min(Math.max(512, prev.min || 1024), p.max);
      ctx.action.target('meta:memory');
      ctx.action.op({ type: 'meta', fields: [{ path: 'memory', had: true, value: prev }] });
      await instances.update(p.inst.id, { memory: { override: true, min, max: p.max } });
      deps.send('instances:changed');
      return {
        data: { scope: 'instance', before: prev.override ? { mode: 'instance', max_mb: prev.max } : { mode: 'global_or_auto' }, after: { mode: 'instance', min_mb: min, max_mb: p.max }, warnings },
        warnings,
        summary: t('assistant.sumRamInstance', { name: p.inst.name, max: p.max }),
      };
    }
    const s = await settings.get();
    if (s.memoryMode === 'manual' && s.memory?.max === p.max) return noChange(t('assistant.sumRamSame', { max: p.max }), { max_mb: p.max });
    const min = Math.min(1024, p.max);
    ctx.action.target('settings:memory');
    ctx.action.op({ type: 'settings', patch: { memoryMode: s.memoryMode, memory: { ...(s.memory || {}) }, perf: { manualMax: s.perf?.manualMax ?? undefined } } });
    await settings.set({ memoryMode: 'manual', memory: { min, max: p.max }, perf: { manualMax: p.max } });
    deps.send('assistant:settingsChanged');
    return {
      data: { scope: 'global', before: { mode: s.memoryMode === 'manual' ? 'manual' : 'auto', max_mb: s.memory?.max }, after: { mode: 'manual', min_mb: min, max_mb: p.max }, warnings },
      warnings,
      summary: t('assistant.sumRamGlobal', { max: p.max }),
    };
  },
};

const setOption = {
  minLevel: 'reversible',
  async prepare(input) {
    const keys = config.optionKeys();
    const def = keys[input.key];
    if (!def) throw new ToolError(t('assistant.errOptionKey', { key: String(input.key).slice(0, 40), keys: Object.keys(keys).join(', ') }), 'option');
    const inst = await getInstance(input.instance_id);
    assertNotRunning(inst);
    const doc = await options.read(inst.dir);
    const legacyRaw = def.legacy ? options.rawOf(doc, def.legacy) : null;
    const existing = options.rawOf(doc, input.key);
    if (def.since && !options.mcAtLeast(inst.mcVersion, def.since) && existing === null && !def.legacy) {
      throw new ToolError(t('assistant.errOptionVersion', { key: input.key, since: def.since, mc: inst.mcVersion }), 'option');
    }
    const fmt = options.format(input.key, def, input.value, { mcVersion: inst.mcVersion, existingRaw: existing, legacyExists: legacyRaw !== null && existing === null });
    return { scope: 'instance', instanceId: inst.id, inst, key: input.key, def, fmt, doc };
  },
  async run(p, ctx) {
    const { inst, key, def, fmt, doc } = p;
    const prevRaw = options.rawOf(doc, fmt.fileKey);
    const lang = require('../../core/i18n').getLanguage();
    const label = def.label?.[lang] || def.label?.en || key;
    const before = options.display(key, def, fmt.fileKey === key ? prevRaw : null, fmt.fileKey !== key ? prevRaw : null);
    // Valores con nombre (fast, minimal, true...) traducidos para el resumen de la interfaz
    const shown = (v) => {
      const k = `assistant.optval_${v}`;
      const tr = t(k);
      return tr === k ? v : tr;
    };
    if (prevRaw === fmt.raw) return noChange(t('assistant.sumOptionSame', { label, value: shown(fmt.display) }), { key, value: fmt.display });
    ctx.action.target(`option:${fmt.fileKey}`);
    ctx.action.op({ type: 'option', fileKey: fmt.fileKey, had: prevRaw !== null, raw: prevRaw, fileExisted: doc.exists });
    await options.setRaw(inst.dir, fmt.fileKey, fmt.raw);
    return {
      data: { key, before, after: fmt.display, ...(doc.exists ? {} : { note: 'options.txt was created; the game fills in the rest on first launch.' }) },
      summary: t('assistant.sumOption', { label, from: before === null ? t('assistant.defaultValue') : shown(before), to: shown(fmt.display) }),
    };
  },
};

const setJavaVersion = {
  minLevel: 'reversible',
  async prepare(input) {
    const inst = await getInstance(input.instance_id);
    assertNotRunning(inst);
    const major = String(input.major).toLowerCase();
    const required = java.majorForMinecraft(inst.mcVersion);
    if (major !== 'auto') {
      const n = Number(major);
      if (![8, 16, 17, 21, 25].includes(n)) throw new ToolError(t('assistant.errJavaMajor'), 'java');
      if (n < required && !java.compatibleMajors(required).includes(n)) throw new ToolError(t('assistant.errJavaTooOld', { major: n, required, mc: inst.mcVersion }), 'java');
      if (required === 8 && n > 8 && LEGACY_JAVA8.includes(inst.loader)) throw new ToolError(t('assistant.errJavaLegacy', { major: n, mc: inst.mcVersion, loader: loaderLabel(inst.loader) }), 'java');
    }
    return { scope: 'instance', instanceId: inst.id, inst, major, required };
  },
  async run(p, ctx) {
    const { inst } = p;
    const prevPath = inst.java?.path || '';
    const before = await javaInfo(inst);
    let javaPath = '';
    let afterLabel = 'auto';
    if (p.major !== 'auto') {
      const n = Number(p.major);
      const component = java.MAJOR_COMPONENT[n] || `java-${n}`;
      javaPath = await deps.runTask(t('assistant.taskJava', { major: n }), (task) => java.ensureRuntime(component, n, task), inst.id, ctx.signal);
      if (!javaPath) throw new ToolError(t('assistant.errJavaInstall', { major: n }), 'java');
      afterLabel = String(n);
    }
    if (javaPath === prevPath) return noChange(t('assistant.sumJavaSame', { major: afterLabel }), { java: afterLabel });
    ctx.action.target('meta:java.path');
    ctx.action.op({ type: 'meta', fields: [{ path: 'java.path', had: true, value: prevPath }] });
    await instances.update(inst.id, { java: { path: javaPath } });
    deps.send('instances:changed');
    return {
      data: { before: before.mode === 'auto' ? 'auto' : String(before.major || 'custom'), after: afterLabel, required_by_game: p.required },
      summary: t('assistant.sumJava', { name: inst.name, from: before.mode === 'auto' ? t('assistant.javaAuto') : `Java ${before.major || '?'}`, to: afterLabel === 'auto' ? t('assistant.javaAuto') : `Java ${afterLabel}` }),
    };
  },
};

const setJvmArgs = {
  minLevel: 'reversible',
  async prepare(input) {
    const flags = config.jvmFlags();
    const byId = new Map(flags.map((f) => [f.id, f]));
    const ids = [...new Set((input.flag_ids || []).map((x) => String(x).toLowerCase()))];
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length) throw new ToolError(t('assistant.errJvmUnknown', { ids: unknown.join(', '), allowed: flags.map((f) => f.id).join(', ') }), 'jvm');
    const chosen = ids.map((id) => byId.get(id));
    const gcs = chosen.filter((f) => f.group === 'gc');
    if (gcs.length > 1) throw new ToolError(t('assistant.errJvmGcConflict', { ids: gcs.map((f) => f.id).join(', ') }), 'jvm');
    const inst = await getInstance(input.instance_id);
    assertNotRunning(inst);
    const jv = await javaInfo(inst);
    const major = jv.major || jv.required;
    for (const f of chosen) {
      if (major < f.minJava) throw new ToolError(t('assistant.errJvmJava', { id: f.id, min: f.minJava, major }), 'jvm');
      if (f.maxJava && major > f.maxJava) throw new ToolError(t('assistant.errJvmJava', { id: f.id, min: f.minJava, major }), 'jvm');
    }
    const tokens = splitArgs(inst.java?.args || '');
    const whitelisted = new Set(flags.flatMap((f) => f.args));
    const kept = tokens.filter((x) => !whitelisted.has(x));
    if (gcs.length && kept.some((x) => GC_SELECTOR.test(x))) throw new ToolError(t('assistant.errJvmCustomGc'), 'jvm');
    return { scope: 'instance', instanceId: inst.id, inst, flags, chosen, gc: gcs[0] || null, kept };
  },
  async run(p, ctx) {
    const { inst, flags, chosen, gc, kept } = p;
    const add = [];
    for (const f of chosen) for (const a of f.args) if (!add.includes(a)) add.push(a);
    const newArgs = joinArgs([...kept, ...add]);
    const curPreset = inst.java?.preset || null;
    const whitelistedPresets = new Set(flags.filter((f) => f.group === 'gc').map((f) => f.preset));
    const newPreset = gc ? gc.preset : whitelistedPresets.has(curPreset) ? null : curPreset;
    const curArgs = inst.java?.args || '';
    if (newArgs === curArgs && newPreset === curPreset) return noChange(t('assistant.sumJvmSame'), { flag_ids: chosen.map((f) => f.id) });
    const java0 = inst.java || {};
    ctx.action.target('meta:java.args', 'meta:java.preset');
    ctx.action.op({
      type: 'meta',
      fields: [
        { path: 'java.args', had: Object.prototype.hasOwnProperty.call(java0, 'args'), value: java0.args ?? '' },
        { path: 'java.preset', had: java0.preset !== undefined, value: java0.preset ?? null },
      ],
    });
    await instances.update(inst.id, { java: { args: newArgs, preset: newPreset } });
    deps.send('instances:changed');
    const lang = require('../../core/i18n').getLanguage();
    const labels = chosen.map((f) => f.label?.[lang] || f.label?.en || f.id);
    return {
      data: { applied: chosen.map((f) => f.id), gc_preset: newPreset || 'global', custom_args_kept: kept.length },
      summary: chosen.length ? t('assistant.sumJvm', { list: labels.join(', ') }) : t('assistant.sumJvmReset'),
    };
  },
};

const changeInstanceVersion = {
  minLevel: 'reversible',
  async prepare(input) {
    const inst = await getInstance(input.instance_id);
    assertNotRunning(inst);
    const mc = String(input.mc_version || '').trim();
    const v = await validateVersion(mc, input.loader, input.loader_version ? String(input.loader_version).trim() : null);
    const sameLoaderVersion = !input.loader_version || v.loaderVersion === inst.loaderVersion;
    if (mc === inst.mcVersion && input.loader === inst.loader && sameLoaderVersion) {
      return { scope: 'instance', instanceId: inst.id, inst, same: true };
    }
    const fromIdx = (v.manifest.versions || []).findIndex((x) => x.id === inst.mcVersion);
    // El manifest va de la mas nueva a la mas vieja: un indice mayor es una version mas vieja
    const downgrade = fromIdx >= 0 && v.index > fromIdx;
    const mcChanged = mc !== inst.mcVersion;
    const loaderChanged = input.loader !== inst.loader;
    const worlds = await undo.countWorlds(inst.dir);
    const prep = { scope: 'instance', instanceId: inst.id, inst, mc, loader: input.loader, loaderVersion: v.loaderVersion, downgrade, mcChanged, loaderChanged, worlds };
    // Con mundos, cambiar la version o el loader es destructivo para ellos (al abrirlos se actualizan, se dañan o
    // pierden los bloques de los mods que ya no cargan) y Deshacer solo vuelve la configuracion: siempre se confirma.
    if (worlds > 0 && (mcChanged || loaderChanged)) {
      const key = loaderChanged ? 'Loader' : downgrade ? 'Downgrade' : 'Upgrade';
      const from = loaderChanged ? `${inst.mcVersion} ${loaderLabel(inst.loader)}` : inst.mcVersion;
      const to = loaderChanged ? `${mc} ${loaderLabel(input.loader)}` : mc;
      prep.confirm = confirmPayload('downgrade', t(`assistant.confirm${key}Title`), `${t(`assistant.confirm${key}Text`, { name: inst.name, from, to, count: worlds })} ${t('assistant.confirmWorldsNoUndo', { count: worlds })}`, {
        okText: t(`assistant.confirm${key}Ok`),
        items: [`${from} → ${to}`],
      });
    }
    return prep;
  },
  async run(p, ctx) {
    const { inst } = p;
    if (p.same) return noChange(t('assistant.sumVersionSame', { version: inst.mcVersion, loader: loaderLabel(inst.loader) }));
    const field = (k) => ({ path: k, had: inst[k] !== undefined, value: inst[k] ?? null });
    ctx.action.target('meta:version');
    ctx.action.op({ type: 'meta', fields: ['mcVersion', 'loader', 'loaderVersion', 'versionId', 'installed', 'preset'].map(field) });
    const loaderChanged = p.loader !== inst.loader;
    await instances.update(inst.id, {
      mcVersion: p.mc,
      loader: p.loader,
      loaderVersion: p.loaderVersion || (p.loader === 'vanilla' ? null : 'latest'),
      versionId: null,
      installed: false,
      ...(loaderChanged ? { preset: null } : {}),
    });
    await instances.clearPrepared(inst.id).catch(() => {});
    deps.send('instances:changed');
    deps.startInstall(inst.id, inst.name);
    const mods = (await countContent(inst.dir, 'mods')).enabled;
    const warnings = [];
    if (mods) warnings.push(t('assistant.warnModsAfterChange', { count: mods }));
    if (p.worlds && p.loaderChanged) warnings.push(t('assistant.warnWorldsLoader', { count: p.worlds }));
    if (p.worlds && p.mcChanged) warnings.push(t(p.downgrade ? 'assistant.warnWorldsDowngrade' : 'assistant.warnWorldsUpgrade', { count: p.worlds }));
    return {
      data: { before: { mc_version: inst.mcVersion, loader: inst.loader }, after: { mc_version: p.mc, loader: p.loader, loader_version: p.loaderVersion || null }, status: 'Reinstalling in the background.', mods_to_check: mods, worlds: p.worlds, warnings },
      warnings,
      summary: t('assistant.sumVersionChanged', { name: inst.name, from: `${inst.mcVersion} ${loaderLabel(inst.loader)}`, to: `${p.mc} ${loaderLabel(p.loader)}` }),
    };
  },
};

// ---------- Destructiva ----------
const removeMod = {
  minLevel: 'destructive',
  async prepare(input) {
    const inst = await getInstance(input.instance_id);
    assertNotRunning(inst);
    const file = await existingContent(inst.dir, 'mods', input.file);
    const ids = await sources.identify(inst, 'mods', [{ file: file.name }], { network: false });
    const title = ids[file.name]?.title || file.name;
    return {
      scope: 'instance',
      instanceId: inst.id,
      inst,
      file,
      title,
      confirm: confirmPayload('destructive', t('assistant.confirmRemoveTitle'), t('assistant.confirmRemoveText', { title, name: inst.name }), { okText: t('assistant.confirmRemoveOk'), items: [file.name] }),
    };
  },
  async run(p) {
    const { inst, file } = p;
    if (!deps.trash) throw new ToolError(t('assistant.errNoTrash'), 'trash');
    try {
      await deps.trash(file.full);
    } catch {
      throw new ToolError(t('assistant.errTrash', { file: file.name }), 'trash');
    }
    // Registros de Modrinth/CurseForge que apuntaban a ese archivo
    const base = file.name.replace(/\.disabled$/, '');
    try {
      const cur = await instances.get(inst.id);
      const patch = {};
      for (const src of ['modrinth', 'curseforge']) {
        const projects = { ...(cur[src]?.projects || {}) };
        let changed = false;
        for (const [pid, rec] of Object.entries(projects)) {
          if (rec?.file === base && (!rec.folder || rec.folder === 'mods')) {
            delete projects[pid];
            changed = true;
          }
        }
        if (changed) patch[src] = { ...(cur[src] || {}), projects };
      }
      if (Object.keys(patch).length) await instances.update(inst.id, patch);
    } catch (err) {
      console.warn('[assistant] No se pudieron limpiar los registros del mod quitado:', err.message);
    }
    deps.send('instances:changed');
    return { data: { removed: file.name, location: 'recycle bin' }, summary: t('assistant.sumRemoved', { file: file.name }) };
  },
};

const REGISTRY = {
  list_instances: listInstances,
  get_instance_info: getInstanceInfo,
  list_mods: listMods,
  get_system_specs: getSystemSpecs,
  run_benchmark: runBenchmark,
  search_mods: searchTool('mod'),
  search_resource_packs: searchTool('resourcepack'),
  search_shaders: searchTool('shader'),
  get_mod_versions: getModVersions,
  check_compatibility: checkCompatibility,
  read_crash_summary: readCrashSummary,
  create_instance: createInstance,
  install_mod: installTool('mod'),
  install_resource_pack: installTool('resourcepack'),
  install_shader: installTool('shader'),
  update_mod: updateMod,
  toggle_mod: toggleMod,
  set_ram: setRam,
  set_option: setOption,
  set_java_version: setJavaVersion,
  set_jvm_args: setJvmArgs,
  change_instance_version: changeInstanceVersion,
  remove_mod: removeMod,
};

// Servidores locales (tools-servers.js) y extras de instancias (tools-extra.js): comparten ayudas y deps con las de arriba
const shared = { deps, getInstance, assertNotRunning, noChange, confirmPayload, countContent, loaderLabel, javaInfo, MB };
Object.assign(REGISTRY, require('./tools-servers').build(shared), require('./tools-extra').build(shared));

const INSTALL_TOOLS = new Set(['install_mod', 'install_resource_pack', 'install_shader']);

module.exports = { configure, REGISTRY, INSTALL_TOOLS, getInstance, appliedFlags, javaInfo, splitArgs };
