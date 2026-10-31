'use strict';
// Catalogo de packs de contenido verificados en Modrinth para cada version + loader:
// rendimiento, shaders, minimapa, calidad de vida, cliente PvP, joystick, chat de voz y multijugador.
const instances = require('../core/instances');
const tasks = require('../core/tasks');
const game = require('../core/game');
const { t } = require('../core/i18n');
const availability = require('./perf/availability');
const installer = require('./perf/installer');
const recommend = require('./perf/recommend');
const mcver = require('./perf/mcver');

const SHADER_PACKS = ['complementary-reimagined', 'bsl-shaders', 'makeup-ultra-fast-shaders'];

const g = (key, candidates, extra = {}) => ({ key, candidates: [].concat(candidates), type: 'mod', ...extra });

// Mod que permite usar shaders segun el loader (null = no hay forma de cargarlos)
function shaderGroups({ loader, mcVersion }) {
  const packs = SHADER_PACKS.map((s) => g(s, s, { type: 'shader' }));
  if (loader === 'fabric' || loader === 'quilt') return [g('iris', 'iris'), ...packs];
  if (loader === 'neoforge') {
    if (mcver.atLeast(mcVersion, '1.21')) return [g('iris', 'iris'), ...packs];
    return [g('renderer', 'embeddium'), g('oculus', 'oculus'), ...packs];
  }
  if (loader === 'forge') return [g('renderer', 'embeddium'), g('oculus', 'oculus'), ...packs];
  if (loader === 'optifine') return packs; // OptiFine ya trae soporte de shaders
  return [g('iris', 'iris'), ...packs];
}

function qolGroups({ loader }) {
  const fabricLike = loader === 'fabric' || loader === 'quilt';
  return [
    ...(fabricLike ? [g('modmenu', 'modmenu')] : []),
    g('recipes', fabricLike ? ['emi', 'jei'] : ['jei', 'emi']),
    g('jade', 'jade'),
    g('appleskin', 'appleskin'),
    g('mouse-tweaks', 'mouse-tweaks'),
  ];
}

function pvpGroups() {
  return [
    g('zoom', ['zoomify', 'ok-zoomer']),
    g('hud', 'evergreenhud'),
    g('keystrokes', 'clean-keystrokes', { unless: 'hud' }),
    g('cps', ['cps-plus', 'cpsdisplay'], { unless: 'hud' }),
    g('fps', ['fpsdisplay', 'customizable-fps-display', 'custom-fps-display'], { unless: 'hud' }),
    g('coordinates', 'coordinates-display'),
    g('betterf3', 'betterf3'),
  ];
}

const PACKS = [
  { id: 'performance', icon: 'zap', groups: (ctx) => recommend.perfGroups({ ...ctx, lowEnd: false }) },
  { id: 'shaders', icon: 'sun', groups: shaderGroups },
  { id: 'minimap', icon: 'map', groups: () => [g('minimap', ['xaeros-minimap', 'journeymap'])] },
  { id: 'qol', icon: 'sparkles', groups: qolGroups },
  { id: 'pvp-hud', icon: 'swords', groups: pvpGroups },
  { id: 'controller', icon: 'gamepad', groups: () => [g('controller', ['controlify', 'controllermod'])] },
  { id: 'voice', icon: 'mic', groups: () => [g('voice', 'simple-voice-chat')] },
  { id: 'multiplayer', icon: 'wifi', groups: () => [g('e4mc', 'e4mc')] },
];

const memo = new Map(); // `${mc}|${loader}` -> { at, packs }
const MEMO_TTL = 10 * 60 * 1000;

// catalog:packs({ mcVersion, loader, preset?, instanceId? })
async function packs(opts = {}) {
  let { mcVersion, loader, preset } = opts;
  let inst = null;
  if (opts.instanceId) {
    inst = await instances.get(opts.instanceId);
    mcVersion = inst.mcVersion;
    loader = inst.loader;
    preset = inst.preset;
  }
  if (!mcVersion) throw new Error(t('catalog.errNoVersion'));
  loader = loader || 'vanilla';
  const key = `${mcVersion}|${loader}|${preset || ''}`;
  let base = memo.get(key);
  if (!base || Date.now() - base.at > MEMO_TTL) {
    base = { at: Date.now(), packs: await buildPacks({ mcVersion, loader, preset }) };
    memo.set(key, base);
  }
  const info = inst ? await recommend.installedInfo(inst) : null;
  return base.packs.map((p) => ({
    ...p,
    items: p.items.map((it) => ({ ...it, installed: info ? recommend.isInstalled(it, info) : false })),
  }));
}

async function buildPacks({ mcVersion, loader, preset }) {
  const ctx = { mcVersion, loader, preset };
  const modLoaders = availability.loadersFor({ mcVersion, loader, preset }).mod;
  const hasModLoader = modLoaders.length > 0;
  // Todos los grupos de todos los packs se resuelven juntos (un solo pedido en lote de proyectos)
  const all = PACKS.map((p) => ({ pack: p, groups: p.groups(ctx).map((gr) => ({ ...gr, key: `${p.id}:${gr.key}`, unless: gr.unless ? `${p.id}:${gr.unless}` : undefined })) }));
  const groups = all.flatMap((x) => x.groups);
  let resolved = [];
  let error = null;
  if (groups.length) {
    const shader = loader === 'optifine' ? ['optifine'] : ['iris'];
    try {
      resolved = await availability.resolveGroups(groups, { mcVersion, loaders: { mod: modLoaders, shader } });
    } catch (err) {
      error = err;
    }
  }
  if (error) throw new Error(t('catalog.errModrinth', { error: error.message }));
  const byKey = new Map(resolved.map((r) => [r.key, r]));
  return all.map(({ pack, groups: gs }) => {
    let items = gs.map((gr) => byKey.get(gr.key)).filter(Boolean).map(({ key, ...it }) => ({ ...it, key: key.slice(pack.id.length + 1) }));
    // Shaders: sin el mod que los carga, los packs de shaders no sirven
    if (pack.id === 'shaders' && loader !== 'optifine' && !items.some((i) => i.type === 'mod' && (i.slug === 'iris' || i.slug === 'oculus') && i.available)) {
      items = items.map((i) => ({ ...i, available: false }));
    }
    const available = items.filter((i) => i.available).length;
    let note = null;
    if (!hasModLoader && pack.id !== 'shaders') note = t('catalog.noteNeedsLoader');
    else if (pack.id === 'shaders' && !available) note = t(loader === 'vanilla' ? 'catalog.noteShadersVanilla' : 'catalog.noteUnavailable');
    else if (!available) note = t('catalog.noteUnavailable');
    else if (pack.id === 'voice') note = t('catalog.noteVoiceServer');
    else if (pack.id === 'multiplayer') note = t('catalog.noteE4mc');
    return {
      id: pack.id,
      title: t(`catalog.pack_${pack.id}`),
      description: t(`catalog.pack_${pack.id}_desc`),
      icon: pack.icon,
      items,
      available,
      note,
    };
  });
}

// catalog:installPacks(instanceId, packIds) -> tarea; omite lo no disponible y resuelve dependencias.
async function installPacks(instanceId, packIds) {
  const ids = [].concat(packIds || []).filter((x) => typeof x === 'string');
  if (!instanceId) throw new Error(t('catalog.errNoInstance'));
  const inst = await instances.get(instanceId);
  if (game.status()[instanceId]) throw new Error(t('catalog.errRunning', { name: inst.name }));
  const list = await packs({ instanceId });
  const chosen = list.filter((p) => ids.includes(p.id));
  if (!chosen.length) throw new Error(t('catalog.errNoPacks'));
  return tasks.run(
    t('catalog.taskInstall', { name: inst.name }),
    async (task) => {
      const items = [];
      const seen = new Set();
      const unavailable = [];
      for (const p of chosen) {
        for (const it of p.items) {
          if (!it.available || !it.projectId) {
            unavailable.push(it.title);
            continue;
          }
          if (seen.has(it.projectId) || it.installed) continue;
          seen.add(it.projectId);
          items.push(it);
        }
      }
      // Mods primero (Iris/Oculus antes que los packs de shaders)
      items.sort((a, b) => Number(a.type === 'shader') - Number(b.type === 'shader'));
      const r = await installer.installAll(instanceId, items, task, { from: 0.02, to: 1 });
      if (r.failed.length) task.update({ detail: t('catalog.taskPartial', { count: r.failed.length }) });
      return { ...r, unavailable, packs: chosen.map((p) => p.id) };
    },
    { instanceId },
  );
}

function register({ handle }) {
  handle('catalog:packs', (opts) => packs(opts || {}));
  handle('catalog:installPacks', (instanceId, packIds) => installPacks(instanceId, packIds));
}

module.exports = { register, packs, installPacks, PACKS };
