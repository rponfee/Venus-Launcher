'use strict';
// Destino de una instalación (instancia o servidor): versión, loader, carpetas y registros de Modrinth.
const instances = require('../../core/instances');
const servers = require('../../core/servers');
const { t, getLanguage } = require('../../core/i18n');

const PLUGIN_LOADERS = ['paper', 'spigot', 'bukkit', 'purpur', 'folia', 'sponge'];
const PROXY_LOADERS = ['velocity', 'bungeecord', 'waterfall'];
const MOD_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt', 'liteloader', 'modloader', 'rift', 'legacy-fabric', 'babric', 'bta-babric', 'nilloader', 'ornithe', 'java-agent'];

const NAMES = {
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
  legacyfabric: 'Legacy Fabric',
  'legacy-fabric': 'Legacy Fabric',
  liteloader: 'LiteLoader',
  modloader: 'ModLoader',
  rift: 'Rift',
  bukkit: 'Bukkit',
  spigot: 'Spigot',
  paper: 'Paper',
  purpur: 'Purpur',
  folia: 'Folia',
  sponge: 'Sponge',
  velocity: 'Velocity',
  bungeecord: 'BungeeCord',
  waterfall: 'Waterfall',
  iris: 'Iris',
  optifine: 'OptiFine',
  canvas: 'Canvas',
  vanilla: 'Vanilla',
  minecraft: 'Minecraft',
  datapack: 'Data pack',
};

function loaderName(l) {
  return NAMES[l] || (l ? l.charAt(0).toUpperCase() + l.slice(1) : '?');
}

function joinList(items, type) {
  const list = [...new Set((items || []).filter(Boolean).map(String))];
  if (!list.length) return '';
  try {
    return new Intl.ListFormat(getLanguage(), { style: 'long', type }).format(list);
  } catch {
    return list.join(', ');
  }
}
const andList = (items) => joinList(items, 'conjunction');
const orList = (items) => joinList(items, 'disjunction');

function instanceModLoaders(inst) {
  switch (inst.loader) {
    case 'fabric':
      return ['fabric'];
    case 'legacyfabric':
      return ['legacy-fabric', 'fabric'];
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

function serverLoaders(s) {
  switch (s.type) {
    case 'paper':
      return ['paper', 'spigot', 'bukkit'];
    case 'purpur':
      return ['purpur', 'paper', 'spigot', 'bukkit'];
    case 'folia':
      return ['folia'];
    case 'spigot':
    case 'bukkit':
      return ['spigot', 'bukkit'];
    case 'fabric':
      return ['fabric'];
    case 'quilt':
      return ['quilt', 'fabric'];
    case 'forge':
      return ['forge'];
    case 'neoforge':
      return s.mcVersion === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge'];
    default:
      return [];
  }
}

function validId(id) {
  return typeof id === 'string' && /^[\w.-]{1,120}$/.test(id) && id !== '.' && id !== '..';
}

// desc = { kind: 'instance'|'server', id }
async function load(desc) {
  const kind = desc?.kind === 'server' ? 'server' : desc?.kind === 'instance' ? 'instance' : null;
  if (!kind || !validId(desc?.id)) throw new Error(t('compat.errTarget'));
  const id = desc.id;
  if (kind === 'server') {
    let s;
    try {
      s = await servers.get(id);
    } catch {
      throw new Error(t('compat.errNoServer'));
    }
    const modLoaders = serverLoaders(s);
    const pluginServer = modLoaders.some((l) => PLUGIN_LOADERS.includes(l));
    const folder = pluginServer ? 'plugins' : 'mods';
    return {
      kind,
      id,
      name: s.name || id,
      dir: s.dir,
      mcVersion: s.mcVersion,
      loader: s.type || 'vanilla',
      preset: null,
      side: 'server',
      records: s.modrinth?.projects || {},
      folders: modLoaders.length ? [folder] : [],
      contentFolder: folder,
      modLoaders,
      pluginServer,
    };
  }
  let inst;
  try {
    inst = await instances.get(id);
  } catch {
    throw new Error(t('compat.errNoInstance'));
  }
  return {
    kind,
    id,
    name: inst.name || id,
    dir: inst.dir || instances.dir(id),
    mcVersion: inst.mcVersion,
    loader: inst.loader || 'vanilla',
    preset: inst.preset || null,
    side: 'client',
    records: inst.modrinth?.projects || {},
    folders: ['mods', 'resourcepacks', 'shaderpacks'],
    contentFolder: 'mods',
    modLoaders: instanceModLoaders(inst),
    pluginServer: false,
  };
}

// Actualiza los registros de Modrinth del destino (projectId -> { title, file, versionId, ... }).
// Se lee y se escribe dentro de la cola del destino: otra instalacion o actualizacion en paralelo no se pierde.
async function updateRecords(target, mutate) {
  if (target.kind === 'instance') {
    await instances.update(target.id, (inst) => {
      const projects = { ...(inst.modrinth?.projects || {}) };
      mutate(projects);
      return { modrinth: { ...(inst.modrinth || {}), projects } };
    });
    return;
  }
  // servers.update solo acepta los campos que edita la interfaz: los internos (modrinth) van por patchMeta.
  if (typeof servers.patchMeta === 'function') {
    await servers.patchMeta(target.id, (s) => {
      const projects = { ...(s.modrinth?.projects || {}) };
      mutate(projects);
      return { ...s, modrinth: { ...(s.modrinth || {}), projects } };
    });
    return;
  }
  if (typeof servers.update !== 'function') return;
  const s = await servers.get(target.id);
  const projects = { ...(s.modrinth?.projects || {}) };
  mutate(projects);
  await servers.update(target.id, { modrinth: { ...(s.modrinth || {}), projects } });
}

// Carpeta donde va cada tipo de contenido
function folderFor(target, type) {
  if (type === 'resourcepack') return 'resourcepacks';
  if (type === 'shader') return 'shaderpacks';
  if (type === 'plugin') return 'plugins';
  if (type === 'mod') return target.pluginServer ? 'plugins' : 'mods';
  return null;
}

module.exports = { load, updateRecords, folderFor, loaderName, andList, orList, validId, instanceModLoaders, serverLoaders, PLUGIN_LOADERS, PROXY_LOADERS, MOD_LOADERS };
