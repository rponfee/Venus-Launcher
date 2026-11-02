// Posiciones de los widgets del overlay. Sin DOM ni imports: lo usan la pagina del overlay, la vista previa de
// Ajustes y las pruebas (src/main/modules/overlay/test/layout.test.js).
// Todo se mide en fracciones del area del juego (0 a 1), asi da igual el tamano de la ventana o la escala de
// Windows. Una posicion libre (x, y) es la fraccion del espacio que queda libre dentro de los margenes: x = 0
// pega el widget al borde izquierdo y x = 1 al derecho, sin que nunca se salga. Las 9 posiciones de la grilla
// son las mismas cuentas con x e y en 0, 0.5 o 1.

export const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
export const MARGIN = Object.freeze({ x: 0.0125, y: 0.02 });
// Teclado numerico: 7 8 9 arriba, 4 5 6 al medio, 1 2 3 abajo.
export const DIGIT_ANCHOR = Object.freeze({ 7: 'tl', 8: 'tc', 9: 'tr', 4: 'ml', 5: 'mc', 6: 'mr', 1: 'bl', 2: 'bc', 3: 'br' });

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round4 = (n) => Math.round(n * 10000) / 10000;

// 'tr' -> { col: 2, row: 0 }; null si no es una posicion de la grilla.
export function anchorCell(anchor) {
  const i = ANCHORS.indexOf(anchor);
  return i < 0 ? null : { col: i % 3, row: Math.floor(i / 3) };
}

// Posicion libre equivalente a una posicion de la grilla ('br' -> { x: 1, y: 1 }).
export function anchorFraction(anchor) {
  const c = anchorCell(anchor);
  return c ? { x: c.col / 2, y: c.row / 2 } : { x: 0, y: 0 };
}

// Esquina superior izquierda (fracciones del area) de un widget de tamano size = { w, h } (fracciones).
export function freeBox(pos, size, margin = MARGIN) {
  const w = clamp01(size?.w);
  const h = clamp01(size?.h);
  return {
    left: margin.x + clamp01(pos?.x) * Math.max(0, 1 - 2 * margin.x - w),
    top: margin.y + clamp01(pos?.y) * Math.max(0, 1 - 2 * margin.y - h),
  };
}

// Inversa de freeBox: esquina -> posicion libre (si el widget ocupa todo el ancho o alto, queda centrado).
export function freeFromBox(box, size, margin = MARGIN) {
  const spanX = 1 - 2 * margin.x - clamp01(size?.w);
  const spanY = 1 - 2 * margin.y - clamp01(size?.h);
  return {
    x: round4(spanX > 0 ? clamp01((box.left - margin.x) / spanX) : 0.5),
    y: round4(spanY > 0 ? clamp01((box.top - margin.y) / spanY) : 0.5),
  };
}

// Esquina de un widget en una posicion de la grilla (si estuviera solo en esa celda).
export function anchoredBox(anchor, size, margin = MARGIN) {
  return freeBox(anchorFraction(anchor), size, margin);
}

// Esquina de un widget segun su configuracion ({ anchor, x, y }).
export function boxFor(widget, size, margin = MARGIN) {
  return widget?.anchor === 'free' ? freeBox(widget, size, margin) : anchoredBox(widget?.anchor || 'tl', size, margin);
}

// Al soltar un widget arrastrado: si quedo cerca de una posicion de la grilla se ancla ahi; si no, queda libre.
// threshold es una fraccion del alto; aspect (ancho / alto del area) hace comparables las dos direcciones.
export function snap(box, size, { threshold = 0.035, aspect = 16 / 9, margin = MARGIN } = {}) {
  let best = null;
  for (const anchor of ANCHORS) {
    const p = anchoredBox(anchor, size, margin);
    const d = Math.hypot((box.left - p.left) * aspect, box.top - p.top);
    if (d <= threshold && (!best || d < best.d)) best = { anchor, d };
  }
  if (best) return { anchor: best.anchor };
  return { anchor: 'free', ...freeFromBox(box, size, margin) };
}

// Mantiene la esquina dentro del area mientras se arrastra.
export function clampBox(box, size) {
  return {
    left: Math.min(Math.max(0, box.left), Math.max(0, 1 - clamp01(size?.w))),
    top: Math.min(Math.max(0, box.top), Math.max(0, 1 - clamp01(size?.h))),
  };
}

// Flechas del teclado en el modo edicion: corre la posicion (libre o de la grilla) un paso.
export function nudge(widget, dx, dy, step = 0.01) {
  const start = widget?.anchor === 'free' ? { x: clamp01(widget.x), y: clamp01(widget.y) } : anchorFraction(widget?.anchor);
  return { anchor: 'free', x: round4(clamp01(start.x + dx * step)), y: round4(clamp01(start.y + dy * step)) };
}

// Escala efectiva de un widget: la elegida, dentro de 0.6 a 1.6.
export function clampScale(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1.6, Math.max(0.6, n)) : 1;
}

// Tamano en fracciones de un widget medido en pixeles (los dos rectangulos en el mismo sistema de coordenadas).
export function sizeOf(rect, area) {
  if (!area?.width || !area?.height) return { w: 0, h: 0 };
  return { w: clamp01(rect.width / area.width), h: clamp01(rect.height / area.height) };
}
