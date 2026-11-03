// Motor visual compartido por Apariencia (color de acento, paleta propia y tema claro) y Accesibilidad
// (daltonismo y alto contraste). Calcula las variables de color de :root y transforma los colores fijos de
// todas las hojas de estilo (restyle.js). Cada color de la interfaz se clasifica una sola vez segun el tema
// original (oscuro):
//   accent  -> familia naranja/oro de Venus (se re-ancla al acento elegido)
//   neutral -> fondos, bordes y textos calidos (se tiñen con el tono del acento; con el tema claro o una
//              paleta propia se re-anclan entre el fondo y el texto nuevos)
//   good / warn / bad / info -> estados (se cambian por paletas distinguibles en los modos de daltonismo)
import * as C from './color.js';
import { setMapper, mapValue } from './restyle.js';

// Variables de color del tema original (respaldo si no se puede leer main.css)
const FALLBACK_VARS = {
  '--bg-0': '#0c0705',
  '--bg-1': '#120b08',
  '--surface': '#1b130e',
  '--surface-2': '#231912',
  '--surface-3': '#2c2017',
  '--surface-4': '#382a1e',
  '--border': 'rgba(255, 196, 120, 0.09)',
  '--border-2': 'rgba(255, 196, 120, 0.18)',
  '--border-3': 'rgba(255, 196, 120, 0.32)',
  '--text': '#fff3e3',
  '--text-2': '#d4bfa8',
  '--muted': '#ad9781',
  '--faint': '#9b8773',
  '--accent': '#f29a2e',
  '--accent-hi': '#ffc562',
  '--accent-lo': '#d9761c',
  '--accent-deep': '#9b4512',
  '--accent-ink': '#2b1405',
  '--accent-wash': 'rgba(242, 154, 46, 0.12)',
  '--accent-glow': 'rgba(242, 154, 46, 0.35)',
  '--cream': '#ffe6b0',
  '--good': '#36c25a',
  '--good-wash': 'rgba(54, 194, 90, 0.13)',
  '--warn': '#fab219',
  '--warn-wash': 'rgba(250, 178, 25, 0.13)',
  '--bad': '#e5544b',
  '--bad-wash': 'rgba(229, 84, 75, 0.13)',
  '--info': '#5aa7f0',
};

// Tema claro (html[data-scheme="light"]): los mismos valores que la regla de styles/a11y.css, que es la que
// pinta; estos son la base sobre la que se calcula el acento, la paleta propia, el daltonismo y el alto
// contraste (la prueba a11y/test/light-palette.test.js verifica que las dos copias coincidan y el contraste).
export const LIGHT_VARS = {
  '--bg-0': '#f4ece2',
  '--bg-1': '#faf5ee',
  '--surface': '#fffaf3',
  '--surface-2': '#f7eee2',
  '--surface-3': '#eee2d2',
  '--surface-4': '#e2d2bd',
  '--surface-raised': '#fffdf9',
  '--card-bg': 'linear-gradient(180deg, rgba(255, 252, 247, 0.9), rgba(255, 248, 240, 0.9))',
  '--card-bg-flat': 'rgba(255, 250, 243, 0.85)',
  '--field-bg': 'rgba(255, 255, 255, 0.72)',
  '--well-bg': 'rgba(120, 82, 44, 0.07)',
  '--hover-bg': 'rgba(120, 82, 44, 0.08)',
  '--scrim': 'rgba(64, 42, 24, 0.5)',
  '--border': 'rgba(94, 58, 22, 0.13)',
  '--border-2': 'rgba(94, 58, 22, 0.22)',
  '--border-3': 'rgba(94, 58, 22, 0.36)',
  '--text': '#2b1d12',
  '--text-2': '#4e3a2a',
  '--muted': '#6e5945',
  '--faint': '#86715c',
  '--accent': '#e8891c',
  '--accent-hi': '#9a4e08',
  '--accent-lo': '#c96f10',
  '--accent-deep': '#8a4210',
  '--accent-ink': '#2b1405',
  '--accent-wash': 'rgba(232, 137, 28, 0.14)',
  '--accent-line': 'rgba(232, 137, 28, 0.45)',
  '--accent-glow': 'rgba(232, 137, 28, 0.28)',
  '--cream': '#6e3808',
  '--good': '#1f9a45',
  '--good-wash': 'rgba(31, 154, 69, 0.12)',
  '--good-line': 'rgba(31, 154, 69, 0.4)',
  '--good-text': '#176b32',
  '--warn': '#c98400',
  '--warn-wash': 'rgba(201, 132, 0, 0.14)',
  '--warn-line': 'rgba(201, 132, 0, 0.45)',
  '--warn-text': '#7a5000',
  '--bad': '#d23b32',
  '--bad-wash': 'rgba(210, 59, 50, 0.1)',
  '--bad-line': 'rgba(210, 59, 50, 0.4)',
  '--bad-text': '#a0281f',
  '--info': '#2b7fd0',
  '--info-wash': 'rgba(43, 127, 208, 0.1)',
  '--info-line': 'rgba(43, 127, 208, 0.4)',
  '--info-text': '#1c5d9c',
  '--shadow': '0 10px 30px rgba(70, 45, 20, 0.16)',
  '--shadow-s': '0 4px 14px rgba(70, 45, 20, 0.12)',
  '--focus-ring-color': '#c96f10',
};

export const BASE_ACCENT = '#f29a2e';
const BASE_LCH = C.toOklch(C.parseColor(BASE_ACCENT));
const LIGHT_LCH = C.toOklch(C.parseColor(LIGHT_VARS['--accent']));
// Extremos del tema original entre los que se ubica cada neutro fijo (fondo mas oscuro y texto principal)
const DARK_BG_LCH = C.toOklch(C.parseColor(FALLBACK_VARS['--bg-0']));
const DARK_TEXT_LCH = C.toOklch(C.parseColor(FALLBACK_VARS['--text']));
// Brillo legible del acento: sobre fondo oscuro tiene que ser claro; sobre fondo claro, medio (los textos
// de acento salen mas oscuros por proporcion)
const ACCENT_RANGE = { dark: [0.62, 0.9], light: [0.55, 0.75] };

// Amarillos de "aviso" con un tono casi igual al dorado del acento: se reconocen por valor exacto.
const WARN_SET = new Set(['#fab219', '#ffd36b', '#ffd98a', '#ffe2a3', '#c98f12']);
// Colores de marca (Modrinth, CurseForge) que no cambian con los temas ni los modos de daltonismo
const BRAND_SET = new Set(['#1bd96a', '#6ff0a6', '#0b7a3b', '#04210f', '#7df0ac', '#f16436']);

const STATUS_BASE = { good: '#36c25a', warn: '#fab219', bad: '#e5544b', info: '#5aa7f0' };
// Paletas distinguibles (Okabe-Ito para protanopia/deuteranopia; rojo/cian para tritanopia),
// verificadas con la simulacion de Machado et al. (2009) sobre fondo oscuro.
export const CVD_PALETTES = {
  protanopia: { good: '#56b4e9', warn: '#f0e442', bad: '#d55e00', info: '#cc79a7' },
  deuteranopia: { good: '#56b4e9', warn: '#f0e442', bad: '#d55e00', info: '#cc79a7' },
  tritanopia: { good: '#33c8e8', warn: '#ffd166', bad: '#ff4d6d', info: '#c39bff' },
};

// Simulacion de Machado et al. 2009 (severidad 1, en RGB lineal) y matriz para "devolver" el error
// a los canales visibles (daltonizacion). Resultado: M = I + k * SHIFT * (I - SIM)
const SIM = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const SHIFT = {
  protanopia: [[0, 0, 0], [0.7, 1, 0], [0.7, 0, 1]],
  deuteranopia: [[0, 0, 0], [0.7, 1, 0], [0.7, 0, 1]],
  tritanopia: [[1, 0, 0.7], [0, 1, 0.7], [0, 0, 0]],
};

const VAR_ROLES = {
  '--text': 'text',
  '--text-2': 'text',
  '--muted': 'text',
  '--faint': 'text',
  '--cream': 'text',
  '--accent-ink': 'text',
  '--border': 'border',
  '--border-2': 'border',
  '--border-3': 'border',
  '--bg-0': 'bg',
  '--bg-1': 'bg',
  '--surface': 'bg',
  '--surface-2': 'bg',
  '--surface-3': 'bg',
  '--surface-4': 'bg',
  '--accent-wash': 'bg',
  '--good-wash': 'bg',
  '--warn-wash': 'bg',
  '--bad-wash': 'bg',
  '--modrinth-wash': 'bg',
};

const COLOR_RE = /url\((?:[^()"']|"[^"]*"|'[^']*')*\)|(#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\))/g;

const state = {
  theme: null, // { scheme, accent: { target, hueK, neutralScale } | null, tint, palette, neutral }
  cvd: 'none',
  cvdStrength: 0.5,
  hc: false,
  shapes: false,
};
let statusLch = null; // { good: {base, target}, ... } segun el modo de daltonismo
let baseVars = null;
let managed = new Set();
const classCache = new Map();
let scheduled = false;
let dirty = true; // hay que regenerar variables y hojas espejo (no solo el filtro o las clases)
let themeKey = '';
const listeners = new Set();

// ---------- API ----------

// theme: { accent: '#rrggbb' | null, tint: true, scheme: 'dark' | 'light', palette: { bg, surface, text, border, accent } }
// o null para el tema original de Venus. accent null (o el de Venus) = sin cambiar la familia naranja/oro.
// palette: colores en hex o null (null = el del esquema); el texto tiene que llegar ya legible (appearance.js).
export function setTheme(theme) {
  const next = theme ? prepareTheme(theme) : null;
  const key = next ? JSON.stringify([next.scheme, next.accent?.target, next.tint, next.palette]) : '';
  if (key !== themeKey) {
    themeKey = key;
    state.theme = next;
    dirty = true;
  }
  schedule();
}

// { cvd: 'none'|'protanopia'|'deuteranopia'|'tritanopia', cvdStrength: 0..1, hc: bool, shapes: bool }
export function setVision(v = {}) {
  const before = `${state.cvd}|${state.hc}`;
  if (v.cvd !== undefined) state.cvd = SIM[v.cvd] ? v.cvd : 'none';
  if (v.cvdStrength !== undefined) state.cvdStrength = C.clamp(Number(v.cvdStrength) || 0);
  if (v.hc !== undefined) state.hc = Boolean(v.hc);
  if (v.shapes !== undefined) state.shapes = Boolean(v.shapes);
  if (`${state.cvd}|${state.hc}` !== before) {
    statusLch = state.cvd === 'none' ? null : buildStatus(CVD_PALETTES[state.cvd]);
    dirty = true;
  }
  schedule();
}

export function onApply(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Acento ajustado para que se lea bien sobre el fondo (lo que realmente se aplica): claro sobre el tema
// oscuro, medio sobre el tema claro (light = true)
export function legibleAccent(hex, light = false) {
  const c = C.parseColor(hex);
  if (!c) return light ? LIGHT_VARS['--accent'] : BASE_ACCENT;
  const lch = C.toOklch(c);
  const [lo, hi] = ACCENT_RANGE[light ? 'light' : 'dark'];
  const l = C.clamp(lch.l, lo, hi);
  return l === lch.l ? C.toHex(c) : C.toHex(C.fromOklch({ ...lch, l }));
}

// Esquema que esta aplicando el motor ('dark' | 'light')
export function currentScheme() {
  return state.theme?.scheme || 'dark';
}

// Variables de color base de un esquema (copia): para mostrar los valores "de Venus" en el editor
export function baseTokens(scheme = currentScheme()) {
  return { ...readBaseVars(scheme) };
}

// Aplica ya (sin esperar al siguiente cuadro): util al iniciar para evitar un parpadeo
export function applyNow() {
  scheduled = false;
  apply();
}

// ---------- Preparacion ----------
function prepareTheme(theme) {
  const scheme = theme.scheme === 'light' ? 'light' : 'dark';
  const palette = cleanPalette(theme.palette);
  const accentHex = palette?.accent || (C.isHexColor(theme.accent) ? theme.accent : null);
  let accent = null;
  if (accentHex && accentHex.toLowerCase() !== BASE_ACCENT) {
    const lch = C.toOklch(C.parseColor(accentHex));
    const [lo, hi] = ACCENT_RANGE[scheme];
    lch.l = C.clamp(lch.l, lo, hi);
    // Las luces del tema original "giran" hacia el amarillo y las sombras hacia el rojo (pixel art).
    // Con otros tonos se gira hacia el lado mas corto al amarillo, un poco mas suave.
    const toYellow = C.hueDelta(lch.h, 100);
    const dir = toYellow >= 0 ? 1 : -1;
    const hueK = lch.c < 0.03 ? 0 : (Math.abs(toYellow) < 60 ? 1 : 0.6) * dir;
    const neutralScale = C.clamp(lch.c / BASE_LCH.c, 0, 1.15);
    accent = { target: lch, hueK, neutralScale };
  }
  const base = readBaseVars(scheme);
  // Los neutros fijos de las hojas (pensados para el tema oscuro) se ubican entre el fondo y el texto nuevos
  let neutral = null;
  if (scheme === 'light' || palette?.bg || palette?.text || palette?.surface) {
    const toBg = C.toOklch(C.parseColor(palette?.bg || base['--bg-0']));
    const toText = C.toOklch(C.parseColor(palette?.text || base['--text']));
    neutral = { toBg, toText };
  }
  return { scheme, accent, tint: theme.tint !== false, palette, neutral };
}

function cleanPalette(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  let any = false;
  for (const k of ['bg', 'surface', 'text', 'border', 'accent']) {
    out[k] = C.isHexColor(p[k]) ? String(p[k]).toLowerCase() : null;
    if (out[k]) any = true;
  }
  return any ? out : null;
}

function buildStatus(pal) {
  const out = {};
  for (const k of Object.keys(STATUS_BASE)) out[k] = { base: C.toOklch(C.parseColor(STATUS_BASE[k])), target: C.toOklch(C.parseColor(pal[k])) };
  return out;
}

function readDarkVars() {
  if (baseVars) return baseVars;
  const out = { ...FALLBACK_VARS };
  try {
    const sheet = [...document.styleSheets].find((s) => /styles\/main\.css$/.test(s.href || ''));
    const root = sheet && [...sheet.cssRules].find((r) => r.selectorText === ':root');
    if (root) {
      for (let i = 0; i < root.style.length; i++) {
        const name = root.style[i];
        if (!name.startsWith('--')) continue;
        const v = root.style.getPropertyValue(name).trim();
        if (/#|rgb/i.test(v)) out[name] = v;
      }
      baseVars = out;
    }
  } catch {
    /* se usa el respaldo */
  }
  return out;
}

// Base de cada esquema: el oscuro sale de main.css; el claro son LIGHT_VARS sobre esa base (lo que el
// claro no redefine queda como en el oscuro).
function readBaseVars(scheme) {
  const dark = readDarkVars();
  return scheme === 'light' ? { ...dark, ...LIGHT_VARS } : dark;
}

// ---------- Paleta propia: variables derivadas de los colores elegidos ----------
const hex = (c) => C.toHex(c);
const alpha = (c, a) => C.rgba(c, a);
function stepL(c, d) {
  const s = C.toOklch(c);
  return C.fromOklch({ l: C.clamp(s.l + d), c: s.c, h: s.h });
}
function mixOk(a, b, t) {
  const x = C.toOklch(a);
  const y = C.toOklch(b);
  return C.fromOklch({ l: x.l + (y.l - x.l) * t, c: x.c + (y.c - x.c) * t, h: x.h + C.hueDelta(x.h, y.h) * t });
}

function paletteVars(p, base) {
  const out = {};
  const bg = C.parseColor(p.bg || base['--bg-0']);
  const surface = C.parseColor(p.surface || base['--surface']);
  const text = C.parseColor(p.text || base['--text']);
  const dir = C.toOklch(text).l >= C.toOklch(surface).l ? 1 : -1; // hacia donde "suben" las superficies
  if (p.bg) {
    out['--bg-0'] = hex(bg);
    out['--bg-1'] = hex(stepL(bg, dir * 0.03));
    out['--field-bg'] = alpha(bg, 0.6);
    out['--well-bg'] = alpha(bg, 0.5);
    out['--scrim'] = alpha(bg, 0.66);
  }
  if (p.surface) {
    const s2 = stepL(surface, dir * 0.04);
    out['--surface'] = hex(surface);
    out['--surface-2'] = hex(s2);
    out['--surface-3'] = hex(stepL(surface, dir * 0.08));
    out['--surface-4'] = hex(stepL(surface, dir * 0.13));
    out['--surface-raised'] = hex(stepL(surface, dir * 0.05));
    out['--card-bg'] = `linear-gradient(180deg, ${alpha(s2, 0.82)}, ${alpha(surface, 0.82)})`;
    out['--card-bg-flat'] = alpha(surface, 0.7);
  }
  if (p.text) {
    out['--text'] = hex(text);
    out['--text-2'] = hex(mixOk(text, surface, 0.18));
    out['--muted'] = hex(mixOk(text, surface, 0.36));
    out['--faint'] = hex(mixOk(text, surface, 0.46));
    out['--hover-bg'] = alpha(text, 0.06);
    const accent = C.parseColor(p.accent || base['--accent']);
    out['--cream'] = hex(mixOk(text, accent, 0.3));
  }
  if (p.border) {
    const b = C.parseColor(p.border);
    out['--border'] = alpha(b, 0.14);
    out['--border-2'] = alpha(b, 0.26);
    out['--border-3'] = alpha(b, 0.42);
  }
  return out;
}

// ---------- Clasificacion ----------
function classify(c) {
  const key = (Math.round(c.r) << 16) | (Math.round(c.g) << 8) | Math.round(c.b);
  let cls = classCache.get(key);
  if (cls !== undefined) return cls;
  cls = computeClass(c);
  if (classCache.size > 5000) classCache.clear();
  classCache.set(key, cls);
  return cls;
}

function computeClass(c) {
  const hx = C.toHex(c);
  if (WARN_SET.has(hx)) return 'warn';
  if (BRAND_SET.has(hx)) return null;
  const { l, c: ch, h } = C.toOklch(c);
  if (ch < 0.004) return null; // grises puros
  if (ch >= 0.05) {
    if (h >= 125 && h <= 168) return 'good';
    if (h >= 14 && h <= 33) return 'bad';
    if (h >= 235 && h <= 268) return 'info';
  }
  if (h >= 45.5 && h <= 90 && ch >= 0.045) return 'accent';
  if (h >= 28 && h <= 100 && ch < 0.045) return 'neutral';
  if (h >= 30 && h <= 70 && l < 0.3 && ch < 0.07) return 'neutral';
  return null;
}

// ---------- Transformaciones ----------
// Re-ancla un color relativo a "base" sobre "target" (mismo salto de brillo, croma proporcional)
function reanchor(s, base, target, hueK, alpha) {
  const l = s.l >= base.l ? target.l + ((s.l - base.l) * (1 - target.l)) / Math.max(0.0001, 1 - base.l) : target.l * (s.l / Math.max(0.0001, base.l));
  const chroma = base.c > 0 ? s.c * (target.c / base.c) : target.c;
  const h = target.h + C.hueDelta(base.h, s.h) * hueK;
  return C.fromOklch({ l, c: chroma, h }, alpha);
}

// Tinte de los neutros: mismo brillo, tono del acento, croma segun lo saturado del acento
function tintColor(c, s) {
  const a = state.theme.accent;
  const h = a.target.h + C.hueDelta(BASE_LCH.h, s.h) * a.hueK * 0.5;
  return C.fromOklch({ l: s.l, c: s.c * a.neutralScale, h }, c.a);
}

// Un neutro pensado para el tema oscuro, ubicado entre el fondo y el texto nuevos (tema claro o paleta propia)
function neutralColor(c, s) {
  const { toBg, toText } = state.theme.neutral;
  const t = C.clamp((s.l - DARK_BG_LCH.l) / (DARK_TEXT_LCH.l - DARK_BG_LCH.l), -0.1, 1.1);
  const k = C.clamp(t);
  const l = toBg.l + (toText.l - toBg.l) * t;
  const chroma = toBg.c + (toText.c - toBg.c) * k;
  const h = toBg.h + C.hueDelta(toBg.h, toText.h) * k;
  return C.fromOklch({ l: C.clamp(l), c: chroma, h }, c.a);
}

function statusColor(c, cls) {
  const st = statusLch[cls];
  return reanchor(C.toOklch(c), st.base, st.target, 1, c.a);
}

function roleOf(prop) {
  if (!prop) return 'other';
  if (prop.startsWith('--')) {
    if (VAR_ROLES[prop]) return VAR_ROLES[prop];
    if (/border|line|ring|outline|stroke/.test(prop)) return 'border';
    if (/text|fg|ink|muted|faint|label|title/.test(prop)) return 'text';
    if (/bg|surface|wash|back|panel|card/.test(prop)) return 'bg';
    return 'other';
  }
  const p = prop.replace(/^-webkit-/, '');
  if (p === 'color' || p === 'text-fill-color' || p === 'caret-color' || p === 'fill' || p === 'stroke' || p.startsWith('text-decoration') || p.startsWith('text-emphasis')) return 'text';
  if (p.startsWith('border') || p.startsWith('outline') || p.startsWith('column-rule')) return 'border';
  if (p.startsWith('background')) return 'bg';
  return 'other';
}

// Colores de acento y de estado fijos en las hojas (pensados para fondo oscuro) sobre el tema claro:
// los textos y bordes se oscurecen para que se lean; los fondos traslucidos quedan como estan.
function lightLegible(c, ctx) {
  const role = roleOf(ctx?.prop);
  const a = c.a ?? 1;
  const s = C.toOklch(c);
  if (role === 'text') {
    if (s.l <= 0.52) return c;
    return C.fromOklch({ l: 0.46, c: Math.min(s.c, 0.16), h: s.h }, a);
  }
  if (role === 'border') {
    if (s.l <= 0.6) return c;
    return C.fromOklch({ l: 0.58, c: Math.min(s.c, 0.16), h: s.h }, a < 1 ? Math.min(1, a * 1.6) : 1);
  }
  if (role === 'other' && a >= 1 && !ctx?.gradient && s.l > 0.7) {
    // iconos y detalles con color pleno: un poco mas oscuros, sin llegar a texto
    return C.fromOklch({ l: 0.62, c: s.c, h: s.h }, a);
  }
  return c;
}

function contrastColor(c, ctx) {
  const role = roleOf(ctx?.prop);
  const a = c.a ?? 1;
  const light = state.theme?.scheme === 'light';
  if (role === 'text') {
    const s = C.toOklch(c);
    let l;
    if (light) {
      // sobre fondo claro: textos oscuros aun mas oscuros, grises mas oscuros, colores un poco mas oscuros
      l = s.l < 0.3 ? s.l * 0.7 : s.c < 0.06 ? s.l * 0.6 : Math.min(s.l, Math.max(0.3, s.l - 0.07));
    } else {
      // texto oscuro (sobre botones de color) mas oscuro; texto gris mas claro; texto de color un poco mas claro sin perder el tono
      l = s.l < 0.3 ? s.l * 0.55 : s.c < 0.06 ? 1 - (1 - s.l) * 0.4 : Math.max(s.l, Math.min(0.93, s.l + 0.07));
    }
    return C.fromOklch({ l, c: s.c, h: s.h }, a < 1 ? Math.max(a, 0.9) : 1);
  }
  if (role === 'border') {
    const s = C.toOklch(c);
    const l = light ? (s.l > 0.5 ? Math.max(0, s.l - 0.2) : s.l) : s.l < 0.5 ? Math.min(1, s.l + 0.2) : s.l;
    return C.fromOklch({ l, c: s.c, h: s.h }, a < 1 ? Math.min(1, a * 2.6 + 0.14) : 1);
  }
  if (role === 'bg' && !ctx?.gradient && a < 1) {
    const { l } = C.toOklch(c);
    if (light) {
      if (l > 0.68 && a > 0.3) return { ...c, a: Math.max(a, 0.96) }; // superficies traslucidas -> opacas
      if (l < 0.45 && a < 0.25) return { ...c, a: Math.min(0.45, a * 2) }; // resaltados mas visibles
    } else {
      if (l < 0.32 && a > 0.3) return { ...c, a: Math.max(a, 0.96) }; // superficies traslucidas -> opacas
      if (l > 0.55 && a < 0.25) return { ...c, a: Math.min(0.45, a * 2) }; // resaltados (hover, wash) mas visibles
    }
  }
  return c;
}

// ctx.token: el color es una variable base del esquema (ya expresada en los colores finales): no se re-ancla
// entre fondo y texto ni se corrige para el tema claro, solo se tiñe o cambia de acento.
function mapColor(c, ctx) {
  const cls = classify(c);
  const th = state.theme;
  let out = c;
  if (th) {
    if (cls === 'accent') {
      if (th.accent) out = reanchor(C.toOklch(out), ctx?.token && th.scheme === 'light' ? LIGHT_LCH : BASE_LCH, th.accent.target, th.accent.hueK, c.a);
    } else if (cls === 'neutral') {
      const s = C.toOklch(out);
      if (th.neutral && !ctx?.token) out = neutralColor(out, s);
      else if (th.accent && th.tint) out = tintColor(out, s);
    }
  }
  if (statusLch && statusLch[cls]) out = statusColor(out, cls);
  if (th?.scheme === 'light' && cls && cls !== 'neutral' && !ctx?.token) out = lightLegible(out, ctx);
  if (state.hc) out = contrastColor(out, ctx);
  return out === c ? null : out;
}

// Como mapValue de restyle.js, pero para las variables base (ctx.token)
function mapToken(value, name) {
  if (!/#|rgb/i.test(value)) return value;
  const ctx = { prop: name, gradient: /gradient\(/i.test(value), token: true };
  return String(value).replace(COLOR_RE, (m, color) => {
    if (!color) return m;
    const c = C.parseColor(color);
    if (!c) return m;
    const out = mapColor(c, ctx);
    return out ? C.toCss(out) : m;
  });
}

// ---------- Aplicar ----------
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    if (!scheduled) return;
    scheduled = false;
    apply();
  });
}

function apply() {
  const root = document.documentElement;
  const th = state.theme;
  const active = Boolean(th && (th.accent || th.scheme === 'light' || th.palette)) || Boolean(statusLch) || state.hc;
  root.classList.toggle('ap-themed', Boolean(th?.accent));
  root.classList.toggle('ax-hc', state.hc);
  root.classList.toggle('ax-shapes', state.shapes);
  for (const k of Object.keys(SIM)) root.classList.toggle(`ax-cvd-${k}`, state.cvd === k);

  if (dirty) {
    dirty = false;
    setMapper(active ? mapColor : null, { now: true });
    const next = new Set();
    if (active) {
      const base = readBaseVars(th?.scheme || 'dark');
      const over = th?.palette ? paletteVars(th.palette, base) : {};
      // Con el tema claro las variables se escriben siempre: asi ganan a los espejos de las hojas
      const force = th?.scheme === 'light';
      for (const [name, value] of Object.entries(base)) {
        const v = over[name] !== undefined ? over[name] : mapToken(value, name);
        if (force || v !== value) {
          root.style.setProperty(name, v);
          next.add(name);
        }
      }
    }
    for (const name of managed) if (!next.has(name)) root.style.removeProperty(name);
    managed = next;
  }
  applyFilter();
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('[a11y]', err);
    }
  }
}

// Filtro SVG (feColorMatrix) de correccion para daltonismo, aplicado a toda la ventana.
function applyFilter() {
  const root = document.documentElement;
  const k = state.cvd !== 'none' ? state.cvdStrength : 0;
  if (!k) {
    if (root.style.filter.includes('ax-cvd-filter')) root.style.removeProperty('filter');
    return;
  }
  let svg = document.getElementById('ax-filters');
  if (!svg) {
    const NS = 'http://www.w3.org/2000/svg';
    svg = document.createElementNS(NS, 'svg');
    svg.id = 'ax-filters';
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    const filter = document.createElementNS(NS, 'filter');
    filter.id = 'ax-cvd-filter';
    filter.setAttribute('color-interpolation-filters', 'linearRGB');
    const fe = document.createElementNS(NS, 'feColorMatrix');
    fe.setAttribute('type', 'matrix');
    filter.append(fe);
    svg.append(filter);
    document.body.append(svg);
  }
  const m = correctionMatrix(state.cvd, k);
  const values = [...m[0], 0, 0, ...m[1], 0, 0, ...m[2], 0, 0, 0, 0, 0, 1, 0].map((v) => (Math.round(v * 10000) / 10000).toString()).join(' ');
  svg.querySelector('feColorMatrix').setAttribute('values', values);
  root.style.filter = 'url(#ax-cvd-filter)';
}

export function correctionMatrix(type, k) {
  const S = SIM[type];
  const E = SHIFT[type];
  const out = [];
  for (let i = 0; i < 3; i++) {
    out.push([]);
    for (let j = 0; j < 3; j++) {
      // (SHIFT * (I - SIM))[i][j]
      let v = 0;
      for (let x = 0; x < 3; x++) v += E[i][x] * ((x === j ? 1 : 0) - S[x][j]);
      out[i].push((i === j ? 1 : 0) + k * v);
    }
  }
  return out;
}

// Para pruebas o vistas previas: transforma un color suelto con el estado actual
export function previewColor(css, prop = 'color') {
  return mapValue(css, prop);
}
