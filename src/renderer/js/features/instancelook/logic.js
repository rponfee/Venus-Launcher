// Aspecto por instancia y links: lógica pura (sin DOM ni Electron, con pruebas en test/logic.test.js).
// El aspecto de una instancia (inst.look en venus-instance.json) es { color?, background?, music? }:
//   color: { accent } | { accent: 'custom', customColor }          background: { type: 'stars' } | { type: 'wallpaper', id, dim, blur } | { type: 'image', file, dim, blur }
//   music: { type: 'off' } | { type: 'file', file, volume, pauseInGame }
// Lo que no está sigue como el launcher. mergeLook arma lo que se dibuja encima de los ajustes globales, sin tocarlos.
import { PRESETS, isHex, intIn, normalizeAppearance } from '../../a11y/appearance-logic.js';
import { getWallpaper } from '../../wallpapers.js';

const VIDEO = /\.(mp4|webm|m4v|ogv)$/i;

function cleanColor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.accent === 'custom') return isHex(raw.customColor) ? { accent: 'custom', customColor: String(raw.customColor).toLowerCase() } : null;
  return PRESETS.some((p) => p.id === raw.accent) ? { accent: raw.accent } : null;
}

function cleanBackground(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const shade = { dim: intIn(raw.dim, 0, 90, 45), blur: intIn(raw.blur, 0, 24, 0) };
  if (raw.type === 'stars') return { type: 'stars' };
  if (raw.type === 'wallpaper') return getWallpaper(raw.id) ? { type: 'wallpaper', id: raw.id, ...shade } : null;
  if (raw.type === 'image') return typeof raw.file === 'string' && raw.file ? { type: 'image', file: raw.file, ...shade } : null;
  return null;
}

function cleanMusic(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'off') return { type: 'off' };
  if (raw.type === 'file' && typeof raw.file === 'string' && raw.file) return { type: 'file', file: raw.file, volume: intIn(raw.volume, 0, 100, 35), pauseInGame: raw.pauseInGame !== false };
  return null;
}

// El aspecto guardado, limpio; null si no cambia nada.
export function normalizeLook(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  const color = cleanColor(raw.color);
  const background = cleanBackground(raw.background);
  const music = cleanMusic(raw.music);
  if (color) out.color = color;
  if (background) out.background = background;
  if (music) out.music = music;
  return Object.keys(out).length ? out : null;
}

// Parche de apariencia para dibujar ese aspecto. En el modo liviano no hay video propio ni desenfoque: sin esto
// se apagarían solo los fondos de la galería (los animados ya pasan a su miniatura en appearance.js).
export function lookPatch(rawLook, { lite = false } = {}) {
  const look = normalizeLook(rawLook);
  if (!look) return null;
  const patch = {};
  if (look.color) Object.assign(patch, look.color);
  const bg = look.background;
  if (bg?.type === 'stars') patch.background = 'stars';
  else if (bg?.type === 'wallpaper') Object.assign(patch, { background: 'wallpaper', wallpaperId: bg.id, bgDim: bg.dim, bgBlur: lite ? 0 : bg.blur });
  else if (bg?.type === 'image' && !(lite && VIDEO.test(bg.file))) Object.assign(patch, { background: 'image', bgFile: bg.file, bgDim: bg.dim, bgBlur: lite ? 0 : bg.blur });
  if (look.music?.type === 'off') patch.music = { enabled: false };
  else if (look.music?.type === 'file') patch.music = { enabled: true, file: look.music.file, volume: look.music.volume, pauseInGame: look.music.pauseInGame };
  return Object.keys(patch).length ? patch : null;
}

// Lo que se dibuja: la apariencia global con el parche encima, como copia. Sin parche devuelve la misma global.
// Un color de la instancia manda sobre el acento del editor de colores (si no, ese acento lo taparía).
export function mergeLook(appearance, patch) {
  if (!patch) return appearance;
  const { music, ...rest } = patch;
  const palette = rest.accent ? { ...appearance.palette, accent: null } : appearance.palette;
  return normalizeAppearance({ ...appearance, ...rest, palette, music: { ...appearance.music, ...(music || {}) } });
}

// De qué instancia es el aspecto que se ve: una que esté corriendo (la última que arrancó) y, si no, la seleccionada.
// Las partidas silenciosas (búsqueda del culpable de un crash) no cuentan.
export function pickLookInstance({ instances = [], running = {}, selectedId = null } = {}) {
  const withLook = (inst) => Boolean(inst && normalizeLook(inst.look));
  const live = Object.entries(running || {})
    .filter(([, r]) => r && !r.quiet && (r.state === 'running' || r.state === 'preparing'))
    .sort(([, a], [, b]) => (b.startedAt || 0) - (a.startedAt || 0))
    .map(([id]) => instances.find((i) => i.id === id))
    .find(withLook);
  if (live) return live;
  // Igual que store.selectedInstance(): sin una elegida, la primera de la lista.
  const selected = instances.find((i) => i.id === selectedId) || instances[0] || null;
  return withLook(selected) ? selected : null;
}

// Un look guardado (Mis looks) como aspecto de instancia: solo color, fondo y música.
export function lookFromSaved(saved) {
  const a = saved?.appearance;
  if (!a) return null;
  const color = a.accent === 'custom' ? { accent: 'custom', customColor: a.customColor } : { accent: a.accent };
  let background = { type: 'stars' };
  if (a.background === 'wallpaper') background = { type: 'wallpaper', id: a.wallpaperId, dim: a.bgDim, blur: a.bgBlur };
  else if (a.background === 'image' && a.bgFile) background = { type: 'image', file: a.bgFile, dim: a.bgDim, blur: a.bgBlur };
  const music = a.music?.enabled && a.music.file ? { type: 'file', file: a.music.file, volume: a.music.volume, pauseInGame: a.music.pauseInGame } : { type: 'off' };
  return normalizeLook({ color, background, music });
}

// Link para compartir: el modpack de origen si se conoce (anda en cualquier PC) o la instancia (solo en esta).
export function instanceLink(inst) {
  const mr = (inst?.pack && typeof inst.pack === 'object' ? inst.pack : null) || inst?.modrinth?.pack;
  if (mr?.projectId && /^[A-Za-z0-9]+$/.test(mr.projectId)) {
    const version = mr.versionId && /^[A-Za-z0-9]{4,16}$/.test(mr.versionId) ? `?version=${mr.versionId}` : '';
    return { kind: 'modpack', source: 'modrinth', link: `venus://modpack/modrinth/${mr.projectId}${version}` };
  }
  const cf = inst?.curseforge?.pack;
  if (Number.isInteger(Number(cf?.projectId)) && Number(cf.projectId) > 0) return { kind: 'modpack', source: 'curseforge', link: `venus://modpack/curseforge/${Number(cf.projectId)}` };
  return inst?.id ? { kind: 'instance', source: null, link: `venus://instance/${inst.id}` } : null;
}
