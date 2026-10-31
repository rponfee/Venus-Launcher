// Motor visual compartido por Apariencia (color de acento) y Accesibilidad (daltonismo y alto contraste).
// Calcula las variables de color de :root y transforma los colores fijos de todas las hojas de estilo
// (restyle.js). Cada color de la interfaz se clasifica una sola vez segun el tema original:
//   accent  -> familia naranja/oro de Venus (se re-ancla al acento elegido)
//   neutral -> fondos, bordes y textos calidos (se tiñen con el tono del acento)
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

export const BASE_ACCENT = '#f29a2e';
const BASE_LCH = C.toOklch(C.parseColor(BASE_ACCENT));

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

const state = {
  theme: null, // { target, hueK, neutralScale, tint }
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

// theme: { accent: '#rrggbb', tint: true } o null para el tema original de Venus
export function setTheme(theme) {
  const c = theme && C.isHexColor(theme.accent) ? C.parseColor(theme.accent) : null;
  const next = c && C.toHex(c) !== BASE_ACCENT ? prepareTheme(c, theme.tint !== false) : null;
  const key = next ? `${C.toHex(c)}|${next.tint}` : '';
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

// Acento ajustado para que se lea bien sobre el fondo oscuro (lo que realmente se aplica)
export function legibleAccent(hex) {
  const c = C.parseColor(hex);
  if (!c) return BASE_ACCENT;
  const lch = C.toOklch(c);
  const l = C.clamp(lch.l, 0.62, 0.9);
  return l === lch.l ? C.toHex(c) : C.toHex(C.fromOklch({ ...lch, l }));
}

// Aplica ya (sin esperar al siguiente cuadro): util al iniciar para evitar un parpadeo
export function applyNow() {
  scheduled = false;
  apply();
}

// ---------- Preparacion ----------
function prepareTheme(c, tint) {
  const lch = C.toOklch(c);
  lch.l = C.clamp(lch.l, 0.62, 0.9);
  // Las luces del tema original "giran" hacia el amarillo y las sombras hacia el rojo (pixel art).
  // Con otros tonos se gira hacia el lado mas corto al amarillo, un poco mas suave.
  const toYellow = C.hueDelta(lch.h, 100);
  const dir = toYellow >= 0 ? 1 : -1;
  const hueK = lch.c < 0.03 ? 0 : (Math.abs(toYellow) < 60 ? 1 : 0.6) * dir;
  const neutralScale = C.clamp(lch.c / BASE_LCH.c, 0, 1.15);
  return { target: lch, hueK, neutralScale, tint };
}

function buildStatus(pal) {
  const out = {};
  for (const k of Object.keys(STATUS_BASE)) out[k] = { base: C.toOklch(C.parseColor(STATUS_BASE[k])), target: C.toOklch(C.parseColor(pal[k])) };
  return out;
}

function readBaseVars() {
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

function themeColor(c, cls) {
  const t = state.theme;
  const s = C.toOklch(c);
  if (cls === 'accent') return reanchor(s, BASE_LCH, t.target, t.hueK, c.a);
  // neutros: mismo brillo, tono del acento, croma segun lo saturado del acento
  const h = t.target.h + C.hueDelta(BASE_LCH.h, s.h) * t.hueK * 0.5;
  return C.fromOklch({ l: s.l, c: s.c * t.neutralScale, h }, c.a);
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

function contrastColor(c, ctx) {
  const role = roleOf(ctx?.prop);
  const a = c.a ?? 1;
  if (role === 'text') {
    const s = C.toOklch(c);
    // texto oscuro (sobre botones de color) mas oscuro; texto gris mas claro; texto de color un poco mas claro sin perder el tono
    const l = s.l < 0.3 ? s.l * 0.55 : s.c < 0.06 ? 1 - (1 - s.l) * 0.4 : Math.max(s.l, Math.min(0.93, s.l + 0.07));
    return C.fromOklch({ l, c: s.c, h: s.h }, a < 1 ? Math.max(a, 0.9) : 1);
  }
  if (role === 'border') {
    const s = C.toOklch(c);
    const l = s.l < 0.5 ? Math.min(1, s.l + 0.2) : s.l;
    return C.fromOklch({ l, c: s.c, h: s.h }, a < 1 ? Math.min(1, a * 2.6 + 0.14) : 1);
  }
  if (role === 'bg' && !ctx?.gradient && a < 1) {
    const { l } = C.toOklch(c);
    if (l < 0.32 && a > 0.3) return { ...c, a: Math.max(a, 0.96) }; // superficies traslucidas -> opacas
    if (l > 0.55 && a < 0.25) return { ...c, a: Math.min(0.45, a * 2) }; // resaltados (hover, wash) mas visibles
  }
  return c;
}

function mapColor(c, ctx) {
  const cls = classify(c);
  let out = c;
  if (state.theme && (cls === 'accent' || (cls === 'neutral' && state.theme.tint))) out = themeColor(out, cls);
  if (statusLch && statusLch[cls]) out = statusColor(out, cls);
  if (state.hc) out = contrastColor(out, ctx);
  return out === c ? null : out;
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
  const active = Boolean(state.theme) || Boolean(statusLch) || state.hc;
  root.classList.toggle('ap-themed', Boolean(state.theme));
  root.classList.toggle('ax-hc', state.hc);
  root.classList.toggle('ax-shapes', state.shapes);
  for (const k of Object.keys(SIM)) root.classList.toggle(`ax-cvd-${k}`, state.cvd === k);

  if (dirty) {
    dirty = false;
    setMapper(active ? mapColor : null, { now: true });
    const next = new Set();
    if (active) {
      for (const [name, value] of Object.entries(readBaseVars())) {
        const v = mapValue(value, name);
        if (v !== value) {
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
