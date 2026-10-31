// Utilidades de color para temas y accesibilidad: lectura de colores CSS, OKLab/OKLCH
// (espacio perceptual: cambiar el tono sin cambiar el brillo), mezcla y contraste WCAG.

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

// '#f29a2e', '#fff8', 'rgb(242, 154, 46)', 'rgba(242 154 46 / 50%)' -> { r, g, b, a } (0-255, a 0-1)
export function parseColor(str) {
  const s = String(str || '').trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]+)$/);
  if (m) {
    let hx = m[1];
    if (hx.length === 3 || hx.length === 4) hx = [...hx].map((c) => c + c).join('');
    if (hx.length !== 6 && hx.length !== 8) return null;
    return {
      r: parseInt(hx.slice(0, 2), 16),
      g: parseInt(hx.slice(2, 4), 16),
      b: parseInt(hx.slice(4, 6), 16),
      a: hx.length === 8 ? parseInt(hx.slice(6, 8), 16) / 255 : 1,
    };
  }
  m = s.match(/^rgba?\(([^()]*)\)$/);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const ch = (p) => (p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p));
  const al = (p) => (p === undefined ? 1 : p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p));
  const c = { r: ch(parts[0]), g: ch(parts[1]), b: ch(parts[2]), a: al(parts[3]) };
  if ([c.r, c.g, c.b, c.a].some((v) => !Number.isFinite(v))) return null;
  return { r: clamp(c.r, 0, 255), g: clamp(c.g, 0, 255), b: clamp(c.b, 0, 255), a: clamp(c.a) };
}

const hex2 = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');

export function toHex(c) {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

// Opaco -> #rrggbb; con transparencia -> rgba(...)
export function toCss(c) {
  const a = c.a === undefined ? 1 : c.a;
  if (a >= 0.999) return toHex(c);
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.round(a * 1000) / 1000})`;
}

export function rgba(c, a) {
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;
}

export function mix(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: (a.a ?? 1) + ((b.a ?? 1) - (a.a ?? 1)) * t };
}

// HSL (h 0-360, s y l 0-1): el mismo modelo que usa el filtro CSS hue-rotate()
export function toHsl({ r, g, b }) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

// ---------- sRGB <-> lineal ----------
export const toLinear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export const fromLinear = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);

// ---------- OKLab / OKLCH ----------
function linToOklab(R, G, B) {
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function oklabToLin(L, A, B) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

export function toOklch(c) {
  const [L, A, B] = linToOklab(toLinear(c.r), toLinear(c.g), toLinear(c.b));
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c: Math.hypot(A, B), h };
}

const inGamut = (rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

// OKLCH -> sRGB. Si el color no entra en sRGB se baja el croma (se conserva brillo y tono).
export function fromOklch({ l, c, h }, alpha = 1) {
  const L = clamp(l);
  const rad = (((h % 360) + 360) % 360) * (Math.PI / 180);
  const at = (chroma) => oklabToLin(L, chroma * Math.cos(rad), chroma * Math.sin(rad));
  let rgb = at(Math.max(0, c));
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = Math.max(0, c);
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    rgb = at(lo);
  }
  return { r: clamp(fromLinear(clamp(rgb[0])), 0, 255), g: clamp(fromLinear(clamp(rgb[1])), 0, 255), b: clamp(fromLinear(clamp(rgb[2])), 0, 255), a: alpha };
}

// Diferencia de tono con signo por el camino mas corto (-180..180)
export function hueDelta(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

// ---------- Contraste (WCAG 2) ----------
export function luminance(c) {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isHexColor(s) {
  return /^#[0-9a-f]{6}$/i.test(String(s || ''));
}
