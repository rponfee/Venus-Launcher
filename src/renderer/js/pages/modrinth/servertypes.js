// Tipos de servidor local y que contenido de Modrinth aceptan (logica pura, sin DOM).
// La lista real viene de servers:types (core/servers.js): { id, kind, plugins, mods, proxy,
// modrinth: { plugin: [loaders], mod: [loaders] } }. Si el canal no existe se usan los tipos de antes.

export const FALLBACK_SERVER_TYPES = [
  { id: 'paper', kind: 'plugins', plugins: true, mods: false, proxy: false, modrinth: { plugin: ['paper', 'spigot', 'bukkit'] } },
  { id: 'purpur', kind: 'plugins', plugins: true, mods: false, proxy: false, modrinth: { plugin: ['purpur', 'paper', 'spigot', 'bukkit'] } },
  { id: 'fabric', kind: 'mods', plugins: false, mods: true, proxy: false, modrinth: { mod: ['fabric'] } },
  { id: 'forge', kind: 'mods', plugins: false, mods: true, proxy: false, modrinth: { mod: ['forge'] } },
  { id: 'neoforge', kind: 'mods', plugins: false, mods: true, proxy: false, modrinth: { mod: ['neoforge'] } },
];

// Normaliza la respuesta de servers:types (ignora entradas raras); null si no sirve.
export function normalizeServerTypes(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const x of list) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id) continue;
    const m = x.modrinth && typeof x.modrinth === 'object' ? x.modrinth : {};
    const strs = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === 'string' && s) : []);
    const kind = typeof x.kind === 'string' ? x.kind : 'vanilla';
    out.push({
      id: x.id,
      kind,
      plugins: typeof x.plugins === 'boolean' ? x.plugins : ['plugins', 'hybrid', 'proxy'].includes(kind),
      mods: typeof x.mods === 'boolean' ? x.mods : ['mods', 'hybrid'].includes(kind),
      proxy: typeof x.proxy === 'boolean' ? x.proxy : kind === 'proxy',
      modrinth: { plugin: strs(m.plugin), mod: strs(m.mod) },
    });
  }
  return out.length ? out : null;
}

export function serverTypeInfo(types, type) {
  return (types || FALLBACK_SERVER_TYPES).find((x) => x.id === type) || null;
}

// Loaders de Modrinth que acepta un servidor. projectType: 'mod' | 'plugin' | otro (los dos).
// Un proyecto de tipo mod con versiones de plugin (por ejemplo Simple Voice Chat) se puede instalar en un
// servidor de plugins: para 'mod' en un servidor sin mods se devuelven los loaders de plugin.
export function serverLoadersOf(types, srv, projectType) {
  const info = serverTypeInfo(types, srv?.type);
  if (!info) return [];
  const mods = srv?.type === 'neoforge' && srv?.mcVersion === '1.20.1' ? ['neoforge', 'forge'] : info.modrinth?.mod || [];
  const plugins = info.modrinth?.plugin || [];
  if (projectType === 'plugin') return [...plugins];
  if (projectType === 'mod' && mods.length) return [...mods];
  if (projectType === 'mod') return [...plugins];
  return [...new Set([...mods, ...plugins])];
}

export const acceptsPlugins = (types, srv) => Boolean(serverTypeInfo(types, srv?.type)?.plugins);
export const acceptsMods = (types, srv) => Boolean(serverTypeInfo(types, srv?.type)?.mods);
export const isProxyType = (types, srv) => Boolean(serverTypeInfo(types, srv?.type)?.proxy);
