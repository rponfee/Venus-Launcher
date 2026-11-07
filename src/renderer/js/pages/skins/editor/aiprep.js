// Creador de skins con IA: piezas puras (sin DOM, con pruebas en test/aiprep.test.js).
//  - dominantColors: los colores que mas aparecen en una imagen de referencia, para que la IA parta de la paleta real.
//  - fitSize: tamaño final de una referencia (lado mayor <= max, sin agrandar nada).
//  - base64Bytes: tamaño real de un data: URL, para respetar el tope del pedido.
//  - errorKey: clave de texto para un error del proceso principal.

const hex = (n) => n.toString(16).padStart(2, '0');

/**
 * data = RGBA (Uint8ClampedArray de una imagen chica). Agrupa los colores en cubos de 8 niveles por canal y devuelve
 * hasta `count` colores '#rrggbb' bien distintos entre si, del mas al menos frecuente. Ignora lo transparente y el
 * fondo casi blanco (casi todas las ilustraciones vienen sobre blanco).
 */
export function dominantColors(data, count = 8, { minGap = 40 } = {}) {
  const bins = new Map();
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r > 236 && g > 236 && b > 236) continue;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const e = bins.get(key);
    if (e) {
      e.n++;
      e.r += r;
      e.g += g;
      e.b += b;
    } else bins.set(key, { n: 1, r, g, b });
  }
  const sorted = [...bins.values()].sort((x, y) => y.n - x.n);
  const out = [];
  for (const e of sorted) {
    const c = [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)];
    if (out.some((o) => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) < minGap)) continue;
    out.push(c);
    if (out.length >= count) break;
  }
  return out.map((c) => `#${hex(c[0])}${hex(c[1])}${hex(c[2])}`);
}

export function fitSize(w, h, max = 640) {
  const big = Math.max(w, h);
  if (!(big > 0)) return { w: 1, h: 1 };
  const k = big > max ? max / big : 1;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// Bytes de los datos de un data: URL en base64 (sin contar el prefijo)
export function base64Bytes(dataUrl) {
  const i = String(dataUrl).indexOf(',');
  return i < 0 ? 0 : dataUrl.length - i - 1;
}

const KNOWN = new Set(['badImage', 'bigImage', 'badSkin', 'needText', 'needInput', 'bad', 'busy', 'cancelled']);

// 'skinai:badImage' -> 'skineditor.aiErr_badImage'; lo demas (errores de la IA) llega ya traducido
export function errorKey(err) {
  const m = /^skinai:(\w+)$/.exec(String(err?.code ?? ''));
  return m && KNOWN.has(m[1]) ? `skineditor.aiErr_${m[1]}` : null;
}
