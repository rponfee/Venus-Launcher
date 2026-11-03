// Ajustes de decoración (settings.decor): valores por defecto, normalización, elección de partículas por
// temporada y tope de partículas por tamaño de ventana. Sin DOM ni Electron: se prueba con Node puro
// (test/settings.test.js).

export const PARTICLE_KINDS = ['none', 'snow', 'rain', 'leaves', 'embers', 'stars'];
export const DENSITIES = ['low', 'normal'];
export const SOUND_PACKS = ['soft', 'pixel', 'space'];
export const SPLASH_STYLES = ['logo', 'text', 'minimal'];
export const CURSORS = ['default', 'pixel', 'sword', 'pickaxe', 'diamond'];
export const SPLASH_TEXT_MAX = 24;

// Temporadas que manda window 'venus:season' ({ detail: { id } }) y las partículas que les corresponden.
export const SEASONS = ['halloween', 'christmas', 'newyear'];
export const SEASON_PARTICLES = { halloween: 'leaves', christmas: 'snow', newyear: 'embers' };

// Todo apagado por defecto (los sonidos también).
export const DECOR_DEFAULTS = {
  particles: 'none', // 'none' | 'snow' | 'rain' | 'leaves' | 'embers' | 'stars'
  density: 'normal', // 'low' | 'normal'
  seasonalParticles: false, // partículas acordes a la temporada (sin pisar la elección del usuario)
  sounds: { enabled: false, pack: 'soft', volume: 60 }, // pack: 'soft' | 'pixel' | 'space'; volume 0-100
  splash: { enabled: false, style: 'logo', text: '' }, // style: 'logo' | 'text' | 'minimal'; text hasta 24 caracteres
  cursor: 'default', // 'default' | 'pixel' | 'sword' | 'pickaxe' | 'diamond'
};

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function oneOf(v, list, def) {
  return list.includes(v) ? v : def;
}

function intIn(v, min, max, def) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

// Texto de la pantalla de inicio: una sola línea, sin caracteres de control, hasta SPLASH_TEXT_MAX.
export function cleanSplashText(v) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) {
    const code = ch.codePointAt(0);
    if (code < 32 || (code >= 127 && code < 160)) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, SPLASH_TEXT_MAX).trim();
}

export function normalizeDecor(raw = {}) {
  const r = isObj(raw) ? raw : {};
  const so = isObj(r.sounds) ? r.sounds : {};
  const sp = isObj(r.splash) ? r.splash : {};
  return {
    particles: oneOf(r.particles, PARTICLE_KINDS, DECOR_DEFAULTS.particles),
    density: oneOf(r.density, DENSITIES, DECOR_DEFAULTS.density),
    seasonalParticles: r.seasonalParticles === true,
    sounds: {
      enabled: so.enabled === true,
      pack: oneOf(so.pack, SOUND_PACKS, DECOR_DEFAULTS.sounds.pack),
      volume: intIn(so.volume, 0, 100, DECOR_DEFAULTS.sounds.volume),
    },
    splash: {
      enabled: sp.enabled === true,
      style: oneOf(sp.style, SPLASH_STYLES, DECOR_DEFAULTS.splash.style),
      text: cleanSplashText(sp.text),
    },
    cursor: oneOf(r.cursor, CURSORS, DECOR_DEFAULTS.cursor),
  };
}

// Mezcla profunda de parches de ajustes (objetos planos; los arrays y el resto se reemplazan).
export function mergeDecor(base, patch) {
  const out = isObj(base) ? { ...base } : {};
  if (!isObj(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? mergeDecor(out[k], v) : isObj(v) ? mergeDecor({}, v) : v;
  }
  return out;
}

// Id de temporada válido o null.
export function seasonId(v) {
  return typeof v === 'string' && SEASONS.includes(v) ? v : null;
}

// Partículas que corresponden a una temporada ('snow' en Navidad, 'leaves' en Halloween, 'embers' en Año Nuevo) o null.
export function seasonParticles(season) {
  const id = seasonId(season);
  return id ? SEASON_PARTICLES[id] : null;
}

// Partículas que se muestran: la temporada manda solo si el usuario activó las partículas de temporada; su
// elección (decor.particles) no se pisa nunca y vuelve sola cuando la temporada termina.
export function resolveParticles(decor, season) {
  const d = normalizeDecor(decor);
  const seasonal = d.seasonalParticles ? seasonParticles(season) : null;
  if (seasonal) return { kind: seasonal, seasonal: true, season: seasonId(season), choice: d.particles };
  return { kind: d.particles, seasonal: false, season: null, choice: d.particles };
}

// Cuántas partículas por tamaño de ventana (px de CSS): cada tipo tiene su peso y 'low' muestra la mitad.
const KIND_WEIGHT = { snow: 1, rain: 1.3, leaves: 0.3, embers: 0.45, stars: 0.5 };
export const PARTICLE_MAX = 220;
export const PARTICLE_MIN = 8;

export function particleBudget(width, height, kind, density = 'normal') {
  const w = Number(width);
  const h = Number(height);
  const weight = KIND_WEIGHT[kind];
  if (!weight || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0;
  const base = ((w * h) / 12000) * weight * (density === 'low' ? 0.5 : 1);
  return Math.max(PARTICLE_MIN, Math.min(PARTICLE_MAX, Math.round(base)));
}
