// Editor de skins: lógica pura (sin DOM, con pruebas en test/logic.test.js). Trabaja sobre un arreglo RGBA
// de 64x64 (Uint8ClampedArray de 16384 bytes, como ImageData.data).
//  - Zonas del mapa UV (partes, caras y capas) a partir de la misma geometría de la vista 3D (../model.js).
//  - Espejo izquierda/derecha: el mismo punto del otro lado del cuerpo (cabeza y torso sobre sí mismos).
//  - Lápiz, goma y balde (el balde no se sale de la cara donde empieza) respetando la capa activa.
//  - Historial de deshacer/rehacer con instantáneas.
import { playerParts, faceRects } from '../model.js';

export const SIZE = 64;
export const BYTES = SIZE * SIZE * 4;
export const LAYERS = ['base', 'outer'];
export const PARTS = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
export const FACES = ['front', 'back', 'right', 'left', 'top', 'bottom'];
const MIRROR_PART = { head: 'head', body: 'body', rightArm: 'leftArm', leftArm: 'rightArm', rightLeg: 'leftLeg', leftLeg: 'rightLeg' };
const MIRROR_FACE = { front: 'front', back: 'back', top: 'top', bottom: 'bottom', right: 'left', left: 'right' };

export const normVariant = (v) => (v === 'slim' ? 'slim' : 'classic');
export const newPixels = () => new Uint8ClampedArray(BYTES);
export const inside = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE;

// ---------- Zonas ----------
const zoneCache = new Map();

// [{ id, part, layer, face, rect: [x, y, w, h] }] para el modelo clásico o slim.
export function zones(variant = 'classic') {
  const v = normVariant(variant);
  if (zoneCache.has(v)) return zoneCache.get(v).list;
  const list = [];
  for (const p of playerParts(v)) {
    for (const b of p.boxes) {
      const [w, h, d] = b.size;
      const rects = faceRects(b.uv[0], b.uv[1], w, h, d);
      const layer = b.overlay ? 'outer' : 'base';
      for (const face of FACES) list.push({ id: `${p.id}:${layer}:${face}`, part: p.id, layer, face, rect: rects[face] });
    }
  }
  const map = new Int16Array(SIZE * SIZE).fill(-1);
  list.forEach((z, i) => {
    const [x0, y0, w, h] = z.rect;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) map[y * SIZE + x] = i;
  });
  const byId = new Map(list.map((z) => [z.id, z]));
  zoneCache.set(v, { list, map, byId });
  return list;
}

function table(variant) {
  zones(variant);
  return zoneCache.get(normVariant(variant));
}

// Zona del pixel o null (pixeles que el modelo no usa).
export function zoneAt(x, y, variant = 'classic') {
  if (!inside(x, y)) return null;
  const tb = table(variant);
  const i = tb.map[y * SIZE + x];
  return i < 0 ? null : tb.list[i];
}

export function zoneById(id, variant = 'classic') {
  return table(variant).byId.get(id) || null;
}

// Se puede pintar el pixel con la capa activa ('base', 'outer' o 'all').
export function editable(x, y, variant = 'classic', layer = 'all') {
  const z = zoneAt(x, y, variant);
  return Boolean(z) && (layer === 'all' || z.layer === layer);
}

// ---------- Espejo ----------
// Punto equivalente del otro lado del cuerpo, o null si el pixel no es de ninguna zona.
export function mirrorPoint(x, y, variant = 'classic') {
  const z = zoneAt(x, y, variant);
  if (!z) return null;
  const target = zoneById(`${MIRROR_PART[z.part]}:${z.layer}:${MIRROR_FACE[z.face]}`, variant);
  if (!target) return null;
  const [rx, ry] = z.rect;
  const [tx, ty, tw, th] = target.rect;
  const lx = x - rx;
  const ly = y - ry;
  const mx = tw - 1 - lx;
  if (mx < 0 || ly >= th) return null;
  return { x: tx + mx, y: ty + ly };
}

// ---------- Pixeles ----------
export function getPixel(px, x, y) {
  if (!inside(x, y)) return [0, 0, 0, 0];
  const i = (y * SIZE + x) * 4;
  return [px[i], px[i + 1], px[i + 2], px[i + 3]];
}

// Devuelve true si cambió.
export function setPixel(px, x, y, rgba) {
  if (!inside(x, y)) return false;
  const i = (y * SIZE + x) * 4;
  const [r, g, b, a] = rgba[3] === 0 ? [0, 0, 0, 0] : rgba;
  if (px[i] === r && px[i + 1] === g && px[i + 2] === b && px[i + 3] === a) return false;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
  return true;
}

export const TRANSPARENT = Object.freeze([0, 0, 0, 0]);

// Mismo color (todos los transparentes son iguales, sin importar su RGB).
export function sameColor(a, b) {
  if (a[3] === 0 && b[3] === 0) return true;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * Lápiz o goma en un pixel (rgba = TRANSPARENT para borrar). Respeta la capa activa y, con mirror, pinta
 * también el pixel espejo. Devuelve la lista de puntos que cambiaron.
 */
export function paint(px, x, y, rgba, { variant = 'classic', layer = 'all', mirror = false } = {}) {
  const changed = [];
  if (!editable(x, y, variant, layer)) return changed;
  if (setPixel(px, x, y, rgba)) changed.push({ x, y });
  if (mirror) {
    const m = mirrorPoint(x, y, variant);
    if (m && (m.x !== x || m.y !== y) && editable(m.x, m.y, variant, layer) && setPixel(px, m.x, m.y, rgba)) changed.push({ x: m.x, y: m.y });
  }
  return changed;
}

/**
 * Balde: rellena los pixeles vecinos (4 direcciones) del mismo color sin salirse de la cara donde empieza.
 * Con mirror, pinta también los puntos espejo de lo rellenado. Devuelve la lista de puntos que cambiaron.
 */
export function floodFill(px, x, y, rgba, { variant = 'classic', layer = 'all', mirror = false } = {}) {
  const changed = [];
  const z = zoneAt(x, y, variant);
  if (!z || (layer !== 'all' && z.layer !== layer)) return changed;
  const from = getPixel(px, x, y);
  const to = rgba[3] === 0 ? TRANSPARENT : rgba;
  if (sameColor(from, to)) {
    // mismo color: no hay nada que rellenar acá, pero el espejo puede ser distinto
    if (!mirror) return changed;
  }
  const [rx, ry, rw, rh] = z.rect;
  const seen = new Uint8Array(rw * rh);
  const filled = [];
  const stack = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    if (cx < rx || cy < ry || cx >= rx + rw || cy >= ry + rh) continue;
    const k = (cy - ry) * rw + (cx - rx);
    if (seen[k]) continue;
    seen[k] = 1;
    if (!sameColor(getPixel(px, cx, cy), from)) continue;
    filled.push([cx, cy]);
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  for (const [fx, fy] of filled) if (setPixel(px, fx, fy, to)) changed.push({ x: fx, y: fy });
  if (mirror) {
    for (const [fx, fy] of filled) {
      const m = mirrorPoint(fx, fy, variant);
      if (m && editable(m.x, m.y, variant, layer) && setPixel(px, m.x, m.y, to)) changed.push({ x: m.x, y: m.y });
    }
  }
  return changed;
}

// Puntos de una línea (Bresenham), para que un trazo rápido no deje huecos.
export function line(x0, y0, x1, y1) {
  const out = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (let guard = 0; guard < 512; guard++) {
    out.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

// ---------- Capas ----------
// Copia con las capas ocultas en transparente (para la vista 2D y la 3D).
export function withLayers(px, { base = true, outer = true } = {}, variant = 'classic') {
  const out = new Uint8ClampedArray(px);
  if (base && outer) return out;
  for (const z of zones(variant)) {
    if ((z.layer === 'base' && base) || (z.layer === 'outer' && outer)) continue;
    const [x0, y0, w, h] = z.rect;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.fill(0, (y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4);
  }
  return out;
}

// Como en el juego, la capa base se ve opaca (un pixel borrado ahí se ve negro): copia para la vista 3D.
export function opaqueBase(px, variant = 'classic') {
  const out = new Uint8ClampedArray(px);
  for (const z of zones(variant)) {
    if (z.layer !== 'base') continue;
    const [x0, y0, w, h] = z.rect;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * SIZE + x) * 4;
        if (out[i + 3] === 0) out.fill(0, i, i + 3);
        out[i + 3] = 255;
      }
    }
  }
  return out;
}

// Borra lo que el modelo no usa (por ejemplo la cuarta columna de los brazos en slim) para que el PNG
// guardado quede limpio y la biblioteca reconozca el modelo.
export function cleanUnused(px, variant = 'classic') {
  const out = new Uint8ClampedArray(px);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (!zoneAt(x, y, variant)) out.fill(0, (y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4);
  return out;
}

// Skin en blanco: capa base gris claro con un sombreado por cara (para que se lea en 3D) y capa exterior vacía.
export function blankSkin(variant = 'classic') {
  const px = newPixels();
  const shade = { front: 206, back: 176, right: 190, left: 190, top: 222, bottom: 160 };
  for (const z of zones(variant)) {
    if (z.layer !== 'base') continue;
    const v = shade[z.face];
    const [x0, y0, w, h] = z.rect;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPixel(px, x, y, [v, v, v, 255]);
  }
  return px;
}

export function isBlank(px) {
  for (let i = 3; i < px.length; i += 4) if (px[i]) return false;
  return true;
}

export function samePixels(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------- Colores ----------
export function parseHex(text) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(text || '').trim());
  if (!m) return null;
  return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 255];
}

export function toHex(rgba) {
  return `#${rgba
    .slice(0, 3)
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')}`;
}

// Recientes: el nuevo primero, sin repetidos, como mucho "max".
export function pushRecent(list, hex, max = 10) {
  const h = String(hex || '').toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(h)) return Array.isArray(list) ? list.slice(0, max) : [];
  return [h, ...(Array.isArray(list) ? list : []).filter((c) => c !== h)].slice(0, max);
}

// Paleta inicial: pieles, pelo, ropa y colores de Minecraft.
export const PALETTE = [
  '#f9d7b5', '#e8b48c', '#c68a5e', '#8d5a3b', '#5a3825', '#2f1e14',
  '#f5e1a4', '#d9a441', '#9c5b2e', '#4a2c1a', '#1c1410', '#ffffff',
  '#c9c9c9', '#8a8a8a', '#4f4f4f', '#000000', '#d63a3a', '#f08a24',
  '#f2cf3a', '#5cb84a', '#2f8f4e', '#3fb6d9', '#2f5fd0', '#7a4bd0',
  '#d050a8', '#2a8a8a', '#7d5a3a', '#3b6b2e',
];

// ---------- Historial ----------
/**
 * Instantáneas para deshacer/rehacer. record(antes) guarda el estado anterior a un cambio (y borra lo que
 * se podía rehacer); undo(actual) y redo(actual) devuelven el estado a poner o null.
 */
export function createHistory({ limit = 100 } = {}) {
  let past = [];
  let future = [];
  const copy = (px) => new Uint8ClampedArray(px);
  return {
    record(before) {
      past.push(copy(before));
      if (past.length > limit) past = past.slice(past.length - limit);
      future = [];
    },
    undo(current) {
      if (!past.length) return null;
      future.push(copy(current));
      return past.pop();
    },
    redo(current) {
      if (!future.length) return null;
      past.push(copy(current));
      return future.pop();
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    clear() {
      past = [];
      future = [];
    },
    get size() {
      return { undo: past.length, redo: future.length };
    },
  };
}
