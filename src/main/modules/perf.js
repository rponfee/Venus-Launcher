'use strict';
// Rendimiento: datos del equipo, memoria automatica por instancia (antes de cada partida),
// recomendaciones (RAM, Java, mods de optimizacion, opciones de video) y su aplicacion.
const os = require('os');
const paths = require('../core/paths');
const settings = require('../core/settings');
const instances = require('../core/instances');
const tasks = require('../core/tasks');
const game = require('../core/game');
const java = require('../core/java');
const { readJson } = require('../core/util');
const { t } = require('../core/i18n');
const system = require('./perf/system');
const memory = require('./perf/memory');
const options = require('./perf/options');
const recommend = require('./perf/recommend');
const installer = require('./perf/installer');

const MB = 1048576;
const PRESETS = ['auto', 'aikar', 'zgc', 'g1', 'none'];

// ---------- Plan de memoria (para la pagina y el panel de cada instancia) ----------
async function memoryPlan({ instanceId } = {}) {
  const s = await settings.get();
  const totalMb = os.totalmem() / MB;
  const freeMb = os.freemem() / MB;
  const p = memory.plan(totalMb);
  const out = {
    totalMb,
    freeMb,
    mode: s.memoryMode === 'manual' ? 'manual' : 'auto',
    manual: { min: s.memory?.min, max: s.memory?.max },
    manualMax: s.perf?.manualMax || s.memory?.max || p.base,
    plan: p,
    slider: memory.zones(totalMb),
    examples: memory.examples(totalMb),
  };
  if (instanceId) {
    const inst = await instances.get(instanceId);
    const auto = await memory.forInstance(inst, { totalMb });
    out.instance = {
      id: inst.id,
      name: inst.name,
      memory: inst.memory || { override: false, min: 1024, max: 4096 },
      modCount: auto.modCount,
      isModpack: auto.isModpack,
      shaders: auto.shaders,
      auto: { min: auto.min, max: auto.max },
      need: auto.need,
      slider: memory.zones(totalMb, auto.need),
    };
  }
  return out;
}

// ---------- Aplicar recomendaciones ----------
function normalizeMods(list, rec) {
  if (list === true) return (rec?.mods || []).filter((m) => !m.installed);
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => (typeof m === 'string' ? { projectId: m } : m))
    .filter((m) => m && typeof m.projectId === 'string' && /^[\w-]{2,64}$/.test(m.projectId))
    .map((m) => {
      const known = rec?.mods?.find((x) => x.projectId === m.projectId);
      return { projectId: m.projectId, versionId: m.versionId || known?.versionId || null, title: m.title || known?.title, slug: known?.slug, type: 'mod' };
    });
}

function sanitizeOptions(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) if (options.KEYS[k] && v !== null && v !== undefined) out[k] = v;
  return out;
}

// opts: { memory: true | { min, max } | null, jvmPreset?, mods: true | [projectId | { projectId, versionId }], options: true | { clave: valor }, lowEnd }
async function applyRecommended(instanceId, opts = {}) {
  if (!instanceId) throw new Error(t('perf.errNoInstance'));
  const inst = await instances.get(instanceId);
  if (game.status()[instanceId]) throw new Error(t('perf.errRunning', { name: inst.name }));
  const needsRec = opts.memory === true || opts.mods === true || opts.options === true;
  const rec = needsRec ? await recommend.build({ instanceId, lowEnd: opts.lowEnd }) : null;

  return tasks.run(
    t('perf.taskOptimize', { name: inst.name }),
    async (task) => {
      const summary = { memory: null, jvmPreset: null, installed: [], skipped: [], failed: [], warnings: [], options: [] };
      // 1) Memoria y recolector de Java
      const mem = opts.memory === true ? rec.memory : opts.memory;
      if (mem && Number(mem.max) > 0) {
        const max = Math.max(512, Math.round(Number(mem.max)));
        const min = Math.min(max, Math.max(256, Math.round(Number(mem.min) || memory.deriveMin(max))));
        await instances.update(instanceId, { memory: { override: true, min, max } });
        summary.memory = { min, max };
      }
      const preset = opts.jvmPreset === true ? rec?.jvmPreset : opts.jvmPreset;
      if (preset && PRESETS.includes(preset)) {
        await instances.update(instanceId, { java: { preset } });
        summary.jvmPreset = preset;
      }
      // 2) Mods (con dependencias)
      const mods = normalizeMods(opts.mods, rec);
      if (mods.length) {
        const r = await installer.installAll(instanceId, mods, task, { from: 0.05, to: 0.9 });
        Object.assign(summary, { installed: r.installed, skipped: r.skipped, failed: r.failed, warnings: r.warnings });
      }
      // 3) Opciones de video
      const patch = opts.options === true ? rec.options : sanitizeOptions(opts.options);
      if (patch && Object.keys(patch).length) {
        task.update({ detail: t('perf.taskOptions'), progress: 0.95 });
        const r = await options.merge(inst.dir, inst.mcVersion, patch);
        summary.options = r.changed;
      }
      if (summary.failed.length) task.update({ detail: t('perf.taskPartial', { count: summary.failed.length }) });
      return summary;
    },
    { instanceId },
  );
}

// ---------- Antes de cada partida ----------
function fmtGb(mb) {
  const gb = mb / 1024;
  return `${gb >= 10 || Number.isInteger(gb) ? Math.round(gb) : gb.toFixed(1)} GB`;
}

async function beforeLaunch({ instance, resolved, settings: s }) {
  const warnings = [];
  // Memoria automatica: si la instancia no tiene memoria propia, se calcula ahora
  // (RAM total, RAM libre y tamaño de la instancia). game.js usa settings.memory en ese caso.
  try {
    if (s && s.memoryMode !== 'manual' && !instance.memory?.override) {
      const totalMb = os.totalmem() / MB;
      const freeMb = os.freemem() / MB;
      const r = await memory.forInstance(instance, { totalMb, freeMb });
      s.memory = { min: r.min, max: r.max };
      if (r.lowFree) warnings.push(t('perf.warnLowFreeRam', { free: fmtGb(freeMb), need: fmtGb(Math.min(r.need, r.max)) }));
    }
  } catch (err) {
    console.warn('[perf] memoria automatica:', err.message);
  }
  // Java elegido a mano para la instancia: avisar si no sirve para esta version
  try {
    if (instance.java?.path) {
      const check = await java.checkJavaFor({
        javaPath: instance.java.path,
        requiredMajor: resolved?.javaVersion?.majorVersion,
        mcVersion: instance.mcVersion,
        loader: instance.loader,
      });
      if (check.problem) warnings.push(check.message);
    }
  } catch (err) {
    console.warn('[perf] chequeo de Java:', err.message);
  }
  return warnings.length ? { warnings } : null;
}

// Una sola vez: quien ya habia elegido su RAM a mano en la version anterior queda en modo manual.
async function migrateMemoryMode() {
  const raw = await readJson(paths.data('settings.json'), null);
  if (!raw || raw.memoryMode) return;
  const rec = settings.recommendedMemory();
  const custom = raw.memory && Number(raw.memory.max) > 0 && Number(raw.memory.max) !== rec.max;
  await settings.set(custom ? { memoryMode: 'manual', perf: { manualMax: Number(raw.memory.max) } } : { memoryMode: 'auto' });
}

function register({ app, handle }) {
  if (app?.getGPUInfo) system.setGpuProvider(() => app.getGPUInfo('complete'));

  handle('perf:system', () => system.get());
  handle('perf:benchmark', () => system.get({ rerun: true }));
  handle('perf:memoryPlan', (opts) => memoryPlan(opts || {}));
  handle('perf:recommend', (opts) => recommend.build(opts || {}));
  handle('perf:applyRecommended', (instanceId, opts) => applyRecommended(instanceId, opts || {}));
  handle('perf:readOptions', async (instanceId) => {
    const inst = await instances.get(instanceId);
    return options.read(inst.dir);
  });

  game.addBeforeLaunch(beforeLaunch);
  migrateMemoryMode().catch((err) => console.warn('[perf] migracion de memoria:', err.message));
}

module.exports = { register, memoryPlan, applyRecommended, beforeLaunch, recommend: recommend.build, system: system.get };
